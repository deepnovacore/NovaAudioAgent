import {isPermanentlyPurged} from './purge.js'
import {existsSync,lstatSync} from 'node:fs'
import {z} from 'zod'
import {canonicalJson} from '../text/canonical-json.js'
import type {LedgerDatabase} from '../memory-ledger/store.js'
import {contentHash,memoryOperation} from './store.js'

/** Read-only import. The legacy database remains untouched as the recovery copy. */
export function migrateLegacyMemory(db:LedgerDatabase,input:unknown,openLegacy:(path:string)=>LedgerDatabase):number {
 const {path,user_id,entry_prefix,source_prefix}=z.object({path:z.string().min(1),user_id:z.string().min(1),entry_prefix:z.string().min(1),source_prefix:z.string().min(1)}).strict().parse(input)
 const marker=canonicalJson([path,user_id]);db.exec('CREATE TABLE IF NOT EXISTS memory_migrations(id TEXT PRIMARY KEY)')
 if(!existsSync(path))return 0
 const stat=lstatSync(path);if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink!==1)throw Error('STORE_MIGRATION_FAILED')
 db.prepare('INSERT OR IGNORE INTO memory_migration_paths VALUES(?,?,?,?,?,?)').run(path,user_id,entry_prefix,source_prefix,stat.dev,stat.ino)
 if(db.prepare('SELECT id FROM memory_migrations WHERE id=?').get(marker))return 0
 const legacy=openLegacy(path);let count=0
 try {
  const tables=legacy.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name)
  if(!tables.includes('vm_memories')||!tables.includes('vm_sources'))throw new Error('STORE_MIGRATION_FAILED')
  const records=legacy.prepare("SELECT payload FROM vm_memories WHERE user_id=? AND scope='personal' ORDER BY json_extract(payload,'$.recordedAt'),id").all(user_id)
  db.exec('BEGIN IMMEDIATE')
  try {
   for(const row of records){
    const record=z.object({id:z.string(),kind:z.string(),text:z.string(),evidenceIds:z.array(z.string()),authority:z.string(),recordedAt:z.string(),occurredAt:z.string().nullable(),supersededBy:z.string().nullable()}).passthrough().parse(JSON.parse(String(row.payload)))
    if(isPermanentlyPurged(db,entry_prefix+record.id))continue
    const refs:string[]=[]
    let corrected=false
    for(const originalId of record.evidenceIds){
     const sourceRow=legacy.prepare("SELECT payload,state FROM vm_sources WHERE user_id=? AND scope='personal' AND id=?").get(user_id,originalId)
     if(!sourceRow||sourceRow.state==='forgotten')continue
     const source=z.object({text:z.string(),recordedAt:z.string(),occurredAt:z.string().nullable(),role:z.string().optional(),sessionId:z.string().optional()}).passthrough().parse(JSON.parse(String(sourceRow.payload)))
     if(source.role==='assistant')continue
     let ref={type:'conversation',ref:originalId,observed_at:source.occurredAt??source.recordedAt}
     if(tables.includes('vm_meta')){const saved=legacy.prepare('SELECT value FROM vm_meta WHERE key=?').get(JSON.stringify(['nova-entry',user_id,'personal','source',originalId]));if(saved)ref=z.object({type:z.string(),ref:z.string(),observed_at:z.string()}).parse(JSON.parse(String(saved.value)))}
     const evidenceId=source_prefix+'legacy-e:'+contentHash(originalId)
     if(isPermanentlyPurged(db,evidenceId))continue
     const correction=source.sessionId?.startsWith('correction:')===true
     corrected ||= correction
     memoryOperation(db,'append_evidence',{id:evidenceId,source_id:source_prefix+ref.ref,source_kind:correction?'user_correction':ref.type==='task'?'task_result':ref.type,locator:ref.ref,observed_at:ref.observed_at,recorded_at:source.recordedAt,raw_text:source.text,hash:contentHash(user_id+':'+source.text),trust:correction?'trusted_user':'untrusted_external'},false)
     memoryOperation(db,'record_extraction',{evidence_id:evidenceId,attempt_id:'legacy-import',extracted:{legacy:true}},false)
     refs.push(evidenceId)
    }
    if(refs.length===0)continue
    memoryOperation(db,'merge',{entry_id:entry_prefix+record.id,kind:record.kind==='trait'?'preference':record.kind==='heartnote'?'concern':'fact',origin:corrected?'stated':'inferred',written_by:corrected?'user_correction':'merge',evidence_refs:refs,content:{text:record.text.slice(0,500),legacy_id:record.id,legacy_authority:record.authority},recorded_at:record.recordedAt,...(record.supersededBy?{op:'tombstone'}:{})},false)
    count++
   }
   // Preserve durable content suppressions; import is atomic and runs only once.
   if(tables.includes('vm_meta'))for(const row of legacy.prepare('SELECT key,value FROM vm_meta').all()){
    let key:unknown;try{key=JSON.parse(String(row.key))}catch{continue}
    if(Array.isArray(key)&&key[0]==='nova-entry'&&key[1]===user_id&&key[3]==='suppressed'&&typeof key[4]==='string'&&row.value==='true')db.prepare('INSERT OR IGNORE INTO memory_legacy_suppressed VALUES(?,?)').run(source_prefix,key[4])
   }
   db.prepare('INSERT INTO memory_migrations VALUES(?)').run(marker);db.exec('COMMIT')
  }catch(error){db.exec('ROLLBACK');throw error}
 }finally{legacy.close()}
 return count
}
