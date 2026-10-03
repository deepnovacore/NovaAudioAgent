import {processingGrantSchema} from '../memory-substrate/source-state.js'
import {z} from 'zod'

const text = (max: number) => z.string().min(1).max(max).refine(value => !value.includes('\0'))
export const MemorySourceRefSchema = z.object({
  type: z.enum(['conversation', 'file', 'mail', 'calendar', 'task', 'im']),
  ref: text(256),
  observed_at: z.iso.datetime({offset: true}),
}).strict()
export const MemoryVersionSchema = z.union([z.number().int().positive(), text(256), z.null()])
export const LifeMemorySchema = z.object({
  id:text(256),version:z.number().int().nonnegative(),
  status:z.enum(['open','doing','waiting','done','cancelled','active','paused','completed','archived']),
  due:z.string().date().nullable(),goal_id:z.string().nullable(),idea_id:z.string().nullable(),
  success_criteria:z.string().max(2000).nullable(),
}).strict()
export const MemoryEntrySchema = z.object({
  id: text(256), version: MemoryVersionSchema, content: z.string().max(500),
  kind: z.enum(['fact', 'preference', 'plan', 'concern', 'commitment', 'entity', 'topic', 'todo', 'idea', 'goal', 'profile']),
  life:LifeMemorySchema.optional(),
  editable:z.boolean().optional(),
  commitment:z.object({direction:z.enum(['owed_by_me','owed_to_me']),due:z.iso.datetime({offset:true}).nullable(),status:z.enum(['open','done','dropped']),counterparty:z.string().optional()}).strict().optional(), origin: z.enum(['stated', 'inferred']),
  source_refs: z.array(MemorySourceRefSchema).min(1).max(256),
  evidence_refs: z.array(text(600)).max(256).optional(),
  observed_at: z.iso.datetime({offset: true}), recorded_at: z.iso.datetime({offset: true}),
  topic: z.string().max(256), status: z.enum(['active', 'corrected', 'forgotten', 'expired']),
  corrected_to: z.string().max(500).nullable(), confidence_note: z.string().max(500).nullable(),
}).strict()
export type MemorySourceRef = z.infer<typeof MemorySourceRefSchema>
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>
/** Completed objects remain readable, but must not create another action reminder. */
export function memoryEligibleForDiscovery(entry:MemoryEntry|null|undefined):entry is MemoryEntry {
  return entry?.status==='active'&&entry.version!==null
    &&(entry.commitment===undefined||entry.commitment.status==='open')
    &&(entry.life===undefined||['open','doing','waiting','active'].includes(entry.life.status))
}
export type MemoryVersion = z.infer<typeof MemoryVersionSchema>
export interface MemoryCapabilities {readonly list:boolean;readonly get:boolean;readonly correct:boolean;readonly forgetEntry:boolean;readonly forgetSource:boolean;readonly observeSource?:boolean}
export const MemoryListOptionsSchema = z.object({cursor:text(256).optional(),limit:z.number().int().min(1).max(100).optional(),include_expired:z.boolean().optional()}).strict()
export type MemoryListOptions = z.infer<typeof MemoryListOptionsSchema>
export const MemoryPageSchema = z.object({entries:z.array(MemoryEntrySchema).max(100),cursor:z.string().nullable()}).strict()
export type MemoryPage = z.infer<typeof MemoryPageSchema>

export const MemoryObservationSchema = z.object({source_ref:MemorySourceRefSchema,content:text(500),topic:text(80).optional(),embedding_consent:z.boolean().optional(),processing_consent:processingGrantSchema.optional(),evidence_ids:z.array(text(600)).min(1).max(2).optional()}).strict()
export type MemoryObservation = z.infer<typeof MemoryObservationSchema>
