import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  FRONTEND_INSTRUCTIONS,
  GUARD_ACTIVATION_PREFIX,
  QwenAudioRealtimeAdapter,
  QwenRealtimeError,
  QwenSocketClosedError,
  type QwenSocket,
} from '../src/realtime/qwen.js'
import { ItemDeliveryUncertainError, type RealtimeProviderEvent } from '../src/realtime/protocol.js'

interface Scripted {
  readonly socket: QwenSocket
  readonly sent: Record<string, unknown>[]
  push(frame: Record<string, unknown>): void
  end(): void
}

/** A socket whose inbound frames are scripted and whose outbound frames are recorded. */
function scriptedSocket(initial: Record<string, unknown>[] = []): Scripted {
  const inbound: (Record<string, unknown> | null)[] = [...initial]
  const sent: Record<string, unknown>[] = []
  let wake: (() => void) | undefined
  const socket: QwenSocket = {
    send(payload) {
      sent.push(JSON.parse(payload) as Record<string, unknown>)
      return Promise.resolve()
    },
    async receive() {
      while (inbound.length === 0) {
        await new Promise<void>(resolve => { wake = resolve })
      }
      const next = inbound.shift()
      if (next === null || next === undefined) throw new QwenSocketClosedError()
      return JSON.stringify(next)
    },
    async close() { /* nothing to release */ },
  }
  return {
    socket,
    sent,
    push(frame) { inbound.push(frame); wake?.(); wake = undefined },
    end() { inbound.push(null); wake?.(); wake = undefined },
  }
}

function ids(): () => string {
  let sequence = 0
  return () => { sequence += 1; return `id-${sequence}` }
}

function adapterFor(scripted: Scripted, overrides: Record<string, unknown> = {}) {
  return new QwenAudioRealtimeAdapter({
    url: 'wss://example.invalid/realtime',
    apiKey: 'test-key',
    model: 'qwen-audio-3.0-realtime-plus',
    voice: 'longanqian',
    connector: () => Promise.resolve(scripted.socket),
    idFactory: ids(),
    ...overrides,
  })
}

const handshake = [
  {type: 'session.created', session: {id: 'sess-1'}},
  {type: 'session.updated', session: {id: 'sess-1'}},
]

test('connect performs the Qwen handshake and never logs the credential', async () => {
  const scripted = scriptedSocket([...handshake])
  let seenHeaders: Record<string, string> = {}
  const adapter = new QwenAudioRealtimeAdapter({
    url: 'wss://example.invalid/realtime',
    apiKey: 'secret-key-value',
    model: 'qwen-audio-3.0-realtime-plus',
    voice: 'longanqian',
    idFactory: ids(),
    connector: options => {
      seenHeaders = {...options.headers}
      assert.equal(options.endpoint,
        'wss://example.invalid/realtime?model=qwen-audio-3.0-realtime-plus')
      return Promise.resolve(scripted.socket)
    },
  })

  const identity = await adapter.connect({tools: [], signal: new AbortController().signal})
  assert.deepEqual(identity, {epoch: 1, provider_session_id: 'sess-1'})
  assert.equal(seenHeaders.Authorization, 'Bearer secret-key-value')

  const update = scripted.sent.find(frame => frame.type === 'session.update')
  assert.ok(update !== undefined)
  const session = update.session as Record<string, unknown>
  assert.deepEqual(session.modalities, ['audio', 'text'])
  assert.equal(session.voice, 'longanqian')
  assert.equal(session.input_audio_format, 'pcm')
  assert.equal(session.output_audio_format, 'pcm')
  assert.equal(session.max_history_turns, 20)
  assert.deepEqual(session.turn_detection, {type: 'smart_turn'})
  assert.equal(session.instructions, FRONTEND_INSTRUCTIONS)
  // A credential must never ride along inside the session payload.
  assert.doesNotMatch(JSON.stringify(update), /secret-key-value/u)
})

test('a session id that changes between created and updated is rejected', async () => {
  const scripted = scriptedSocket([
    {type: 'session.created', session: {id: 'sess-1'}},
    {type: 'session.updated', session: {id: 'sess-2'}},
  ])
  const adapter = adapterFor(scripted)
  await assert.rejects(
    adapter.connect({tools: [], signal: new AbortController().signal}),
    (error: unknown) => error instanceof QwenRealtimeError
      && error.message.includes('session identity changed'),
  )
})

test('connect refuses a second concurrent session', async () => {
  const scripted = scriptedSocket([...handshake])
  const adapter = adapterFor(scripted)
  await adapter.connect({tools: [], signal: new AbortController().signal})
  await assert.rejects(
    adapter.connect({tools: [], signal: new AbortController().signal}),
    /already connected/u,
  )
})

test('audio is appended as base64 and a closed socket is swallowed', async () => {
  const scripted = scriptedSocket([...handshake])
  const adapter = adapterFor(scripted)
  await adapter.connect({tools: [], signal: new AbortController().signal})

  await adapter.sendAudio(new Uint8Array([0, 1, 2, 3]), new AbortController().signal)
  const append = scripted.sent.find(frame => frame.type === 'input_audio_buffer.append')
  assert.ok(append !== undefined)
  assert.equal(append.audio, Buffer.from([0, 1, 2, 3]).toString('base64'))

  await assert.rejects(
    adapter.sendAudio(new Uint8Array([1]), new AbortController().signal),
    /aligned PCM16/u,
  )
})

test('a host fact carries the Python wording and a Guard activation is labelled', async () => {
  for (const asUserActivation of [false, true]) {
    const scripted = scriptedSocket([...handshake])
    const adapter = adapterFor(scripted)
    await adapter.connect({tools: [], signal: new AbortController().signal})

    const injection = adapter.injectHostItem({
      kind: 'progress',
      host_item_id: 'host-1',
      event_id: 'ev-1',
      content: '任务正在处理',
      call_id: null,
    }, {confirmationTimeout: 1, asUserActivation, signal: new AbortController().signal})

    // The adapter allocates the provider item id from the injected factory.
    await Promise.resolve()
    const create = scripted.sent.find(frame => frame.type === 'conversation.item.create')
    assert.ok(create !== undefined, 'the item create frame must be sent')
    const item = create.item as Record<string, unknown>
    assert.equal(item.type, 'message')
    assert.equal(item.role, asUserActivation ? 'user' : 'system')
    const content = item.content as {text: string}[]
    if (asUserActivation) {
      assert.ok(content[0]!.text.startsWith(GUARD_ACTIVATION_PREFIX))
      assert.match(content[0]!.text, /以下内容不是用户说的话/u)
    } else {
      assert.equal(content[0]!.text, 'Nova Audio Agent 任务进度事实：任务正在处理')
    }

    scripted.push({type: 'conversation.item.created', item: {id: item.id}})
    const identity = await injection
    assert.deepEqual(identity, {
      session_epoch: 1,
      host_item_id: 'host-1',
      provider_item_id: item.id,
    })
  }
})

test('a tool output injects a function_call_output item', async () => {
  const scripted = scriptedSocket([...handshake])
  const adapter = adapterFor(scripted)
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const injection = adapter.injectHostItem({
    kind: 'tool_output',
    host_item_id: 'host-2',
    event_id: 'ev-2',
    content: '{"ok":true}',
    call_id: 'call-9',
  }, {confirmationTimeout: 1, asUserActivation: false, signal: new AbortController().signal})

  await Promise.resolve()
  const create = scripted.sent.find(frame => frame.type === 'conversation.item.create')
  const item = create!.item as Record<string, unknown>
  assert.equal(item.type, 'function_call_output')
  assert.equal(item.call_id, 'call-9')
  assert.equal(item.output, '{"ok":true}')

  scripted.push({type: 'conversation.item.created', item: {id: item.id}})
  await injection
})

test('an unconfirmed host item becomes ItemDeliveryUncertainError, not a silent success',
  async () => {
    const scripted = scriptedSocket([...handshake])
    const adapter = adapterFor(scripted)
    await adapter.connect({tools: [], signal: new AbortController().signal})
    await assert.rejects(
      adapter.injectHostItem({
        kind: 'final',
        host_item_id: 'host-3',
        event_id: 'ev-3',
        content: '完成',
        call_id: null,
      }, {
        confirmationTimeout: 0.02,
        asUserActivation: false,
        signal: new AbortController().signal,
      }),
      (error: unknown) => error instanceof ItemDeliveryUncertainError
        && error.host_item_id === 'host-3'
        && error.item_kind === 'final',
    )
  })

test('user activation is refused for a kind Guard cannot activate', async () => {
  const scripted = scriptedSocket([...handshake])
  const adapter = adapterFor(scripted)
  await adapter.connect({tools: [], signal: new AbortController().signal})
  await assert.rejects(adapter.injectHostItem({
    kind: 'recovery',
    host_item_id: 'host-4',
    event_id: 'ev-4',
    content: '摘要',
    call_id: null,
  }, {confirmationTimeout: 1, asUserActivation: true, signal: new AbortController().signal}),
  /Guard progress or final/u)
})

async function collect(
  adapter: QwenAudioRealtimeAdapter,
  signal: AbortSignal,
  count: number,
): Promise<RealtimeProviderEvent[]> {
  const seen: RealtimeProviderEvent[] = []
  for await (const event of adapter.events(signal)) {
    seen.push(event)
    if (seen.length === count) break
  }
  return seen
}

test('provider frames normalize to the neutral event contract', async () => {
  const scripted = scriptedSocket([...handshake])
  const adapter = adapterFor(scripted)
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const stop = new AbortController()

  scripted.push({type: 'input_audio_buffer.speech_started', item_id: 'item-a'})
  scripted.push({type: 'input_audio_buffer.speech_stopped', item_id: 'item-a'})
  scripted.push({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item-a',
    transcript: '你好',
  })
  scripted.push({type: 'response.created', response: {id: 'resp-1'}})
  scripted.push({
    type: 'response.audio.delta',
    response_id: 'resp-1',
    delta: Buffer.from([1, 2, 3, 4]).toString('base64'),
  })
  scripted.push({type: 'response.audio_transcript.delta', response_id: 'resp-1', delta: '嗯'})
  scripted.push({type: 'response.audio_transcript.done', response_id: 'resp-1', transcript: '嗯好'})
  scripted.push({
    type: 'response.function_call_arguments.done',
    call_id: 'call-1',
    item_id: 'item-b',
    name: 'memory__recall',
    arguments: '{"query":"x"}',
    response_id: 'resp-1',
  })
  scripted.push({type: 'response.done', response: {id: 'resp-1', status: 'completed'}})

  const events = await collect(adapter, stop.signal, 9)
  assert.deepEqual(events.map(event => event.kind), [
    'user_speech_started',
    'user_speech_ended',
    'user_transcript_final',
    'response_started',
    'response_audio_delta',
    'response_transcript_delta',
    'response_transcript_final',
    'tool_call_ready',
    'response_terminal',
  ])
  // Speech start and end must share one host-allocated speech id.
  const started = events[0] as Extract<RealtimeProviderEvent, {kind: 'user_speech_started'}>
  const ended = events[1] as Extract<RealtimeProviderEvent, {kind: 'user_speech_ended'}>
  assert.equal(started.speech_id, ended.speech_id)
  const audio = events[4] as Extract<RealtimeProviderEvent, {kind: 'response_audio_delta'}>
  assert.deepEqual([...audio.pcm], [1, 2, 3, 4])
  const call = events[7] as Extract<RealtimeProviderEvent, {kind: 'tool_call_ready'}>
  assert.deepEqual(call.arguments, {query: 'x'})
  assert.equal(call.response_id, 'resp-1')
  stop.abort()
})

test('speech end without a matching start is a protocol error, not a silent drop', async () => {
  const scripted = scriptedSocket([...handshake])
  const adapter = adapterFor(scripted)
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const stop = new AbortController()
  scripted.push({type: 'input_audio_buffer.speech_stopped', item_id: 'orphan'})

  const events = await collect(adapter, stop.signal, 1)
  assert.deepEqual(events, [{
    session_epoch: 1,
    kind: 'provider_error',
    code: 'protocol_error',
    recoverable: false,
  }])
  stop.abort()
})

test('a transport close surfaces a recoverable disconnect', async () => {
  // Python only reaches this branch on EOFError, which its test doubles raise; a
  // real websockets peer close raises ConnectionClosed and is not caught there, so
  // the recovery path the service keys off is unreachable in production. Node maps
  // any transport close onto it.
  const scripted = scriptedSocket([...handshake])
  const adapter = adapterFor(scripted)
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const stop = new AbortController()
  scripted.end()

  const events = await collect(adapter, stop.signal, 1)
  assert.deepEqual(events, [{
    session_epoch: 1,
    kind: 'provider_error',
    code: 'disconnected',
    recoverable: true,
  }])
  stop.abort()
})

test('a cancel with no active response becomes response_cancel_rejected', async () => {
  const scripted = scriptedSocket([...handshake])
  const adapter = adapterFor(scripted)
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const stop = new AbortController()

  await adapter.cancelResponse('resp-7', new AbortController().signal)
  const cancel = scripted.sent.find(frame => frame.type === 'response.cancel')
  assert.ok(cancel !== undefined)
  const cancelRequestId = cancel.event_id as string

  scripted.push({
    type: 'error',
    error: {
      code: 'invalid_value',
      message: '  Conversation has no active response. ',
      event_id: cancelRequestId,
    },
  })
  const events = await collect(adapter, stop.signal, 1)
  assert.deepEqual(events, [{
    session_epoch: 1,
    kind: 'response_cancel_rejected',
    response_id: 'resp-7',
    cancel_request_id: cancelRequestId,
    reason: 'no_active_response',
  }])
  stop.abort()
})

test('a second concurrent cancel in one epoch is refused', async () => {
  const scripted = scriptedSocket([...handshake])
  const adapter = adapterFor(scripted)
  await adapter.connect({tools: [], signal: new AbortController().signal})
  await adapter.cancelResponse('resp-1', new AbortController().signal)
  await assert.rejects(
    adapter.cancelResponse('resp-2', new AbortController().signal),
    /cancel is already pending/u,
  )
})

test('provider error codes are sanitized, bounded, and param-qualified', async () => {
  const cases: {
    readonly error: Record<string, unknown>
    readonly code: string
    readonly recoverable: boolean
  }[] = [
    {error: {code: 'response_idle_timeout'}, code: 'response_idle_timeout', recoverable: true},
    {
      error: {code: 'rate limit/exceeded', param: 'session.update'},
      code: 'rate_limit_exceeded.session.update',
      recoverable: false,
    },
    {
      error: {code: 'bad', param: 'not.in.allowlist'},
      code: 'bad.unknown_param',
      recoverable: false,
    },
    {error: {message: 'no code field'}, code: 'None', recoverable: false},
  ]

  for (const expected of cases) {
    const scripted = scriptedSocket([...handshake])
    const adapter = adapterFor(scripted)
    await adapter.connect({tools: [], signal: new AbortController().signal})
    const stop = new AbortController()
    scripted.push({type: 'error', error: expected.error})
    const events = await collect(adapter, stop.signal, 1)
    assert.deepEqual(events, [{
      session_epoch: 1,
      kind: 'provider_error',
      code: expected.code,
      recoverable: expected.recoverable,
    }], JSON.stringify(expected.error))
    stop.abort()
  }
})

test('a stray no-active-response error without a pending cancel is dropped', async () => {
  const scripted = scriptedSocket([...handshake])
  const adapter = adapterFor(scripted)
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const stop = new AbortController()

  scripted.push({type: 'error', error: {code: 'invalid_value', message: 'no active response found to cancel'}})
  scripted.push({type: 'response.created', response: {id: 'resp-2'}})

  const events = await collect(adapter, stop.signal, 1)
  assert.deepEqual(events.map(event => event.kind), ['response_started'])
  stop.abort()
})

test('a non-canonical base64 audio delta is refused', async () => {
  const scripted = scriptedSocket([...handshake])
  const adapter = adapterFor(scripted)
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const stop = new AbortController()
  scripted.push({type: 'response.audio.delta', response_id: 'resp-1', delta: 'not!base64'})

  const events = await collect(adapter, stop.signal, 1)
  assert.equal(events[0]?.kind, 'provider_error')
  stop.abort()
})

test('malformed json and non-object events are bounded protocol failures', async () => {
  const scripted = scriptedSocket([...handshake])
  const adapter = adapterFor(scripted)
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const stop = new AbortController()
  // A frame whose `type` is absent is malformed for this protocol.
  scripted.push({session: {id: 'sess-1'}})

  const events = await collect(adapter, stop.signal, 1)
  assert.deepEqual(events, [{
    session_epoch: 1,
    kind: 'provider_error',
    code: 'protocol_error',
    recoverable: false,
  }])
  stop.abort()
})

test('close is idempotent and releases pending confirmations', async () => {
  const scripted = scriptedSocket([...handshake])
  const adapter = adapterFor(scripted)
  await adapter.connect({tools: [], signal: new AbortController().signal})
  const pending = adapter.injectHostItem({
    kind: 'progress',
    host_item_id: 'host-9',
    event_id: 'ev-9',
    content: '进行中',
    call_id: null,
  }, {confirmationTimeout: 5, asUserActivation: false, signal: new AbortController().signal})

  await Promise.resolve()
  await adapter.close()
  await adapter.close()
  await assert.rejects(pending)
})

/** Await with a deadline, so a regression fails fast instead of hanging the suite. */
async function within<T>(work: Promise<T>, milliseconds: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), milliseconds)
  })
  try {
    return await Promise.race([work, expiry])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Spin the macrotask queue until a condition holds, or fail rather than hang. */
async function until(condition: () => boolean, turns = 200): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (condition()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error('condition never became true')
}

/** A socket whose sends can be held open, to order writes against a reconnect. */
function blockableSocket(initial: Record<string, unknown>[] = []) {
  const inbound: (Record<string, unknown> | null)[] = [...initial]
  const sent: Record<string, unknown>[] = []
  const gates: (() => void)[] = []
  let wake: (() => void) | undefined
  let blocking = false
  let received = 0
  return {
    sent,
    get received() { return received },
    get parked() { return gates.length },
    releaseAll() { for (const gate of gates.splice(0)) gate() },
    block() { blocking = true },
    unblock() { blocking = false },
    push(frame: Record<string, unknown>) { inbound.push(frame); wake?.(); wake = undefined },
    socket: {
      send(payload: string) {
        const record = (): void => { sent.push(JSON.parse(payload) as Record<string, unknown>) }
        if (!blocking) {
          record()
          return Promise.resolve()
        }
        return new Promise<void>(resolve => gates.push(() => { record(); resolve() }))
      },
      async receive() {
        while (inbound.length === 0) {
          await new Promise<void>(resolve => { wake = resolve })
        }
        const next = inbound.shift()
        received += 1
        if (next === null || next === undefined) throw new QwenSocketClosedError()
        return JSON.stringify(next)
      },
      close: () => Promise.resolve(),
    } satisfies QwenSocket,
  }
}

test('a write queued on a closed session never lands on its replacement', async () => {
  // The write chain outlives a connection. A frame queued behind a slow send must
  // not be delivered to the next session, ahead of that session's own
  // session.update, which would inject stale host context into it.
  const first = blockableSocket([...handshake])
  const second = blockableSocket([...handshake])
  let dial = 0
  const adapter = new QwenAudioRealtimeAdapter({
    url: 'wss://example.invalid/realtime',
    apiKey: 'k',
    model: 'm',
    voice: 'v',
    idFactory: ids(),
    connector: () => {
      dial += 1
      return Promise.resolve(dial === 1 ? first.socket : second.socket)
    },
  })
  const signal = new AbortController().signal
  await adapter.connect({tools: [], signal})

  first.block()
  // Block on createResponse rather than sendAudio: sendAudio checks ownership and
  // returns early once the socket is detached, so it never parks and the race
  // cannot be staged through it.
  const blocked = adapter.createResponse({
    kind: 'host_fact',
    item: {
      kind: 'final',
      host_item_id: 'live-item',
      event_id: 'ev-live',
      content: '当前会话',
      call_id: null,
    },
    task_summary: null,
    origin_spoken: false,
  }, signal)
  // The write must actually be parked on the gate before anything else happens,
  // otherwise it runs after close() and the ordering under test never occurs.
  await until(() => first.parked === 1)

  const injection = adapter.injectHostItem({
    kind: 'progress',
    host_item_id: 'stale-host-item',
    event_id: 'ev-stale',
    content: '旧会话进度',
    call_id: null,
  }, {confirmationTimeout: 0.05, asUserActivation: false, signal})
  const settled = Promise.allSettled([blocked, injection])

  await adapter.close()
  // Start the replacement handshake but do not await it yet: its session.update is
  // queued behind the still-blocked writes. Releasing the old send now runs the
  // stale injection while this.#socket already points at the replacement, which is
  // exactly the ordering that delivered one session's host item into another.
  const reconnected = adapter.connect({tools: [], signal})
  // Release only once the replacement socket is actually installed. Releasing
  // earlier makes the stale write fail with "not connected" and the race is missed,
  // which is what made an earlier version of this test vacuous.
  await until(() => second.received >= 1)
  first.unblock()
  first.releaseAll()
  await within(reconnected, 5_000, 'the replacement handshake')
  await within(settled, 5_000, 'the old session writes to settle')

  const kinds = second.sent.map(frame => frame.type)
  assert.deepEqual(kinds, ['session.update'],
    'the replacement session must see only its own handshake')
  assert.doesNotMatch(JSON.stringify(second.sent), /stale-host-item/u)
})

test('a reconnected session exposes its own events, not the previous sentinel', async () => {
  // close() enqueues a terminal null to release any consumer. If connect() did not
  // discard it, the reconnected stream would report done on its first iteration and
  // the session would look permanently silent.
  const first = scriptedSocket([...handshake])
  const second = scriptedSocket([...handshake])
  let dial = 0
  const adapter = new QwenAudioRealtimeAdapter({
    url: 'wss://example.invalid/realtime',
    apiKey: 'k',
    model: 'm',
    voice: 'v',
    idFactory: ids(),
    connector: () => {
      dial += 1
      return Promise.resolve(dial === 1 ? first.socket : second.socket)
    },
  })
  const signal = new AbortController().signal

  // Connect and close without ever consuming events, leaving the sentinel queued.
  await adapter.connect({tools: [], signal})
  await adapter.close()

  const identity = await adapter.connect({tools: [], signal})
  assert.equal(identity.epoch, 2)
  const stop = new AbortController()
  second.push({type: 'response.created', response: {id: 'resp-after-reconnect'}})

  const events = await collect(adapter, stop.signal, 1)
  assert.deepEqual(events, [{
    session_epoch: 2,
    kind: 'response_started',
    response_id: 'resp-after-reconnect',
  }])
  stop.abort()
})
