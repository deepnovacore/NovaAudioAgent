import { z } from 'zod'
import { jsonValueSchema } from './events.js'
import { memoryRefSchema, type MemoryRef } from './memory.js'

export const DEFAULT_COOLDOWN = 60
export const SELECTED_WAKE_KIND = 'suggestion_selected'

export const suggestionOriginSchema = z.enum(['fast_brain', 'surrogate', 'executor'])
export const suggestionKindSchema = z.enum(['question', 'notify', 'followup'])
export const suggestionStatusSchema = z.enum(['pending', 'fired', 'withdrawn', 'expired'])

const suggestionContentSchema = z.record(z.string(), jsonValueSchema)

export interface Suggestion {
  readonly id: string
  readonly origin: z.infer<typeof suggestionOriginSchema>
  readonly kind: z.infer<typeof suggestionKindSchema>
  readonly content: Readonly<Record<string, z.infer<typeof jsonValueSchema>>>
  readonly evidence_refs: readonly MemoryRef[]
  readonly salience: number
  readonly cooldown_until: number
  readonly expires_at: number
  readonly status: z.infer<typeof suggestionStatusSchema>
}

export function isSuggestionAvailable(suggestion: Suggestion, now: number): boolean {
  return suggestion.status === 'pending' && now < suggestion.expires_at
}

export class SuggestionPool {
  #items: Suggestion[] = []
  #sequence = 0
  readonly #defaultCooldown: number

  constructor(options: {readonly defaultCooldown?: number} = {}) {
    this.#defaultCooldown = options.defaultCooldown ?? DEFAULT_COOLDOWN
    if (!Number.isFinite(this.#defaultCooldown) || this.#defaultCooldown < 0) {
      throw new RangeError('default cooldown must be finite and non-negative')
    }
  }

  add(input: {
    readonly origin: z.infer<typeof suggestionOriginSchema>
    readonly kind: z.infer<typeof suggestionKindSchema>
    readonly content: Readonly<Record<string, z.infer<typeof jsonValueSchema>>>
    readonly evidence_refs?: readonly MemoryRef[]
    readonly salience?: number
    readonly expires_at?: number
  }): Suggestion {
    this.#sequence += 1
    const suggestion: Suggestion = {
      id: `s-${this.#sequence}`,
      origin: suggestionOriginSchema.parse(input.origin),
      kind: suggestionKindSchema.parse(input.kind),
      content: structuredClone(suggestionContentSchema.parse(input.content)),
      evidence_refs: z.array(memoryRefSchema).parse(input.evidence_refs ?? []),
      salience: finiteNumber(input.salience ?? 0, 'suggestion salience'),
      cooldown_until: 0,
      expires_at: input.expires_at ?? Number.POSITIVE_INFINITY,
      status: 'pending',
    }
    if (Number.isNaN(suggestion.expires_at)) throw new TypeError('suggestion expiry cannot be NaN')
    this.#items = [...this.#items, suggestion]
    return suggestion
  }

  get(id: string): Suggestion | undefined {
    return this.#items.find(item => item.id === id)
  }

  all(): readonly Suggestion[] {
    return [...this.#items]
  }

  fire(id: string, now: number, cooldown = this.#defaultCooldown): void {
    const index = this.#items.findIndex(item => item.id === id)
    const current = this.#items[index]
    if (current?.status !== 'pending') return
    finiteNumber(now, 'fire timestamp')
    finiteNumber(cooldown, 'suggestion cooldown')
    if (cooldown < 0) throw new RangeError('suggestion cooldown cannot be negative')
    this.#items[index] = {...current, status: 'fired', cooldown_until: now + cooldown}
  }

  withdraw(id: string): boolean {
    const index = this.#items.findIndex(item => item.id === id)
    const current = this.#items[index]
    if (current?.status !== 'pending') return false
    this.#items[index] = {...current, status: 'withdrawn'}
    return true
  }

  rearmFrom(channel: string, now: number): void {
    for (const [index, item] of this.#items.entries()) {
      if (item.status !== 'fired' || now < item.cooldown_until || now >= item.expires_at) continue
      if (item.evidence_refs.some(reference => reference.startsWith(`${channel}:`))) {
        this.#items[index] = {...item, status: 'pending'}
      }
    }
  }
}

function finiteNumber(value: number, field: string): number {
  if (!Number.isFinite(value)) throw new TypeError(`${field} must be finite`)
  return value
}
