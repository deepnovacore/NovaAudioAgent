import assert from 'node:assert/strict'
import {mkdtemp,realpath,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,isAbsolute} from 'node:path'
import {MemoryLedgerClient} from '../../dist/src/memory-ledger/store-client.js'
import {SubstrateMemoryResource} from '../../dist/src/memory-substrate/resource.js'
import {PersonalAgentHost} from '../../dist/src/personal-agent/host.js'
import {SuggestionPool} from '../../dist/src/core/suggestions.js'
import {UnifiedRetrieval} from '../../dist/src/memory/retrieval.js'

// Real host, worker and files; every input is synthetic and external calls are forbidden.
const directory=await mkdtemp(join(await realpath(tmpdir()),'nova-life-objects-live-'))
const output=process.env.NOVA_LIVE_MODULE_REPORT??join(directory,'result.json')
assert.ok(isAbsolute(output))
const report={version:1,module:'life-objects',layer:'runtime-live',synthetic:true,status:'failed',started_at:new Date().toISOString(),checks:[],coverage:['Life types, dates, current revisions and canonical evidence','reschedule, completion/cancellation, reminder invalidation and restart','explicit news conversion and durable source deduplication'],limitations:['Synthetic runtime integration only; no real model, native GUI, physical voice or external account.'],artifacts:{directory}}
let memory,host,sequence=0
const gateway={async *stream(){throw Error('Unexpected model call')},complete(){return Promise.reject(Error('Unexpected model call'))}}
async function open(){
 memory=new SubstrateMemoryResource({client:new MemoryLedgerClient(join(directory,'ledger.sqlite')),userId:'synthetic-life',gateway,model:'synthetic',inputConsent:true,conversationProviders:['synthetic'],consolidation:{enabled:false}})
 await memory.open()
 host=new PersonalAgentHost({path:join(directory,'host.json'),userScope:'synthetic-life',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null})
 await host.open()
}
async function command(method,params){const result=await host.command({type:'personal.command',request_id:'life-live-'+(++sequence),method,params});assert.equal(result.ok,true,JSON.stringify(result));return result.data}
const entry=async id=>(await memory.list()).entries.find(row=>row.life?.id===id)
const pass=name=>{report.checks.push(name);console.log('PASS',name)}
try{
 await open()
 const forged=await host.command({type:'personal.command',request_id:'forged-news',method:'life.mutate',params:{op:'from_news',kind:'todo',title:'Synthetic forged item',article:{article_id:'invented',source_id:'invented',url:'https://example.com/unverified',content_hash:'fiction',title:'Unverified',summary:'',published_at:null}}})
 assert.equal(forged.ok,false,'Generic Life command must reject an unverified news snapshot')
 assert.equal(host.life.snapshot().todos.length,0);pass('generic Life command cannot forge a verified news source')
 const todo=await command('life.mutate',{op:'create',kind:'todo',title:'Synthetic orchid report',due:'2026-10-01'})
 let row=await entry(todo.id);assert.equal(row.kind,'todo');assert.equal(row.life.due,'2026-10-01')
 const retrieval=new UnifiedRetrieval({memory:()=>memory})
 let recalled=await retrieval.recall('orchid',{consumer:'synthetic'})
 assert.equal(recalled.entries[0].life.status,'open');assert.ok(recalled.entries[0].evidence_refs.length)
 assert.equal((await retrieval.evidence(recalled.entries[0].evidence_refs[0],{consumer:'synthetic'})).state,'ok')
 pass('real Life object exposes its kind, local date, current revision and canonical original')
 const proposal={kind:'question',summary:'Review synthetic orchid report?',why_now:'Synthetic due item',evidence_refs:[],memory_refs:[{entry_id:row.id,version:row.version}]}
 assert.equal(await host.admit(proposal,await host.discoverySnapshot()),'admitted')
 await command('life.mutate',{op:'update',kind:'todo',id:todo.id,expected_version:1,due:'2026-10-03'})
 await host.sourceChanged();assert.equal(host.snapshot().feed[0].lifecycle,'invalidated')
 row=await entry(todo.id);assert.equal(row.life.due,'2026-10-03');assert.equal(row.version,2)
 await command('life.mutate',{op:'update',kind:'todo',id:todo.id,expected_version:2,status:'done'})
 const cancelled=await command('life.mutate',{op:'create',kind:'todo',title:'Synthetic cancelled task',due:'2026-10-01'})
 await command('life.mutate',{op:'update',kind:'todo',id:cancelled.id,expected_version:1,status:'cancelled'})
 assert.equal((await host.discoverySnapshot()).memory.some(item=>item.life?.id===todo.id||item.life?.id===cancelled.id),false)
 recalled=await retrieval.recall('orchid',{consumer:'synthetic'});assert.equal(recalled.entries[0].life.status,'done')
 pass('reschedule invalidates old reminder; done/cancelled objects remain history but leave discovery')
 host.news.options.fetcher=async()=>new Response('<rss><channel><item><title>Synthetic public article</title><link>https://example.com/synthetic-article</link><description>Public fixture excerpt, not a user fact.</description></item></channel></rss>',{status:200})
 await host.news.configure({enabled:true,explore:false,interests:['synthetic']});await host.news.refresh()
 const article=host.news.snapshot().items[0];assert.ok(article)
 const conversion={id:article.id,content_hash:article.content_hash,kind:'idea',title:'My synthetic idea',note:'User-authored intention'}
 const idea=await command('news.convert',conversion)
 await command('life.mutate',{op:'update',kind:'idea',id:idea.id,expected_version:1,title:'My revised idea'})
 const retry=await command('news.convert',conversion);assert.equal(retry.id,idea.id);assert.equal(retry.version,2)
 assert.equal(host.life.snapshot().ideas[0].news_source.action,'user_conversion')
 await host.news.configure({enabled:false,explore:false,interests:['synthetic']})
 pass('explicit news conversion retains public provenance and retries preserve user edits')
 await host.close();await memory.close();await open()
 assert.equal((await entry(todo.id)).life.status,'done')
 assert.equal((await entry(todo.id)).life.due,'2026-10-03')
 assert.equal(host.snapshot().feed[0].lifecycle,'invalidated')
 const again=await command('news.convert',conversion);assert.equal(again.id,idea.id)
 assert.equal(host.life.snapshot().ideas.length,1);assert.equal(host.life.snapshot().ideas[0].title,'My revised idea')
 pass('restart retains lifecycle, local date, invalidation and same-article deduplication')
 report.status='passed'
}catch(error){report.failure={name:error.name,message:error.message};console.error('FAIL',report.failure);process.exitCode=1}
finally{
 try{await host?.close();await memory?.close()}catch(error){report.status='failed';report.cleanup_error=error.message;process.exitCode=1}
 report.finished_at=new Date().toISOString();await writeFile(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log('Life runtime report:',output)
}
