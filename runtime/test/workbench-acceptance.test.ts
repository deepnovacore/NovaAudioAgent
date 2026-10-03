import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {assertOriginalProfilePaths,loadAcceptanceManifest} from '../src/desktop/workbench-acceptance.js'

function fixture(){
 const root=mkdtempSync(join(tmpdir(),'nova-acceptance-'))
 for(const name of ['electron','runtime','repo','output','other'])mkdirSync(join(root,name))
 const blackboard=join(root,'runtime/blackboard.sqlite');writeFileSync(blackboard,'');writeFileSync(blackboard+'.personal.json','{}')
 writeFileSync(blackboard+'.personal.json.sources.json',JSON.stringify({sources:[{view:{state:'connected'},processing_consent:{extraction_provider:'known',embedding_provider:'known'}}]}))
 const manifest={version:1,originalUserData:join(root,'electron'),originalBlackboardPath:blackboard,repository:join(root,'repo'),outputDirectory:join(root,'output'),buildCommit:'a'.repeat(40),providers:[{identity:'known',origin:'https://provider.invalid',models:['model']}],allowedIdentities:['known'],runCapSeconds:10}
 const manifestPath=join(root,'manifest.json');writeFileSync(manifestPath,JSON.stringify(manifest))
 const env={...process.env,NOVA_WORKBENCH_ACCEPTANCE_MANIFEST:manifestPath,NOVA_WORKBENCH_ACCEPTANCE_REPORT:join(root,'output/counts.ndjson'),BLACKBOARD_PATH:blackboard}
 return {root,manifest,manifestPath,env,close:()=>rmSync(root,{recursive:true,force:true})}
}
test('canonical Electron and blackboard boundaries are independently enforced',()=>{
 const f=fixture();try{
 const expected={userData:f.manifest.originalUserData,blackboardPath:f.manifest.originalBlackboardPath}
 assert.doesNotThrow(()=>assertOriginalProfilePaths(expected,expected))
 assert.throws(()=>assertOriginalProfilePaths({...expected,userData:join(f.root,'other')},expected),/wrong_user_data/)
 assert.throws(()=>assertOriginalProfilePaths({...expected,blackboardPath:join(f.root,'manifest.json')},expected),/wrong_blackboard/)
 }finally{f.close()}
})
test('report output cannot be inside original profile or repository',()=>{
 const f=fixture();try{
 assert.ok(loadAcceptanceManifest(f.env))
 writeFileSync(f.manifestPath,JSON.stringify({...f.manifest,outputDirectory:f.manifest.originalUserData}))
 assert.throws(()=>loadAcceptanceManifest(f.env),/output_inside/)
 }finally{f.close()}
})
test('real fetch/socket/http transports fail closed before network; persisted grants cannot be widened',()=>{
 const f=fixture();try{
 const moduleUrl=new URL('../src/desktop/workbench-acceptance.js',import.meta.url).href
 const code=`import assert from 'node:assert/strict';import net from 'node:net';import https from 'node:https';import http from 'node:http';import {request as undiciRequest} from 'undici';import {allowAcceptanceLoopback,installAcceptanceGate,assertAcceptanceGrant,assertPersistedAcceptanceGrant,probeAcceptanceGate} from ${JSON.stringify(moduleUrl)};
 net.Socket.prototype.connect=function(){return this};
 globalThis.fetch=async()=>{net.connect({host:'provider.invalid',port:443});return new Response('{}')};
 http.request=()=>({synthetic:true});
 installAcceptanceGate();
 assert.deepEqual(await probeAcceptanceGate(),{probeBlocked:true,probeTransport:'fetch',blockedAttempts:1});
 assertPersistedAcceptanceGrant({extraction_provider:'known',embedding_provider:'known'},${JSON.stringify(f.manifest.originalBlackboardPath+'.personal.json')});
 assert.throws(()=>assertPersistedAcceptanceGrant({extraction_provider:'known',embedding_provider:'known'},${JSON.stringify(f.manifest.originalBlackboardPath)}),/wrong_host_path/);
 allowAcceptanceLoopback('ws://127.0.0.1:48000/');
 assert.doesNotThrow(()=>http.request({host:'127.0.0.1',port:48000,path:'/'}));
 assert.throws(()=>http.request({hostname:'127.0.0.1',port:48001}),/unapproved_http_transport/);
 assert.throws(()=>http.request('http://127.0.0.1:48000/',{hostname:'unknown.invalid'}),/unapproved_http_transport/);
 assert.equal((await fetch('https://provider.invalid',{method:'POST',body:JSON.stringify({model:'model'})})).status,200);
 await assert.rejects(fetch('https://unknown.invalid',{method:'POST',body:'{}'}),/unknown_outbound/);
 await assert.rejects(fetch('https://provider.invalid',{method:'POST',body:JSON.stringify({model:'unknown'})}),/unknown_model/);
 assert.throws(()=>net.connect({host:'provider.invalid',port:443}),/unknown_socket/);
 assert.throws(()=>https.request('https://provider.invalid'),/unapproved_http_transport/);
 await assert.rejects(undiciRequest('https://provider.invalid'),/unapproved_dispatcher/);
 assert.throws(()=>assertAcceptanceGrant({extraction_provider:'known',embedding_provider:'known'},[{extraction_provider:'old',embedding_provider:'known'}]),/grant_mismatch/);
 assert.throws(()=>assertAcceptanceGrant({extraction_provider:'known',embedding_provider:null},[]),/embedding_provider_disabled/);
 assertAcceptanceGrant({extraction_provider:'known',embedding_provider:'known'},[{extraction_provider:'known',embedding_provider:'known'}]);`
 const child=spawnSync(process.execPath,['--input-type=module','-e',code],{env:f.env,encoding:'utf8'})
 assert.equal(child.status,0,child.stderr)
 const output=readFileSync(f.env.NOVA_WORKBENCH_ACCEPTANCE_REPORT,'utf8')
 assert.equal(output.includes('provider.invalid'),false);assert.equal(output.includes('known'),false)
 }finally{f.close()}
})

test('unrelated provider descriptors cannot piggyback on a source identity allowlist',()=>{
 const f=fixture();try{
 writeFileSync(f.manifestPath,JSON.stringify({...f.manifest,allowedIdentities:['known','unrelated'],providers:[...f.manifest.providers,{identity:'unrelated',origin:'https://unrelated.invalid',models:['other']}]}))
 const moduleUrl=new URL('../src/desktop/workbench-acceptance.js',import.meta.url).href
 const child=spawnSync(process.execPath,['--input-type=module','-e',`import assert from 'node:assert/strict';import {installAcceptanceGate} from ${JSON.stringify(moduleUrl)};assert.throws(()=>installAcceptanceGate(),/provider_outside_source_grant/);`],{env:f.env,encoding:'utf8'})
 assert.equal(child.status,0,child.stderr)
 }finally{f.close()}
})

test('acceptance host disables unrelated profile and understanding generators',()=>{
 const f=fixture();try{
 const gate=new URL('../src/desktop/workbench-acceptance.js',import.meta.url).href,host=new URL('../src/personal-agent/host.js',import.meta.url).href
 const code=`import assert from 'node:assert/strict';import {installAcceptanceGate} from ${JSON.stringify(gate)};import {PersonalAgentHost} from ${JSON.stringify(host)};installAcceptanceGate();const subject=new PersonalAgentHost({path:${JSON.stringify(f.manifest.originalBlackboardPath+'.personal.json')},userScope:'synthetic',memory:()=>undefined,pool:{},evidence:()=>null,generateProfile:()=>{throw Error('unrelated model')},understand:{},rankNews:()=>{throw Error('unrelated ranker')}});assert.equal(subject.profileWarmup.generate,undefined);assert.equal(subject.understanding.options.pipeline,undefined);assert.equal(subject.news.options.rank,undefined,'news stays a timeline under the gate');assert.equal(subject.news.options.firstRefreshMs,null,'no automatic feed reads unless the manifest turns news on');`
 const child=spawnSync(process.execPath,['--input-type=module','-e',code],{env:f.env,encoding:'utf8'})
 assert.equal(child.status,0,child.stderr)
 }finally{f.close()}
})

test('mandatory acceptance entry rejects missing gate environment before opening the synthetic profile',()=>{
 const f=fixture();try{
 const entry=new URL('../src/desktop-entry.js',import.meta.url)
 const child=spawnSync(process.execPath,[entry.pathname,'--nova-workbench-acceptance-required'],{env:{...f.env,NOVA_WORKBENCH_ACCEPTANCE_REPORT:'',NOVA_WORKBENCH_ACCEPTANCE_MANIFEST:''},encoding:'utf8'})
 assert.notEqual(child.status,0)
 assert.match(child.stderr,/acceptance_gate_missing/u)
 assert.equal(readFileSync(f.manifest.originalBlackboardPath,'utf8'),'')
 assert.equal(readFileSync(f.manifest.originalBlackboardPath+'.personal.json','utf8'),'{}')
 }finally{f.close()}
})

test('one provider identity cannot authorize an additional origin',()=>{
 const f=fixture();try{
 writeFileSync(f.manifestPath,JSON.stringify({...f.manifest,providers:[...f.manifest.providers,{identity:'known',origin:'https://extra.invalid',models:['model']}]}))
 assert.throws(()=>loadAcceptanceManifest(f.env),/provider_identity_multiple_origins/u)
 }finally{f.close()}
})

test('acceptance capability projection removes actual search and camera assembly paths',async()=>{
 const {acceptanceCapabilityRegistry}=await import('../src/desktop/workbench-acceptance.js')
 const {parseCapabilityRegistry}=await import('../src/config/capability-registry.js')
 const {settingsSchema}=await import('../src/config/config.js')
 const {buildAssembly}=await import('../src/composition/assembly.js')
 const configured=parseCapabilityRegistry({version:1,modules:{search:{enabled:true},camera:{enabled:true}}},{TAVILY_API_KEY:'synthetic'})
 const capabilities=acceptanceCapabilityRegistry(configured,true)
 const core=buildAssembly({settings:settingsSchema.parse({memory_connection:'disabled',executors:[],model_api_key:'synthetic'}),capabilities})
 try{
  assert.equal(core.runtime.executors.has('search'),false)
  assert.equal(core.tools.bindings.has('search__search'),false)
  assert.equal(core.visionController,undefined)
  assert.deepEqual(capabilities.mcpServers,{})
  assert.equal(configured.modules.search.enabled,true)
  assert.equal(configured.modules.camera.enabled,true)
  assert.equal(acceptanceCapabilityRegistry(configured,false),configured)
 }finally{await core.stop()}
})
test('runtime fingerprint changes when entry bytes change',async()=>{
 const {acceptanceRuntimeHash}=await import('../src/desktop/workbench-acceptance.js')
 const f=fixture();try{
 const entry=join(f.root,'entry.js');writeFileSync(entry,'first')
 const before=acceptanceRuntimeHash(entry);writeFileSync(entry,'second')
 assert.notEqual(acceptanceRuntimeHash(entry),before)
 }finally{f.close()}
})
test('fetch probe cannot certify a stub error without an actual blocked counter increment',()=>{
 const f=fixture();try{
 const gate=new URL('../src/desktop/workbench-acceptance.js',import.meta.url).href
 const code=`import assert from 'node:assert/strict';import {installAcceptanceGate,probeAcceptanceGate} from ${JSON.stringify(gate)};installAcceptanceGate();globalThis.fetch=async()=>{throw Error('acceptance_unknown_outbound')};await assert.rejects(probeAcceptanceGate(),/gate_probe_failed/);`
 const child=spawnSync(process.execPath,['--input-type=module','-e',code],{env:f.env,encoding:'utf8'})
 assert.equal(child.status,0,child.stderr)
 }finally{f.close()}
})
test('a chat call records its token counts, and only its counts, without consuming the caller\'s body',()=>{
 const f=fixture();try{
 const moduleUrl=new URL('../src/desktop/workbench-acceptance.js',import.meta.url).href
 const code=`import assert from 'node:assert/strict';import net from 'node:net';import {installAcceptanceGate} from ${JSON.stringify(moduleUrl)};
 net.Socket.prototype.connect=function(){return this};
 globalThis.fetch=async()=>{net.connect({host:'provider.invalid',port:443});return new Response(JSON.stringify({choices:[{message:{content:'private reply text'}}],usage:{prompt_tokens:1200,completion_tokens:340}}))};
 installAcceptanceGate();
 const response=await fetch('https://provider.invalid/v1/chat/completions',{method:'POST',body:JSON.stringify({model:'model'})});
 assert.equal((await response.json()).choices[0].message.content,'private reply text');
 await new Promise(resolve=>setTimeout(resolve,50));`
 const child=spawnSync(process.execPath,['--input-type=module','-e',code],{env:f.env,encoding:'utf8'})
 assert.equal(child.status,0,child.stderr)
 const output=readFileSync(f.env.NOVA_WORKBENCH_ACCEPTANCE_REPORT,'utf8')
 const usage=output.trim().split('\n').map(line=>JSON.parse(line) as {kind:string;counts:Record<string,number>}).find(row=>row.kind==='model_usage')
 assert.equal(usage?.counts.input_tokens,1200);assert.equal(usage?.counts.output_tokens,340)
 assert.equal(output.includes('private reply text'),false)
 }finally{f.close()}
})

test('news feeds pass the gate only when the manifest turns news on, and only as plain GETs',()=>{
 const f=fixture();try{
 const moduleUrl=new URL('../src/desktop/workbench-acceptance.js',import.meta.url).href
 const run=(news:boolean,body:string)=>{
  writeFileSync(f.manifestPath,JSON.stringify({...f.manifest,news}))
  const code=`import assert from 'node:assert/strict';import net from 'node:net';import {installAcceptanceGate,acceptanceNewsEnabled} from ${JSON.stringify(moduleUrl)};
 net.Socket.prototype.connect=function(){return this};
 const seen=[];globalThis.fetch=async (input,init)=>{seen.push(String(input)+' '+JSON.stringify(init?.headers??null));net.connect({host:new URL(String(input)).hostname,port:443});return new Response('<rss/>')};
 installAcceptanceGate();const feed='https://feeds.bbci.co.uk/news/rss.xml';${body}`
  const child=spawnSync(process.execPath,['--input-type=module','-e',code],{env:f.env,encoding:'utf8'})
  assert.equal(child.status,0,child.stderr)
  const rows=readFileSync(f.env.NOVA_WORKBENCH_ACCEPTANCE_REPORT,'utf8').trim().split('\n').map(line=>JSON.parse(line) as {kind:string;counts:Record<string,number>})
  rmSync(f.env.NOVA_WORKBENCH_ACCEPTANCE_REPORT);return rows
 }
 const off=run(false,`assert.equal(acceptanceNewsEnabled(),false);await assert.rejects(fetch(feed),/unknown_outbound/);`)
 assert.equal(off.find(row=>row.kind==='disabled_modules')?.counts.news,1)
 const on=run(true,`assert.equal(acceptanceNewsEnabled(),true);
 assert.equal((await fetch(feed)).status,200);assert.equal((await fetch('https://www.ithome.com/rss/',{method:'get'})).status,200);
 await assert.rejects(fetch(feed,{method:'POST',body:'{}'}),/news_get_only/);
 await assert.rejects(fetch(feed,{method:'PUT'}),/news_get_only/);
 await assert.rejects(fetch(feed+'?q=secret-query'),/news_get_only/,'no query data rides on a feed read');
 await assert.rejects(fetch('https://feeds.bbci.co.uk/other.xml'),/news_get_only/,'only the built-in feed paths');
 await assert.rejects(fetch(new Request(feed)),/news_get_only/,'a Request object would carry its own headers');
 assert.equal((await fetch(feed,{headers:{Authorization:'secret-token','X-Private':'secret-header'}})).status,200);
 assert.equal(seen.length,3);assert.ok(seen.every(line=>line.includes('NovaAudioAgent-News')&&!line.includes('secret')),seen.join('|'));
 await assert.rejects(fetch('https://feeds.bbci.co.uk.invalid/rss.xml'),/unknown_outbound/);
 await assert.rejects(fetch('http://feeds.bbci.co.uk/news/rss.xml'),/unknown_outbound/);
 assert.throws(()=>net.connect({host:'feeds.bbci.co.uk',port:443}),/unknown_socket/);`)
 assert.equal(on.find(row=>row.kind==='disabled_modules')?.counts.news,0)
 assert.equal(on.filter(row=>row.kind==='news_fetch'&&row.counts.ok===1).length,3)
 assert.ok(!JSON.stringify(on).includes('bbc'),'counts carry no feed identity')
 }finally{f.close()}
})
