/**
 * Translate admitted realtime tool proposals into existing Runtime dispatch.
 *
 * Ported from `src/nova_audio_agent/realtime/bridge.py`. This is the *only* route by which a
 * provider's tool calls and user transcripts reach the reducer, which is what makes it the place
 * where evidence and authority are checked. Two invariants live here and nowhere else:
 *
 * - A tool proposal must carry an `origin_ref` naming real, visible evidence. The provider may
 *   supply one, but a transcript the host itself ingested outranks it -- a model that has just heard
 *   the user cannot cite something older to justify acting.
 * - Recall is fulfilled inline rather than delegated. It reads the blackboard and returns, so
 *   routing it through an executor would invent a dispatch that nothing is waiting on.
 *
 * Everything else is refusal shaped as a tool result, because a provider protocol left without one
 * stalls: a refused call still gets an item and an intent.
 */

import { createHmac, randomBytes } from 'node:crypto'
import { canonicalJson } from '../canonical-json.js'
import type { JsonValue } from '../events.js'
import { USER_PRIORITY } from '../memory.js'
import type { DelegateRequest, UpdateSpec } from '../ports.js'
import type { WakeReason } from '../slots.js'
import type { CompiledTools } from '../tool-schema.js'
import type { HostContextItem, HostResponseIntent } from './protocol.js'
import type { toolCallReadySchema } from './protocol.js'
import type { z } from 'zod'
import {stripLikePython} from '../python-text.js'

/** The provider event this bridge admits. Derived from the schema so the two cannot drift. */
export type ToolCallReady = z.infer<typeof toolCallReadySchema>
import {
  RecallOriginError,
  compileMemoryRecall,
  encodeMemoryRecall,
  type RecallScope,
  type RecallView,
} from './recall.js'

/** The runtime surface this bridge needs. Narrow on purpose: three calls and three reads. */
export interface BridgeRuntime {
  readonly clock: {now(): number}
  readonly memory: Parameters<typeof compileMemoryRecall>[0]
  readonly executors: ReadonlyMap<string, {readonly manifest: ExecutorManifestLike}>
  ingestUserInput(input: {readonly text: string}): Promise<string>
  updateExternal(spec: UpdateSpec, reason: WakeReason): boolean
  dispatchExternal(
    request: DelegateRequest,
    reason: WakeReason,
  ): {readonly accepted: boolean; readonly delegate_id: string | null}
}

interface OpSpecLike {
  readonly name: string
  readonly params: Readonly<Record<string, JsonValue>>
  readonly sync_result?: boolean
}

interface ExecutorManifestLike {
  readonly ops: readonly OpSpecLike[]
  readonly policy: {readonly suggest?: boolean}
}

export interface ToolAcceptance {
  readonly accepted: boolean
  readonly code: string
  readonly host_item: HostContextItem
  readonly response_intent: HostResponseIntent
  readonly delegate_id: string | null
  /**
   * R105: the accepted op declared `sync_result`, so the host item is a pending tool result the
   * service must resolve, not a delegation acknowledgement.
   */
  readonly sync_result: boolean
  readonly executor: string | null
  readonly op: string | null
  readonly inline_fulfilled: boolean
  readonly telemetry: Readonly<Record<string, JsonValue>> | null
}

/** Longest task summary a delegation acknowledgement will carry. */
const MAX_TASK_SUMMARY = 240

/**
 * `codex.project` multiplexes short project-boundary operations and long-running task execution.
 * The former can produce a confirmation proposal, so acknowledging them as delegated work would
 * let the model speak before it has seen the confirmation question. Keep only `start_session`
 * asynchronous; every immediate project action must resolve through its correlated Handoff.
 */
const SYNCHRONOUS_PROJECT_ACTIONS = new Set([
  'list_workspaces',
  'create_workspace',
  'select_workspace',
  'list_sessions',
  'resume_session',
])

export function requiresSynchronousResult(
  executor: string,
  op: string,
  arguments_: Readonly<Record<string, JsonValue>>,
  declaredSyncResult: boolean,
): boolean {
  if (declaredSyncResult) return true
  return executor === 'codex'
    && op === 'project'
    && typeof arguments_.action === 'string'
    && SYNCHRONOUS_PROJECT_ACTIONS.has(arguments_.action)
}

export class RealtimeRuntimeBridge {
  readonly #runtime: BridgeRuntime
  readonly #tools: CompiledTools
  readonly #idFactory: () => string
  /**
   * Per-process key for hashing recall queries in telemetry.
   *
   * Random per instance and never persisted: the digest exists so two recalls can be recognised as
   * the same question, not so the question can be recovered. A fixed key would make the digests
   * comparable across runs, which is exactly the property that would turn telemetry into a
   * transcript of what users searched for.
   */
  readonly #queryDigestKey: Buffer
  #latestUserOriginRef: string | null = null

  constructor(options: {
    readonly runtime: BridgeRuntime
    readonly tools: CompiledTools
    readonly idFactory: () => string
    /** Test seam only. Production leaves it unset so the key is random. */
    readonly queryDigestKey?: Buffer
  }) {
    this.#runtime = options.runtime
    this.#tools = options.tools
    this.#idFactory = options.idFactory
    this.#queryDigestKey = options.queryDigestKey ?? randomBytes(32)
  }

  /** Apply provider transcript evidence before it can authorize a tool proposal. */
  async acceptUserTranscript(text: string): Promise<string> {
    const originRef = await this.#runtime.ingestUserInput({text})
    this.#latestUserOriginRef = originRef
    return originRef
  }

  /**
   * Admit one tool call, or refuse it with a reason the provider can render.
   *
   * The three binding kinds are genuinely different admissions, not variants of one: an `update`
   * writes structured state and completes immediately, a `query` reads memory and returns its answer
   * inline, and everything else dispatches an executor and returns an acknowledgement.
   */
  acceptToolCall(
    call: ToolCallReady,
    options: {readonly originRef?: string | null} = {},
  ): ToolAcceptance {
    const originRef = options.originRef ?? null
    const binding = this.#tools.bindings.get(call.name)
    if (binding === undefined) return this.#refused(call, 'unknown_tool')
    let reason: WakeReason = {
      kind: 'realtime_tool',
      priority: USER_PRIORITY,
      routing_class: 'user_awaited',
      origin: null,
      selected_suggestion: null,
    }
    if (binding.kind === 'update') {
      const schema = this.#wireParams(call.name)
      if (
        binding.target === undefined
        || binding.target === null
        || schema === null
        || !validParams(call.arguments, schema)
      ) {
        return this.#refused(call, 'invalid_params')
      }
      const accepted = this.#runtime.updateExternal(
        {target: binding.target, delta: {...call.arguments}},
        reason,
      )
      if (!accepted) return this.#refused(call, 'invalid_params')
      const hostItem = this.#toolOutput(call, {state: 'completed'})
      return acceptance({
        accepted: true,
        code: 'completed',
        host_item: hostItem,
        response_intent: toolResultIntent(hostItem),
      })
    }
    if (binding.kind === 'query') return this.#acceptMemoryRecall(call, originRef)
    if (
      binding.executor === undefined || binding.executor === null
      || binding.op === undefined || binding.op === null
    ) {
      return this.#refused(call, 'unsupported_tool')
    }

    const {origin_ref: providerOriginRef, ...arguments_} = call.arguments
    // Host-ingested evidence outranks whatever the provider supplied. A model that has just heard
    // the user must not be able to reach past that transcript to an older reference.
    const resolvedOriginRef = originRef ?? this.#latestUserOriginRef ?? providerOriginRef
    if (typeof resolvedOriginRef !== 'string' || resolvedOriginRef === '') {
      return this.#refused(call, 'missing_origin_ref')
    }
    const adapter = this.#runtime.executors.get(binding.executor)
    const op = adapter?.manifest.ops.find(candidate => candidate.name === binding.op) ?? null
    if (op === null || !validParams(arguments_, op.params)) {
      return this.#refused(call, 'invalid_params')
    }
    if (binding.op === 'start' && adapter?.manifest.policy.suggest === true) {
      // R128: a suggest-channel start window is an ambient observation -- its hit is the Surrogate's
      // to arbitrate, not a user-awaited result. stop/status (and every other executor) stay
      // user_awaited.
      reason = {
        kind: 'realtime_tool',
        priority: USER_PRIORITY,
        routing_class: 'ambient',
        origin: null,
        selected_suggestion: null,
      }
    }
    const summary = boundedSummary(
      firstTruthy(arguments_.work_order, arguments_.task, arguments_.condition, call.name),
    )
    if (summary === '') return this.#refused(call, 'invalid_params')

    const syncResult = requiresSynchronousResult(
      binding.executor,
      binding.op,
      arguments_,
      op.sync_result === true,
    )
    let hostItem: HostContextItem
    let responseIntent: HostResponseIntent
    if (syncResult) {
      // R105: hold the provider protocol open with a pending tool result; the service resolves it
      // from the correlated Handoff or Deadline.
      hostItem = this.#toolOutput(call, {state: 'pending'})
      responseIntent = toolResultIntent(hostItem)
    } else {
      hostItem = this.#toolOutput(call, {state: 'accepted'})
      responseIntent = {
        kind: 'delegation_acknowledgement',
        item: hostItem,
        task_summary: summary,
        origin_spoken: false,
      }
    }
    const admission = this.#runtime.dispatchExternal(
      {
        executor: binding.executor,
        op: binding.op,
        request: arguments_,
        origin_ref: resolvedOriginRef,
      },
      reason,
    )
    if (!admission.accepted || admission.delegate_id === null) {
      return this.#refused(call, 'runtime_rejected')
    }
    return acceptance({
      accepted: true,
      code: 'accepted',
      delegate_id: admission.delegate_id,
      host_item: hostItem,
      response_intent: responseIntent,
      sync_result: syncResult,
      executor: binding.executor,
      op: binding.op,
    })
  }

  /**
   * Fulfil a recall query inline.
   *
   * A projection failure becomes an `error` view rather than an exception: recall is a read, so a
   * broken one has nothing to roll back and the provider still needs an answer to its call. The
   * origin failure is the exception, because a query with no visible evidence is a different refusal
   * from a query that could not be computed.
   */
  #acceptMemoryRecall(call: ToolCallReady, originRef: string | null): ToolAcceptance {
    const schema = this.#wireParams(call.name)
    if (schema === null || !validParams(call.arguments, schema)) {
      return this.#refused(call, 'invalid_params')
    }
    // Recall validates its own origin too -- and more strictly, since the reference has to name a
    // trusted *user* item -- so this pre-check changes no outcome. It is here to avoid hashing the
    // query and reading the clock for a call that cannot succeed, and to match the oracle's shape.
    const resolvedOriginRef = originRef ?? this.#latestUserOriginRef
    if (typeof resolvedOriginRef !== 'string' || resolvedOriginRef === '') {
      return this.#refused(call, 'missing_origin_ref')
    }
    const query = call.arguments.query
    const scope = call.arguments.scope
    if (typeof query !== 'string' || typeof scope !== 'string') {
      return this.#refused(call, 'invalid_params')
    }
    if (stripLikePython(query) === '') return this.#refused(call, 'invalid_params')
    const startedAt = this.#runtime.clock.now()
    const digest = createHmac('sha256', this.#queryDigestKey).update(query, 'utf8').digest('hex')

    let view: RecallView
    try {
      view = compileMemoryRecall(this.#runtime.memory, {
        query,
        scope: scope as RecallScope,
        beforeRef: resolvedOriginRef,
      })
    } catch (cause) {
      if (cause instanceof RecallOriginError) return this.#refused(call, 'missing_origin_ref')
      // Named by constructor rather than message: the message could carry query text, and this line
      // goes to a log the user never consented to have their words in.
      console.log(
        `[realtime-diagnostic] memory_recall_projection_error type=${diagnosticName(cause)}`,
      )
      const errorView: RecallView = {
        state: 'error',
        scope: scope as RecallScope,
        raw_scanned: 0,
        searched_count: 0,
        scan_truncated: false,
        hits: [],
        omitted: 0,
      }
      return this.#inlineToolResult(call, encodeMemoryRecall(errorView), 'error', this.#recallTelemetry({
        queryDigest: digest,
        scope: scope as RecallScope,
        state: 'error',
        rawScanned: 0,
        searchedCount: 0,
        scanTruncated: false,
        hitRefs: [],
        matches: {lexical: 0, recency_fallback: 0},
        omitted: 0,
        startedAt,
      }))
    }

    const content = encodeMemoryRecall(view)
    // Read back from the encoded bytes, not the view: encoding drops hits to fit the character
    // budget, so telemetry taken from the view would report hits the model never saw.
    const emitted = JSON.parse(content) as {
      readonly state: string
      readonly raw_scanned: number
      readonly searched_count: number
      readonly scan_truncated: boolean
      readonly omitted: number
      readonly hits: readonly {readonly ref: string; readonly match: string}[]
    }
    const telemetry = this.#recallTelemetry({
      queryDigest: digest,
      scope: scope as RecallScope,
      state: emitted.state,
      rawScanned: emitted.raw_scanned,
      searchedCount: emitted.searched_count,
      scanTruncated: emitted.scan_truncated,
      hitRefs: emitted.hits.map(hit => hit.ref),
      matches: {
        lexical: emitted.hits.filter(hit => hit.match === 'lexical').length,
        recency_fallback: emitted.hits.filter(hit => hit.match === 'recency_fallback').length,
      },
      omitted: emitted.omitted,
      startedAt,
    })
    return this.#inlineToolResult(call, content, view.state, telemetry)
  }

  #inlineToolResult(
    call: ToolCallReady,
    content: string,
    code: string,
    telemetry: Readonly<Record<string, JsonValue>>,
  ): ToolAcceptance {
    const hostItem = this.#toolOutputContent(call, content)
    return acceptance({
      accepted: true,
      code,
      host_item: hostItem,
      response_intent: toolResultIntent(hostItem),
      inline_fulfilled: true,
      telemetry,
    })
  }

  #recallTelemetry(input: {
    readonly queryDigest: string
    readonly scope: RecallScope
    readonly state: string
    readonly rawScanned: number
    readonly searchedCount: number
    readonly scanTruncated: boolean
    readonly hitRefs: readonly string[]
    readonly matches: Readonly<Record<string, number>>
    readonly omitted: number
    readonly startedAt: number
  }): Readonly<Record<string, JsonValue>> {
    return {
      query_digest: input.queryDigest,
      scope: input.scope,
      state: input.state,
      raw_scanned: input.rawScanned,
      searched_count: input.searchedCount,
      scan_truncated: input.scanTruncated,
      hit_count: input.hitRefs.length,
      hit_refs: [...input.hitRefs],
      matches: {...input.matches},
      omitted: input.omitted,
      // Clamped at zero: a clock that went backwards must not report a negative duration, which
      // would poison any aggregate computed over these.
      elapsed: Math.max(0, this.#runtime.clock.now() - input.startedAt),
    }
  }

  /** A refusal is still a tool result: a provider left without one stalls waiting for it. */
  #refused(call: ToolCallReady, code: string): ToolAcceptance {
    const hostItem = this.#toolOutput(call, {code, state: 'refused'})
    return acceptance({
      accepted: false,
      code,
      host_item: hostItem,
      response_intent: toolResultIntent(hostItem),
    })
  }

  #toolOutput(call: ToolCallReady, value: Readonly<Record<string, string>>): HostContextItem {
    return this.#toolOutputContent(call, canonicalJson(value))
  }

  #toolOutputContent(call: ToolCallReady, content: string): HostContextItem {
    return {
      kind: 'tool_output',
      host_item_id: this.#idFactory(),
      event_id: this.#idFactory(),
      call_id: call.call_id,
      content,
    }
  }

  /**
   * The wire schema for one tool, as the provider was given it.
   *
   * Validated against the *published* schema rather than the executor manifest, because that is what
   * the model was told the tool accepts -- checking against anything else would refuse calls that
   * honoured the contract, or admit ones that did not.
   */
  #wireParams(name: string): Readonly<Record<string, JsonValue>> | null {
    for (const schema of this.#tools.schemas) {
      const fn = schema.function
      if (!isJsonObject(fn) || fn.name !== name) continue
      const params = fn.parameters
      return isJsonObject(params) ? params : null
    }
    return null
  }
}

function acceptance(input: {
  readonly accepted: boolean
  readonly code: string
  readonly host_item: HostContextItem
  readonly response_intent: HostResponseIntent
  readonly delegate_id?: string
  readonly sync_result?: boolean
  readonly executor?: string
  readonly op?: string
  readonly inline_fulfilled?: boolean
  readonly telemetry?: Readonly<Record<string, JsonValue>>
}): ToolAcceptance {
  return {
    accepted: input.accepted,
    code: input.code,
    host_item: input.host_item,
    response_intent: input.response_intent,
    delegate_id: input.delegate_id ?? null,
    sync_result: input.sync_result ?? false,
    executor: input.executor ?? null,
    op: input.op ?? null,
    inline_fulfilled: input.inline_fulfilled ?? false,
    telemetry: input.telemetry ?? null,
  }
}

function toolResultIntent(item: HostContextItem): HostResponseIntent {
  return {kind: 'tool_result', item, task_summary: null, origin_spoken: false}
}

/**
 * The first field with something in it, by Python's notion of "something".
 *
 * The oracle chains these with `or`, which falls through on *any* falsy value -- an empty string, a
 * zero, a false, an empty list. Nullish coalescing falls through only on null and undefined, so a
 * schema permitting a numeric `work_order` of `0` would summarize the task as "0" here and as the
 * `task` field there; an empty-string `work_order` was worse still, refusing a call the oracle
 * dispatches. Matching the oracle's truthiness is the whole job of this function.
 */
function firstTruthy(...values: (JsonValue | undefined)[]): JsonValue | undefined {
  for (const value of values) {
    if (isPythonTruthy(value)) return value
  }
  return values.at(-1)
}

/** Whether Python's `bool()` would be true for this value. */
function isPythonTruthy(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null || value === false) return false
  if (value === true) return true
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') return value !== ''
  if (Array.isArray(value)) return value.length > 0
  return Object.keys(value).length > 0
}

function boundedSummary(value: JsonValue | undefined): string {
  // Stringified the way the oracle's `str()` does for the shapes that reach here, then trimmed and
  // cut to the bound in code points -- a summary split mid-character would be invalid text.
  const text = typeof value === 'string' ? value : canonicalJson(value ?? null)
  return [...stripLikePython(text)].slice(0, MAX_TASK_SUMMARY).join('')
}

function diagnosticName(cause: unknown): string {
  return cause instanceof Error ? cause.constructor.name : typeof cause
}

function isJsonObject(value: unknown): value is Readonly<Record<string, JsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether one call's arguments satisfy a published JSON Schema.
 *
 * A deliberately small subset -- the shapes the tool schemas actually use -- rather than a general
 * validator. The oracle checks exactly these, and a Node validator that accepted more would admit
 * calls Python refuses; one that accepted less would refuse calls Python admits. Either way the two
 * runtimes would disagree about what a model is allowed to ask for.
 */
export function validParams(
  arguments_: Readonly<Record<string, JsonValue>>,
  schema: Readonly<Record<string, JsonValue>>,
): boolean {
  if (schema.type !== 'object') return false
  const properties = schema.properties
  if (!isJsonObject(properties)) return false
  const required = schema.required ?? []
  if (!Array.isArray(required) || !required.every(name => typeof name === 'string')) return false
  if (required.some(name => !(name in arguments_))) return false
  if (schema.additionalProperties === false) {
    if (Object.keys(arguments_).some(name => !(name in properties))) return false
  }
  return Object.entries(arguments_).every(([name, value]) => (
    validValue(value, properties[name])
  ))
}

function validValue(value: JsonValue, schema: JsonValue | undefined): boolean {
  if (!isJsonObject(schema)) return false
  const kind = schema.type
  if (kind === 'string') {
    if (typeof value !== 'string') return false
    const enumerated = schema.enum
    if (enumerated !== undefined) {
      if (!Array.isArray(enumerated) || !enumerated.includes(value)) return false
    }
    const minimum = schema.minLength
    const maximum = schema.maxLength
    if (typeof minimum !== 'number' && typeof maximum !== 'number') return true
    // Code points, because Python's `len()` counts code points and `String.prototype.length` counts
    // UTF-16 units. They agree for BMP text and diverge for anything astral, so a bound measured in
    // units would refuse a 300-emoji argument the oracle admits -- the model would find a tool
    // rejecting input the schema says is fine, in one runtime only.
    const length = [...value].length
    if (typeof minimum === 'number' && Number.isInteger(minimum) && length < minimum) return false
    if (typeof maximum === 'number' && Number.isInteger(maximum) && length > maximum) return false
    return true
  }
  // `integer` and `number` are distinct: the oracle's `type(value) is int` rejects a float that
  // happens to be whole, and JSON gives no way to tell `1` from `1.0`, so an integer field accepts
  // only a value that survives `Number.isInteger`. A boolean is not an integer here, as in Python
  // where `type(value) is int` is false for `bool`.
  if (kind === 'integer') return typeof value === 'number' && Number.isInteger(value)
  if (kind === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (kind === 'boolean') return typeof value === 'boolean'
  if (kind === 'array') return Array.isArray(value)
  if (kind === 'object') return isJsonObject(value)
  return false
}
