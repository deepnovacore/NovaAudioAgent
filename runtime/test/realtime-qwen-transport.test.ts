import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import { QwenSocketClosedError } from '../src/realtime/qwen.js'
import {
  MAX_QWEN_INBOUND_BACKLOG,
  webSocketQwenConnector,
} from '../src/realtime/qwen-transport.js'

function textOfFrame(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  return Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]).toString('utf8')
}

interface Harness {
  readonly endpoint: string
  readonly headers: Promise<Record<string, string | string[] | undefined>>
  readonly peer: Promise<WebSocket>
  close(): Promise<void>
}

/** A real loopback WebSocket server, so the transport is exercised, not mocked. */
async function harness(): Promise<Harness> {
  const server = new WebSocketServer({host: '127.0.0.1', port: 0, perMessageDeflate: false})
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  let resolveHeaders: ((value: Record<string, string | string[] | undefined>) => void) | undefined
  let resolvePeer: ((value: WebSocket) => void) | undefined
  const headers = new Promise<Record<string, string | string[] | undefined>>(resolve => {
    resolveHeaders = resolve
  })
  const peer = new Promise<WebSocket>(resolve => { resolvePeer = resolve })
  server.on('connection', (socket, request) => {
    resolveHeaders?.(request.headers)
    resolvePeer?.(socket)
  })
  return {
    endpoint: `ws://127.0.0.1:${address.port}/`,
    headers,
    peer,
    close: () => new Promise<void>((resolve, reject) => {
      // `close` only calls back once every client is gone, so drop them first.
      // Otherwise a test that deliberately leaves its socket open hangs here.
      for (const client of server.clients) client.terminate()
      server.close(error => {
        if (error !== undefined) reject(error)
        else resolve()
      })
    }),
  }
}

/**
 * Receive with a deadline. `receive()` parks when the backlog is empty, so a test
 * whose premise fails must fail fast instead of hanging the whole suite.
 */
async function receiveWithin(
  socket: {receive(): Promise<string>},
  milliseconds: number,
): Promise<string> {
  let timer: NodeJS.Timeout | undefined
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('receive timed out')), milliseconds)
  })
  try {
    return await Promise.race([socket.receive(), expiry])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function connect(endpoint: string, signal: AbortSignal) {
  return webSocketQwenConnector({
    endpoint,
    headers: {Authorization: 'Bearer transport-test-key'},
    openTimeout: 5,
    signal,
  })
}

test('the transport forwards auth headers and round-trips text frames', async () => {
  const server = await harness()
  const stop = new AbortController()
  try {
    const socket = await connect(server.endpoint, stop.signal)
    assert.equal((await server.headers).authorization, 'Bearer transport-test-key')

    const peer = await server.peer
    peer.send(JSON.stringify({type: 'session.created', session: {id: 'sess-1'}}))
    assert.equal(await socket.receive(),
      '{"type":"session.created","session":{"id":"sess-1"}}')

    const received = new Promise<string>(resolve => peer.once('message', (data: RawData) => {
      resolve(textOfFrame(data))
    }))
    await socket.send('{"type":"session.update"}')
    assert.equal(await received, '{"type":"session.update"}')
    await socket.close()
  } finally {
    await server.close()
  }
})

test('frames buffered before the first receive are not dropped', async () => {
  // The wrapper attaches its listener before 'open' resolves, so a server that
  // greets immediately cannot lose its first frames.
  const server = await harness()
  const stop = new AbortController()
  try {
    const opened = connect(server.endpoint, stop.signal)
    const peer = await server.peer
    peer.send('{"type":"first"}')
    peer.send('{"type":"second"}')
    const socket = await opened
    assert.equal(await socket.receive(), '{"type":"first"}')
    assert.equal(await socket.receive(), '{"type":"second"}')
    await socket.close()
  } finally {
    await server.close()
  }
})

test('a peer close drains buffered frames before reporting EOF', async () => {
  const server = await harness()
  const stop = new AbortController()
  try {
    const socket = await connect(server.endpoint, stop.signal)
    const peer = await server.peer
    peer.send('{"type":"last"}')
    peer.close(1000)
    assert.equal(await socket.receive(), '{"type":"last"}')
    await assert.rejects(socket.receive(),
      (error: unknown) => error instanceof QwenSocketClosedError)
  } finally {
    await server.close()
  }
})

test('sending on a closed socket rejects instead of silently dropping', async () => {
  const server = await harness()
  const stop = new AbortController()
  try {
    const socket = await connect(server.endpoint, stop.signal)
    const peer = await server.peer
    const closed = new Promise<void>(resolve => peer.once('close', () => resolve()))
    peer.close(1000)
    await closed
    await assert.rejects(socket.send('{"type":"x"}'),
      (error: unknown) => error instanceof QwenSocketClosedError)
  } finally {
    await server.close()
  }
})

test('binary frames are ignored because this protocol is JSON text', async () => {
  const server = await harness()
  const stop = new AbortController()
  try {
    const socket = await connect(server.endpoint, stop.signal)
    const peer = await server.peer
    peer.send(Buffer.from([0, 1, 2, 3]))
    peer.send('{"type":"text-after-binary"}')
    assert.equal(await socket.receive(), '{"type":"text-after-binary"}')
    await socket.close()
  } finally {
    await server.close()
  }
})

test('an inbound firehose fails the socket rather than growing without bound', async () => {
  const server = await harness()
  const stop = new AbortController()
  try {
    const socket = await connect(server.endpoint, stop.signal)
    const peer = await server.peer
    const flood = MAX_QWEN_INBOUND_BACKLOG * 2
    for (let index = 0; index < flood; index += 1) {
      peer.send(`{"type":"flood","n":${index}}`)
    }
    // Let the queued frames arrive before draining, so the bound is what rejects
    // rather than the drain outrunning delivery.
    await new Promise(resolve => setTimeout(resolve, 250))
    await assert.rejects(async () => {
      for (let index = 0; index < flood + 2; index += 1) {
        await receiveWithin(socket, 2_000)
      }
    }, /backlog overflowed/u)
  } finally {
    await server.close()
  }
})

test('a refused endpoint reports a bounded failure with no credential or URL', async () => {
  const stop = new AbortController()
  await assert.rejects(
    connect('ws://127.0.0.1:1/', stop.signal),
    (error: unknown) => error instanceof Error
      && error.message === 'qwen realtime websocket failed to open',
  )
})

test('an aborted connect does not leak a half-open socket', async () => {
  const server = await harness()
  const stop = new AbortController()
  try {
    const opening = connect(server.endpoint, stop.signal)
    stop.abort()
    await assert.rejects(opening, /aborted/u)
  } finally {
    await server.close()
  }
})
