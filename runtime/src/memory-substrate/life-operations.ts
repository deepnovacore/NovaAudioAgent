import {queueMemoryFiles} from './file-authority.js'
import {createHash} from 'node:crypto'
import {z} from 'zod'
import type {LedgerDatabase} from '../memory-ledger/store.js'
import {canonicalJson} from '../text/canonical-json.js'
import {applyLifeMutation,emptyLifeState,lifeInputSchema,lifeStateSchema,type LifeState} from '../personal-agent/life.js'
import {assertAcceptable,decisionSchema,sourceSchema,validateCandidate,type EvaluatedCandidate} from '../understanding/candidates.js'
import {CandidateSchema,EntryRevisionSchema,EvidenceRecordSchema,type EntryRevision,type MemoryOperation} from './store.js'
import {lifeResolutionSchema,validateResolution,type LifeResolution} from './resolution.js'
import {processingGrantSchema,type ProcessingGrant} from './source-state.js'

type Run=(operation:MemoryOperation,input:unknown)=>unknown
const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
const namespaceSchema=z.string().min(1).max(256).endsWith(':life:')
const metaSchema=z.object({revision:z.number().int().nonnegative(),receipts:lifeStateSchema.shape.receipts,signature:z.string(),migrated:z.literal(true),profile_version:z.number().int().nonnegative().optional(),legacy_path:z.string().min(1).max(4096).optional()})
type Meta=z.infer<typeof metaSchema>
const provenanceSchema=z.object({type:z.enum(['accepted_candidate','explicit_candidate']),row:z.object({source:sourceSchema,candidate:z.unknown(),decision:decisionSchema,status:z.enum(['proposed','withheld']),reasons:z.array(z.string())}),resolution:lifeResolutionSchema.optional()}).strict()
interface LifeObject {kind:'todo'|'idea'|'goal'|'profile';id:string;data:Record<string,unknown>}

/** Operation receipts, aggregate CAS, Profile version watermark and completed migration marker. */
export function initializeLife(db:LedgerDatabase):void{
 db.exec('CREATE TABLE IF NOT EXISTS memory_life_im_receipts(namespace TEXT NOT NULL,message_key TEXT NOT NULL,evidence_id TEXT NOT NULL,entry_id TEXT,PRIMARY KEY(namespace,message_key))')
 db.exec('CREATE TABLE IF NOT EXISTS memory_life_meta(namespace TEXT PRIMARY KEY,payload_json TEXT NOT NULL)')
}
function readMeta(db:LedgerDatabase,namespace:string):Meta|null{
 const row=db.prepare('SELECT payload_json FROM memory_life_meta WHERE namespace=?').get(namespace)
 return row?metaSchema.parse(JSON.parse(String(row.payload_json))):null
}
function saveMeta(db:LedgerDatabase,namespace:string,meta:Meta):void{
 db.prepare('INSERT OR REPLACE INTO memory_life_meta(namespace,payload_json) VALUES(?,?)').run(namespace,canonicalJson(meta))
}
function rows(run:Run,namespace:string):EntryRevision[]{return z.array(EntryRevisionSchema).parse(run('list',{include_history:true})).filter(row=>row.entry_id.startsWith(namespace)&&['todo','idea','goal','profile'].includes(row.kind))}
const signature=(entries:EntryRevision[])=>hash(canonicalJson(entries))
/** Keep the editable Markdown body and the typed domain object in one revision. */
export function normalizeLifeContent(kind:string,content:Record<string,unknown>,previousContent?:Record<string,unknown>):Record<string,unknown>{
 if(!['todo','idea','goal','profile'].includes(kind)||!Object.hasOwn(content,'life_data'))return content
 const schema=kind==='profile'?lifeStateSchema.shape.profile:kind==='todo'?lifeStateSchema.shape.todos.element:kind==='idea'?lifeStateSchema.shape.ideas.element:lifeStateSchema.shape.goals.element
 const data=schema.parse(content.life_data),text=z.string().parse(content.text)
 const represented='about'in data?data.about:[data.title,data.note].filter(Boolean).join('\n')
 if(text===represented)return {...content,life_data:data}
 const previous=previousContent?.life_data===undefined?data:schema.parse(previousContent.life_data)
 const version=Math.max(data.version,previous.version+1)
 const newline=text.indexOf('\n')
 const patched=kind==='profile'?{...data,about:text,version}:{...data,title:newline<0?text:text.slice(0,newline),note:newline<0?'':text.slice(newline+1),version}
 // Validation fails atomically rather than silently truncating a hand-edited document.
 const parsed=schema.parse(patched)
 return {...content,life_data:parsed,text:'about'in parsed?parsed.about:[parsed.title,parsed.note].filter(Boolean).join('\n')}
}
function stateFrom(entries:EntryRevision[],receipts:LifeState['receipts']):LifeState{
 const state=emptyLifeState();state.receipts=receipts
 for(const row of [...entries].sort((a,b)=>Number(a.content.life_order??0)-Number(b.content.life_order??0))){
  if(row.op==='tombstone')continue
  const data=normalizeLifeContent(row.kind,row.content).life_data
  if(row.kind==='profile')state.profile=lifeStateSchema.shape.profile.parse(data)
  else if(row.kind==='todo')state.todos.push(lifeStateSchema.shape.todos.element.parse(data))
  else if(row.kind==='idea')state.ideas.push(lifeStateSchema.shape.ideas.element.parse(data))
  else if(row.kind==='goal')state.goals.push(lifeStateSchema.shape.goals.element.parse(data))
 }
 return lifeStateSchema.parse(state)
}
function objects(state:LifeState):LifeObject[]{return [
 ...state.todos.map(data=>({kind:'todo' as const,id:data.id,data})),
 ...state.ideas.map(data=>({kind:'idea' as const,id:data.id,data})),
 ...state.goals.map(data=>({kind:'goal' as const,id:data.id,data})),
 {kind:'profile',id:'profile',data:state.profile},
]}
const entryId=(namespace:string,object:LifeObject)=>namespace+object.kind+':'+object.id
function persist(run:Run,namespace:string,before:EntryRevision[],state:LifeState,evidenceId:string,now:string,legacy=false,processingGrant?:ProcessingGrant):void{
 const profile=before.find(row=>row.kind==='profile'&&row.op!=='tombstone')
 const storageId=(item:LifeObject)=>item.kind==='profile'?(profile?.entry_id??(legacy?entryId(namespace,item):namespace+'profile:'+hash(evidenceId))):entryId(namespace,item)
 const current=new Map(before.map(row=>[row.entry_id,row])),next=objects(state).filter(item=>item.kind!=='profile'||profile!==undefined||item.data.about!==''||item.data.version!==0),ids=new Set(next.map(storageId))
 const nextOrder=new Map<string,number>()
 for(const row of before)nextOrder.set(row.kind,Math.max(nextOrder.get(row.kind)??0,Number(row.content.life_order??-1)+1))
 for(const item of next){
  const id=storageId(item),old=current.get(id)
  if(old?.op!=='tombstone'&&canonicalJson(old?.content.life_data??null)===canonicalJson(item.data))continue
  const text=item.kind==='profile'?String(item.data.about):[item.data.title,item.data.note].filter(Boolean).join('\n')
  const objectEvidenceId=legacy?evidenceId+':'+hash(id):evidenceId
  if(legacy)run('append_evidence',EvidenceRecordSchema.parse({id:objectEvidenceId,source_id:namespace+'migration:'+hash(id),source_kind:'task_result',locator:'legacy-life-json:'+item.kind,observed_at:now,recorded_at:now,raw_text:null,hash:hash(canonicalJson({entry_id:id,legacy:item.data})),trust:'trusted_system',extracted:{event:'legacy_import',legacy:true,original_evidence_available:false}}))
  if(legacy&&processingGrant)run('source_grant',{source_id:namespace+'migration:'+hash(id),expected_revision:0,grant:processingGrant})
  const order=typeof old?.content.life_order==='number'?old.content.life_order:nextOrder.get(item.kind)??0;nextOrder.set(item.kind,Math.max(nextOrder.get(item.kind)??0,order+1))
  run('merge',CandidateSchema.parse({entry_id:id,expected_revision:old?.revision??0,kind:item.kind,origin:legacy?'inferred':'stated',written_by:legacy?'merge':'user_correction',evidence_refs:[...new Set([objectEvidenceId,...(Array.isArray(item.data.provenance_refs)?item.data.provenance_refs.filter((ref):ref is string=>typeof ref==='string'&&run('retrieval_evidence',{id:ref})!==null):[])])],content:{life_id:item.id,life_data:item.data,life_order:order,text,...(item.kind==='profile'?{section:'explicit'}:{}),legacy},recorded_at:now}))
 }
 for(const old of before)if(old.op!=='tombstone'&&!ids.has(old.entry_id))run('merge',CandidateSchema.parse({entry_id:old.entry_id,expected_revision:old.revision,kind:old.kind,origin:'stated',written_by:'user_correction',evidence_refs:[evidenceId],content:{life_id:old.content.life_id,reason:'undo_create'},op:'tombstone',recorded_at:now}))
}

/** Called inside the worker transaction for add, update and NOOP, including unselected old entries. */
function checkResolution(run:Run,namespace:string,resolution:LifeResolution):EntryRevision[]{
 const all=rows(run,namespace),selected:EntryRevision[]=[]
 for(const context of resolution.contexts){
  const entry=all.find(row=>row.entry_id===context.entry_id)
  if(entry?.revision!==context.revision||entry.op==='tombstone'||(entry.valid_until!==null&&Date.parse(entry.valid_until)<=Date.now()))throw Error('STORE_STALE_REVISION')
  if(run('processing_stamp',{ids:entry.evidence_refs,purpose:'extraction',provider:resolution.provider})!==context.stamp)throw Error('STORE_STALE_REVISION')
  selected.push(entry)
 }
 return selected
}

/** The caller's enclosing memory worker transaction owns evidence, merge and receipts atomically. */
export function lifeOperation(db:LedgerDatabase,operation:'life_load'|'life_mutate'|'life_capture_im',value:unknown,run:Run):unknown{
 if(operation==='life_capture_im')return captureIm(db,value,run)
 if(operation==='life_load'){
  const q=z.object({namespace:namespaceSchema,legacy:lifeStateSchema.optional(),processingGrant:processingGrantSchema.optional(),hostMigrationPath:z.string().min(1).max(4096).optional(),resolution:lifeResolutionSchema.optional()}).strict().parse(value)
  if(q.resolution)checkResolution(run,q.namespace,q.resolution)
  let meta=readMeta(db,q.namespace),entries=rows(run,q.namespace)
  if(!meta){
   if(!q.legacy)return null
   if(entries.length)throw Error('life_migration_conflict')
   const now=new Date().toISOString(),id=q.namespace+'e:legacy'
   persist(run,q.namespace,[],q.legacy,id,now,true,q.processingGrant)
   entries=rows(run,q.namespace)
   meta={revision:0,receipts:q.legacy.receipts,signature:signature(entries),migrated:true,profile_version:q.legacy.profile.version,...(q.hostMigrationPath?{legacy_path:q.hostMigrationPath}: {})};saveMeta(db,q.namespace,meta)
  }else if(meta.signature!==signature(entries)){
   meta={...meta,revision:meta.revision+1,signature:signature(entries)};saveMeta(db,q.namespace,meta)
  }
  if(!meta.legacy_path&&q.hostMigrationPath){meta={...meta,legacy_path:q.hostMigrationPath};saveMeta(db,q.namespace,meta)}
  const state=stateFrom(entries,meta.receipts)
  if((meta.profile_version??0)<state.profile.version){meta={...meta,profile_version:state.profile.version};saveMeta(db,q.namespace,meta)}
  return {state,revision:meta.revision}
 }
 const q=z.object({namespace:namespaceSchema,input:lifeInputSchema,requestId:z.string().min(1).max(512),expectedRevision:z.number().int().nonnegative(),provenance:provenanceSchema.optional(),processingGrant:processingGrantSchema.optional()}).strict().parse(value)
 const meta=readMeta(db,q.namespace);if(!meta)throw Error('life_not_initialized')
 const entries=rows(run,q.namespace),state=stateFrom(entries,meta.receipts)
 // A durable idempotency receipt takes precedence over a stale client's aggregate revision.
 if(Object.hasOwn(meta.receipts,q.requestId)){
  const prior=applyLifeMutation(state,q.input,q.requestId),stamp=signature(entries)
  const refreshed=meta.signature===stamp?meta:{...meta,signature:stamp,revision:meta.revision+1}
  if(refreshed!==meta)saveMeta(db,q.namespace,refreshed)
  return {state,revision:refreshed.revision,result:prior.result}
 }
 const resolutionEntries=q.provenance?.resolution?checkResolution(run,q.namespace,q.provenance.resolution):[]
 if(meta.revision!==q.expectedRevision||meta.signature!==signature(entries))throw Error('version_conflict')
 let evaluated:EvaluatedCandidate|undefined
 if(q.provenance){
  const raw=z.record(z.string(),z.unknown()).parse(q.provenance.row.candidate),{id,...candidate}=raw
  const checked=validateCandidate(q.provenance.row.source,candidate)
  if(checked.id!==id)throw Error('candidate_id_mismatch')
  evaluated={...q.provenance.row,candidate:checked};assertAcceptable(evaluated,evaluated.source)
  if(q.provenance.type==='explicit_candidate'&&((evaluated.candidate.kind!=='todo'&&evaluated.candidate.operation!=='update')||evaluated.decision.capture!=='explicit'))throw Error('candidate_not_explicit')
  if((q.input.op==='profile'&&evaluated.candidate.kind!=='profile')||(q.input.op==='create'&&q.input.kind!==evaluated.candidate.kind)||(q.input.op==='update'&&q.input.kind!==evaluated.candidate.kind)||!['profile','create','update'].includes(q.input.op))throw Error('candidate_kind_mismatch')
  const resolution=q.provenance.resolution
  if(evaluated.candidate.operation==='update'&&(q.input.op!=='update'||!resolution))throw Error('candidate_update_no_match')
  if(q.input.op==='update'&&!resolution)throw Error('candidate_missing_resolution')
  if(resolution){
   const decision=validateResolution({decisions:[resolution.decision]},[evaluated.candidate],resolutionEntries)[0]!
   if(decision.action==='no_change'||(decision.action==='add'&&q.input.op!=='create')||(decision.action==='update'&&q.input.op!=='update'))throw Error('candidate_resolution_mismatch')
   if(q.input.op==='update'){
    const target=resolutionEntries.find(row=>row.entry_id===decision.target_id)!,data=target.content.life_data as {id:string;version:number}
    if(q.input.id!==data.id||q.input.expected_version!==data.version)throw Error('candidate_resolution_mismatch')
    if(q.input.goal_id!==undefined||q.input.success_criteria!==undefined)throw Error('candidate_patch_mismatch')
    const patch=evaluated.candidate.patch??{}
    if(!Object.keys(patch).length)throw Error('candidate_empty_update')
    for(const key of ['title','note','status','due'] as const)if(q.input[key]!==patch[key])throw Error('candidate_patch_mismatch')
   }
  }

 }
 const now=new Date().toISOString(),next=applyLifeMutation(state,q.input,q.requestId,now),evidenceId=q.namespace+'e:'+hash(q.requestId)
 // Empty UI state remains version zero; a new incarnation cannot reuse an old editor's version.
 if(q.input.op==='profile'){const version=Math.max(next.state.profile.version,(meta.profile_version??0)+1);next.state.profile.version=version;next.result.version=version;next.state.receipts[q.requestId]!.result.version=version}
 run('append_evidence',EvidenceRecordSchema.parse({id:evidenceId,source_id:q.namespace+'event:'+hash(q.requestId),source_kind:'user_correction',locator:evaluated?'host-source:'+evaluated.source.id:'life-command:'+q.requestId,observed_at:evaluated?.source.observed_at??now,recorded_at:now,raw_text:evaluated?.source.text??canonicalJson(q.input),hash:hash(canonicalJson({namespace:q.namespace,input:q.input,requestId:q.requestId,provenance:q.provenance??null})),trust:'trusted_user',extracted:{event:q.provenance?.type??'life_command',command:q.input,...(evaluated?{source:evaluated.source,candidate:evaluated.candidate,decision:evaluated.decision}: {})}}))
 if(q.processingGrant)run('source_grant',{source_id:q.namespace+'event:'+hash(q.requestId),expected_revision:0,grant:q.processingGrant})
 persist(run,q.namespace,entries,next.state,evidenceId,now)
 const updated=rows(run,q.namespace),updatedMeta:Meta={...meta,profile_version:Math.max(meta.profile_version??0,next.state.profile.version),revision:meta.revision+1,receipts:next.state.receipts,signature:signature(updated),migrated:true}
 saveMeta(db,q.namespace,updatedMeta)
 return {state:stateFrom(updated,updatedMeta.receipts),revision:updatedMeta.revision,result:next.result}
}

/** This transaction records receipt and original source linkage together. No message text is retained in receipts. */
function captureIm(db:LedgerDatabase,value:unknown,run:Run):unknown{
 const q=z.object({namespace:namespaceSchema.startsWith('personal:'),evidence_id:z.string().min(1).max(512),provider:z.string().min(1),stamp:z.string().min(1),context:z.array(z.object({evidence_id:z.string().min(1).max(512),stamp:z.string().min(1)}).strict()).max(12).optional(),action:z.object({title:z.string().trim().min(1).max(200),note:z.string().max(4000),due:z.string().date().nullable(),quote:z.string().min(1)}).strict().nullable(),target:z.object({entry_id:z.string(),revision:z.number().int().positive(),stamp:z.string().min(1)}).strict().optional()}).strict().parse(value)
 const evidence=EvidenceRecordSchema.nullable().parse(run('processing_evidence',{id:q.evidence_id,purpose:'extraction',provider:q.provider})),metadata=evidence?.source_metadata
 if(!evidence||!evidence.source_id.startsWith(q.namespace.slice(0,-5))||evidence.source_kind!=='im'||metadata?.mention!=='direct'||metadata.auto_capture!==true||!metadata.recipient_id||metadata.recipient_id===metadata.sender_id||!metadata.message_id||!metadata.chat_id)throw Error('im_capture_not_authorized')
 if(run('processing_stamp',{ids:[evidence.id],purpose:'extraction',provider:q.provider})!==q.stamp)throw Error('STORE_STALE_REVISION')
 for(const context of q.context??[]){
  const record=EvidenceRecordSchema.nullable().parse(run('processing_evidence',{id:context.evidence_id,purpose:'extraction',provider:q.provider}))
  if(record?.source_kind!=='im'||!record.source_id.startsWith(q.namespace.slice(0,-5))||record.source_metadata?.account_id!==metadata.account_id||record.source_metadata.chat_id!==metadata.chat_id||Date.parse(record.observed_at)>Date.now()||run('processing_stamp',{ids:[record.id],purpose:'extraction',provider:q.provider})!==context.stamp)throw Error('STORE_STALE_REVISION')
 }
 if(q.action?.quote&&!evidence.raw_text?.includes(q.action.quote))throw Error('im_capture_quote_missing')
 const entries=rows(run,q.namespace),now=new Date().toISOString()
 let meta=readMeta(db,q.namespace)??{revision:0,receipts:{},signature:signature(entries),migrated:true as const}
 if(meta.signature!==signature(entries))meta={...meta,revision:meta.revision+1,signature:signature(entries)}
 const key=hash(canonicalJson([metadata.account_id,metadata.chat_id,metadata.message_id]))
 const prior=db.prepare('SELECT evidence_id,entry_id FROM memory_life_im_receipts WHERE namespace=? AND message_key=?').get(q.namespace,key)
 let target:EntryRevision|undefined
 if(prior){target=entries.find(row=>row.entry_id===prior.entry_id&&row.op!=='tombstone')}
 else if(q.target){
  target=entries.find(row=>row.entry_id===q.target!.entry_id&&row.kind==='todo'&&row.op!=='tombstone')
  if(target?.revision!==q.target.revision||(target.valid_until!==null&&Date.parse(target.valid_until)<=Date.now())||run('processing_stamp',{ids:target.evidence_refs,purpose:'extraction',provider:q.provider})!==q.target.stamp)throw Error('STORE_STALE_REVISION')
 }
 let result:{id:string;version:number}|null=null,storedId:string|null=null
 if(target&&(q.action||prior)){
  const data=lifeStateSchema.shape.todos.element.parse(target.content.life_data)
  const changed=Boolean(prior&&prior.evidence_id!==evidence.id)
  const refs=[...new Set([...(data.provenance_refs??[]),evidence.id])]
  if(refs.length>256)throw Error('im_provenance_limit')
  if(changed||!prior){
   const updated={...data,provenance_refs:refs,...(changed?{source_changed:true}:{}),version:data.version+1,updated_at:now}
   // A metadata-only revision retains the original human authority and all editable fields.
   const next=EntryRevisionSchema.parse({...target,revision:target.revision+1,supersedes:target.revision,op:'update',recorded_at:now,evidence_refs:[...new Set([...target.evidence_refs,evidence.id])],content:{...target.content,life_data:updated}})
   db.prepare('INSERT INTO memory_revisions VALUES(?,?,?)').run(next.entry_id,next.revision,canonicalJson(next));db.prepare('DELETE FROM memory_vectors WHERE entry_id=?').run(next.entry_id);queueMemoryFiles(db)
   result={id:data.id,version:updated.version}
  }else result={id:data.id,version:data.version}
  storedId=target.entry_id
 }else if(!prior&&q.action){
  const data=lifeStateSchema.shape.todos.element.parse({id:hash(q.namespace+key),title:q.action.title,note:q.action.note,due:q.action.due,status:'open',goal_id:null,idea_id:null,version:1,created_at:now,updated_at:now,auto_recorded:true,provenance_refs:[evidence.id]})
  storedId=q.namespace+'todo:'+data.id
  const merged=EntryRevisionSchema.nullable().parse(run('merge',{entry_id:storedId,expected_revision:0,kind:'todo',origin:'inferred',written_by:'merge',evidence_refs:[evidence.id],content:{life_id:data.id,life_data:data,life_order:entries.filter(row=>row.kind==='todo').length,text:[data.title,data.note].filter(Boolean).join('\n')},recorded_at:now}))
  if(!merged)throw Error('im_capture_merge_rejected')
  result={id:data.id,version:data.version}
 }
 if(!prior)db.prepare('INSERT INTO memory_life_im_receipts VALUES(?,?,?,?)').run(q.namespace,key,evidence.id,storedId)
 else if(prior.evidence_id!==evidence.id)db.prepare('UPDATE memory_life_im_receipts SET evidence_id=? WHERE namespace=? AND message_key=?').run(evidence.id,q.namespace,key)
 const updated=rows(run,q.namespace),nextSignature=signature(updated)
 meta={...meta,revision:meta.revision+(nextSignature!==meta.signature?1:0),signature:nextSignature};saveMeta(db,q.namespace,meta)
 return {state:stateFrom(updated,meta.receipts),revision:meta.revision,result}
}
