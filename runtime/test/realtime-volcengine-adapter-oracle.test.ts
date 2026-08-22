import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import type {
  HostContextItem,
  HostResponseIntent,
  JsonObject,
  RealtimeProviderEvent,
} from '../src/realtime/protocol.js'
import type { RealtimeTelemetry } from '../src/realtime/telemetry.js'
import {CascadedRealtimeAdapter} from '../src/realtime/cascaded/adapter.js'
import type {
  AsrClient,
  AsrSession,
  AsrTranscript,
  EndpointingEvent,
  EndpointingPort,
  TtsAudio,
  TtsClient,
  TtsSession,
} from '../src/realtime/cascaded/ports.js'
import type {
  CascadedLlmEvent,
  CascadedLlmInput,
  CascadedLlmSession,
  CascadedLlmTool,
} from '../src/realtime/cascaded/llm.js'

type LlmStreamInput = Parameters<CascadedLlmSession['stream']>[0]

const FIXTURE = new URL(
  '../../../fixtures/realtime/volcengine/v1/adapter.json',
  import.meta.url,
)
const EXPECTED = new URL(
  '../../../fixtures/realtime/volcengine/v1/adapter-expected.json',
  import.meta.url,
)
const PROVIDER_SECRET = 'sentinel-provider-secret'
const SETTLE_MS = 800

type Row = Readonly<Record<string, unknown>>

interface VadEntry extends Row {
  readonly kind: 'speech_started' | 'speech_stopped'
}

interface AsrSpec extends Row {
  readonly transcripts?: readonly AsrTranscript[]
}

interface ArkEntry extends Row {
  readonly kind: 'started' | 'text' | 'tool' | 'completed' | 'failed' | 'yield' | 'block'
}

interface TtsSpec extends Row {
  readonly audio_before_finish_b64?: readonly string[]
  readonly audio_b64?: readonly string[]
}

interface Step extends Row {
  readonly op: 'send_audio' | 'inject' | 'create_response' | 'cancel_response' | 'close'
  readonly wait?: Readonly<{event: string; count?: number; code?: string}>
}

interface Scenario extends Row {
  readonly name: string
  readonly vad?: readonly (readonly VadEntry[])[]
  readonly asr?: readonly AsrSpec[]
  readonly ark?: readonly (readonly ArkEntry[])[]
  readonly tts?: readonly TtsSpec[]
  readonly steps: readonly Step[]
}

interface FixtureDocument {
  readonly schema_version: number
  readonly tools: readonly JsonObject[]
  readonly scenarios: readonly Scenario[]
}

interface ExpectedScenario extends Row {
  readonly name: string
  readonly session: Row
  readonly steps: readonly Row[]
  readonly events: readonly Row[]
  readonly ark_calls: readonly Row[]
  readonly asr_operations: readonly Row[]
  readonly tts_operations: readonly Row[]
  readonly telemetry: readonly Row[]
  readonly vad: Row
}

interface ExpectedDocument {
  readonly schema_version: number
  readonly scenarios: readonly ExpectedScenario[]
}

async function settleWithin<T>(label: string, promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle`)), SETTLE_MS)
  })
  try {
    return await Promise.race([promise, expired])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function waitForCondition(label: string, predicate: () => boolean): Promise<void> {
  await settleWithin(label, (async () => {
    while (!predicate()) await new Promise<void>(resolve => setImmediate(resolve))
  })())
}

async function yieldToTasks(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
}

function decode(encoded: unknown, fallback = ''): Uint8Array {
  return new Uint8Array(Buffer.from(typeof encoded === 'string' ? encoded : fallback, 'base64'))
}

function encode(pcm: Uint8Array): string {
  return Buffer.from(pcm).toString('base64')
}

class ScriptedEndpointing implements EndpointingPort {
  readonly #batches: (readonly VadEntry[])[]
  inSpeech = false
  feedCalls = 0
  resetCalls = 0

  constructor(batches: readonly (readonly VadEntry[])[]) {
    this.#batches = batches.map(batch => [...batch])
  }

  feed(pcm: Uint8Array): Promise<readonly EndpointingEvent[]> {
    const batch = this.#batches[this.feedCalls]
    if (batch === undefined) return Promise.reject(new Error('endpoint fixture exhausted'))
    this.feedCalls += 1
    const events: EndpointingEvent[] = []
    const wasSpeech = this.inSpeech
    const started = batch.find(entry => entry.kind === 'speech_started')
    if (started !== undefined) {
      this.inSpeech = true
      events.push({
        kind: 'speech_start',
        pcm: started.pre_roll === 'input' ? pcm.slice() : decode(started.pre_roll_b64),
      })
      const speech = started.speech === 'input' ? pcm.slice() : decode(started.speech_b64)
      if (speech.byteLength > 0) events.push({kind: 'speech_audio', pcm: speech})
    } else if (wasSpeech) {
      events.push({kind: 'speech_audio', pcm: pcm.slice()})
    }
    const stopped = batch.find(entry => entry.kind === 'speech_stopped')
    if (stopped !== undefined) {
      this.inSpeech = false
      events.push({kind: 'speech_end', commit: stopped.commit === true})
    }
    return Promise.resolve(events)
  }

  reset(): void {
    this.inSpeech = false
    this.resetCalls += 1
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}

class ScriptedAsrSession implements AsrSession {
  readonly #label: string
  readonly #spec: AsrSpec
  readonly #operations: Row[]
  #appendCalls = 0
  #closed = false
  #release: (() => void) | null = null
  readonly #finished = new Promise<void>(resolve => { this.#release = resolve })

  constructor(label: string, spec: AsrSpec, operations: Row[]) {
    this.#label = label
    this.#spec = spec
    this.#operations = operations
  }

  append(pcm: Uint8Array): Promise<void> {
    this.#appendCalls += 1
    const failed = this.#appendCalls === this.#spec.append_error_at
    this.#operations.push({
      op: 'append', session: this.#label, pcm_b64: encode(pcm),
      outcome: failed ? 'error' : 'ok',
    })
    return failed ? Promise.reject(new Error(PROVIDER_SECRET)) : Promise.resolve()
  }

  finish(): Promise<void> {
    const failed = this.#spec.finish_error === true
    this.#operations.push({op: 'finish', session: this.#label,
      outcome: failed ? 'error' : 'ok'})
    if (failed) return Promise.reject(new Error(PROVIDER_SECRET))
    this.#release?.()
    return Promise.resolve()
  }

  async *events(): AsyncIterable<AsrTranscript> {
    await settleWithin(`ASR ${this.#label} terminal`, this.#finished)
    if (this.#spec.events_error === true) throw new Error(PROVIDER_SECRET)
    for (const transcript of this.#spec.transcripts ?? []) yield structuredClone(transcript)
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve()
    this.#closed = true
    this.#operations.push({op: 'close', session: this.#label})
    this.#release?.()
    return Promise.resolve()
  }
}

class ScriptedAsr implements AsrClient {
  readonly #specs: readonly AsrSpec[]
  opens = 0
  readonly operations: Row[] = []

  constructor(specs: readonly AsrSpec[]) {
    this.#specs = specs
  }

  open(): Promise<AsrSession> {
    const spec = this.#specs[this.opens]
    if (spec === undefined) return Promise.reject(new Error('ASR fixture exhausted'))
    this.opens += 1
    const label = `asr-${this.opens}`
    const failed = spec.open_error === true
    this.operations.push({op: 'open', session: label, outcome: failed ? 'error' : 'ok'})
    if (failed) return Promise.reject(new Error(PROVIDER_SECRET))
    return Promise.resolve(new ScriptedAsrSession(label, spec, this.operations))
  }
}

class ScriptedLlm implements CascadedLlmSession {
  readonly #scripts: (readonly ArkEntry[])[]
  readonly calls: Row[] = []
  #previousResponseId: string | null = null
  #pendingToolCallId: string | null = null
  closed = false

  constructor(scripts: readonly (readonly ArkEntry[])[]) {
    this.#scripts = scripts.map(entries => [...entries])
  }

  async *stream(input: LlmStreamInput): AsyncIterable<CascadedLlmEvent> {
    const entries = this.#scripts[this.calls.length]
    if (entries === undefined) throw new Error('LLM fixture exhausted')
    if (this.#pendingToolCallId !== null && !input.inputs.some(candidate =>
      candidate.kind === 'tool_result' && candidate.call_id === this.#pendingToolCallId)) {
      this.#previousResponseId = null
      this.#pendingToolCallId = null
    }
    this.calls.push({
      input_items: input.inputs.map(oracleInputItem),
      tools: input.tools.map(oracleToolSchema),
      previous_response_id: this.#previousResponseId,
    })
    let responseId: string | null = null
    let pendingCallId: string | null = null
    let textSeen = false
    let toolSeen = false
    for (const entry of entries) {
      if (entry.kind === 'started') {
        responseId = String(entry.response_id)
        yield {kind: 'response_started', response_id: responseId}
      } else if (entry.kind === 'text') {
        textSeen = true
        yield {kind: 'text_delta', text: String(entry.text)}
      } else if (entry.kind === 'tool') {
        toolSeen = true
        pendingCallId = String(entry.call_id)
        yield {
          kind: 'tool_call', item_id: String(entry.item_id), call_id: pendingCallId,
          name: String(entry.name), arguments: structuredClone(entry.arguments as JsonObject),
        }
      } else if (entry.kind === 'completed') {
        const completedId = String(entry.response_id)
        this.#previousResponseId = completedId
        this.#pendingToolCallId = pendingCallId
        yield {kind: 'response_completed', response_id: completedId}
      } else if (entry.kind === 'failed') {
        this.#previousResponseId = null
        this.#pendingToolCallId = null
        yield {kind: 'response_failed', response_id: String(entry.response_id),
          code: entry.code === 'incomplete' ? 'incomplete' : 'failed'}
      } else if (entry.kind === 'yield') {
        await yieldToTasks()
      } else {
        const signal = input.signal
        if (signal === undefined) throw new Error('blocking LLM fixture requires a signal')
        await settleWithin('blocking LLM abort', new Promise<void>(resolve => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => resolve(), {once: true})
        }))
        throw new DOMException('aborted', 'AbortError')
      }
      if (textSeen && toolSeen) {
        this.#previousResponseId = null
        this.#pendingToolCallId = null
      }
    }
    void responseId
  }

  abandonPendingResponse(): Promise<void> {
    if (this.#pendingToolCallId !== null) this.#previousResponseId = null
    this.#pendingToolCallId = null
    return Promise.resolve()
  }

  close(): Promise<void> {
    this.closed = true
    this.#previousResponseId = null
    this.#pendingToolCallId = null
    return Promise.resolve()
  }
}

function oracleInputItem(input: CascadedLlmInput): JsonObject {
  if (input.kind === 'tool_result') {
    return {type: 'function_call_output', call_id: input.call_id, output: JSON.stringify(input.output)}
  }
  if (input.kind === 'user_text') return {role: 'user', content: input.text}
  const asActivation = input.content.includes('以下内容不是用户说的话')
  return {role: asActivation ? 'user' : 'system', content: input.content}
}

function oracleToolSchema(tool: CascadedLlmTool): JsonObject {
  return {
    type: 'function', name: tool.name,
    ...(tool.description === undefined ? {} : {description: tool.description}),
    parameters: structuredClone(tool.parameters),
  }
}

class ScriptedTtsSession implements TtsSession {
  readonly #label: string
  readonly #spec: TtsSpec
  readonly #operations: Row[]
  #sendCalls = 0
  #cancelled = false
  #closed = false
  #release: (() => void) | null = null
  readonly #finished = new Promise<void>(resolve => { this.#release = resolve })

  constructor(label: string, spec: TtsSpec, operations: Row[]) {
    this.#label = label
    this.#spec = spec
    this.#operations = operations
  }

  sendText(text: string): Promise<void> {
    this.#sendCalls += 1
    const failed = this.#sendCalls === this.#spec.send_error_at
    this.#operations.push({op: 'send_text', session: this.#label, text,
      outcome: failed ? 'error' : 'ok'})
    return failed ? Promise.reject(new Error(PROVIDER_SECRET)) : Promise.resolve()
  }

  finish(): Promise<void> {
    this.#operations.push({op: 'finish', session: this.#label})
    this.#release?.()
    return Promise.resolve()
  }

  cancel(): Promise<void> {
    this.#operations.push({op: 'cancel', session: this.#label})
    this.#cancelled = true
    this.#release?.()
    return Promise.resolve()
  }

  async *events(): AsyncIterable<TtsAudio> {
    for (const encoded of this.#spec.audio_before_finish_b64 ?? []) {
      yield {pcm: decode(encoded)}
    }
    if (this.#spec.events_error_after_audio === true) throw new Error(PROVIDER_SECRET)
    await settleWithin(`TTS ${this.#label} terminal`, this.#finished)
    if (this.#cancelled) return
    for (const encoded of this.#spec.audio_b64 ?? []) yield {pcm: decode(encoded)}
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve()
    this.#closed = true
    this.#operations.push({op: 'close', session: this.#label})
    this.#release?.()
    return Promise.resolve()
  }
}

class ScriptedTts implements TtsClient {
  readonly #specs: readonly TtsSpec[]
  opens = 0
  readonly operations: Row[] = []

  constructor(specs: readonly TtsSpec[]) {
    this.#specs = specs
  }

  open(): Promise<TtsSession> {
    const spec = this.#specs[this.opens] ?? {}
    this.opens += 1
    const label = `tts-${this.opens}`
    this.operations.push({op: 'open', session: label})
    return Promise.resolve(new ScriptedTtsSession(label, spec, this.operations))
  }
}

class RecordingTelemetry implements RealtimeTelemetry {
  readonly records: Row[] = []

  record(kind: string, payload: Readonly<Record<string, unknown>>): void {
    this.records.push({name: kind, payload: structuredClone(payload)})
  }

  close(): void {
    throw new Error('adapter closed caller-owned telemetry')
  }
}

class EventObserver {
  readonly events: RealtimeProviderEvent[] = []
  readonly #task: Promise<void>

  constructor(adapter: CascadedRealtimeAdapter) {
    this.#task = (async () => {
      for await (const event of adapter.events(new AbortController().signal)) {
        this.events.push(event)
      }
    })()
  }

  async wait(spec: NonNullable<Step['wait']>): Promise<void> {
    await waitForCondition(`event ${spec.event}`, () => this.events.filter(event =>
      event.kind === spec.event && (spec.code === undefined
        || event.kind === 'provider_error' && event.code === spec.code)).length
        >= (spec.count ?? 1))
  }

  settle(): Promise<void> {
    return settleWithin('adapter event observer', this.#task)
  }
}

function idFactory(name: string): () => string {
  let next = 0
  return () => {
    next += 1
    return `${name}-id-${next}`
  }
}

function hostItem(value: unknown): HostContextItem {
  const item = value as Row
  return {
    kind: item.kind as HostContextItem['kind'],
    host_item_id: String(item.host_item_id),
    event_id: String(item.event_id),
    content: String(item.content),
    call_id: typeof item.call_id === 'string' ? item.call_id : null,
  }
}

function responseIntent(kind: unknown, item: HostContextItem): HostResponseIntent {
  return {
    kind: kind === 'tool_result' ? 'tool_result' : 'host_fact',
    item,
    task_summary: null,
    origin_spoken: false,
  }
}

function directOptions(): {
  readonly confirmationTimeout: null
  readonly asUserActivation: false
  readonly signal: AbortSignal
} {
  return {
    confirmationTimeout: null,
    asUserActivation: false,
    signal: new AbortController().signal,
  }
}

async function runScenario(spec: Scenario, tools: readonly JsonObject[]): Promise<{
  readonly observed: Row
  readonly llmClosed: boolean
}> {
  const endpointing = new ScriptedEndpointing(spec.vad ?? [])
  const asr = new ScriptedAsr(spec.asr ?? [])
  const llm = new ScriptedLlm(spec.ark ?? [])
  const tts = new ScriptedTts(spec.tts ?? [])
  const telemetry = new RecordingTelemetry()
  const adapter = new CascadedRealtimeAdapter({
    endpointing, asr, tts, llm, telemetry,
    idFactory: idFactory(spec.name), settleTimeoutMs: SETTLE_MS,
  })
  const session = await adapter.connect({tools, signal: new AbortController().signal}) as Row
  const observer = new EventObserver(adapter)
  const items = new Map<string, HostContextItem>()
  const steps: Row[] = []
  let closed = false
  try {
    for (let index = 0; index < spec.steps.length; index += 1) {
      const step = spec.steps[index]!
      let result: unknown = null
      try {
        if (step.op === 'send_audio') {
          await adapter.sendAudio(decode(step.pcm_b64, 'AAE='), new AbortController().signal)
        } else if (step.op === 'inject') {
          const item = hostItem(step.item)
          result = await adapter.injectHostItem(item, {
            ...directOptions(), asUserActivation: step.as_user_activation === true,
          })
          items.set(item.host_item_id, item)
        } else if (step.op === 'create_response') {
          const item = items.get(String(step.host_item_id))
          if (item === undefined) throw new Error('host item fixture is missing')
          await adapter.createResponse(
            responseIntent(step.kind, item), new AbortController().signal,
          )
        } else if (step.op === 'cancel_response') {
          await adapter.cancelResponse(String(step.response_id), new AbortController().signal)
        } else {
          await adapter.close()
          closed = true
        }
      } catch (error) {
        if (step.expect_error !== true) {
          if (error instanceof Error && error.message.includes(PROVIDER_SECRET)) {
            throw new Error(`${spec.name} step ${index} exposed a provider failure`)
          }
          throw error
        }
        const failure = error as Error & {readonly code?: string}
        result = {error: failure.name, code: failure.code ?? 'unknown'}
      }
      if (step.expect_error === true && result === null) {
        throw new Error(`${spec.name} step ${index} expected an error`)
      }
      if (step.wait !== undefined) {
        await observer.wait(step.wait)
        if (step.wait.event === 'response_terminal') {
          await waitForCondition('response terminal telemetry', () => telemetry.records.filter(
            row => row.name === 'volcengine.response.terminal',
          ).length >= (step.wait?.count ?? 1))
        }
      }
      steps.push({step: index, op: step.op, result})
    }
  } finally {
    if (!closed) await adapter.close()
    await observer.settle()
  }
  return {
    observed: {
      name: spec.name,
      session,
      steps,
      events: observer.events.map(normalizeNodeEvent),
      ark_calls: llm.calls,
      asr_operations: asr.operations,
      tts_operations: tts.operations,
      telemetry: telemetry.records,
      vad: {feed_calls: endpointing.feedCalls, reset_calls: endpointing.resetCalls},
    },
    llmClosed: llm.closed,
  }
}

function normalizeNodeEvent(event: RealtimeProviderEvent): Row {
  if (event.kind === 'response_audio_delta') {
    const {kind, pcm, ...rest} = event
    return {event: kind, ...rest, pcm_b64: encode(pcm)}
  }
  const {kind, ...rest} = event
  return {event: kind, ...rest}
}

function normalizeSpeechEnd(events: readonly Row[]): Row[] {
  return events.map(event => {
    if (event.event !== 'user_speech_ended') return structuredClone(event)
    const rest: Record<string, unknown> = {...event}
    delete rest.provider_item_id
    return rest
  })
}

function normalizeEndpointDeviation(name: string, actual: readonly Row[]): Row[] {
  const normalized = normalizeSpeechEnd(actual)
  if (name !== 'asr-start-recovery') return normalized
  const prefix = normalized.slice(0, 4)
  assert.deepEqual(prefix.map(event => event.event), [
    'user_speech_started', 'user_speech_ended', 'provider_error', 'user_transcript_failed',
  ], 'Node endpoint shape must retain the failed utterance lifecycle')
  assert.equal(prefix[0]?.speech_id, prefix[1]?.speech_id)
  assert.equal(prefix[0]?.provider_item_id, prefix[3]?.item_id)
  assert.equal(prefix[2]?.code, 'volcengine_asr_start')
  return [prefix[2], ...normalized.slice(4)]
}

function normalizedStepResult(result: unknown): unknown {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return result
  const row = result as Row
  if (row.error !== 'VolcengineRealtimeError' && row.error !== 'CascadedRealtimeError') {
    return structuredClone(row)
  }
  return {error: 'CascadedRealtimeError', code: 'duplicate_host_item'}
}

function cascadedTelemetry(rows: readonly Row[]): Row[] {
  return rows.map(row => ({
    ...structuredClone(row),
    ...(typeof row.name === 'string'
      ? {name: row.name.replace(/^volcengine[.]llm[.]/u, 'cascaded.llm.')}
      : {}),
  }))
}

function expectedProjection(expected: ExpectedScenario): Row {
  return {
    name: expected.name,
    session: expected.session,
    steps: expected.steps.map(step => ({
      step: step.step,
      op: step.op,
      result: normalizedStepResult(step.result),
    })),
    events: normalizeSpeechEnd(expected.events),
    ark_calls: expected.ark_calls,
    asr_operations: expected.asr_operations,
    tts_operations: expected.tts_operations,
    telemetry: cascadedTelemetry(expected.telemetry),
    vad: expected.vad,
  }
}

const PREWARM_CLEANUP_SCENARIOS = new Set([
  'mixed-tool-text',
  'pending-lifecycle',
  'response-continuation',
  'unresolved-tool-late-output',
  'close-during-response',
])

function assertAndProjectPrewarmCleanup(
  name: string,
  actual: Row,
  expected: Row,
): Row {
  if (!PREWARM_CLEANUP_SCENARIOS.has(name)) return actual
  const operations = actual.tts_operations as readonly Row[]
  const expectedOperations = expected.tts_operations as readonly Row[]
  if (name === 'close-during-response') {
    assert.deepEqual(operations.map(row => row.op), ['open', 'send_text', 'cancel', 'close'])
    assert.equal(operations[1]?.text, '生成中，')
    assert.equal(operations[0]?.session, operations[2]?.session)
    assert.equal(operations[0]?.session, operations[3]?.session)
    const telemetry = (actual.telemetry as readonly Row[]).filter(
      row => row.name !== 'volcengine.tts.cancel' && row.name !== 'volcengine.tts.first_text'
        && row.name !== 'volcengine.tts.prewarm.ready',
    )
    return {...actual, tts_operations: expectedOperations, telemetry}
  }
  const cleanupCount = name === 'response-continuation' || name === 'unresolved-tool-late-output'
    ? 2 : 1
  assert.equal(operations.length, cleanupCount * 3,
    `${name} must clean every resolved prewarm session`)
  for (let index = 0; index < cleanupCount; index += 1) {
    const triplet = operations.slice(index * 3, index * 3 + 3)
    assert.deepEqual(triplet.map(row => row.op), ['open', 'cancel', 'close'])
    assert.equal(triplet[0]?.session, triplet[1]?.session)
    assert.equal(triplet[0]?.session, triplet[2]?.session)
  }
  const telemetry = (actual.telemetry as readonly Row[]).filter(
    row => row.name !== 'volcengine.tts.cancel',
  )
  return {...actual, tts_operations: expectedOperations, telemetry}
}

const NODE_ENDPOINT_RESET_COUNTS: Readonly<Record<string, number>> = {
  'text-happy': 3,
  'tool-only': 3,
  'mixed-text-tool': 2,
  'mixed-tool-text': 2,
  'blank-final': 3,
  'asr-start-recovery': 5,
  'asr-append-recovery': 5,
  'asr-finish-recovery': 4,
  'asr-receive-recovery': 4,
  'pending-lifecycle': 3,
  'response-continuation': 2,
  'unresolved-tool-late-output': 3,
  'tts-retry-before-audio': 2,
  'tts-no-retry-after-audio': 2,
  'cancel-exact-mismatch': 2,
  'close-during-asr': 2,
  'close-during-response': 2,
}

function assertAndProjectEndpointResets(name: string, actual: Row, expected: Row): Row {
  const actualVad = actual.vad as Row
  const expectedVad = expected.vad as Row
  assert.equal(actualVad.reset_calls, NODE_ENDPOINT_RESET_COUNTS[name],
    `${name} must preserve the Node endpoint reset lifecycle`)
  return {...actual, vad: expectedVad}
}

function assertAndProjectRetryCleanup(name: string, actual: Row): Row {
  if (name !== 'tts-retry-before-audio') return actual
  const operations = actual.tts_operations as readonly Row[]
  assert.deepEqual(operations.map(row => row.op), [
    'open', 'send_text', 'cancel', 'close', 'open', 'send_text', 'finish', 'close',
  ])
  return {
    ...actual,
    tts_operations: operations.filter((_row, index) => index !== 2),
  }
}

function assertAndProjectSafeTtsFailure(name: string, actual: Row, expected: Row): Row {
  if (name !== 'tts-no-retry-after-audio') return actual
  const events = structuredClone(actual.events as readonly Row[])
  const providerError = events.find(event => event.event === 'provider_error')
  const terminal = events.find(event => event.event === 'response_terminal')
  assert.equal(providerError?.code, 'volcengine_tts_receive')
  assert.equal(terminal?.reason, 'tts_failure')
  return {...actual, events: expected.events}
}

function projectActual(name: string, observed: Row, expected: Row): Row {
  const steps = (observed.steps as readonly Row[]).map(step => ({
    ...step,
    result: normalizedStepResult(step.result),
  }))
  const events = normalizeEndpointDeviation(name, observed.events as readonly Row[])
  const endpoint = assertAndProjectEndpointResets(
    name, {...observed, steps, events}, expected,
  )
  const prewarm = assertAndProjectPrewarmCleanup(name, endpoint, expected)
  const retry = assertAndProjectRetryCleanup(name, prewarm)
  return assertAndProjectSafeTtsFailure(name, retry, expected)
}

test('real Volcengine adapter replays every Python oracle scenario', async context => {
  const fixture = JSON.parse(await readFile(FIXTURE, 'utf8')) as FixtureDocument
  const golden = JSON.parse(await readFile(EXPECTED, 'utf8')) as ExpectedDocument
  assert.equal(fixture.schema_version, 1)
  assert.equal(golden.schema_version, 1)
  assert.deepEqual(golden.scenarios.map(scenario => scenario.name),
    fixture.scenarios.map(scenario => scenario.name))
  for (const spec of fixture.scenarios) {
    await context.test(spec.name, async () => {
      const expectedScenario = golden.scenarios.find(row => row.name === spec.name)
      assert.ok(expectedScenario !== undefined)
      const expected = expectedProjection(expectedScenario)
      const {observed, llmClosed} = await runScenario(spec, fixture.tools)
      assert.equal(llmClosed, true, 'Node must close its fresh epoch-owned LLM gateway')
      assert.doesNotMatch(JSON.stringify(observed), /sentinel-provider-secret/u)
      assert.deepEqual(projectActual(spec.name, observed, expected), expected)
    })
  }
})
