import {canonicalJson} from '../text/canonical-json.js'
import type {LedgerDatabase} from '../memory-ledger/store.js'
import type {LogicalWorkspace,WorkspaceInstance,RelationCard} from '../memory-ledger/models.js'
import {contentHash,memoryOperation,EntryRevisionSchema} from './store.js'

/** Existing graph tables are materialized views; retain their typed content in the shared log. */
export function recordWorkspaceRevision<T extends LogicalWorkspace|WorkspaceInstance|RelationCard>(db:LedgerDatabase,kind:'LogicalWorkspace'|'WorkspaceInstance'|'RelationCard',card:T):T {
 const key='logical_workspace_id' in card && 'aliases' in card?card.logical_workspace_id:'instance_id' in card?card.instance_id:canonicalJson([card.source_logical_id,card.target_logical_id,card.relation_type])
 const entryId='workspace:'+kind+':'+contentHash(key)
 const time='updated_at' in card?card.updated_at:card.last_seen_at
 const observedAt=new Date(time*1000).toISOString()
 const references='evidence_refs' in card?card.evidence_refs:[]
 const refs:string[]=[]
 // Identity records originate in a host-observed repository snapshot, never model narration.
 const identityRefs=references.length?references:[{source:'filesystem',ref:'path_label' in card?card.path_label:'canonical_remote' in card?card.canonical_remote??key:key,observed_at:time}]
 for(const ref of identityRefs){
  const evidenceId='workspace:e:'+contentHash(canonicalJson([ref.source,ref.ref,ref.observed_at]))
  memoryOperation(db,'append_evidence',{id:evidenceId,source_id:'workspace:'+ref.source+':'+contentHash(ref.ref),source_kind:ref.source==='user'?'conversation':ref.source==='executor'?'task_result':'file',locator:ref.ref,observed_at:new Date(ref.observed_at*1000).toISOString(),recorded_at:observedAt,raw_text:null,extracted:{},hash:contentHash(canonicalJson(ref)),trust:ref.source==='user'?'trusted_user':ref.source==='executor'?'trusted_system':'untrusted_external'},false)
  refs.push(evidenceId)
 }
 const revision=EntryRevisionSchema.parse(memoryOperation(db,'merge',{entry_id:entryId,kind,origin:'inferred',written_by:'merge',evidence_refs:refs,content:card,recorded_at:observedAt},false))
 return revision.content as unknown as T
}
