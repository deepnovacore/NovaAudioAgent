import {test} from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {initializeMemory,memoryOperation,type MemoryOperation,type EntryRevision,type EvidenceRecord} from '../src/memory-substrate/store.js'
import type {LifeState} from '../src/personal-agent/life.js'
const namespace='personal:test:life:',provider='test-provider'
function setup(){
 const db=new DatabaseSync(':memory:');initializeMemory(db)
 type Output<O>=O extends 'list'?EntryRevision[]:O extends 'daily_evidence'|'im_context'?EvidenceRecord[]:O extends 'processing_stamp'?string|null:{state:LifeState;revision:number;result:{id:string;version:number}}
 const run=<O extends MemoryOperation>(op:O,input:unknown):Output<O>=>memoryOperation(db,op,input) as Output<O>
 const add=(id='im-1',message='message',extra:Record<string,unknown>={})=>{
  const source_id='personal:test:im:'+id,now=new Date().toISOString()
  run('append_evidence',{id,source_id,source_kind:'im',locator:'im',observed_at:now,recorded_at:now,raw_text:'Please review this tomorrow',hash:id,trust:'untrusted_external',source_metadata:{account_id:'account',sender_id:'sender',recipient_id:'me',chat_id:'chat',message_id:message,mention:'direct',auto_capture:true},...extra})
  run('source_grant',{source_id,expected_revision:0,grant:{revision:1,scope_revision:1,extraction_provider:provider,embedding_provider:null}})
  return {namespace,evidence_id:id,provider,stamp:run('processing_stamp',{ids:[id],purpose:'extraction',provider}),action:{title:'Review',note:'Please review',due:null,quote:'review'}}
 }
 return {db,run,add}
}
test('IM capture stores original evidence and durable dedupe survives manual edits and receipt eviction',()=>{
 const {db,run,add}=setup();try{
 const q=add();let loaded=run('life_capture_im',q);const id=loaded.result.id
 assert.equal(loaded.state.todos[0]!.auto_recorded,true)
 let row=run('list',{}).find((r)=>r.kind==='todo')!;assert.equal(row.origin,'inferred');assert.equal(row.written_by,'merge');assert.deepEqual(row.evidence_refs,['im-1'])
 loaded=run('life_mutate',{namespace,requestId:'edit',expectedRevision:loaded.revision,input:{op:'update',kind:'todo',id,expected_version:1,title:'Human title',status:'done'}})
 for(let n=0;n<257;n++)loaded=run('life_mutate',{namespace,requestId:'profile'+n,expectedRevision:loaded.revision,input:{op:'profile',expected_version:n,about:String(n)}})
 loaded=run('life_capture_im',q);assert.equal(loaded.state.todos.length,1);assert.equal(loaded.state.todos[0]!.title,'Human title');assert.equal(loaded.state.todos[0]!.status,'done')
 loaded=run('life_capture_im',add('im-2'));assert.equal(loaded.state.todos[0]!.source_changed,true);assert.equal(loaded.state.todos[0]!.status,'done')
 row=run('list',{}).find((r)=>r.kind==='todo')!;assert.equal(row.written_by,'user_correction');assert.ok(row.evidence_refs.includes('im-1'))
 }finally{db.close()}
})
test('IM capture validates scope, stamps, retention and quote; null outcome remains deduped',()=>{
 const {db,run,add}=setup();try{
 const q=add();assert.throws(()=>run('life_capture_im',{...q,namespace:'personal:other:life:'}));assert.throws(()=>run('life_capture_im',{...q,stamp:'bad'}));assert.throws(()=>run('life_capture_im',{...q,action:{...q.action,quote:'not present'}}))
 const expired=add('expired','other',{retention_until:'2020-01-01T00:00:00.000Z'});assert.throws(()=>run('life_capture_im',{...expired,stamp:'old'}))
 assert.equal(run('life_capture_im',{...q,action:null}).result,null);assert.equal(run('life_capture_im',q).result,null)
 assert.equal(run('life_load',{namespace}).state.todos.length,0)
 }finally{db.close()}
})
test('IM target links atomically without rewriting an existing human Todo; stale targets fail',()=>{
 const {db,run,add}=setup();try{
 const q=add();let loaded=run('life_capture_im',q)
 const row=run('list',{}).find((r)=>r.kind==='todo')!
 const next=add('another','another-message'),target={entry_id:row.entry_id,revision:row.revision,stamp:run('processing_stamp',{ids:row.evidence_refs,purpose:'extraction',provider})}
 assert.throws(()=>run('life_capture_im',{...next,target:{...target,revision:99}}))
 loaded=run('life_capture_im',{...next,action:{...next.action,title:'Different request'},target})
 assert.equal(loaded.state.todos.length,1);assert.equal(loaded.state.todos[0]!.title,'Review');assert.deepEqual(loaded.state.todos[0]!.provenance_refs,['im-1','another'])
 const count=db.prepare('SELECT COUNT(*) n FROM memory_life_im_receipts').get()!.n;assert.equal(count,2)
 }finally{db.close()}
})
test('conversion retains original provenance evidence, and daily evidence respects provider and namespace',()=>{
 const {db,run,add}=setup();try{
 add();run('life_load',{namespace,legacy:{todos:[],ideas:[],goals:[],profile:{about:'',version:0},receipts:{}}})
 const now=new Date().toISOString(),data={id:'idea',title:'Review',note:'',status:'active',goal_id:null,version:1,created_at:now,updated_at:now,provenance_refs:['im-1']}
 run('merge',{entry_id:namespace+'idea:idea',kind:'idea',origin:'inferred',written_by:'merge',evidence_refs:['im-1'],content:{life_data:data,text:'Review',life_id:'idea'},recorded_at:now})
 let loaded=run('life_load',{namespace});loaded=run('life_mutate',{namespace,expectedRevision:loaded.revision,requestId:'convert',input:{op:'convert',id:'idea',target:'todo',expected_version:1}})
 assert.deepEqual(loaded.state.todos[0]!.provenance_refs,['im-1']);assert.ok(run('list',{}).find((row)=>row.kind==='todo')!.evidence_refs.includes('im-1'))
 assert.equal(run('daily_evidence',{source_prefix:'personal:test:',provider}).length,1)
 assert.equal(run('daily_evidence',{source_prefix:'personal:other:',provider}).length,0)
 assert.equal(run('daily_evidence',{source_prefix:'personal:test:',provider:'other'}).length,0)
 }finally{db.close()}
})
test('IM context is bounded to current authorized account/chat and excludes future and expired records',()=>{
 const {db,run,add}=setup();try{
 const metadata={account_id:'account',sender_id:'sender',recipient_id:'me',chat_id:'chat',message_id:'context',mention:'none',auto_capture:true}
 for(let n=0;n<15;n++)add('context'+n,'context'+n,{observed_at:new Date(Date.now()-100_000+n*1000).toISOString()})
 add('foreign','foreign',{source_metadata:{...metadata,account_id:'foreign'}})
 add('other-chat','other-chat',{source_metadata:{...metadata,chat_id:'other'}})
 add('future','future',{observed_at:'2099-01-01T00:00:00.000Z'})
 add('expired','expired',{retention_until:'2020-01-01T00:00:00.000Z'})
 const query={source_prefix:'personal:test:',provider,account_id:'account',chat_id:'chat'}
 const context=run('im_context',query)
 assert.equal(context.length,12);assert.equal(context[0]!.id,'context14');assert.equal(context[11]!.id,'context3')
 assert.equal(run('im_context',{...query,provider:'wrong'}).length,0)
 assert.equal(run('im_context',{...query,source_prefix:'personal:other:'}).length,0)
 assert.equal(run('im_context',{...query,account_id:'missing'}).length,0)
 }finally{db.close()}
})
test('IM capture fences revoked, changed and foreign model context before writing any receipt',()=>{
 const {db,run,add}=setup();try{
 const q=add(),background=add('background','background'),context=[{evidence_id:background.evidence_id,stamp:background.stamp}]
 assert.throws(()=>run('life_capture_im',{...q,context:[{...context[0],stamp:'stale'}]}))
 const foreign=add('foreign','foreign',{source_metadata:{account_id:'foreign',sender_id:'sender',recipient_id:'me',chat_id:'chat',message_id:'foreign',mention:'none'}})
 assert.throws(()=>run('life_capture_im',{...q,context:[{evidence_id:foreign.evidence_id,stamp:foreign.stamp}]}))
 run('source_grant',{source_id:'personal:test:im:background',expected_revision:1,grant:{revision:2,scope_revision:1,extraction_provider:null,embedding_provider:null}})
 assert.throws(()=>run('life_capture_im',{...q,context}),/STORE_STALE_REVISION/)
 assert.equal(db.prepare('SELECT COUNT(*) n FROM memory_life_im_receipts').get()!.n,0)
 assert.equal(run('list',{}).length,0)
 const valid=add('valid','valid');assert.equal(run('life_capture_im',{...q,context:[{evidence_id:valid.evidence_id,stamp:valid.stamp}]}).state.todos.length,1)
 }finally{db.close()}
})
test('daily evidence omits processed null and matched mentions across changed evidence IDs',()=>{
 const {db,run,add}=setup();try{
 const query={source_prefix:'personal:test:',provider},noop=add('noop','noop')
 run('life_capture_im',{...noop,action:null});add('noop-edited','noop')
 assert.deepEqual(run('daily_evidence',query),[])
 const original=add('todo','todo');run('life_capture_im',original)
 const row=run('list',{}).find(r=>r.kind==='todo')!,followup=add('followup','followup')
 run('life_capture_im',{...followup,target:{entry_id:row.entry_id,revision:row.revision,stamp:run('processing_stamp',{ids:row.evidence_refs,purpose:'extraction',provider})}})
 add('followup-edited','followup');add('todo-edited','todo');add('pending','pending')
 assert.deepEqual(run('daily_evidence',query).map(record=>record.id),['pending'])
 }finally{db.close()}
})
