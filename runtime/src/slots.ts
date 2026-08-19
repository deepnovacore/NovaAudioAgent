import { z } from 'zod'
import { routingClassSchema } from './ports.js'

export const SLOTS = ['fast', 'surrogate.watch', 'compress'] as const
export const slotSchema = z.enum(SLOTS)

export const wakeReasonSchema = z.object({
  kind: z.string().min(1),
  priority: z.number().int(),
  routing_class: routingClassSchema.default('ambient'),
  origin: z.string().nullable().default(null),
  selected_suggestion: z.string().nullable().default(null),
}).strict()

export type Slot = z.infer<typeof slotSchema>
export type WakeReason = z.infer<typeof wakeReasonSchema>

const routingRank: Readonly<Record<WakeReason['routing_class'], number>> = {
  user_awaited: 1,
  ambient: 0,
}

export function higherWakeReason(
  current: WakeReason | null,
  candidate: WakeReason,
): WakeReason {
  if (current === null) return candidate
  const currentKey = [current.priority, routingRank[current.routing_class]] as const
  const candidateKey = [candidate.priority, routingRank[candidate.routing_class]] as const
  const winner = candidateKey[0] > currentKey[0]
    || (candidateKey[0] === currentKey[0] && candidateKey[1] > currentKey[1])
    ? candidate
    : current
  if (
    winner.routing_class !== 'user_awaited'
    && (current.routing_class === 'user_awaited' || candidate.routing_class === 'user_awaited')
  ) return {...winner, routing_class: 'user_awaited'}
  return winner
}

export class SlotSet {
  readonly inflight: Record<Slot, boolean> = {
    fast: false,
    'surrogate.watch': false,
    compress: false,
  }
  readonly pending: Record<Slot, WakeReason | null> = {
    fast: null,
    'surrogate.watch': null,
    compress: null,
  }
  readonly activeJobId: Record<Slot, string | null> = {
    fast: null,
    'surrogate.watch': null,
    compress: null,
  }
  readonly #spawn: (slot: Slot, reason: WakeReason) => string

  constructor(spawn: (slot: Slot, reason: WakeReason) => string) {
    this.#spawn = spawn
  }

  wake(slot: Slot, reason: WakeReason): void {
    const parsed = wakeReasonSchema.parse(reason)
    if (this.inflight[slot]) {
      this.pending[slot] = higherWakeReason(this.pending[slot], parsed)
      return
    }
    this.inflight[slot] = true
    try {
      this.activeJobId[slot] = this.#spawn(slot, parsed)
    } catch (error) {
      this.inflight[slot] = false
      throw error
    }
  }

  onDone(slot: Slot, jobId: string, consume: () => void): void {
    if (!this.inflight[slot] || this.activeJobId[slot] !== jobId) {
      throw new Error(`stale model completion: ${slot}/${jobId}`)
    }
    let reason: WakeReason | null = null
    try {
      // Runs before the slot is cleared, so a wake raised while consuming this
      // output is still merged into `pending` instead of spawning a second job.
      consume()
    } finally {
      // Release the slot even if consumption threw. A wedged `inflight` flag
      // would silently stop this slot from ever waking again, turning one
      // contract failure into a permanently deaf runtime.
      reason = this.pending[slot]
      this.pending[slot] = null
      this.inflight[slot] = false
      this.activeJobId[slot] = null
    }
    if (reason !== null) this.wake(slot, reason)
  }
}
