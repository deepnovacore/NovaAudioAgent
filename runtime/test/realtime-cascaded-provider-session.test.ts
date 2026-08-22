import assert from 'node:assert/strict'
import { test } from 'node:test'
import { VirtualClock } from '../src/clock.js'
import { PlaybackRegistry } from '../src/playback.js'
import { RealtimeProviderSession } from '../src/realtime/provider-session.js'
import type { HostContextItem, RealtimeProviderEvent } from '../src/realtime/protocol.js'
import { RealtimeSession } from '../src/realtime/session.js'
import {
  CascadedRealtimeError,
} from '../src/realtime/cascaded/adapter.js'
import {CascadedRealtimeProvider} from '../src/realtime/cascaded/provider.js'
import type {
  AsrClient,
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

class NoopEndpointing implements EndpointingPort {
  resets = 0
  feed(): Promise<readonly []> { return Promise.resolve([]) }
  reset(): void { this.resets += 1 }
  close(): Promise<void> { return Promise.resolve() }
}

const unusedAsr: AsrClient = {
  open: () => Promise.reject(new Error('ASR is unused in this provider-session test')),
}

class EmptyTtsSession implements TtsSession {
  cancel(): Promise<void> { return Promise.resolve() }
  close(): Promise<void> { return Promise.resolve() }
  finish(): Promise<void> { return Promise.resolve() }
  sendText(): Promise<void> { return Promise.resolve() }
  async *events(): AsyncIterable<TtsAudio> { await Promise.resolve(); return }
}

const tts: TtsClient = {open: () => Promise.resolve(new EmptyTtsSession())}

function providerFor(input: {
  readonly llms: CascadedLlmSession[]
  readonly endpointingFactory?: () => Promise<EndpointingPort>
  readonly asrFactory?: () => AsrClient
  readonly ttsFactory?: () => TtsClient
  readonly idFactory: () => string
}): CascadedRealtimeProvider {
  const llmFactory: CascadedLlmFactory = {
    open: () => {
      const llm = input.llms.shift()
      if (llm === undefined) throw new Error('LLM fixture exhausted')
      return llm
    },
  }
  return new CascadedRealtimeProvider({
    endpointingFactory: input.endpointingFactory
      ?? (() => Promise.resolve(new NoopEndpointing())),
    asrFactory: {openClient: input.asrFactory ?? (() => unusedAsr)},
    llmFactory,
    ttsFactory: {openClient: input.ttsFactory ?? (() => tts)},
    idFactory: input.idFactory,
  })
}

class EpochLlm implements CascadedLlmSession {
  readonly calls: LlmStreamInput[] = []
  readonly #events: readonly CascadedLlmEvent[]
  closed = false

  constructor(events: readonly CascadedLlmEvent[] = []) {
    this.#events = events
  }

  async *stream(input: LlmStreamInput): AsyncIterable<CascadedLlmEvent> {
    this.calls.push(structuredClone(input))
    await Promise.resolve()
    for (const event of this.#events) yield structuredClone(event)
  }

  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
}

class BlockingEpochLlm implements CascadedLlmSession {
  readonly calls: LlmStreamInput[] = []
  closed = false

  async *stream(input: LlmStreamInput): AsyncIterable<CascadedLlmEvent> {
    this.calls.push(structuredClone(input))
    yield {kind: 'response_started', response_id: 'response-old'}
    const signal = input.signal
    if (signal === undefined) throw new Error('blocking LLM fixture requires a signal')
    await settleWithin('old LLM cancellation', new Promise<void>(resolve => {
      if (signal.aborted) resolve()
      else signal.addEventListener('abort', () => resolve(), {once: true})
    }))
    throw new DOMException('aborted', 'AbortError')
  }

  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
}

function idFactory(...values: readonly string[]): () => string {
  let index = 0
  return () => {
    const value = values[index]
    if (value === undefined) throw new Error('provider-session id fixture exhausted')
    index += 1
    return value
  }
}

async function collectTerminal(session: RealtimeProviderSession): Promise<RealtimeProviderEvent[]> {
  const events: RealtimeProviderEvent[] = []
  for await (const event of session.events()) {
    events.push(event)
    if (event.kind === 'response_terminal') return events
  }
  throw new Error('provider-session stream ended before terminal')
}

async function waitFor(label: string, predicate: () => boolean): Promise<void> {
  await settleWithin(label, (async () => {
    while (!predicate()) await new Promise<void>(resolve => setImmediate(resolve))
  })())
}

async function guardReconnectInputs(historyMode: 'none' | 'packed'): Promise<{
  readonly inputs: readonly Readonly<Record<string, unknown>>[]
  readonly outcome: string
}> {
  const firstLlm = new BlockingEpochLlm()
  const secondLlm = new EpochLlm([
    {kind: 'response_started', response_id: 'response-new'},
    {kind: 'response_completed', response_id: 'response-new'},
  ])
  const llms: CascadedLlmSession[] = [firstLlm, secondLlm]
  let adapterId = 0
  const adapter = providerFor({
    llms,
    idFactory: () => `volc-session-id-${++adapterId}`,
  })
  const provider = new RealtimeProviderSession(adapter)
  let hostId = 0
  const nextHostId = (): string => `volc-host-id-${++hostId}`
  const playback = new PlaybackRegistry({
    idFactory: nextHostId,
    onFrame: () => undefined,
    onClear: () => undefined,
  })
  const session = new RealtimeSession({
    provider, playback, idFactory: nextHostId, clock: new VirtualClock(),
    onDiagnostic: () => undefined,
  })
  await session.connect({tools: []})
  await session.deliverHostItem({
    kind: 'progress', host_item_id: 'old-host', event_id: 'old-event',
    content: '旧任务仍在运行。', call_id: null,
  })
  await waitFor('old LLM response start', () => firstLlm.calls.length === 1)
  await session.accept({
    kind: 'response_started', session_epoch: 1, response_id: 'response-old',
  })
  await session.accept({
    kind: 'response_audio_delta', session_epoch: 1, response_id: 'response-old',
    pcm: new Uint8Array([0, 1]),
  })
  const generation = session.currentGeneration
  if (generation === null) throw new Error('Guard fixture did not open playback')

  const history = [
    {
      sequence: 1, role: 'user' as const, text: '上一问', source: 'conversation' as const,
      delivery: 'user_final' as const, played_ms: null, trust: 'trusted_user' as const,
    },
    {
      sequence: 2, role: 'assistant' as const, text: '上一答', source: 'conversation' as const,
      delivery: 'spoken' as const, played_ms: 120, trust: 'trusted_system' as const,
    },
  ]
  const outcome = await session.reconnectForGuard({
    tools: [], oldGeneration: generation, historyMode, history,
  })
  await session.deliverPreemptiveHostResponse({
    kind: 'host_fact',
    item: {
      kind: 'progress', host_item_id: 'guard-host', event_id: 'guard-event',
      content: '请提醒用户。', call_id: null,
    },
    task_summary: null, origin_spoken: false,
  }, {asUserActivation: true})
  await waitFor('new LLM response input', () => secondLlm.calls.length === 1)
  const inputs = secondLlm.calls[0]?.inputs ?? []
  await provider.close()
  assert.equal(firstLlm.closed, true)
  assert.equal(secondLlm.closed, true)
  return {inputs, outcome}
}

test('formal provider session reconnect closes the epoch LLM, swaps streams, and deep-copies tools',
  async () => {
    const firstLlm = new EpochLlm()
    const secondLlm = new EpochLlm([
      {kind: 'response_started', response_id: 'response-second'},
      {kind: 'response_completed', response_id: 'response-second'},
    ])
    const llms = [firstLlm, secondLlm]
    const adapter = providerFor({
      llms,
      idFactory: idFactory('session-first', 'session-second', 'provider-item'),
    })
    const session = new RealtimeProviderSession(adapter)
    const tool = {
      type: 'function',
      function: {name: 'weather__get', parameters: {type: 'object'}},
    }
    assert.deepEqual(await session.connect([tool]), {
      epoch: 1, provider_session_id: 'session-first',
    })
    const oldIterator = session.events()[Symbol.asyncIterator]()
    const waitingOld = oldIterator.next()

    assert.deepEqual(await session.reconnect([tool]), {
      epoch: 2, provider_session_id: 'session-second',
    })
    assert.equal(firstLlm.closed, true)
    assert.deepEqual(await settleWithin('old epoch stream', waitingOld), {done: true, value: undefined})

    tool.function.name = 'caller-mutated'
    tool.function.parameters.type = 'array'
    const item: HostContextItem = {
      kind: 'progress', host_item_id: 'host-second', event_id: 'event-second',
      content: '第二轮', call_id: null,
    }
    await session.injectHostItem(item)
    const collecting = collectTerminal(session)
    await session.createResponse({
      kind: 'host_fact', item, task_summary: null, origin_spoken: false,
    })
    const events = await settleWithin('second epoch response', collecting)

    assert.deepEqual(events.map(event => event.session_epoch), [2, 2])
    assert.deepEqual(secondLlm.calls[0]?.tools, [
      {name: 'weather__get', parameters: {type: 'object'}},
    ])
    await session.close()
    assert.equal(secondLlm.closed, true)
  })

test('formal RealtimeSession Guard recovery keeps Volc history disabled but accepts packed input',
  async () => {
    const withoutHistory = await guardReconnectInputs('none')
    assert.equal(withoutHistory.outcome, 'none')
    assert.equal(withoutHistory.inputs.length, 2)
    assert.equal(withoutHistory.inputs[0]?.kind, 'host_context')
    assert.match(String(withoutHistory.inputs[0]?.content), /恢复摘要/u)
    assert.equal(withoutHistory.inputs[1]?.kind, 'host_context')
    assert.match(String(withoutHistory.inputs[1]?.content), /请提醒用户/u)
    assert.doesNotMatch(JSON.stringify(withoutHistory.inputs), /上一问|上一答/u)

    const packed = await guardReconnectInputs('packed')
    assert.equal(packed.outcome, 'packed')
    assert.equal(packed.inputs.length, 3)
    assert.equal(packed.inputs[0]?.kind, 'packed_history')
    assert.match(String(packed.inputs[0]?.content), /只读历史对话/u)
    assert.match(String(packed.inputs[0]?.content), /上一问/u)
    assert.match(String(packed.inputs[1]?.content), /恢复摘要/u)
    assert.match(String(packed.inputs[2]?.content), /请提醒用户/u)
  })

test('lazy cascaded owner constructs one fresh epoch per connect and closes idempotently',
  async () => {
    const operations: string[] = []
    let ids = 0
    const sessions: EpochLlm[] = []
    const provider = new CascadedRealtimeProvider({
      endpointingFactory: () => {
        operations.push('endpointing')
        return Promise.resolve({
          feed: () => Promise.resolve([]), reset: () => undefined,
          close: () => { operations.push('endpointing.close'); return Promise.resolve() },
        })
      },
      asrFactory: {openClient: () => { operations.push('asr'); return unusedAsr }},
      llmFactory: {open: () => {
        operations.push('llm')
        const session = new EpochLlm()
        sessions.push(session)
        return session
      }},
      ttsFactory: {openClient: () => { operations.push('tts'); return tts }},
      idFactory: () => `cascaded-owner-${++ids}`,
    })

    assert.deepEqual(operations, [])
    assert.deepEqual(await provider.connect({
      tools: [], signal: new AbortController().signal,
    }), {epoch: 1, provider_session_id: 'cascaded-owner-1'})
    assert.deepEqual(operations.slice(0, 4), ['endpointing', 'asr', 'llm', 'tts'])
    const closing = provider.close()
    assert.equal(provider.close(), closing)
    await closing
    assert.equal(sessions[0]?.closed, true)

    assert.deepEqual(await provider.connect({
      tools: [], signal: new AbortController().signal,
    }), {epoch: 2, provider_session_id: 'cascaded-owner-2'})
    await provider.close()
    assert.equal(sessions[1]?.closed, true)
    assert.equal(operations.filter(operation => operation === 'endpointing').length, 2)
    assert.equal(operations.filter(operation => operation === 'endpointing.close').length, 2)
  })

test('close owns an in-flight endpointing factory and prevents late resource construction',
  async () => {
    const gate = deferred<EndpointingPort>()
    let resources = 0
    const provider = new CascadedRealtimeProvider({
      endpointingFactory: () => gate.promise,
      asrFactory: {openClient: () => { resources += 1; return unusedAsr }},
      llmFactory: {open: () => { resources += 1; return new EpochLlm() }},
      ttsFactory: {openClient: () => { resources += 1; return tts }},
      idFactory: () => 'cascaded-close-owner',
    })
    const connecting = provider.connect({tools: [], signal: new AbortController().signal})
    await new Promise<void>(resolve => setImmediate(resolve))
    const closing = provider.close()
    await assert.rejects(
      provider.connect({tools: [], signal: new AbortController().signal}),
      error => error instanceof CascadedRealtimeError && error.code === 'state',
    )
    gate.resolve(new NoopEndpointing())
    await assert.rejects(connecting, {name: 'AbortError'})
    await closing
    assert.equal(resources, 0)
  })

test('partial connect failure rolls constructed resources back in reverse order and retries fresh',
  async () => {
    const operations: string[] = []
    let attempt = 0
    const provider = new CascadedRealtimeProvider({
      endpointingFactory: () => {
        operations.push(`endpointing.${attempt + 1}`)
        return Promise.resolve({
          feed: () => Promise.resolve([]), reset: () => undefined,
          close: () => { operations.push(`endpointing.close.${attempt}`); return Promise.resolve() },
        })
      },
      asrFactory: {openClient: () => { operations.push('asr'); return unusedAsr }},
      llmFactory: {open: () => {
        operations.push('llm')
        const llm = new EpochLlm()
        const close = llm.close.bind(llm)
        llm.close = () => { operations.push(`llm.close.${attempt}`); return close() }
        return llm
      }},
      ttsFactory: {openClient: () => {
        attempt += 1
        operations.push('tts')
        if (attempt === 1) throw new Error('private provider failure')
        return tts
      }},
      idFactory: () => `cascaded-rollback-${attempt}`,
    })

    await assert.rejects(
      provider.connect({tools: [], signal: new AbortController().signal}),
      error => error instanceof CascadedRealtimeError && error.code === 'configuration',
    )
    assert.deepEqual(operations, [
      'endpointing.1', 'asr', 'llm', 'tts', 'llm.close.1', 'endpointing.close.1',
    ])
    const identity = await provider.connect({tools: [], signal: new AbortController().signal})
    assert.equal(identity.epoch, 1)
    await provider.close()
  })
