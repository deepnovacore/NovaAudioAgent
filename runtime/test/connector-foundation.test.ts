import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {connectorSourceId,initializeSourceState,assertSourceStateSchema} from '../src/memory-substrate/source-state.js'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import type {SourceConnection} from '../src/memory-substrate/source-state.js'
import {initializeMemory,memoryOperation,EvidenceRecordSchema,CandidateSchema,type MemoryOperation,type EntryRevision} from '../src/memory-substrate/store.js'

test('source identity separates accounts and deletion generations within reference budget',()=>{
 const a=connectorSourceId('account',0,'x'.repeat(4096))
 assert.ok(('personal:'+ 'a'.repeat(64)+':'+a).length<=256)
 assert.equal(a,connectorSourceId('account',0,'x'.repeat(4096)))
 assert.notEqual(a,connectorSourceId('other',0,'x'.repeat(4096)))
 assert.notEqual(a,connectorSourceId('account',1,'x'.repeat(4096)))
 assert.throws(()=>connectorSourceId('account',-1,'x'))
 assert.throws(()=>connectorSourceId('account',Number.MAX_SAFE_INTEGER+1,'x'))
})

test('paused and outdated-scope sources cannot starve extraction admission',()=>{
 const db=new DatabaseSync(':memory:');initializeMemory(db)
 const run=(op:MemoryOperation,input:unknown)=>memoryOperation(db,op,input)
 try{
  for(const [index,name] of ['paused','outdated','active'].entries()){
   run('source_connection',{action:'create',id:name,namespace:name})
   const c=run('source_connection',{action:'fence',id:name,state:'connected',expected_epoch:0}) as SourceConnection
   const source_id=connectorSourceId(name,0,'object'),id=String(index)
   run('source_apply_page',{fence:c.fence,batch_id:'1',page_id:'page',changes:[{object_key:'object',source_id,semantic_hash:id,metadata:{},status:'current',evidence:[EvidenceRecordSchema.parse({id,source_id,source_kind:'mail',locator:id,observed_at:new Date().toISOString(),recorded_at:new Date().toISOString(),raw_text:id,hash:id,trust:'untrusted_external'})]}],pending_ids:[],continuation:null,checkpoint:null,complete:true})
   run('source_grant',{source_id,expected_revision:0,grant:{revision:1,scope_revision:name==='outdated'?1:0,extraction_provider:'fixture',embedding_provider:null}})
   if(name==='paused')run('source_connection',{action:'fence',id:name,state:'paused',expected_epoch:c.fence.epoch})
  }
  assert.deepEqual((run('pending_evidence',{source_prefix:'connector:',provider:'fixture',limit:1}) as {id:string}[]).map(e=>e.id),['2'])
 }finally{db.close()}
})

test('undelivered source phases survive later batches and paginate beyond 200 receipts',()=>{
 const db=new DatabaseSync(':memory:');initializeMemory(db)
 const run=(op:MemoryOperation,input:unknown)=>memoryOperation(db,op,input)
 try{
  run('source_connection',{action:'create',id:'c',namespace:'n'})
  const c=run('source_connection',{action:'fence',id:'c',state:'connected',expected_epoch:0}) as SourceConnection
  for(let n=1;n<=202;n++)run('source_apply_page',{fence:c.fence,batch_id:String(n),page_id:'p',changes:[],pending_ids:[],continuation:null,checkpoint:null,complete:true})
  const first=run('source_events',{prefix:'c',provider:'fixture'}) as {events:{revision:number;phase:string}[];next:number|null}
  assert.equal(first.events[0]?.revision,1);assert.equal(first.events.length,200);assert.equal(first.next,200)
  const next=run('source_events',{prefix:'c',provider:'fixture',after:first.next}) as typeof first
  assert.deepEqual(next.events.map(e=>e.revision),[201,202]);assert.equal(next.next,null)
  run('source_events',{prefix:'c',provider:'fixture',ack:{revision:1,phase:'invalidated'}})
  const ready=run('source_events',{prefix:'c',provider:'fixture'}) as typeof first
  assert.deepEqual(ready.events[0],{revision:1,phase:'ready'})
 }finally{db.close()}
})

test('v3 migration preserves evidence and suppression and does not reset source clock',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-source-migration-'));const path=join(root,'memory.sqlite')
 let client=new MemoryLedgerClient(path)
 try{
  await client.open();await client.close()
  const old=new DatabaseSync(path)
  for(const table of ['source_connections','source_objects','source_pages','source_grants','source_extractions','source_clock'])old.exec(`DROP TABLE IF EXISTS ${table}`)
  old.exec('DELETE FROM schema_migrations WHERE version>3; INSERT OR IGNORE INTO schema_migrations VALUES(3,0)')
  old.prepare('INSERT INTO memory_suppressed VALUES(?)').run('forgotten')
  old.prepare('INSERT INTO memory_evidence VALUES(?,?,?,?)').run('e','s','h','{"preserve":true}')
  old.close()
  client=new MemoryLedgerClient(path);await client.open();await client.close()
  const upgraded=new DatabaseSync(path)
  assert.equal(upgraded.prepare('SELECT MAX(version) n FROM schema_migrations').get()!.n,4)
  assert.equal(upgraded.prepare('SELECT COUNT(*) n FROM memory_suppressed').get()!.n,1)
  assert.equal(upgraded.prepare('SELECT payload_json FROM memory_evidence WHERE id=?').get('e')!.payload_json,'{"preserve":true}')
  upgraded.exec('UPDATE source_clock SET revision=7');upgraded.close()
  client=new MemoryLedgerClient(path);await client.open();await client.close()
  const again=new DatabaseSync(path);assert.equal(again.prepare('SELECT revision FROM source_clock').get()!.revision,7)
  again.exec('INSERT INTO schema_migrations VALUES(999,0)');again.close()
  client=new MemoryLedgerClient(path);await assert.rejects(client.open(),{code:'STORE_SCHEMA_UNSUPPORTED'})
 }finally{await client.close();await rm(root,{recursive:true,force:true})}
})

test('source schema rejects missing uniqueness rather than silently accepting damaged tables',()=>{
 const db=new DatabaseSync(':memory:')
 try{
  initializeSourceState(db);assertSourceStateSchema(db)
  db.exec('DROP TABLE source_grants; CREATE TABLE source_grants(source_id TEXT,payload_json TEXT NOT NULL) STRICT')
  assert.throws(()=>assertSourceStateSchema(db),/SCHEMA/)
 }finally{db.close()}
})

test('object activation withdraws derived memory, reuses A, and ignores metadata-only changes',()=>{
 const db=new DatabaseSync(':memory:');initializeMemory(db)
 const run=(op:string,input:unknown)=>memoryOperation(db,op as MemoryOperation,input)
 try{
  run('source_connection',{action:'create',id:'c',namespace:'n'})
  const connected=run('source_connection',{action:'fence',id:'c',state:'connected',expected_epoch:0}) as {fence:unknown}
  const source=connectorSourceId('n',0,'message')
  const raw=(id:string)=>EvidenceRecordSchema.parse({id,source_id:source,source_kind:'mail',locator:'mail/message',observed_at:new Date().toISOString(),recorded_at:new Date().toISOString(),raw_text:id,hash:id,trust:'untrusted_external'})
  const a=raw('a'),b=raw('b')
  const page=(id:string,e:typeof a,metadata:Record<string,boolean>={})=>({fence:connected.fence,batch_id:'1',page_id:id,changes:[{object_key:'message',source_id:source,semantic_hash:e.id,metadata,evidence:[e],status:'current'}],pending_ids:[],continuation:null,checkpoint:null,complete:false})
  const first=run('source_apply_page',page('1',a)) as {revision:number;activations:{revision:number}[]}
  run('source_grant',{source_id:source,expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:'fixture',embedding_provider:null}})
  const ticket=run('extraction_ticket',{evidence_id:'a',provider:'fixture'})
  assert.ok(ticket)
  assert.equal(first.activations[0]!.revision,1)
  const candidate=CandidateSchema.parse({entry_id:'promise',kind:'fact',origin:'inferred',written_by:'merge',evidence_refs:['a'],content:{text:'promise from A'},recorded_at:new Date().toISOString()})
  run('merge',candidate)
  const independent=raw('independent');independent.source_id='user-source';independent.source_kind='user_correction';independent.trust='trusted_user'
  run('append_evidence',independent)
  run('merge',{...candidate,entry_id:'mixed',evidence_refs:['a','independent']})
  run('merge',{...candidate,entry_id:'user',origin:'stated',written_by:'user_correction',evidence_refs:['independent']})
  run('source_apply_page',page('2',b))
  assert.equal(run('retrieval_evidence',{id:'a'}),null)
  assert.equal((run('history',{entry_id:'promise'}) as EntryRevision[]).at(-1)!.op,'tombstone')
  assert.equal((run('history',{entry_id:'mixed'}) as EntryRevision[]).at(-1)!.op,'tombstone')
  assert.ok((run('list',{}) as EntryRevision[]).some(e=>e.entry_id==='user'))
  assert.throws(()=>run('merge',{...candidate,entry_id:'late'}),/NOT_FOUND/)
  assert.ok(!(run('pending_evidence',{source_prefix:'connector:'}) as {id:string}[]).some(e=>e.id==='a'))
  const back=run('source_apply_page',page('3',a)) as typeof first
  assert.deepEqual(run('commit_extraction',{ticket,candidates:[{...candidate,entry_id:'stale-ticket'}],extracted:{entries:[]}}),{applied:false})
  const fresh=run('extraction_ticket',{evidence_id:'a',provider:'fixture'})
  assert.ok(fresh)
  assert.deepEqual(run('commit_extraction',{ticket:fresh,candidates:[{...candidate,entry_id:'fresh-ticket'}],extracted:{entries:[]}}),{applied:true})
  assert.equal(run('extraction_ticket',{evidence_id:'a',provider:'fixture'}),null)
  run('source_grant',{source_id:source,expected_revision:1,grant:{revision:2,scope_revision:0,extraction_provider:'fixture',embedding_provider:'embed'}})
  const stamp=run('processing_stamp',{ids:['a'],purpose:'embedding',provider:'embed'})
  run('source_grant',{source_id:source,expected_revision:2,grant:{revision:3,scope_revision:0,extraction_provider:'fixture',embedding_provider:null}})
  run('source_grant',{source_id:source,expected_revision:3,grant:{revision:4,scope_revision:0,extraction_provider:'fixture',embedding_provider:'embed'}})
  assert.equal(run('write_vectors',{entry_prefix:'fresh-',provider:'embed',entries:[{entry_id:'fresh-ticket',revision:1,vector:[1,0],stamp}]}),0,'revoked and regranted consent cannot authorize an old embedding result')
  assert.equal(back.activations[0]!.revision,3)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM memory_evidence WHERE id=?').get('a')!.n,1)
  assert.notEqual(run('retrieval_evidence',{id:'a'}),null)
  const flags=run('source_apply_page',page('4',a,{read:true})) as typeof first
  assert.equal(flags.activations.length,0)
  const replay=run('source_apply_page',page('4',a,{read:true})) as {applied:boolean;revision:number}
  assert.equal(replay.applied,false);assert.equal(replay.revision,flags.revision)
  assert.throws(()=>run('source_apply_page',page('4',b)),/IDEMPOTENCY/)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM memory_deleted_sources').get()!.n,0)
  db.prepare('INSERT INTO memory_suppressed VALUES(?)').run('a')
  run('source_apply_page',page('5',b));run('source_apply_page',page('6',a))
  assert.equal(run('retrieval_evidence',{id:'a'}),null,'reactivation cannot defeat forgetting')
  assert.equal(run('merge',{...candidate,entry_id:'forgotten'}),null)
 }finally{db.close()}
})

test('unfinished pages and generation cleanup resume from disk without skipping bodies or deleting new data',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-page-resume-')),path=join(root,'memory.sqlite');let client=new MemoryLedgerClient(path)
 try{
  await client.open();await client.memory('source_connection',{action:'create',id:'c',namespace:'n'})
  let c=await client.memory('source_connection',{action:'fence',id:'c',state:'connected',expected_epoch:0}) as SourceConnection
  const ids=Array.from({length:200},(_,i)=>'m'+i)
  const page={fence:c.fence,batch_id:'1',page_id:'list',changes:[],pending_ids:ids,continuation:{page:'next'},checkpoint:{cursor:'done'},complete:false}
  await client.memory('source_apply_page',page)
  const changes=ids.slice(0,20).map(id=>{const source_id=connectorSourceId('n',0,id);return {object_key:id,source_id,semantic_hash:id,metadata:{},status:'current',evidence:[EvidenceRecordSchema.parse({id,source_id,source_kind:'mail',locator:id,observed_at:new Date().toISOString(),recorded_at:new Date().toISOString(),raw_text:id,hash:id,trust:'untrusted_external'})]}})
  const body={...page,page_id:'body',changes,pending_ids:ids.slice(20)}
  await client.memory('source_apply_page',body);await client.close();client=new MemoryLedgerClient(path);await client.open()
  c=await client.memory('source_connection',{action:'get',id:'c'}) as SourceConnection
  assert.equal(c.pending_ids.length,180);assert.equal(c.checkpoint,null)
  assert.equal((await client.memory('source_apply_page',body) as {applied:boolean}).applied,false)
  await assert.rejects(client.memory('source_apply_page',{...body,page_id:'bad',complete:true}))
  await assert.rejects(client.memory('source_apply_page',{...page,page_id:'skip',pending_ids:[],complete:true}),'cannot drop unread IDs to claim completion')
  await assert.rejects(client.memory('source_apply_page',{...page,batch_id:'2'}),'cannot abandon incomplete batch')
  const old=c.fence
  c=await client.memory('source_connection',{action:'delete_begin',id:'c',expected_epoch:c.fence.epoch}) as SourceConnection
  assert.equal(c.fence.generation,1);assert.deepEqual(c.deleting,[0])
  await client.close();client=new MemoryLedgerClient(path);await client.open()
  assert.equal((await client.memory('source_connection',{action:'delete_step',id:'c',limit:10}) as {remaining:boolean}).remaining,true)
  c=await client.memory('source_connection',{action:'fence',id:'c',state:'connected',expected_epoch:c.fence.epoch}) as SourceConnection
  const source_id=connectorSourceId('n',1,'m0'),change={...changes[0]!,source_id,evidence:[{...changes[0]!.evidence[0]!,id:'new-m0',source_id}]}
  await client.memory('source_apply_page',{...page,fence:c.fence,batch_id:'2',page_id:'new',changes:[change],pending_ids:[],complete:true})
  await client.memory('source_connection',{action:'delete_step',id:'c',limit:200})
  assert.notEqual(await client.memory('evidence',{id:'new-m0'}),null)
  assert.equal(await client.memory('evidence',{id:'m0'}),null)
  await assert.rejects(client.memory('source_apply_page',{...page,fence:old,page_id:'late'}))
 }finally{await client.close();await rm(root,{recursive:true,force:true})}
})

test('connection consent revocation blocks untouched object grants after an interrupted fanout',()=>{
 const db=new DatabaseSync(':memory:');initializeMemory(db)
 const run=(op:MemoryOperation,input:unknown)=>memoryOperation(db,op,input)
 try{
  run('source_connection',{action:'create',id:'c',namespace:'c'})
  const c=run('source_connection',{action:'fence',id:'c',state:'connected',expected_epoch:0}) as SourceConnection
  const source_id=connectorSourceId('c',0,'object'),grant={revision:1,scope_revision:0,extraction_provider:'fixture',embedding_provider:'embed'}
  run('source_grant',{source_id:'c',expected_revision:0,grant});run('source_grant',{source_id,expected_revision:0,grant})
  run('source_apply_page',{fence:c.fence,batch_id:'1',page_id:'page',changes:[{object_key:'object',source_id,semantic_hash:'e',metadata:{},status:'current',evidence:[EvidenceRecordSchema.parse({id:'e',source_id,source_kind:'mail',locator:'fixture',observed_at:new Date().toISOString(),recorded_at:new Date().toISOString(),raw_text:'fixture',hash:'fixture',trust:'untrusted_external'})]}],pending_ids:[],continuation:null,checkpoint:null,complete:true})
  assert.ok(run('processing_evidence',{id:'e',purpose:'extraction',provider:'fixture'}))
  run('source_grant',{source_id:'c',expected_revision:1,grant:{...grant,revision:2,extraction_provider:null,embedding_provider:null}})
  assert.equal(run('processing_evidence',{id:'e',purpose:'extraction',provider:'fixture'}),null)
  assert.equal(run('processing_evidence',{id:'e',purpose:'embedding',provider:'embed'}),null)
  assert.deepEqual(run('pending_evidence',{source_prefix:'connector:',provider:'fixture'}),[])
 }finally{db.close()}
})
