import type {LedgerDatabase} from '../memory-ledger/store.js'
import {LogicalWorkspaceSchema,WorkspaceInstanceSchema,RelationCardSchema} from '../memory-ledger/models.js'
import {SensitivePathPolicy} from '../memory/sensitivity.js'
import {canonicalJson} from '../text/canonical-json.js'
import {contentHash,type EntryRevision} from './store.js'
type LedgerSqlInput=Parameters<ReturnType<LedgerDatabase['prepare']>['run']>[number]
const changed=new WeakSet<LedgerDatabase>()
export function consumeWorkspaceProjectionChange(db:LedgerDatabase):boolean{const result=changed.has(db);changed.delete(db);return result}

const kinds=['LogicalWorkspace','WorkspaceInstance','RelationCard'] as const
type Kind=typeof kinds[number]
const isKind=(kind:string):kind is Kind=>(kinds as readonly string[]).includes(kind)
const schemas={LogicalWorkspace:LogicalWorkspaceSchema,WorkspaceInstance:WorkspaceInstanceSchema,RelationCard:RelationCardSchema}
const key=(kind:Kind,content:Record<string,unknown>)=>kind==='LogicalWorkspace'?String(content.logical_workspace_id):kind==='WorkspaceInstance'?String(content.instance_id):canonicalJson([content.source_logical_id,content.target_logical_id,content.relation_type])
const identityFields={LogicalWorkspace:['logical_workspace_id','canonical_remote','created_at'],WorkspaceInstance:['instance_id','logical_workspace_id','path_label','repository_fingerprint','first_seen_at'],RelationCard:['source_logical_id','target_logical_id','relation_type','evidence_refs','first_seen_at']}

/** A body edit changes descriptive fields, never host-owned identity or evidence references. */
export function normalizeWorkspaceContent(kind:string,content:Record<string,unknown>,previousContent?:Record<string,unknown>,userCorrection=false):Record<string,unknown>{
 if(!isKind(kind))return content
 const parsed=schemas[kind].parse(content),previous=previousContent?schemas[kind].parse(previousContent):undefined
 if(previous&&key(kind,parsed)!==key(kind,previous))throw Error('STORE_WORKSPACE_IDENTITY')
 if(userCorrection&&previous){
  for(const field of identityFields[kind])if(canonicalJson((parsed as Record<string,unknown>)[field])!==canonicalJson((previous as Record<string,unknown>)[field]))throw Error('STORE_WORKSPACE_IDENTITY')
  if(new SensitivePathPolicy().scrubText('workspace',canonicalJson(parsed)).kind!=='clean')throw Error('STORE_SENSITIVE_PATH_DENIED')
  if(canonicalJson(parsed)!==canonicalJson(previous))return {...parsed,revision:previous.revision+1}
 }
 return parsed
}
const definitions={
 LogicalWorkspace:{table:'logical_workspaces',columns:['logical_workspace_id','display_name','canonical_remote','created_at','updated_at','revision'],keys:['logical_workspace_id']},
 WorkspaceInstance:{table:'workspace_instances',columns:['instance_id','logical_workspace_id','display_name','path_label','branch','repository_fingerprint','status','first_seen_at','last_seen_at','revision'],keys:['instance_id']},
 RelationCard:{table:'relation_cards',columns:['source_logical_id','target_logical_id','relation_type','confidence','reason','first_seen_at','last_seen_at','status','revision'],keys:['source_logical_id','target_logical_id','relation_type']},
}
function available(db:LedgerDatabase):boolean{
 const count=db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('logical_workspaces','workspace_instances','relation_cards','relation_evidence')").get()?.count
 if(Number(count)===0)return false
 if(Number(count)!==4)throw Error('STORE_WORKSPACE_SCHEMA')
 return true
}
function projectionStamp(db:LedgerDatabase):string{return canonicalJson([
 db.prepare('SELECT * FROM logical_workspaces ORDER BY logical_workspace_id').all(),
 db.prepare('SELECT * FROM workspace_instances ORDER BY instance_id').all(),
 db.prepare('SELECT * FROM relation_cards ORDER BY source_logical_id,target_logical_id,relation_type').all(),
 db.prepare('SELECT * FROM relation_evidence ORDER BY source_logical_id,target_logical_id,relation_type,evidence_source,evidence_ref').all(),
])}
function validate(row:EntryRevision,previous?:EntryRevision|null):Record<string,unknown>{
 const content=normalizeWorkspaceContent(row.kind,row.content,previous?.op==='tombstone'?undefined:previous?.content)
 if(!isKind(row.kind)||row.entry_id!=='workspace:'+row.kind+':'+contentHash(key(row.kind,content)))throw Error('STORE_WORKSPACE_IDENTITY')
 return content
}
function write(db:LedgerDatabase,kind:Kind,content:Record<string,unknown>):void{
 const {table,columns,keys}=definitions[kind],all=[...columns,'payload_json']
 db.prepare(`INSERT INTO ${table}(${all.join(',')}) VALUES(${all.map(()=>'?').join(',')}) ON CONFLICT(${keys.join(',')}) DO UPDATE SET ${all.filter(field=>!keys.includes(field)).map(field=>`${field}=excluded.${field}`).join(',')}`).run(...columns.map(field=>content[field] as LedgerSqlInput),canonicalJson(content))
 if(kind==='RelationCard'){
  const relation=RelationCardSchema.parse(content)
  db.prepare('DELETE FROM relation_evidence WHERE source_logical_id=? AND target_logical_id=? AND relation_type=?').run(relation.source_logical_id,relation.target_logical_id,relation.relation_type)
  for(const evidence of relation.evidence_refs)db.prepare('INSERT INTO relation_evidence(source_logical_id,target_logical_id,relation_type,evidence_source,evidence_ref,observed_at,evidence_json) VALUES(?,?,?,?,?,?,?)').run(relation.source_logical_id,relation.target_logical_id,relation.relation_type,evidence.source,evidence.ref,evidence.observed_at,canonicalJson(evidence))
 }
}
/** Single-row projection inside the owning merge transaction; never removes unrelated cards. */
export function projectWorkspaceRevision(db:LedgerDatabase,next:EntryRevision,previous?:EntryRevision|null):void{
 if(!isKind(next.kind)||!available(db))return
 const stamp=projectionStamp(db)
 if(next.op!=='tombstone'){write(db,next.kind,validate(next,previous));if(stamp!==projectionStamp(db))changed.add(db);return}
 if(!previous||previous.op==='tombstone')throw Error('STORE_WORKSPACE_IDENTITY')
 const content=validate(previous),{table,keys}=definitions[next.kind]
 if(next.kind!==previous.kind||next.entry_id!==previous.entry_id)throw Error('STORE_WORKSPACE_IDENTITY')
 if(next.kind==='RelationCard')db.prepare('DELETE FROM relation_evidence WHERE source_logical_id=? AND target_logical_id=? AND relation_type=?').run(content.source_logical_id as string,content.target_logical_id as string,content.relation_type as string)
 db.prepare(`DELETE FROM ${table} WHERE ${keys.map(field=>`${field}=?`).join(' AND ')}`).run(...keys.map(field=>content[field] as LedgerSqlInput))
 if(stamp!==projectionStamp(db))changed.add(db)
}
/** Rebuild all typed projections from accepted current revisions inside the index transaction. */
export function rebuildWorkspaceProjections(db:LedgerDatabase,revisions:EntryRevision[]):void{
 if(!available(db))return
 const stamp=projectionStamp(db)
 const latest=new Map<string,EntryRevision>()
 for(const row of revisions)if(isKind(row.kind)&&(!latest.has(row.entry_id)||latest.get(row.entry_id)!.revision<row.revision))latest.set(row.entry_id,row)
 const active=[...latest.values()].filter(row=>row.op!=='tombstone').map(row=>({kind:row.kind as Kind,content:validate(row)}))
 // Validate the entire replacement before touching existing projections.
 db.exec('DELETE FROM relation_evidence; DELETE FROM relation_cards; DELETE FROM workspace_instances; DELETE FROM logical_workspaces')
 for(const entry of active)write(db,entry.kind,entry.content)
 if(stamp!==projectionStamp(db))changed.add(db)
}
