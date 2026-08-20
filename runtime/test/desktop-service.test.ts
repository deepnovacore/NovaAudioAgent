import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WebSocket, type RawData } from 'ws'
import { buildAssembly } from '../src/assembly.js'
import { settingsSchema } from '../src/config.js'
import type { DesktopReadiness } from '../src/desktop.js'
import { NodeDesktopServer } from '../src/desktop.js'
import { runFromEnvironment } from '../src/desktop-service.js'
import type { EventRecord } from '../src/events.js'
import { MonotonicIdFactory } from '../src/ids.js'
import type {
  CompleteRequest,
  GatewayCompletion,
  GatewayDelta,
  ModelGateway,
  StreamRequest,
} from '../src/model-gateway.js'

const TOKEN = '0123456789abcdef0123456789abcdef'

function frameText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  return Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]).toString('utf8')
}

class ScriptedGateway implements ModelGateway {
  constructor(private readonly deltas: readonly GatewayDelta[] = []) {}
  async *stream(request: StreamRequest): AsyncIterable<GatewayDelta> {
    void request
    for (const delta of this.deltas) {
      await Promise.resolve()
      yield delta
    }
  }
  complete(request: CompleteRequest): Promise<GatewayCompletion> {
    void request
    return Promise.resolve({text: ''})
  }
}

async function waitFor(condition: () => boolean, milliseconds = 4_000): Promise<void> {
  const deadline = Date.now() + milliseconds
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition never became true')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function connect(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/`)
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

test('the desktop service serves a renderer over the real transport', async () => {
  const assembly = buildAssembly({
    settings: settingsSchema.parse({
      executors: ['fast_sim'], model_api_key: 'k', tavily_api_key: 'search-k',
    }),
    gateway: new ScriptedGateway([{kind: 'text', text: '在的'}]),
    ids: new MonotonicIdFactory(),
  })
  const applied: EventRecord[] = []
  assembly.runtime.observe(event => applied.push(event))

  const server = new NodeDesktopServer({token: TOKEN})
  const stop = new AbortController()
  let announced: DesktopReadiness | undefined
  const running = runFromEnvironment({
    assembly,
    server,
    readyEndpoint: '127.0.0.1:1',
    stop,
    // Capture readiness rather than dialing a real loopback listener.
    announce: (endpoint, readiness) => {
      assert.equal(endpoint, '127.0.0.1:1')
      announced = readiness
      return Promise.resolve()
    },
  })

  await waitFor(() => announced !== undefined)
  assert.equal(announced?.host, '127.0.0.1')
  assert.equal(announced?.token, TOKEN)
  assert.ok((announced?.port ?? 0) > 0)

  const socket = await connect(announced.port)
  try {
    const bootstrap = new Promise<string[]>(resolve => {
      const frames: string[] = []
      socket.on('message', (data: RawData) => {
        frames.push(frameText(data))
        if (frames.length === 2) resolve(frames)
      })
    })
    socket.send(JSON.stringify({type: 'hello', token: TOKEN}))
    assert.deepEqual(await bootstrap, [
      '{"type":"desktop.ready"}',
      '{"type":"codex.state","state":"idle"}',
    ])

    // The runtime is genuinely serving while the renderer is attached.
    await assembly.runtime.ingestUserInput({text: '你在吗'})
    await waitFor(() => applied.some(event => event.kind === 'model_done'))
    assert.ok(applied.some(event => event.kind === 'speak_start'))
  } finally {
    socket.close()
    stop.abort()
    await running
  }
})

test('shutdown closes the transport before draining, and is idempotent', async () => {
  const assembly = buildAssembly({
    settings: settingsSchema.parse({
      executors: ['fast_sim'], model_api_key: 'k', tavily_api_key: 'search-k',
    }),
    gateway: new ScriptedGateway([]),
    ids: new MonotonicIdFactory(),
  })
  const server = new NodeDesktopServer({token: TOKEN})
  const stop = new AbortController()
  let announced: DesktopReadiness | undefined
  const running = runFromEnvironment({
    assembly, server, readyEndpoint: '127.0.0.1:1', stop,
    announce: (_endpoint, readiness) => { announced = readiness; return Promise.resolve() },
  })
  await waitFor(() => announced !== undefined)

  stop.abort()
  await running
  // A second stop must not throw, and the runtime must be closed rather than serving.
  stop.abort()
  await assert.rejects(assembly.runtime.ingestUserInput({text: 'too late'}),
    /closed/u)
})

test('a readiness failure still tears the service down', async () => {
  const assembly = buildAssembly({
    settings: settingsSchema.parse({
      executors: ['fast_sim'], model_api_key: 'k', tavily_api_key: 'search-k',
    }),
    gateway: new ScriptedGateway([]),
    ids: new MonotonicIdFactory(),
  })
  const server = new NodeDesktopServer({token: TOKEN})
  const stop = new AbortController()
  await assert.rejects(runFromEnvironment({
    assembly, server, readyEndpoint: '127.0.0.1:1', stop,
    announce: () => Promise.reject(new Error('parent went away')),
  }), /parent went away/u)
  // The serving loop must not be left running after the failure.
  await assert.rejects(assembly.runtime.ingestUserInput({text: 'x'}), /closed/u)
})
