import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import {
  MAX_VOLC_SOCKET_BACKLOG_BYTES,
  MAX_VOLC_SOCKET_BACKLOG_FRAMES,
  VolcSocketFailure,
  webSocketVolcBinaryConnector,
  type VolcBinarySocket,
} from '../src/realtime/volcengine/websocket.js'

interface SocketHarness {
  readonly endpoint: string
  readonly headers: Promise<Record<string, string | string[] | undefined>>
  readonly peer: Promise<WebSocket>
  readonly connections: () => number
  close(): Promise<void>
}

async function socketHarness(): Promise<SocketHarness> {
  const server = new WebSocketServer({host: '127.0.0.1', port: 0, perMessageDeflate: false})
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  let connectionCount = 0
  let resolveHeaders: ((value: Record<string, string | string[] | undefined>) => void) | undefined
  let resolvePeer: ((value: WebSocket) => void) | undefined
  const headers = new Promise<Record<string, string | string[] | undefined>>(resolve => {
    resolveHeaders = resolve
  })
  const peer = new Promise<WebSocket>(resolve => { resolvePeer = resolve })
  server.on('connection', (socket, request) => {
    connectionCount += 1
    resolveHeaders?.(request.headers)
    resolvePeer?.(socket)
  })
  return {
    endpoint: `ws://127.0.0.1:${address.port}/provider-path?secret=endpoint-nonce`,
    headers,
    peer,
    connections: () => connectionCount,
    close: () => new Promise<void>((resolve, reject) => {
      for (const client of server.clients) client.terminate()
      server.close(error => error === undefined ? resolve() : reject(error))
    }),
  }
}

async function settleWithin<T>(label: string, promise: Promise<T>, milliseconds = 1_000): Promise<T> {
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

async function eventLoopTurns(count = 4): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

function hasCode(code: VolcSocketFailure['code']): (error: unknown) => boolean {
  return error => error instanceof VolcSocketFailure && error.code === code
}

function connect(
  endpoint: string,
  signal: AbortSignal,
  options: {readonly closeTimeoutMs?: number; readonly maxFrameBytes?: number} = {},
): Promise<VolcBinarySocket> {
  return webSocketVolcBinaryConnector({
    endpoint,
    headers: {
      'X-Api-Key': 'websocket-api-secret',
      'X-Api-Resource-Id': 'websocket-resource-secret',
    },
    openTimeoutMs: 1_000,
    closeTimeoutMs: options.closeTimeoutMs ?? 50,
    maxFrameBytes: options.maxFrameBytes ?? 10 * 1_024 * 1_024,
    signal,
  })
}

function binary(data: RawData): Uint8Array {
  return Buffer.isBuffer(data)
    ? new Uint8Array(data)
    : new Uint8Array(Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]))
}

test('binary transport forwards copied headers and round-trips owned bytes', async () => {
  const harness = await socketHarness()
  const controller = new AbortController()
  try {
    const socket = await connect(harness.endpoint, controller.signal)
    assert.equal((await harness.headers)['x-api-key'], 'websocket-api-secret')
    const peer = await harness.peer
    peer.send(Buffer.from([1, 2, 3]))
    const inbound = await settleWithin('binary receive', socket.receive())
    assert.deepEqual([...inbound], [1, 2, 3])

    const received = new Promise<Uint8Array>(resolve => {
      peer.once('message', data => resolve(binary(data)))
    })
    const outbound = new Uint8Array([4, 5, 6])
    const sending = socket.send(outbound)
    outbound.fill(99)
    await sending
    assert.deepEqual([...(await settleWithin('binary send', received))], [4, 5, 6])
    await socket.close()
  } finally {
    await harness.close()
  }
})

test('a text frame terminally fails the binary socket without exposing content', async () => {
  const harness = await socketHarness()
  const controller = new AbortController()
  try {
    const socket = await connect(harness.endpoint, controller.signal)
    const peer = await harness.peer
    peer.send('provider-text-secret')
    await assert.rejects(settleWithin('text rejection', socket.receive()), hasCode('protocol'))
    await assert.rejects(socket.receive(), hasCode('protocol'))
    await assert.rejects(socket.send(new Uint8Array([1, 2])), hasCode('protocol'))
  } finally {
    await harness.close()
  }
})

test('pre-aborted and mid-open signals reject without leaving a connection', async () => {
  const preHarness = await socketHarness()
  const pre = new AbortController()
  pre.abort()
  try {
    await assert.rejects(connect(preHarness.endpoint, pre.signal), hasCode('aborted'))
    await eventLoopTurns()
    assert.equal(preHarness.connections(), 0)
  } finally {
    await preHarness.close()
  }

  const openingHarness = await socketHarness()
  const opening = new AbortController()
  try {
    const pending = connect(openingHarness.endpoint, opening.signal)
    opening.abort()
    await assert.rejects(settleWithin('mid-open abort', pending), hasCode('aborted'))
  } finally {
    await openingHarness.close()
  }
})

test('only one receive may wait and aborting it leaves the socket usable', async () => {
  const harness = await socketHarness()
  const controller = new AbortController()
  try {
    const socket = await connect(harness.endpoint, controller.signal)
    const waiting = new AbortController()
    const first = socket.receive(waiting.signal)
    await assert.rejects(settleWithin('concurrent receive', socket.receive()),
      hasCode('concurrent_receive'))
    waiting.abort()
    await assert.rejects(settleWithin('receive abort', first), hasCode('aborted'))
    ;(await harness.peer).send(Buffer.from([7, 8]))
    assert.deepEqual([...(await settleWithin('receive after abort', socket.receive()))], [7, 8])
    await socket.close()
  } finally {
    await harness.close()
  }
})

test('pre-aborted sends write nothing and queued sends preserve copied call order', async () => {
  const harness = await socketHarness()
  const controller = new AbortController()
  try {
    const socket = await connect(harness.endpoint, controller.signal)
    const peer = await harness.peer
    const received: number[][] = []
    peer.on('message', data => { received.push([...binary(data)]) })
    const stopped = new AbortController()
    stopped.abort()
    await assert.rejects(socket.send(new Uint8Array([0]), stopped.signal), hasCode('aborted'))
    const one = new Uint8Array([1])
    const two = new Uint8Array([2])
    const sends = [socket.send(one), socket.send(two), socket.send(new Uint8Array([3]))]
    one[0] = 91
    two[0] = 92
    await Promise.all(sends)
    for (let turn = 0; received.length < 3 && turn < 20; turn += 1) await eventLoopTurns(1)
    assert.deepEqual(received, [[1], [2], [3]])
    await socket.close()
  } finally {
    await harness.close()
  }
})

test('frame-count overflow is terminal and clears the queued backlog', async () => {
  const harness = await socketHarness()
  const controller = new AbortController()
  try {
    const socket = await connect(harness.endpoint, controller.signal, {maxFrameBytes: 1})
    const peer = await harness.peer
    for (let index = 0; index <= MAX_VOLC_SOCKET_BACKLOG_FRAMES; index += 1) {
      peer.send(Buffer.from([index & 0xff]))
    }
    await eventLoopTurns(8)
    await assert.rejects(settleWithin('count overflow', socket.receive()), hasCode('overflow'))
    await assert.rejects(socket.receive(), hasCode('overflow'))
  } finally {
    await harness.close()
  }
})

test('aggregate-byte and single-frame bounds fail before queue admission', async () => {
  const aggregateHarness = await socketHarness()
  const aggregateController = new AbortController()
  try {
    const socket = await connect(aggregateHarness.endpoint, aggregateController.signal)
    const peer = await aggregateHarness.peer
    const peerClosed = new Promise<void>(resolve => peer.once('close', () => resolve()))
    const block = Buffer.alloc(1_024 * 1_024)
    for (let size = 0; size <= MAX_VOLC_SOCKET_BACKLOG_BYTES; size += block.byteLength) {
      peer.send(block)
    }
    await settleWithin('aggregate overflow close', peerClosed)
    await assert.rejects(settleWithin('byte overflow', socket.receive()), hasCode('overflow'))
  } finally {
    await aggregateHarness.close()
  }

  const frameHarness = await socketHarness()
  const frameController = new AbortController()
  try {
    const socket = await connect(frameHarness.endpoint, frameController.signal, {maxFrameBytes: 2})
    ;(await frameHarness.peer).send(Buffer.from([1, 2, 3]))
    await assert.rejects(settleWithin('frame overflow', socket.receive()), hasCode('overflow'))
    await assert.rejects(socket.send(new Uint8Array([1, 2, 3])), hasCode('overflow'))
  } finally {
    await frameHarness.close()
  }
})

test('peer close settles a waiter once and redacts the close reason', async () => {
  const harness = await socketHarness()
  const controller = new AbortController()
  try {
    const socket = await connect(harness.endpoint, controller.signal)
    const waiting = socket.receive()
    ;(await harness.peer).close(4000, 'provider-close-secret')
    let captured: unknown
    try {
      await settleWithin('peer close', waiting)
    } catch (error) {
      captured = error
    }
    assert.ok(hasCode('closed')(captured))
    assert.doesNotMatch(JSON.stringify(captured), /provider-close-secret|endpoint-nonce/u)
  } finally {
    await harness.close()
  }
})

test('close is one shared bounded cleanup and settles pending operations', async () => {
  const harness = await socketHarness()
  const controller = new AbortController()
  // Deliberately capture an unbound prototype method so the monkeypatch can preserve each socket.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const terminate = WebSocket.prototype.terminate
  let terminateCalls = 0
  try {
    const socket = await connect(harness.endpoint, controller.signal, {closeTimeoutMs: 25})
    const peer = await harness.peer
    WebSocket.prototype.terminate = function terminateAtDeadline(): void {
      terminateCalls += 1
      terminate.call(this)
    }
    peer.pause()
    const waiting = socket.receive()
    const waitingRejected = assert.rejects(waiting, hasCode('closed'))
    const first = socket.close()
    const second = socket.close()
    assert.equal(first, second)
    await settleWithin('bounded close', first, 500)
    assert.equal(terminateCalls, 1)
    await settleWithin('close waiting receiver', waitingRejected)
    await assert.rejects(socket.send(new Uint8Array([1])), hasCode('closed'))
    await assert.rejects(socket.receive(), hasCode('closed'))
  } finally {
    WebSocket.prototype.terminate = terminate
    await harness.close()
  }
})
