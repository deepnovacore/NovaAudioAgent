import {createHash} from 'node:crypto'
import {z} from 'zod'

export const sourceSchema=z.object({id:z.string().min(1),version:z.number().int().nonnegative(),text:z.string().min(1).max(64000),origin:z.enum(['user','assistant','public','import']),context:z.string().max(16000).optional(),observed_at:z.iso.datetime({offset:true}).optional(),timezone:z.string().min(1).max(100).optional()}).strict()
export type EvidenceSource=z.infer<typeof sourceSchema>
export const candidatePatchSchema=z.object({title:z.string().trim().min(1).max(200).optional(),note:z.string().max(1000).optional(),due:z.string().date().nullable().optional(),status:z.enum(['open','doing','waiting','done','cancelled','active','archived','paused','completed']).optional()}).strict()
const inputSchema=z.object({source_id:z.string(),source_version:z.number().int(),span:z.object({start:z.number().int().nonnegative(),end:z.number().int().positive(),quote:z.string().min(1)}).strict(),kind:z.enum(['todo','idea','goal','profile']),text:z.string().min(1).max(1000),operation:z.enum(['record','update']).optional(),patch:candidatePatchSchema.optional()}).strict()
export type Candidate=z.infer<typeof inputSchema>&{id:string}
export const decisionSchema=z.object({attribution:z.enum(['user','other','uncertain']),modality:z.enum(['commitment','request','preference','aspiration','tentative','rejected','uncertain']),support:z.enum(['supported','contradicted','insufficient']),importance:z.enum(['transient','useful','lasting','critical']),capture:z.enum(['explicit','suggested','none']).optional(),probabilities:z.record(z.string(),z.record(z.string(),z.number().min(0).max(1))).optional()}).strict()
export type CandidateDecision=z.infer<typeof decisionSchema>
export type CandidateJudge=(source:EvidenceSource,candidates:Candidate[],signal:AbortSignal)=>Promise<Record<string,CandidateDecision>>
export interface EvaluatedCandidate {candidate:Candidate;source:EvidenceSource;decision:CandidateDecision;status:'proposed'|'withheld';reasons:string[]}
/** Offsets use JS UTF-16 code units. The exact quote is checked before any model call. */
export function validateCandidate(source:EvidenceSource,raw:unknown):Candidate{
 sourceSchema.parse(source)
 const c=inputSchema.parse(raw)
 if(c.source_id!==source.id||c.source_version!==source.version)throw Error('candidate_stale_source')
 if(c.span.end<=c.span.start||source.text.slice(c.span.start,c.span.end)!==c.span.quote||c.span.end>source.text.length)throw Error('candidate_invalid_span')
 if(c.operation!=='update'&&Object.keys(c.patch??{}).some(key=>key!=='due'))throw Error('candidate_update_operation_required')
 if(c.operation==='update'&&(c.kind==='profile'||!c.patch||!Object.keys(c.patch).length))throw Error('candidate_invalid_update')
 if(c.patch?.due!==undefined&&c.kind!=='todo')throw Error('candidate_invalid_due')
 if(c.patch?.due!==undefined&&(!source.observed_at||!source.timezone))throw Error('candidate_missing_time_anchor')
 if(c.patch?.status!==undefined){const allowed=c.kind==='todo'?['open','doing','waiting','done','cancelled']:c.kind==='idea'?['active','archived']:c.kind==='goal'?['active','paused','completed','archived']:[];if(!allowed.includes(c.patch.status))throw Error('candidate_invalid_status')}
 const id=createHash('sha256').update(JSON.stringify([source.id,source.version,source.text,c.span,c.kind,c.text,...(c.operation?[c.operation]:[]),...(c.patch?[c.patch]:[])])).digest('hex')
 return {...c,id}
}
function policy(source:EvidenceSource,c:Candidate,d:CandidateDecision):string[]{
 const reasons:string[]=[]
 if(d.capture==='none')reasons.push('no_record')
 if(source.origin!=='user')reasons.push('not_direct_user_source')
 if(d.attribution!=='user')reasons.push('not_user_attribution')
 if(d.support!=='supported')reasons.push('not_supported')
 if(d.modality==='rejected'||d.modality==='uncertain')reasons.push('unconfirmed_modality')
 if(c.kind==='todo'&&!['commitment','request'].includes(d.modality))reasons.push('no_action_commitment')
 if(c.kind==='profile'&&d.modality!=='preference')reasons.push('not_stated_preference')
 return reasons
}
export async function evaluateCandidates(source:EvidenceSource,candidates:Candidate[],judge:CandidateJudge,signal:AbortSignal):Promise<EvaluatedCandidate[]>{
 const snapshot=sourceSchema.parse(source)
 if(candidates.length>32)throw Error('candidate_batch_limit')
 const checked=candidates.map(({id,...raw})=>{const c=validateCandidate(snapshot,raw);if(c.id!==id)throw Error('candidate_id_mismatch');return c})
 if(new Set(checked.map(c=>c.id)).size!==checked.length)throw Error('duplicate_candidate')
 signal.throwIfAborted()
 if(!checked.length)return []
 const results=await judge(structuredClone(snapshot),structuredClone(checked),signal)
 signal.throwIfAborted()
 if(Object.keys(results).length!==checked.length||Object.keys(results).some(id=>!checked.some(c=>c.id===id)))throw Error('incomplete_decisions')
 return checked.map(candidate=>{const decision=decisionSchema.parse(results[candidate.id]),reasons=policy(snapshot,candidate,decision);return {candidate,source:structuredClone(snapshot),decision,status:reasons.length?'withheld':'proposed',reasons}})
}
/** Call at the explicit accept action; this function never mutates domain state. */
export function assertAcceptable(row:EvaluatedCandidate,currentSource:EvidenceSource):void{
 sourceSchema.parse(currentSource)
 if(JSON.stringify(sourceSchema.parse(row.source))!==JSON.stringify(sourceSchema.parse(currentSource)))throw Error('candidate_stale_source')
 const {id,...raw}=row.candidate
 if(validateCandidate(currentSource,raw).id!==id)throw Error('candidate_id_mismatch')
 if(row.status!=='proposed'||policy(currentSource,row.candidate,decisionSchema.parse(row.decision)).length)throw Error('candidate_withheld')
}
