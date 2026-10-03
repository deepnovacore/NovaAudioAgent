import type {ModelGateway} from '../src/model/model-gateway.js'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm,realpath,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {parseFeed} from '../src/news/feeds.js'
import {NewsService} from '../src/news/service.js'
const now=()=>new Date('2026-09-20T11:00:00Z')
const source={id:'bbc',name:'BBC',url:'https://feeds.bbci.co.uk/news/rss.xml'}
const xml='<rss><channel><item><title>AI research</title><link>https://www.bbc.com/news/one?utm_source=rss</link><description><![CDATA[<b>Voice models</b> improve latency]]></description><pubDate>Sun, 20 Sep 2026 10:00:00 GMT</pubDate></item></channel></rss>'
test('RSS and Atom normalize safe text, links and dates; HTML and DTD are rejected',()=>{
 const a=parseFeed(xml,source,new Date('2026-09-20T11:00:00Z'))
 assert.equal(a.length,1);assert.equal(a[0]!.url,'https://www.bbc.com/news/one');assert.equal(a[0]!.summary,'Voice models improve latency')
 assert.equal(parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>One</title><link href="https://example.com/one"/><summary>News</summary></entry></feed>',source,new Date())[0]!.published_at,null)
 assert.throws(()=>parseFeed('<html><body>Access denied</body></html>',source,new Date()),/feed/)
 assert.throws(()=>parseFeed('<!DOCTYPE rss><rss/>',source,new Date()),/doctype/)
 assert.equal(parseFeed('<rss><channel><item><title>X</title><link>javascript:alert(1)</link></item></channel></rss>',source,new Date()).length,0)
})
test('real service persists explicit interests, dedupes refresh, applies idempotent feedback and survives source failure',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-news-'));let broken=false,calls=0
 const make=()=>new NewsService({path:join(dir,'news.json'),sources:[source],now,fetcher:()=>{calls++;return Promise.resolve(new Response(broken?'<html>blocked</html>':xml))},rank:(interests,articles)=>Promise.resolve(articles.map(a=>({id:a.id,matches:[{interest_id:interests[0]!.id,score:0.9,quote:'AI research'}],reason:'与你关注的 AI 研究相关'})))})
 let service=make();await service.open()
 try{
  await service.refresh();assert.equal(calls,1,'news is on before any configuration');assert.equal(service.snapshot().mode,'timeline');assert.equal(service.snapshot().items[0]!.ranking,null,'no interests, no ranking call')
  await service.configure({enabled:true,interests:['AI'],explore:false});await service.refresh()
  const row=service.snapshot().items[0]!;assert.equal(row.ranking?.reason,'与你关注的 AI 研究相关')
  await service.refresh();assert.equal(service.snapshot().items.length,1)
  await service.action({id:row.id,action:'save',value:true});await service.action({id:row.id,action:'read',value:true})
  const interest_id=service.snapshot().interests[0]!.id
  await service.action({action:'weight',interest_id,value:0.5});await service.action({action:'weight',interest_id,value:0.5})
  assert.equal(service.snapshot().interests[0]!.weight,0.5)
  broken=true;await service.refresh();assert.equal(service.snapshot().items.length,1);assert.equal(service.snapshot().sources[0]!.error,'invalid_feed')
  await service.close();service=make();await service.open();assert.equal(service.snapshot().items[0]!.saved,true);assert.equal(service.snapshot().items[0]!.read,true)
  await service.action({action:'block',source_id:'bbc',value:true});assert.equal(service.snapshot().items.length,0)
 }finally{await service.close();await rm(dir,{recursive:true,force:true})}
})
test('profile changes fence late ranking and quoted evidence is validated',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-news-race-'));let release:()=>void=()=>{/* optional cleanup/observer */};let started:()=>void=()=>{/* optional cleanup/observer */};const entered=new Promise<void>(r=>{started=r})
 const service=new NewsService({path:join(dir,'news.json'),sources:[source],now,fetcher:()=>Promise.resolve(new Response(xml)),rank:async(interests,articles)=>{started();await new Promise<void>(r=>{release=r});return articles.map(a=>({id:a.id,matches:[{interest_id:interests[0]!.id,score:1,quote:'AI research'}],reason:'AI'}))}})
 await service.open()
 try{await service.configure({enabled:true,interests:['AI'],explore:false});const run=service.refresh();await entered;await service.configure({enabled:true,interests:['Gardening'],explore:false});release();await run;assert.equal(service.snapshot().items[0]!.ranking,null);assert.equal(service.snapshot().pending,1)}finally{release();await service.close();await rm(dir,{recursive:true,force:true})}
})
test('ranking carries an explicit output schema even for JSON-object-only gateways',async()=>{
 const {createNewsRanker}=await import('../src/news/ranking.js');let prompt=''
 const gateway={complete:(request:{prompt:string})=>{prompt=request.prompt;return Promise.resolve({text:JSON.stringify({scores:[]})})}}
 await createNewsRanker(gateway as unknown as ModelGateway,'model')([],[],new AbortController().signal)
 assert.match(prompt,/"output_schema"/u);assert.match(prompt,/"scores"/u)
})
test('refresh requested during ranking runs again for changed interests',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-news-rerun-'));let release:()=>void=()=>{/* optional cleanup/observer */};let entered:()=>void=()=>{/* optional cleanup/observer */};const started=new Promise<void>(r=>{entered=r});const profiles:string[]=[]
 const service=new NewsService({path:join(dir,'news.json'),sources:[source],now,fetcher:()=>Promise.resolve(new Response(xml)),rank:async(interests,articles)=>{profiles.push(interests[0]!.text);if(profiles.length===1){entered();await new Promise<void>(r=>{release=r})}return articles.map(a=>({id:a.id,matches:[],reason:''}))}})
 await service.open();try{await service.configure({enabled:true,interests:['AI'],explore:false});const first=service.refresh();await started;await service.configure({enabled:true,interests:['Travel'],explore:false});const second=service.refresh();release();await Promise.all([first,second]);assert.deepEqual(profiles,['AI','Travel']);assert.equal(service.snapshot().pending,0)}finally{release();await service.close();await rm(dir,{recursive:true,force:true})}
})
test('news conversion input is explicit, immutable, and rejects stale article content',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-news-convert-'));let feed=xml
 const service=new NewsService({path:join(dir,'news.json'),sources:[source],now,fetcher:()=>Promise.resolve(new Response(feed))});await service.open()
 try{
  await service.configure({enabled:true,interests:['AI'],explore:false});await service.refresh();const row=service.snapshot().items[0]!
  const params={id:row.id,content_hash:row.content_hash,kind:'idea',title:'My interpretation',note:'Public source, not my own fact'}
  const input=service.conversionInput(params);assert.equal(input.op,'from_news');assert.equal(input.title,'My interpretation');assert.equal(input.article.url,row.url);assert.equal(input.article.summary,row.summary)
  input.article.title='Mutated copy';assert.equal(service.snapshot().items[0]!.title,row.title)
  assert.throws(()=>service.conversionInput({...params,id:'missing'}),/article_not_found/)
  assert.throws(()=>service.conversionInput({...params,content_hash:'old'}),/article_changed/)
  feed=xml.replace('AI research','Updated AI research');await service.refresh();assert.throws(()=>service.conversionInput(params),/article_changed/)
  assert.throws(()=>service.conversionInput({...params,kind:'profile'}))
 }finally{await service.close();await rm(dir,{recursive:true,force:true})}
})

test('Chinese and non-Chinese systems fetch only their native-language catalog without cross-language fallback',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-news-language-'))
 try{for(const language of ['zh-CN','zh-Hant-TW','en-US','ja-JP']){
  const urls:string[]=[];const options={path:join(dir,language+'.json'),language,fetcher:(url:Parameters<typeof fetch>[0])=>{urls.push(typeof url==='string'?url:url instanceof URL?url.href:url.url);return Promise.resolve(new Response('offline',{status:503}))}}
  const news=new NewsService(options);await news.open();try{await news.configure({enabled:true,interests:['graphics'],explore:true});await news.refresh();assert.ok(urls.length>=2);if(language.startsWith('zh'))assert.ok(urls.every(u=>!u.includes('bbc')&&!u.includes('theguardian')));else assert.ok(urls.every(u=>!u.includes('ithome')&&!u.includes('sspai')&&!u.includes('solidot')&&!u.includes('36kr')))}finally{await news.close()}
 }}finally{await rm(dir,{recursive:true,force:true})}
})
test('language restart hides foreign cached and saved items without deleting user saves',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-news-switch-')),path=join(dir,'news.json');const make=(language:string)=>new NewsService({path,language,now,fetcher:()=>Promise.resolve(new Response(xml))})
 let news=make('en');await news.open()
 try{await news.configure({enabled:true,interests:['AI'],explore:false});await news.refresh();const row=news.snapshot().items[0]!;await news.action({action:'save',id:row.id,value:true});await news.close();news=make('zh-CN');await news.open();assert.equal(news.snapshot().items.length,0);assert.equal(news.snapshot().saved.length,0);assert.equal(news.snapshot().pending,0);assert.throws(()=>news.conversionInput({id:row.id,content_hash:row.content_hash,kind:'idea',title:'Old language'}),/article_not_found/);await news.close();news=make('en');await news.open();assert.ok(news.snapshot().saved.some(a=>a.id===row.id))}finally{await news.close();await rm(dir,{recursive:true,force:true})}
})

test('stale preference edits cannot re-enable updates after the user pauses them',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-news-config-')),service=new NewsService({path:join(dir,'news.json')})
 try{await service.open();await service.configure({enabled:true,explore:true,interests:['AI']});const version=service.snapshot().profile_version
  await service.configure({enabled:false,explore:true,interests:['AI'],expected_version:version})
  await assert.rejects(service.configure({enabled:true,explore:false,interests:['AI'],expected_version:version}),/version_conflict/)
  assert.equal(service.snapshot().enabled,false)
 }finally{await service.close();await rm(dir,{recursive:true,force:true})}
})


test('first explicit empty preference save is durable and advances its version',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-news-empty-')),service=new NewsService({path:join(dir,'news.json')})
 try{await service.open();await service.configure({enabled:false,explore:true,interests:[],expected_version:0});assert.equal(service.snapshot().profile_version,1);assert.deepEqual(service.snapshot().interests,[])
  await service.close();await service.open();assert.equal(service.snapshot().profile_version,1);assert.deepEqual(service.snapshot().interests,[])
  await assert.rejects(service.configure({enabled:true,explore:true,interests:['AI'],expected_version:0}),/version_conflict/)
 }finally{await service.close();await rm(dir,{recursive:true,force:true})}
})
test('news starts on as a timeline, takes Profile interests once, and an explicit off stays off',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-news-default-'));let calls=0;const ranked:string[][]=[]
 const make=(firstRefreshMs?:number|null)=>new NewsService({path:join(dir,'news.json'),sources:[source],now,...(firstRefreshMs===undefined?{}:{firstRefreshMs}),fetcher:()=>{calls++;return Promise.resolve(new Response(xml))},rank:(interests,articles)=>{ranked.push(interests.map(i=>i.text));return Promise.resolve(articles.map(a=>({id:a.id,matches:[],reason:''})))}})
 let service=make(null)
 try{
  await service.open();assert.equal(service.snapshot().enabled,true);await service.refresh();assert.equal(calls,1);assert.deepEqual(ranked,[],'a timeline needs no ranker')
  assert.equal(await service.seedInterests([' AI ','AI','Design','']),true);assert.deepEqual(service.snapshot().interests.map(i=>i.text),['AI','Design']);assert.equal(service.snapshot().profile_version,1)
  assert.equal(await service.seedInterests(['Travel']),false,'a seeded profile is not reseeded');assert.deepEqual(service.snapshot().interests.map(i=>i.text),['AI','Design'])
  assert.equal(service.snapshot().interests_seeded,true)
  await service.refresh();assert.deepEqual(ranked,[],'guessed interests are not sent to the ranker');assert.equal(service.snapshot().mode,'timeline');assert.equal(service.snapshot().rank_error,null)
  await service.configure({enabled:true,interests:['AI','Design'],explore:true});assert.equal(service.snapshot().interests_seeded,false)
  await service.refresh();assert.deepEqual(ranked,[['AI','Design']],'once the user saves them, they rank')
  await service.configure({enabled:false,interests:['AI'],explore:false});await service.close();service=make(null);await service.open()
  assert.equal(service.snapshot().enabled,false,'an explicit off survives reopen');const before=calls;await service.refresh();assert.equal(calls,before)
  assert.equal(await service.seedInterests(['Travel']),false)
  await service.close();const file=JSON.parse(await readFile(join(dir,'news.json'),'utf8')) as Record<string,unknown>
  await writeFile(join(dir,'news.json'),JSON.stringify({...file,enabled:false,profile_version:0,interests:[]}))
  service=make(null);await service.open();assert.equal(service.snapshot().enabled,true,'the old never-configured default reads as on')
  await service.close();calls=0;service=make(5);await service.open();await service.refreshSoon();assert.equal(calls,0,'the first automatic refresh waits for launch work')
  for(let i=0;i<100&&!calls;i++)await new Promise(r=>setTimeout(r,10))
  assert.equal(calls,1,'then it runs on its own');await service.refreshSoon();assert.equal(calls,2,'afterwards a seed refreshes at once')
 }finally{await service.close();await rm(dir,{recursive:true,force:true})}
})
