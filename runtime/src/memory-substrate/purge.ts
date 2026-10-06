import {createHash,randomUUID} from 'node:crypto'
import {closeSync,constants,fstatSync,fsyncSync,lstatSync,openSync,readFileSync,renameSync,writeFileSync} from 'node:fs'
import {dirname,isAbsolute,join,parse} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {z} from 'zod'
import type {LedgerDatabase} from '../memory-ledger/store.js'
import {canonicalJson} from '../text/canonical-json.js'
import {lifeStateSchema} from '../personal-agent/life.js'
import {MarkdownRepository} from './markdown-repository.js'
import {enableMemoryFiles,forgetMemoryFileCache} from './file-authority.js'
import {EvidenceRecordSchema,reconcileMemoryFiles,type EntryRevision} from './store.js'
import {rebuildWorkspaceProjections} from './workspace-projections.js'

const hash=(text:string)=>createHash('sha256').update(text).digest('hex')
const inputSchema=z.object({request_id:z.string().min(1).max(256),entry_prefix:z.string().min(1).max(512),selection:z.object({kind:z.literal('entry'),id:z.string().min(1).max(512),expected_revision:z.number().int().positive()}).strict()}).strict()
export interface PurgeResult {status:'complete'|'incomplete';operation_id:string;removed_entries:number;removed_evidence:number;removed_entry_ids:string[];removed_evidence_ids:string[];index_evidence_ids:string[];backup_cleanup:{status:'complete'|'incomplete';unresolved:string[]}}
type Backup={kind:'life';path:string;before:string;after:string;bytes:string}|{kind:'legacy';path:string;dev:number;ino:number;user_id:string;ids:string[];sources:string[];preimages:Record<string,string>}
type Selected=Pick<EntryRevision,'entry_id'|'kind'|'content'>
interface Intent {selected:Selected[];operation_id:string;entry_id:string;expected_revision:number;request_ids:string[];revisions:EntryRevision[];baselines:Record<string,string>;removed_entries:number;removed_evidence:number;removed_entry_ids:string[];removed_evidence_ids:string[];pending_index_evidence_ids:string[];backups:Backup[];unresolved:string[];repository_done:boolean;result?:PurgeResult}
export function initializePurge(db:LedgerDatabase):void{
 db.exec('CREATE TABLE IF NOT EXISTS memory_purges(entry_id TEXT PRIMARY KEY,payload_json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS memory_purged_ids(hash TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS memory_migration_paths(path TEXT NOT NULL,user_id TEXT NOT NULL,entry_prefix TEXT NOT NULL,source_prefix TEXT NOT NULL,dev INTEGER NOT NULL,ino INTEGER NOT NULL,PRIMARY KEY(path,user_id))')
}
function save(db:LedgerDatabase,intent:Intent):void{db.prepare('INSERT OR REPLACE INTO memory_purges VALUES(?,?)').run(intent.entry_id,canonicalJson(intent))}
function intents(db:LedgerDatabase):Intent[]{return db.prepare('SELECT payload_json FROM memory_purges').all().map(row=>JSON.parse(String(row.payload_json)) as Intent)}
export function isPermanentlyPurged(db:LedgerDatabase,id:string):boolean{return db.prepare('SELECT 1 FROM memory_purged_ids WHERE hash=?').get(hash(id))!==undefined}
/** Validate every ancestor and SQLite sidecar before opening any host-registered backup. */
function safePath(path:string,sidecars=false):void {
 if(!isAbsolute(path))throw Error('unregistered_backup_path')
 const root=parse(path).root,components=path.slice(root.length).split(/[\\/]/).filter(Boolean);let cursor=root
 for(const [index,component] of components.entries()){
  cursor=join(cursor,component);const stat=lstatSync(cursor,{throwIfNoEntry:false});if(!stat)throw Error(index===components.length-1?'backup_missing':'backup_parent_missing')
  if(process.platform==='darwin'&&['/tmp','/var','/etc'].includes(cursor))continue
  if(stat.isSymbolicLink()||(!stat.isDirectory()&&(!stat.isFile()||stat.nlink!==1)))throw Error('unsafe_backup_path')
 }
 if(sidecars)for(const suffix of ['-wal','-shm','-journal']){const stat=lstatSync(path+suffix,{throwIfNoEntry:false});if(stat&&(stat.isSymbolicLink()||!stat.isFile()||stat.nlink!==1))throw Error('unsafe_backup_sidecar')}
}
function readPrivate(path:string):string {safePath(path);const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{if(fstatSync(fd).size>16*1024*1024)throw Error('backup_too_large');return readFileSync(fd,'utf8')}finally{closeSync(fd)}}
/** Only the historical fixed-ID empty initializer can waive a specifically missing Life backup. */
function emptyLegacyProfile(db:LedgerDatabase,namespace:string,row:Selected):boolean{
 if(row.entry_id!==namespace+'profile:profile'||row.kind!=='profile'||row.content.legacy!==true||row.content.life_id!=='profile'||row.content.legacy_id!==undefined)return false
 const fingerprint=hash(canonicalJson({entry_id:row.entry_id,legacy:{about:'',version:0}}))
 const record=db.prepare('SELECT payload_json FROM memory_evidence WHERE id=?').get(namespace+'e:legacy:'+hash(row.entry_id))
 if(!record)return db.prepare('SELECT 1 FROM memory_suppressed WHERE hash=?').get(fingerprint)!==undefined
 const parsed=EvidenceRecordSchema.safeParse(JSON.parse(String(record.payload_json)))
 if(!parsed.success)return false
 const evidence=parsed.data
 return evidence.id===namespace+'e:legacy:'+hash(row.entry_id)&&evidence.hash===fingerprint&&evidence.source_id===namespace+'migration:'+hash(row.entry_id)&&evidence.source_kind==='task_result'&&evidence.locator==='legacy-life-json:profile'&&evidence.trust==='trusted_system'&&evidence.raw_text===null&&evidence.extracted.event==='legacy_import'&&evidence.extracted.legacy===true&&evidence.extracted.original_evidence_available===false
}
function backupPlan(db:LedgerDatabase,selected:Selected[]):{backups:Backup[];unresolved:string[]}{
 const backups:Backup[]=[],unresolved:string[]=[]
 for(const record of db.prepare('SELECT namespace,payload_json FROM memory_life_meta').all()){
  const namespace=String(record.namespace),entries=selected.filter(row=>row.entry_id.startsWith(namespace)&&row.content.legacy===true)
  if(!entries.length)continue
  const meta=JSON.parse(String(record.payload_json)) as {legacy_path?:string}
  if(!meta.legacy_path){unresolved.push('life_backup_path_unregistered');continue}
  try{
   const bytes=readPrivate(meta.legacy_path),state=lifeStateSchema.parse(JSON.parse(bytes)),ids=new Set(entries.map(row=>z.string().parse(row.content.life_id)))
   state.todos=state.todos.filter(row=>!entries.some(entry=>entry.kind==='todo'&&entry.content.life_id===row.id))
   state.ideas=state.ideas.filter(row=>!entries.some(entry=>entry.kind==='idea'&&entry.content.life_id===row.id))
   state.goals=state.goals.filter(row=>!entries.some(entry=>entry.kind==='goal'&&entry.content.life_id===row.id))
   if(entries.some(row=>row.kind==='profile'))state.profile={about:'',version:state.profile.version+1}
   state.receipts=Object.fromEntries(Object.entries(state.receipts).filter(([,receipt])=>!ids.has(receipt.result.id)))
   const after=JSON.stringify(state,null,2)+'\n';backups.push({kind:'life',path:meta.legacy_path,before:hash(bytes),after:hash(after),bytes:after})
  }catch(error){if(!(error instanceof Error&&error.message==='backup_missing'&&entries.every(row=>emptyLegacyProfile(db,namespace,row))))unresolved.push('life_backup_unverified')}
 }
 const legacy=selected.filter(row=>typeof row.content.legacy_id==='string')
 const mappings=db.prepare('SELECT * FROM memory_migration_paths').all()
 for(const row of legacy)if(!mappings.some(mapping=>row.entry_id.startsWith(String(mapping.entry_prefix))))unresolved.push('legacy_backup_path_unregistered')
 for(const mapping of mappings){
  const selectedHere=legacy.filter(row=>row.entry_id.startsWith(String(mapping.entry_prefix)));if(!selectedHere.length)continue
  const path=String(mapping.path),user_id=String(mapping.user_id),ids=[...new Set(selectedHere.map(row=>z.string().parse(row.content.legacy_id)))];let legacyDb:DatabaseSync|undefined
  try{
   safePath(path,true);const stat=lstatSync(path);if(stat.dev!==Number(mapping.dev)||stat.ino!==Number(mapping.ino))throw Error('backup_replaced')
   legacyDb=new DatabaseSync(path,{readOnly:true,allowExtension:false});const sources=new Set<string>(),preimages:Record<string,string>={}
   for(const id of ids){const raw=legacyDb.prepare("SELECT payload FROM vm_memories WHERE user_id=? AND scope='personal' AND id=?").get(user_id,id);if(raw){preimages['memory:'+id]=hash(String(raw.payload));const value=z.object({evidenceIds:z.array(z.string())}).passthrough().parse(JSON.parse(String(raw.payload)));for(const source of value.evidenceIds)sources.add(source)}}
   for(const source of sources){const raw=legacyDb.prepare("SELECT payload FROM vm_sources WHERE user_id=? AND scope='personal' AND id=?").get(user_id,source);if(raw)preimages['source:'+source]=hash(String(raw.payload))}
   backups.push({kind:'legacy',path,user_id,dev:stat.dev,ino:stat.ino,ids,sources:[...sources],preimages})
  }catch{unresolved.push('legacy_backup_unverified')}finally{legacyDb?.close()}
 }
 return {backups,unresolved:[...new Set(unresolved)]}
}
function compact(db:LedgerDatabase):void{
 db.exec('PRAGMA secure_delete=ON')
 const checkpoint=db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();if(checkpoint&&Number(checkpoint.busy)>0)throw Error('checkpoint_busy')
 db.exec('VACUUM')
 const after=db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();if(after&&Number(after.busy)>0)throw Error('checkpoint_busy')
}
function cleanBackup(backup:Backup):void{
 if(backup.kind==='life'){
  const bytes=readPrivate(backup.path),current=hash(bytes);if(current===backup.after)return;if(current!==backup.before)throw Error('backup_changed')
  const temporary=join(dirname(backup.path),'.nova-purge-'+hash(backup.path+backup.after)+'.tmp')
  if(lstatSync(temporary,{throwIfNoEntry:false})){if(readPrivate(temporary)!==backup.bytes)throw Error('backup_changed')}
  else {const fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,backup.bytes);fsyncSync(fd)}finally{closeSync(fd)}}
  if(hash(readPrivate(backup.path))!==backup.before)throw Error('backup_changed')
  renameSync(temporary,backup.path)
  if(process.platform!=='win32'){const fd=openSync(dirname(backup.path),constants.O_RDONLY);try{fsyncSync(fd)}finally{closeSync(fd)}}
  return
 }
 safePath(backup.path,true);const stat=lstatSync(backup.path);if(stat.dev!==backup.dev||stat.ino!==backup.ino)throw Error('backup_replaced')
 const db=new DatabaseSync(backup.path,{allowExtension:false})
 try{
  db.exec('PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA busy_timeout=1000')
  const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>String(row.name)))
  const known=new Set(['vm_meta','vm_sources','vm_memories','vm_memory_lifecycle','vm_query_activations','vm_graph_tags','vm_graph_blocks','vm_dynamic_slots','vm_generated_slots','vm_slot_summaries','vm_evidence'])
  if([...tables].some(name=>!known.has(name)&&!name.startsWith('sqlite_')))throw Error('backup_schema_unknown')
  db.exec('BEGIN IMMEDIATE')
  try{
   for(const [key,expected] of Object.entries(backup.preimages)){const memory=key.startsWith('memory:'),table=memory?'vm_memories':'vm_sources',id=key.slice(7),row=db.prepare(`SELECT payload FROM ${table} WHERE user_id=? AND scope='personal' AND id=?`).get(backup.user_id,id);if(row&&hash(String(row.payload))!==expected)throw Error('backup_changed')}
   for(const id of backup.ids){
    if(tables.has('vm_dynamic_slots')&&tables.has('vm_generated_slots')&&tables.has('vm_graph_tags'))db.prepare("DELETE FROM vm_dynamic_slots WHERE user_id=? AND scope='personal' AND name IN (SELECT t.slot FROM vm_graph_tags t JOIN vm_generated_slots g ON g.user_id=t.user_id AND g.scope=t.scope AND g.name=t.slot WHERE t.user_id=? AND t.scope='personal' AND t.memory_id=?)").run(backup.user_id,backup.user_id,id)
    for(const table of ['vm_evidence','vm_query_activations','vm_graph_tags','vm_memory_lifecycle'])if(tables.has(table))db.prepare(`DELETE FROM ${table} WHERE user_id=? AND scope='personal' AND memory_id=?`).run(backup.user_id,id)
    db.prepare("DELETE FROM vm_memories WHERE user_id=? AND scope='personal' AND id=?").run(backup.user_id,id)
   }
   for(const id of backup.sources){
    if(tables.has('vm_evidence'))db.prepare("DELETE FROM vm_evidence WHERE user_id=? AND scope='personal' AND source_id=?").run(backup.user_id,id)
    db.prepare("DELETE FROM vm_sources WHERE user_id=? AND scope='personal' AND id=?").run(backup.user_id,id)
   }
   if(tables.has('vm_slot_summaries'))db.prepare("DELETE FROM vm_slot_summaries WHERE user_id=? AND scope='personal'").run(backup.user_id)
   if(tables.has('vm_meta'))for(const row of db.prepare('SELECT key FROM vm_meta').all()){
    let key:unknown;try{key=JSON.parse(String(row.key))}catch{continue}
    if(Array.isArray(key)&&key[0]==='nova-entry'&&key[1]===backup.user_id&&key[2]==='personal'&&(backup.ids.includes(String(key[4]))||backup.sources.includes(String(key[4]))))db.prepare('DELETE FROM vm_meta WHERE key=?').run(String(row.key))
   }
   db.exec('COMMIT')
  }catch(error){db.exec('ROLLBACK');throw error}
  compact(db)
 }finally{db.close()}
}
function finish(db:LedgerDatabase,path:string,intent:Intent):PurgeResult{
 if(intent.result?.status==='complete')return intent.result
 let unresolved=[...intent.unresolved]
 try{
  if(!intent.repository_done){new MarkdownRepository(path+'.memory').purge(intent.revisions,intent.operation_id,intent.baselines);intent.repository_done=true;intent.revisions=[];intent.baselines={};forgetMemoryFileCache(db);save(db,intent)}
 }catch{unresolved.push('markdown_git_cleanup_pending')}
 if(intent.repository_done){
  if(intent.unresolved.length){const planned=backupPlan(db,intent.selected);intent.unresolved=planned.unresolved;unresolved=[...planned.unresolved];for(const backup of planned.backups)if(!intent.backups.some(old=>old.kind===backup.kind&&old.path===backup.path))intent.backups.push(backup)}
  const pending:Backup[]=[]
  for(const backup of intent.backups)try{cleanBackup(backup)}catch{pending.push(backup);unresolved.push(backup.kind+'_backup_cleanup_pending')}
  intent.backups=pending
 }
 if(intent.pending_index_evidence_ids.length)unresolved.push('knowledge_index_cleanup_pending')
 const result:PurgeResult={status:unresolved.length?'incomplete':'complete',operation_id:intent.operation_id,removed_entries:intent.removed_entries,removed_evidence:intent.removed_evidence,removed_entry_ids:intent.removed_entry_ids,removed_evidence_ids:intent.removed_evidence_ids,index_evidence_ids:intent.pending_index_evidence_ids,backup_cleanup:{status:unresolved.some(item=>item.includes('backup'))?'incomplete':'complete',unresolved:[...new Set(unresolved)]}}
 // A crash before/during compaction must retain an incomplete receipt, never a premature success.
 intent.result={...result,status:'incomplete',backup_cleanup:{...result.backup_cleanup,unresolved:[...result.backup_cleanup.unresolved,'ledger_compaction_pending']}};save(db,intent)
 try{compact(db)}catch{return intent.result}
 // This last write contains identifiers and status only, so it cannot reintroduce erased plaintext.
 intent.result=result;save(db,intent);return result
}
/** Runs before Markdown rebuilding; a pending purge must never resurrect removed SQL revisions. */
export function recoverMemoryPurges(db:LedgerDatabase,path:string):void{
 for(const intent of intents(db))if(!intent.repository_done||intent.result?.backup_cleanup.unresolved.includes('ledger_compaction_pending')){finish(db,path,intent);if(!intent.repository_done)throw Error('MEMORY_MARKDOWN_PURGE_PENDING')}
}
export function purgeStatus(db:LedgerDatabase,prefix:string):unknown[]{return intents(db).filter(intent=>intent.entry_id.startsWith(prefix)&&intent.result?.status==='incomplete').map(intent=>({...intent.result,entry_id:intent.entry_id,expected_revision:intent.expected_revision}))}
export function purgeEntry(db:LedgerDatabase,path:string,input:unknown):PurgeResult{
 const q=inputSchema.parse(input);if(!q.selection.id.startsWith(q.entry_prefix))throw Error('STORE_INVALID_OPERATION')
 const saved=intents(db);if(saved.some(intent=>intent.entry_id!==q.selection.id&&intent.request_ids.includes(q.request_id)))throw Error('STORE_IDEMPOTENCY_CONFLICT')
 const previous=saved.find(intent=>intent.entry_id===q.selection.id)
 if(previous){if(previous.expected_revision!==q.selection.expected_revision)throw Error('STORE_STALE_REVISION');if(!previous.request_ids.includes(q.request_id)){previous.request_ids.push(q.request_id);save(db,previous)}return finish(db,path,previous)}
 if(intents(db).some(intent=>intent.result?.status==='incomplete'))throw Error('STORE_INVALID_OPERATION')
 if(intents(db).some(intent=>intent.request_ids.includes(q.request_id)))throw Error('STORE_IDEMPOTENCY_CONFLICT')
 enableMemoryFiles(db,path+'.memory',{alreadyLocked:true});reconcileMemoryFiles(db)
 const repository=new MarkdownRepository(path+'.memory'),snapshot=repository.read()
 if(snapshot.edits.length||db.prepare('SELECT 1 FROM memory_file_outbox').get())throw Error('MEMORY_MARKDOWN_CONFLICT')
 const current=snapshot.revisions.filter(row=>row.entry_id===q.selection.id).at(-1)
 if(!current)throw Error('STORE_NOT_FOUND');if(current.revision!==q.selection.expected_revision)throw Error('STORE_STALE_REVISION')
 const selectedIds=new Set([current.entry_id]);let changed=true
 while(changed){changed=false;for(const row of snapshot.revisions)if(row.kind==='memory_summary'&&Array.isArray(row.content.basis)&&row.content.basis.some(item=>item&&typeof item==='object'&&!Array.isArray(item)&&typeof item.id==='string'&&selectedIds.has(item.id))&&!selectedIds.has(row.entry_id)){selectedIds.add(row.entry_id);changed=true}}
 const selected=snapshot.revisions.filter(row=>selectedIds.has(row.entry_id)),refs=[...new Set(snapshot.revisions.filter(row=>row.entry_id===current.entry_id).flatMap(row=>row.evidence_refs))]
 if(selectedIds.size>4096||refs.length>4096)throw Error('STORE_INVALID_OPERATION')
 const evidence=refs.flatMap(id=>{const row=db.prepare('SELECT payload_json FROM memory_evidence WHERE id=?').get(id);return row?[EvidenceRecordSchema.parse(JSON.parse(String(row.payload_json)))]:[]})
 const pendingIndex=refs.filter(id=>db.prepare("SELECT 1 FROM memory_extractions WHERE evidence_id=? AND attempt_id='knowledge-index'").get(id)!==undefined)
 const backup=backupPlan(db,selected)
 const selectedMapping=selected.map(row=>({entry_id:row.entry_id,kind:row.kind,content:{...(row.content.legacy===true?{legacy:true}:{}),...(typeof row.content.legacy_id==='string'?{legacy_id:row.content.legacy_id}:{}),...(typeof row.content.life_id==='string'?{life_id:row.content.life_id}:{})}}))
 const intent:Intent={selected:selectedMapping,operation_id:randomUUID(),entry_id:current.entry_id,expected_revision:current.revision,request_ids:[q.request_id],revisions:snapshot.revisions.filter(row=>!selectedIds.has(row.entry_id)),baselines:snapshot.baselines,removed_entries:selectedIds.size,removed_evidence:evidence.length,removed_entry_ids:[...selectedIds],removed_evidence_ids:evidence.map(row=>row.id),pending_index_evidence_ids:pendingIndex,...backup,repository_done:false}
 db.exec('PRAGMA secure_delete=ON; BEGIN IMMEDIATE')
 try{
  for(const id of selectedIds){db.prepare('INSERT OR IGNORE INTO memory_purged_ids VALUES(?)').run(hash(id));db.prepare('DELETE FROM memory_revisions WHERE entry_id=?').run(id);db.prepare('DELETE FROM memory_vectors WHERE entry_id=?').run(id)}
  for(const record of evidence){db.prepare('INSERT OR IGNORE INTO memory_purged_ids VALUES(?)').run(hash(record.id));db.prepare('INSERT OR IGNORE INTO memory_suppressed VALUES(?)').run(record.hash);db.prepare('DELETE FROM memory_evidence WHERE id=?').run(record.id);db.prepare('DELETE FROM memory_extractions WHERE evidence_id=?').run(record.id);db.prepare("DELETE FROM source_extractions WHERE json_extract(payload_json,'$.ticket.evidence_id')=?").run(record.id)}
  for(const row of db.prepare('SELECT namespace,payload_json FROM memory_life_meta').all()){
   const meta=JSON.parse(String(row.payload_json)) as {profile_version?:number;receipts:Record<string,{result:{id:string}}>},selectedHere=selected.filter(entry=>entry.entry_id.startsWith(String(row.namespace))),selectedLife=new Set(selectedHere.map(entry=>entry.content.life_id))
   // selected retains the pre-purge revisions, including legacy versions higher than aggregate CAS.
   for(const entry of selectedHere)if(entry.kind==='profile'&&entry.content.life_data!==undefined)meta.profile_version=Math.max(meta.profile_version??0,lifeStateSchema.shape.profile.parse(entry.content.life_data).version)
   meta.receipts=Object.fromEntries(Object.entries(meta.receipts).filter(([,receipt])=>!selectedLife.has(receipt.result.id)));db.prepare('UPDATE memory_life_meta SET payload_json=? WHERE namespace=?').run(canonicalJson(meta),String(row.namespace))
  }
  rebuildWorkspaceProjections(db,intent.revisions);save(db,intent);db.exec('COMMIT')
 }catch(error){db.exec('ROLLBACK');throw error}
 return finish(db,path,intent)
}

/** Only the host calls this after the evidence-linked index has durably removed its copies. */
export function completePurgeIndex(db:LedgerDatabase,path:string,input:unknown):PurgeResult{
 const q=z.object({entry_prefix:z.string().min(1).max(512),entry_id:z.string().min(1).max(512),operation_id:z.string().min(1).max(128)}).strict().parse(input)
 if(!q.entry_id.startsWith(q.entry_prefix))throw Error('STORE_INVALID_OPERATION')
 const intent=intents(db).find(row=>row.entry_id===q.entry_id)
 if(!intent)throw Error('STORE_NOT_FOUND');if(intent.operation_id!==q.operation_id)throw Error('STORE_IDEMPOTENCY_CONFLICT')
 intent.pending_index_evidence_ids=[];save(db,intent);return finish(db,path,intent)
}
