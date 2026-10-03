import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {migrateLegacyMemory} from '../src/memory-substrate/migration.js'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {initializeMemory,memoryOperation,contentHash,CandidateSchema,type EvidenceRecord,type EntryRevision} from '../src/memory-substrate/store.js'

test('memory revisions preserve correction, deletion, suppression and retention',()=>{
 assert.equal(contentHash(' ＲＥＶＩＥＷ\u00a0说明 '),contentHash('review 说明'))
 const db=new DatabaseSync(':memory:');initializeMemory(db)
 const now='2026-09-12T00:00:00.000Z'
 const source=(id:string,kind:EvidenceRecord['source_kind']='im'):EvidenceRecord=>({id,source_id:id,source_kind:kind,locator:id,cursor:null,observed_at:now,recorded_at:now,raw_text:'Review by Friday',extracted:{},hash:contentHash(id),sensitivity:{policy_version:'1',redactions:[]},retention_until:null,trust:kind==='user_correction'?'trusted_user':'untrusted_external'})
 const run=(op:Parameters<typeof memoryOperation>[1],input:unknown)=>memoryOperation(db,op,input)
 run('append_evidence',source('im'));run('append_evidence',source('second'))
 const candidate=CandidateSchema.parse({entry_id:'one',kind:'fact',origin:'inferred',written_by:'merge',evidence_refs:['im','second'],content:{text:'review'},recorded_at:now})
 const first=run('merge',candidate) as EntryRevision;assert.equal(first.revision,1)
 assert.equal((run('merge',candidate) as EntryRevision).revision,1)
 run('delete_source',{source_id:'im'});assert.equal((run('list',{}) as EntryRevision[]).length,1)
 assert.equal(run('evidence',{id:'im'}),null)
 run('append_evidence',source('correction','user_correction'))
 const corrected=run('merge',{...candidate,expected_revision:1,origin:'stated',written_by:'user_correction',evidence_refs:['correction'],content:{text:'correct'}}) as EntryRevision
 assert.equal(corrected.revision,2);assert.equal(corrected.entry_id,first.entry_id)
 assert.throws(()=>run('merge',{...candidate,evidence_refs:['second'],expected_revision:1}),/STALE_REVISION/)
 assert.equal((run('merge',{...candidate,evidence_refs:['second']}) as EntryRevision).revision,2)
 assert.equal((run('history',{entry_id:'one'}) as EntryRevision[])[0]!.content.text,'review')
 run('forget',{entry_id:'one',candidate:{...candidate,origin:'stated',written_by:'user_correction',evidence_refs:['correction'],op:'tombstone',expected_revision:2}})
 assert.equal((run('list',{}) as EntryRevision[]).length,0)
 assert.equal(run('merge',{...candidate,entry_id:'resurrection',evidence_refs:['correction']}),null)
 run('append_evidence',source('expiry'));assert.equal(run('expire',{now:'2026-11-01T00:00:00.000Z'}),2)
 assert.equal((run('evidence',{id:'expiry'}) as EvidenceRecord).raw_text,null)
 run('append_evidence',source('third'));run('merge',{...candidate,entry_id:'delete',evidence_refs:['third']});run('delete_source',{source_id:'third'})
 assert.equal((run('history',{entry_id:'delete'}) as EntryRevision[]).at(-1)!.op,'tombstone')
 db.close()
})

test('expired entries and replay fences never enter current projections',()=>{
 const db=new DatabaseSync(':memory:');initializeMemory(db)
 const now='2026-09-12T00:00:00.000Z'
 const raw={id:'user:e:1',source_id:'user:im',source_kind:'im',locator:'chat/message',observed_at:now,recorded_at:now,raw_text:'password=secret123 useful review',hash:contentHash('review'),trust:'untrusted_external'}
 const saved=memoryOperation(db,'append_evidence',raw) as EvidenceRecord
 assert.ok(!saved.raw_text!.includes('secret123'));assert.ok(saved.sensitivity.redactions.length)
 assert.equal((memoryOperation(db,'pending_evidence',{source_prefix:'different:'}) as unknown[]).length,0)
 assert.equal((memoryOperation(db,'pending_evidence',{source_prefix:'user:'}) as unknown[]).length,1)
 memoryOperation(db,'merge',{entry_id:'expired',kind:'plan',origin:'inferred',written_by:'merge',evidence_refs:[raw.id],content:{text:'last week'},recorded_at:now,valid_until:now})
 assert.equal((memoryOperation(db,'list',{now}) as unknown[]).length,0)
 assert.equal((memoryOperation(db,'list',{now,include_history:true}) as unknown[]).length,1)
 memoryOperation(db,'record_extraction',{evidence_id:raw.id,attempt_id:'one',extracted:{candidates:[]}})
 assert.equal((memoryOperation(db,'pending_evidence',{source_prefix:'user:'}) as unknown[]).length,0)
 memoryOperation(db,'delete_source',{source_id:raw.source_id})
 assert.throws(()=>memoryOperation(db,'append_evidence',raw),/INVALID_OPERATION/)
 db.close()
})
test('file-derived inferences stay in history but leave personal and chat projections',()=>{
 const db=new DatabaseSync(':memory:');initializeMemory(db)
 const now=new Date().toISOString(),prefix='personal:me:'
 try{
  for(const [name,source_kind] of [['file','file'],['turn','conversation']] as const){
   const source_id=prefix+name,evidence_id=prefix+'e:'+name
   memoryOperation(db,'append_evidence',{id:evidence_id,source_id,source_kind,locator:name,observed_at:now,recorded_at:now,raw_text:'Project planning',hash:contentHash(name),trust:source_kind==='file'?'untrusted_external':'trusted_user'})
   memoryOperation(db,'source_grant',{source_id,expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:'provider',embedding_provider:'embed',conversation_providers:['chat']}})
   memoryOperation(db,'merge',{entry_id:prefix+name,kind:'fact',origin:source_kind==='file'?'inferred':'stated',written_by:'merge',evidence_refs:[evidence_id],content:{text:'Project planning'},recorded_at:now})
  }
  assert.equal((memoryOperation(db,'list',{}) as EntryRevision[]).length,2)
  assert.deepEqual((memoryOperation(db,'list',{exclude_file_inferences:true}) as EntryRevision[]).map(row=>row.entry_id),[prefix+'turn'])
  assert.deepEqual((memoryOperation(db,'conversation_snapshot',{entry_prefix:prefix,consumer:'chat'}) as EntryRevision[]).map(row=>row.entry_id),[prefix+'turn'])
  const search=memoryOperation(db,'search',{entry_prefix:prefix,provider:'lexical',query:'Project planning',vector:null,scope:'any',limit:8,exclude_file_inferences:true}) as {hits:{entry:EntryRevision}[]}
  assert.deepEqual(search.hits.map(hit=>hit.entry.entry_id),[prefix+'turn'])
  assert.deepEqual((memoryOperation(db,'pending_vectors',{entry_prefix:prefix,provider:'embed',limit:1,exclude_file_inferences:true}) as EntryRevision[]).map(row=>row.entry_id),[prefix+'turn'])
 }finally{db.close()}
})

test('legacy import is atomic and idempotent and leaves its recovery database unchanged',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'nova-memory-migrate-'));const path=join(directory,'legacy.sqlite');const old=new DatabaseSync(path)
 const now='2026-09-12T00:00:00.000Z'
 old.exec('CREATE TABLE vm_sources(user_id TEXT,scope TEXT,id TEXT,payload TEXT,state TEXT);CREATE TABLE vm_memories(user_id TEXT,scope TEXT,id TEXT,payload TEXT);CREATE TABLE vm_meta(key TEXT,value TEXT)')
 old.prepare('INSERT INTO vm_sources VALUES(?,?,?,?,?)').run('me','personal','turn',JSON.stringify({text:'喜欢短回复',recordedAt:now,occurredAt:now,role:'user',sessionId:'session'}),'done')
 old.prepare('INSERT INTO vm_memories VALUES(?,?,?,?)').run('me','personal','old-id',JSON.stringify({id:'old-id',kind:'trait',text:'喜欢短回复',authority:'explicit',recordedAt:now,occurredAt:now,evidenceIds:['turn'],supersededBy:null}))
 old.close();const db=new DatabaseSync(':memory:');initializeMemory(db)
 try {
  const request={path,user_id:'me',entry_prefix:'personal:me:',source_prefix:'personal:me:'}
  assert.equal(migrateLegacyMemory(db,request,path=>new DatabaseSync(path,{readOnly:true})),1);assert.equal(migrateLegacyMemory(db,request,path=>new DatabaseSync(path,{readOnly:true})),0)
  const entry=(memoryOperation(db,'list',{}) as EntryRevision[])[0]!
  assert.equal(entry.entry_id,'personal:me:old-id');assert.equal(entry.origin,'inferred')
  assert.equal((memoryOperation(db,'pending_evidence',{source_prefix:'personal:me:'}) as unknown[]).length,0)
  const original=new DatabaseSync(path,{readOnly:true});assert.equal(original.prepare('SELECT COUNT(*) n FROM vm_memories').get()!.n,1);original.close()
 }finally{db.close();await rm(directory,{recursive:true,force:true})}
})

test('corrections never enter pending extraction and graph timestamps use seconds',async()=>{
 const {recordWorkspaceRevision}=await import('../src/memory-substrate/workspace.js')
 const db=new DatabaseSync(':memory:');initializeMemory(db)
 const now='2026-09-12T00:00:00.000Z';const seconds=Date.parse(now)/1000
 try {
  memoryOperation(db,'append_evidence',{id:'user:e:correction',source_id:'user:correction',source_kind:'user_correction',locator:'correction',observed_at:now,recorded_at:now,raw_text:'删除这条记忆',hash:contentHash('delete'),trust:'trusted_user'})
  assert.equal((memoryOperation(db,'pending_evidence',{source_prefix:'user:'}) as unknown[]).length,0)
  recordWorkspaceRevision(db,'LogicalWorkspace',{logical_workspace_id:'project',display_name:'Project',aliases:[],canonical_remote:null,created_at:seconds,updated_at:seconds,revision:0})
  const entry=(memoryOperation(db,'list',{}) as EntryRevision[])[0]!
  assert.equal(entry.recorded_at,now)
  const evidence=memoryOperation(db,'evidence',{id:entry.evidence_refs[0]}) as EvidenceRecord
  assert.equal(evidence.observed_at,now)
 }finally{db.close()}
})

test('connector inventory is prefix-isolated and paginates without exposing other users',()=>{
 const db=new DatabaseSync(':memory:');initializeMemory(db)
 try{
  for(const id of ['personal:a:connector:1','personal:a:connector:2','personal:b:connector:1'])memoryOperation(db,'source_connection',{action:'create',id,namespace:id})
  const first=memoryOperation(db,'source_connection',{action:'list',prefix:'personal:a:connector:',limit:1}) as {connections:{fence:{connection_id:string}}[];next:string|null}
  assert.equal(first.connections.length,1);assert.equal(first.connections[0]?.fence.connection_id,'personal:a:connector:1')
  const second=memoryOperation(db,'source_connection',{action:'list',prefix:'personal:a:connector:',after:first.next,limit:1}) as typeof first
  assert.equal(second.connections[0]?.fence.connection_id,'personal:a:connector:2');assert.equal(second.next,null)
 }finally{db.close()}
})

test('resetting an expired sync fences late pages without changing scope or generation',()=>{
 const db=new DatabaseSync(':memory:');initializeMemory(db)
 try{
  const id='personal:a:connector:reset'
  memoryOperation(db,'source_connection',{action:'create',id,namespace:id})
  const next=memoryOperation(db,'source_connection',{action:'reset_sync',id,expected_epoch:0}) as {fence:{epoch:number;generation:number;scope_revision:number};checkpoint:unknown;continuation:unknown}
  assert.equal(next.fence.epoch,1);assert.equal(next.fence.generation,0);assert.equal(next.fence.scope_revision,0);assert.equal(next.checkpoint,null);assert.equal(next.continuation,null)
  assert.throws(()=>memoryOperation(db,'source_connection',{action:'reset_sync',id,expected_epoch:0}),/STALE/)
 }finally{db.close()}
})
