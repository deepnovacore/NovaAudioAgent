/**
 * The three model ports backed by one provider-neutral gateway.
 *
 * Ports `src/nova_audio_agent/model_adapters.py`. The prompts and tool schemas these
 * assemble are model-visible and pinned by their own goldens; this module owns the
 * decode side: turning provider tool calls back into typed actions without ever
 * retaining a malformed payload.
 */

import { z } from 'zod'
import type { ContextView } from './context-view.js'
import type { ProactivityPreset } from './config.js'
import type { JsonValue } from './events.js'
import type { MemoryItem } from './memory.js'
import type { GatewayImage, ModelGateway } from './model-gateway.js'
import type { UpdateSpec } from './ports.js'
import {progressClassSchema} from './ports.js'
import {
  COMPRESSOR_SYSTEM,
  FASTBRAIN_SYSTEM,
  pythonJsonDumps,
  renderContextView,
  renderFastBrainContext,
  surrogateSystemPrompt,
} from './prompting.js'
import type { CompiledTools, ToolBinding } from './tool-schema.js'
import {stripLikePython} from './python-text.js'

/** JSON Schema handed to the provider so the Surrogate answers in one shape. */
export const SURROGATE_SCHEMA: Readonly<Record<string, JsonValue>> = {
  type: 'object',
  properties: {
    speak: {type: 'boolean'},
    suggestion_id: {type: ['string', 'null']},
    progress_class: {
      type: ['string', 'null'],
      enum: ['routine_delta', 'milestone', 'blocker', 'action_required', null],
    },
    reason: {type: 'string'},
  },
  required: ['speak', 'suggestion_id', 'progress_class', 'reason'],
  additionalProperties: false,
}

export interface TextDelta {
  readonly kind: 'text'
  readonly text: string
}

export interface DelegateAction {
  readonly act: 'delegate'
  readonly delegate: {
    readonly executor: string
    readonly op: string
    readonly request: Readonly<Record<string, JsonValue>>
    readonly origin_ref: string
  }
}

export interface UpdateAction {
  readonly act: 'update'
  readonly update: UpdateSpec
}

export interface ActionDelta {
  readonly kind: 'action'
  readonly action: DelegateAction | UpdateAction
}

export interface ContractFailureDelta {
  readonly kind: 'contract_failure'
  readonly code: string
  readonly tool_name: string | null
}

export type FastBrainDelta = TextDelta | ActionDelta | ContractFailureDelta

export interface MediaVisibility {
  /** Per-ref visibility labels rendered under the visual-availability heading. */
  readonly states: Readonly<Record<string, string>>
  readonly images: readonly GatewayImage[]
}

export interface MediaSelector {
  select(view: ContextView): MediaVisibility
}

export interface FastBrainOptions {
  readonly gateway: ModelGateway
  readonly model: string
  readonly tools: CompiledTools
  readonly media?: MediaSelector
  readonly system?: string
  readonly includeTrigger?: boolean
}

export class GatewayFastBrain {
  readonly #gateway: ModelGateway
  readonly #model: string
  readonly #tools: CompiledTools
  readonly #media: MediaSelector | undefined
  readonly #system: string
  readonly #includeTrigger: boolean

  constructor(options: FastBrainOptions) {
    this.#gateway = options.gateway
    this.#model = options.model
    this.#tools = options.tools
    this.#media = options.media
    this.#system = options.system ?? FASTBRAIN_SYSTEM
    this.#includeTrigger = options.includeTrigger ?? false
  }

  async *call(view: ContextView, signal?: AbortSignal): AsyncIterable<FastBrainDelta> {
    const active = toolsForTrigger(this.#tools, view.trigger_kind, this.#includeTrigger)
    // Tool calls stream as fragments keyed by index; name and arguments both arrive in
    // pieces and are only decodable once the stream ends.
    const calls = new Map<number, {name: string, arguments: string}>()

    const visibility = this.#media?.select(view)
    const prompt = visibility === undefined
      ? renderContextView(view, this.#includeTrigger)
      : renderFastBrainContext(view, visibility.states, this.#includeTrigger)

    for await (const delta of this.#gateway.stream({
      model: this.#model,
      system: this.#system,
      prompt,
      tools: active.schemas,
      ...(visibility === undefined ? {} : {images: visibility.images}),
      ...(signal === undefined ? {} : {signal}),
    })) {
      if (delta.kind === 'text') {
        yield {kind: 'text', text: delta.text}
        continue
      }
      const slot = calls.get(delta.index) ?? {name: '', arguments: ''}
      slot.name += delta.name
      slot.arguments += delta.arguments
      calls.set(delta.index, slot)
    }

    for (const index of [...calls.keys()].sort((left, right) => left - right)) {
      const slot = calls.get(index)!
      yield decodeToolCall(active, slot.name, slot.arguments)
    }
  }
}

/**
 * Drop Codex tools when the wake was not a user turn.
 *
 * A background trigger must not be able to start new development work; only an
 * explicit user turn can.
 */
export function toolsForTrigger(
  tools: CompiledTools,
  triggerKind: string | null,
  enabled: boolean,
): CompiledTools {
  if (!enabled || triggerKind === 'user_input') return tools
  const bindings = new Map(
    [...tools.bindings].filter(([, binding]) => binding.executor !== 'codex'),
  )
  const schemas = tools.schemas.filter(schema => {
    const declared = schema.function
    const name = typeof declared === 'object' && declared !== null && !Array.isArray(declared)
      ? declared.name
      : undefined
    return typeof name === 'string' && bindings.has(name)
  })
  return {schemas, bindings}
}

const toolArgumentsSchema = z.record(z.string(), z.unknown())

export function decodeToolCall(
  tools: CompiledTools,
  name: string,
  rawArguments: string,
): ActionDelta | ContractFailureDelta {
  const binding = tools.bindings.get(name)
  if (binding === undefined) {
    return {kind: 'contract_failure', code: 'unknown_tool', tool_name: name === '' ? null : name}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArguments)
  } catch {
    return {kind: 'contract_failure', code: 'invalid_tool_arguments', tool_name: name}
  }
  // A non-object, or any number JSON cannot represent as a finite binary64, is a
  // contract failure. The malformed payload itself is never retained.
  if (
    Array.isArray(parsed)
    || !toolArgumentsSchema.safeParse(parsed).success
    || !isFiniteBinary64Json(parsed)
  ) {
    return {kind: 'contract_failure', code: 'invalid_tool_arguments', tool_name: name}
  }
  const argumentsObject = parsed as Record<string, JsonValue>

  if (binding.kind === 'update') {
    if (binding.target === null) {
      return {kind: 'contract_failure', code: 'invalid_tool_arguments', tool_name: name}
    }
    return {
      kind: 'action',
      action: {act: 'update', update: {target: binding.target, delta: argumentsObject}},
    }
  }
  return decodeDelegate(binding, name, argumentsObject)
}

function decodeDelegate(
  binding: ToolBinding,
  name: string,
  argumentsObject: Record<string, JsonValue>,
): ActionDelta | ContractFailureDelta {
  const {origin_ref: originRef, ...request} = argumentsObject
  if (typeof originRef !== 'string' || originRef === '') {
    return {kind: 'contract_failure', code: 'missing_origin_ref', tool_name: name}
  }
  if (binding.executor === null || binding.op === null) {
    return {kind: 'contract_failure', code: 'unknown_tool', tool_name: name}
  }
  return {
    kind: 'action',
    action: {
      act: 'delegate',
      delegate: {executor: binding.executor, op: binding.op, request, origin_ref: originRef},
    },
  }
}

/** Whether every number in the value is representable as a finite binary64. */
export function isFiniteBinary64Json(value: unknown): boolean {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isFiniteBinary64Json)
  if (typeof value === 'object') {
    return Object.entries(value).every(([key, item]) =>
      typeof key === 'string' && isFiniteBinary64Json(item))
  }
  return false
}

const surrogateResponseSchema = z.object({
  speak: z.boolean(),
  suggestion_id: z.string().nullable(),
  progress_class: progressClassSchema,
  reason: z.string(),
}).loose()

export interface SurrogateVerdict {
  readonly speak: boolean
  readonly suggestion_id: string | null
  readonly progress_class: z.infer<typeof progressClassSchema>
  readonly reason: string
}

export class GatewaySurrogate {
  readonly #gateway: ModelGateway
  readonly #model: string
  readonly #proactivityPreset: ProactivityPreset

  constructor(options: {
    readonly gateway: ModelGateway
    readonly model: string
    readonly proactivityPreset: ProactivityPreset
  }) {
    this.#gateway = options.gateway
    this.#model = options.model
    this.#proactivityPreset = options.proactivityPreset
  }

  async watch(view: ContextView, signal?: AbortSignal): Promise<SurrogateVerdict> {
    const response = await this.#gateway.complete({
      model: this.#model,
      system: surrogateSystemPrompt(this.#proactivityPreset),
      prompt: renderContextView(view),
      jsonSchema: SURROGATE_SCHEMA,
      ...(signal === undefined ? {} : {signal}),
    })
    let value: unknown
    try {
      value = JSON.parse(response.text)
    } catch {
      throw new TypeError('Surrogate 输出不是合法 JSON')
    }
    const parsed = surrogateResponseSchema.safeParse(value)
    if (!parsed.success) throw new TypeError('Surrogate 输出不符合契约')
    return {
      speak: parsed.data.speak,
      suggestion_id: parsed.data.suggestion_id,
      progress_class: parsed.data.progress_class,
      reason: parsed.data.reason,
    }
  }
}

/**
 * The compressor prompt, rendered the way the oracle's `json.dumps` renders it.
 *
 * The oracle serializes this with `prompt_json`, so keys sort by code point and numbers
 * follow ECMAScript rules. That makes a plain serialization correct: no field needs its
 * own spelling, and the golden pins the result.
 */
export function compressorPrompt(items: readonly MemoryItem[]): string {
  // Now that the oracle routes this through prompt_json, ts follows ECMAScript number
  // rules like every other value, so the whole item serializes uniformly and no field
  // needs hand-emitting.
  return pythonJsonDumps(items.map(item => ({
    ref: `${item.channel}:${item.seq}`,
    ts: item.ts,
    trust: item.trust,
    outcome: item.outcome,
    content: item.content,
    refs: [...item.refs],
  })))
}

export class GatewayCompressor {
  readonly #gateway: ModelGateway
  readonly #model: string

  constructor(options: {readonly gateway: ModelGateway, readonly model: string}) {
    this.#gateway = options.gateway
    this.#model = options.model
  }

  async compress(items: readonly MemoryItem[], signal?: AbortSignal): Promise<string> {
    const response = await this.#gateway.complete({
      model: this.#model,
      system: COMPRESSOR_SYSTEM,
      prompt: compressorPrompt(items),
      ...(signal === undefined ? {} : {signal}),
    })
    return stripLikePython(response.text)
  }
}
