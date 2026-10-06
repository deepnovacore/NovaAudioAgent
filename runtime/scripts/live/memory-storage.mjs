import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {constants} from 'node:fs'
import {mkdtemp,open,readFile,realpath,rename,stat,unlink,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {isAbsolute,join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'

const args=process.argv.slice(2)
const selected=args.length===0?'storage':args.length===2&&args[0]==='--module'?args[1]:null
if(!['storage','purge'].includes(selected))throw Error('Usage: node memory-storage.mjs [--module storage|purge]')
if(process.env.NOVA_LIVE_MODULE_REPORT&&!isAbsolute(process.env.NOVA_LIVE_MODULE_REPORT))throw Error('NOVA_LIVE_MODULE_REPORT must be an absolute path')
const directory=await mkdtemp(join(await realpath(tmpdir()),'nova-memory-'+selected+'-live-'))
const reportPath=process.env.NOVA_LIVE_MODULE_REPORT||join(directory,'result.json')
const report={version:1,module:selected==='storage'?'memory-storage':'memory-purge',layer:'runtime-live',synthetic:true,status:'failed',checks:[],coverage:selected==='storage'?['Markdown hand edit admission through merge','worker restart and SQLite revision-index rebuild','durable outbox recovery after Git publication failure','read-only legacy Life JSON migration']:['PersonalAgentHost → SubstrateMemoryResource → managed Knowledge index purge','missing registered migration backup remains incomplete and retries','Git history and SQLite plaintext removal while retaining another object'],started_at:new Date().toISOString(),finished_at:null,checkpoint:'starting',checkpoints:[],limitations:['Runtime integration with synthetic data; no live model, GUI, voice, external account, or real user database.'],artifacts:{directory,ledger:join(directory,'ledger.sqlite')}}
let client,memory,host,knowledge,life,gatewayCalls=0
const forbiddenGateway={async *stream(){gatewayCalls++;throw Error('Unexpected model call in storage-only acceptance')},async complete(){gatewayCalls++;throw Error('Unexpected model call in storage-only acceptance')}}
async function save(){
 const file=await open(reportPath,constants.O_WRONLY|constants.O_CREAT|constants.O_TRUNC|constants.O_NOFOLLOW,0o600)
 try{await file.chmod(0o600);await file.writeFile(JSON.stringify(report,null,2)+'\n');await file.sync()}finally{await file.close()}
}
async function checkpoint(name){report.checkpoint=name;report.checkpoints.push({name,at:new Date().toISOString()});await save()}
async function pass(name){report.checks.push(name);await checkpoint(name);console.log('PASS',name)}
function git(path,...args){
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')))
 Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_TERMINAL_PROMPT:'0'})
 return execFileSync('git',['-c','core.hooksPath=/dev/null','-C',path,...args],{encoding:'utf8',env,timeout:15000,maxBuffer:16*1024*1024,stdio:['pipe','pipe','pipe']})
}
const now=()=>new Date().toISOString()
const sha=text=>createHash('sha256').update(text).digest('hex')
const legacyState=text=>({todos:[],ideas:[],goals:[],profile:{about:text,version:3},receipts:{}})
async function seed(prefix,key,text){
 const id=prefix+'e:'+key,time=now()
 await client.memory('append_evidence',{id,source_id:prefix+'source:'+key,source_kind:'conversation',locator:'synthetic:'+key,observed_at:time,recorded_at:time,raw_text:'SYNTHETIC ORIGINAL '+text,hash:sha(text),trust:'trusted_user'})
 await client.memory('record_extraction',{evidence_id:id,attempt_id:'synthetic-fixture-admission',extracted:{}})
 const row=await client.memory('merge',{entry_id:prefix+key,kind:'fact',origin:'stated',written_by:'merge',evidence_refs:[id],content:{text},recorded_at:time})
 return {entry:row,evidence:id}
}
async function assertNoSqlitePlaintext(path,text){
 for(const suffix of ['','-wal','-journal']){
  try{assert.equal((await readFile(path+suffix)).includes(Buffer.from(text)),false,`Selected plaintext remains in SQLite ${suffix||'main file'}`)}catch(error){if(error.code!=='ENOENT')throw error}
 }
}
async function assertGitErased(path,text,oldCommit){
 assert.equal(git(path,'rev-list','--count','HEAD').trim(),'1')
 if(oldCommit)assert.throws(()=>git(path,'cat-file','-e',oldCommit))
 assert.equal(git(path,'cat-file','--batch-all-objects','--batch').includes(text),false,'Selected plaintext remains in a Git object')
 assert.equal(git(path,'fsck','--no-reflogs','--unreachable').trim(),'')
}
async function storage(modules){
 const {MemoryLedgerClient,SubstrateMemoryResource,LifeService}=modules,path=report.artifacts.ledger,prefix='personal:synthetic-storage:'
 client=new MemoryLedgerClient(path);await client.open();await client.memory('enable_files',{})
 const initial=await seed(prefix,'preference','SYNTHETIC initial concise preference')
 const document=join(path+'.memory','entries',sha(initial.entry.entry_id)+'.md')
 const source=await readFile(document,'utf8'),beforeBody=source.slice(0,source.lastIndexOf('SYNTHETIC initial concise preference'))
 await checkpoint('editing-current-Markdown-body')
 await writeFile(document,beforeBody+'SYNTHETIC revised detailed preference\n',{mode:0o600})
 let rows=await client.memory('list',{}),edited=rows.find(row=>row.entry_id===initial.entry.entry_id)
 assert.equal(edited.revision,2);assert.equal(edited.written_by,'user_correction');assert.equal(edited.content.text,'SYNTHETIC revised detailed preference')
 const history=await client.memory('history',{entry_id:edited.entry_id});assert.equal(history[0].content.text,initial.entry.content.text)
 assert.equal((await readFile(document,'utf8')).includes('SYNTHETIC ORIGINAL'),false)
 await pass('actual Markdown body edit became a second merge revision while preserving history')
 await client.close();client=new MemoryLedgerClient(path);await client.open()
 assert.deepEqual(await client.memory('history',{entry_id:edited.entry_id}),history)
 await pass('worker restart retained the corrected stable ID and complete revision history')
 await client.close();client=undefined
 const db=new DatabaseSync(path);try{db.exec('DELETE FROM memory_revisions; DELETE FROM memory_vectors')}finally{db.close()}
 await checkpoint('reopening-after-synthetic-revision-index-removal')
 client=new MemoryLedgerClient(path);await client.open()
 assert.deepEqual(await client.memory('history',{entry_id:edited.entry_id}),history)
 await pass('Markdown rebuilt a deleted SQLite revision index without inventing history')
 const time=now(),evidenceId=prefix+'e:publication'
 await client.memory('append_evidence',{id:evidenceId,source_id:prefix+'source:publication',source_kind:'user_correction',locator:'synthetic:publication',observed_at:time,recorded_at:time,raw_text:'SYNTHETIC publication correction',hash:sha('publication correction'),trust:'trusted_user'})
 const lock=join(path+'.memory','.git','HEAD.lock');await writeFile(lock,'synthetic publication fault\n',{flag:'wx',mode:0o600})
 await checkpoint('injecting-Git-publication-failure')
 await assert.rejects(client.memory('merge',{entry_id:edited.entry_id,expected_revision:2,kind:'fact',origin:'stated',written_by:'user_correction',evidence_refs:[evidenceId],content:{text:'SYNTHETIC durable recovered correction'},recorded_at:time}))
 await client.close();client=undefined
 const pending=new DatabaseSync(path,{readOnly:true});try{assert.equal(pending.prepare('SELECT COUNT(*) count FROM memory_file_outbox').get().count,1)}finally{pending.close()}
 await unlink(lock);client=new MemoryLedgerClient(path);await client.open()
 rows=await client.memory('list',{});edited=rows.find(row=>row.entry_id===initial.entry.entry_id)
 assert.equal(edited.revision,3);assert.equal(edited.content.text,'SYNTHETIC durable recovered correction')
 const recovered=new DatabaseSync(path,{readOnly:true});try{assert.equal(recovered.prepare('SELECT COUNT(*) count FROM memory_file_outbox').get().count,0)}finally{recovered.close()}
 await pass('failed Git publication left a durable outbox and restart completed exactly one revision')
 await client.close();client=new MemoryLedgerClient(path)
 memory=new SubstrateMemoryResource({client,userId:'synthetic-storage-life',gateway:forbiddenGateway,model:'disabled',personalMemoryEnabled:false,consolidation:{enabled:false}});await memory.open()
 const legacyPath=join(directory,'legacy-life.json'),legacy=JSON.stringify(legacyState('SYNTHETIC read-only migrated profile'),null,2)+'\n'
 await writeFile(legacyPath,legacy,{mode:0o600});const before=await stat(legacyPath)
 life=new LifeService(legacyPath,()=>{},()=>memory.lifeBackend());await life.open()
 assert.equal(life.snapshot().profile.about,'SYNTHETIC read-only migrated profile')
 const after=await stat(legacyPath);assert.equal(await readFile(legacyPath,'utf8'),legacy);assert.equal(after.mode,before.mode);assert.equal(after.mtimeMs,before.mtimeMs)
 await pass('real LifeService imported synthetic legacy JSON without rewriting or changing its mode')
}
async function purge(modules){
 const {MemoryLedgerClient,SubstrateMemoryResource,PersonalAgentHost,SuggestionPool,UnifiedRetrieval,KnowledgeStoreClient,KnowledgeService}=modules
 const path=report.artifacts.ledger,hostPath=join(directory,'host.json'),indexPath=join(directory,'knowledge.sqlite'),legacyPath=hostPath+'.life.json'
 report.artifacts.knowledge_index=indexPath;report.artifacts.legacy_life=legacyPath
 const target='SYNTHETIC ERASE INDEXED MEMORY',retained='SYNTHETIC KEEP OTHER MEMORY',legacyText='SYNTHETIC ERASE LEGACY PROFILE'
 await writeFile(legacyPath,JSON.stringify(legacyState(legacyText)),{mode:0o600})
 client=new MemoryLedgerClient(path)
 memory=new SubstrateMemoryResource({client,userId:'synthetic-purge',gateway:forbiddenGateway,model:'disabled',personalMemoryEnabled:false,consolidation:{enabled:false}});await memory.open()
 const chosen=await seed(memory.prefix,'selected',target),keep=await seed(memory.prefix,'retained',retained)
 await client.memory('record_extraction',{evidence_id:chosen.evidence,attempt_id:'knowledge-index',extracted:{}})
 const index=new KnowledgeStoreClient({path:indexPath})
 knowledge=new KnowledgeService({store:index,embedding:{id:'disabled',dims:2,async embed(){throw Error('Unexpected embedding call in storage-only acceptance')}}});await knowledge.open()
 const timestamp=Date.now(),source={id:'synthetic-source',title:'Synthetic acceptance source',kind:'file',locator:join(directory,'synthetic-source.txt'),mime:'text/plain',fingerprint:'synthetic-v1',bytes:target.length+retained.length,created_at:timestamp,updated_at:timestamp,status:'ready'}
 const indexInput={source,provider_id:'synthetic-local-fixture',dims:2,chunks:[{heading_path:'Selected',text:target,token_estimate:5,vector:[1,0],evidence_id:chosen.evidence},{heading_path:'Retained',text:retained,token_estimate:5,vector:[0,1],evidence_id:keep.evidence}]}
 await index.replaceSource(indexInput)
 host=new PersonalAgentHost({path:hostPath,userScope:'synthetic-purge',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null})
 host.setRetrieval(new UnifiedRetrieval({memory:()=>memory,rawPurgeEvidence:ids=>knowledge.purgeEvidence(ids)}));await host.open()
 const oldCommit=git(path+'.memory','rev-parse','HEAD').trim()
 await checkpoint('executing-host-purge-with-managed-knowledge-index')
 const response=await host.command({type:'personal.command',request_id:'synthetic-index-purge',method:'memory.purge',params:{id:chosen.entry.entry_id,expected_version:chosen.entry.revision}})
 assert.equal(response.ok,true,JSON.stringify(response));assert.equal(response.data.status,'complete');assert.deepEqual(response.data.index_evidence_ids,[])
 assert.equal(await memory.get(chosen.entry.entry_id),null);assert.equal(await memory.readEvidence(chosen.evidence),null)
 assert.deepEqual((await index.listChunks(source.id)).map(row=>row.text),[retained]);assert.ok(await memory.get(keep.entry.entry_id))
 await assertGitErased(path+'.memory',target,oldCommit);await assertNoSqlitePlaintext(path,target);await assertNoSqlitePlaintext(indexPath,target)
 await pass('actual host command erased Substrate evidence and Knowledge copies while retaining another object')
 await index.replaceSource(indexInput);assert.deepEqual((await index.listChunks(source.id)).map(row=>row.text),[retained])
 await pass('durable index suppression blocked stale chunk reconstruction after deletion')
 const profile=(await client.memory('list',{})).find(row=>row.kind==='profile'),hidden=join(directory,'temporarily-unavailable-life.json')
 assert.ok(profile);await rename(legacyPath,hidden);await checkpoint('removing-registered-synthetic-backup-before-purge')
 const command={type:'personal.command',request_id:'synthetic-backup-missing',method:'memory.purge',params:{id:profile.entry_id,expected_version:profile.revision}}
 const incomplete=await host.command(command);assert.equal(incomplete.ok,true,JSON.stringify(incomplete));assert.equal(incomplete.data.status,'incomplete');assert.equal((await memory.pendingPurges()).length,1)
 await pass('missing registered migration backup kept the host result explicitly incomplete')
 await host.close();host=undefined;await memory.close();memory=undefined;client=undefined
 await rename(hidden,legacyPath);client=new MemoryLedgerClient(path)
 memory=new SubstrateMemoryResource({client,userId:'synthetic-purge',gateway:forbiddenGateway,model:'disabled',personalMemoryEnabled:false,consolidation:{enabled:false}});await memory.open()
 host=new PersonalAgentHost({path:hostPath,userScope:'synthetic-purge',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null});host.setRetrieval(new UnifiedRetrieval({memory:()=>memory,rawPurgeEvidence:ids=>knowledge.purgeEvidence(ids)}));await host.open()
 const retried=await host.command({...command,request_id:'synthetic-backup-restored'});assert.equal(retried.ok,true,JSON.stringify(retried));assert.equal(retried.data.status,'complete');assert.equal(retried.data.operation_id,incomplete.data.operation_id)
 assert.equal(JSON.parse(await readFile(legacyPath,'utf8')).profile.about,'');assert.deepEqual(await memory.pendingPurges(),[])
 assert.deepEqual((await client.memory('list',{})).map(row=>row.entry_id),[keep.entry.entry_id])
 await assertGitErased(path+'.memory',legacyText);await assertNoSqlitePlaintext(path,legacyText);await assertNoSqlitePlaintext(path,target)
 assert.equal((await readFile(hostPath,'utf8')).includes(target),false);assert.equal((await readFile(hostPath,'utf8')).includes(legacyText),false)
 await pass('restart and restored backup completed the same purge without reviving content or losing the retained object')
}
try{
 await checkpoint('loading-compiled-runtime')
 const [store,resource,lifeModule,hostModule,suggestions,retrieval,index,knowledgeModule]=await Promise.all([
  import('../../dist/src/memory-ledger/store-client.js'),import('../../dist/src/memory-substrate/resource.js'),import('../../dist/src/personal-agent/life.js'),import('../../dist/src/personal-agent/host.js'),import('../../dist/src/core/suggestions.js'),import('../../dist/src/memory/retrieval.js'),import('../../dist/src/knowledge/store-client.js'),import('../../dist/src/knowledge/service.js'),
 ])
 const modules={...store,...resource,...lifeModule,...hostModule,...suggestions,...retrieval,...index,...knowledgeModule}
 await (selected==='storage'?storage(modules):purge(modules))
 assert.equal(gatewayCalls,0,'No model may be called by this acceptance module');await pass('no model or external account was used');report.status='passed'
}catch(error){report.status='failed';report.failure={checkpoint:report.checkpoint,name:error?.name??'Error',message:String(error?.message??error)};process.exitCode=1;console.error('FAIL',report.failure)}finally{
 for(const [name,resource] of [['host',host],['life',life],['memory',memory],['client',client],['knowledge',knowledge]]){
  try{await resource?.close()}catch(error){report.status='failed';report.cleanup_errors??=[];report.cleanup_errors.push({resource:name,message:String(error?.message??error)});process.exitCode=1}
 }
 report.gateway_calls=gatewayCalls;report.finished_at=new Date().toISOString();await save();console.log('Runtime integration report:',reportPath)
}
