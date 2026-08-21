import assert from 'node:assert/strict'
import { test } from 'node:test'
import { VirtualClock } from '../src/clock.js'
import { PlaybackRegistry } from '../src/playback.js'
import { RealtimeProviderSession } from '../src/realtime/provider-session.js'
import type { HostContextItem, RealtimeProviderEvent } from '../src/realtime/protocol.js'
import { RealtimeSession } from '../src/realtime/session.js'
import {
  VolcengineCascadedAdapter,
  type VolcAsrClient,
  type VolcEndpointingPort,
  type VolcTtsClient,
  type VolcTtsSession,
} from '../src/realtime/volcengine/adapter.js'
import type {
  ArkEvent,
  ArkResponsesGateway,
  ArkStreamInput,
} from '../src/realtime/volcengine/ark.js'
import type { TtsAudio } from '../src/realtime/volcengine/tts.js'

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

class NoopEndpointing implements VolcEndpointingPort {
  resets = 0
  feed(): Promise<readonly []> { return Promise.resolve([]) }
  reset(): void { this.resets += 1 }
  close(): Promise<void> { return Promise.resolve() }
}

const unusedAsr: VolcAsrClient = {
  open: () => Promise.reject(new Error('ASR is unused in this provider-session test')),
}

class EmptyTtsSession implements VolcTtsSession {
  cancel(): Promise<void> { return Promise.resolve() }
  close(): Promise<void> { return Promise.resolve() }
  finish(): Promise<void> { return Promise.resolve() }
  sendText(): Promise<void> { return Promise.resolve() }
  async *events(): AsyncIterable<TtsAudio> { await Promise.resolve(); return }
}

const tts: VolcTtsClient = {open: () => Promise.resolve(new EmptyTtsSession())}

class EpochArk implements ArkResponsesGateway {
  readonly calls: ArkStreamInput[] = []
  readonly #events: readonly ArkEvent[]
  closed = false

  constructor(events: readonly ArkEvent[] = []) {
    this.#events = events
  }

  async *stream(input: ArkStreamInput): AsyncIterable<ArkEvent> {
    this.calls.push(structuredClone(input))
    await Promise.resolve()
    for (const event of this.#events) yield structuredClone(event)
  }

  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
}

class BlockingEpochArk implements ArkResponsesGateway {
  readonly calls: ArkStreamInput[] = []
  closed = false

  async *stream(input: ArkStreamInput): AsyncIterable<ArkEvent> {
    this.calls.push(structuredClone(input))
    yield {kind: 'response_started', response_id: 'response-old'}
    const signal = input.signal
    if (signal === undefined) throw new Error('blocking Ark fixture requires a signal')
    await settleWithin('old Ark cancellation', new Promise<void>(resolve => {
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
  const firstArk = new BlockingEpochArk()
  const secondArk = new EpochArk([
    {kind: 'response_started', response_id: 'response-new'},
    {kind: 'response_completed', response_id: 'response-new'},
  ])
  const arks: ArkResponsesGateway[] = [firstArk, secondArk]
  let adapterId = 0
  const adapter = new VolcengineCascadedAdapter({
    endpointing: new NoopEndpointing(), asr: unusedAsr, tts,
    arkFactory: () => {
      const ark = arks.shift()
      if (ark === undefined) throw new Error('Ark fixture exhausted')
      return ark
    },
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
  await waitFor('old Ark response start', () => firstArk.calls.length === 1)
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
  await waitFor('new Ark response input', () => secondArk.calls.length === 1)
  const inputs = secondArk.calls[0]?.inputItems ?? []
  await provider.close()
  assert.equal(firstArk.closed, true)
  assert.equal(secondArk.closed, true)
  return {inputs, outcome}
}

test('formal provider session reconnect closes the epoch Ark, swaps streams, and deep-copies tools',
  async () => {
    const firstArk = new EpochArk()
    const secondArk = new EpochArk([
      {kind: 'response_started', response_id: 'response-second'},
      {kind: 'response_completed', response_id: 'response-second'},
    ])
    const arks = [firstArk, secondArk]
    const adapter = new VolcengineCascadedAdapter({
      endpointing: new NoopEndpointing(),
      asr: unusedAsr,
      tts,
      arkFactory: () => {
        const ark = arks.shift()
        if (ark === undefined) throw new Error('Ark fixture exhausted')
        return ark
      },
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
    assert.equal(firstArk.closed, true)
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
    assert.deepEqual(secondArk.calls[0]?.tools, [
      {type: 'function', name: 'weather__get', parameters: {type: 'object'}},
    ])
    await session.close()
    assert.equal(secondArk.closed, true)
  })

test('formal RealtimeSession Guard recovery keeps Volc history disabled but accepts packed input',
  async () => {
    const withoutHistory = await guardReconnectInputs('none')
    assert.equal(withoutHistory.outcome, 'none')
    assert.equal(withoutHistory.inputs.length, 2)
    assert.match(String(withoutHistory.inputs[0]?.content), /恢复摘要/u)
    assert.match(String(withoutHistory.inputs[1]?.content), /请提醒用户/u)
    assert.doesNotMatch(JSON.stringify(withoutHistory.inputs), /上一问|上一答/u)

    const packed = await guardReconnectInputs('packed')
    assert.equal(packed.outcome, 'packed')
    assert.equal(packed.inputs.length, 3)
    assert.match(String(packed.inputs[0]?.content), /只读历史对话/u)
    assert.match(String(packed.inputs[0]?.content), /上一问/u)
    assert.match(String(packed.inputs[1]?.content), /恢复摘要/u)
    assert.match(String(packed.inputs[2]?.content), /请提醒用户/u)
  })
