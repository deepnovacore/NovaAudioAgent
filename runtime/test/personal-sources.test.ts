import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import {syncBuiltinESMExports} from 'node:module'
import {VoiceMem} from 'voicemem'
import {VersionedMemory} from '../src/voicemem/versioned-memory.js'
import {mkdtemp, mkdir, writeFile, rm, realpath, symlink, rename, readFile, utimes, stat, chmod} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {LocalDirectorySources} from '../src/personal-agent/sources.js'
import {GitActivityCache,gitIgnoredDirectories,nextComputerRoot,orderComputerRoots,rootActivity} from '../src/personal-agent/source-priority.js'
import {scanDirectory} from '../src/personal-agent/source-walk.js'
import {KnowledgeService, type KnowledgeEvidenceLedger} from '../src/knowledge/service.js'
import {KnowledgeStoreClient} from '../src/knowledge/store-client.js'

async function fixture(realMemory = false, priorityWorkspace?:()=>Promise<string|null>, directorySafetyCap?:number, contentRecheckMs?:number, observationRetryMs=100) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'nova-directory-'))
  const folder = join(root, 'allowed'); await mkdir(folder)
  let failEmbedding = false, failInvalidation = false, failConsent=false
  let embeddingHook: () => Promise<void> = () => Promise.resolve(), ingestHook: () => Promise<void> = () => Promise.resolve()
  // Scan-time ingestion commits before embedding, so failures and gates are injected at the index commit.
  const store = new KnowledgeStoreClient({path: join(root, 'db', 'knowledge.sqlite')}), replace = store.replaceSource.bind(store)
  const record = store.recordJob.bind(store)
  store.replaceSource = async input => {if (failEmbedding) throw new Error('offline'); await replace(input)}
  store.recordJob = async input => {if (input.state === 'running') await ingestHook(); await record(input)}
  const knowledge = new KnowledgeService({store,
    embedding: {id: 'test', dims: 2, embed: texts => embeddingHook().then(() => texts.map(() => new Float32Array([1, 0])))}})
  await knowledge.open()
  const embeddings = {model:'test', embed: (texts: readonly string[]) => Promise.resolve(texts.map(() => [1,0]))}
  const native = realMemory ? new VoiceMem({path:join(root,'memory.sqlite'), userId:'test', embeddings, model:{complete:()=> Promise.resolve('{}')}}) : undefined
  const memory = native ? new VersionedMemory(native,'test',embeddings) : undefined
  let memoryAvailable = true
  const invalidated: string[] = []
  const observations: {content: string; source_ref: {ref: string}}[] = []
  let observeHook:(value:{content:string;source_ref:{type:'file';ref:string;observed_at:string};topic?:string})=>void|Promise<void>=()=>undefined
  let changeHook:()=>void|Promise<void>=()=>undefined
  const options = {computerRoot:folder,...(priorityWorkspace?{priorityWorkspace}:{}),...(directorySafetyCap?{directorySafetyCap}:{}),...(contentRecheckMs!==undefined?{contentRecheckMs}:{}),processingGrant:(consent:boolean,revision:number,scope_revision:number)=>({revision,scope_revision,extraction_provider:consent?'test':null,embedding_provider:consent?'test':null}),path: join(root, 'db', 'sources.json'), knowledge, pollMs: 0,
    onProcessingConsent:()=>failConsent?Promise.reject(Error('grant_write_failed')):Promise.resolve(),
    onChange: async()=>{await changeHook()},
    observationRetryMs,
    onObserve: async (value: {content: string; source_ref: {type:'file'; ref: string; observed_at:string}; topic?:string}) => {
      await observeHook(value)
      if (!memoryAvailable) throw new Error('memory_unavailable')
      if (memory) await memory.observeSource(value)
      observations.push(value)
    },
    onInvalidate: (ref: string) => { if (failInvalidation) throw new Error('interrupted'); invalidated.push(ref); memory?.forgetSource(ref) }}
  let sources = new LocalDirectorySources(options)
  await sources.open()
  return {root, folder, knowledge, invalidated, observations, memory, setFailConsent(value:boolean){failConsent=value},setMemoryAvailable(value:boolean) {memoryAvailable=value}, setEmbeddingHook(hook: () => Promise<void>) {embeddingHook = hook}, setIngestHook(hook: () => Promise<void>) {ingestHook = hook}, setFail(value: boolean) {failEmbedding = value}, setFailInvalidation(value: boolean) {failInvalidation = value}, get sources() {return sources},
    reopen: async () => {await sources.close(); sources = new LocalDirectorySources(options); await sources.open()},
    setObserveHook(hook:typeof observeHook){observeHook=hook},
    setChangeHook(hook:typeof changeHook){changeHook=hook},
    close: async () => {await sources.close(); await knowledge.close(); await native?.close(); await rm(root, {recursive: true, force: true})}}
}

test('failed authority update does not publish a durable successful consent revocation',async()=>{
 const f=await fixture()
 try{
  await f.sources.command('sources.add',{path:f.folder,consent:true});f.setFailConsent(true)
  await assert.rejects(f.sources.command('sources.consent',{id:f.sources.list()[0]!.id,consent:false}),/grant_write_failed/)
  await f.reopen()
  assert.equal(f.sources.list()[0]!.processing_consent_required,false)
 }finally{await f.close()}
})

test('changed processing provider requires renewed consent',async()=>{
 const f=await fixture()
 try{
  await f.sources.command('sources.add',{path:f.folder,consent:true});await f.sources.close()
  const path=join(f.root,'db','sources.json'),state=JSON.parse(await readFile(path,'utf8')) as {sources:{processing_consent:{extraction_provider:string}}[]}
  state.sources[0]!.processing_consent.extraction_provider='old-provider';await writeFile(path,JSON.stringify(state));await f.reopen()
  assert.equal(f.sources.list()[0]!.processing_consent_required,true)
 }finally{await f.close()}
})

test('snapshot open reads indexed file context without starting a scan',async()=>{
 const f=await fixture()
 try{
  await writeFile(join(f.folder,'readme.md'),'Next step: review the local note.')
  await f.sources.command('sources.add',{path:f.folder,consent:true})
  await f.sources.close()
  await writeFile(join(f.folder,'new.md'),'New file should not be indexed by a snapshot open.')
  let syncCalls=0
  const sources=new LocalDirectorySources({path:join(f.root,'db','sources.json'),pollMs:0,scanOnOpen:false,
   processingGrant:(consent,revision,scope_revision)=>({revision,scope_revision,extraction_provider:consent?'test':null,embedding_provider:consent?'test':null}),
   knowledge:{listSources:()=>f.knowledge.listSources(),handle:(...args)=>f.knowledge.handle(...args),syncFile:(...args)=>{syncCalls++;return f.knowledge.syncFile(...args)}}})
  try{await sources.open();assert.equal(syncCalls,0);assert.equal(sources.contextEntries().length,1);assert.match(sources.contextEntries()[0]!.content,/review the local note/u)}finally{await sources.close()}
 }finally{await f.close()}
})

test('legacy retry fields on indexed files do not block source startup',async()=>{
 const f=await fixture()
 try{
  await writeFile(join(f.folder,'readme.md'),'Next step: review the local note.')
  await f.sources.command('sources.add',{path:f.folder,consent:true})
  await f.sources.close()
  const path=join(f.root,'db','sources.json')
  const state=JSON.parse(await readFile(path,'utf8')) as {sources:{files:Record<string,unknown>[]}[]}
  assert.ok(state.sources[0]!.files.length)
  Object.assign(state.sources[0]!.files[0]!,{attempts:1,eligible_at:Date.now(),reason:'retry'})
  await writeFile(path,JSON.stringify(state))
  await f.reopen()
  assert.equal(f.sources.contextEntries().length,1)
  const migrated=JSON.parse(await readFile(path,'utf8')) as {sources:{files:Record<string,unknown>[]}[]}
  assert.equal('attempts' in migrated.sources[0]!.files[0]!,false)
 }finally{await f.close()}
})

test('source state with a legacy 51st failure still opens and keeps the failure cap',async()=>{
 const f=await fixture()
 try{
  await f.sources.command('sources.add',{path:f.folder,consent:true});await f.sources.close()
  const path=join(f.root,'db','sources.json'),state=JSON.parse(await readFile(path,'utf8')) as {sources:{view:{failures:{path:string;code:string}[]}}[]}
  state.sources[0]!.view.failures=Array.from({length:51},(_,index)=>({path:`file-${index}`,code:'source_unavailable'}))
  await writeFile(path,JSON.stringify(state))
  const sources=new LocalDirectorySources({path,pollMs:0,scanOnOpen:false,knowledge:f.knowledge,processingGrant:(consent,revision,scope_revision)=>({revision,scope_revision,extraction_provider:consent?'test':null,embedding_provider:consent?'test':null})})
  try{await sources.open();assert.equal(sources.list()[0]!.failures.length,50);assert.equal(sources.list()[0]!.failures[0]!.path,'file-1');assert.equal(sources.list()[0]!.failures.at(-1)!.path,'file-50')}finally{await sources.close()}
 }finally{await f.close()}
})

test('computer scan does not descend into directories a repository ignores',async()=>{
 const f=await fixture()
 try{
  const repo=join(f.folder,'project');await mkdir(join(repo,'outputs','run1'),{recursive:true})
  execFileSync('git',['init','-q',repo])
  await writeFile(join(repo,'.gitignore'),'outputs/\n');await writeFile(join(repo,'plan.md'),'Tracked plan')
  await writeFile(join(repo,'outputs','run1','report.md'),'Generated report')
  const {id}=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  for(let n=0;n<40&&(f.sources.list()[0]!.scan_pending||!(await f.knowledge.listSources()).length);n++)await f.sources.command('sources.sync',{id})
  const locators=(await f.knowledge.listSources()).map(source=>source.locator)
  assert.ok(locators.some(locator=>locator.endsWith('plan.md')),locators.join())
  assert.ok(!locators.some(locator=>locator.includes('outputs')),'ignored output is never read')
  assert.ok((f.sources.list()[0]!.reasons.git_ignored??0)>=1)
 }finally{await f.close()}
})

test('a failed ignore probe reports no answer instead of an empty repository',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'nova-ignore-probe-'))
 try{
  assert.equal(await gitIgnoredDirectories(join(root,'missing')),null,'a failure must not be cached as nothing ignored')
  execFileSync('git',['init','-q',root]);await mkdir(join(root,'out'));await writeFile(join(root,'out','x.md'),'x');await writeFile(join(root,'.gitignore'),'out/\n')
  assert.deepEqual([...(await gitIgnoredDirectories(root))!],[join(root,'out')])
 }finally{await rm(root,{recursive:true,force:true})}
})

test('watch hints cannot enter an ignored repository subtree directly',async t=>{
 const originalWatch=fs.watch
 t.mock.method(fs,'watch',(path:string,options:fs.WatchOptions,listener:fs.WatchListener<string|Buffer>)=>{
  const watcher=originalWatch(path,options,listener)
  queueMicrotask(()=>listener('change','project/outputs/run1/report.md'))
  return watcher
 })
 syncBuiltinESMExports()
 const f=await fixture()
 try{
  const repo=join(f.folder,'project');await mkdir(join(repo,'outputs','run1'),{recursive:true})
  execFileSync('git',['init','-q',repo])
  await writeFile(join(repo,'.gitignore'),'outputs/\n');await writeFile(join(repo,'plan.md'),'Tracked plan')
  await writeFile(join(repo,'outputs','run1','report.md'),'Generated report')
  const {id}=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  for(let n=0;n<40&&(f.sources.list()[0]!.scan_pending||!(await f.knowledge.listSources()).length);n++)await f.sources.command('sources.sync',{id})
  const locators=(await f.knowledge.listSources()).map(source=>source.locator)
  assert.ok(locators.some(locator=>locator.endsWith('plan.md')),locators.join())
  assert.ok(!locators.some(locator=>locator.includes('outputs')),'watch hints must honor repository ignores')
 }finally{await f.close();t.mock.restoreAll();syncBuiltinESMExports()}
})

test('failed repository ignore lookup defers scanning and can be retried',async()=>{
 const f=await fixture(),previous=process.env.GIT_CONFIG_COUNT
 try{
  execFileSync('git',['init','-q',f.folder]);await writeFile(join(f.folder,'plan.md'),'A plan')
  process.env.GIT_CONFIG_COUNT='invalid'
  const {id}=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  await f.sources.command('sources.sync',{id})
  assert.equal((await f.knowledge.listSources()).length,0)
  assert.ok((f.sources.list()[0]!.reasons.directory_unavailable??0)>0)
  if(previous===undefined)delete process.env.GIT_CONFIG_COUNT;else process.env.GIT_CONFIG_COUNT=previous
  await f.sources.command('sources.sync',{id})
  assert.ok((await f.knowledge.listSources()).some(source=>source.locator.endsWith('plan.md')))
 }finally{
  if(previous===undefined)delete process.env.GIT_CONFIG_COUNT;else process.env.GIT_CONFIG_COUNT=previous
  await f.close()
 }
})

test('computer scan settles files larger than its total byte budget without retrying them',async()=>{
 const f=await fixture()
 try{
  const oversized=join(f.folder,'oversized.md');await writeFile(oversized,'01234567890')
  const {id}=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  await f.sources.close()
  const path=join(f.root,'db','sources.json'),state=JSON.parse(await readFile(path,'utf8')) as {sources:{view:{max_bytes:number};walk:unknown}[]}
  state.sources[0]!.view.max_bytes=10
  state.sources[0]!.walk={queue:[],pending:[{path:oversized,size:11,mtime:1,unit:f.folder}]}
  await writeFile(path,JSON.stringify(state))
  const sources=new LocalDirectorySources({path,pollMs:0,scanOnOpen:false,computerRoot:f.folder,knowledge:f.knowledge,processingGrant:(consent,revision,scope_revision)=>({revision,scope_revision,extraction_provider:consent?'test':null,embedding_provider:consent?'test':null})})
  try{
   await sources.open();await sources.command('sources.sync',{id})
   const source=sources.list()[0]!
   const saved=JSON.parse(await readFile(path,'utf8')) as {sources:{walk:{pending:{path:string}[]}|null}[]}
   assert.equal(source.reasons.body_budget,1)
   assert.equal(source.scan_pending,false)
   assert.equal(source.coverage,'partial')
   assert.equal(source.health,'degraded')
   assert.equal(saved.sources[0]!.walk?.pending?.some(file=>file.path===oversized)??false,false)
  }finally{await sources.close()}
 }finally{await f.close()}
})

test('legacy excluded computer files clean in bounded batches and retry invalid records after restart',async()=>{
 const f=await fixture()
 try{
  const {id}=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  await f.sources.close()
  const path=join(f.root,'db','sources.json'),disk=JSON.parse(await readFile(path,'utf8')) as {sources:{files:unknown[];walk:{queue:{path:string;offset?:number}[];ledger:unknown[];generation:number;turn:number;cursors:number[];pending:unknown[];deferred:unknown[]}}[]}
  const hidden=join(f.folder,'.worktrees','legacy');await mkdir(hidden,{recursive:true})
  await writeFile(join(f.folder,'fresh.md'),'A current project note with a concrete idea.')
  const entries=Array.from({length:65},(_,i)=>({path:join(hidden,`legacy-${i}.md`),size:1,mtime:1,unit:f.folder,id:`legacy-${i}`,fingerprint:'old',owned:true,valid:true,excerpt:null,observed:false,observation_ref:`observation-${i}`}))
  disk.sources[0]!.files=entries
  disk.sources[0]!.walk={queue:[{path:f.folder,offset:0}],ledger:[],generation:1,turn:0,cursors:[0,0,0],pending:[],deferred:[]}
  await writeFile(path,JSON.stringify(disk))
  const invalidated:(readonly string[])[]=[]
  const hiddenBatches:(readonly string[])[]=[]
  const handle=(method:string,args:unknown)=>{assert.equal(method,'knowledge.remove');removed.push((args as {id:string}).id);return Promise.resolve({})}
  const removed:string[]=[]
  const knowledge={listSources:()=>Promise.resolve([]),handle:async(method:string,args:unknown)=>handle(method,args),syncFile:(...args:Parameters<typeof f.knowledge.syncFile>)=>f.knowledge.syncFile(...args)}
  const options={path,computerRoot:f.folder,pollMs:0,scanOnOpen:false,knowledge,processingGrant:(consent:boolean,revision:number,scope_revision:number)=>({revision,scope_revision,extraction_provider:consent?'test':null,embedding_provider:consent?'test':null}),onHideEvidenceMany:(refs:readonly string[])=>{hiddenBatches.push(refs)},onInvalidateMany:(refs:readonly string[])=>{invalidated.push(refs);throw Error('poisoned_batch_ref')},onInvalidate:(ref:string)=>{if(ref==='legacy-5')throw Error('poisoned_file_ref')}}
  let sources=new LocalDirectorySources(options)
  try{
   await sources.open();assert.equal(sources.list()[0]!.state,'connected');await sources.command('sources.sync',{id});assert.equal(sources.list()[0]!.state,'connected')
   const interrupted=JSON.parse(await readFile(path,'utf8')) as {sources:{files:{id:string;valid:boolean}[];walk:{queue:{path:string}[]}}[]}
   assert.equal(removed.length,7,'per-file fallback cleans healthy neighbors around the poison record')
   assert.equal(interrupted.sources[0]!.files.filter(file=>!file.valid).length,58)
   assert.ok(sources.list()[0]!.scanned>=1,'visible discovery continues despite cleanup failure')
   assert.equal(sources.list()[0]!.scan_pending,true)
   assert.ok(invalidated.length>=1)
   assert.equal(hiddenBatches.length,1,'all legacy evidence refs are hidden in one persisted pass')
   await sources.close();sources=new LocalDirectorySources(options);await sources.open()
   for(let i=0;i<12;i++)await sources.command('sources.sync',{id})
   const recovered=JSON.parse(await readFile(path,'utf8')) as {sources:{files:{id:string;valid:boolean;cleanup_retry_at?:number}[]}[]}
   const legacy=recovered.sources[0]!.files.filter(file=>file.id.startsWith('legacy-'))
   assert.deepEqual(legacy.map(file=>file.id),['legacy-5'],'only the poison record remains after later batches drain')
   assert.equal(legacy[0]!.valid,false)
   assert.ok(legacy[0]!.cleanup_retry_at!>Date.now(),'poison record receives a retry deadline')
   assert.equal(removed.length,64)
   assert.equal(hiddenBatches.length,1,'restart does not resubmit already-hidden evidence refs')
  }finally{await sources.close()}
 }finally{await f.close()}
})

test('computer snapshots migrate legacy failures and clear current health after a clean batch',async()=>{
 const f=await fixture()
 try{
  const {id}=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  await f.sources.close()
  const path=join(f.root,'db','sources.json'),state=JSON.parse(await readFile(path,'utf8')) as {sources:{view:{state:string;failures:{path:string;code:string}[]};walk:unknown}[]}
  state.sources[0]!.view.failures=Array.from({length:51},(_,index)=>({path:`file-${index}`,code:'source_unavailable'}))
  state.sources[0]!.view.state='error'
  state.sources[0]!.walk={queue:[],pending:[]}
  await writeFile(path,JSON.stringify(state))
  const sources=new LocalDirectorySources({path,pollMs:0,scanOnOpen:false,computerRoot:f.folder,knowledge:f.knowledge,processingGrant:(consent,revision,scope_revision)=>({revision,scope_revision,extraction_provider:consent?'test':null,embedding_provider:consent?'test':null})})
  try{
   await sources.open();assert.ok(sources.list()[0]!.failures.length<=50)
   await sources.command('sources.sync',{id})
   const source=sources.list()[0]!
   assert.equal(source.state,'connected')
   assert.ok(source.failures.length<=50)
   assert.equal(source.failures.at(-1)?.path,'file-50')
  }finally{await sources.close()}
 }finally{await f.close()}
})

test('computer walk migrates legacy pending items at the index limit and settles them',async()=>{
 const f=await fixture()
 try{
  const pending=join(f.folder,'overflow.md');await writeFile(pending,'overflow')
  const {id}=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  await f.sources.close()
  const path=join(f.root,'db','sources.json'),state=JSON.parse(await readFile(path,'utf8')) as {sources:{walk:unknown;files:unknown[];view:unknown}[]}
  state.sources[0]!.files=Array.from({length:20000},(_,index)=>({path:join(f.folder,`old-${index}.md`),id:`id-${index}`,fingerprint:'x',size:1,mtime:1,owned:true,valid:true,excerpt:null,observed:true,observation_ref:null}))
  state.sources[0]!.walk={queue:[],pending:[{path:pending,size:8,mtime:1,unit:f.folder}]}
  await writeFile(path,JSON.stringify(state))
  const sources=new LocalDirectorySources({path,pollMs:0,scanOnOpen:false,computerRoot:f.folder,knowledge:f.knowledge,processingGrant:(consent,revision,scope_revision)=>({revision,scope_revision,extraction_provider:consent?'test':null,embedding_provider:consent?'test':null})})
  try{
   await sources.open();await sources.command('sources.sync',{id})
   assert.equal(sources.list()[0]!.reasons.index_limit,1)
   assert.equal(sources.list()[0]!.scan_pending,false)
  }finally{await sources.close()}
 }finally{await f.close()}
})

test('computer ingestion failures move to a bounded future retry with an attempt count',async()=>{
 const f=await fixture()
 try{
  const file=join(f.folder,'retry.md');await writeFile(file,'retry this later')
  const {id}=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  await f.sources.close()
  const path=join(f.root,'db','sources.json'),state=JSON.parse(await readFile(path,'utf8')) as {sources:{walk:unknown}[]}
  state.sources[0]!.walk={queue:[],pending:[{path:file,size:16,mtime:1,unit:f.folder}]}
  await writeFile(path,JSON.stringify(state));f.setFail(true)
  const sources=new LocalDirectorySources({path,pollMs:0,scanOnOpen:false,computerRoot:f.folder,knowledge:f.knowledge,processingGrant:(consent,revision,scope_revision)=>({revision,scope_revision,extraction_provider:consent?'test':null,embedding_provider:consent?'test':null})})
  try{
   await sources.open();await sources.command('sources.sync',{id})
   const saved=JSON.parse(await readFile(path,'utf8')) as {sources:{walk:{deferred:{path:string;attempts:number;eligible_at:number}[]}|null}[]}
   const retry=saved.sources[0]!.walk?.deferred.find(item=>item.path===file)
   assert.equal(sources.list()[0]!.scan_pending,true)
   assert.equal(retry?.attempts,1)
   assert.ok((retry?.eligible_at??0)>Date.now())
  }finally{await sources.close()}
 }finally{await f.close()}
})

test('full pending and deferred computer queues stay bounded across sync and reopen',async()=>{
 const f=await fixture()
 try{
  const first=join(f.folder,'pending-0.md');await writeFile(first,'x')
  const {id}=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  await f.sources.close()
  const path=join(f.root,'db','sources.json'),state=JSON.parse(await readFile(path,'utf8')) as {sources:{view:{max_bytes:number};walk:unknown}[]}
  const pending=Array.from({length:200},(_,index)=>({path:index===0?first:join(f.folder,`pending-${index}.md`),size:1,mtime:1,unit:f.folder}))
  const deferred=Array.from({length:200},(_,index)=>({path:join(f.folder,`deferred-${index}.md`),size:1,mtime:1,unit:f.folder,eligible_at:0,attempts:1,reason:'retry'}))
  state.sources[0]!.view.max_bytes=1
  state.sources[0]!.walk={queue:[],pending,deferred}
  await writeFile(path,JSON.stringify(state))
  const sources=new LocalDirectorySources({path,pollMs:0,scanOnOpen:false,computerRoot:f.folder,knowledge:f.knowledge,processingGrant:(consent,revision,scope_revision)=>({revision,scope_revision,extraction_provider:consent?'test':null,embedding_provider:consent?'test':null})})
  try{
   await sources.open();await sources.command('sources.sync',{id})
   assert.equal(sources.list()[0]!.scan_pending,true)
   await sources.close()
   const reopened=new LocalDirectorySources({path,pollMs:0,scanOnOpen:false,computerRoot:f.folder,knowledge:f.knowledge,processingGrant:(consent,revision,scope_revision)=>({revision,scope_revision,extraction_provider:consent?'test':null,embedding_provider:consent?'test':null})})
   try{
    await reopened.open()
    const saved=JSON.parse(await readFile(path,'utf8')) as {sources:{walk:{pending:{path:string}[];deferred:{path:string}[]}|null}[]}
    assert.ok((saved.sources[0]!.walk?.pending.length??0)<=200)
    assert.ok((saved.sources[0]!.walk?.deferred.length??0)<=200)
    assert.equal((saved.sources[0]!.walk?.pending.length??0)+(saved.sources[0]!.walk?.deferred.length??0),399)
   }finally{await reopened.close()}
  }finally{await sources.close()}
 }finally{await f.close()}
})

test('current read failures report partial health without making source state error',async()=>{
 const f=await fixture();f.setFail(true)
 try{
  await writeFile(join(f.folder,'failure.md'),'content that cannot be embedded now')
  await f.sources.command('sources.add',{path:f.folder,consent:true})
  const source=f.sources.list()[0]!
  assert.equal(source.state,'connected')
  assert.equal(source.health,'degraded')
  assert.equal(source.coverage,'partial')
  assert.equal(source.failures.length,1)
 }finally{await f.close()}
})

test('observation callback failures preserve indexed excerpts, continue, and retry after cooldown',async t=>{
 const f=await fixture();let calls=0,now=Date.now()
 t.mock.method(Date,'now',()=>now)
 f.setObserveHook(()=>{calls++;if(calls===1)throw Error('private callback details / secret')})
 try{
  await writeFile(join(f.folder,'a.md'),'first useful source excerpt')
  await writeFile(join(f.folder,'b.md'),'second useful source excerpt')
  const {id}=await f.sources.command('sources.add',{path:f.folder,consent:true}) as {id:string}
  const first=f.sources.list()[0]!
  assert.equal(first.state,'connected');assert.equal(first.indexed,2)
  assert.equal(first.health,'degraded');assert.equal(first.coverage,'partial')
  assert.equal(first.scan_pending,true)
  assert.equal(first.failures.at(-1)?.stage,'observe')
  assert.equal(first.failures.at(-1)?.code,'source_unavailable')
  assert.ok(!JSON.stringify(first).includes('private callback details'))
  assert.equal(f.observations.length,1)
  await f.sources.command('sources.sync',{id})
  assert.equal(calls,2,'a sync during cooldown does not retry the failed observation')
  now+=110
  await f.sources.command('sources.sync',{id})
  assert.equal(calls,3,'the failed observation is retried after cooldown')
  assert.equal(f.sources.list()[0]!.indexed,2)
  assert.equal(f.sources.list()[0]!.scan_pending,false)
  assert.equal(f.observations.length,2)
 }finally{await f.close()}
})

test('cooled-down observations do not consume the per-scan batch limit',async()=>{
 const f=await fixture(false,undefined,undefined,undefined,60_000);let calls=0
 f.setObserveHook(value=>{calls++;if(/(?:0[0-7])\.md/u.test(value.content))throw Error('retry this file later')})
 try{
  for(let i=0;i<10;i++){const path=join(f.folder,`${String(i).padStart(2,'0')}.md`);await writeFile(path,`source excerpt ${i}`);await utimes(path,new Date('2020-01-01'),new Date('2020-01-01'))}
  const {id}=await f.sources.command('sources.add',{path:f.folder,consent:true}) as {id:string}
  assert.equal(calls,8)
  assert.equal(f.observations.length,0)
  assert.equal(f.sources.list()[0]!.scan_pending,true)
  await f.sources.command('sources.sync',{id})
  assert.equal(calls,10,'the next two eligible files progress while the earlier eight cool down')
  assert.equal(f.observations.length,2)
 }finally{await f.close()}
})

test('directory scan pending ignores unselected files',async()=>{
 const f=await fixture()
 try{
  for(const name of ['a','b','c','d','e','f','g','h','i']){const path=join(f.folder,`${name}.md`);await writeFile(path,`notes ${name}`);await utimes(path,new Date('2020-01-01'),new Date('2020-01-01'))}
  const {id}=await f.sources.command('sources.add',{path:f.folder,consent:true}) as {id:string}
  assert.equal(f.observations.length,8)
  await mkdir(join(f.folder,'.git'))
  await f.sources.command('sources.consent',{id,consent:true})
  await f.sources.command('sources.sync',{id})
  assert.equal(f.observations.length,16)
  assert.equal(f.sources.list()[0]!.scan_pending,false)
 }finally{await f.close()}
})

test('final onChange errors persist a safe stage diagnostic and still reject the sync',async()=>{
 const f=await fixture();let calls=0
 f.setChangeHook(()=>{if(++calls===2)throw Error('private observer projection failure')})
 try{
  await writeFile(join(f.folder,'notes.md'),'a source note')
  await assert.rejects(f.sources.command('sources.add',{path:f.folder,consent:true}),/private observer projection failure/u)
  const source=f.sources.list()[0]!
  assert.equal(source.failures.at(-1)?.path,'')
  assert.equal(source.failures.at(-1)?.stage,'on_change_final')
  assert.equal(source.failures.at(-1)?.code,'source_unavailable')
  assert.ok(!JSON.stringify(source).includes('private observer projection failure'))
 }finally{await f.close()}
})

test('screening rejection is a local bounded diagnostic and never publishes file body', async () => {
  const f = await fixture()
  try {
    const secret = 'token=credential-value-123456789'
    await writeFile(join(f.folder, 'notes.md'), secret)
    await f.sources.command('sources.add', {path: f.folder, consent: true})
    const source = f.sources.list()[0]!
    assert.equal(source.failures[0]!.code, 'screening_rejected')
    assert.equal(source.state, 'connected')
    assert.deepEqual(f.sources.contextEntries(), [])
    assert.ok(!JSON.stringify(source).includes(secret))
  } finally {await f.close()}
})

test('successful retry clears current degraded health while retaining read failure diagnostics',async()=>{
 const f=await fixture()
 try{
  const file=join(f.folder,'recover.md');await writeFile(file,'retry can recover this source')
  const {id}=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  await f.sources.close()
  const path=join(f.root,'db','sources.json'),state=JSON.parse(await readFile(path,'utf8')) as {sources:{walk:unknown}[]}
  state.sources[0]!.walk={queue:[],pending:[{path:file,size:29,mtime:1,unit:f.folder}]}
  await writeFile(path,JSON.stringify(state));f.setFail(true)
  const sources=new LocalDirectorySources({path,pollMs:0,scanOnOpen:false,computerRoot:f.folder,knowledge:f.knowledge,processingGrant:(consent,revision,scope_revision)=>({revision,scope_revision,extraction_provider:consent?'test':null,embedding_provider:consent?'test':null})})
  try{
   await sources.open();await sources.command('sources.sync',{id})
   assert.equal(sources.list()[0]!.health,'degraded')
   assert.equal(sources.list()[0]!.coverage,'partial')
   await sources.close()
   const retryState=JSON.parse(await readFile(path,'utf8')) as {sources:{walk:{deferred:{eligible_at:number}[]}|null}[]}
   assert.ok(retryState.sources[0]!.walk?.deferred.length)
   retryState.sources[0]!.walk.deferred[0]!.eligible_at=0
   await writeFile(path,JSON.stringify(retryState));f.setFail(false)
   const retrying=new LocalDirectorySources({path,pollMs:0,scanOnOpen:false,computerRoot:f.folder,knowledge:f.knowledge,processingGrant:(consent,revision,scope_revision)=>({revision,scope_revision,extraction_provider:consent?'test':null,embedding_provider:consent?'test':null})})
   try{
    await retrying.open();await retrying.command('sources.sync',{id})
    const recovered=retrying.list()[0]!
    assert.equal(recovered.scan_pending,false)
    assert.equal(recovered.health,'healthy')
    assert.equal(recovered.coverage,'complete')
    assert.equal(recovered.reasons.read_failed,1)
   }finally{await retrying.close()}
  }finally{await sources.close()}
 }finally{await f.close()}
})

test('pausing a source stops its background embedding and resuming finishes it',async()=>{
 const f=await fixture();let calls=0,release!:()=>void
 const held=new Promise<void>(resolve=>{release=resolve})
 try{
  await writeFile(join(f.folder,'a.md'),'First note');await writeFile(join(f.folder,'b.md'),'Second note')
  f.setEmbeddingHook(()=>{calls++;return calls===1?held:Promise.resolve()})
  const {id}=await f.sources.command('sources.add',{path:f.folder,consent:true}) as {id:string}
  await f.sources.command('sources.pause',{id});release();await f.knowledge.vectorsSettled()
  assert.equal(calls,1,'the file queued behind the in-flight batch is not uploaded after the pause')
  const store=(await f.knowledge.listSources()).map(source=>source.id).sort()
  assert.equal(store.length,2)
  await f.sources.command('sources.resume',{id});for(let n=0;n<50&&calls<3;n++)await new Promise(resolve=>setTimeout(resolve,20));await f.knowledge.vectorsSettled()
  assert.ok(calls>=3,`resume embeds what the pause left pending (calls=${calls})`)
 }finally{release();await f.close()}
})

test('startup never embeds chunks of a paused source that its record does not own yet',async()=>{
 const f=await fixture();let calls=0
 try{
  await writeFile(join(f.folder,'a.md'),'Committed before the crash')
  f.setEmbeddingHook(()=>Promise.reject(Error('offline')))
  const {id}=await f.sources.command('sources.add',{path:f.folder,consent:true}) as {id:string}
  await f.knowledge.vectorsSettled();await f.sources.close()
  const path=join(f.root,'db','sources.json'),state=JSON.parse(await readFile(path,'utf8')) as {sources:{view:{state:string};files:{path:string;size:number;mtime:number}[];pending:unknown}[]}
  const file=state.sources[0]!.files[0]!
  state.sources[0]!.view.state='paused';state.sources[0]!.pending={path:file.path,size:file.size,mtime:file.mtime,owned:true,previous_updated_at:null};state.sources[0]!.files=[]
  await writeFile(path,JSON.stringify(state))
  f.setEmbeddingHook(()=>{calls++;return Promise.resolve()})
  const [orphan]=(await f.knowledge.listSources()).map(source=>source.id)
  let gate:Parameters<KnowledgeService['setVectorGate']>[0]|undefined
  const knowledge={listSources:()=>f.knowledge.listSources(),handle:(method:string,params:unknown)=>f.knowledge.handle(method,params),
   syncFile:(...args:Parameters<KnowledgeService['syncFile']>)=>f.knowledge.syncFile(...args),resumeVectors:()=>f.knowledge.resumeVectors(),
   setVectorGate:(value:NonNullable<typeof gate>)=>{gate=value;f.knowledge.setVectorGate(value)}}
  for(const scanOnOpen of [false,true]){
   const sources=new LocalDirectorySources({path,pollMs:0,scanOnOpen,knowledge,processingGrant:(consent,revision,scope_revision)=>({revision,scope_revision,extraction_provider:consent?'test':null,embedding_provider:consent?'test':null})})
   try{
    await sources.open();for(let n=0;n<10;n++)await new Promise(resolve=>setTimeout(resolve,10));await f.knowledge.vectorsSettled()
    if(!scanOnOpen)assert.equal(gate?.(orphan!,false),null,'an id no record owns yet stays fenced, even with a ledger that would allow it')
   }finally{await sources.close()}
   assert.equal(calls,0,`scanOnOpen=${scanOnOpen}: a paused source's chunks are not uploaded at startup`)
  }
  assert.ok(id)
 }finally{await f.reopen();await f.close()}
})
test('re-granting consent without a scan embeds what the withdrawal left pending',async()=>{
 const f=await fixture();let calls=0
 try{
  await writeFile(join(f.folder,'a.md'),'Waiting for vectors')
  f.setEmbeddingHook(()=>Promise.reject(Error('offline')))
  const {id}=await f.sources.command('sources.add',{path:f.folder,consent:true}) as {id:string}
  await f.knowledge.vectorsSettled()
  await f.sources.command('sources.consent',{id,consent:false})
  f.setEmbeddingHook(()=>{calls++;return Promise.resolve()})
  await f.sources.command('sources.consent',{id,consent:true})
  for(let n=0;n<50&&calls===0;n++)await new Promise(resolve=>setTimeout(resolve,10));await f.knowledge.vectorsSettled()
  assert.equal(calls,1,'the re-grant lifts the withdrawal fence and requeues the pending vectors')
 }finally{await f.close()}
})

test('legacy directory state without processing consent reads locally without embedding',async()=>{
 const f=await fixture();let embeddings=0
 try{
  await writeFile(join(f.folder,'readme.md'),'before')
  await f.sources.command('sources.add',{path:f.folder,consent:true});await f.sources.close()
  const path=join(f.root,'db','sources.json');const state=JSON.parse(await readFile(path,'utf8')) as {sources:{processing_consent?:unknown}[]}
  delete state.sources[0]!.processing_consent;await writeFile(path,JSON.stringify(state))
  await writeFile(join(f.folder,'another.md'),'new local content')
  f.setEmbeddingHook(()=>{embeddings++;return Promise.resolve()});await f.reopen()
  assert.equal(embeddings,0);assert.equal(f.sources.list()[0]!.processing_consent_required,true)
  assert.ok((await f.knowledge.listSources()).some(s=>s.locator.endsWith('another.md')))
 }finally{await f.close()}
})

test('local sources use explicit grants, exclude private trees and reconcile durable scoped knowledge', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.folder, 'readme.md'), 'The blue lamp is ready.')
    for (const name of ['.git', 'node_modules', 'Browser']) {await mkdir(join(f.folder, name)); await writeFile(join(f.folder, name, 'private.md'), 'Never read this')}
    await writeFile(join(f.folder, '.env'), 'secret')
    await writeFile(join(f.root, 'outside.md'), 'Outside grant')
    await symlink(join(f.root, 'outside.md'), join(f.folder, 'escape.md'))
    await assert.rejects(f.sources.command('sources.add', {path: f.folder}), /invalid_request/)
    await assert.rejects(f.sources.command('sources.add', {path: join(f.folder, 'Browser'), consent: true}), /path_denied/)
    assert.equal((await f.knowledge.listSources()).length, 0)
    await f.sources.command('sources.add', {path: f.folder, consent: true})
    const source = f.sources.list()[0]!
    assert.equal(source.read, 1)
    assert.ok(source.excludes.includes('Browser'))
    assert.ok(source.skipped >= 5)
    assert.equal((await f.knowledge.listSources()).length, 1)
    const ref = f.sources.evidenceSnapshot()[0]!.ref
    assert.ok(f.sources.evidence(ref))
    await f.reopen()
    assert.equal(f.sources.list()[0]!.id, source.id)
    await f.sources.command('sources.pause', {id: source.id})
    await writeFile(join(f.folder, 'new.md'), 'Another file')
    await f.sources.command('sources.sync', {id: source.id})
    assert.equal((await f.knowledge.listSources()).length, 1)
    await f.sources.command('sources.resume', {id: source.id})
    assert.equal((await f.knowledge.listSources()).length, 2)
    await rm(join(f.folder, 'readme.md'))
    await f.sources.command('sources.sync', {id: source.id})
    assert.equal((await f.knowledge.listSources()).length, 1)
    assert.ok(f.invalidated.includes(ref))
    assert.equal(f.sources.evidence(ref), null)
    await f.sources.command('sources.disconnect', {id: source.id})
    for (const method of ['sources.pause', 'sources.resume', 'sources.sync']) await assert.rejects(f.sources.command(method, {id: source.id}), /source_disconnected/)
    assert.equal(f.sources.list()[0]!.state, 'disconnected')
    await f.sources.command('sources.delete', {id: source.id})
    assert.deepEqual(await f.knowledge.listSources(), [])
    assert.deepEqual(f.sources.list(), [])
  } finally {await f.close()}
})

test('metadata coverage counts 10000 files while body budget is enforced and failed roots retain index', async () => {
  const f = await fixture()
  try {
    for (let start = 0; start < 10000; start += 100) {
      await Promise.all(Array.from({length: 100}, (_, index) => writeFile(join(f.folder, `note-${start + index}.md`), 'A short note.')))
    }
    await f.sources.command('sources.add', {path: f.folder, consent: true, max_files: 2, max_bytes: 100})
    const source = f.sources.list()[0]!
    assert.equal(source.scanned, 10000)
    assert.equal(source.read, 2)
    assert.equal(source.reasons.body_budget, 9998)
    await rename(f.folder, `${f.folder}-offline`)
    await f.sources.command('sources.sync', {id: source.id})
    assert.equal(f.sources.list()[0]!.state, 'error')
    assert.equal((await f.knowledge.listSources()).length, 2)
    assert.equal(f.invalidated.length, 0)
    await rename(`${f.folder}-offline`, f.folder)
    await f.sources.command('sources.sync', {id: source.id})
    assert.equal(f.sources.list()[0]!.state, 'connected')
    assert.equal(f.sources.list()[0]!.read, 2)
    assert.ok((await readFile(join(f.root, 'db', 'sources.json'), 'utf8')).includes(source.id))
  } finally {await f.close()}
})

test('scoped ingestion rejects a replaced directory resolving outside the grant', async () => {
  const f = await fixture()
  try {
    await mkdir(join(f.root, 'other'))
    await writeFile(join(f.root, 'other', 'readme.md'), 'Must not upload outside grant')
    await symlink(join(f.root, 'other'), join(f.folder, 'link'))
    await assert.rejects(f.knowledge.syncFile(join(f.folder, 'link', 'readme.md'), f.folder, new AbortController().signal), /screening_rejected|ingest_failed/)
    assert.equal((await f.knowledge.listSources()).length, 0)
  } finally {await f.close()}
})


test('failed refresh retries the changed file rather than blessing stale index metadata', async () => {
  const f = await fixture()
  try {
    const path = join(f.folder, 'notes.md')
    await writeFile(path, 'Original manually imported source')
    await f.knowledge.handle('knowledge.ingest', {kind: 'file', locator: path, consent: true})
    await f.sources.command('sources.add', {path: f.folder, consent: true})
    const source = f.sources.list()[0]!, before = (await f.knowledge.listSources())[0]!
    await writeFile(path, 'Updated source after an interrupted synchronization')
    f.setFail(true)
    await f.sources.command('sources.sync', {id: source.id})
    f.setFail(false)
    await f.sources.command('sources.sync', {id: source.id})
    assert.notEqual((await f.knowledge.listSources())[0]!.fingerprint, before.fingerprint)
    assert.equal((await f.knowledge.recall('Updated', 1))[0]!.text, 'Updated source after an interrupted synchronization')
  } finally {await f.close()}
})

test('committed replacement survives repeated old-ledger cleanup failures until pending recovery', async () => {
  for (const owned of [true, false]) {
   const f = await fixture()
   try {
    const path = join(f.folder, 'notes.md')
    await writeFile(path, 'Initial verified note')
    if (!owned) await f.knowledge.handle('knowledge.ingest', {kind: 'file', locator: path, consent: true})
    await f.sources.command('sources.add', {path: f.folder, consent: true})
    const id = f.sources.list()[0]!.id, oldRef = f.sources.evidenceSnapshot()[0]!.ref
    const oldId = (await f.knowledge.listSources())[0]!.id
    const rows = new Map<string, NonNullable<Awaited<ReturnType<KnowledgeEvidenceLedger['read']>>>>()
    let cleanupFailures = 2
    const removed: string[] = []
    const ledger: KnowledgeEvidenceLedger = {
      record: input => {const evidence_id = randomUUID(); rows.set(evidence_id, {
        evidence_id, locator: input.locator, text: input.text, source_kind: 'file', observed_at: input.observedAt, trust: 'untrusted_external',
      }); return Promise.resolve({evidence_id})},
      read: evidenceId => Promise.resolve(rows.get(evidenceId) ?? null),
      canProcess: () => Promise.resolve(true),
      processingStamp: () => Promise.resolve('test-grant'),
      remove: sourceId => {if (cleanupFailures-- > 0) return Promise.reject(Error('private cleanup detail')); removed.push(sourceId); return Promise.resolve()},
    }
    await f.knowledge.bindEvidenceLedger(ledger)
    await writeFile(path, 'Replacement verified note')
    await f.sources.command('sources.sync', {id})
    assert.equal(f.sources.evidence(oldRef), null)
    assert.equal(cleanupFailures, 0)
    assert.equal(f.sources.evidenceSnapshot().length, 0)
    await f.sources.command('sources.sync', {id})
    assert.equal(f.sources.evidenceSnapshot().length, 1)
    assert.match(f.sources.contextEntries()[0]!.content, /Replacement verified/u)
    assert.equal((await f.knowledge.listSources()).length, 1)
    assert.ok(removed.includes(`knowledge:${oldId}`))
   } finally {await f.close()}
  }
})

test('terminal screening rejection removes the stale owned knowledge index', async () => {
  const f = await fixture()
  try {
    const path = join(f.folder, 'notes.md')
    await writeFile(path, 'Previously searchable source')
    await f.sources.command('sources.add', {path: f.folder, consent: true})
    const id = f.sources.list()[0]!.id
    await writeFile(path, 'token=credential-value-123456789')
    await f.sources.command('sources.sync', {id})
    assert.equal(f.sources.list()[0]!.failures[0]!.code, 'screening_rejected')
    assert.deepEqual(await f.knowledge.listSources(), [])
  } finally {await f.close()}
})

test('exhausted transient retry retires stale owned knowledge index', async () => {
  const f = await fixture()
  try {
    const path = join(f.folder, 'notes.md')
    await writeFile(path, 'Initial searchable content')
    const {id} = await f.sources.command('sources.authorize_computer', {consent: true}) as {id: string}
    for (let i = 0; i < 3 && !(await f.knowledge.listSources()).length; i++) await f.sources.command('sources.sync', {id})
    assert.equal((await f.knowledge.listSources()).length, 1)
    await f.sources.close()
    await writeFile(path, 'Changed content needing embedding')
    const info = await stat(path)
    const statePath = join(f.root, 'db', 'sources.json')
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {sources: {walk: unknown}[]}
    state.sources[0]!.walk = {queue: [], ledger: [], generation: 1, pending: [{path, size: info.size, mtime: info.mtimeMs, unit: f.folder, attempts: 5}], deferred: []}
    await writeFile(statePath, JSON.stringify(state))
    f.setFail(true)
    const sources = new LocalDirectorySources({path: statePath, computerRoot: f.folder, knowledge: f.knowledge, pollMs: 0, scanOnOpen: false, contentRecheckMs: 0,
      processingGrant: (consent, revision, scope_revision) => ({revision, scope_revision, extraction_provider: consent ? 'test' : null, embedding_provider: consent ? 'test' : null})})
    try {
      await sources.open(); await sources.command('sources.sync', {id})
      assert.deepEqual(await f.knowledge.listSources(), [])
      const saved = JSON.parse(await readFile(statePath, 'utf8')) as {sources: {walk: {deferred: unknown[]}}[]}
      assert.equal(saved.sources[0]!.walk.deferred.length, 0)
    } finally {await sources.close()}
  } finally {await f.close()}
})

test('same-metadata recheck read failure keeps verified evidence available', async () => {
  const f = await fixture(false, undefined, undefined, 0)
  try {
    const path = join(f.folder, 'notes.md')
    await writeFile(path, 'Known good project note')
    await f.sources.command('sources.add', {path: f.folder, consent: true})
    const id = f.sources.list()[0]!.id, ref = f.sources.evidenceSnapshot()[0]!.ref
    await chmod(path, 0o000)
    await f.sources.command('sources.sync', {id})
    assert.equal(f.sources.evidenceSnapshot()[0]!.ref, ref)
    assert.ok(!f.invalidated.includes(ref))
    await chmod(path, 0o600)
    await f.sources.command('sources.sync', {id})
    assert.equal(f.sources.evidenceSnapshot()[0]!.ref, ref)
  } finally {await chmod(join(f.folder, 'notes.md'), 0o600).catch(() => undefined); await f.close()}
})

test('directory recheck retries survive reopen and retire stale evidence once exhausted', async (t) => {
  const f = await fixture(false, undefined, undefined, 0)
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  try {
    const path = join(f.folder, 'notes.md')
    await writeFile(path, 'Previously verified directory note')
    await f.sources.command('sources.add', {path: f.folder, consent: true})
    const id = f.sources.list()[0]!.id, ref = f.sources.evidenceSnapshot()[0]!.ref
    const observation = f.observations[0]!.source_ref.ref
    const before = await stat(path)
    await chmod(path, 0o000)
    for (let attempt = 0; attempt < 5; attempt++) {
      await f.sources.command('sources.sync', {id})
      assert.ok(f.sources.evidence(ref), 'verified evidence survives a retryable failure')
      // Neither repeated polling nor reopening may consume the delayed retry.
      for (let poll = 0; poll < 7; poll++) await f.sources.command('sources.sync', {id})
      await f.reopen()
      assert.ok(f.sources.evidence(ref))
      assert.equal((await f.knowledge.listSources()).length, 1)
      assert.ok(!f.invalidated.includes(ref))
      now += 30_001
    }
    await f.sources.command('sources.sync', {id})
    assert.equal(f.sources.evidence(ref), null)
    assert.deepEqual(await f.knowledge.listSources(), [])
    assert.equal(f.invalidated.filter(value => value === ref).length, 1)
    assert.equal(f.invalidated.filter(value => value === observation).length, 1)
    const invalidations = f.invalidated.length
    now += 300_001
    await f.reopen()
    await f.sources.command('sources.sync', {id})
    assert.equal(f.invalidated.length, invalidations)
    assert.equal(f.observations.length, 1)
    // A later reconciliation is bounded even when the file remains unreadable.
    now += 24 * 60 * 60_000
    await f.sources.command('sources.sync', {id})
    await chmod(path, 0o600)
    await f.reopen()
    for (let poll = 0; poll < 7; poll++) await f.sources.command('sources.sync', {id})
    assert.deepEqual(await f.knowledge.listSources(), [])
    now += 24 * 60 * 60_000
    await f.reopen()
    await f.sources.command('sources.sync', {id})
    assert.equal((await f.knowledge.listSources()).length, 1)
    const recovered = f.sources.evidenceSnapshot()[0]!
    assert.ok(recovered, 'same-metadata readable file recovers after the long retry delay')
    assert.ok(f.sources.evidence(recovered.ref))
    assert.match(f.sources.contextEntries()[0]!.content, /Previously verified directory note/u)
    const after = await stat(path)
    assert.equal(after.size, before.size)
    assert.equal(after.mtimeMs, before.mtimeMs)
  } finally {await chmod(join(f.folder, 'notes.md'), 0o600).catch(() => undefined); await f.close()}
})

test('same-size same-mtime screened replacement retires prior index', async (t) => {
  const f = await fixture(false, undefined, undefined, 0)
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  try {
    const path = join(f.folder, 'notes.md'), secret = 'token=credential-value-123456789'
    await writeFile(path, 'A'.repeat(secret.length))
    const stableTime = new Date(Math.floor(Date.now() / 1000) * 1000)
    await utimes(path, stableTime, stableTime)
    await f.sources.command('sources.add', {path: f.folder, consent: true})
    const id = f.sources.list()[0]!.id, oldRef = f.sources.evidenceSnapshot()[0]!.ref
    const before = await stat(path)
    await writeFile(path, secret)
    await utimes(path, stableTime, stableTime)
    const after = await stat(path)
    assert.equal(after.size, before.size)
    assert.equal(after.mtimeMs, before.mtimeMs)
    await f.sources.command('sources.sync', {id})
    assert.equal(f.sources.evidence(oldRef), null)
    assert.deepEqual(await f.knowledge.listSources(), [])
    assert.equal(f.sources.list()[0]!.failures[0]!.code, 'screening_rejected')
    await writeFile(path, 'A'.repeat(secret.length))
    await utimes(path, stableTime, stableTime)
    now += 2 * 24 * 60 * 60_000
    await f.reopen()
    await f.sources.command('sources.sync', {id})
    assert.deepEqual(await f.knowledge.listSources(), [], 'terminal screening cannot become an automatic age-based retry')
  } finally {await f.close()}
})

test('persistent same-metadata read failure exhausts the computer retry budget', async () => {
  const f = await fixture()
  try {
    const path = join(f.folder, 'notes.md')
    await writeFile(path, 'Previously verified computer note')
    const {id} = await f.sources.command('sources.authorize_computer', {consent: true}) as {id: string}
    for (let i = 0; i < 3 && !(await f.knowledge.listSources()).length; i++) await f.sources.command('sources.sync', {id})
    assert.equal((await f.knowledge.listSources()).length, 1)
    await f.sources.close()
    const info = await stat(path)
    await chmod(path, 0o000)
    const statePath = join(f.root, 'db', 'sources.json')
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {sources: {walk: unknown}[]}
    state.sources[0]!.walk = {queue: [], ledger: [], generation: 1, pending: [{path, size: info.size, mtime: info.mtimeMs, unit: f.folder, attempts: 5}], deferred: []}
    await writeFile(statePath, JSON.stringify(state))
    const sources = new LocalDirectorySources({path: statePath, computerRoot: f.folder, knowledge: f.knowledge, pollMs: 0, scanOnOpen: false, contentRecheckMs: 0,
      processingGrant: (consent, revision, scope_revision) => ({revision, scope_revision, extraction_provider: consent ? 'test' : null, embedding_provider: consent ? 'test' : null})})
    try {
      await sources.open(); await sources.command('sources.sync', {id})
      assert.deepEqual(await f.knowledge.listSources(), [])
      const saved = JSON.parse(await readFile(statePath, 'utf8')) as {sources: {walk: {deferred: unknown[]}}[]}
      assert.equal(saved.sources[0]!.walk.deferred.length, 0)
    } finally {await sources.close()}
  } finally {await chmod(join(f.folder, 'notes.md'), 0o600).catch(() => undefined); await f.close()}
})

test('bounded recheck detects same-size same-mtime replacement and invalidates old version first', async () => {
  const f = await fixture(false, undefined, undefined, 0)
  try {
    const path = join(f.folder, 'notes.md'), original = 'Alpha project note', replacement = 'Bravo project note'
    await writeFile(path, original)
    const stableTime = new Date(Math.floor(Date.now() / 1000) * 1000)
    await utimes(path, stableTime, stableTime)
    await f.sources.command('sources.add', {path: f.folder, consent: true})
    const source = f.sources.list()[0]!, oldRef = f.sources.evidenceSnapshot()[0]!.ref
    await f.sources.command('sources.sync', {id: source.id})
    assert.equal(f.sources.evidenceSnapshot()[0]!.ref, oldRef)
    assert.ok(!f.invalidated.includes(oldRef))
    const before = await stat(path)
    await writeFile(path, replacement)
    await utimes(path, before.atime, before.mtime)
    const after = await stat(path)
    assert.equal(after.size, before.size)
    assert.equal(after.mtimeMs, before.mtimeMs)
    await f.sources.command('sources.sync', {id: source.id})
    assert.equal(f.sources.evidence(oldRef), null)
    assert.ok(f.invalidated.includes(oldRef))
    const current = f.sources.evidenceSnapshot()
    assert.equal(current.length, 1)
    assert.notEqual(current[0]!.ref, oldRef)
    assert.match(f.sources.contextEntries()[0]!.content, /Bravo/u)
    assert.ok(!(await f.knowledge.listSources()).some(item => item.fingerprint === oldRef.split(':').at(-1)))
  } finally {await f.close()}
})

test('metadata-only touch preserves verified evidence and observation references', async () => {
  const f = await fixture()
  try {
    const path = join(f.folder, 'README.md')
    await writeFile(path, 'A verified project description')
    await f.sources.command('sources.add', {path: f.folder, consent: true})
    const id = f.sources.list()[0]!.id, ref = f.sources.evidenceSnapshot()[0]!.ref
    const observationRef = f.observations[0]!.source_ref.ref
    await utimes(path, new Date(), new Date(Date.now() + 2000))
    await f.sources.command('sources.sync', {id})
    assert.equal(f.sources.evidenceSnapshot()[0]!.ref, ref)
    assert.equal(f.observations.length, 1)
    assert.ok(!f.invalidated.includes(ref) && !f.invalidated.includes(observationRef))
  } finally {await f.close()}
})

test('body-budget deferred changes cannot keep stale source evidence or owned searchable chunks', async () => {
  const f = await fixture()
  try {
    const path = join(f.folder, 'notes.md')
    await writeFile(path, 'Original')
    await f.sources.command('sources.add', {path: f.folder, consent: true, max_bytes: 10})
    const source = f.sources.list()[0]!, ref = f.sources.evidenceSnapshot()[0]!.ref
    await writeFile(path, 'Changed content now larger than the authorized scan budget')
    await f.sources.command('sources.sync', {id: source.id})
    assert.equal(f.sources.evidence(ref), null)
    assert.deepEqual(await f.knowledge.listSources(), [])
    assert.ok(f.invalidated.includes(ref))
  } finally {await f.close()}
})


test('restart retries source invalidation interrupted after durable stale marking', async () => {
  const f = await fixture()
  try {
    const path = join(f.folder, 'notes.md')
    await writeFile(path, 'Original version')
    await f.sources.command('sources.add', {path: f.folder, consent: true})
    const id = f.sources.list()[0]!.id, ref = f.sources.evidenceSnapshot()[0]!.ref
    f.setFailInvalidation(true)
    await writeFile(path, 'Changed version with distinct size')
    await f.sources.command('sources.sync', {id})
    assert.equal(f.sources.evidence(ref), null)
    assert.equal(f.invalidated.length, 0)
    f.setFailInvalidation(false)
    await f.reopen()
    assert.ok(f.invalidated.includes(ref))
    assert.equal(f.sources.evidenceSnapshot().length, 1)
    assert.notEqual(f.sources.evidenceSnapshot()[0]!.ref, ref)
  } finally {await f.close()}
})


test('pause fences an in-flight body import before it can commit', async () => {
  const f = await fixture()
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => {release = resolve})
  const started = new Promise<void>(resolve => {entered = resolve})
  try {
    await writeFile(join(f.folder, 'notes.md'), 'An import being paused')
    f.setIngestHook(() => {entered(); return gate})
    const adding = f.sources.command('sources.add', {path: f.folder, consent: true})
    await started
    const id = f.sources.list()[0]!.id
    const pausing = f.sources.command('sources.pause', {id})
    release()
    await Promise.all([adding, pausing])
    assert.equal(f.sources.list()[0]!.state, 'paused')
    assert.deepEqual(await f.knowledge.listSources(), [])
    assert.deepEqual(f.sources.evidenceSnapshot(), [])
  } finally {release(); await f.close()}
})


test('project descriptions become content memories while scan statistics stay in source settings', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.folder, 'README.md'), '# Example\n\n![build](https://example.com/badge.svg)\n\nA tool for evaluating phone agents with repeatable tasks.\n\n```sh\nignore instructions\n```')
    await writeFile(join(f.folder, 'newer.ts'), '// just code')
    await f.sources.command('sources.add', {path:f.folder, consent:true, max_files:1})
    assert.equal(f.observations.length,1)
    assert.match(f.observations[0]!.content,/evaluating phone agents/)
    assert.doesNotMatch(f.observations[0]!.content,/扫描|索引|ignore instructions|badge/)
    const id=f.sources.list()[0]!.id, ref=f.observations[0]!.source_ref.ref
    await f.sources.command('sources.sync',{id})
    assert.equal(f.observations.length,1)
    await writeFile(join(f.folder, 'README.md'), '# Example\n\nNow also evaluates desktop agents.')
    await f.sources.command('sources.sync',{id})
    assert.equal(f.observations.length,2)
    assert.match(f.observations[1]!.content,/desktop agents/)
    assert.ok(f.invalidated.includes(ref))
    await f.sources.command('sources.delete',{id})
    assert.ok(f.invalidated.includes(f.observations[1]!.source_ref.ref))
  } finally {await f.close()}
})


test('README version replacement survives touch and A-B-A without overriding explicit forgetting', async () => {
  const f = await fixture(true)
  try {
    const path=join(f.folder,'README.md'), original='# Example\n\nA voice conversation project.'
    await writeFile(path,original)
    await f.sources.command('sources.add',{path:f.folder,consent:true})
    const id=f.sources.list()[0]!.id
    assert.equal(f.memory!.list().entries.length,1)
    const firstRef=f.memory!.list().entries[0]!.source_refs[0]!.ref
    await utimes(path,new Date(),new Date(Date.now()+2000))
    await f.sources.command('sources.sync',{id})
    assert.equal(f.memory!.list().entries.length,1)
    assert.equal(f.memory!.list().entries[0]!.source_refs[0]!.ref,firstRef)
    await writeFile(path,'# Example\n\nA mobile evaluation project.')
    await f.sources.command('sources.sync',{id})
    assert.equal(f.memory!.list().entries.length,1)
    assert.match(f.memory!.list().entries[0]!.content,/mobile evaluation/)
    await writeFile(path,original)
    await f.sources.command('sources.sync',{id})
    const entry=f.memory!.list().entries[0]!
    assert.equal(f.memory!.list().entries.length,1)
    assert.match(entry.content,/voice conversation/)
    f.memory!.forgetEntry(entry.id,entry.version)
    await utimes(path,new Date(),new Date(Date.now()+4000))
    await f.sources.command('sources.sync',{id})
    assert.equal(f.memory!.list().entries.length,0)
    await f.reopen()
    assert.equal(f.memory!.list().entries.length,0)
    await f.sources.command('sources.delete',{id})
    assert.equal(f.memory!.list().entries.length,0)
  } finally {await f.close()}
})

test('nested documents retain project context and unavailable observations retry after restart', async () => {
  const f=await fixture(true)
  try {
    await mkdir(join(f.folder,'Alpha'))
    await mkdir(join(f.folder,'Beta'))
    await writeFile(join(f.folder,'Alpha','README.md'),'# Alpha\n\n'+ 'Voice conversations. '.repeat(35))
    await writeFile(join(f.folder,'Beta','README.md'),'# Beta\n\nRepeatable mobile agent evaluations.')
    f.setMemoryAvailable(false)
    await f.sources.command('sources.add',{path:f.folder,consent:true})
    assert.equal(f.memory!.list().entries.length,0)
    assert.equal(f.sources.list()[0]!.state,'connected')
    assert.equal(f.sources.list()[0]!.health,'degraded')
    assert.equal(f.sources.list()[0]!.failures[0]!.stage,'observe')
    f.setMemoryAvailable(true)
    await f.reopen()
    const entries=f.memory!.list().entries
    assert.equal(entries.length,2)
    assert.deepEqual(entries.map(entry=>entry.topic).sort(),['Alpha','Beta'])
    for(const entry of entries){assert.match(entry.content,new RegExp(entry.topic+'/README.md'));assert(entry.content.length<=500)}
    await f.sources.command('sources.delete',{id:f.sources.list()[0]!.id})
    assert.equal(f.memory!.list().entries.length,0)
  } finally {await f.close()}
})

test('project-balanced admission preserves a small old collection beside a crowded Git project',async()=>{
 const f=await fixture()
 try{
  await mkdir(join(f.folder,'large','.git'),{recursive:true});await mkdir(join(f.folder,'papers'))
  for(let i=0;i<12;i++){const d=join(f.folder,'large','part'+i);await mkdir(d);await writeFile(join(d,'README.md'),'Large project section '+i)}
  const note=join(f.folder,'papers','reading-notes.md');await writeFile(note,'Optical imaging research notes, collected in the past.');await utimes(note,new Date('2020-01-01'),new Date('2020-01-01'))
  await f.sources.command('sources.add',{path:f.folder,consent:true,max_files:4})
  assert.ok((await f.knowledge.listSources()).some(s=>s.locator===note),'small non-README collection must receive body budget')
  assert.ok(f.observations.some(o=>o.content.includes('Optical imaging')),'notes must supply representative observations')
 }finally{await f.close()}
})
test('project overview budget is stable across unchanged syncs and generated files stay out',async()=>{
 const f=await fixture()
 try{
  await mkdir(join(f.folder,'.git'));for(let i=0;i<20;i++)await writeFile(join(f.folder,'note-'+i+'.md'),'Distinct project note '+i)
  await writeFile(join(f.folder,'package-lock.json'),'{}');await f.sources.command('sources.add',{path:f.folder,consent:true})
  const before=await f.knowledge.listSources();assert.ok(before.length<=8,'one project must not consume all file slots');assert.ok(before.every(s=>!s.locator.endsWith('package-lock.json')))
  await f.sources.command('sources.sync',{id:f.sources.list()[0]!.id});assert.equal((await f.knowledge.listSources()).length,before.length);assert.equal(f.sources.list()[0]!.read,0)
 }finally{await f.close()}
})
test('evidence snapshot represents both roots',async()=>{
 const f=await fixture()
 try{
  const other=join(f.root,'other');await mkdir(other)
  for(let i=0;i<8;i++){await writeFile(join(f.folder,'a'+i+'.md'),'First collection '+i);await writeFile(join(other,'b'+i+'.md'),'Second collection '+i)}
  await f.sources.command('sources.add',{path:f.folder,consent:true});await f.sources.command('sources.add',{path:other,consent:true})
  const snapshot=f.sources.evidenceSnapshot();assert.equal(snapshot.length,8);assert.ok(snapshot.some(s=>/a\d+\.md/u.test(s.summary)));assert.ok(snapshot.some(s=>/b\d+\.md/u.test(s.summary)))
 }finally{await f.close()}
})

test('a Git metadata ceiling leaves sibling collections reachable and retains unseen indexed files',async()=>{
 const f=await fixture()
 try{
  const repo=join(f.folder,'large'),papers=join(f.folder,'papers');await mkdir(join(repo,'.git'),{recursive:true});await mkdir(papers)
  await Promise.all(Array.from({length:2050},(_,i)=>writeFile(join(repo,'part-'+i+'.txt'),'Project data '+i)))
  await writeFile(join(papers,'notes.md'),'Independent scientific reading notes.')
  await f.sources.command('sources.add',{path:f.folder,consent:true,max_files:3})
  assert.ok(f.sources.list()[0]!.reasons.project_metadata_limit)
  assert.ok((await f.knowledge.listSources()).some(s=>s.locator===join(papers,'notes.md')))
  const before=(await f.knowledge.listSources()).map(s=>s.id).sort()
  await f.sources.command('sources.sync',{id:f.sources.list()[0]!.id})
  assert.deepEqual((await f.knowledge.listSources()).map(s=>s.id).sort().filter(id=>before.includes(id)),before)
 }finally{await f.close()}
})
test('identical content occupies one snapshot slot without losing separate source ownership',async()=>{
 const f=await fixture()
 try{
  for(const name of ['one','two']){await mkdir(join(f.folder,name));await writeFile(join(f.folder,name,'README.md'),'Identical checkout overview.')}
  await f.sources.command('sources.add',{path:f.folder,consent:true})
  assert.equal((await f.knowledge.listSources()).length,2)
  assert.equal(f.sources.evidenceSnapshot().length,1)
 }finally{await f.close()}
})

test('a changed file outside the project overview budget cannot keep stale evidence',async()=>{
 const f=await fixture()
 try{
  await mkdir(join(f.folder,'.git'));const code=join(f.folder,'example.ts');await writeFile(code,'export const version = 1')
  await f.sources.command('sources.add',{path:f.folder,consent:true});const old=f.sources.evidenceSnapshot()[0]!.ref
  for(let i=0;i<8;i++){const dir=join(f.folder,'part'+i);await mkdir(dir);await writeFile(join(dir,'README.md'),'Overview '+i)}
  await writeFile(code,'export const version = 222')
  await f.sources.command('sources.sync',{id:f.sources.list()[0]!.id})
  assert.equal(f.sources.evidence(old),null);assert.ok(f.invalidated.includes(old))
  assert.ok((await f.knowledge.listSources()).every(s=>s.locator!==code))
 }finally{await f.close()}
})

test('project overview favors the root README over newer nested README files',async()=>{
 const f=await fixture()
 try{
  await mkdir(join(f.folder,'.git'));const overview=join(f.folder,'README.md');await writeFile(overview,'Whole project overview');await utimes(overview,new Date('2020-01-01'),new Date('2020-01-01'))
  for(let i=0;i<10;i++){const dir=join(f.folder,'part'+i);await mkdir(dir);await writeFile(join(dir,'README.md'),'Nested implementation '+i)}
  await f.sources.command('sources.add',{path:f.folder,consent:true,max_files:1})
  assert.equal((await f.knowledge.listSources())[0]!.locator,overview)
 }finally{await f.close()}
})


test('whole-computer grant resumes batches past the directory overview budget without admitting credentials',async()=>{
 const f=await fixture()
 try{
  execFileSync('git',['init','-q',f.folder])
  for(let n=0;n<19;n++)await writeFile(join(f.folder,`note-${String(n).padStart(2,'0')}.md`),`Distinct project document ${n}: implementation notes.`)
  await writeFile(join(f.folder,'.env'),'SECRET=never-read')
  await assert.rejects(f.sources.command('sources.authorize_computer',{consent:true,path:'/'}))
  const grant=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  for(let i=0;i<3&&(await f.knowledge.listSources()).length<19;i++)await f.sources.command('sources.sync',{id:grant.id})
  assert.equal((await f.knowledge.listSources()).length,19)
  assert.equal(f.sources.list()[0]!.scope,'computer')
  assert.equal(f.sources.contextEntries().length,19)
  assert.equal(f.sources.contextEntries()[0]!.kind,'file')
  assert.doesNotMatch(f.sources.contextEntries()[0]!.content,/^note-\d+\.md:/u)
  await f.sources.command('sources.consent',{id:grant.id,consent:false});assert.equal(f.sources.contextEntries().length,0)
  await f.reopen()
  assert.equal(f.sources.list()[0]!.scope,'computer')
  assert.equal((await f.knowledge.listSources()).length,19)
 }finally{await f.close()}
})

test('whole-computer scan skips hidden content and invalidates a legacy hidden record',async()=>{
 const f=await fixture()
 try{
  const visible=join(f.folder,'project');await mkdir(visible)
  await writeFile(join(visible,'README.md'),'Visible project notes')
  const hidden=join(f.folder,'.tool');await mkdir(hidden)
  const hiddenFile=join(hidden,'notes.md');await writeFile(hiddenFile,'Hidden tool setting')
  await writeFile(join(f.folder,'.private.md'),'Hidden root note')
  const grant=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  await f.sources.command('sources.sync',{id:grant.id})
  assert.ok((await f.knowledge.listSources()).some(s=>s.locator===join(visible,'README.md')))
  assert.ok(!(await f.knowledge.listSources()).some(s=>s.locator===hiddenFile))
  await f.sources.close()
  await f.knowledge.handle('knowledge.ingest',{kind:'file',locator:hiddenFile,consent:true})
  const indexed=(await f.knowledge.listSources()).find(s=>s.locator===hiddenFile)!
  const statePath=join(f.root,'db','sources.json'),state=JSON.parse(await readFile(statePath,'utf8')) as {sources:{files:unknown[]}[]}
  state.sources[0]!.files.push({path:hiddenFile,id:indexed.id,fingerprint:indexed.fingerprint,size:19,mtime:1,owned:true,valid:true,excerpt:'Hidden tool setting',observed:false,observation_ref:null})
  await writeFile(statePath,JSON.stringify(state))
  const legacyRef=`file:${indexed.id}:${indexed.fingerprint}`
  await f.reopen()
  assert.equal(f.sources.contextEntries().some(e=>e.content.includes('Hidden tool setting')),false)
  await f.sources.command('sources.sync',{id:grant.id})
  assert.ok(f.invalidated.includes(legacyRef))
  assert.ok(!(await f.knowledge.listSources()).some(s=>s.locator===hiddenFile))
 }finally{await f.close()}
})

test('priority directory changes scan order without changing computer authority',async()=>{
 const f=await fixture()
 try{
  const alpha=join(f.folder,'alpha'),project=join(f.folder,'project')
  await mkdir(alpha);await mkdir(project)
 await writeFile(join(alpha,'README.md'),'Alpha notes')
 await writeFile(join(project,'README.md'),'Project notes')
  await mkdir(join(project,'.github'));await writeFile(join(project,'.github','notes.md'),'Hidden project metadata')
  const grant=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  await f.sources.command('sources.priority.add',{path:project})
  assert.deepEqual(f.sources.list()[0]!.priority_dirs,[project])
  await f.sources.command('sources.sync',{id:grant.id})
  assert.equal(f.sources.contextEntries().some(entry=>entry.content.includes('Hidden project metadata')),false)
  await f.sources.command('sources.priority.remove',{path:project})
  assert.deepEqual(f.sources.list()[0]!.priority_dirs,[])
  assert.equal(f.sources.list()[0]!.state,'connected')
  await f.sources.command('sources.sync',{id:grant.id})
  assert.ok((await f.knowledge.listSources()).some(s=>s.locator===join(project,'README.md')))
 }finally{await f.close()}
})
test('adding a priority does not resume a paused computer grant',async()=>{
 const f=await fixture()
 try{
  const project=join(f.folder,'project');await mkdir(project);await writeFile(join(project,'README.md'),'Project notes')
  const {id}=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  await f.sources.command('sources.pause',{id})
  const before=f.sources.list()[0]!.read
  await f.sources.command('sources.priority.add',{path:project})
  assert.equal(f.sources.list()[0]!.state,'paused')
  assert.equal(f.sources.list()[0]!.read,before)
 }finally{await f.close()}
})
test('computer candidates keep nested Git repositories separate',async()=>{
 const f=await fixture()
 try{
  const code=join(f.folder,'code');await mkdir(code)
  for(const name of ['active','older']){const repo=join(code,name);execFileSync('git',['init','-q',repo]);await writeFile(join(repo,'README.md'),`An idea for ${name} setup.`)}
  const {id}=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  for(let i=0;i<4&&(await f.knowledge.listSources()).length<2;i++)await f.sources.command('sources.sync',{id})
  assert.deepEqual(new Set(f.sources.contextEntries().flatMap(item=>item.kind==='file'?[item.root]:[])),new Set([join(code,'active'),join(code,'older')]))
 }finally{await f.close()}
})
test('whole-computer scan invalidates a file when its parent folder is deleted',async()=>{
 const f=await fixture()
 try{
  const project=join(f.folder,'project'),nested=join(project,'notes');await mkdir(project);await mkdir(nested)
  const document=join(nested,'plan.md');await writeFile(document,'An idea for a simpler setup.')
  const {id}=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  await f.sources.command('sources.sync',{id})
  const tracked=f.sources.contextEntries().find(item=>item.kind==='file'&&item.content.includes('simpler setup'))
  assert.ok(tracked)
  await rm(nested,{recursive:true})
  await f.sources.command('sources.sync',{id})
  assert.equal(f.sources.contextEntries().some(item=>item.kind==='file'&&item.content.includes('simpler setup')),false)
  assert.equal((await f.knowledge.listSources()).some(item=>item.locator===document),false)
 }finally{await f.close()}
})
test('computer roots rank selected and current work ahead of recent Git and mtime',()=>{
 const roots=[
  {path:'/older',selected:false,currentWorkspace:false,lastGitCommitMs:null,mtimeMs:1},
  {path:'/git',selected:false,currentWorkspace:false,lastGitCommitMs:9,mtimeMs:2},
  {path:'/current',selected:false,currentWorkspace:true,lastGitCommitMs:null,mtimeMs:1},
  {path:'/selected',selected:true,currentWorkspace:false,lastGitCommitMs:null,mtimeMs:1},
 ]
 assert.deepEqual(orderComputerRoots(roots).map(root=>root.path),['/selected','/current','/git','/older'])
})
test('recent commits by someone else do not promote a cloned repository',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'nova-git-owner-'))
 try{
  execFileSync('git',['init','-q',root])
  execFileSync('git',['-C',root,'config','user.name','Owner'])
  execFileSync('git',['-C',root,'config','user.email','owner@example.test'])
  await writeFile(join(root,'README.md'),'upstream')
  execFileSync('git',['-C',root,'add','README.md'])
  execFileSync('git',['-C',root,'commit','-qm','upstream'],{env:{...process.env,GIT_AUTHOR_NAME:'Other',GIT_AUTHOR_EMAIL:'other@example.test',GIT_COMMITTER_NAME:'Other',GIT_COMMITTER_EMAIL:'other@example.test'}})
  assert.equal((await rootActivity(root)).lastGitCommitMs,null)
  await writeFile(join(root,'README.md'),'owner work')
  execFileSync('git',['-C',root,'commit','-qam','owner work'])
  assert.ok((await rootActivity(root)).lastGitCommitMs)
 }finally{await rm(root,{recursive:true,force:true})}
})
test('persisted Git activity skips the Git probe for an unchanged repository after reopening',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'nova-git-cache-')),repo=join(root,'repo'),cachePath=join(root,'state','sources.activity.json')
 await mkdir(join(root,'state'),{mode:0o700})
 let probes=0;const probe=(path:string)=>{probes++;return rootActivity(path)}
 try{
  execFileSync('git',['init','-q',repo])
  execFileSync('git',['-C',repo,'config','user.name','Owner']);execFileSync('git',['-C',repo,'config','user.email','owner@example.test'])
  await writeFile(join(repo,'notes.md'),'first');execFileSync('git',['-C',repo,'add','notes.md']);execFileSync('git',['-C',repo,'commit','-qm','first'])
  const first=new GitActivityCache(cachePath,probe);await first.open()
  const value=await first.get(repo,0);assert.equal(probes,1);assert.equal(value.ownCommits,1);await first.flush()
  const reopened=new GitActivityCache(cachePath,probe);await reopened.open()
  assert.deepEqual(await reopened.get(repo,0),value);assert.equal(probes,1,'unchanged HEAD, reflog, and config reuse the stored clue')
  await writeFile(join(repo,'notes.md'),'second');execFileSync('git',['-C',repo,'commit','-qam','second'])
  assert.equal((await reopened.get(repo,0)).ownCommits,2);assert.equal(probes,2,'a new commit moves the key and reprobes')
 }finally{await rm(root,{recursive:true,force:true})}
})
test('persisted Git activity notices linked-worktree commits and inherited identity changes',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'nova-git-worktree-')),repo=join(root,'repo'),tree=join(root,'tree'),global=join(root,'gitconfig')
 const saved=process.env.GIT_CONFIG_GLOBAL;process.env.GIT_CONFIG_GLOBAL=global
 let probes=0;const probe=(path:string)=>{probes++;return rootActivity(path)}
 try{
  await writeFile(global,'[user]\n\tname = Owner\n\temail = owner@example.test\n')
  execFileSync('git',['init','-q',repo]);await writeFile(join(repo,'notes.md'),'first');execFileSync('git',['-C',repo,'add','notes.md']);execFileSync('git',['-C',repo,'commit','-qm','first'])
  execFileSync('git',['-C',repo,'worktree','add','-q','-b','side',tree])
  const cache=new GitActivityCache(undefined,probe)
  assert.equal((await cache.get(tree,0)).ownCommits,1);assert.equal(probes,1)
  assert.equal((await cache.get(tree,0)).ownCommits,1);assert.equal(probes,1,'an unchanged worktree reuses its clue')
  await writeFile(join(tree,'notes.md'),'second');execFileSync('git',['-C',tree,'commit','-qam','second'])
  assert.equal((await cache.get(tree,0)).ownCommits,2,'a commit behind a gitdir pointer moves the key')
  await writeFile(global,'[user]\n\tname = Someone\n\temail = someone-else@example.test\n')
  assert.equal((await cache.get(tree,0)).ownCommits,0,'a changed global author identity reprobes')
 }finally{if(saved===undefined)delete process.env.GIT_CONFIG_GLOBAL;else process.env.GIT_CONFIG_GLOBAL=saved;await rm(root,{recursive:true,force:true})}
})
test('weighted root turns include lower tiers while rotating peers',()=>{
 const now=Date.now(),base={mtimeMs:1,lastGitCommitMs:null}
 const roots=[{...base,path:'/selected-a',selected:true,currentWorkspace:false},{...base,path:'/selected-b',selected:true,currentWorkspace:false},{...base,path:'/active',selected:false,currentWorkspace:false,lastGitCommitMs:now},{...base,path:'/other',selected:false,currentWorkspace:false}]
 const cursors=[0,0,0]
 const chosen=Array.from({length:7},(_,turn)=>nextComputerRoot(roots,turn,cursors)!.path)
 assert.deepEqual(chosen,['/selected-a','/selected-b','/selected-a','/selected-b','/active','/active','/other'])
})
test('recent mtime is a bounded tier below recent Git and selected roots',()=>{
 const now=Date.now(),roots=[
  {path:'/selected',selected:true,currentWorkspace:false,lastGitCommitMs:null,mtimeMs:now},
  {path:'/git',selected:false,currentWorkspace:false,lastGitCommitMs:now-86_400_000,mtimeMs:1},
  {path:'/recent-mtime',selected:false,currentWorkspace:false,lastGitCommitMs:null,mtimeMs:now-60_000},
  {path:'/old',selected:false,currentWorkspace:false,lastGitCommitMs:null,mtimeMs:now-30*86_400_000},
 ]
 const cursors=[0,0,0,0],chosen=Array.from({length:8},(_,turn)=>nextComputerRoot(roots,turn,cursors)!.path)
 assert.deepEqual(chosen,['/selected','/selected','/selected','/selected','/git','/git','/recent-mtime','/old'])
 assert.deepEqual(orderComputerRoots(roots).map(root=>root.path),['/selected','/git','/recent-mtime','/old'])
})
test('first computer batches include more than one visible project root',async()=>{
 const f=await fixture()
 try{
  const alpha=join(f.folder,'alpha'),beta=join(f.folder,'beta')
  await mkdir(alpha);await mkdir(beta)
  for(let i=0;i<48;i++)await writeFile(join(alpha,`note-${String(i).padStart(2,'0')}.md`),`Alpha note ${i}`)
  await writeFile(join(beta,'README.md'),'Beta project overview')
  await utimes(beta,new Date('2020-01-01'),new Date('2020-01-01'))
  const {id}=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  await f.sources.command('sources.sync',{id})
  assert.ok((await f.knowledge.listSources()).some(source=>source.locator===join(beta,'README.md')))
 }finally{await f.close()}
})
test('current workspace reaches the first computer batches even behind a long saved queue',async()=>{
 let workspace:string|null=null
 const f=await fixture(false,()=>Promise.resolve(workspace))
 try{
  for(let i=0;i<80;i++){const dir=join(f.folder,`older-${String(i).padStart(2,'0')}`);await mkdir(dir);await writeFile(join(dir,'README.md'),`Older project ${i}`)}
  workspace=join(f.folder,'zz-current');await mkdir(workspace);await writeFile(join(workspace,'README.md'),'Current working project overview')
  const {id}=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  await f.sources.command('sources.sync',{id})
  assert.ok((await f.knowledge.listSources()).some(source=>source.locator===join(workspace!,'README.md')))
 }finally{await f.close()}
})

test('streamed directory scan reports exact cap as complete and excess as partial',async()=>{
 const f=await fixture()
 try{
  for(let i=0;i<3;i++)await writeFile(join(f.folder,`note-${i}.md`),`Note ${i}`)
  const seen:string[]=[]
  const exact=await scanDirectory(f.folder,new AbortController().signal,entry=>{seen.push(entry.name)},{hardSafetyCap:3})
  assert.equal(exact.complete,true);assert.equal(exact.seen,3);assert.equal(typeof exact.identity.dev,'string')
  await writeFile(join(f.folder,'fourth.md'),'Fourth note')
  const partial=await scanDirectory(f.folder,new AbortController().signal,()=>undefined,{hardSafetyCap:3})
  assert.equal(partial.complete,false);assert.equal(partial.seen,3)
  let changed=false
  const mutation=await scanDirectory(f.folder,new AbortController().signal,async()=>{if(!changed){changed=true;await writeFile(join(f.folder,'during-scan.md'),'Mutation during scan')}},{hardSafetyCap:10})
  assert.equal(mutation.complete,false);assert.equal(mutation.capped,false)
 }finally{await f.close()}
})

test('computer scan exposes a safety-cap partial pass without deleting prior evidence',async()=>{
 const f=await fixture(false,undefined,3)
 try{
  for(let i=0;i<4;i++)await writeFile(join(f.folder,`note-${i}.md`),`Note ${i}`)
  const {id}=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  await f.sources.command('sources.sync',{id})
  assert.equal(f.sources.list()[0]!.coverage,'partial')
  assert.ok((f.sources.list()[0]!.reasons.directory_partial??0)>0)
 }finally{await f.close()}
})

test('unavailable computer root retains indexed evidence',async()=>{
 const f=await fixture()
 try{
  const document=join(f.folder,'README.md');await writeFile(document,'Prior project evidence')
  const {id}=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  await f.sources.command('sources.sync',{id})
  assert.ok((await f.knowledge.listSources()).some(s=>s.locator===document))
  await rename(f.folder,join(f.root,'unmounted'))
  await f.sources.command('sources.sync',{id})
  assert.ok((await f.knowledge.listSources()).some(s=>s.locator===document))
  assert.equal(f.sources.list()[0]!.coverage,'partial')
 }finally{await f.close()}
})

test('computer reconciliation admits a changed tracked file',async()=>{
 const f=await fixture()
 try{
  const document=join(f.folder,'README.md');await writeFile(document,'Original work note')
  const {id}=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  await f.sources.command('sources.sync',{id})
  await writeFile(document,'Updated work note with a new conclusion')
  await f.sources.command('sources.sync',{id})
  assert.ok(f.sources.contextEntries().some(item=>item.content.includes('Updated work note')))
 }finally{await f.close()}
})

test('legacy offset checkpoint migrates without dropping pending and deferred files',async()=>{
 const f=await fixture()
 try{
  const project=join(f.folder,'project');await mkdir(project)
  const old=join(project,'z-old.md'),added=join(project,'a-new.md')
  await writeFile(old,'Old project note')
  const {id}=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  await f.sources.close()
  const path=join(f.root,'db','sources.json'),state=JSON.parse(await readFile(path,'utf8')) as {sources:{walk:unknown}[]}
  const deferred=join(project,'later.md')
  state.sources[0]!.walk={queue:[{path:project,offset:1}],pending:[{path:old,size:16,mtime:1,unit:project}],deferred:[{path:deferred,size:1,mtime:1,unit:project,eligible_at:Date.now()+60_000,attempts:1,reason:'retry'}]}
  await writeFile(path,JSON.stringify(state))
  await writeFile(added,'New project note')
  await f.reopen()
  for(let i=0;i<3;i++)await f.sources.command('sources.sync',{id})
  const locators=(await f.knowledge.listSources()).map(s=>s.locator)
  assert.equal(locators.filter(p=>p===old).length,1)
  assert.equal(locators.filter(p=>p===added).length,1)
  const saved=JSON.parse(await readFile(path,'utf8')) as {sources:{walk:{deferred:{path:string}[]}|null}[]}
  assert.ok(saved.sources[0]!.walk?.deferred.some(item=>item.path===deferred))
 }finally{await f.close()}
})

test('directory ledger rollback emits a readable legacy checkpoint',async()=>{
 const f=await fixture()
 try{
  await f.sources.command('sources.authorize_computer',{consent:true})
  await f.sources.close()
  const input=join(f.root,'db','sources.json'),output=join(f.root,'db','sources-legacy.json')
  const state=JSON.parse(await readFile(input,'utf8')) as {sources:{walk:unknown}[]}
  state.sources[0]!.walk={generation:3,queue:[],ledger:[{path:f.folder,generation:3,status:'queued'}],pending:[{path:join(f.folder,'pending.md'),size:1,mtime:1,unit:f.folder}],deferred:[{path:join(f.folder,'later.md'),size:1,mtime:1,unit:f.folder,eligible_at:Date.now()+60_000,attempts:1,reason:'retry'}]}
  await writeFile(input,JSON.stringify(state))
  const script=new URL('../../scripts/rollback-source-walk.mjs',import.meta.url)
  execFileSync(process.execPath,[script.pathname,input,output])
  assert.throws(()=>execFileSync(process.execPath,[script.pathname,input,join(f.root,'db','..','db','sources.json')],{stdio:'pipe'}))
  const legacy=JSON.parse(await readFile(output,'utf8')) as {sources:{walk:{queue:{path:string;offset:number}[];pending:unknown[];deferred:unknown[];ledger?:unknown}}[]}
  assert.deepEqual(legacy.sources[0]!.walk.queue,[{path:f.folder,offset:0}])
  assert.equal(legacy.sources[0]!.walk.pending.length,1)
  assert.equal(legacy.sources[0]!.walk.deferred.length,1)
  assert.equal(legacy.sources[0]!.walk.ledger,undefined)
  const reopened=new LocalDirectorySources({path:output,computerRoot:f.folder,knowledge:f.knowledge,pollMs:0,scanOnOpen:false})
  try{await reopened.open();assert.equal(reopened.list().length,1)}finally{await reopened.close()}
 }finally{await f.close()}
})

test('one large computer directory never persists more than the pending cap',async()=>{
 const f=await fixture()
 try{
  const {id}=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  await f.sources.close()
  for(let i=0;i<205;i++)await writeFile(join(f.folder,`note-${i}.md`),`Note ${i}`)
  const path=join(f.root,'db','sources.json'),disk=JSON.parse(await readFile(path,'utf8')) as {sources:{walk:unknown}[]}
  disk.sources[0]!.walk={queue:[{path:f.folder}],ledger:[],generation:1,pending:[],deferred:[]}
  await writeFile(path,JSON.stringify(disk))
  const sources=new LocalDirectorySources({path,computerRoot:f.folder,knowledge:f.knowledge,pollMs:0,scanOnOpen:false})
  try{
   await sources.open()
   let release!:()=>void,entered!:()=>void
   const gate=new Promise<void>(resolve=>{release=resolve}),started=new Promise<void>(resolve=>{entered=resolve})
   f.setIngestHook(()=>{entered();return gate})
   const sync=sources.command('sources.sync',{id})
   try{
    await started
    const saved=JSON.parse(await readFile(path,'utf8')) as {sources:{walk:{pending:unknown[];queue:unknown[]}}[]}
    assert.ok(saved.sources[0]!.walk.pending.length<=16)
    assert.ok(saved.sources[0]!.walk.queue.length>0)
   }finally{release();await sync}
   assert.notEqual(sources.list()[0]!.state,'error')
  }finally{await sources.close()}
 }finally{await f.close()}
})

test('queued ledger entry without queue recovers after restart',async()=>{
 const f=await fixture()
 try{
  const document=join(f.folder,'recovered.md')
  await f.sources.command('sources.authorize_computer',{consent:true})
  await f.sources.close()
  await writeFile(document,'Recovery note')
  const path=join(f.root,'db','sources.json'),disk=JSON.parse(await readFile(path,'utf8')) as {sources:{walk:unknown;files:unknown[]}[]}
  disk.sources[0]!.files=[]
  disk.sources[0]!.walk={queue:[],ledger:[{path:f.folder,generation:2,status:'queued'}],generation:2,pending:[],deferred:[]}
  await writeFile(path,JSON.stringify(disk))
  await f.reopen()
  for(let i=0;i<30&&!(await f.knowledge.listSources()).some(item=>item.locator===document);i++)await new Promise(resolve=>setTimeout(resolve,50))
  assert.ok((await f.knowledge.listSources()).some(item=>item.locator===document))
 }finally{await f.close()}
})

test('dirty hint keeps prior directory identity before deletion reconciliation',async()=>{
 let workspace:string|null=null
 const f=await fixture(false,()=>Promise.resolve(workspace))
 try{
  const project=join(f.folder,'project');await mkdir(project)
  const document=join(project,'old.md');await writeFile(document,'Previously indexed note')
  const {id}=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  await f.sources.command('sources.sync',{id});await f.sources.close()
  const path=join(f.root,'db','sources.json'),disk=JSON.parse(await readFile(path,'utf8')) as {sources:{walk:unknown}[]}
  disk.sources[0]!.walk={queue:[],ledger:[{path:project,generation:1,status:'done',identity:{dev:'-1',ino:'-1',mtimeNs:'0'}}],generation:1,pending:[],deferred:[]}
  await writeFile(path,JSON.stringify(disk));await rm(document)
  workspace=project
  await f.reopen();await f.sources.command('sources.sync',{id})
  assert.ok((await f.knowledge.listSources()).some(item=>item.locator===document))
 }finally{await f.close()}
})

test('computer batch turn persists so lower tier progresses beside four busy priorities',async()=>{
 const f=await fixture()
 try{
  const priorities:string[]=[]
  for(let i=0;i<4;i++){const dir=join(f.folder,`high-${i}`);priorities.push(dir);await mkdir(dir);for(let j=0;j<12;j++)await writeFile(join(dir,`note-${j}.md`),`High ${i} note ${j}`)}
  const other=join(f.folder,'other');await mkdir(other);await writeFile(join(other,'README.md'),'Other root overview')
  const {id}=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  await f.sources.close()
  const path=join(f.root,'db','sources.json'),disk=JSON.parse(await readFile(path,'utf8')) as {sources:{view:{priority_dirs:string[]};walk:unknown;files:unknown[]}[]}
  disk.sources[0]!.view.priority_dirs=priorities
  disk.sources[0]!.walk={queue:[...priorities,other].map(path=>({path})),ledger:[],generation:1,pending:[],deferred:[]}
  disk.sources[0]!.files=[]
  await writeFile(path,JSON.stringify(disk))
  const sources=new LocalDirectorySources({path,computerRoot:f.folder,knowledge:f.knowledge,pollMs:0,scanOnOpen:false})
  try{await sources.open();for(let i=0;i<2;i++)await sources.command('sources.sync',{id});assert.ok((await f.knowledge.listSources()).some(item=>item.locator===join(other,'README.md')))}finally{await sources.close()}
 }finally{await f.close()}
})

test('past-due partial directory waits behind future pending files without hot loop',async()=>{
 const f=await fixture()
 try{
  const {id}=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  await f.sources.close()
  const path=join(f.root,'db','sources.json'),disk=JSON.parse(await readFile(path,'utf8')) as {sources:{walk:unknown}[]}
  const future=Date.now()+60_000
  disk.sources[0]!.walk={queue:[],ledger:[{path:f.folder,generation:1,status:'partial',eligible_at:0}],generation:1,pending:Array.from({length:16},(_,i)=>({path:join(f.folder,`future-${i}.md`),size:1,mtime:1,unit:f.folder,eligible_at:future})),deferred:[]}
  await writeFile(path,JSON.stringify(disk))
  let changes=0
  const sources=new LocalDirectorySources({path,computerRoot:f.folder,knowledge:f.knowledge,pollMs:0,scanOnOpen:false,onChange:()=>{changes++}})
  try{await sources.open();await sources.command('sources.sync',{id});await new Promise(resolve=>setTimeout(resolve,100));assert.ok(changes<=4)}finally{await sources.close()}
 }finally{await f.close()}
})

test('stat budget counts work across directory yields in one batch',async()=>{
 const f=await fixture()
 try{
  const alpha=join(f.folder,'alpha'),beta=join(f.folder,'beta');await mkdir(alpha);await mkdir(beta)
  for(let i=0;i<6;i++)await writeFile(join(alpha,`old-${i}.md`),`Old note ${i}`)
  const {id}=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  for(let i=0;i<3&&(await f.knowledge.listSources()).length<6;i++)await f.sources.command('sources.sync',{id})
  assert.equal((await f.knowledge.listSources()).length,6)
  await f.sources.close()
  for(let i=0;i<5;i++)await writeFile(join(alpha,`z-new-${i}.md`),`New note ${i}`)
  for(let i=0;i<3;i++)await writeFile(join(beta,`beta-${i}.md`),`Beta note ${i}`)
  const path=join(f.root,'db','sources.json'),disk=JSON.parse(await readFile(path,'utf8')) as {sources:{walk:unknown;view:{priority_dirs:string[]}}[]}
  disk.sources[0]!.view.priority_dirs=[alpha]
  disk.sources[0]!.walk={queue:[{path:alpha},{path:beta}],ledger:[],generation:2,pending:[],deferred:[]}
  await writeFile(path,JSON.stringify(disk))
  let statCalls=0
  const sources=new LocalDirectorySources({path,computerRoot:f.folder,knowledge:f.knowledge,pollMs:0,scanOnOpen:false,metadataStatBudget:12,onMetadataStat:()=>{statCalls++}})
  try{
   await sources.open();await sources.command('sources.sync',{id})
   assert.ok(statCalls<=12,`stat calls exceeded batch budget: ${statCalls}`)
   assert.equal(statCalls,12)
   const saved=JSON.parse(await readFile(path,'utf8')) as {sources:{walk:{queue:{path:string}[]}}[]}
   assert.ok(saved.sources[0]!.walk.queue.length>0)
  }finally{await sources.close()}
 }finally{await f.close()}
})

test('rotating tail probe admits a recently active deep project while old roots progress',async()=>{
 const f=await fixture()
 try{
  const {id}=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  await f.sources.close()
  const oldTime=new Date('2020-01-01'),oldRoots:string[]=[]
  for(let i=0;i<80;i++){
   const dir=join(f.folder,`old-${String(i).padStart(2,'0')}`)
   await mkdir(dir);await utimes(dir,oldTime,oldTime);oldRoots.push(dir)
  }
  const active=join(f.folder,'tail-active');await mkdir(active)
  const document=join(active,'README.md');await writeFile(document,'Recently edited project notes')
  const path=join(f.root,'db','sources.json'),disk=JSON.parse(await readFile(path,'utf8')) as {sources:{walk:unknown;files:unknown[]}[]}
  disk.sources[0]!.files=[]
  disk.sources[0]!.walk={queue:[...oldRoots,active].map(path=>({path})),ledger:[],generation:1,turn:0,cursors:[0,0,0],probe_cursor:0,pending:[],deferred:[]}
  await writeFile(path,JSON.stringify(disk))
  const sources=new LocalDirectorySources({path,computerRoot:f.folder,knowledge:f.knowledge,pollMs:0,scanOnOpen:false})
  try{
   await sources.open();await sources.command('sources.sync',{id})
   assert.ok((await f.knowledge.listSources()).some(item=>item.locator===document),'deep recent project should be indexed in its first batch')
   const saved=JSON.parse(await readFile(path,'utf8')) as {sources:{walk:{queue:{path:string}[];ledger:{path:string;status:string}[]}}[]}
   assert.ok(saved.sources[0]!.walk.ledger.some(item=>oldRoots.includes(item.path)&&item.status==='done'),'older roots should continue making progress')
   assert.ok(saved.sources[0]!.walk.queue.length>0,'the scan should remain bounded and resumable')
  }finally{await sources.close()}
 }finally{await f.close()}
})

test('acceptance counts report cumulative scan time and entries per stage',async()=>{
 const f=await fixture()
 try{
  await writeFile(join(f.folder,'a.md'),'Next step: review the local note.');await writeFile(join(f.folder,'b.md'),'An idea for the setup.')
  await f.sources.command('sources.add',{path:f.folder,consent:true})
  const counts=f.sources.acceptanceCounts()
  assert.equal(counts.scan_ingest_n,2,'one ingest entry per read file')
  for(const stage of ['recover_pending','metadata_walk','ingest','on_change_final'])assert.ok(Number.isInteger(counts[`scan_${stage}_ms`])&&counts[`scan_${stage}_ms`]!>=0,stage)
  assert.ok(counts.scan_on_change_final_n!>=1,'the last stage is closed when the scan ends')
 }finally{await f.close()}
})
