import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import type { Socket } from 'node:net'
import { test } from 'node:test'
import { WebSocket, type RawData } from 'ws'
import {
  DesktopProtocolError,
  MAX_DESKTOP_JSON_BYTES,
  MAX_DESKTOP_OUTBOUND_BINARY_BYTES,
  MAX_DESKTOP_PENDING_SENDS,
  MAX_DESKTOP_PCM_BYTES,
  NodeDesktopServer,
  announceReadiness,
  authenticateDesktopFrame,
  parseDesktopControl,
  parseReadyEndpoint,
} from '../src/desktop.js'

const TOKEN = '0123456789abcdef0123456789abcdef'

interface CloseVerdict {
  readonly code: number
  readonly reason: string
}

interface ReceivedFrame {
  readonly binary: boolean
  readonly bytes: Uint8Array
}

function text(data: RawData): string {
  return Buffer.isBuffer(data)
    ? data.toString('utf8')
    : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]).toString('utf8')
}

async function connect(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/`)
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  return socket
}

function nextTextFrames(socket: WebSocket, count: number): Promise<readonly string[]> {
  return new Promise((resolve, reject) => {
    const frames: string[] = []
    const onMessage = (data: RawData, isBinary: boolean): void => {
      if (isBinary) {
        cleanup()
        reject(new Error('expected a text desktop frame'))
        return
      }
      frames.push(text(data))
      if (frames.length === count) {
        cleanup()
        resolve(frames)
      }
    }
    const onClose = (): void => {
      cleanup()
      reject(new Error('desktop socket closed before all frames arrived'))
    }
    const cleanup = (): void => {
      socket.off('message', onMessage)
      socket.off('close', onClose)
    }
    socket.on('message', onMessage)
    socket.once('close', onClose)
  })
}

function waitForClose(socket: WebSocket): Promise<CloseVerdict> {
  return new Promise(resolve => {
    socket.once('close', (code, reason) => resolve({
      code,
      reason: reason.toString('utf8'),
    }))
  })
}

async function closeClient(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return
  const closed = waitForClose(socket)
  if (socket.readyState < WebSocket.CLOSING) socket.close(1000)
  await closed
}

function settleWithin<T>(label: string, promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not settle in time`)), timeoutMs)
    void promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(`${label} rejected`))
      },
    )
  })
}

function nextFrames(socket: WebSocket, count: number): Promise<readonly ReceivedFrame[]> {
  return new Promise((resolve, reject) => {
    const frames: ReceivedFrame[] = []
    const onMessage = (data: RawData, isBinary: boolean): void => {
      const bytes = Buffer.isBuffer(data)
        ? new Uint8Array(data)
        : new Uint8Array(Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]))
      frames.push({binary: isBinary, bytes})
      if (frames.length === count) {
        cleanup()
        resolve(frames)
      }
    }
    const onClose = (): void => {
      cleanup()
      reject(new Error('desktop socket closed before all frames arrived'))
    }
    const cleanup = (): void => {
      socket.off('message', onMessage)
      socket.off('close', onClose)
    }
    socket.on('message', onMessage)
    socket.once('close', onClose)
  })
}

async function authenticate(socket: WebSocket, bootstrapCount = 2): Promise<void> {
  const bootstrap = nextFrames(socket, bootstrapCount)
  socket.send(JSON.stringify({type: 'hello', token: TOKEN}))
  await settleWithin('desktop authentication bootstrap', bootstrap)
}

test('desktop parsers validate credentials without echoing them', () => {
  authenticateDesktopFrame(
    JSON.stringify({type: 'hello', token: TOKEN, ignored: 'compatible-with-python'}),
    TOKEN,
  )
  const secret = 'wrong-secret'
  assert.throws(
    () => authenticateDesktopFrame(JSON.stringify({type: 'hello', token: secret}), TOKEN),
    error => error instanceof DesktopProtocolError && !error.message.includes(secret),
  )
  assert.throws(() => authenticateDesktopFrame(' '.repeat(MAX_DESKTOP_JSON_BYTES + 1), TOKEN),
    /too large/u)
  assert.throws(() => parseReadyEndpoint('localhost:4000'), /invalid/u)
  assert.deepEqual(parseReadyEndpoint('127.0.0.1:4000'), {host: '127.0.0.1', port: 4000})
})

test('desktop controls preserve the Python accepted shape and strip unknown evidence', () => {
  assert.deepEqual(parseDesktopControl(JSON.stringify({
    type: 'playback.started',
    utterance_id: 'u-1',
    generation_epoch: 2,
    played_ms: 'ignored-on-start',
    extra: true,
  })), {
    type: 'playback.started',
    utterance_id: 'u-1',
    generation_epoch: 2,
  })
  const onset = parseDesktopControl(JSON.stringify({
    type: 'speech.onset',
    speech_id: 'x'.repeat(256),
  }))
  assert.equal(onset.type, 'speech.onset')
  if (onset.type === 'speech.onset') assert.equal(onset.speech_id, 'x'.repeat(256))
  assert.throws(() => parseDesktopControl(JSON.stringify({
    type: 'speech.onset',
    speech_id: '   ',
  })), /unsupported/u)
  assert.throws(() => parseDesktopControl(JSON.stringify({
    type: 'playback.done',
    utterance_id: 'u-1',
    generation_epoch: 1,
    played_ms: -1,
  })), /unsupported/u)
})

test('readiness is announced as one authenticated line over loopback TCP', async () => {
  let received = Buffer.alloc(0)
  const listener = createServer(socket => {
    socket.on('data', chunk => { received = Buffer.concat([received, chunk]) })
  })
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject)
    listener.listen({host: '127.0.0.1', port: 0}, resolve)
  })
  const address = listener.address()
  assert.ok(address !== null && typeof address === 'object')

  try {
    await announceReadiness(`127.0.0.1:${address.port}`, {
      token: TOKEN,
      host: '127.0.0.1',
      port: 51_515,
    })
    assert.equal(received.toString('utf8'), `${JSON.stringify({
      token: TOKEN,
      host: '127.0.0.1',
      port: 51_515,
    })}\n`)
  } finally {
    await new Promise<void>((resolve, reject) => listener.close(error => {
      if (error !== undefined) reject(error)
      else resolve()
    }))
  }
})

test('authenticated desktop client receives bootstrap and forwards validated input', async () => {
  let resolveAudio: ((value: Uint8Array) => void) | undefined
  let resolveControl: ((value: string) => void) | undefined
  const audio = new Promise<Uint8Array>(resolve => { resolveAudio = resolve })
  const control = new Promise<string>(resolve => { resolveControl = resolve })
  let disconnects = 0
  const server = new NodeDesktopServer({
    token: TOKEN,
    onAudio: pcm => resolveAudio?.(pcm),
    onControl: value => resolveControl?.(value.type),
    onClientDisconnect: () => { disconnects += 1 },
  })
  const readiness = await server.start()
  const socket = await connect(readiness.port)

  try {
    const bootstrap = nextTextFrames(socket, 2)
    socket.send(JSON.stringify({type: 'hello', token: TOKEN}))
    assert.deepEqual(await bootstrap, [
      '{"type":"desktop.ready"}',
      '{"type":"codex.state","state":"idle"}',
    ])

    socket.send(Buffer.from([0, 1, 2, 3]))
    socket.send(JSON.stringify({type: 'speech.onset', speech_id: 'speech-1'}))
    assert.deepEqual([...await audio], [0, 1, 2, 3])
    assert.equal(await control, 'speech.onset')
  } finally {
    await closeClient(socket)
    await server.close()
  }
  assert.equal(disconnects, 1)
})

test('invalid credentials and malformed PCM fail closed with no credential disclosure', async () => {
  const server = new NodeDesktopServer({token: TOKEN})
  const readiness = await server.start()
  const invalid = await connect(readiness.port)

  const invalidClosed = waitForClose(invalid)
  invalid.send(JSON.stringify({type: 'hello', token: 'not-the-token'}))
  const invalidVerdict = await invalidClosed
  assert.deepEqual(invalidVerdict, {code: 4003, reason: 'desktop protocol rejected'})

  const malformed = await connect(readiness.port)
  const bootstrap = nextTextFrames(malformed, 2)
  malformed.send(JSON.stringify({type: 'hello', token: TOKEN}))
  await bootstrap
  const malformedClosed = waitForClose(malformed)
  malformed.send(Buffer.from([0]))
  assert.deepEqual(await malformedClosed, {code: 4003, reason: 'desktop protocol rejected'})
  await server.close()
})

test('a second desktop client cannot take over the active connection', async () => {
  const server = new NodeDesktopServer({token: TOKEN})
  const readiness = await server.start()
  const primary = await connect(readiness.port)
  const bootstrap = nextTextFrames(primary, 2)
  primary.send(JSON.stringify({type: 'hello', token: TOKEN}))
  await bootstrap

  const duplicate = new WebSocket(`ws://127.0.0.1:${readiness.port}/`)
  const duplicateClosed = waitForClose(duplicate)
  assert.deepEqual(await duplicateClosed, {
    code: 4009,
    reason: 'desktop client already connected',
  })

  await closeClient(primary)
  await server.close()
})

test('an unauthenticated desktop client is dropped on its own deadline', async () => {
  const server = new NodeDesktopServer({token: TOKEN, authTimeoutMs: 25})
  const readiness = await server.start()
  const silent = await connect(readiness.port)

  assert.deepEqual(await waitForClose(silent), {
    code: 4003,
    reason: 'desktop protocol rejected',
  })
  await server.close()
})

test('oversized PCM is rejected by the WebSocket payload bound', async () => {
  const server = new NodeDesktopServer({token: TOKEN})
  const readiness = await server.start()
  const socket = await connect(readiness.port)
  const bootstrap = nextTextFrames(socket, 2)
  socket.send(JSON.stringify({type: 'hello', token: TOKEN}))
  await bootstrap

  const closed = waitForClose(socket)
  socket.send(Buffer.alloc(MAX_DESKTOP_PCM_BYTES + 2))
  assert.equal((await closed).code, 1009)
  await server.close()
})

test('a renderer that disconnects can reconnect to the same live runtime', async () => {
  // Python's realtime/desktop.py drains only on parent EOF or a signal, so a
  // window reload must find the backend still serving.
  let disconnects = 0
  let observeDisconnect: (() => void) | undefined
  const serverSawDisconnect = new Promise<void>(resolve => { observeDisconnect = resolve })
  const server = new NodeDesktopServer({
    token: TOKEN,
    onClientDisconnect: () => {
      disconnects += 1
      observeDisconnect?.()
    },
  })
  const readiness = await server.start()

  try {
    const first = await connect(readiness.port)
    const firstBootstrap = nextTextFrames(first, 2)
    first.send(JSON.stringify({type: 'hello', token: TOKEN}))
    await firstBootstrap
    await closeClient(first)
    // The client resolving its own close says nothing about the server having
    // observed it, and only the server releasing its active slot admits a
    // replacement. Wait for the server's own verdict.
    await serverSawDisconnect
    assert.equal(disconnects, 1)

    const second = await connect(readiness.port)
    const secondBootstrap = nextTextFrames(second, 2)
    second.send(JSON.stringify({type: 'hello', token: TOKEN}))
    assert.deepEqual(await secondBootstrap, [
      '{"type":"desktop.ready"}',
      '{"type":"codex.state","state":"idle"}',
    ])
    await closeClient(second)
  } finally {
    await server.close()
  }
})

test('desktop outbound sends fail closed before authentication and after disconnect', async () => {
  let observeDisconnect: (() => void) | undefined
  const disconnected = new Promise<void>(resolve => { observeDisconnect = resolve })
  const server = new NodeDesktopServer({
    token: TOKEN,
    onClientDisconnect: () => observeDisconnect?.(),
  })
  const readiness = await server.start()
  const socket = await connect(readiness.port)

  try {
    await assert.rejects(
      server.sendText('{"type":"before-auth"}'),
      error => error instanceof DesktopProtocolError && !error.message.includes('before-auth'),
    )
    await authenticate(socket)
    await closeClient(socket)
    await settleWithin('server observes desktop disconnect', disconnected)
    await assert.rejects(
      server.sendBinary(new Uint8Array([9, 8, 7])),
      error => error instanceof DesktopProtocolError,
    )
  } finally {
    await server.close()
  }
})

test('desktop outbound writer preserves accepted text and binary frame order', async () => {
  const server = new NodeDesktopServer({token: TOKEN})
  const readiness = await server.start()
  const socket = await connect(readiness.port)

  try {
    await authenticate(socket)
    const received = nextFrames(socket, 3)
    await Promise.all([
      server.sendText('{"type":"outbound.one"}'),
      server.sendBinary(new Uint8Array([0, 255, 3, 128])),
      server.sendText('{"type":"outbound.two"}'),
    ])
    const frames = await settleWithin('ordered desktop outbound frames', received)
    assert.deepEqual(frames.map(frame => ({
      binary: frame.binary,
      bytes: [...frame.bytes],
    })), [
      {binary: false, bytes: [...Buffer.from('{"type":"outbound.one"}', 'utf8')]},
      {binary: true, bytes: [0, 255, 3, 128]},
      {binary: false, bytes: [...Buffer.from('{"type":"outbound.two"}', 'utf8')]},
    ])
  } finally {
    await closeClient(socket)
    await server.close()
  }
})

test('configured bootstrap frames precede the authenticated notification', async () => {
  let authenticatedNotifications = 0
  const server = new NodeDesktopServer({
    token: TOKEN,
    bootstrapTextFrames: ['{"type":"desktop.ready"}'],
    onClientAuthenticated: async () => {
      authenticatedNotifications += 1
      await server.sendText('{"type":"desktop.authenticated"}')
    },
  })
  const readiness = await server.start()
  const socket = await connect(readiness.port)

  try {
    const received = nextFrames(socket, 2)
    socket.send(JSON.stringify({type: 'hello', token: TOKEN}))
    const frames = await settleWithin('configured bootstrap and authentication notification', received)
    assert.equal(authenticatedNotifications, 1)
    assert.deepEqual(frames.map(frame => text(Buffer.from(frame.bytes))), [
      '{"type":"desktop.ready"}',
      '{"type":"desktop.authenticated"}',
    ])
  } finally {
    await closeClient(socket)
    await server.close()
  }
})

test('desktop outbound applies size and pending-send bounds', async () => {
  const server = new NodeDesktopServer({token: TOKEN})
  const readiness = await server.start()
  const socket = await connect(readiness.port)

  try {
    await authenticate(socket)
    const delivered = nextFrames(socket, MAX_DESKTOP_PENDING_SENDS)
    const pending = Array.from({length: MAX_DESKTOP_PENDING_SENDS}, (_, index) =>
      server.sendText(`{"type":"pending","index":${index}}`),
    )
    await assert.rejects(
      server.sendText('{"type":"pending","index":128}'),
      error => error instanceof DesktopProtocolError,
    )
    await Promise.all(pending)
    await settleWithin('bounded pending desktop sends', delivered)
    await assert.rejects(
      server.sendText('x'.repeat(MAX_DESKTOP_JSON_BYTES + 1)),
      error => error instanceof DesktopProtocolError,
    )
    await assert.rejects(
      server.sendBinary(new Uint8Array(MAX_DESKTOP_OUTBOUND_BINARY_BYTES + 1)),
      error => error instanceof DesktopProtocolError,
    )
  } finally {
    await closeClient(socket)
    await server.close()
  }
})

test('a failed desktop outbound send releases only that socket and notifies once', async () => {
  let disconnects = 0
  let observeDisconnect: (() => void) | undefined
  const disconnected = new Promise<void>(resolve => { observeDisconnect = resolve })
  const server = new NodeDesktopServer({
    token: TOKEN,
    onClientDisconnect: () => {
      disconnects += 1
      observeDisconnect?.()
    },
  })
  const readiness = await server.start()
  const socket = await connect(readiness.port)

  try {
    await authenticate(socket)
    const sending = server.sendBinary(
      new Uint8Array(MAX_DESKTOP_OUTBOUND_BINARY_BYTES),
    )
    socket.terminate()
    await assert.rejects(
      settleWithin('failed desktop outbound send', sending),
      error => error instanceof DesktopProtocolError,
    )
    await settleWithin('failed send disconnect notification', disconnected)
    assert.equal(disconnects, 1)
  } finally {
    await server.close()
  }
})

test('desktop outbound uses a fresh authenticated socket after reconnect', async () => {
  let disconnects = 0
  let observeFirstDisconnect: (() => void) | undefined
  const firstDisconnected = new Promise<void>(resolve => { observeFirstDisconnect = resolve })
  const server = new NodeDesktopServer({
    token: TOKEN,
    onClientDisconnect: () => {
      disconnects += 1
      if (disconnects === 1) observeFirstDisconnect?.()
    },
  })
  const readiness = await server.start()

  try {
    const first = await connect(readiness.port)
    await authenticate(first)
    const firstMessage = nextFrames(first, 1)
    await server.sendText('{"type":"first-connection"}')
    const firstFrames = await settleWithin('first outbound send', firstMessage)
    assert.equal(firstFrames.length, 1)
    assert.equal(text(Buffer.from(firstFrames[0]!.bytes)),
      '{"type":"first-connection"}')
    await closeClient(first)
    await settleWithin('first server disconnect', firstDisconnected)

    const second = await connect(readiness.port)
    try {
      await authenticate(second)
      const secondMessage = nextFrames(second, 1)
      await server.sendText('{"type":"second-connection"}')
      const secondFrames = await settleWithin('second outbound send', secondMessage)
      assert.equal(secondFrames.length, 1)
      assert.equal(text(Buffer.from(secondFrames[0]!.bytes)),
        '{"type":"second-connection"}')
    } finally {
      await closeClient(second)
    }
  } finally {
    await server.close()
  }
})

test('forwarded PCM is a copy that a later frame cannot overwrite', async () => {
  // `ws` allocates receive buffers from a shared pool, so a view would alias
  // bytes the next frame reuses.
  const received: Uint8Array[] = []
  const server = new NodeDesktopServer({
    token: TOKEN,
    onAudio: pcm => { received.push(pcm) },
  })
  const readiness = await server.start()
  const socket = await connect(readiness.port)

  try {
    const bootstrap = nextTextFrames(socket, 2)
    socket.send(JSON.stringify({type: 'hello', token: TOKEN}))
    await bootstrap

    for (let frame = 1; frame <= 8; frame += 1) {
      socket.send(Buffer.alloc(64, frame))
    }
    while (received.length < 8) await new Promise(resolve => setTimeout(resolve, 10))

    received.forEach((pcm, index) => {
      assert.deepEqual([...new Set(pcm)], [index + 1], `frame ${index + 1} was overwritten`)
    })
  } finally {
    await closeClient(socket)
    await server.close()
  }
})

test('readiness announcement fails on its own deadline instead of hanging', async () => {
  // A parent that accepts and then holds the connection open forever.
  const held: Socket[] = []
  const listener = createServer(socket => held.push(socket))
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject)
    listener.listen({host: '127.0.0.1', port: 0}, resolve)
  })
  const address = listener.address()
  assert.ok(address !== null && typeof address === 'object')

  try {
    await assert.rejects(
      announceReadiness(
        `127.0.0.1:${address.port}`,
        {token: TOKEN, host: '127.0.0.1', port: 51_515},
        50,
      ),
      (error: unknown) => error instanceof DesktopProtocolError
        && error.message.includes('timed out'),
    )
  } finally {
    for (const socket of held) socket.destroy()
    await new Promise<void>((resolve, reject) => listener.close(error => {
      if (error !== undefined) reject(error)
      else resolve()
    }))
  }
})

test('desktop shutdown terminates a peer that does not acknowledge close', async () => {
  const server = new NodeDesktopServer({token: TOKEN, closeGraceMs: 25})
  const readiness = await server.start()
  const socket = await connect(readiness.port)
  const bootstrap = nextTextFrames(socket, 2)
  socket.send(JSON.stringify({type: 'hello', token: TOKEN}))
  await bootstrap

  const transport = (socket as WebSocket & {readonly _socket: Socket})._socket
  transport.pause()
  const started = Date.now()
  await server.close()
  assert.ok(Date.now() - started < 500)
  transport.destroy()
})
