import { z } from 'zod'
import { jsonValueSchema } from './events.js'
import { memoryRefSchema, type MemoryRef } from './memory.js'

export const DEFAULT_COOLDOWN = 60
export const SELECTED_WAKE_KIND = 'suggestion_selected'

export const suggestionOriginSchema = z.enum(['fast_brain', 'surrogate', 'executor'])
export const suggestionKindSchema = z.enum(['question', 'notify', 'followup'])
export const suggestionStatusSchema = z.enum(['pending', 'fired', 'withdrawn', 'expired'])
export const suggestionDeliveryPolicySchema = z.enum(['once', 'while_condition_true'])

const suggestionContentSchema = z.record(z.string(), jsonValueSchema)
const conditionKeySchema = z.string().min(1).max(128)

export interface Suggestion {
  readonly id: string
  readonly origin: z.infer<typeof suggestionOriginSchema>
  readonly kind: z.infer<typeof suggestionKindSchema>
  readonly content: Readonly<Record<string, z.infer<typeof jsonValueSchema>>>
  readonly evidence_refs: readonly MemoryRef[]
  readonly salience: number
  readonly delivery_policy: z.infer<typeof suggestionDeliveryPolicySchema>
  readonly condition_key: string | null
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
  readonly #conditionEvidence = new Map<string, Set<MemoryRef>>()
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
    readonly delivery_policy?: z.infer<typeof suggestionDeliveryPolicySchema>
    readonly condition_key?: string
  }): Suggestion {
    const deliveryPolicy = suggestionDeliveryPolicySchema.parse(input.delivery_policy ?? 'once')
    if (deliveryPolicy === 'while_condition_true' && input.condition_key === undefined) {
      throw new TypeError('while_condition_true requires a condition key')
    }
    if (deliveryPolicy === 'once' && input.condition_key !== undefined) {
      throw new TypeError('once delivery cannot have a condition key')
    }
    this.#sequence += 1
    const evidenceRefs = z.array(memoryRefSchema).parse(input.evidence_refs ?? [])
    const suggestion: Suggestion = {
      id: `s-${this.#sequence}`,
      origin: suggestionOriginSchema.parse(input.origin),
      kind: suggestionKindSchema.parse(input.kind),
      content: structuredClone(suggestionContentSchema.parse(input.content)),
      evidence_refs: evidenceRefs,
      salience: finiteNumber(input.salience ?? 0, 'suggestion salience'),
      delivery_policy: deliveryPolicy,
      condition_key: deliveryPolicy === 'while_condition_true'
        ? conditionKeySchema.parse(input.condition_key)
        : null,
      cooldown_until: 0,
      expires_at: input.expires_at ?? Number.POSITIVE_INFINITY,
      status: 'pending',
    }
    if (Number.isNaN(suggestion.expires_at)) throw new TypeError('suggestion expiry cannot be NaN')
    this.#items = [...this.#items, suggestion]
    if (deliveryPolicy === 'while_condition_true') {
      this.#conditionEvidence.set(suggestion.id, new Set(evidenceRefs))
    }
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
    this.#items[index] = {
      ...current,
      status: 'fired',
      // A cooldown is a repeat-reminder interval, not a generic fired timestamp.
      cooldown_until: current.delivery_policy === 'while_condition_true' ? now + cooldown : 0,
    }
  }

  withdraw(id: string): boolean {
    const index = this.#items.findIndex(item => item.id === id)
    const current = this.#items[index]
    if (current?.status !== 'pending') return false
    this.#items[index] = {...current, status: 'withdrawn'}
    this.#conditionEvidence.delete(current.id)
    return true
  }

  refreshCondition(input: {
    readonly condition_key: string
    readonly now: number
    readonly evidence_ref: MemoryRef
    readonly content: Readonly<Record<string, z.infer<typeof jsonValueSchema>>>
  }): boolean {
    const conditionKey = conditionKeySchema.parse(input.condition_key)
    const now = finiteNumber(input.now, 'condition refresh timestamp')
    const evidenceRef = memoryRefSchema.parse(input.evidence_ref)
    const content = structuredClone(suggestionContentSchema.parse(input.content))
    for (let index = this.#items.length - 1; index >= 0; index -= 1) {
      const item = this.#items[index]
      if (
        item?.delivery_policy !== 'while_condition_true'
        || item.condition_key !== conditionKey
        || item.status !== 'fired'
        || now < item.cooldown_until
        || now >= item.expires_at
        || (this.#conditionEvidence.get(item.id) ?? new Set(item.evidence_refs)).has(evidenceRef)
      ) continue
      this.#items[index] = {
        ...item,
        content,
        evidence_refs: [evidenceRef],
        cooldown_until: 0,
        status: 'pending',
      }
      const seen = this.#conditionEvidence.get(item.id) ?? new Set(item.evidence_refs)
      seen.add(evidenceRef)
      this.#conditionEvidence.set(item.id, seen)
      return true
    }
    return false
  }

  clearCondition(conditionKey: string): boolean {
    const parsed = conditionKeySchema.parse(conditionKey)
    let cleared = false
    this.#items = this.#items.map(item => {
      if (
        item.delivery_policy !== 'while_condition_true'
        || item.condition_key !== parsed
        || (item.status !== 'pending' && item.status !== 'fired')
      ) return item
      cleared = true
      this.#conditionEvidence.delete(item.id)
      return {...item, status: 'withdrawn'}
    })
    return cleared
  }
}

function finiteNumber(value: number, field: string): number {
  if (!Number.isFinite(value)) throw new TypeError(`${field} must be finite`)
  return value
}
