import {z} from 'zod'
import type {MemoryEntry} from '../memory/entry.js'
import {versionSchema} from './contracts.js'

export const memoryOverviewSchema = z.object({
  summary: z.string().trim().min(1).max(500),
  sections: z.array(z.object({
    title: z.string().trim().min(1).max(40),
    summary: z.string().trim().min(1).max(500),
    keywords: z.array(z.string().trim().min(1).max(40)).max(5),
    refs: z.array(z.object({entry_id: z.string().min(1).max(256), version: versionSchema}).strict()).min(1).max(100),
  }).strict()).min(1).max(4),
}).strict()
export type MemoryOverview = z.infer<typeof memoryOverviewSchema>

export function validateMemoryOverview(value: unknown, entries: readonly MemoryEntry[]): MemoryOverview | null {
  const parsed = memoryOverviewSchema.safeParse(value)
  if (!parsed.success) return null
  const active = new Map(entries.filter(entry => entry.status === 'active').map(entry => [entry.id, entry.version]))
  return parsed.data.sections.every(section => section.refs.every(ref => active.get(ref.entry_id) === ref.version)) ? parsed.data : null
}
