import {z} from 'zod'
import type {lifeInputSchema} from '../personal-agent/life.js'
import type {EntryRevision} from './store.js'

/** Host-owned fences cover every old entry sent to either model call, including unselected entries. */
export const resolutionContextSchema=z.object({entry_id:z.string().min(1).max(512),revision:z.number().int().positive(),stamp:z.string().min(1).max(128)}).strict()
export type ResolutionContext=z.infer<typeof resolutionContextSchema>
export const resolutionSchema=z.object({decisions:z.array(z.object({
 candidate_index:z.number().int().min(0).max(7),action:z.enum(['add','update','no_change']),target_id:z.string().min(1).max(512).nullable(),
}).strict()).max(8)}).strict()
export type ResolutionDecision=z.infer<typeof resolutionSchema>['decisions'][number]

/** The model selects identity only from supplied same-user, same-kind targets; it never supplies authority. */
export function validateResolution(value:unknown,candidates:readonly {kind:string}[],context:readonly EntryRevision[]):ResolutionDecision[]{
 const {decisions}=resolutionSchema.parse(value)
 if(decisions.length!==candidates.length)throw Error('STORE_INVALID_RESOLUTION')
 const indexes=new Set<number>(),targets=new Set<string>(),entries=new Map(context.map(entry=>[entry.entry_id,entry]))
 for(const decision of decisions){
  const candidate=candidates[decision.candidate_index]
  if(!candidate||indexes.has(decision.candidate_index))throw Error('STORE_INVALID_RESOLUTION')
  indexes.add(decision.candidate_index)
  if(decision.action==='add'){if(decision.target_id!==null)throw Error('STORE_INVALID_RESOLUTION');continue}
  const entry=decision.target_id===null?undefined:entries.get(decision.target_id)
  if(entry?.kind!==candidate.kind||targets.has(entry.entry_id))throw Error('STORE_INVALID_RESOLUTION')
  targets.add(entry.entry_id)
 }
 return decisions.sort((a,b)=>a.candidate_index-b.candidate_index)
}

/** The host binds every old item shown to the resolver, including add and no-change results. */
export const lifeResolutionSchema=z.object({provider:z.string().min(1).max(512),contexts:z.array(resolutionContextSchema).max(4),decision:resolutionSchema.shape.decisions.element}).strict()
export type LifeResolution=z.infer<typeof lifeResolutionSchema>
export type LifeCandidateInput=Extract<z.infer<typeof lifeInputSchema>,{op:'create'|'update'}>
export interface ResolvedLifeCandidate {input:LifeCandidateInput|null;resolution:LifeResolution}
