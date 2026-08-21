import assert from 'node:assert/strict'
import { gzipSync, gunzipSync } from 'node:zlib'
import { test } from 'node:test'
import {
  DoubaoAsrClient,
  DoubaoAsrFailure,
} from '../src/realtime/volcengine/asr.js'
import {
  VolcSocketFailure,
  type VolcBinaryConnector,
  type VolcBinaryConnectorOptions,
  type VolcBinarySocket,
} from '../src/realtime/volcengine/websocket.js'

const acknowledgement = new Uint8Array([0x11, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])

class ScriptedSocket implements VolcBinarySocket {
  readonly sent: Uint8Array[] = []
  readonly receiveSignals: (AbortSignal | undefined)[] = []
  readonly incoming: (Uint8Array | Error | 'hang')[]
  closeCalls = 0
  activeSends = 0
  maxActiveSends = 0
  sendFailure: Error | undefined
  #sendGate: Promise<void> | undefined

  constructor(incoming: (Uint8Array | Error | 'hang')[] = [acknowledgement]) {
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
      if (this.sendFailure !== undefined) throw this.sendFailure
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

function serverTranscript(sequence: number, text: string, final = false): Uint8Array {
  const payload = gzipSync(new TextEncoder().encode(JSON.stringify({result: {text}})))
  const frame = new Uint8Array(12 + payload.byteLength)
  frame.set([0x11, final ? 0x93 : 0x91, 0x11, 0])
  const view = new DataView(frame.buffer)
  view.setInt32(4, sequence)
  view.setUint32(8, payload.byteLength)
  frame.set(payload, 12)
  return frame
}

function audioPacket(frame: Uint8Array): {readonly sequence: number; readonly pcm: Uint8Array} {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  const size = view.getUint32(8)
  return {sequence: view.getInt32(4), pcm: gunzipSync(frame.subarray(12, 12 + size))}
}

function client(socket: ScriptedSocket, options: {
  readonly chunkMs?: number
  readonly receiveTimeoutMs?: number
  readonly idFactory?: () => string
} = {}): {readonly value: DoubaoAsrClient; readonly connector: CapturingConnector} {
  const connector = new CapturingConnector(socket)
  return {
    value: new DoubaoAsrClient({
      endpoint: 'wss://speech.example/asr?secret=endpoint-nonce',
      apiKey: 'asr-api-secret',
      resourceId: 'asr-resource-secret',
      chunkMs: options.chunkMs ?? 1,
      receiveTimeoutMs: options.receiveTimeoutMs ?? 100,
      connector: connector.connect,
      idFactory: options.idFactory ?? ids('connect-id', 'user-id'),
    }),
    connector,
  }
}

test('ASR open sends exact copied auth and starts audio at sequence two', async () => {
  const socket = new ScriptedSocket()
  const created = client(socket)
  const session = await created.value.open()

  assert.equal(created.connector.calls.length, 1)
  const call = created.connector.calls[0]!
  assert.deepEqual(call.headers, {
    'X-Api-Key': 'asr-api-secret',
    'X-Api-Resource-Id': 'asr-resource-secret',
    'X-Api-Connect-Id': 'connect-id',
  })
  assert.equal(call.openTimeoutMs, 20_000)
  assert.equal(call.closeTimeoutMs, 1_000)
  assert.equal(call.maxFrameBytes, 10 * 1_024 * 1_024)
  assert.equal(new DataView(socket.sent[0]!.buffer).getInt32(4), 1)

  await session.append(new Uint8Array(34))
  await session.finish()
  assert.deepEqual(socket.sent.slice(1).map(frame => audioPacket(frame).sequence), [2, -3])
  await session.close()
})

test('ASR holds an exactly full chunk and finish sends the remainder once', async () => {
  const socket = new ScriptedSocket()
  const {value} = client(socket)
  const session = await value.open()
  await session.append(new Uint8Array(32))
  assert.equal(socket.sent.length, 1)
  await session.append(new Uint8Array([1, 2]))
  assert.deepEqual([...audioPacket(socket.sent[1]!).pcm], [...new Uint8Array(32)])
  await session.finish()
  assert.deepEqual([...audioPacket(socket.sent[2]!).pcm], [1, 2])
  assert.equal(audioPacket(socket.sent[2]!).sequence, -3)
  await session.finish()
  assert.equal(socket.sent.length, 3)
  await assert.rejects(session.append(new Uint8Array([3, 4])),
    (error: unknown) => error instanceof DoubaoAsrFailure && error.code === 'session')
})

test('empty finish is retryable and ASR serializes concurrent append and finish', async () => {
  const socket = new ScriptedSocket()
  const {value} = client(socket)
  const session = await value.open()
  await assert.rejects(session.finish(),
    (error: unknown) => error instanceof DoubaoAsrFailure && error.code === 'session')

  let release: (() => void) | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  socket.blockSends(gate)
  const append = session.append(new Uint8Array(34))
  const finish = session.finish()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(socket.maxActiveSends, 1)
  release?.()
  await Promise.all([append, finish])
  assert.deepEqual(socket.sent.slice(1).map(frame => audioPacket(frame).sequence), [2, -3])
})

test('ASR yields provider order, ignores null frames, and permits only one iterator', async () => {
  const socket = new ScriptedSocket([
    acknowledgement,
    acknowledgement,
    serverTranscript(1, 'partial'),
    serverTranscript(-2, 'final', true),
  ])
  const {value} = client(socket)
  const session = await value.open()
  const first = session.events()[Symbol.asyncIterator]()
  assert.deepEqual(await first.next(), {done: false, value: {text: 'partial', final: false}})
  const second = session.events()[Symbol.asyncIterator]()
  await assert.rejects(second.next(),
    (error: unknown) => error instanceof DoubaoAsrFailure && error.code === 'session')
  assert.deepEqual(await first.next(), {done: false, value: {text: 'final', final: true}})
  assert.deepEqual(await first.next(), {done: true, value: undefined})
  assert.notEqual(socket.receiveSignals[1], socket.receiveSignals[2])
})

test('ASR receive timeout and malformed frames are stable and content-free', async () => {
  const timeoutSocket = new ScriptedSocket([acknowledgement, 'hang'])
  const timeoutClient = client(timeoutSocket, {receiveTimeoutMs: 5}).value
  const timeoutSession = await timeoutClient.open()
  await assert.rejects(settleWithin(
    'ASR receive timeout', timeoutSession.events()[Symbol.asyncIterator]().next(),
  ),
    (error: unknown) => error instanceof DoubaoAsrFailure && error.code === 'receive')

  const malformedSocket = new ScriptedSocket([acknowledgement, new Uint8Array([1, 2, 3])])
  const malformedSession = await client(malformedSocket).value.open()
  let failure: unknown
  try {
    await malformedSession.events()[Symbol.asyncIterator]().next()
  } catch (error) {
    failure = error
  }
  assert.ok(failure instanceof DoubaoAsrFailure && failure.code === 'receive')
  assert.doesNotMatch(JSON.stringify(failure), /asr-api-secret|asr-resource-secret|endpoint-nonce/u)
})

test('ASR handshake timeout closes the allocated socket and chunk cap rejects before dial', async () => {
  const socket = new ScriptedSocket(['hang'])
  const created = client(socket, {receiveTimeoutMs: 5})
  await assert.rejects(settleWithin('ASR handshake timeout', created.value.open()),
    (error: unknown) => error instanceof DoubaoAsrFailure && error.code === 'handshake')
  assert.equal(socket.closeCalls, 1)

  let dialed = false
  assert.throws(() => new DoubaoAsrClient({
    endpoint: 'wss://speech.example/asr',
    apiKey: 'secret',
    resourceId: 'resource',
    chunkMs: 2_049,
    connector: options => {
      void options
      dialed = true
      return Promise.resolve(new ScriptedSocket())
    },
  }), (error: unknown) => error instanceof DoubaoAsrFailure && error.code === 'configuration')
  assert.equal(dialed, false)
})
