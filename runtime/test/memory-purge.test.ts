import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile,writeFile,rename,unlink,symlink} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {canonicalJson} from '../src/text/canonical-json.js'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {DatabaseSync} from 'node:sqlite'
import {execFileSync} from 'node:child_process'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import {initializeMemory,memoryOperation} from '../src/memory-substrate/store.js'
import {enableMemoryFiles} from '../src/memory-substrate/file-authority.js'
import {purgeEntry} from '../src/memory-substrate/purge.js'
import type {EntryRevision} from '../src/memory-substrate/store.js'

const now='2026-09-21T00:00:00Z',prefix='personal:purge:'
async function add(client:MemoryLedgerClient,id:string,text:string){
 await client.memory('append_evidence',{id:prefix+'e:'+id,source_id:prefix+'s:'+id,source_kind:'conversation',locator:id,observed_at:now,recorded_at:now,raw_text:'RAW '+text,hash:id,trust:'trusted_user'})
 await client.memory('merge',{entry_id:prefix+id,kind:'fact',origin:'stated',written_by:'merge',evidence_refs:[prefix+'e:'+id],content:{text},recorded_at:now})
}
test('entry purge erases ledger evidence and Git history, preserves another object, and retries after restart',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-purge-')),path=join(root,'ledger.sqlite');let client=new MemoryLedgerClient(path)
 try{
  await client.open();await client.memory('enable_files',{});await add(client,'one','SYNTHETIC DELETE SECRET');await add(client,'two','SYNTHETIC KEEP')
  const input={request_id:'purge-1',entry_prefix:prefix,selection:{kind:'entry',id:prefix+'one',expected_revision:1}}
  const result=await client.memory('purge',input) as {status:string;removed_entries:number;removed_evidence:number}
  assert.equal(result.status,'complete');assert.equal(result.removed_entries,1);assert.equal(result.removed_evidence,1)
  assert.deepEqual((await client.memory('list',{}) as EntryRevision[]).map(row=>row.entry_id),[prefix+'two'])
  assert.equal(await client.memory('evidence',{id:prefix+'e:one'}),null)
  assert.equal(execFileSync('git',['-C',path+'.memory','rev-list','--count','HEAD'],{encoding:'utf8'}).trim(),'1')
  await client.close();client=new MemoryLedgerClient(path);await client.open()
  assert.equal((await client.memory('purge',{...input,request_id:'purge-retry'}) as {status:string}).status,'complete')
  assert.equal((await readFile(path)).includes(Buffer.from('SYNTHETIC DELETE SECRET')),false)
  assert.equal((await client.memory('purge',{request_id:'purge-2',entry_prefix:prefix,selection:{kind:'entry',id:prefix+'two',expected_revision:1}}) as {status:string}).status,'complete')
  assert.equal((await readFile(path)).includes(Buffer.from('SYNTHETIC KEEP')),false,'prior successful purge receipts cannot retain the next selected content')
 }finally{await client.close();await rm(root,{recursive:true,force:true})}
})

const legacyLife=()=>({todos:[],ideas:[],goals:[],profile:{about:'SYNTHETIC LEGACY DELETE',version:3},receipts:{}})
test('purge cleans only the selected Life migration object and retries a temporarily missing registered backup',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-purge-life-')),path=join(root,'ledger.sqlite'),backup=join(root,'life.json'),hidden=join(root,'temporarily-unavailable.json'),namespace=prefix+'life:';let client=new MemoryLedgerClient(path)
 try{
  const legacy=legacyLife();await writeFile(backup,JSON.stringify(legacy));await client.open();await client.memory('enable_files',{})
  await client.memory('life_load',{namespace,legacy,hostMigrationPath:backup});await add(client,'keep','KEEP SEPARATE OBJECT')
  const selected=(await client.memory('list',{}) as EntryRevision[]).find(row=>row.kind==='profile')!
  await rename(backup,hidden)
  const input={request_id:'missing-backup',entry_prefix:prefix,selection:{kind:'entry',id:selected.entry_id,expected_revision:selected.revision}}
  assert.equal((await client.memory('purge',input) as {status:string}).status,'incomplete')
  assert.equal((await client.memory('purge_status',{entry_prefix:prefix}) as unknown[]).length,1)
  await assert.rejects(client.memory('purge',{request_id:'cannot-overlap',entry_prefix:prefix,selection:{kind:'entry',id:prefix+'keep',expected_revision:1}}))
  await client.close();await rename(hidden,backup);client=new MemoryLedgerClient(path);await client.open()
  assert.equal((await client.memory('purge',{...input,request_id:'retry-backup'}) as {status:string}).status,'complete')
  assert.equal((JSON.parse(await readFile(backup,'utf8')) as {profile:{about:string}}).profile.about,'')
  assert.deepEqual((await client.memory('list',{}) as EntryRevision[]).map(row=>row.entry_id),[prefix+'keep'])
  assert.equal((await client.memory('purge_status',{entry_prefix:prefix}) as unknown[]).length,0)
 }finally{await client.close();await rm(root,{recursive:true,force:true})}
})
test('purge does not claim completion for an old Life migration with no registered backup path',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-purge-unregistered-')),path=join(root,'ledger.sqlite'),client=new MemoryLedgerClient(path)
 try{
  await client.open();await client.memory('enable_files',{});await client.memory('life_load',{namespace:prefix+'life:',legacy:legacyLife()})
  const row=(await client.memory('list',{}) as EntryRevision[])[0]!
  const result=await client.memory('purge',{request_id:'unregistered',entry_prefix:prefix,selection:{kind:'entry',id:row.entry_id,expected_revision:row.revision}}) as {status:string;backup_cleanup:{unresolved:string[]}}
  assert.equal(result.status,'incomplete');assert.ok(result.backup_cleanup.unresolved.includes('life_backup_path_unregistered'))
  assert.equal((await client.memory('list',{}) as unknown[]).length,0)
 }finally{await client.close();await rm(root,{recursive:true,force:true})}
})
test('purge cleans a registered legacy VoiceMem backup without deleting another user or remaining object',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-purge-legacy-')),path=join(root,'ledger.sqlite'),backup=join(root,'legacy.sqlite'),client=new MemoryLedgerClient(path)
 const legacy=new DatabaseSync(backup)
 legacy.exec('CREATE TABLE vm_memories(user_id TEXT,scope TEXT,id TEXT,payload TEXT);CREATE TABLE vm_sources(user_id TEXT,scope TEXT,id TEXT,payload TEXT,state TEXT)')
 const insert=(user:string,id:string,text:string)=>{
  legacy.prepare('INSERT INTO vm_sources VALUES(?,?,?,?,?)').run(user,'personal','s:'+id,JSON.stringify({text,recordedAt:now,occurredAt:null}),'active')
  legacy.prepare('INSERT INTO vm_memories VALUES(?,?,?,?)').run(user,'personal',id,JSON.stringify({id,kind:'fact',text,evidenceIds:['s:'+id],authority:'inferred',recordedAt:now,occurredAt:null,supersededBy:null}))
 }
 insert('test','one','LEGACY SELECTED SECRET');insert('test','two','LEGACY RETAINED');insert('other','one','OTHER USER RETAINED');legacy.close()
 try{
  await client.open();await client.memory('migrate_legacy',{path:backup,user_id:'test',entry_prefix:prefix,source_prefix:prefix});await client.memory('enable_files',{})
  assert.equal((await client.memory('purge',{request_id:'legacy-purge',entry_prefix:prefix,selection:{kind:'entry',id:prefix+'one',expected_revision:1}}) as {status:string}).status,'complete')
  const check=new DatabaseSync(backup,{readOnly:true});try{assert.equal(check.prepare('SELECT COUNT(*) n FROM vm_memories').get()!.n,2);assert.equal(check.prepare('SELECT COUNT(*) n FROM vm_sources').get()!.n,2)}finally{check.close()}
  assert.equal((await readFile(backup)).includes(Buffer.from('LEGACY SELECTED SECRET')),false)
  assert.equal(await client.memory('migrate_legacy',{path:backup,user_id:'test',entry_prefix:prefix,source_prefix:prefix}),0)
 }finally{await client.close();await rm(root,{recursive:true,force:true})}
})

test('purge Git failure stays incomplete and restart finishes the same operation before rebuilding',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-purge-recover-')),path=join(root,'ledger.sqlite');let client=new MemoryLedgerClient(path)
 try{
  await client.open();await client.memory('enable_files',{});await add(client,'one','CRASH SELECTED SECRET')
  const lock=join(path+'.memory','.git','HEAD.lock');await writeFile(lock,'synthetic Git failure')
  const input={request_id:'failed-git',entry_prefix:prefix,selection:{kind:'entry',id:prefix+'one',expected_revision:1}}
  const failed=await client.memory('purge',input) as {status:string;operation_id:string};assert.equal(failed.status,'incomplete')
  await client.close();await unlink(lock);client=new MemoryLedgerClient(path);await client.open()
  assert.equal((await client.memory('list',{}) as unknown[]).length,0)
  const recovered=await client.memory('purge',{...input,request_id:'retry-git'}) as {status:string;operation_id:string};assert.equal(recovered.status,'complete');assert.equal(recovered.operation_id,failed.operation_id)
 }finally{await client.close();await rm(root,{recursive:true,force:true})}
})
test('purge refuses a symlink migration backup and keeps the external file unchanged',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-purge-symlink-')),path=join(root,'ledger.sqlite'),backup=join(root,'life.json'),external=join(root,'external.json'),client=new MemoryLedgerClient(path),legacy=legacyLife()
 try{
  await writeFile(external,JSON.stringify(legacy));await symlink(external,backup);await client.open();await client.memory('enable_files',{})
  await client.memory('life_load',{namespace:prefix+'life:',legacy,hostMigrationPath:backup})
  const row=(await client.memory('list',{}) as EntryRevision[])[0]!
  assert.equal((await client.memory('purge',{request_id:'symlink',entry_prefix:prefix,selection:{kind:'entry',id:row.entry_id,expected_revision:row.revision}}) as {status:string}).status,'incomplete')
  assert.equal(await readFile(external,'utf8'),JSON.stringify(legacy))
 }finally{await client.close();await rm(root,{recursive:true,force:true})}
})
test('purging one entry removes dependent summaries but preserves independent raw evidence and gates shared evidence',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-purge-summary-')),path=join(root,'ledger.sqlite'),client=new MemoryLedgerClient(path)
 try{
  await client.open();await client.memory('enable_files',{});await add(client,'one','SELECTED');await add(client,'two','RETAINED')
  for(const id of ['one','two'])await client.memory('source_grant',{source_id:prefix+'s:'+id,expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:null,embedding_provider:null,conversation_providers:['consumer']}})
  await client.memory('merge',{entry_id:prefix+'shared',kind:'fact',origin:'stated',written_by:'merge',evidence_refs:[prefix+'e:one'],content:{text:'OTHER SHARED UNDERSTANDING'},recorded_at:now})
  await client.memory('merge',{entry_id:prefix+'summary',kind:'memory_summary',origin:'inferred',written_by:'merge',evidence_refs:[prefix+'e:one',prefix+'e:two'],content:{text:'SUMMARY',basis:[{id:prefix+'one',revision:1},{id:prefix+'two',revision:1}]},recorded_at:now})
  assert.equal((await client.memory('purge',{request_id:'summary',entry_prefix:prefix,selection:{kind:'entry',id:prefix+'one',expected_revision:1}}) as {status:string}).status,'complete')
  assert.notEqual(await client.memory('evidence',{id:prefix+'e:two'}),null)
  assert.deepEqual((await client.memory('list',{}) as EntryRevision[]).map(row=>row.entry_id).sort(),[prefix+'shared',prefix+'two'])
  assert.deepEqual((await client.memory('conversation_snapshot',{entry_prefix:prefix,consumer:'consumer'}) as EntryRevision[]).map(row=>row.entry_id),[prefix+'two'])
 }finally{await client.close();await rm(root,{recursive:true,force:true})}
})

test('a failure after saving compaction intent cannot leave a durable complete receipt',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-purge-compact-')),path=join(root,'ledger.sqlite');let db=new DatabaseSync(path)
 try{
  initializeMemory(db);enableMemoryFiles(db,path+'.memory')
  memoryOperation(db,'append_evidence',{id:prefix+'e:one',source_id:prefix+'s:one',source_kind:'conversation',locator:'one',observed_at:now,recorded_at:now,raw_text:'COMPACTION SECRET',hash:'one',trust:'trusted_user'})
  memoryOperation(db,'merge',{entry_id:prefix+'one',kind:'fact',origin:'stated',written_by:'merge',evidence_refs:[prefix+'e:one'],content:{text:'COMPACTION SECRET'},recorded_at:now})
  const input={request_id:'compaction-failure',entry_prefix:prefix,selection:{kind:'entry',id:prefix+'one',expected_revision:1}}
  const interrupted={prepare:db.prepare.bind(db),close:db.close.bind(db),exec:(sql:string)=>{if(sql==='VACUUM')throw Error('synthetic interruption before compaction');db.exec(sql)}}
  assert.equal(purgeEntry(interrupted,path,input).status,'incomplete')
  const durable=JSON.parse(String(db.prepare('SELECT payload_json FROM memory_purges').get()!.payload_json)) as {result:{status:string;backup_cleanup:{unresolved:string[]}}}
  assert.equal(durable.result.status,'incomplete');assert.ok(durable.result.backup_cleanup.unresolved.includes('ledger_compaction_pending'))
  db.close();db=new DatabaseSync(path);initializeMemory(db)
  assert.equal(purgeEntry(db,path,input).status,'complete')
  assert.equal((await readFile(path)).includes(Buffer.from('COMPACTION SECRET')),false)
 }finally{db.close();await rm(root,{recursive:true,force:true})}
})

test('purge remains incomplete until the host confirms evidence-linked index cleanup',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-purge-index-')),path=join(root,'ledger.sqlite'),client=new MemoryLedgerClient(path)
 try{
  await client.open();await client.memory('enable_files',{});await add(client,'one','INDEXED SELECTED SECRET')
  await client.memory('record_extraction',{evidence_id:prefix+'e:one',attempt_id:'knowledge-index',extracted:{}})
  const result=await client.memory('purge',{request_id:'index-purge',entry_prefix:prefix,selection:{kind:'entry',id:prefix+'one',expected_revision:1}}) as {status:string;operation_id:string;index_evidence_ids:string[]}
  assert.equal(result.status,'incomplete');assert.deepEqual(result.index_evidence_ids,[prefix+'e:one'])
  await assert.rejects(client.memory('purge_index_complete',{entry_prefix:prefix,entry_id:prefix+'one',operation_id:'wrong-operation'}))
  const completed=await client.memory('purge_index_complete',{entry_prefix:prefix,entry_id:prefix+'one',operation_id:result.operation_id}) as {status:string;index_evidence_ids:string[]}
  assert.equal(completed.status,'complete');assert.deepEqual(completed.index_evidence_ids,[])
 }finally{await client.close();await rm(root,{recursive:true,force:true})}
})


// Reproduce the old importer directly: the fixed importer must never manufacture this row again.
function historicalEmptyProfile(db:DatabaseSync,backup:string|undefined,profile={about:'',version:0},namespace=prefix+'life:'){
 initializeMemory(db)
 const digest=(text:string)=>createHash('sha256').update(text).digest('hex'),id=namespace+'profile:profile',evidenceId=namespace+'e:legacy:'+digest(id)
 const fingerprint=digest(canonicalJson({entry_id:id,legacy:profile}))
 memoryOperation(db,'append_evidence',{id:evidenceId,source_id:namespace+'migration:'+digest(id),source_kind:'task_result',locator:'legacy-life-json:profile',observed_at:now,recorded_at:now,raw_text:null,hash:fingerprint,trust:'trusted_system',extracted:{event:'legacy_import',legacy:true,original_evidence_available:false}})
 memoryOperation(db,'merge',{entry_id:id,kind:'profile',origin:'inferred',written_by:'merge',evidence_refs:[evidenceId],content:{life_id:'profile',life_data:profile,life_order:0,text:profile.about,section:'explicit',legacy:true},recorded_at:now})
 db.prepare('INSERT INTO memory_life_meta VALUES(?,?)').run(namespace,canonicalJson({revision:0,receipts:{},signature:digest(canonicalJson(memoryOperation(db,'list',{}))),migrated:true,...(backup?{legacy_path:backup}:{})}))
 return {id,evidenceId,fingerprint,input:{request_id:'historical',entry_prefix:prefix,selection:{kind:'entry',id,expected_revision:1}}}
}

test('historical empty default Profile does not require a missing backup, including after an explicit edit',async()=>{
 for(const edited of [false,true]){
  const root=await mkdtemp(join(tmpdir(),'nova-purge-old-empty-')),path=join(root,'ledger.sqlite'),db=new DatabaseSync(path)
  try{
   const fixture=historicalEmptyProfile(db,join(root,'life.json'))
   if(edited){memoryOperation(db,'life_load',{namespace:prefix+'life:'});memoryOperation(db,'life_mutate',{namespace:prefix+'life:',expectedRevision:0,requestId:'edit',input:{op:'profile',expected_version:0,about:'LATER PRIVATE PROFILE'}});fixture.input.selection.expected_revision=2}
   enableMemoryFiles(db,path+'.memory')
   assert.equal(purgeEntry(db,path,fixture.input).status,'complete')
   assert.deepEqual(memoryOperation(db,'list',{}),[])
   assert.equal(memoryOperation(db,'evidence',{id:fixture.evidenceId}),null)
   assert.equal(purgeEntry(db,path,fixture.input).status,'complete')
   assert.throws(()=>memoryOperation(db,'append_evidence',{id:fixture.evidenceId,source_id:'replay',source_kind:'conversation',locator:'replay',observed_at:now,recorded_at:now,raw_text:'replay',hash:'replay',trust:'trusted_user'}))
  }finally{db.close();await rm(root,{recursive:true,force:true})}
 }
})

test('old incomplete empty-Profile purge retries from stripped mappings and suppressed fingerprint after restart',async()=>{
 for(const proof of ['same-entry','other-namespace','missing']){
  const root=await mkdtemp(join(tmpdir(),'nova-purge-old-incomplete-')),path=join(root,'ledger.sqlite');let db=new DatabaseSync(path)
  try{
   const fixture=historicalEmptyProfile(db,join(root,'life.json')),digest=(text:string)=>createHash('sha256').update(text).digest('hex')
   db.exec('DELETE FROM memory_revisions; DELETE FROM memory_evidence')
   for(const id of [fixture.id,fixture.evidenceId])db.prepare('INSERT INTO memory_purged_ids VALUES(?)').run(digest(id))
   if(proof!=='missing')db.prepare('INSERT INTO memory_suppressed VALUES(?)').run(proof==='same-entry'?fixture.fingerprint:digest(canonicalJson({entry_id:'personal:other:life:profile:profile',legacy:{about:'',version:0}})))
   const intent={selected:[{entry_id:fixture.id,kind:'profile',content:{legacy:true,life_id:'profile'}}],operation_id:'old-operation',entry_id:fixture.id,expected_revision:1,request_ids:['historical'],revisions:[],baselines:{},removed_entries:1,removed_evidence:1,removed_entry_ids:[fixture.id],removed_evidence_ids:[fixture.evidenceId],pending_index_evidence_ids:[],backups:[],unresolved:['life_backup_unverified'],repository_done:true,result:{status:'incomplete',operation_id:'old-operation',backup_cleanup:{status:'incomplete',unresolved:['life_backup_unverified']}}}
   db.prepare('INSERT INTO memory_purges VALUES(?,?)').run(fixture.id,canonicalJson(intent));db.close();db=new DatabaseSync(path);initializeMemory(db)
   const retried=purgeEntry(db,path,{...fixture.input,request_id:'retry'})
   assert.equal(retried.status,proof==='same-entry'?'complete':'incomplete',proof);assert.equal(retried.operation_id,'old-operation')
   assert.equal(db.prepare('SELECT COUNT(*) n FROM memory_purged_ids').get()!.n,2)
  }finally{db.close();await rm(root,{recursive:true,force:true})}
 }
})

test('empty migration exemption fails closed for actual backups, unsafe paths and nonempty historical Profiles',async()=>{
 for(const variant of ['present','invalid-json','symlink','missing-parent','no-path','versioned-blank','nonempty-cleared','missing-proof','voicemem-mapping']){
  const root=await mkdtemp(join(tmpdir(),'nova-purge-proof-boundary-')),path=join(root,'ledger.sqlite'),backup=join(root,'life.json'),external=join(root,'external.json'),db=new DatabaseSync(path)
  try{
   const profile=variant==='versioned-blank'?{about:'',version:1}:variant==='nonempty-cleared'?{about:'ACTUAL OLD PRIVATE TEXT',version:1}:{about:'',version:0}
   const fixture=historicalEmptyProfile(db,variant==='no-path'?undefined:variant==='missing-parent'?join(root,'absent','life.json'):backup,profile)
   if(variant==='present')await writeFile(backup,JSON.stringify(legacyLife()))
   if(variant==='invalid-json')await writeFile(backup,'not JSON')
   if(variant==='symlink'){await writeFile(external,JSON.stringify(legacyLife()));await symlink(external,backup)}
   if(variant==='missing-proof')db.prepare("UPDATE memory_evidence SET payload_json=json_set(payload_json,'$.hash','unproved') WHERE id=?").run(fixture.evidenceId)
   if(variant==='voicemem-mapping')db.exec("UPDATE memory_revisions SET payload_json=json_set(payload_json,'$.content.legacy_id','old-voice')")
   if(variant==='nonempty-cleared'){memoryOperation(db,'life_load',{namespace:prefix+'life:'});memoryOperation(db,'life_mutate',{namespace:prefix+'life:',expectedRevision:0,requestId:'clear',input:{op:'profile',expected_version:1,about:''}});fixture.input.selection.expected_revision=2}
   enableMemoryFiles(db,path+'.memory')
   const result=purgeEntry(db,path,fixture.input)
   assert.equal(result.status,variant==='present'?'complete':'incomplete',variant)
   if(variant==='present')assert.equal((JSON.parse(await readFile(backup,'utf8')) as {profile:{about:string}}).profile.about,'','a proven empty import still scrubs a present backup')
   if(variant==='symlink')assert.equal(await readFile(external,'utf8'),JSON.stringify(legacyLife()))
  }finally{db.close();await rm(root,{recursive:true,force:true})}
 }
})
