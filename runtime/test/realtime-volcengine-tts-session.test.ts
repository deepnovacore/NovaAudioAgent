import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DoubaoTtsClient,
  DoubaoTtsFailure,
  DoubaoTtsSession,
} from '../src/realtime/volcengine/tts.js'
import { EventType, MessageType, VolcMessage } from '../src/realtime/volcengine/protocol.js'
import {
  VolcSocketFailure,
  type VolcBinaryConnector,
  type VolcBinaryConnectorOptions,
  type VolcBinarySocket,
} from '../src/realtime/volcengine/websocket.js'

class ScriptedSocket implements VolcBinarySocket {
  readonly sent: Uint8Array[] = []
  readonly incoming: (Uint8Array | Error | 'hang')[]
  readonly receiveSignals: (AbortSignal | undefined)[] = []
  closeCalls = 0
  activeSends = 0
  maxActiveSends = 0
  failEvent: EventType | undefined
  #sendGate: Promise<void> | undefined

  constructor(incoming: (Uint8Array | Error | 'hang')[]) {
    this.incoming = [...incoming]
  }

  blockSends(gate: Promise<void>): void {
    this.#sendGate = gate
  }

  async send(frame: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) throw new VolcSocketFailure('aborted')
    this.activeSends += 1
    this.maxActiveSends = Math.max(this.maxActiveSends, this.activeSends)
    this.sent.push(new Uint8Array(frame))
    try {
      if (VolcMessage.unmarshal(frame).event === this.failEvent) {
        throw new Error('provider-send-secret')
      }
      await this.#sendGate
    } finally {
      this.activeSends -= 1
    }
  }

  receive(signal?: AbortSignal): Promise<Uint8Array> {
    this.receiveSignals.push(signal)
    const next = this.incoming.shift() ?? 'hang'
    if (next instanceof Uint8Array) return Promise.resolve(new Uint8Array(next))
    if (next instanceof Error) return Promise.reject(next)
    return new Promise((_resolve, reject) => {
      const fail = (): void => reject(new VolcSocketFailure('aborted'))
      signal?.addEventListener('abort', fail, {once: true})
      if (signal?.aborted === true) fail()
    })
  }

  close(): Promise<void> {
    this.closeCalls += 1
    return Promise.resolve()
  }
}

class CapturingConnector {
  readonly socket: ScriptedSocket
  readonly calls: VolcBinaryConnectorOptions[] = []

  constructor(socket: ScriptedSocket) {
    this.socket = socket
  }

  readonly connect: VolcBinaryConnector = options => {
    this.calls.push({...options, headers: {...options.headers}})
    return Promise.resolve(this.socket)
  }
}

function ids(...values: string[]): () => string {
  const pending = [...values]
  return () => pending.shift() ?? 'unexpected-extra-id'
}

function serverMessage(
  event: EventType,
  options: {
    readonly sessionId?: string
    readonly payload?: Uint8Array
    readonly messageType?: MessageType
  } = {},
): Uint8Array {
  return new VolcMessage({
    messageType: options.messageType ?? MessageType.FULL_SERVER_RESPONSE,
    event,
    ...(options.sessionId === undefined ? {} : {sessionId: options.sessionId}),
    ...(options.payload === undefined ? {} : {payload: options.payload}),
  }).marshal()
}

function normalHandshake(sessionId = 'tts-session'): Uint8Array[] {
  return [
    serverMessage(EventType.CONNECTION_STARTED),
    serverMessage(EventType.SESSION_STARTED, {sessionId}),
  ]
}

function makeClient(socket: ScriptedSocket, options: {
  readonly receiveTimeoutMs?: number
  readonly idFactory?: () => string
} = {}): {readonly value: DoubaoTtsClient; readonly connector: CapturingConnector} {
  const connector = new CapturingConnector(socket)
  return {
    value: new DoubaoTtsClient({
      endpoint: 'wss://speech.example/tts?secret=endpoint-nonce',
      apiKey: 'tts-api-secret',
      resourceId: 'tts-resource-secret',
      voice: 'fixture-voice',
      receiveTimeoutMs: options.receiveTimeoutMs ?? 100,
      connector: connector.connect,
      idFactory: options.idFactory ?? ids(
        'connect-id', 'tts-session', 'start-user-id', 'task-user-id',
      ),
    }),
    connector,
  }
}

async function settleWithin<T>(label: string, promise: Promise<T>, milliseconds = 250): Promise<T> {
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

test('TTS performs the exact two-stage handshake with copied credentials and payload', async () => {
  const socket = new ScriptedSocket(normalHandshake())
  const created = makeClient(socket)
  await created.value.open()

  assert.deepEqual(created.connector.calls[0]!.headers, {
    'X-Api-Key': 'tts-api-secret',
    'X-Api-Resource-Id': 'tts-resource-secret',
    'X-Api-Connect-Id': 'connect-id',
  })
  assert.equal(created.connector.calls[0]!.openTimeoutMs, 20_000)
  assert.equal(created.connector.calls[0]!.closeTimeoutMs, 1_000)
  const startConnection = VolcMessage.unmarshal(socket.sent[0]!)
  const startSession = VolcMessage.unmarshal(socket.sent[1]!)
  assert.equal(startConnection.event, EventType.START_CONNECTION)
  assert.deepEqual(JSON.parse(new TextDecoder().decode(startConnection.payload)), {})
  assert.equal(startSession.event, EventType.START_SESSION)
  assert.equal(startSession.sessionId, 'tts-session')
  assert.deepEqual(JSON.parse(new TextDecoder().decode(startSession.payload)), {
    event: EventType.START_SESSION,
    user: {uid: 'start-user-id'},
    namespace: 'BidirectionalTTS',
    req_params: {
      speaker: 'fixture-voice',
      audio_params: {format: 'pcm', sample_rate: 24_000, enable_timestamp: false},
      additions: '{"disable_markdown_filter":false}',
    },
  })
})

test('TTS rejects a wrong connection event or foreign started session and closes partial opens', async () => {
  for (const incoming of [
    [serverMessage(EventType.CONNECTION_FAILED)],
    [serverMessage(EventType.CONNECTION_STARTED),
      serverMessage(EventType.SESSION_STARTED, {sessionId: 'foreign-session'})],
  ]) {
    const socket = new ScriptedSocket(incoming)
    await assert.rejects(settleWithin('TTS rejected handshake', makeClient(socket).value.open()),
      (error: unknown) => error instanceof DoubaoTtsFailure && error.code === 'handshake')
    assert.equal(socket.closeCalls, 1)
  }
})

test('TTS task text uses Python strip, code-point bounds, and the pinned payload', async () => {
  const socket = new ScriptedSocket(normalHandshake())
  const session = await makeClient(socket).value.open()
  await assert.rejects(session.sendText('\u001c\u0085'),
    (error: unknown) => error instanceof DoubaoTtsFailure && error.code === 'session')
  await session.sendText('🙂'.repeat(4_000))
  await assert.rejects(session.sendText('🙂'.repeat(4_001)),
    (error: unknown) => error instanceof DoubaoTtsFailure && error.code === 'session')
  const task = VolcMessage.unmarshal(socket.sent[2]!)
  const payload = JSON.parse(new TextDecoder().decode(task.payload)) as Record<string, unknown>
  assert.equal(task.event, EventType.TASK_REQUEST)
  assert.equal(task.sessionId, 'tts-session')
  assert.equal((payload.req_params as Record<string, unknown>).text, '🙂'.repeat(4_000))
  assert.equal((payload.user as Record<string, unknown>).uid, 'task-user-id')
})

test('TTS serializes writes and only the first finish or cancel terminal action wins', async () => {
  const finishSocket = new ScriptedSocket(normalHandshake())
  const finishSession = await makeClient(finishSocket).value.open()
  let release: (() => void) | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  finishSocket.blockSends(gate)
  const text = finishSession.sendText('hello')
  const finish = finishSession.finish()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(finishSocket.maxActiveSends, 1)
  release?.()
  await Promise.all([text, finish, finishSession.finish(), finishSession.cancel()])
  assert.deepEqual(finishSocket.sent.slice(2).map(frame => VolcMessage.unmarshal(frame).event), [
    EventType.TASK_REQUEST, EventType.FINISH_SESSION,
  ])
  await assert.rejects(finishSession.sendText('late'),
    (error: unknown) => error instanceof DoubaoTtsFailure && error.code === 'session')

  const cancelSocket = new ScriptedSocket(normalHandshake('cancel-session'))
  const cancelSession = await makeClient(cancelSocket, {
    idFactory: ids('connect-2', 'cancel-session', 'start-user-2'),
  }).value.open()
  await Promise.all([cancelSession.cancel(), cancelSession.cancel(), cancelSession.finish()])
  assert.deepEqual(cancelSocket.sent.slice(2).map(frame => VolcMessage.unmarshal(frame).event), [
    EventType.CANCEL_SESSION,
  ])
})

test('TTS ignores foreign and empty audio, copies aligned PCM, and has one event consumer', async () => {
  const ownedPayload = new Uint8Array([1, 2, 3, 4])
  const socket = new ScriptedSocket([
    ...normalHandshake(),
    serverMessage(EventType.TTS_RESPONSE, {
      sessionId: 'foreign-session', payload: new Uint8Array([7, 8]),
      messageType: MessageType.AUDIO_ONLY_SERVER,
    }),
    serverMessage(EventType.TTS_RESPONSE, {
      sessionId: 'tts-session', payload: new Uint8Array(),
      messageType: MessageType.AUDIO_ONLY_SERVER,
    }),
    serverMessage(EventType.TTS_RESPONSE, {
      sessionId: 'tts-session', payload: ownedPayload,
      messageType: MessageType.AUDIO_ONLY_SERVER,
    }),
    serverMessage(EventType.SESSION_FINISHED, {sessionId: 'tts-session'}),
  ])
  const session = await makeClient(socket).value.open()
  const first = session.events()[Symbol.asyncIterator]()
  assert.deepEqual(await first.next(), {done: false, value: {pcm: new Uint8Array([1, 2, 3, 4])}})
  const second = session.events()[Symbol.asyncIterator]()
  await assert.rejects(second.next(),
    (error: unknown) => error instanceof DoubaoTtsFailure && error.code === 'session')
  assert.deepEqual(await first.next(), {done: true, value: undefined})
  ownedPayload.fill(99)
  assert.notEqual(socket.receiveSignals[2], socket.receiveSignals[3])
})

test('TTS rejects misaligned audio and provider failure with stable content-free errors', async () => {
  const malformedSocket = new ScriptedSocket([
    ...normalHandshake(),
    serverMessage(EventType.TTS_RESPONSE, {
      sessionId: 'tts-session', payload: new Uint8Array([1]),
      messageType: MessageType.AUDIO_ONLY_SERVER,
    }),
  ])
  const malformed = await makeClient(malformedSocket).value.open()
  await assert.rejects(malformed.events()[Symbol.asyncIterator]().next(),
    (error: unknown) => error instanceof DoubaoTtsFailure && error.code === 'receive')

  const failedSocket = new ScriptedSocket([
    ...normalHandshake(),
    serverMessage(EventType.SESSION_FAILED, {
      sessionId: 'tts-session', payload: new TextEncoder().encode('provider-body-secret'),
    }),
  ])
  const failed = await makeClient(failedSocket).value.open()
  let failure: unknown
  try {
    await failed.events()[Symbol.asyncIterator]().next()
  } catch (error) {
    failure = error
  }
  assert.ok(failure instanceof DoubaoTtsFailure && failure.code === 'receive')
  assert.doesNotMatch(JSON.stringify(failure),
    /provider-body-secret|tts-api-secret|tts-resource-secret|endpoint-nonce/u)
})

test('TTS applies a fresh receive timeout and cancellation closes the partial socket', async () => {
  const timeoutSocket = new ScriptedSocket([...normalHandshake(), 'hang'])
  const timeoutSession = await makeClient(timeoutSocket, {receiveTimeoutMs: 5}).value.open()
  await assert.rejects(settleWithin(
    'TTS receive timeout', timeoutSession.events()[Symbol.asyncIterator]().next(),
  ), (error: unknown) => error instanceof DoubaoTtsFailure && error.code === 'receive')

  const cancelSocket = new ScriptedSocket(['hang'])
  const controller = new AbortController()
  const opening = makeClient(cancelSocket).value.open(controller.signal)
  await new Promise<void>(resolve => setImmediate(resolve))
  controller.abort()
  await assert.rejects(settleWithin('TTS open abort', opening), {name: 'AbortError'})
  assert.equal(cancelSocket.closeCalls, 1)
})

test('TTS close always attempts finish-connection, closes in finally, and shares one result', async () => {
  const socket = new ScriptedSocket(normalHandshake())
  const session = await makeClient(socket).value.open()
  await session.finish()
  socket.failEvent = EventType.FINISH_CONNECTION
  const first = session.close()
  const second = session.close()
  assert.equal(first, second)
  await assert.rejects(first,
    (error: unknown) => error instanceof DoubaoTtsFailure && error.code === 'close')
  assert.equal(socket.closeCalls, 1)
  assert.equal(VolcMessage.unmarshal(socket.sent.at(-1)!).event, EventType.FINISH_CONNECTION)
})

test('TTS close reaches the socket within its bound when an earlier write never settles',
  async () => {
    const socket = new ScriptedSocket([])
    let release: (() => void) | undefined
    socket.blockSends(new Promise<void>(resolve => { release = resolve }))
    const session = new DoubaoTtsSession({
      socket, sessionId: 'blocked-session', voice: 'fixture-voice', sampleRate: 24_000,
      receiveTimeoutMs: 100, idFactory: ids('blocked-task'),
    })
    const blocked = session.sendText('阻塞。')
    void blocked.catch(() => undefined)
    await new Promise<void>(resolve => setImmediate(resolve))

    try {
      await assert.rejects(settleWithin('bounded blocked-write close', session.close(), 1_300),
        (error: unknown) => error instanceof DoubaoTtsFailure && error.code === 'close')
      assert.equal(socket.closeCalls, 1)
    } finally {
      release?.()
      await settleWithin('blocked write release', blocked.catch(() => undefined))
    }
  })
