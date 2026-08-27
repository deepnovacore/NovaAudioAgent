import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RealtimeProviderEvent } from '../src/realtime/protocol.js'
import type { RealtimeTelemetry } from '../src/realtime/telemetry.js'
import {
  CASCADED_GUARD_POLICY,
  CascadedRealtimeAdapter,
  CascadedRealtimeError,
} from '../src/realtime/cascaded/adapter.js'
import type {
  AsrClient,
  AsrSession,
  AsrTranscript,
  EndpointingEvent,
  EndpointingPort,
  TtsClient,
  TtsAudio,
  TtsSession,
} from '../src/realtime/cascaded/ports.js'
import type {
  CascadedLlmEvent,
  CascadedLlmFactory,
  CascadedLlmSession,
} from '../src/realtime/cascaded/llm.js'

type LlmStreamInput = Parameters<CascadedLlmSession['stream']>[0]

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolve: ((value: T) => void) | undefined
  const promise = new Promise<T>(settle => { resolve = settle })
  return {promise, resolve: value => resolve?.(value)}
}

async function settleWithin<T>(label: string, promise: Promise<T>, milliseconds = 500): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle`)), milliseconds)
  })
  try {
    return await Promise.race([promise, expired])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

class ScriptedEndpointing implements EndpointingPort {
  readonly #batches: (readonly EndpointingEvent[])[]
  resets = 0
  closed = false

  constructor(...batches: (readonly EndpointingEvent[])[]) {
    this.#batches = [...batches]
  }

  feed(): Promise<readonly EndpointingEvent[]> {
    return Promise.resolve(this.#batches.shift() ?? [])
  }

  reset(): void {
    this.resets += 1
  }

  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
}

class FakeAsrSession implements AsrSession {
  readonly appended: Uint8Array[] = []
  readonly #transcripts: readonly AsrTranscript[]
  #release: (() => void) | null = null
  readonly #finished = new Promise<void>(resolve => { this.#release = resolve })
  closed = false

  constructor(...transcripts: readonly AsrTranscript[]) {
    this.#transcripts = transcripts
  }

  append(pcm: Uint8Array): Promise<void> {
    this.appended.push(pcm)
    return Promise.resolve()
  }

  finish(): Promise<void> {
    this.#release?.()
    return Promise.resolve()
  }

  async *events(): AsyncIterable<AsrTranscript> {
    await this.#finished
    for (const transcript of this.#transcripts) yield transcript
  }

  close(): Promise<void> {
    this.closed = true
    this.#release?.()
    return Promise.resolve()
  }
}

class FakeAsrClient implements AsrClient {
  readonly sessions: AsrSession[]
  opens = 0

  constructor(...sessions: AsrSession[]) {
    this.sessions = sessions
  }

  open(): Promise<AsrSession> {
    const session = this.sessions[this.opens]
    this.opens += 1
    if (session === undefined) return Promise.reject(new Error('fake ASR exhausted'))
    return Promise.resolve(session)
  }
}

class FakeLlm implements CascadedLlmSession {
  readonly calls: LlmStreamInput[] = []
  readonly #eventSets: (readonly CascadedLlmEvent[])[]
  closed = false
  abandons = 0

  constructor(...eventSets: (readonly CascadedLlmEvent[])[]) {
    this.#eventSets = [...eventSets]
  }

  async *stream(input: LlmStreamInput): AsyncIterable<CascadedLlmEvent> {
    if (this.closed) throw new Error('fake LLM is closed')
    this.calls.push(structuredClone(input))
    await Promise.resolve()
    for (const event of this.#eventSets.shift() ?? []) yield structuredClone(event)
  }

  abandonPendingResponse(): Promise<void> {
    this.abandons += 1
    return Promise.resolve()
  }

  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
}

class TerminalWindowLlm implements CascadedLlmSession {
  readonly calls: LlmStreamInput[] = []
  readonly committed = deferred<void>()
  readonly aborted = deferred<void>()
  readonly #terminalGate = deferred<void>()
  continuationPending = false
  abandons = 0
  closed = false

  async *stream(input: LlmStreamInput): AsyncIterable<CascadedLlmEvent> {
    this.calls.push(structuredClone(input))
    if (this.calls.length === 1) {
      yield {kind: 'response_started', response_id: 'response-window'}
      yield {kind: 'tool_call', item_id: 'item-window', call_id: 'call-window',
        name: 'weather', arguments: {}}
      this.continuationPending = true
      this.committed.resolve(undefined)
      const noteAbort = (): void => { this.aborted.resolve(undefined) }
      if (input.signal.aborted) noteAbort()
      else input.signal.addEventListener('abort', noteAbort, {once: true})
      await this.#terminalGate.promise
      yield {kind: 'response_completed', response_id: 'response-window'}
      return
    }
    if (this.continuationPending) throw new Error('hidden continuation reached unrelated response')
    yield {kind: 'response_started', response_id: 'response-unrelated'}
    yield {kind: 'response_completed', response_id: 'response-unrelated'}
  }

  releaseTerminal(): void { this.#terminalGate.resolve(undefined) }

  abandonPendingResponse(): Promise<void> {
    this.abandons += 1
    this.continuationPending = false
    return Promise.resolve()
  }

  close(): Promise<void> {
    this.closed = true
    this.continuationPending = false
    this.releaseTerminal()
    return Promise.resolve()
  }
}

class FakeTtsSession implements TtsSession {
  readonly texts: string[] = []
  readonly #audio: readonly Uint8Array[]
  #release: (() => void) | null = null
  readonly #finished = new Promise<void>(resolve => { this.#release = resolve })
  cancelled = false
  closed = false

  constructor(...audio: readonly Uint8Array[]) {
    this.#audio = audio.map(pcm => pcm.slice())
  }

  sendText(text: string): Promise<void> {
    this.texts.push(text)
    return Promise.resolve()
  }

  finish(): Promise<void> {
    this.#release?.()
    return Promise.resolve()
  }

  cancel(): Promise<void> {
    this.cancelled = true
    this.#release?.()
    return Promise.resolve()
  }

  async *events(): AsyncIterable<TtsAudio> {
    await this.#finished
    if (!this.cancelled) for (const pcm of this.#audio) yield {pcm: pcm.slice()}
  }

  close(): Promise<void> {
    this.closed = true
    this.#release?.()
    return Promise.resolve()
  }
}

class FakeTtsClient implements TtsClient {
  readonly sessions: TtsSession[]
  opens = 0

  constructor(...sessions: TtsSession[]) {
    this.sessions = sessions
  }

  open(): Promise<TtsSession> {
    const session = this.sessions[this.opens]
    this.opens += 1
    if (session === undefined) return Promise.reject(new Error('fake TTS exhausted'))
    return Promise.resolve(session)
  }
}

class RecordingTelemetry implements RealtimeTelemetry {
  readonly records: {readonly kind: string; readonly payload: Readonly<Record<string, unknown>>}[] = []
  closed = false

  record(kind: string, payload: Readonly<Record<string, unknown>>): void {
    this.records.push({kind, payload: structuredClone(payload)})
  }

  close(): void {
    this.closed = true
  }
}

class BlockingLlm implements CascadedLlmSession {
  readonly calls: LlmStreamInput[] = []
  closed = false

  async *stream(input: LlmStreamInput): AsyncIterable<CascadedLlmEvent> {
    this.calls.push(structuredClone(input))
    yield {kind: 'response_started', response_id: 'response-blocked'}
    await new Promise<void>((_resolve, reject) => {
      const abort = (): void => reject(new DOMException('aborted', 'AbortError'))
      input.signal?.addEventListener('abort', abort, {once: true})
    })
  }

  abandonPendingResponse(): Promise<void> { return Promise.resolve() }

  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
}

class LateLlm implements CascadedLlmSession {
  #release: (() => void) | null = null
  readonly #released = new Promise<void>(resolve => { this.#release = resolve })
  closed = false

  async *stream(): AsyncIterable<CascadedLlmEvent> {
    yield {kind: 'response_started', response_id: 'response-old'}
    await this.#released
    yield {kind: 'text_delta', text: 'stale-provider-secret'}
    yield {kind: 'response_completed', response_id: 'response-old'}
  }

  release(): void { this.#release?.() }
  abandonPendingResponse(): Promise<void> { return Promise.resolve() }
  close(): Promise<void> { this.closed = true; return Promise.resolve() }
}

class FailSendTtsSession implements TtsSession {
  readonly texts: string[] = []
  #release: (() => void) | null = null
  readonly #stopped = new Promise<void>(resolve => { this.#release = resolve })
  closed = false

  sendText(text: string): Promise<void> {
    this.texts.push(text)
    return Promise.reject(new Error('tts-provider-secret'))
  }

  finish(): Promise<void> { this.#release?.(); return Promise.resolve() }
  cancel(): Promise<void> { this.#release?.(); return Promise.resolve() }
  async *events(): AsyncIterable<TtsAudio> { await this.#stopped }
  close(): Promise<void> { this.closed = true; this.#release?.(); return Promise.resolve() }
}

class FailAfterAudioTtsSession implements TtsSession {
  readonly texts: string[] = []
  #finished = false
  #release: (() => void) | null = null
  readonly #finishWait = new Promise<void>(resolve => { this.#release = resolve })
  closed = false

  sendText(text: string): Promise<void> { this.texts.push(text); return Promise.resolve() }
  finish(): Promise<void> { this.#finished = true; this.#release?.(); return Promise.resolve() }
  cancel(): Promise<void> { this.#release?.(); return Promise.resolve() }
  async *events(): AsyncIterable<TtsAudio> {
    await this.#finishWait
    if (!this.#finished) return
    yield {pcm: new Uint8Array([5, 6])}
    throw new Error('tts-provider-secret')
  }
  close(): Promise<void> { this.closed = true; this.#release?.(); return Promise.resolve() }
}

class FailSecondSendTtsSession extends FakeTtsSession {
  #calls = 0

  override sendText(text: string): Promise<void> {
    this.#calls += 1
    if (this.#calls === 2) return Promise.reject(new Error('tts-provider-secret'))
    return super.sendText(text)
  }
}

class FailFinishTtsSession extends FakeTtsSession {
  override finish(): Promise<void> {
    return Promise.reject(new Error('tts-provider-secret'))
  }
}

function ids(...values: readonly string[]): () => string {
  let index = 0
  return () => {
    const value = values[index]
    if (value === undefined) throw new Error('id fixture exhausted')
    index += 1
    return value
  }
}

async function collectThroughTerminal(
  adapter: CascadedRealtimeAdapter,
  signal = new AbortController().signal,
): Promise<RealtimeProviderEvent[]> {
  const seen: RealtimeProviderEvent[] = []
  for await (const raw of adapter.events(signal)) {
    const event = raw
    seen.push(event)
    if (event.kind === 'response_terminal') return seen
  }
  throw new Error('Volcengine event stream ended before a terminal')
}

function observe(adapter: CascadedRealtimeAdapter): {
  readonly events: RealtimeProviderEvent[]
  readonly stop: () => Promise<void>
} {
  const controller = new AbortController()
  const events: RealtimeProviderEvent[] = []
  const task = (async () => {
    for await (const raw of adapter.events(controller.signal)) {
      events.push(raw)
    }
  })()
  return {
    events,
    stop: async () => {
      controller.abort()
      await settleWithin('Volcengine observer stop', task)
    },
  }
}

async function waitFor(
  label: string,
  predicate: () => boolean,
  milliseconds = 500,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  let stopped = false
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not become true`)), milliseconds)
  })
  const checking = (async () => {
    while (!stopped && !predicate()) await new Promise<void>(resolve => setImmediate(resolve))
  })()
  try {
    await Promise.race([checking, expired])
  } finally {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
  }
}

function hostItem(
  host_item_id: string,
  content = '任务仍在运行',
): {
  readonly kind: 'progress'
  readonly host_item_id: string
  readonly event_id: string
  readonly content: string
  readonly call_id: null
} {
  return {kind: 'progress', host_item_id, event_id: `${host_item_id}-event`, content, call_id: null}
}

const directOptions = (): {
  readonly confirmationTimeout: null
  readonly asUserActivation: false
  readonly signal: AbortSignal
} => ({
  confirmationTimeout: null,
  asUserActivation: false,
  signal: new AbortController().signal,
})

function terminalStatus(events: readonly RealtimeProviderEvent[]): string | null {
  const last = events.at(-1)
  return last?.kind === 'response_terminal' ? last.status : null
}

test('cascaded happy path preserves VAD, ASR, LLM, TTS, and normalized event order', async () => {
  const onset = new Uint8Array([0, 0, 1, 0])
  const endpointing = new ScriptedEndpointing(
    [{kind: 'speech_start', pcm: onset}],
    [{kind: 'speech_end', commit: true}],
  )
  const asrSession = new FakeAsrSession(
    {text: '你', final: false},
    {text: '你好 Nova', final: true},
  )
  const llm = new FakeLlm([
    {kind: 'response_started', response_id: 'response-1'},
    {kind: 'text_delta', text: '你好，'},
    {kind: 'text_delta', text: '很高兴见到你。'},
    {kind: 'response_completed', response_id: 'response-1'},
  ])
  const ttsSession = new FakeTtsSession(new Uint8Array([1, 2]))
  const adapter = new CascadedRealtimeAdapter({
    endpointing,
    asr: new FakeAsrClient(asrSession),
    llm,
    tts: new FakeTtsClient(ttsSession),
    idFactory: ids('session-1', 'speech-1', 'item-1'),
  })
  const connected = await adapter.connect({tools: [], signal: new AbortController().signal})
  const collecting = collectThroughTerminal(adapter)

  const callerPcm = new Uint8Array([9, 0])
  await adapter.sendAudio(callerPcm, new AbortController().signal)
  callerPcm[0] = 7
  await adapter.sendAudio(new Uint8Array([8, 0]), new AbortController().signal)
  const events = await settleWithin('Volcengine happy path', collecting)

  assert.deepEqual(connected, {epoch: 1, provider_session_id: 'session-1'})
  assert.deepEqual(events.map(event => event.kind), [
    'user_speech_started',
    'user_speech_ended',
    'user_transcript_delta',
    'user_transcript_final',
    'response_started',
    'response_transcript_delta',
    'response_transcript_delta',
    'response_audio_delta',
    'response_transcript_final',
    'response_terminal',
  ])
  assert.deepEqual(asrSession.appended, [onset])
  assert.deepEqual(llm.calls[0]?.inputs, [{kind: 'user_text', text: '你好 Nova'}])
  assert.deepEqual(ttsSession.texts, ['你好，', '很高兴见到你。'])
  assert.equal(ttsSession.closed, true)
  assert.equal(endpointing.resets, 2, 'connect and utterance completion reset endpointing')
})

test('cascaded Guard policy is fixed and cannot inherit the Qwen reconnect policy', () => {
  assert.deepEqual(CASCADED_GUARD_POLICY, {
    controlledGuardReconnect: false,
    guardHistoryRecovery: 'none',
    guardHistoryPairs: 4,
  })
  assert.equal(Object.isFrozen(CASCADED_GUARD_POLICY), true)
})

test('one adapter reconnects with a fresh LLM epoch instead of reusing a closed session', async () => {
  const first = new FakeLlm()
  const second = new FakeLlm([
    {kind: 'response_started', response_id: 'response-reconnected'},
    {kind: 'response_completed', response_id: 'response-reconnected'},
  ])
  const sessions = [second]
  const factory: CascadedLlmFactory = {
    open: () => {
      const session = sessions.shift()
      if (session === undefined) throw new Error('LLM factory exhausted')
      return session
    },
  }
  const adapter = new CascadedRealtimeAdapter({
    endpointing: new ScriptedEndpointing(),
    asr: new FakeAsrClient(),
    llm: first,
    tts: new FakeTtsClient(),
    idFactory: ids('session-first', 'session-second', 'provider-reconnected'),
    llmFactory: factory,
  })

  await adapter.connect({tools: [], signal: new AbortController().signal})
  await adapter.close()
  const identity = await adapter.connect({tools: [], signal: new AbortController().signal})
  const item = hostItem('reconnected-host')
  await adapter.injectHostItem(item, directOptions())
  const collecting = collectThroughTerminal(adapter)
  await adapter.createResponse(
    {kind: 'host_fact', item, task_summary: null, origin_spoken: false},
    new AbortController().signal,
  )
  const events = await settleWithin('reconnected response', collecting)

  assert.equal(identity.epoch, 2)
  assert.equal(first.closed, true)
  assert.equal(second.calls.length, 1)
  assert.equal(terminalStatus(events), 'completed')
  await adapter.close()
})

test('every final ASR segment becomes its own user turn, matching the Python adapter', async () => {
  const llm = new FakeLlm(
    [
      {kind: 'response_started', response_id: 'response-first-final'},
      {kind: 'response_completed', response_id: 'response-first-final'},
    ],
    [
      {kind: 'response_started', response_id: 'response-second-final'},
      {kind: 'response_completed', response_id: 'response-second-final'},
    ],
  )
  const adapter = new CascadedRealtimeAdapter({
    endpointing: new ScriptedEndpointing(
      [{kind: 'speech_start', pcm: new Uint8Array([0, 0])}],
      [{kind: 'speech_end', commit: true}],
    ),
    asr: new FakeAsrClient(new FakeAsrSession(
      {text: '第一段', final: true},
      {text: '第二段', final: true},
    )),
    llm,
    tts: new FakeTtsClient(new FakeTtsSession(), new FakeTtsSession()),
    idFactory: ids(
      'session-multi-final', 'speech-multi-final', 'item-multi-final',
      'provider-first-final', 'provider-second-final',
    ),
  })
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const watching = observe(adapter)

  await adapter.sendAudio(new Uint8Array([0, 0]), new AbortController().signal)
  await adapter.sendAudio(new Uint8Array([0, 0]), new AbortController().signal)
  await waitFor('both ASR finals', () => llm.calls.length === 2)

  assert.deepEqual(llm.calls.map(call => call.inputs), [
    [{kind: 'user_text', text: '第一段'}],
    [{kind: 'user_text', text: '第二段'}],
  ])
  assert.deepEqual(watching.events
    .filter((event): event is Extract<RealtimeProviderEvent, {kind: 'user_transcript_final'}> => (
      event.kind === 'user_transcript_final'
    ))
    .map(event => event.text), ['第一段', '第二段'])
  await watching.stop()
  await adapter.close()
})

test('host inputs and copied Responses tools preserve Python wording and caller ownership', async () => {
  const llm = new FakeLlm([
    {kind: 'response_started', response_id: 'response-host'},
    {kind: 'response_completed', response_id: 'response-host'},
  ])
  const tool = {
    type: 'function',
    function: {
      name: 'weather__get', description: '天气',
      parameters: {type: 'object', properties: {city: {type: 'string'}}},
    },
  }
  const adapter = new CascadedRealtimeAdapter({
    endpointing: new ScriptedEndpointing(),
    asr: new FakeAsrClient(),
    llm,
    tts: new FakeTtsClient(new FakeTtsSession()),
    idFactory: ids('session-host', 'provider-host'),
  })
  await adapter.connect({tools: [tool], signal: new AbortController().signal})
  tool.function.name = 'caller-mutated'
  tool.function.parameters.properties.city.type = 'number'
  const item = hostItem('progress-host', '第一项')
  await adapter.injectHostItem(item, directOptions())
  const collecting = collectThroughTerminal(adapter)
  await adapter.createResponse({
    kind: 'host_fact', item, task_summary: null, origin_spoken: false,
  }, new AbortController().signal)
  await settleWithin('host response', collecting)

  assert.deepEqual(llm.calls[0]?.inputs, [{
    kind: 'host_context', content: 'Nova Audio Agent 任务进度事实：第一项',
  }])
  assert.deepEqual(llm.calls[0]?.tools, [{
    name: 'weather__get', description: '天气',
    parameters: {type: 'object', properties: {city: {type: 'string'}}},
  }])
})

test('cascaded adapter replaces workspace context without adding old context to LLM history', async () => {
  const llm = new FakeLlm(
    [
      {kind: 'response_started', response_id: 'response-workspace-1'},
      {kind: 'response_completed', response_id: 'response-workspace-1'},
    ],
    [
      {kind: 'response_started', response_id: 'response-workspace-2'},
      {kind: 'response_completed', response_id: 'response-workspace-2'},
    ],
  )
  const adapter = new CascadedRealtimeAdapter({
    endpointing: new ScriptedEndpointing(),
    asr: new FakeAsrClient(),
    llm,
    tts: new FakeTtsClient(),
    idFactory: ids(
      'session-workspace', 'provider-workspace-1', 'provider-fact-1',
      'provider-workspace-2', 'provider-fact-2',
    ),
  })
  await adapter.connect({tools: [], signal: new AbortController().signal})

  const first = await adapter.injectWorkspaceContext({
    kind: 'workspace_context',
    host_item_id: 'workspace-header-1',
    event_id: 'workspace-event-1',
    content: '<active_project_context>first</active_project_context>',
    call_id: null,
    session_epoch: 1,
    workspace_instance_id: 'wi-a',
    revision: 1,
  }, {confirmationTimeout: null, signal: new AbortController().signal})
  assert.deepEqual(first.delivery, {
    capability: 'replace_provider_item', delivered: true,
    session_epoch: 1, workspace_instance_id: 'wi-a', revision: 1,
    prior_provider_item_id: null, provider_item_id: 'provider-workspace-1',
    superseded_provider_item_id: null,
  })

  const firstFact = hostItem('progress-workspace-1', 'first response')
  await adapter.injectHostItem(firstFact, directOptions())
  const watching = observe(adapter)
  await adapter.createResponse({
    kind: 'host_fact', item: firstFact, task_summary: null, origin_spoken: false,
  }, new AbortController().signal)
  await waitFor('first workspace response', () => watching.events.some(event =>
    event.kind === 'response_terminal' && event.response_id === 'response-workspace-1'))

  const second = await adapter.injectWorkspaceContext({
    kind: 'workspace_context',
    host_item_id: 'workspace-header-2',
    event_id: 'workspace-event-2',
    content: '<active_project_context>second</active_project_context>',
    call_id: null,
    session_epoch: 1,
    workspace_instance_id: 'wi-a',
    revision: 2,
  }, {confirmationTimeout: null, signal: new AbortController().signal})
  assert.deepEqual(second.delivery, {
    capability: 'replace_provider_item', delivered: true,
    session_epoch: 1, workspace_instance_id: 'wi-a', revision: 2,
    prior_provider_item_id: 'provider-workspace-1', provider_item_id: 'provider-workspace-2',
    superseded_provider_item_id: 'provider-workspace-1',
  })

  const secondFact = hostItem('progress-workspace-2', 'second response')
  await adapter.injectHostItem(secondFact, directOptions())
  await adapter.createResponse({
    kind: 'host_fact', item: secondFact, task_summary: null, origin_spoken: false,
  }, new AbortController().signal)
  await waitFor('second workspace response', () => watching.events.some(event =>
    event.kind === 'response_terminal' && event.response_id === 'response-workspace-2'))

  assert.equal(llm.calls[0]?.workspaceContext,
    '<active_project_context>first</active_project_context>')
  assert.equal(llm.calls[1]?.workspaceContext,
    '<active_project_context>second</active_project_context>')
  assert.equal(JSON.stringify(llm.calls[1]).includes('>first<'), false)
  await watching.stop()
})

test('adapter supplies semantic user text and matching structured tool results to the LLM',
  async () => {
    const endpointing = new ScriptedEndpointing(
      [{kind: 'speech_start', pcm: new Uint8Array([0, 0])}],
      [{kind: 'speech_end', commit: true}],
    )
    const llm = new FakeLlm(
      [
        {kind: 'response_started', response_id: 'response-tool'},
        {kind: 'tool_call', item_id: 'item-1', call_id: 'call-1',
          name: 'weather__get', arguments: {}},
        {kind: 'response_completed', response_id: 'response-tool'},
      ],
      [
        {kind: 'response_started', response_id: 'response-result'},
        {kind: 'response_completed', response_id: 'response-result'},
      ],
    )
    const adapter = new CascadedRealtimeAdapter({
      endpointing,
      asr: new FakeAsrClient(new FakeAsrSession({text: '你好', final: true})),
      llm,
      tts: new FakeTtsClient(new FakeTtsSession(), new FakeTtsSession()),
      idFactory: ids('session-semantic', 'speech-semantic', 'item-semantic', 'provider-result'),
    })
    await adapter.connect({tools: [], signal: new AbortController().signal})
    const watching = observe(adapter)
    await adapter.sendAudio(new Uint8Array([0, 0]), new AbortController().signal)
    await adapter.sendAudio(new Uint8Array([0, 0]), new AbortController().signal)
    await waitFor('semantic tool call', () => watching.events.some(event =>
      event.kind === 'tool_call_ready'))
    const result = {
      kind: 'tool_output' as const,
      host_item_id: 'tool-result', event_id: 'tool-result-event',
      content: '{"temperature":20}', call_id: 'call-1',
    }
    await adapter.injectHostItem(result, directOptions())
    await adapter.createResponse({
      kind: 'tool_result', item: result, task_summary: null, origin_spoken: false,
    }, new AbortController().signal)
    await waitFor('semantic tool continuation', () => llm.calls.length === 2)

    assert.deepEqual(llm.calls[0]?.inputs.at(-1), {kind: 'user_text', text: '你好'})
    assert.deepEqual(llm.calls[1]?.inputs.at(-1), {
      kind: 'tool_result', call_id: 'call-1', output: {temperature: 20},
    })
    assert.equal(llm.abandons, 0)
    await watching.stop()
  })

test('Python-strip blank ASR final fails the item and never starts LLM', async () => {
  const endpointing = new ScriptedEndpointing(
    [{kind: 'speech_start', pcm: new Uint8Array([0, 0])}],
    [{kind: 'speech_end', commit: true}],
  )
  const asr = new FakeAsrSession({text: '\u001c\u0085', final: true})
  const llm = new FakeLlm([])
  const adapter = new CascadedRealtimeAdapter({
    endpointing, asr: new FakeAsrClient(asr), llm,
    tts: new FakeTtsClient(), idFactory: ids('session-blank', 'speech-blank', 'item-blank'),
  })
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const watching = observe(adapter)
  await adapter.sendAudio(new Uint8Array([0, 0]), new AbortController().signal)
  await adapter.sendAudio(new Uint8Array([0, 0]), new AbortController().signal)
  await waitFor('blank ASR final', () => watching.events.some(event =>
    event.kind === 'user_transcript_failed'))

  assert.equal(llm.calls.length, 0)
  assert.equal(watching.events.some(event => event.kind === 'user_transcript_final'), false)
  await watching.stop()
})

test('an ASR append failure is recoverable and a later utterance still completes', async () => {
  class AppendFailSession implements AsrSession {
    #release: (() => void) | null = null
    readonly #stopped = new Promise<void>(resolve => { this.#release = resolve })
    #appends = 0
    closed = false
    append(): Promise<void> {
      this.#appends += 1
      return this.#appends === 2
        ? Promise.reject(new Error('asr-provider-secret'))
        : Promise.resolve()
    }
    finish(): Promise<void> { return Promise.resolve() }
    async *events(): AsyncIterable<AsrTranscript> { await this.#stopped }
    close(): Promise<void> { this.closed = true; this.#release?.(); return Promise.resolve() }
  }
  const failed = new AppendFailSession()
  const recovered = new FakeAsrSession({text: '恢复成功', final: true})
  const endpointing = new ScriptedEndpointing(
    [{kind: 'speech_start', pcm: new Uint8Array([0, 0])}],
    [{kind: 'speech_audio', pcm: new Uint8Array([2, 0])}],
    [{kind: 'speech_end', commit: true}],
    [{kind: 'speech_start', pcm: new Uint8Array([1, 0])}],
    [{kind: 'speech_end', commit: true}],
  )
  const llm = new FakeLlm([
    {kind: 'response_started', response_id: 'response-recovered'},
    {kind: 'text_delta', text: '好了。'},
    {kind: 'response_completed', response_id: 'response-recovered'},
  ])
  const adapter = new CascadedRealtimeAdapter({
    endpointing, asr: new FakeAsrClient(failed, recovered), llm,
    tts: new FakeTtsClient(new FakeTtsSession(new Uint8Array([1, 2]))),
    idFactory: ids('session-recover', 'speech-fail', 'item-fail', 'speech-ok', 'item-ok'),
  })
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const watching = observe(adapter)

  await assert.doesNotReject(adapter.sendAudio(
    new Uint8Array([0, 0]), new AbortController().signal,
  ))
  await adapter.sendAudio(new Uint8Array([0, 0]), new AbortController().signal)
  await adapter.sendAudio(new Uint8Array([0, 0]), new AbortController().signal)
  await adapter.sendAudio(new Uint8Array([0, 0]), new AbortController().signal)
  await adapter.sendAudio(new Uint8Array([0, 0]), new AbortController().signal)
  await waitFor('recovered response', () => watching.events.some(event =>
    event.kind === 'response_terminal' && event.status === 'completed'))

  const failure = watching.events.find(event => event.kind === 'provider_error')
  assert.deepEqual(failure, {
    kind: 'provider_error', session_epoch: 1,
    code: 'volcengine_asr_append', recoverable: true,
  })
  assert.equal(watching.events.some(event => event.kind === 'user_transcript_failed'), true)
  assert.equal(failed.closed, true)
  await watching.stop()
})

test('ASR receive failure keeps the speech identity until VAD stop releases the floor', async () => {
  class ReceiveFailSession implements AsrSession {
    append(): Promise<void> { return Promise.resolve() }
    finish(): Promise<void> { return Promise.resolve() }
    async *events(): AsyncIterable<AsrTranscript> {
      await Promise.resolve()
      throw new Error('asr-receive-provider-secret')
    }
    close(): Promise<void> { return Promise.resolve() }
  }
  const adapter = new CascadedRealtimeAdapter({
    endpointing: new ScriptedEndpointing(
      [{kind: 'speech_start', pcm: new Uint8Array([0, 0])}],
      [{kind: 'speech_end', commit: true}],
    ),
    asr: new FakeAsrClient(new ReceiveFailSession()), llm: new FakeLlm([]),
    tts: new FakeTtsClient(),
    idFactory: ids('session-receive', 'speech-receive', 'item-receive'),
  })
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const watching = observe(adapter)
  await adapter.sendAudio(new Uint8Array([0, 0]), new AbortController().signal)
  await waitFor('ASR receive failure', () => watching.events.some(event =>
    event.kind === 'provider_error' && event.code === 'volcengine_asr_receive'))
  await adapter.sendAudio(new Uint8Array([0, 0]), new AbortController().signal)
  await waitFor('speech end after ASR receive failure', () => watching.events.some(event =>
    event.kind === 'user_speech_ended'))

  assert.equal(watching.events.filter(event => event.kind === 'user_speech_ended').length, 1)
  assert.equal(watching.events.some(event => event.kind === 'user_transcript_failed'), true)
  await watching.stop()
})

test('tool-only output cancels prewarm, while both mixed-output orders fail without exposing tools', async () => {
  const scenarios: (readonly CascadedLlmEvent[])[] = [
    [
      {kind: 'response_started', response_id: 'tool-only'},
      {kind: 'tool_call', item_id: 'item-tool', call_id: 'call-tool',
        name: 'weather__get', arguments: {city: '上海'}},
      {kind: 'response_completed', response_id: 'tool-only'},
    ],
    [
      {kind: 'response_started', response_id: 'text-tool'},
      {kind: 'text_delta', text: '我来查，'},
      {kind: 'tool_call', item_id: 'item-mixed', call_id: 'call-mixed',
        name: 'weather__get', arguments: {}},
      {kind: 'response_completed', response_id: 'text-tool'},
    ],
    [
      {kind: 'response_started', response_id: 'tool-text'},
      {kind: 'tool_call', item_id: 'item-mixed', call_id: 'call-mixed',
        name: 'weather__get', arguments: {}},
      {kind: 'text_delta', text: '不应出现'},
      {kind: 'response_completed', response_id: 'tool-text'},
    ],
  ]
  for (let index = 0; index < scenarios.length; index += 1) {
    const ttsSession = new FakeTtsSession()
    const adapter = new CascadedRealtimeAdapter({
      endpointing: new ScriptedEndpointing(), asr: new FakeAsrClient(),
      llm: new FakeLlm(scenarios[index]!),
      tts: new FakeTtsClient(ttsSession),
      idFactory: ids(`session-${index}`, `provider-${index}`),
    })
    await adapter.connect({tools: [], signal: new AbortController().signal})
    const item = hostItem(`progress-${index}`)
    await adapter.injectHostItem(item, directOptions())
    const collecting = collectThroughTerminal(adapter)
    await adapter.createResponse({kind: 'host_fact', item, task_summary: null, origin_spoken: false},
      new AbortController().signal)
    const events = await settleWithin(`tool scenario ${index}`, collecting)
    if (index === 0) {
      assert.equal(events.some(event => event.kind === 'tool_call_ready'), true)
      assert.equal(terminalStatus(events), 'completed')
    } else {
      assert.equal(events.some(event => event.kind === 'tool_call_ready'), false)
      assert.equal(events.some(event => event.kind === 'provider_error'
        && event.code === 'cascaded_mixed_text_tool' && !event.recoverable), true)
      assert.equal(terminalStatus(events), 'failed')
    }
    assert.equal(ttsSession.cancelled, true)
  }
})

test('an empty text response releases its prewarmed TTS session', async () => {
  const ttsSession = new FakeTtsSession()
  const adapter = new CascadedRealtimeAdapter({
    endpointing: new ScriptedEndpointing(), asr: new FakeAsrClient(),
    llm: new FakeLlm([
      {kind: 'response_started', response_id: 'response-empty-text'},
      {kind: 'text_delta', text: ''},
      {kind: 'response_completed', response_id: 'response-empty-text'},
    ]),
    tts: new FakeTtsClient(ttsSession),
    idFactory: ids('session-empty-text', 'provider-empty-text'),
  })
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const item = hostItem('empty-text')
  await adapter.injectHostItem(item, directOptions())
  const collecting = collectThroughTerminal(adapter)
  await adapter.createResponse(
    {kind: 'host_fact', item, task_summary: null, origin_spoken: false},
    new AbortController().signal,
  )
  const events = await settleWithin('empty text response', collecting)

  assert.equal(terminalStatus(events), 'completed')
  assert.deepEqual(ttsSession.texts, [])
  assert.equal(ttsSession.cancelled, true)
  assert.equal(ttsSession.closed, true)
})

test('a common LLM failure uses a provider-neutral stable owner code', async () => {
  const adapter = new CascadedRealtimeAdapter({
    endpointing: new ScriptedEndpointing(), asr: new FakeAsrClient(),
    llm: new FakeLlm([
      {kind: 'response_started', response_id: 'response-common-failure'},
      {kind: 'response_failed', response_id: 'response-common-failure', code: 'protocol'},
    ]),
    tts: new FakeTtsClient(new FakeTtsSession()),
    idFactory: ids('session-common-failure', 'provider-common-failure'),
  })
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const item = hostItem('common-failure')
  await adapter.injectHostItem(item, directOptions())
  const collecting = collectThroughTerminal(adapter)
  await adapter.createResponse({kind: 'host_fact', item, task_summary: null, origin_spoken: false},
    new AbortController().signal)
  const events = await collecting

  assert.equal(events.some(event => event.kind === 'provider_error'
    && event.code === 'cascaded_response_failed' && event.recoverable), true)
  assert.equal(terminalStatus(events), 'failed')
  await adapter.close()
})

test('an unresolved tool resets chaining and a late abandoned output never calls LLM', async () => {
  const llm = new FakeLlm(
    [
      {kind: 'response_started', response_id: 'response-tool'},
      {kind: 'tool_call', item_id: 'item-tool', call_id: 'call-tool',
        name: 'weather__get', arguments: {}},
      {kind: 'response_completed', response_id: 'response-tool'},
    ],
    [
      {kind: 'response_started', response_id: 'response-next'},
      {kind: 'response_completed', response_id: 'response-next'},
    ],
  )
  const adapter = new CascadedRealtimeAdapter({
    endpointing: new ScriptedEndpointing(), asr: new FakeAsrClient(), llm,
    tts: new FakeTtsClient(new FakeTtsSession(), new FakeTtsSession()),
    idFactory: ids('session-chain', 'provider-first', 'provider-next', 'provider-late', 'silent-late'),
  })
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const watching = observe(adapter)

  const first = hostItem('first')
  await adapter.injectHostItem(first, directOptions())
  await adapter.createResponse({kind: 'host_fact', item: first, task_summary: null,
    origin_spoken: false}, new AbortController().signal)
  await waitFor('first tool terminal', () => watching.events.filter(event =>
    event.kind === 'response_terminal').length === 1)

  const next = hostItem('next')
  await adapter.injectHostItem(next, directOptions())
  await adapter.createResponse({kind: 'host_fact', item: next, task_summary: null,
    origin_spoken: false}, new AbortController().signal)
  await waitFor('next terminal', () => watching.events.filter(event =>
    event.kind === 'response_terminal').length === 2)
  assert.equal(llm.abandons, 1)
  assert.deepEqual(llm.calls[1]?.inputs.at(-1), {
    kind: 'host_context', content: 'Nova Audio Agent 任务进度事实：任务仍在运行',
  })

  const late = {
    kind: 'tool_output' as const,
    host_item_id: 'late-output', event_id: 'late-event', content: '{"late":true}',
    call_id: 'call-tool',
  }
  await adapter.injectHostItem(late, directOptions())
  await adapter.createResponse({kind: 'tool_result', item: late, task_summary: null,
    origin_spoken: false}, new AbortController().signal)
  await waitFor('late silent terminal', () => watching.events.filter(event =>
    event.kind === 'response_terminal').length === 3)
  assert.equal(llm.calls.length, 2)
  await watching.stop()
})

test('concurrent explicit responses share one held abandonment transition', async () => {
  class DeferredAbandonLlm extends FakeLlm {
    readonly started = deferred<void>()
    readonly gate = deferred<void>()

    override async abandonPendingResponse(): Promise<void> {
      this.abandons += 1
      this.started.resolve()
      await this.gate.promise
    }
  }
  const llm = new DeferredAbandonLlm(
    [
      {kind: 'response_started', response_id: 'response-tool'},
      {kind: 'tool_call', item_id: 'item-tool', call_id: 'call-tool', name: 'weather', arguments: {}},
      {kind: 'response_completed', response_id: 'response-tool'},
    ],
    [
      {kind: 'response_started', response_id: 'response-next'},
      {kind: 'response_completed', response_id: 'response-next'},
    ],
  )
  const adapter = new CascadedRealtimeAdapter({
    endpointing: new ScriptedEndpointing(), asr: new FakeAsrClient(), llm,
    tts: new FakeTtsClient(new FakeTtsSession()),
    idFactory: ids('session-explicit-race', 'provider-first', 'provider-next-1', 'provider-next-2'),
  })
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const watching = observe(adapter)
  const first = hostItem('first')
  await adapter.injectHostItem(first, directOptions())
  await adapter.createResponse({kind: 'host_fact', item: first, task_summary: null,
    origin_spoken: false}, new AbortController().signal)
  await waitFor('explicit race tool terminal', () => watching.events.some(event =>
    event.kind === 'response_terminal'))

  const next1 = hostItem('next-1')
  const next2 = hostItem('next-2')
  await adapter.injectHostItem(next1, directOptions())
  await adapter.injectHostItem(next2, directOptions())
  const firstStart = adapter.createResponse({kind: 'host_fact', item: next1, task_summary: null,
    origin_spoken: false}, new AbortController().signal)
  await llm.started.promise
  const secondStart = assert.rejects(adapter.createResponse({
    kind: 'host_fact', item: next2, task_summary: null, origin_spoken: false,
  }, new AbortController().signal),
  (error: unknown) => error instanceof CascadedRealtimeError && error.code === 'response_active')
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(llm.calls.length, 1)
  assert.equal(llm.abandons, 1)

  llm.gate.resolve()
  await firstStart
  await secondStart
  await waitFor('explicit race response start', () => llm.calls.length === 2)
  assert.equal(llm.abandons, 1)
  await watching.stop()
  await adapter.close()
})

test('ASR and explicit responses share the held abandonment transition', async () => {
  class DeferredAbandonLlm extends FakeLlm {
    readonly started = deferred<void>()
    readonly gate = deferred<void>()

    override async abandonPendingResponse(): Promise<void> {
      this.abandons += 1
      this.started.resolve()
      await this.gate.promise
    }
  }
  const llm = new DeferredAbandonLlm(
    [
      {kind: 'response_started', response_id: 'response-tool'},
      {kind: 'tool_call', item_id: 'item-tool', call_id: 'call-tool', name: 'weather', arguments: {}},
      {kind: 'response_completed', response_id: 'response-tool'},
    ],
    [
      {kind: 'response_started', response_id: 'response-asr'},
      {kind: 'response_completed', response_id: 'response-asr'},
    ],
  )
  const endpointing = new ScriptedEndpointing(
    [{kind: 'speech_start', pcm: new Uint8Array([0, 0])}],
    [{kind: 'speech_end', commit: true}],
  )
  const adapter = new CascadedRealtimeAdapter({
    endpointing, asr: new FakeAsrClient(new FakeAsrSession({text: 'new speech', final: true})), llm,
    tts: new FakeTtsClient(new FakeTtsSession()),
    idFactory: ids(
      'session-asr-race', 'provider-first', 'speech-asr-race', 'item-asr-race', 'provider-manual',
    ),
  })
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const watching = observe(adapter)
  const first = hostItem('first')
  await adapter.injectHostItem(first, directOptions())
  await adapter.createResponse({kind: 'host_fact', item: first, task_summary: null,
    origin_spoken: false}, new AbortController().signal)
  await waitFor('ASR race tool terminal', () => watching.events.some(event =>
    event.kind === 'response_terminal'))

  await adapter.sendAudio(new Uint8Array([0, 0]), new AbortController().signal)
  await adapter.sendAudio(new Uint8Array([0, 0]), new AbortController().signal)
  await llm.started.promise
  const manual = hostItem('manual')
  await adapter.injectHostItem(manual, directOptions())
  const manualStart = assert.rejects(adapter.createResponse({
    kind: 'host_fact', item: manual, task_summary: null, origin_spoken: false,
  }, new AbortController().signal),
  (error: unknown) => error instanceof CascadedRealtimeError && error.code === 'response_active')
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(llm.calls.length, 1)
  assert.equal(llm.abandons, 1)

  llm.gate.resolve()
  await manualStart
  await waitFor('ASR race response start', () => llm.calls.length === 2)
  assert.deepEqual(llm.calls[1]?.inputs.at(-1), {kind: 'user_text', text: 'new speech'})
  assert.equal(llm.abandons, 1)
  await watching.stop()
  await adapter.close()
})

test('an abandoned-continuation reset failure is bounded and closes the owner', async () => {
  class BlockingAbandonLlm extends FakeLlm {
    readonly started = deferred<void>()

    override abandonPendingResponse(): Promise<void> {
      this.abandons += 1
      this.started.resolve()
      return new Promise<void>(() => undefined)
    }
  }
  const llm = new BlockingAbandonLlm([
    {kind: 'response_started', response_id: 'response-tool'},
    {kind: 'tool_call', item_id: 'item-tool', call_id: 'call-tool', name: 'weather', arguments: {}},
    {kind: 'response_completed', response_id: 'response-tool'},
  ])
  const adapter = new CascadedRealtimeAdapter({
    endpointing: new ScriptedEndpointing(), asr: new FakeAsrClient(), llm,
    tts: new FakeTtsClient(new FakeTtsSession()),
    idFactory: ids('session-abandon-failure', 'provider-first', 'provider-next', 'provider-queued'),
    settleTimeoutMs: 10,
  })
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const first = hostItem('first')
  await adapter.injectHostItem(first, directOptions())
  const terminal = collectThroughTerminal(adapter)
  await adapter.createResponse({kind: 'host_fact', item: first, task_summary: null,
    origin_spoken: false}, new AbortController().signal)
  await terminal

  const next = hostItem('next')
  const queued = hostItem('queued')
  await adapter.injectHostItem(next, directOptions())
  await adapter.injectHostItem(queued, directOptions())
  const firstFailure = assert.rejects(settleWithin('abandon reset failure', adapter.createResponse({
    kind: 'host_fact', item: next, task_summary: null, origin_spoken: false,
  }, new AbortController().signal), 150),
  (error: unknown) => error instanceof CascadedRealtimeError && error.code === 'closed')
  await llm.started.promise
  const queuedFailure = assert.rejects(adapter.createResponse({
    kind: 'host_fact', item: queued, task_summary: null, origin_spoken: false,
  }, new AbortController().signal),
  (error: unknown) => error instanceof CascadedRealtimeError
    && (error.code === 'closed' || error.code === 'state'))
  await firstFailure
  await queuedFailure
  assert.equal(llm.closed, true)
  assert.equal(llm.calls.length, 1)
  assert.equal(llm.abandons, 1)
})

test('TTS retries once before audio with every prior chunk, and never retries after audio', async () => {
  const beforeFirst = new FailSendTtsSession()
  const beforeSecond = new FakeTtsSession(new Uint8Array([1, 2]))
  const beforeClient = new FakeTtsClient(beforeFirst, beforeSecond)
  const beforeAdapter = new CascadedRealtimeAdapter({
    endpointing: new ScriptedEndpointing(), asr: new FakeAsrClient(),
    llm: new FakeLlm([
      {kind: 'response_started', response_id: 'response-before'},
      {kind: 'text_delta', text: '第一句。'},
      {kind: 'text_delta', text: '第二句。'},
      {kind: 'response_completed', response_id: 'response-before'},
    ]),
    tts: beforeClient, idFactory: ids('session-before', 'provider-before'),
  })
  await beforeAdapter.connect({tools: [], signal: new AbortController().signal})
  const beforeItem = hostItem('before')
  await beforeAdapter.injectHostItem(beforeItem, directOptions())
  const beforeCollect = collectThroughTerminal(beforeAdapter)
  await beforeAdapter.createResponse({kind: 'host_fact', item: beforeItem,
    task_summary: null, origin_spoken: false}, new AbortController().signal)
  const beforeEvents = await settleWithin('TTS before-audio retry', beforeCollect)
  assert.equal(beforeClient.opens, 2)
  assert.deepEqual(beforeSecond.texts, ['第一句。', '第二句。'])
  assert.equal(terminalStatus(beforeEvents), 'completed')

  const afterFirst = new FailAfterAudioTtsSession()
  const afterClient = new FakeTtsClient(afterFirst, new FakeTtsSession())
  const afterAdapter = new CascadedRealtimeAdapter({
    endpointing: new ScriptedEndpointing(), asr: new FakeAsrClient(),
    llm: new FakeLlm([
      {kind: 'response_started', response_id: 'response-after'},
      {kind: 'text_delta', text: '已经出声。'},
      {kind: 'response_completed', response_id: 'response-after'},
    ]),
    tts: afterClient, idFactory: ids('session-after', 'provider-after'),
  })
  await afterAdapter.connect({tools: [], signal: new AbortController().signal})
  const afterItem = hostItem('after')
  await afterAdapter.injectHostItem(afterItem, directOptions())
  const afterCollect = collectThroughTerminal(afterAdapter)
  await afterAdapter.createResponse({kind: 'host_fact', item: afterItem,
    task_summary: null, origin_spoken: false}, new AbortController().signal)
  const afterEvents = await settleWithin('TTS after-audio failure', afterCollect)
  assert.equal(afterClient.opens, 1)
  assert.equal(afterEvents.some(event => event.kind === 'response_audio_delta'), true)
  assert.equal(afterEvents.some(event => event.kind === 'provider_error'
    && event.code === 'volcengine_tts_receive'), true)
  assert.equal(terminalStatus(afterEvents), 'failed')
})

test('TTS never opens a third session after the one permitted retry also fails', async () => {
  const client = new FakeTtsClient(
    new FailSendTtsSession(),
    new FailSecondSendTtsSession(),
    new FakeTtsSession(new Uint8Array([1, 2])),
  )
  const adapter = new CascadedRealtimeAdapter({
    endpointing: new ScriptedEndpointing(), asr: new FakeAsrClient(),
    llm: new FakeLlm([
      {kind: 'response_started', response_id: 'response-retry-once'},
      {kind: 'text_delta', text: '第一句。'},
      {kind: 'text_delta', text: '第二句。'},
      {kind: 'response_completed', response_id: 'response-retry-once'},
    ]),
    tts: client, idFactory: ids('session-retry-once', 'provider-retry-once'),
  })
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const item = hostItem('retry-once')
  await adapter.injectHostItem(item, directOptions())
  const collecting = collectThroughTerminal(adapter)
  await adapter.createResponse({kind: 'host_fact', item, task_summary: null, origin_spoken: false},
    new AbortController().signal)
  const events = await settleWithin('single TTS retry', collecting)
  assert.equal(client.opens, 2)
  assert.equal(events.some(event => event.kind === 'provider_error'
    && event.code === 'volcengine_tts_receive'), true)
  assert.equal(terminalStatus(events), 'failed')
})

test('a pre-audio finish failure replays every accumulated text chunk in order', async () => {
  const first = new FailFinishTtsSession()
  const second = new FakeTtsSession(new Uint8Array([1, 2]))
  const client = new FakeTtsClient(first, second)
  const adapter = new CascadedRealtimeAdapter({
    endpointing: new ScriptedEndpointing(), asr: new FakeAsrClient(),
    llm: new FakeLlm([
      {kind: 'response_started', response_id: 'response-finish-retry'},
      {kind: 'text_delta', text: '第一句。'},
      {kind: 'text_delta', text: '第二句。'},
      {kind: 'response_completed', response_id: 'response-finish-retry'},
    ]),
    tts: client, idFactory: ids('session-finish-retry', 'provider-finish-retry'),
  })
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const item = hostItem('finish-retry')
  await adapter.injectHostItem(item, directOptions())
  const collecting = collectThroughTerminal(adapter)
  await adapter.createResponse({kind: 'host_fact', item, task_summary: null, origin_spoken: false},
    new AbortController().signal)
  const events = await settleWithin('TTS finish retry replay', collecting)
  assert.equal(client.opens, 2)
  assert.deepEqual(second.texts, ['第一句。', '第二句。'])
  assert.equal(terminalStatus(events), 'completed')
})

test('exact cancellation is single-terminal; mismatch is safely rejected; telemetry stays caller-owned', async () => {
  const llm = new BlockingLlm()
  const telemetry = new RecordingTelemetry()
  const tts = new FakeTtsSession()
  const adapter = new CascadedRealtimeAdapter({
    endpointing: new ScriptedEndpointing(), asr: new FakeAsrClient(),
    llm, tts: new FakeTtsClient(tts), telemetry,
    idFactory: ids('session-cancel', 'provider-cancel', 'cancel-request'),
  })
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const item = hostItem('cancel-item')
  await adapter.injectHostItem(item, directOptions())
  const watching = observe(adapter)
  await adapter.createResponse({kind: 'host_fact', item, task_summary: null, origin_spoken: false},
    new AbortController().signal)
  await waitFor('blocking response started', () => watching.events.some(event =>
    event.kind === 'response_started'))

  await adapter.cancelResponse('wrong-response', new AbortController().signal)
  await waitFor('cancel rejection', () => watching.events.some(event =>
    event.kind === 'response_cancel_rejected'))
  await adapter.cancelResponse('response-blocked', new AbortController().signal)
  await waitFor('cancel terminal', () => watching.events.some(event =>
    event.kind === 'response_terminal' && event.status === 'cancelled'))
  assert.equal(watching.events.filter(event => event.kind === 'response_terminal').length, 1)

  const closing = adapter.close()
  assert.equal(closing, adapter.close())
  await settleWithin('adapter close', closing)
  assert.equal(llm.closed, true)
  assert.equal(telemetry.closed, false)
  assert.doesNotMatch(JSON.stringify({events: watching.events, telemetry: telemetry.records}),
    /provider-secret|api-secret|transcript-secret/u)
  await watching.stop()
})

test('cancellation abandons a committed tool continuation before an unrelated response exactly once',
  async () => {
    const llm = new TerminalWindowLlm()
    const adapter = new CascadedRealtimeAdapter({
      endpointing: new ScriptedEndpointing(), asr: new FakeAsrClient(), llm,
      tts: new FakeTtsClient(new FakeTtsSession(), new FakeTtsSession()),
      idFactory: ids('session-window-cancel', 'provider-first', 'provider-next'),
    })
    await adapter.connect({tools: [], signal: new AbortController().signal})
    const watching = observe(adapter)
    const first = hostItem('window-first')
    await adapter.injectHostItem(first, directOptions())
    await adapter.createResponse({kind: 'host_fact', item: first, task_summary: null,
      origin_spoken: false}, new AbortController().signal)
    await llm.committed.promise

    const cancelling = adapter.cancelResponse('response-window', new AbortController().signal)
    await llm.aborted.promise
    llm.releaseTerminal()
    await cancelling
    assert.equal(llm.abandons, 1)
    assert.equal(llm.continuationPending, false)

    const next = hostItem('window-next')
    await adapter.injectHostItem(next, directOptions())
    await adapter.createResponse({kind: 'host_fact', item: next, task_summary: null,
      origin_spoken: false}, new AbortController().signal)
    await waitFor('unrelated response after cancellation', () => llm.calls.length === 2
      && watching.events.filter(event => event.kind === 'response_terminal').length === 2)
    assert.equal(llm.abandons, 1)
    assert.equal(watching.events.filter(event => event.kind === 'tool_call_ready').length, 0)
    await watching.stop()
    await adapter.close()
  })

test('speech barge-in abandons a committed tool continuation before starting its response',
  async () => {
    const llm = new TerminalWindowLlm()
    const adapter = new CascadedRealtimeAdapter({
      endpointing: new ScriptedEndpointing(
        [{kind: 'speech_start', pcm: new Uint8Array([0, 0])}],
        [{kind: 'speech_end', commit: true}],
      ),
      asr: new FakeAsrClient(new FakeAsrSession({text: 'new speech', final: true})),
      llm,
      tts: new FakeTtsClient(new FakeTtsSession(), new FakeTtsSession()),
      idFactory: ids('session-window-barge', 'provider-first', 'speech-barge', 'item-barge'),
    })
    await adapter.connect({tools: [], signal: new AbortController().signal})
    const watching = observe(adapter)
    const first = hostItem('barge-first')
    await adapter.injectHostItem(first, directOptions())
    await adapter.createResponse({kind: 'host_fact', item: first, task_summary: null,
      origin_spoken: false}, new AbortController().signal)
    await llm.committed.promise

    await adapter.sendAudio(new Uint8Array([0, 0]), new AbortController().signal)
    await adapter.sendAudio(new Uint8Array([0, 0]), new AbortController().signal)
    await llm.aborted.promise
    llm.releaseTerminal()
    await waitFor('barge-in response after continuation reset', () => llm.calls.length === 2
      && watching.events.filter(event => event.kind === 'response_terminal').length === 2)

    assert.equal(llm.abandons, 1)
    assert.equal(llm.continuationPending, false)
    assert.deepEqual(llm.calls[1]?.inputs.at(-1), {kind: 'user_text', text: 'new speech'})
    await watching.stop()
    await adapter.close()
  })

test('closing an active response emits one cancelled terminal into its owning epoch', async () => {
  const llm = new BlockingLlm()
  const telemetry = new RecordingTelemetry()
  const tts = new FakeTtsSession()
  const adapter = new CascadedRealtimeAdapter({
    endpointing: new ScriptedEndpointing(), asr: new FakeAsrClient(),
    llm, tts: new FakeTtsClient(tts), telemetry,
    idFactory: ids('session-close-active', 'provider-close-active'),
  })
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const item = hostItem('close-active-item')
  await adapter.injectHostItem(item, directOptions())
  const watching = observe(adapter)
  await adapter.createResponse({kind: 'host_fact', item, task_summary: null, origin_spoken: false},
    new AbortController().signal)
  await waitFor('active response started before close', () => watching.events.some(event =>
    event.kind === 'response_started'))

  await settleWithin('active response close', adapter.close())
  await waitFor('close cancellation terminal', () => watching.events.some(event =>
    event.kind === 'response_terminal' && event.status === 'cancelled'))

  const terminals = watching.events.filter(event => event.kind === 'response_terminal')
  assert.equal(terminals.length, 1)
  assert.deepEqual(terminals[0], {
    kind: 'response_terminal', session_epoch: 1,
    response_id: 'response-blocked', status: 'cancelled', reason: 'cancelled',
  })
  assert.equal(llm.closed, true)
  assert.equal(tts.cancelled, true)
  assert.equal(tts.closed, true)
  assert.equal(telemetry.records.filter(record =>
    record.kind === 'volcengine.response.terminal').length, 1)
  await watching.stop()
})

test('close bounds a stuck response and directly releases its active TTS resources', async () => {
  class BlockingSendTtsSession extends FakeTtsSession {
    sendCalls = 0
    #release: (() => void) | null = null
    readonly #blocked = new Promise<void>(resolve => { this.#release = resolve })

    override sendText(text: string): Promise<void> {
      this.texts.push(text)
      this.sendCalls += 1
      return this.#blocked
    }

    release(): void { this.#release?.() }
  }
  const tts = new BlockingSendTtsSession()
  const llm = new FakeLlm([
    {kind: 'response_started', response_id: 'response-stuck-tts'},
    {kind: 'text_delta', text: '开始。'},
    {kind: 'response_completed', response_id: 'response-stuck-tts'},
  ])
  const adapter = new CascadedRealtimeAdapter({
    endpointing: new ScriptedEndpointing(), asr: new FakeAsrClient(),
    llm, tts: new FakeTtsClient(tts),
    idFactory: ids('session-stuck-tts', 'provider-stuck-tts'), settleTimeoutMs: 20,
  })
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const item = hostItem('stuck-tts')
  await adapter.injectHostItem(item, directOptions())
  await adapter.createResponse({kind: 'host_fact', item, task_summary: null, origin_spoken: false},
    new AbortController().signal)
  await waitFor('stuck TTS send', () => tts.sendCalls === 1)

  await assert.rejects(settleWithin('bounded stuck TTS close', adapter.close(), 150),
    (error: unknown) => error instanceof CascadedRealtimeError && error.code === 'closed')
  assert.equal(tts.cancelled, true)
  assert.equal(tts.closed, true)
  tts.release()
})

test('close bounds pending endpoint work and gives a fresh epoch an independent audio tail',
  async () => {
    class BlockingFirstEndpointing implements EndpointingPort {
      calls = 0
      #release: (() => void) | null = null
      readonly #blocked = new Promise<void>(resolve => { this.#release = resolve })
      feed(): Promise<readonly EndpointingEvent[]> {
        this.calls += 1
        if (this.calls !== 1) return Promise.resolve([])
        return this.#blocked.then(() => [])
      }
      reset(): Promise<void> { return Promise.resolve() }
      close(): Promise<void> { return Promise.resolve() }
      release(): void { this.#release?.() }
    }
    const endpointing = new BlockingFirstEndpointing()
    const oldAdapter = new CascadedRealtimeAdapter({
      endpointing, asr: new FakeAsrClient(), tts: new FakeTtsClient(),
      llm: new FakeLlm([]),
      idFactory: ids('session-audio-old'), settleTimeoutMs: 20,
    })
    await oldAdapter.connect({tools: [], signal: new AbortController().signal})
    const oldAudio = oldAdapter.sendAudio(new Uint8Array([0, 0]), new AbortController().signal)
    void oldAudio.catch(() => undefined)
    await waitFor('old endpoint feed', () => endpointing.calls === 1)
    try {
      const closing = oldAdapter.close()
      void closing.catch(() => undefined)
      await assert.rejects(settleWithin('post-close audio refusal', oldAdapter.sendAudio(
        new Uint8Array([0, 0]), new AbortController().signal,
      ), 100), (error: unknown) => error instanceof CascadedRealtimeError
        && error.code === 'state')
      await assert.rejects(settleWithin('bounded endpoint close', closing, 150),
        (error: unknown) => error instanceof CascadedRealtimeError && error.code === 'closed')
      const newAdapter = new CascadedRealtimeAdapter({
        endpointing, asr: new FakeAsrClient(), tts: new FakeTtsClient(),
        llm: new FakeLlm([]), idFactory: ids('session-audio-new'), initialEpoch: 1,
      })
      await newAdapter.connect({tools: [], signal: new AbortController().signal})
      await settleWithin('fresh audio tail', newAdapter.sendAudio(
        new Uint8Array([0, 0]), new AbortController().signal,
      ), 100)
      assert.equal(endpointing.calls, 2)
      await newAdapter.close()
    } finally {
      endpointing.release()
      await settleWithin('old endpoint feed release', oldAudio.catch(() => undefined))
      await oldAdapter.close().catch(() => undefined)
    }
  })

test('close bounds every injected teardown even when LLM and endpoint reset ignore cancellation',
  async () => {
    let releaseArk: (() => void) | undefined
    let releaseReset: (() => void) | undefined
    const arkBlocked = new Promise<void>(resolve => { releaseArk = resolve })
    const resetBlocked = new Promise<void>(resolve => { releaseReset = resolve })
    let resetCalls = 0
    const endpointing: EndpointingPort = {
      feed: () => Promise.resolve([]),
      reset: () => {
        resetCalls += 1
        return resetCalls === 1 ? Promise.resolve() : resetBlocked
      },
      close: () => Promise.resolve(),
    }
    const llm: CascadedLlmSession = {
      stream: () => new FakeLlm([]).stream({
        inputs: [], tools: [], signal: new AbortController().signal,
      }),
      abandonPendingResponse: () => Promise.resolve(),
      close: () => arkBlocked,
    }
    const adapter = new CascadedRealtimeAdapter({
      endpointing, asr: new FakeAsrClient(), tts: new FakeTtsClient(),
      llm, idFactory: ids('session-stuck-cleanup'), settleTimeoutMs: 20,
    })
    await adapter.connect({tools: [], signal: new AbortController().signal})
    try {
      await assert.rejects(settleWithin('bounded injected cleanup', adapter.close(), 150),
        (error: unknown) => error instanceof CascadedRealtimeError && error.code === 'closed')
      assert.equal(resetCalls, 2)
    } finally {
      releaseArk?.()
      releaseReset?.()
    }
  })

test('close bounds a stuck ASR close and still releases the remaining epoch resources', async () => {
  class BlockingCloseAsrSession extends FakeAsrSession {
    closeCalls = 0
    #releaseClose: (() => void) | null = null
    readonly #blockedClose = new Promise<void>(resolve => { this.#releaseClose = resolve })

    override async close(): Promise<void> {
      this.closeCalls += 1
      await this.#blockedClose
      await super.close()
    }

    releaseClose(): void { this.#releaseClose?.() }
  }
  const asr = new BlockingCloseAsrSession()
  const endpointing = new ScriptedEndpointing([
    {kind: 'speech_start', pcm: new Uint8Array([0, 0])},
  ])
  const llm = new FakeLlm([])
  const adapter = new CascadedRealtimeAdapter({
    endpointing, asr: new FakeAsrClient(asr), tts: new FakeTtsClient(),
    llm, idFactory: ids(
      'session-stuck-asr', 'speech-stuck-asr', 'item-stuck-asr',
    ), settleTimeoutMs: 20,
  })
  await adapter.connect({tools: [], signal: new AbortController().signal})
  await adapter.sendAudio(new Uint8Array([0, 0]), new AbortController().signal)
  try {
    await assert.rejects(settleWithin('bounded ASR cleanup', adapter.close(), 150),
      (error: unknown) => error instanceof CascadedRealtimeError && error.code === 'closed')
    assert.equal(asr.closeCalls, 1)
    assert.equal(llm.closed, true)
    assert.equal(endpointing.resets, 2)
  } finally {
    asr.releaseClose()
  }
})

test('duplicate and 256-item pending bounds reject without evicting an earlier item', async () => {
  let sequence = 0
  const adapter = new CascadedRealtimeAdapter({
    endpointing: new ScriptedEndpointing(), asr: new FakeAsrClient(),
    llm: new FakeLlm([]), tts: new FakeTtsClient(),
    idFactory: () => `bounded-${sequence++}`,
  })
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const first = hostItem('bounded-first')
  await adapter.injectHostItem(first, directOptions())
  await assert.rejects(adapter.injectHostItem(first, directOptions()),
    (error: unknown) => error instanceof Error
      && 'code' in error && error.code === 'duplicate_host_item')
  for (let index = 1; index < 256; index += 1) {
    await adapter.injectHostItem(hostItem(`bounded-${index}`), directOptions())
  }
  await assert.rejects(adapter.injectHostItem(hostItem('bounded-over'), directOptions()),
    (error: unknown) => error instanceof Error
      && 'code' in error && error.code === 'pending_host_items_full')
})

test('a missing target cannot consume recovery context or start LLM', async () => {
  const llm = new FakeLlm([
    {kind: 'response_started', response_id: 'response-should-not-start'},
    {kind: 'response_completed', response_id: 'response-should-not-start'},
  ])
  const adapter = new CascadedRealtimeAdapter({
    endpointing: new ScriptedEndpointing(), asr: new FakeAsrClient(),
    llm, tts: new FakeTtsClient(),
    idFactory: ids('session-missing-target', 'provider-recovery', 'provider-guard'),
  })
  await adapter.connect({tools: [], signal: new AbortController().signal})
  await adapter.injectHostItem({
    kind: 'recovery', host_item_id: 'recovery-only', event_id: 'recovery-event',
    content: '旧会话恢复。', call_id: null,
  }, directOptions())
  const missing = hostItem('missing-target')
  await assert.rejects(adapter.createResponse({
    kind: 'host_fact', item: missing, task_summary: null, origin_spoken: false,
  }, new AbortController().signal),
  (error: unknown) => error instanceof CascadedRealtimeError
      && error.code === 'missing_host_input')
  assert.equal(llm.calls.length, 0)

  const guard = hostItem('guard-after-missing')
  await adapter.injectHostItem(guard, directOptions())
  await adapter.createResponse({kind: 'host_fact', item: guard,
    task_summary: null, origin_spoken: false}, new AbortController().signal)
  await waitFor('recovery retained after missing target', () => llm.calls.length === 1)
  assert.equal(llm.calls[0]?.inputs.length, 2)
  await adapter.close()
})

test('event queue overflow preserves every prior event, surfaces one stable failure, and terminates',
  async () => {
    class FloodAsrSession implements AsrSession {
      #release: (() => void) | null = null
      readonly #finished = new Promise<void>(resolve => { this.#release = resolve })
      append(): Promise<void> { return Promise.resolve() }
      finish(): Promise<void> { this.#release?.(); return Promise.resolve() }
      async *events(): AsyncIterable<AsrTranscript> {
        await this.#finished
        for (let index = 0; index < 4_100; index += 1) yield {text: '', final: false}
      }
      close(): Promise<void> { this.#release?.(); return Promise.resolve() }
    }
    const llm = new FakeLlm([])
    const adapter = new CascadedRealtimeAdapter({
      endpointing: new ScriptedEndpointing(
        [{kind: 'speech_start', pcm: new Uint8Array([0, 0])}],
        [{kind: 'speech_end', commit: true}],
      ),
      asr: new FakeAsrClient(new FloodAsrSession()),
      llm,
      tts: new FakeTtsClient(),
      idFactory: ids('session-overflow', 'speech-overflow', 'item-overflow'),
      settleTimeoutMs: 50,
    })
    await adapter.connect({tools: [], signal: new AbortController().signal})
    const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]()
    const first = iterator.next()
    await adapter.sendAudio(new Uint8Array([0, 0]), new AbortController().signal)
    const firstResult = await settleWithin('overflow speech start', first)
    assert.equal(firstResult.done, false)
    if (!firstResult.done) assert.equal(firstResult.value.kind, 'user_speech_started')

    await adapter.sendAudio(new Uint8Array([0, 0]), new AbortController().signal)
    await waitFor('overflow cleanup', () => llm.closed)
    const drained: RealtimeProviderEvent[] = []
    while (true) {
      const result = await settleWithin('overflow queue drain', iterator.next())
      if (result.done) break
      drained.push(result.value)
    }
    assert.equal(drained.filter(event => event.kind === 'user_transcript_delta').length, 4_095)
    assert.equal(drained[0]?.kind, 'user_speech_ended')
    assert.deepEqual(drained.at(-1), {
      kind: 'provider_error', session_epoch: 1,
      code: 'volcengine_event_overflow', recoverable: false,
    })
  })

test('response transcript bound counts Unicode code points rather than UTF-16 units', async () => {
  const text = '😀'.repeat(3_000)
  const adapter = new CascadedRealtimeAdapter({
    endpointing: new ScriptedEndpointing(), asr: new FakeAsrClient(),
    llm: new FakeLlm([
      {kind: 'response_started', response_id: 'response-unicode'},
      {kind: 'text_delta', text},
      {kind: 'response_completed', response_id: 'response-unicode'},
    ]),
    tts: new FakeTtsClient(new FakeTtsSession(new Uint8Array([1, 2]))),
    idFactory: ids('session-unicode', 'provider-unicode'),
  })
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const item = hostItem('unicode')
  await adapter.injectHostItem(item, directOptions())
  const collecting = collectThroughTerminal(adapter)
  await adapter.createResponse({kind: 'host_fact', item, task_summary: null, origin_spoken: false},
    new AbortController().signal)
  const events = await settleWithin('Unicode response bound', collecting)
  assert.equal(terminalStatus(events), 'completed')
  assert.equal(events.some(event => event.kind === 'response_transcript_final'
    && event.text === text), true)
})

test('queued response audio has an independent 16 MiB aggregate bound', async () => {
  const pcmBlocks = Array.from({length: 17}, () => new Uint8Array(1_024 * 1_024))
  const llm = new FakeLlm([
    {kind: 'response_started', response_id: 'response-audio-overflow'},
    {kind: 'text_delta', text: '会溢出。'},
    {kind: 'response_completed', response_id: 'response-audio-overflow'},
  ])
  const adapter = new CascadedRealtimeAdapter({
    endpointing: new ScriptedEndpointing(), asr: new FakeAsrClient(), llm,
    tts: new FakeTtsClient(new FakeTtsSession(...pcmBlocks)),
    idFactory: ids('session-audio-overflow', 'provider-audio-overflow'),
    settleTimeoutMs: 50,
  })
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const item = hostItem('audio-overflow')
  await adapter.injectHostItem(item, directOptions())
  const iterator = adapter.events(new AbortController().signal)[Symbol.asyncIterator]()
  const first = iterator.next()
  await adapter.createResponse({kind: 'host_fact', item, task_summary: null, origin_spoken: false},
    new AbortController().signal)
  const firstResult = await settleWithin('audio overflow response start', first)
  assert.equal(firstResult.done, false)
  if (!firstResult.done) assert.equal(firstResult.value.kind, 'response_started')
  await waitFor('audio overflow cleanup', () => llm.closed)

  const drained: RealtimeProviderEvent[] = []
  while (true) {
    const result = await settleWithin('audio overflow queue drain', iterator.next())
    if (result.done) break
    drained.push(result.value)
  }
  assert.equal(drained.filter(event => event.kind === 'response_audio_delta').length, 16)
  assert.deepEqual(drained.at(-1), {
    kind: 'provider_error', session_epoch: 1,
    code: 'volcengine_event_overflow', recoverable: false,
  })
})

test('a task settling after an old epoch is revoked cannot enqueue into the fresh epoch', async () => {
  const oldLlm = new LateLlm()
  const newLlm = new FakeLlm([
    {kind: 'response_started', response_id: 'response-new'},
    {kind: 'response_completed', response_id: 'response-new'},
  ])
  const oldAdapter = new CascadedRealtimeAdapter({
    endpointing: new ScriptedEndpointing(), asr: new FakeAsrClient(),
    llm: oldLlm,
    tts: new FakeTtsClient(new FakeTtsSession()),
    idFactory: ids('session-old', 'provider-old'),
    settleTimeoutMs: 20,
  })
  await oldAdapter.connect({tools: [], signal: new AbortController().signal})
  const oldItem = hostItem('old')
  await oldAdapter.injectHostItem(oldItem, directOptions())
  const oldWatching = observe(oldAdapter)
  await oldAdapter.createResponse({kind: 'host_fact', item: oldItem,
    task_summary: null, origin_spoken: false}, new AbortController().signal)
  await waitFor('old response start', () => oldWatching.events.some(event =>
    event.kind === 'response_started'))
  await assert.rejects(settleWithin('bounded stale close', oldAdapter.close()),
    (error: unknown) => error instanceof Error
      && 'code' in error && error.code === 'closed')
  assert.equal(oldLlm.closed, true)

  const newAdapter = new CascadedRealtimeAdapter({
    endpointing: new ScriptedEndpointing(), asr: new FakeAsrClient(), llm: newLlm,
    tts: new FakeTtsClient(new FakeTtsSession()),
    idFactory: ids('session-new', 'provider-new'), initialEpoch: 1,
  })
  await newAdapter.connect({tools: [], signal: new AbortController().signal})
  const newItem = hostItem('new')
  await newAdapter.injectHostItem(newItem, directOptions())
  const newWatching = observe(newAdapter)
  await newAdapter.createResponse({kind: 'host_fact', item: newItem,
    task_summary: null, origin_spoken: false}, new AbortController().signal)
  await waitFor('fresh epoch response', () => newWatching.events.some(event =>
    event.kind === 'response_terminal'))
  oldLlm.release()
  await new Promise<void>(resolve => setImmediate(resolve))

  assert.deepEqual(newWatching.events.map(event => event.session_epoch), [2, 2])
  assert.doesNotMatch(JSON.stringify(newWatching.events), /stale-provider-secret/u)
  await newWatching.stop()
  await oldWatching.stop()
})
