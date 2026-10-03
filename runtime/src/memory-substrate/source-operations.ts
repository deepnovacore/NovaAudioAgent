import {resolutionContextSchema} from './resolution.js'
import {syncStatusSchema} from './source-state.js'
import {z} from 'zod'
import type {LedgerDatabase} from '../memory-ledger/store.js'
import {canonicalJson} from '../text/canonical-json.js'
import {EvidenceRecordSchema,CandidateSchema,EntryRevisionSchema,processingStamp,type MemoryOperation} from './store.js'
import {connectionSchema,readConnection,sourceObjectSchema,sourceIdSchema,revisionSchema,fenceSchema,connectorSourceId,sha256,readProcessingGrant,processingGrantSchema,extractionTicketSchema,sourceObjectFor,type ExtractionTicket,type SourceConnection,type Activation} from './source-state.js'

type Run=(operation:MemoryOperation,input:unknown)=>unknown
const changeSchema=z.object({object_key:sourceIdSchema,source_id:sourceIdSchema,semantic_hash:sourceIdSchema,metadata:z.record(z.string(),z.json()),evidence:z.array(z.lazy(()=>EvidenceRecordSchema)).max(256),status:z.enum(['current','coverage_removed','provider_deleted'])}).strict()
export const applyPageSchema=z.object({fence:fenceSchema,batch_id:z.string().regex(/^[1-9][0-9]{0,14}$/u),page_id:sourceIdSchema,changes:z.array(changeSchema).max(200),pending_ids:z.array(sourceIdSchema).max(200),continuation:z.json(),checkpoint:z.json(),complete:z.boolean()}).strict()
export type ApplyPage=z.infer<typeof applyPageSchema>
export interface PageResult {revision:number;applied:boolean;activations:Activation[]}
export function sourceRevision(db:LedgerDatabase):number{return Number(db.prepare('SELECT revision FROM source_clock WHERE id=1').get()!.revision)}
export function advanceSourceRevision(db:LedgerDatabase):number{db.exec('UPDATE source_clock SET revision=revision+1 WHERE id=1');return sourceRevision(db)}
function save(db:LedgerDatabase,c:SourceConnection):void{db.prepare('INSERT INTO source_connections VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json').run(c.fence.connection_id,canonicalJson(connectionSchema.parse(c)))}
function withdrawObjects(db:LedgerDatabase,c:SourceConnection,run:Run,generation=c.fence.generation):void{
 let after=''
 for(;;){
  const rows=db.prepare('SELECT payload_json FROM source_objects WHERE connection_id=? AND generation=? AND object_key>? ORDER BY object_key LIMIT 200').all(c.fence.connection_id,generation,after)
  for(const row of rows){const object=sourceObjectSchema.parse(JSON.parse(String(row.payload_json)));after=object.object_key
   const ids=object.current_evidence_ids;object.current_evidence_ids=[];object.status='coverage_removed';object.activation_revision++
   db.prepare('UPDATE source_objects SET payload_json=? WHERE connection_id=? AND generation=? AND object_key=?').run(canonicalJson(object),object.connection_id,object.generation,object.object_key)
   run('invalidate_evidence',{ids})
  }
  if(rows.length<200)break
 }
}
export function sourceOperation(db:LedgerDatabase,operation:string,input:unknown,run:Run):unknown{
 const v=z.record(z.string(),z.unknown()).parse(input)
 if(operation==='source_events'){
  const q=z.object({prefix:sourceIdSchema,provider:sourceIdSchema,after:revisionSchema.optional(),ack:z.object({revision:revisionSchema,phase:z.enum(['invalidated','ready'])}).strict().optional()}).strict().parse(v)
  const rows=q.ack?db.prepare("SELECT connection_id,batch_id,page_id,result_json FROM source_pages WHERE substr(connection_id,1,length(?))=? AND json_extract(result_json,'$.revision')=?").all(q.prefix,q.prefix,q.ack.revision):db.prepare("SELECT connection_id,batch_id,page_id,result_json FROM source_pages WHERE substr(connection_id,1,length(?))=? AND coalesce(json_extract(result_json,'$.ready'),0)=0 AND json_extract(result_json,'$.revision')>? ORDER BY json_extract(result_json,'$.revision') LIMIT 200").all(q.prefix,q.prefix,q.after??0)
  const events:{revision:number;phase:'invalidated'|'ready'}[]=[]
  for(const row of rows){
   const r=JSON.parse(String(row.result_json)) as PageResult&{fence:ApplyPage['fence'];invalidated?:boolean;ready?:boolean}
   if(q.ack){if(r.revision===q.ack.revision){r[q.ack.phase]=true;db.prepare('UPDATE source_pages SET result_json=? WHERE connection_id=? AND batch_id=? AND page_id=?').run(canonicalJson(r),String(row.connection_id),String(row.batch_id),String(row.page_id))}continue}
   if(!r.invalidated){events.push({revision:r.revision,phase:'invalidated'});continue}
   if(r.ready)continue
   let ready=true
   for(const activation of r.activations){
    const objectRow=db.prepare('SELECT payload_json FROM source_objects WHERE connection_id=? AND generation=? AND object_key=?').get(String(row.connection_id),r.fence.generation,activation.object_key)
    if(!objectRow)continue
    const object=sourceObjectSchema.parse(JSON.parse(String(objectRow.payload_json)))
    if(object.activation_revision!==activation.revision)continue
    for(const id of object.current_evidence_ids)if(!run('processing_evidence',{id,purpose:'extraction',provider:q.provider})||sourceOperation(db,'extraction_ticket',{evidence_id:id,provider:q.provider},run)!==null){ready=false;break}
    if(!ready)break
   }
   if(ready)events.push({revision:r.revision,phase:'ready'})
  }
  return {events:events.sort((a,b)=>a.revision-b.revision),next:rows.length===200?(JSON.parse(String(rows.at(-1)!.result_json)) as PageResult).revision:null}
 }
 if(operation==='extraction_ticket'){
  const q=z.object({evidence_id:z.string().min(1).max(512),provider:sourceIdSchema,force:z.boolean().optional()}).strict().parse(v)
  const raw=run('processing_evidence',{id:q.evidence_id,purpose:'extraction',provider:q.provider});if(!raw)return null
  const e=EvidenceRecordSchema.parse(raw);if(!e.raw_text||e.source_kind==='user_correction')return null
  const object=sourceObjectFor(db,e.source_id),grant=readProcessingGrant(db,e.source_id)!
  const ticket:ExtractionTicket={evidence_id:e.id,activation:object?{object_key:object.object_key,revision:object.activation_revision}:null,consent_revision:grant.revision,extraction_provider:q.provider,fence:object?readConnection(db,object.connection_id)!.fence:null}
  if(!q.force&&(db.prepare('SELECT 1 FROM source_extractions WHERE ticket_key=?').get(sha256(canonicalJson(ticket)))||(!object&&db.prepare('SELECT 1 FROM memory_extractions WHERE evidence_id=? LIMIT 1').get(e.id))))return null
  return ticket
 }
 if(operation==='commit_extraction'){
  const q=z.object({ticket:extractionTicketSchema,candidates:z.array(CandidateSchema).max(9),contexts:z.array(resolutionContextSchema).max(20).default([]),extracted:z.record(z.string(),z.json())}).strict().parse(v)
  const current=sourceOperation(db,'extraction_ticket',{evidence_id:q.ticket.evidence_id,provider:q.ticket.extraction_provider,force:true},run)
  if(!current||canonicalJson(current)!==canonicalJson(q.ticket))return {applied:false}
  for(const context of q.contexts){
   const row=db.prepare('SELECT payload_json FROM memory_revisions WHERE entry_id=? ORDER BY revision DESC LIMIT 1').get(context.entry_id)
   if(!row)throw Error('STORE_STALE_REVISION')
   const entry=EntryRevisionSchema.parse(JSON.parse(String(row.payload_json)))
   if(entry.revision!==context.revision||entry.op==='tombstone'||(entry.valid_until!==null&&Date.parse(entry.valid_until)<=Date.now()))throw Error('STORE_STALE_REVISION')
   if(processingStamp(db,entry.evidence_refs,'extraction',q.ticket.extraction_provider)!==context.stamp)return {applied:false}
  }
  for(const candidate of q.candidates){
   if(!candidate.evidence_refs.includes(q.ticket.evidence_id))throw Error('STORE_INVALID_OPERATION')
   for(const id of candidate.evidence_refs)if(!run('processing_evidence',{id,purpose:'extraction',provider:q.ticket.extraction_provider}))return {applied:false}
  }
  for(const candidate of q.candidates)run('merge',candidate)
  // The ticket and all candidates share the enclosing worker transaction.
  const key=sha256(canonicalJson(q.ticket))
  run('record_extraction',{evidence_id:q.ticket.evidence_id,attempt_id:key,extracted:q.extracted})
  db.prepare('INSERT OR IGNORE INTO source_extractions VALUES(?,?)').run(key,canonicalJson({ticket:q.ticket}))
  return {applied:true}
 }
 if(operation==='source_revision')return sourceRevision(db)
 if(operation==='source_grant'){
  const q=z.object({source_id:z.string().min(1).max(512),action:z.literal('get').optional(),expected_revision:revisionSchema.optional(),grant:processingGrantSchema.optional()}).strict().parse(v)
  const old=readProcessingGrant(db,q.source_id)
  if(q.action==='get')return old
  if(!q.grant||q.expected_revision!==(old?.revision??0)||q.grant.revision<=q.expected_revision)throw Error('STORE_STALE_REVISION')
  db.prepare('INSERT INTO source_grants VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET payload_json=excluded.payload_json').run(q.source_id,canonicalJson(q.grant))
  db.prepare("DELETE FROM memory_extractions WHERE attempt_id<>'knowledge-index' AND evidence_id IN (SELECT id FROM memory_evidence WHERE source_id=?)").run(q.source_id)
  db.prepare("DELETE FROM memory_vectors WHERE entry_id IN (SELECT r.entry_id FROM memory_revisions r,json_each(r.payload_json,'$.evidence_refs') refs JOIN memory_evidence e ON e.id=refs.value WHERE e.source_id=?)").run(q.source_id)
  return q.grant
 }
 if(operation==='source_connection'){
  if(v.action==='list'){
   const q=z.object({action:z.literal('list'),prefix:sourceIdSchema,after:sourceIdSchema.nullable().optional(),limit:z.number().int().min(1).max(100).default(100)}).strict().parse(v)
   const rows=db.prepare('SELECT payload_json FROM source_connections WHERE substr(id,1,length(?))=? AND id>? ORDER BY id LIMIT ?').all(q.prefix,q.prefix,q.after??'',q.limit+1)
   const connections=rows.slice(0,q.limit).map(row=>connectionSchema.parse(JSON.parse(String(row.payload_json))))
   return {connections,next:rows.length>q.limit?connections.at(-1)!.fence.connection_id:null}
  }
  const id=sourceIdSchema.parse(v.id),c=readConnection(db,id)
  if(v.action==='get')return c
  if(v.action==='create'){
   const q=z.object({action:z.literal('create'),id:sourceIdSchema,namespace:sourceIdSchema}).strict().parse(v)
   if(c){if(c.namespace!==q.namespace)throw Error('STORE_IDEMPOTENCY_CONFLICT');return c}
   const fresh:SourceConnection={fence:{connection_id:id,generation:0,epoch:0,scope_revision:0},namespace:q.namespace,state:'paused',scope:null,checkpoint:null,continuation:null,pending_ids:[],batch:0,completed_batch:0,deleting:[]}
   save(db,fresh);return fresh
  }
  if(!c)throw Error('STORE_NOT_FOUND')
  if(v.action==='sync_status'){
   const q=z.object({action:z.literal('sync_status'),id:sourceIdSchema,expected_epoch:revisionSchema,status:syncStatusSchema}).strict().parse(v)
   if(q.expected_epoch!==c.fence.epoch)throw Error('STORE_STALE_REVISION')
   c.sync_status=q.status;save(db,c);return c
  }
  if(v.action==='reset_sync'){
   const q=z.object({action:z.literal('reset_sync'),id:sourceIdSchema,expected_epoch:revisionSchema}).strict().parse(v)
   if(q.expected_epoch!==c.fence.epoch)throw Error('STORE_STALE_REVISION')
   c.fence.epoch++;c.pending_ids=[];c.continuation=null;c.checkpoint=null;c.completed_batch=c.batch
   save(db,c);return c
  }
  if(v.action==='scope'){
   const q=z.object({action:z.literal('scope'),id:sourceIdSchema,expected_scope_revision:revisionSchema,scope:z.json()}).strict().parse(v)
   if(q.expected_scope_revision!==c.fence.scope_revision)throw Error('STORE_STALE_REVISION')
   c.scope=q.scope;c.fence.scope_revision++;c.fence.epoch++;c.pending_ids=[];c.continuation=null;c.checkpoint=null;c.completed_batch=c.batch
   save(db,c);withdrawObjects(db,c,run);advanceSourceRevision(db);return c
  }
  if(v.action==='delete_begin'){
   const q=z.object({action:z.literal('delete_begin'),id:sourceIdSchema,expected_epoch:revisionSchema}).strict().parse(v)
   if(q.expected_epoch!==c.fence.epoch)throw Error('STORE_STALE_REVISION')
   c.deleting.push(c.fence.generation);c.fence.generation++;c.fence.epoch++;c.state='paused';c.pending_ids=[];c.continuation=null;c.checkpoint=null;c.completed_batch=c.batch
   save(db,c);withdrawObjects(db,c,run,c.fence.generation-1);advanceSourceRevision(db);return c
  }
  if(v.action==='delete_step'){
   const q=z.object({action:z.literal('delete_step'),id:sourceIdSchema,limit:z.number().int().min(1).max(200).default(200)}).strict().parse(v)
   const generation=c.deleting[0];if(generation===undefined)return {remaining:false}
   if(generation>=c.fence.generation)throw Error('STORE_INVALID_OPERATION')
   const rows=db.prepare('SELECT payload_json FROM source_objects WHERE connection_id=? AND generation=? ORDER BY object_key LIMIT ?').all(q.id,generation,q.limit)
   for(const row of rows){const object=sourceObjectSchema.parse(JSON.parse(String(row.payload_json)))
    run('delete_source',{source_id:object.source_id});db.prepare('DELETE FROM source_grants WHERE source_id=?').run(object.source_id)
    db.prepare('DELETE FROM source_objects WHERE connection_id=? AND generation=? AND object_key=?').run(q.id,generation,object.object_key)
   }
   if(!db.prepare('SELECT 1 FROM source_objects WHERE connection_id=? AND generation=? LIMIT 1').get(q.id,generation))c.deleting.shift()
   save(db,c);return {remaining:c.deleting.length>0}
  }
  if(v.action==='fence'){
   const q=z.object({action:z.literal('fence'),id:sourceIdSchema,state:z.enum(['connected','paused','disconnected']),expected_epoch:revisionSchema}).strict().parse(v)
   if(q.expected_epoch!==c.fence.epoch)throw Error('STORE_STALE_REVISION')
   c.fence.epoch++;c.state=q.state;save(db,c);return c
  }
  throw Error('STORE_INVALID_OPERATION')
 }
 if(operation==='source_pending'){
  const q=z.object({id:sourceIdSchema,after:sourceIdSchema.optional(),object_key:sourceIdSchema.optional(),limit:z.number().int().min(1).max(200).default(200)}).strict().parse(v)
  const c=readConnection(db,q.id);if(!c)throw Error('STORE_NOT_FOUND')
  const objects=db.prepare('SELECT payload_json FROM source_objects WHERE connection_id=? AND generation=? AND object_key>? ORDER BY object_key LIMIT ?').all(q.id,c.fence.generation,q.after??'',q.limit+1).map(row=>sourceObjectSchema.parse(JSON.parse(String(row.payload_json))))
  return {connection:c,objects:objects.slice(0,q.limit).filter(o=>!q.object_key||o.object_key===q.object_key),next:objects.length>q.limit?objects[q.limit-1]!.object_key:null}
 }
 if(operation==='source_apply_page'){
  if(Buffer.byteLength(JSON.stringify(v))>5*1024*1024)throw Error('STORE_INVALID_OPERATION')
  const q=applyPageSchema.parse(v),c=readConnection(db,q.fence.connection_id)
  if(c?.state!=='connected'||canonicalJson(c.fence)!==canonicalJson(q.fence))throw Error('STORE_STALE_REVISION')
  const hash=sha256(canonicalJson(q))
  const receipt=db.prepare('SELECT payload_hash,result_json FROM source_pages WHERE connection_id=? AND batch_id=? AND page_id=?').get(q.fence.connection_id,q.batch_id,q.page_id)
  if(receipt){if(receipt.payload_hash!==hash)throw Error('STORE_IDEMPOTENCY_CONFLICT');return {...JSON.parse(String(receipt.result_json)) as PageResult,applied:false}}
  const batch=Number(q.batch_id)
  if(batch<c.batch||batch<=c.completed_batch||(batch>c.batch&&c.batch!==c.completed_batch))throw Error('STORE_STALE_REVISION')
  if(q.complete&&q.pending_ids.length)throw Error('STORE_INVALID_OPERATION')
  const appliedKeys=new Set(q.changes.map(change=>change.object_key))
  if(c.pending_ids.some(id=>!q.pending_ids.includes(id)&&!appliedKeys.has(id)))throw Error('STORE_INVALID_OPERATION')
  const activations:Activation[]=[]
  const seen=new Set<string>()
  for(const change of q.changes){
   if(seen.has(change.object_key))throw Error('STORE_INVALID_OPERATION');seen.add(change.object_key)
   if(change.source_id!==connectorSourceId(c.namespace,c.fence.generation,change.object_key)||change.evidence.some(e=>e.source_id!==change.source_id)||((change.status==='current')!==(change.evidence.length>0)))throw Error('STORE_INVALID_OPERATION')
   const oldRow=db.prepare('SELECT payload_json FROM source_objects WHERE connection_id=? AND generation=? AND object_key=?').get(q.fence.connection_id,q.fence.generation,change.object_key)
   const old=oldRow?sourceObjectSchema.parse(JSON.parse(String(oldRow.payload_json))):null
   const changed=old?.semantic_hash!==change.semantic_hash||old.status!==change.status
   // Metadata-only updates must not replace the content-addressed current set.
   if(!changed&&canonicalJson(old.current_evidence_ids)!==canonicalJson(change.evidence.map(e=>e.id)))throw Error('STORE_IDEMPOTENCY_CONFLICT')
   for(const evidence of change.evidence)run('append_evidence',evidence)
   const next=sourceObjectSchema.parse({connection_id:q.fence.connection_id,generation:q.fence.generation,object_key:change.object_key,source_id:change.source_id,semantic_hash:change.semantic_hash,metadata:change.metadata,current_evidence_ids:change.evidence.map(e=>e.id),activation_revision:(old?.activation_revision??0)+Number(changed),status:change.status,observed_at:new Date().toISOString()})
   db.prepare('INSERT INTO source_objects VALUES(?,?,?,?) ON CONFLICT(connection_id,generation,object_key) DO UPDATE SET payload_json=excluded.payload_json').run(next.connection_id,next.generation,next.object_key,canonicalJson(next))
   if(changed){
    activations.push({object_key:next.object_key,revision:next.activation_revision})
    run('invalidate_evidence',{ids:old?.current_evidence_ids??[]})
    for(const id of next.current_evidence_ids)db.prepare('DELETE FROM memory_extractions WHERE evidence_id=?').run(id)
   }
  }
  c.pending_ids=q.pending_ids;c.continuation=q.continuation;c.batch=Number(q.batch_id)
  if(q.complete){c.checkpoint=q.checkpoint;c.completed_batch=c.batch}
  save(db,c)
  const result:PageResult={revision:advanceSourceRevision(db),applied:true,activations}
  db.prepare('INSERT INTO source_pages VALUES(?,?,?,?,?)').run(q.fence.connection_id,q.batch_id,q.page_id,hash,canonicalJson({...result,fence:q.fence}))
  if(q.complete)db.prepare("DELETE FROM source_pages WHERE connection_id=? AND CAST(batch_id AS INTEGER)<? AND json_extract(result_json,'$.ready')=1").run(q.fence.connection_id,c.completed_batch-1)
  return result
 }
 throw Error('STORE_INVALID_OPERATION')
}
