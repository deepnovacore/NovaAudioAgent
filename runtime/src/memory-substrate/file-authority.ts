import {rebuildWorkspaceProjections} from './workspace-projections.js'
import {randomUUID} from 'node:crypto'
import {lstatSync} from 'node:fs'
import {join} from 'node:path'
import {canonicalJson} from '../text/canonical-json.js'
import type {LedgerDatabase} from '../memory-ledger/store.js'
import {MarkdownRepository,type ApprovedMarkdownEdit} from './markdown-repository.js'
import {EntryRevisionSchema,type EntryRevision} from './store.js'

type Snapshot=ReturnType<MarkdownRepository['read']>
interface Pending {operation_id:string;revisions:EntryRevision[];baselines:Record<string,string>;approved_edits:ApprovedMarkdownEdit[]}
const authorities=new WeakMap<LedgerDatabase,{repository:MarkdownRepository;snapshot:Snapshot}>()
export function storedRevisions(db:LedgerDatabase):EntryRevision[]{
 return db.prepare('SELECT payload_json FROM memory_revisions ORDER BY entry_id,revision').all().map(row=>EntryRevisionSchema.parse(JSON.parse(String(row.payload_json))))
}
function replaceIndex(db:LedgerDatabase,revisions:EntryRevision[],rebuildWorkspace=false):void{
 const same=canonicalJson(storedRevisions(db))===canonicalJson(revisions)
 if(same&&!rebuildWorkspace)return
 db.exec('BEGIN IMMEDIATE')
 try{
  if(!same){
   db.exec('DELETE FROM memory_revisions; DELETE FROM memory_vectors')
   for(const row of revisions)db.prepare('INSERT INTO memory_revisions VALUES(?,?,?)').run(row.entry_id,row.revision,canonicalJson(row))
  }
  rebuildWorkspaceProjections(db,revisions)
  db.exec('COMMIT')
 }catch(error){db.exec('ROLLBACK');throw error}
}
/** Called within the same SQLite transaction as evidence, revision and receipt writes. */
export function queueMemoryFiles(db:LedgerDatabase):void{
 const state=authorities.get(db);if(!state)return
 const previous=db.prepare('SELECT payload_json FROM memory_file_outbox WHERE slot=1').get()
 const old=previous?JSON.parse(String(previous.payload_json)) as Pending:null
 if(old&&state.repository.pendingOperationId()!==null)throw Error('MEMORY_MARKDOWN_PENDING_OPERATION')
 const pending:Pending={operation_id:old?.operation_id??randomUUID(),revisions:storedRevisions(db),baselines:old?.baselines??state.snapshot.baselines,approved_edits:old?.approved_edits??state.snapshot.edits.map(({entry_id,expected_revision,path,hash})=>({entry_id,expected_revision,path,hash}))}
 db.prepare('INSERT INTO memory_file_outbox VALUES(1,?) ON CONFLICT(slot) DO UPDATE SET payload_json=excluded.payload_json').run(canonicalJson(pending))
}
/** Publication may fail after SQL commit. The durable outbox remains until Git is complete. */
export function flushMemoryFiles(db:LedgerDatabase):void{
 const state=authorities.get(db);if(!state)return
 const raw=db.prepare('SELECT payload_json FROM memory_file_outbox WHERE slot=1').get();if(!raw)return
 const pending=JSON.parse(String(raw.payload_json)) as Pending
 const repository=state.repository,journal=repository.pendingOperationId()
 if(journal!==null){if(journal!==pending.operation_id)throw Error('MEMORY_MARKDOWN_CONFLICT');repository.recover(journal,pending.revisions)}
 else if(!repository.hasSnapshot()||canonicalJson(repository.read().revisions)!==canonicalJson(pending.revisions)){
  const operation=repository.prepare(pending.revisions,pending.operation_id,pending.baselines,pending.approved_edits)
  repository.publishPrepared(operation);repository.finalize(operation)
 }
 db.prepare('DELETE FROM memory_file_outbox WHERE slot=1').run()
 state.snapshot=repository.read()
}
/** Called under the store's path lock; finding an existing authority must precede legacy bootstrap. */
export function hasMemoryFileAuthority(db:LedgerDatabase,path:string):boolean {
 return authorities.has(db)||['.nova-memory.json','.nova-memory-batch.json'].some(name=>lstatSync(join(path,name),{throwIfNoEntry:false})!==undefined)||db.prepare('SELECT 1 FROM memory_file_outbox WHERE slot=1').get()!==undefined
}
export function memoryFilesEnabled(db:LedgerDatabase):boolean{return authorities.has(db)}
export function enableMemoryFiles(db:LedgerDatabase,path:string,options:{alreadyLocked?:boolean}={}):Snapshot{
 const repository=authorities.get(db)?.repository??new MarkdownRepository(path)
 const enable=()=>{
  if(authorities.has(db))return readMemoryFiles(db)!
  repository.initialize()
  // Register before replay: the outbox belongs to the ledger, never an inferred Git state.
  authorities.set(db,{repository,snapshot:{revisions:[],edits:[],baselines:{}}})
  try{
   if(!repository.hasSnapshot()&&!db.prepare('SELECT 1 FROM memory_file_outbox WHERE slot=1').get())queueMemoryFiles(db)
   flushMemoryFiles(db)
   const snapshot=repository.read();replaceIndex(db,snapshot.revisions,true)
   authorities.get(db)!.snapshot=snapshot;return snapshot
  }catch(error){authorities.delete(db);throw error}
 }
 return options.alreadyLocked?enable():repository.withLock(enable)
}
export function readMemoryFiles(db:LedgerDatabase):Snapshot|null{
 const state=authorities.get(db);if(!state)return null
 flushMemoryFiles(db)
 const snapshot=state.repository.read();replaceIndex(db,snapshot.revisions);state.snapshot=snapshot;return snapshot
}

export function withMemoryFilesLock<T>(db:LedgerDatabase,fn:()=>T):T {
 const state=authorities.get(db);return state?state.repository.withLock(fn):fn()
}

/** Drop an obsolete projection after a durable permanent purge. */
export function forgetMemoryFileCache(db:LedgerDatabase):void{authorities.delete(db)}
