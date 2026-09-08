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
import {toUSVString} from 'node:util'
import { canonicalJson } from '../canonical-json.js'
import type {ExecutorAdmission, UserTurnAuthority} from '../causal-runtime.js'
import type { JsonValue } from '../events.js'
import { USER_PRIORITY } from '../memory.js'
import {PersonalMemoryError, type PersonalMemoryRecallHit, type PersonalMemoryRecallResult, type PersonalMemoryRecallPort} from '../memory/personal-memory.js'
import type { DelegateRequest } from '../ports.js'
import type { WakeReason } from '../slots.js'
import type { CompiledTools } from '../tool-schema.js'
import type {CodingChannel} from './evidence.js'
import type { HostContextItem, HostResponseIntent } from './protocol.js'
import type { toolCallReadySchema } from './protocol.js'
import type { z } from 'zod'
import {stripLikePython} from '../python-text.js'

/** The provider event this bridge admits. Derived from the schema so the two cannot drift. */
export type ToolCallReady = z.infer<typeof toolCallReadySchema>
import {
  RecallOriginError,
  compileMemoryRecall,
  conversationCutoff,
  encodeMemoryRecall,
  type RecallScope,
  type RecallView,
} from './recall.js'

export type {PersonalMemoryRecallPort} from '../memory/personal-memory.js'

/** The runtime surface this bridge needs. Narrow on purpose: three calls and three reads. */
export interface BridgeRuntime {
  readonly clock: {now(): number}
  readonly memory: Parameters<typeof compileMemoryRecall>[0]
  readonly executors: ReadonlyMap<string, ExecutorAdapterLike>
  ingestUserInput(input: {readonly text: string}): Promise<string>
  flushMemory?(maintenance?: boolean): Promise<void>
  dispatchExternal(
    request: DelegateRequest,
    reason: WakeReason,
    userTurn?: UserTurnAuthority,
  ): {readonly accepted: boolean; readonly delegate_id: string | null} | Promise<{readonly accepted: boolean; readonly delegate_id: string | null}>
}

interface OpSpecLike {
  readonly name: string
  readonly params: Readonly<Record<string, JsonValue>>
  readonly sync_result?: boolean
}

interface ExecutorManifestLike {
  readonly name: string
  readonly display_name?: string | undefined
  readonly roles?: readonly string[]
  readonly ops: readonly OpSpecLike[]
  readonly policy: {readonly suggest?: boolean}
}

export interface ExecutorAdapterLike {
  readonly manifest: ExecutorManifestLike
  admitRequest?(op: string, request: Readonly<Record<string, JsonValue>>): ExecutorAdmission | null
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
 * An op declared `sync_result` always holds the protocol open; otherwise the adapter's own
 * admission hook may decide per call (an op that multiplexes short and long actions needs this so
 * the model cannot speak before it has seen a confirmation question).
 */
export function requiresSynchronousResult(
  adapter: Pick<ExecutorAdapterLike, 'admitRequest'> | undefined,
  op: string,
  arguments_: Readonly<Record<string, JsonValue>>,
  declaredSyncResult: boolean,
): boolean {
  if (declaredSyncResult) return true
  const admission = adapter?.admitRequest?.(op, arguments_) ?? null
  return admission?.ok === true && admission.sync_result
}

export class RealtimeRuntimeBridge {
  readonly #runtime: BridgeRuntime
  readonly #personalMemory: PersonalMemoryRecallPort | undefined
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
    readonly personalMemory?: PersonalMemoryRecallPort
    readonly tools: CompiledTools
    readonly idFactory: () => string
    /** Test seam only. Production leaves it unset so the key is random. */
    readonly queryDigestKey?: Buffer
  }) {
    this.#runtime = options.runtime
    this.#personalMemory = options.personalMemory
    this.#tools = options.tools
    this.#idFactory = options.idFactory
    this.#queryDigestKey = options.queryDigestKey ?? randomBytes(32)
  }

  #codingChannel(): CodingChannel | null {
    for (const adapter of this.#runtime.executors.values()) {
      const manifest = adapter.manifest
      if (manifest.roles?.includes('coding') === true) {
        return {channel: manifest.name, display_name: manifest.display_name ?? manifest.name}
      }
    }
    return null
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
   * Query reads memory and returns its answer inline; everything else dispatches an executor and
   * returns an acknowledgement.
   */
  async acceptToolCall(
    call: ToolCallReady,
    options: {readonly originRef?: string | null; readonly userTurn?: UserTurnAuthority} = {},
  ): Promise<ToolAcceptance> {
    const originRef = options.originRef ?? null
    const binding = this.#tools.bindings.get(call.name)
    if (binding === undefined) return this.#refused(call, 'unknown_tool')
    if (this.#tools.hidden.has(call.name)) return this.#refused(call, 'hidden_executor')
    let reason: WakeReason = {
      kind: 'realtime_tool',
      priority: USER_PRIORITY,
      routing_class: 'user_awaited',
      origin: null,
      selected_suggestion: null,
    }
    if (binding.kind === 'query') {
      await this.#runtime.flushMemory?.(true)
      if (!currentUserTurn(options.userTurn)) return this.#refused(call, 'superseded')
      return this.#acceptMemoryRecall(call, originRef)
    }
    if (
      binding.executor === undefined || binding.executor === null
      || binding.op === undefined || binding.op === null
    ) {
      return this.#refused(call, 'unsupported_tool')
    }

    const {origin_ref: providerOriginRef, ...argumentSnapshot} = call.arguments
    let arguments_: Readonly<Record<string, JsonValue>> = argumentSnapshot
    // Host-ingested evidence outranks whatever the provider supplied. A model that has just heard
    // the user must not be able to reach past that transcript to an older reference.
    const resolvedOriginRef = originRef ?? this.#latestUserOriginRef ?? providerOriginRef
    if (typeof resolvedOriginRef !== 'string' || resolvedOriginRef === '') {
      return this.#refused(call, 'missing_origin_ref')
    }
    const adapter = this.#runtime.executors.get(binding.executor)
    const op = adapter?.manifest.ops.find(candidate => candidate.name === binding.op) ?? null
    if (op === null) return this.#refused(call, 'invalid_params')
    const adapterAdmission = adapter?.admitRequest?.(binding.op, arguments_) ?? null
    if (adapterAdmission !== null) {
      if (!adapterAdmission.ok) return this.#refused(call, 'invalid_params')
      arguments_ = adapterAdmission.request
    } else if (!validParams(arguments_, op.params)) {
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

    const syncResult = op.sync_result === true || (adapterAdmission?.ok === true && adapterAdmission.sync_result)
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
    const admission = await this.#runtime.dispatchExternal(
      {
        executor: binding.executor,
        op: binding.op,
        request: arguments_,
        origin_ref: resolvedOriginRef,
      },
      reason,
      options.userTurn,
    )
    if (!currentUserTurn(options.userTurn)) return this.#refused(call, 'superseded')
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

  /** Personal recall runs through the service-owned cancellable read path. */
  async acceptPersonalMemoryRecall(
    call: ToolCallReady,
    options: {readonly originRef?: string | null} = {},
  ): Promise<ToolAcceptance> {
    const binding = this.#tools.bindings.get(call.name)
    if (binding === undefined) return this.#refused(call, 'unknown_tool')
    if (this.#tools.hidden.has(call.name)) return this.#refused(call, 'hidden_executor')
    if (binding.kind !== 'query') return this.#refused(call, 'unsupported_tool')
    const request = this.#memoryRecallRequest(call, options.originRef ?? null)
    if (!request.ok) return request.acceptance
    if (request.source !== 'personal') return this.#refused(call, 'unsupported_tool')

    const startedAt = this.#runtime.clock.now()
    const digest = createHmac('sha256', this.#queryDigestKey).update(request.query, 'utf8').digest('hex')
    const personal = this.#personalMemory
    if (personal === undefined) {
      return this.#personalMemoryResult(call, request, {
        state: 'disabled', hits: [], contextHits: [], degraded: true,
      }, digest, startedAt)
    }
    try {
      const result = await personal.recall(request.query, {scope: request.scope, limit: 5})
      const view = personalRecallView(result, request.scope)
      if (view === null) {
        return this.#personalMemoryResult(call, request, {
          state: 'error', hits: [], contextHits: [], degraded: true,
        }, digest, startedAt)
      }
      return this.#personalMemoryResult(call, request, view, digest, startedAt)
    } catch (cause) {
      const state = personalRecallFailureState(cause)
      console.log(
        `[realtime-diagnostic] personal_memory_recall_error type=${diagnosticName(cause)} state=${state}`,
      )
      return this.#personalMemoryResult(call, request, {
        state, hits: [], contextHits: [], degraded: true,
      }, digest, startedAt)
    }
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
    const request = this.#memoryRecallRequest(call, originRef)
    if (!request.ok) return request.acceptance
    if (request.source === 'personal') return this.#refused(call, 'async_tool')
    const {query,scope,originRef: resolvedOriginRef} = request
    const startedAt = this.#runtime.clock.now()
    const digest = createHmac('sha256', this.#queryDigestKey).update(query, 'utf8').digest('hex')

    let view: RecallView
    try {
      view = compileMemoryRecall(this.#runtime.memory, {
        query,
        scope: scope,
        beforeRef: resolvedOriginRef,
        coding: this.#codingChannel(),
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
        scope: scope,
        raw_scanned: 0,
        searched_count: 0,
        scan_truncated: false,
        hits: [],
        omitted: 0,
      }
      return this.#inlineToolResult(call, encodeMemoryRecall(errorView), 'error', this.#recallTelemetry({
        queryDigest: digest,
        scope: scope,
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
      scope: scope,
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

  #memoryRecallRequest(
    call: ToolCallReady,
    originRef: string | null,
  ): {readonly ok: true; readonly query: string; readonly scope: RecallScope; readonly source: 'session'|'personal'; readonly originRef: string}
    | {readonly ok: false; readonly acceptance: ToolAcceptance} {
    const schema = this.#wireParams(call.name)
    if (schema === null || !validParams(call.arguments, schema)) {
      return {ok: false, acceptance: this.#refused(call, 'invalid_params')}
    }
    const resolvedOriginRef = originRef ?? this.#latestUserOriginRef
    if (
      typeof resolvedOriginRef !== 'string'
      || resolvedOriginRef === ''
      || !trustedUserOrigin(this.#runtime.memory, resolvedOriginRef)
    ) {
      return {ok: false, acceptance: this.#refused(call, 'missing_origin_ref')}
    }
    const query = call.arguments.query
    const scope = call.arguments.scope
    const source = call.arguments.source ?? 'session'
    if (
      typeof query !== 'string'
      || query.includes('\0')
      || toUSVString(query) !== query
      || stripLikePython(query) === ''
      || (scope !== 'recent' && scope !== 'any')
      || (source !== 'session' && source !== 'personal')
    ) {
      return {ok: false, acceptance: this.#refused(call, 'invalid_params')}
    }
    return {ok: true, query, scope, source, originRef: resolvedOriginRef}
  }

  #personalMemoryResult(
    call: ToolCallReady,
    request: {readonly scope: RecallScope},
    view: PersonalRecallView,
    queryDigest: string,
    startedAt: number,
  ): ToolAcceptance {
    const content = encodePersonalRecall(request.scope, view)
    const emitted = JSON.parse(content) as {
      readonly state: string
      readonly hits: readonly unknown[]
      readonly context_hits: readonly unknown[]
      readonly omitted: number
      readonly degraded: boolean
    }
    return this.#inlineToolResult(call, content, emitted.state, {
      query_digest: queryDigest,
      source: 'personal',
      scope: request.scope,
      state: emitted.state,
      hit_count: emitted.hits.length,
      context_hit_count: emitted.context_hits.length,
      omitted: emitted.omitted,
      degraded: emitted.degraded,
      elapsed: Math.max(0, this.#runtime.clock.now() - startedAt),
    })
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

type PersonalRecallState = PersonalMemoryRecallResult['state'] | 'disabled' | 'unavailable' | 'error'

interface PersonalRecallOutputHit {
  readonly source: 'personal'
  readonly memory_id: string
  readonly kind: NonNullable<PersonalMemoryRecallHit['kind']> | null
  readonly text: string
  readonly subject: string
  readonly attributed_to: string | null
  readonly attribute: string
  readonly emotion: string
  readonly occurred_at: string | null
  readonly recorded_at: string | null
  readonly score: number | null
  readonly evidence_ids: readonly string[]
}

interface PersonalRecallView {
  readonly state: PersonalRecallState
  readonly hits: readonly PersonalRecallOutputHit[]
  readonly contextHits: readonly PersonalRecallOutputHit[]
  readonly degraded: boolean
}

const PERSONAL_RECALL_MAX_CHARS = 3_000
const PERSONAL_RECALL_HIT_LIMIT = 5

function trustedUserOrigin(memory: BridgeRuntime['memory'], reference: string): boolean {
  try {
    conversationCutoff(memory, reference)
    return true
  } catch (cause) {
    if (cause instanceof RecallOriginError) return false
    throw cause
  }
}

function personalRecallView(result: PersonalMemoryRecallResult, scope: RecallScope): PersonalRecallView | null {
  const context = result.contextHits ?? []
  if (
    result.source !== 'personal'
    || result.scope !== scope
    || (result.state !== 'ok' && result.state !== 'empty')
    || typeof result.degraded !== 'boolean'
    || !Array.isArray(result.hits)
    || !Array.isArray(context)
    || result.hits.length > PERSONAL_RECALL_HIT_LIMIT
    || context.length > PERSONAL_RECALL_HIT_LIMIT
  ) return null
  const hits = result.hits.map(personalRecallHit)
  const contextHits = context.map(personalRecallHit)
  if (hits.some(hit => hit === null) || contextHits.some(hit => hit === null)) return null
  if (result.state === 'empty' && (hits.length > 0 || contextHits.length > 0)) return null
  if (result.state === 'ok' && hits.length === 0 && contextHits.length === 0) return null
  return {
    state: result.state,
    hits: hits as PersonalRecallOutputHit[],
    contextHits: contextHits as PersonalRecallOutputHit[],
    degraded: result.degraded,
  }
}

function personalRecallHit(hit: PersonalMemoryRecallHit): PersonalRecallOutputHit | null {
  const attributedTo = hit.attributedTo ?? null
  if (
    !boundedString(hit.memoryId, 256, 1)
    || (hit.kind !== undefined && !['fact','experience','trait'].includes(hit.kind))
    || !boundedString(hit.text, 800, 1)
    || (hit.subject !== undefined && !boundedString(hit.subject, 256, 1))
    || (attributedTo !== null && !boundedString(attributedTo, 256, 1))
    || (hit.attribute !== undefined && !boundedString(hit.attribute, 256))
    || (hit.emotion !== undefined && !boundedString(hit.emotion, 256))
    || (hit.occurredAt != null && !boundedString(hit.occurredAt, 64, 1))
    || (hit.recordedAt !== undefined && !boundedString(hit.recordedAt, 64, 1))
    || (hit.score !== undefined && !Number.isFinite(hit.score))
    || !Array.isArray(hit.evidenceIds)
    || hit.evidenceIds.length > 8
    || !hit.evidenceIds.every(value => boundedString(value, 256, 1))
  ) return null
  return {
    source: 'personal', memory_id: hit.memoryId, kind: hit.kind ?? null, text: hit.text,
    subject: hit.subject ?? '', attributed_to: attributedTo, attribute: hit.attribute ?? '',
    emotion: hit.emotion ?? '', occurred_at: hit.occurredAt ?? null, recorded_at: hit.recordedAt ?? null,
    score: hit.score ?? null, evidence_ids: [...hit.evidenceIds],
  }
}

function boundedString(value: unknown, max: number, min = 0): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max
    && !value.includes('\0') && toUSVString(value) === value
}

function encodePersonalRecall(scope: RecallScope, view: PersonalRecallView): string {
  const hits = [...view.hits]
  const contextHits = [...view.contextHits]
  let omitted = 0
  for (;;) {
    const content = canonicalJson({
      source: 'personal', state: view.state, scope, degraded: view.degraded,
      hits, context_hits: contextHits, omitted,
    })
    if ([...content].length <= PERSONAL_RECALL_MAX_CHARS) return content
    if (hits.length === 0 && contextHits.length === 0) {
      throw new RangeError('personal recall envelope exceeds its character budget')
    }
    if (contextHits.length >= hits.length && contextHits.length > 0) contextHits.pop()
    else hits.pop()
    omitted += 1
  }
}

function personalRecallFailureState(cause: unknown): 'unavailable' | 'error' {
  return cause instanceof PersonalMemoryError ? cause.state : 'error'
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
  // Domain unions require a dedicated validator. Ignoring `oneOf` would validate only the
  // permissive top-level properties and admit fields belonging to a different variant.
  if ('oneOf' in schema) return false
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

function currentUserTurn(turn: UserTurnAuthority | undefined): boolean {
  try { return turn?.stillWanted() ?? true } catch { return false }
}
