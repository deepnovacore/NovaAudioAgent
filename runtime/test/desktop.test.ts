import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import type { Socket } from 'node:net'
import { test } from 'node:test'
import { WebSocket, type RawData } from 'ws'
import {
  DesktopProtocolError,
  MAX_DESKTOP_JSON_BYTES,
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
