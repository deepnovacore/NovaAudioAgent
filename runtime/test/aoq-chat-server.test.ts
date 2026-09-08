import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {once} from 'node:events'
import {test} from 'node:test'
import {WebSocket} from 'ws'
import {AoqChatServer, issueAoqCredential, aoqCredentialURL} from '../src/aoq-chat-server.js'

const token = 'a'.repeat(32)
const allocation = {
  aoqTokenForClient: 'test-client-secret', sid: 'test-sid',
  clientRelayCertFingerprint: 'sha256/test-fingerprint',
  clientRelayEndpoints: [{endpoint: '127.0.0.2', port: 8443, route_index: 0}],
  extraInfo: {workspaceIdHash: 'test-workspace'}, sidExpiresInSecs: 7200,
}
async function peer(port: number, autoPong = true, path = '/client/v1') {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, {autoPong})
  const frames: Record<string, unknown>[] = []
  const readers: ((frame: Record<string, unknown>) => void)[] = []
  socket.on('message', data => {
    const frame = JSON.parse((Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)).toString('utf8')) as Record<string, unknown>
    const reader = readers.shift()
    if (reader) reader(frame)
    else frames.push(frame)
  })
  const closed = once(socket, 'close')
  await once(socket, 'open')
  return {socket, frames, closed, next: async () => frames.shift() ?? new Promise<Record<string, unknown>>(resolve => readers.push(resolve))}
}
function hello(socket: WebSocket, overrides: Record<string, unknown> = {}) {
  socket.send(JSON.stringify({type: 'hello', token, protocol_version: 1,
    media: {transports: ['qwen_aoq_chat_v1']}, ...overrides}))
}
function connect(socket: WebSocket, connection_id: unknown, request_id = randomUUID()) {
  socket.send(JSON.stringify({type: 'aoq.connect', connection_id, request_id}))
  return request_id
}

test('official HTTP allocation is bounded, allowlisted, validated and redacted', async () => {
  const result = await issueAoqCredential('test-api-secret', new AbortController().signal, 'llm-test.cn-beijing.maas.aliyuncs.com', (url, init) => {
    assert.equal(url, 'https://llm-test.cn-beijing.maas.aliyuncs.com/api/v1/webrtc/realtime?model=qwen-audio-3.0-realtime-plus')
    assert.equal(init?.method, 'POST')
    assert.equal(init?.redirect, 'error')
    assert.equal(init?.body, '{}')
    assert.deepEqual(init?.headers, {'Content-Type': 'application/json', Authorization: 'Bearer test-api-secret', 'x-dashscope-rtc-transport': 'moq'})
    return Promise.resolve(Response.json({...allocation, secret: 'must-strip', extraInfo: {...allocation.extraInfo, secret: 'must-strip'}}))
  })
  assert.deepEqual(result, allocation)
  for (const response of [
    new Response('private upstream body', {status: 401}),
    new Response('private redirect', {status: 302, headers: {Location: 'https://untrusted.example'}}),
    new Response('not-json-private'), Response.json({data: allocation}),
    Response.json({...allocation, sidExpiresInSecs: 0}),
    Response.json({...allocation, aoqTokenForClient: ''}),
    Response.json({...allocation, clientRelayEndpoints: [{endpoint: 'host', port: 0}]}),
    Response.json({...allocation, extraInfo: {}}),
    new Response('x'.repeat(65_537)),
  ]) {
    await assert.rejects(issueAoqCredential('test-api-secret', new AbortController().signal, 'llm-test.cn-beijing.maas.aliyuncs.com', () => Promise.resolve(response)),
      {message: 'credential_unavailable'})
  }
})

test('AOQ hello, one credential allocation, chat-only session and repeat fence', {timeout: 5000}, async t => {
  let calls = 0
  const server = new AoqChatServer({token, port: 0, issueCredential: () => { calls++; return Promise.resolve(allocation) }})
  t.after(() => server.close())
  const {port} = await server.start()
  const client = await peer(port)
  hello(client.socket)
  const ready = await client.next()
  assert.equal(ready.type, 'client.ready')
  assert.equal(ready.protocol_version, 1)
  assert.match(String(ready.connection_id), /^[0-9a-f-]{36}$/u)
  assert.match(String(ready.server_instance_id), /^[0-9a-f-]{36}$/u)
  assert.deepEqual(ready.capabilities, ['audio', 'captions'])
  assert.deepEqual(ready.input_audio, {encoding: 'pcm_s16le', sample_rate: 16000, channels: 1})
  assert.deepEqual(ready.output_audio, {encoding: 'pcm_s16le', sample_rate: 24000, channels: 1})
  assert.deepEqual(ready.media, {transport: 'qwen_aoq_chat_v1', path: 'direct', audio_owner: 'aoq_sdk', pipeline: 'integrated', mode: 'chat_only'})
  const busy = await peer(port)
  assert.equal((await busy.closed)[0], 4009)
  const request_id = connect(client.socket, ready.connection_id)
  const reply = await client.next()
  assert.equal(reply.type, 'aoq.credentials')
  assert.equal(reply.connection_id, ready.connection_id)
  assert.equal(reply.request_id, request_id)
  assert.deepEqual(reply.credentials, {aoqTokenForClient: 'test-client-secret', sid: 'test-sid',
    clientRelayCertFingerprint: 'sha256/test-fingerprint',
    clientRelayEndpoints: [{endpoint: '127.0.0.2', port: 8443, routeIndex: 0}], extraInfo: {workspaceIdHash: 'test-workspace'}})
  assert.deepEqual(reply.session, {modalities: ['text', 'audio'], voice: 'longanqian', input_audio_format: 'pcm', output_audio_format: 'pcm',
    instructions: '你是Nova，一个自然、友好的语音聊天助手。仅进行纯聊天，不执行主机工具，不操作文件、终端、项目或设备，也不声称已执行这些操作。',
    turn_detection: {type: 'smart_turn'}})
  connect(client.socket, ready.connection_id)
  assert.deepEqual(await client.next(), {type: 'aoq.error', code: 'credential_unavailable'})
  await client.closed
  assert.equal(calls, 1)
})

test('rejects bad auth, incompatible hello, tools, binary PCM, raw events and stale IDs', {timeout: 5000}, async t => {
  let calls = 0
  const server = new AoqChatServer({token, port: 0, issueCredential: () => { calls++; return Promise.resolve(allocation) }, authTimeoutMs: 40})
  t.after(() => server.close())
  const {port} = await server.start()
  for (const [overrides, code] of [[{token: 'b'.repeat(32)}, 4003], [{protocol_version: 2}, 4006], [{media: null}, 4006], [{media: {transports: ['host_pcm_v1']}}, 4006]] as const) {
    const client = await peer(port)
    hello(client.socket, overrides)
    assert.equal((await client.closed)[0], code)
    assert.deepEqual(client.frames, [])
  }
  const unauth = await peer(port)
  connect(unauth.socket, randomUUID())
  assert.equal((await unauth.closed)[0], 4003)
  const idle = await peer(port)
  assert.equal((await idle.closed)[0], 4003)
  const wrongPath = await peer(port, true, '/debug-board')
  assert.equal((await wrongPath.closed)[0], 4004)
  for (const payload of [Buffer.from([0, 0]), {type: 'client.command'}, {type: 'session.update'},
    {type: 'aoq.connect', connection_id: randomUUID(), request_id: randomUUID()},
    {type: 'aoq.connect', request_id: 'not-uuid'}, 'x'.repeat(16_385)]) {
    const client = await peer(port)
    hello(client.socket)
    await client.next()
    client.socket.send(Buffer.isBuffer(payload) ? payload : JSON.stringify(payload))
    assert.ok([1002, 1009].includes(Number((await client.closed)[0])))
    assert.deepEqual(client.frames, [])
  }
  assert.equal(calls, 0)
})

test('failed requests count across connections; rate window recovers', {timeout: 5000}, async t => {
  let calls = 0
  let now = 0
  const server = new AoqChatServer({token, port: 0, now: () => now,
    issueCredential: () => { calls++; return Promise.reject(new Error('private api secret')) }})
  t.after(() => server.close())
  const {port} = await server.start()
  for (let i = 0; i < 8; i++) {
    if (i === 7) now = 60_001
    const client = await peer(port)
    hello(client.socket)
    const ready = await client.next()
    connect(client.socket, ready.connection_id)
    assert.deepEqual(await client.next(), {type: 'aoq.error', code: 'credential_unavailable'})
    await client.closed
    assert.equal(calls, i < 6 ? i + 1 : i === 6 ? 6 : 7)
  }
})

test('disconnect aborts pending allocation and late results cannot reach the new connection', {timeout: 5000}, async t => {
  let finish!: (value: typeof allocation) => void
  let signal!: AbortSignal
  let aborted!: () => void
  const disconnected = new Promise<void>(resolve => { aborted = resolve })
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  let calls = 0
  const server = new AoqChatServer({token, port: 0, issueCredential: async s => {
    calls++
    if (calls > 1) return allocation
    signal = s
    s.addEventListener('abort', aborted, {once: true})
    entered()
    return new Promise(resolve => { finish = resolve })
  }})
  t.after(() => server.close())
  const {port} = await server.start()
  const first = await peer(port)
  hello(first.socket)
  const oldReady = await first.next()
  connect(first.socket, oldReady.connection_id)
  await started
  first.socket.close()
  await first.closed
  await disconnected
  assert.equal(signal.aborted, true)
  const second = await peer(port)
  hello(second.socket)
  const ready = await second.next()
  assert.notEqual(ready.connection_id, oldReady.connection_id)
  assert.equal(ready.server_instance_id, oldReady.server_instance_id)
  finish(allocation)
  connect(second.socket, ready.connection_id)
  assert.equal((await second.next()).connection_id, ready.connection_id)
  assert.deepEqual(second.frames, [])
})

test('pending duplicate aborts immediately, timeout aborts, and expired allocation is never delivered', {timeout: 5000}, async t => {
  for (const mode of ['duplicate', 'timeout', 'expiry'] as const) {
    let signal!: AbortSignal
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    let now = 0
    const server = new AoqChatServer({token, port: 0, credentialTimeoutMs: 30, now: () => now,
      issueCredential: async s => {
        signal = s
        entered()
        if (mode === 'expiry') { now = 100; return {...allocation, sidExpiresInSecs: 0.02} }
        return new Promise(() => { /* Deliberately ignores abort to verify the fence. */ })
      }})
    t.after(() => server.close())
    const client = await peer((await server.start()).port)
    hello(client.socket)
    const ready = await client.next()
    connect(client.socket, ready.connection_id)
    await started
    if (mode === 'duplicate') connect(client.socket, ready.connection_id)
    assert.deepEqual(await client.next(), {type: 'aoq.error', code: 'credential_unavailable'})
    await client.closed
    assert.equal(signal.aborted, true)
  }
})

test('ping/pong keeps live peers and closes silent network peers', {timeout: 5000}, async t => {
  const server = new AoqChatServer({token, port: 0, heartbeatMs: 30, issueCredential: () => Promise.resolve(allocation)})
  t.after(() => server.close())
  const {port} = await server.start()
  const silent = await peer(port, false)
  hello(silent.socket)
  await silent.next()
  assert.equal((await silent.closed)[0], 1006)
  const live = await peer(port)
  hello(live.socket)
  await live.next()
  await once(live.socket, 'ping')
  await once(live.socket, 'ping')
  assert.equal(live.socket.readyState, WebSocket.OPEN)
})

test('HTTP deadline and disconnect abort the fetch without exposing errors', async t => {
  t.mock.timers.enable({apis: ['setTimeout']})
  for (const externalAbort of [false, true]) {
    const controller = new AbortController()
    let upstreamSignal: AbortSignal | null | undefined
    const result = issueAoqCredential('test-api-secret', controller.signal, 'llm-test.cn-beijing.maas.aliyuncs.com', (_url, init) => {
      upstreamSignal = init?.signal
      return new Promise((_resolve, reject) => {
        upstreamSignal?.addEventListener('abort', () => reject(new Error('private transport error')), {once: true})
      })
    })
    const rejected = assert.rejects(result, {message: 'credential_unavailable'})
    if (externalAbort) controller.abort()
    else t.mock.timers.tick(8000)
    await rejected
    assert.equal(upstreamSignal?.aborted, true)
  }
})

test('HTTP streamed oversize and non-OK responses cancel their bodies', async () => {
  for (const status of [200, 403]) {
    let cancelled = false
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(32_768)) },
      cancel() { cancelled = true },
    }), {status})
    await assert.rejects(issueAoqCredential('test-api-secret', new AbortController().signal, 'llm-test.cn-beijing.maas.aliyuncs.com',
      () => Promise.resolve(response)), {message: 'credential_unavailable'})
    assert.equal(cancelled, true)
  }
})


test('SDK endpoint mapping uses routeIndex fallback, permits eight and fails safely beyond wire bounds', {timeout: 5000}, async t => {
  for (const mode of ['mapping', 'eight', 'nine', 'large'] as const) {
    const endpoints = Array.from({length: mode === 'nine' ? 9 : mode === 'eight' ? 8 : 2}, (_, index) => ({
      endpoint: '127.0.0.2', port: 8443, ...(index === 0 ? {route_index: 7} : {}),
    }))
    const server = new AoqChatServer({token, port: 0, issueCredential: () => Promise.resolve({...allocation,
      clientRelayEndpoints: endpoints, ...(mode === 'large' ? {sid: 's'.repeat(8192), aoqTokenForClient: 't'.repeat(8192)} : {}),
    })})
    t.after(() => server.close())
    const client = await peer((await server.start()).port)
    hello(client.socket)
    const ready = await client.next()
    connect(client.socket, ready.connection_id)
    const reply = await client.next()
    assert.ok(Buffer.byteLength(JSON.stringify(reply)) < 16384)
    if (mode === 'nine' || mode === 'large') {
      assert.deepEqual(reply, {type: 'aoq.error', code: 'credential_unavailable'})
      await client.closed
    } else {
      assert.equal(reply.type, 'aoq.credentials')
      const credentials = reply.credentials as {clientRelayEndpoints: Record<string, unknown>[]}
      assert.equal(credentials.clientRelayEndpoints.length, mode === 'eight' ? 8 : 2)
      assert.deepEqual(credentials.clientRelayEndpoints[0], {endpoint: '127.0.0.2', port: 8443, routeIndex: 7})
      assert.deepEqual(credentials.clientRelayEndpoints[1], {endpoint: '127.0.0.2', port: 8443, routeIndex: 1})
    }
  }
})


test('sid expiry does not impose an active-call timer after credential delivery', {timeout: 5000}, async t => {
  const server = new AoqChatServer({token, port: 0, heartbeatMs: 30,
    issueCredential: () => Promise.resolve({...allocation, sidExpiresInSecs: 0.02})})
  t.after(() => server.close())
  const client = await peer((await server.start()).port)
  hello(client.socket)
  const ready = await client.next()
  connect(client.socket, ready.connection_id)
  assert.equal((await client.next()).type, 'aoq.credentials')
  await once(client.socket, 'ping')
  await once(client.socket, 'ping')
  assert.equal(client.socket.readyState, WebSocket.OPEN)
  assert.deepEqual(client.frames, [])
})


test('AOQ API host cannot redirect credentials outside Beijing workspace domains', async () => {
  for (const host of ['', 'dashscope.aliyuncs.com', 'https://llm-test.cn-beijing.maas.aliyuncs.com',
    'llm-test.cn-beijing.maas.aliyuncs.com.evil.test', 'llm-test.cn-beijing.maas.aliyuncs.com:443',
    'llm-test.cn-beijing.maas.aliyuncs.com/path', 'user@llm-test.cn-beijing.maas.aliyuncs.com']) {
    assert.throws(() => aoqCredentialURL(host))
    let called = false
    await assert.rejects(issueAoqCredential('secret', new AbortController().signal, host, () => {
      called = true; throw new Error('must not send credential')
    }))
    assert.equal(called, false)
  }
})

// Runtime extension: these hooks observe the real broker boundary, never real credentials.
type Runtime = NonNullable<ConstructorParameters<typeof AoqChatServer>[0]['runtime']>
type ProviderConnection = Parameters<Runtime['onProviderConnect']>[0]
function runtimeOptions(overrides: Partial<Runtime> = {}): Runtime {
  return {token, onProviderConnect: () => { /* No provider owner in this test. */ }, onProviderEvent: () => { /* No event consumer. */ }, onProviderDisconnect: () => { /* No owned resource. */ }, ...overrides}
}
function runtimeHello(socket: WebSocket) { hello(socket, {media: {transports: ['qwen_aoq_runtime_v1']}}) }
function providerEvent(socket: WebSocket, id: unknown, sequence: number, event: unknown, extra = {}) {
  socket.send(JSON.stringify({type: 'aoq.event', connection_id: id, sequence, event, ...extra}))
}

test('runtime negotiates explicitly, registers before credentials, and owns session commands', {timeout: 5000}, async t => {
  let hook!: ProviderConnection
  let authenticated = false
  const events: unknown[] = []
  const server = new AoqChatServer({token, port: 0, heartbeatMs: 30, issueCredential: () => Promise.resolve(allocation), runtime: runtimeOptions({
    onClientAuthenticated: () => { authenticated = true },
    onProviderConnect: connection => { hook = connection },
    onProviderEvent: (id, event) => { events.push([id, event]) },
  })})
  t.after(() => server.close())
  const readiness = await server.start()
  assert.equal(readiness.token, token)
  const old = await peer(readiness.port)
  hello(old.socket)
  assert.equal((await old.closed)[0], 4006)
  const client = await peer(readiness.port)
  runtimeHello(client.socket)
  const ready = await client.next()
  assert.equal(authenticated, true)
  assert.deepEqual(ready.capabilities, ['audio', 'captions', 'projects', 'executor'])
  assert.equal((ready.media as Record<string, unknown>).transport, 'qwen_aoq_runtime_v1')
  assert.equal((ready.media as Record<string, unknown>).mode, 'runtime')
  connect(client.socket, ready.connection_id)
  const credential = await client.next()
  assert.equal(credential.type, 'aoq.credentials')
  assert.equal(credential.mode, 'runtime')
  assert.equal(credential.session, undefined)
  assert.equal(hook.id, ready.connection_id)
  await hook.send({type: 'session.update', session: {instructions: 'host-owned'}})
  assert.deepEqual(await client.next(), {type: 'aoq.command', connection_id: hook.id, sequence: 1,
    event: {type: 'session.update', session: {instructions: 'host-owned'}}})
  await hook.send({type: 'response.create'})
  assert.equal((await client.next()).sequence, 2)
  providerEvent(client.socket, hook.id, 1, {type: 'session.updated'})
  providerEvent(client.socket, hook.id, 2, {type: 'response.text.delta', delta: 'hello'})
  await once(client.socket, 'ping')
  assert.deepEqual(events, [[hook.id, {type: 'session.updated'}], [hook.id, {type: 'response.text.delta', delta: 'hello'}]])
})

test('runtime rejects wrong directions, IDs, sequences, authority, audio payloads and unallocated events', {timeout: 5000}, async t => {
  for (const bad of ['before', 'id', 'zero', 'gap', 'repeat', 'unsafe', 'authority', 'host', 'audio', 'nested-audio', 'array', 'size', 'binary']) {
    let received = 0
    const server = new AoqChatServer({token, port: 0, issueCredential: () => Promise.resolve(allocation),
      runtime: runtimeOptions({onProviderEvent: () => { received++ }})})
    t.after(() => server.close())
    const client = await peer((await server.start()).port)
    runtimeHello(client.socket)
    const ready = await client.next()
    if (bad !== 'before') { connect(client.socket, ready.connection_id); await client.next() }
    if (bad === 'repeat') providerEvent(client.socket, ready.connection_id, 1, {type: 'session.created'})
    if (bad === 'binary') client.socket.send(Buffer.from([0, 0]))
    else providerEvent(client.socket, bad === 'id' ? randomUUID() : ready.connection_id,
      bad === 'zero' ? 0 : bad === 'gap' ? 2 : bad === 'unsafe' ? Number.MAX_SAFE_INTEGER + 1 : 1,
      bad === 'array' ? [] : bad === 'host' ? {type: 'response.create'} : bad === 'audio' ? {type: 'response.audio.delta', delta: 'AAAA'}
        : bad === 'nested-audio' ? {type: 'response.done', response: {audio: 'AAAA'}}
        : {type: 'response.text.delta', delta: bad === 'size' ? 'x'.repeat(65536) : 'hello'},
      bad === 'authority' ? {mode: 'runtime'} : {})
    assert.equal((await client.closed)[0], 1002, bad)
    assert.equal(received, bad === 'repeat' ? 1 : 0, bad)
  }
})

test('runtime controls wait independently of provider events and duplicate receipts execute once', {timeout: 5000}, async t => {
  let complete!: () => void
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  let calls = 0
  const server = new AoqChatServer({token, port: 0, issueCredential: () => Promise.resolve(allocation), runtime: runtimeOptions({
    onControl: () => { calls++; entered(); return new Promise<void>(resolve => { complete = resolve }) },
    onProviderEvent: () => { complete() },
  })})
  t.after(() => server.close())
  const client = await peer((await server.start()).port)
  runtimeHello(client.socket)
  const ready = await client.next()
  connect(client.socket, ready.connection_id)
  await client.next()
  const command = JSON.stringify({type: 'client.command', connection_id: ready.connection_id, request_id: 'control-1',
    payload: {type: 'project.confirmation_decision', proposal_id: 'proposal', confirmed: true}})
  client.socket.send(command)
  await started
  client.socket.send(command)
  providerEvent(client.socket, ready.connection_id, 1, {type: 'response.done'})
  assert.deepEqual(await client.next(), {type: 'client.command_result', request_id: 'control-1', status: 'applied'})
  assert.deepEqual(await client.next(), {type: 'client.command_result', request_id: 'control-1', status: 'applied'})
  assert.equal(calls, 1)
})

test('runtime release fences client before provider and stale hooks cannot release replacement', {timeout: 5000}, async t => {
  const hooks: ProviderConnection[] = []
  const calls: string[] = []
  const server = new AoqChatServer({token, port: 0, issueCredential: () => Promise.resolve(allocation), runtime: runtimeOptions({
    onProviderConnect: connection => { hooks.push(connection) },
    onClientDisconnect: () => { calls.push('client'); throw new Error('private cleanup error') },
    onProviderDisconnect: id => { calls.push(id) },
  })})
  t.after(() => server.close())
  const {port} = await server.start()
  for (let i = 0; i < 2; i++) {
    const client = await peer(port)
    runtimeHello(client.socket)
    const ready = await client.next()
    connect(client.socket, ready.connection_id)
    await client.next()
    if (i === 0) {
      await server.disconnectClient()
      await client.closed
      assert.deepEqual(calls, ['client', ready.connection_id])
    } else {
      hooks[0]!.disconnect()
      await assert.rejects(hooks[0]!.send({type: 'response.cancel'}))
      await server.sendText('{"type":"desktop.ready"}')
      assert.deepEqual(await client.next(), {type: 'desktop.ready'})
      assert.equal(calls.length, 2)
      await assert.rejects(server.sendBinary(new Uint8Array([0, 0])))
      hooks[1]!.disconnect()
      await client.closed
      assert.deepEqual(calls, ['client', hooks[0]!.id, 'client', hooks[1]!.id])
    }
  }
})

test('chat isolation rejects runtime offer, event path and host transport writes', {timeout: 5000}, async t => {
  const server = new AoqChatServer({token, port: 0, issueCredential: () => Promise.resolve(allocation)})
  t.after(() => server.close())
  const {port} = await server.start()
  const runtime = await peer(port)
  runtimeHello(runtime.socket)
  assert.equal((await runtime.closed)[0], 4006)
  const client = await peer(port)
  hello(client.socket)
  const ready = await client.next()
  connect(client.socket, ready.connection_id)
  await client.next()
  await assert.rejects(server.sendText('{"type":"desktop.ready"}'))
  await assert.rejects(server.sendBinary(new Uint8Array([0, 0])))
  providerEvent(client.socket, ready.connection_id, 1, {type: 'session.updated'})
  assert.equal((await client.closed)[0], 1002)
})

test('runtime allows only the directional event vocabulary and keeps larger data off the control lane', {timeout: 5000}, async t => {
  let hook!: ProviderConnection
  const received: string[] = []
  const server = new AoqChatServer({token, port: 0, heartbeatMs: 30, issueCredential: () => Promise.resolve(allocation), runtime: runtimeOptions({
    onProviderConnect: c => { hook = c }, onProviderEvent: (_id, event) => { received.push(String(event.type)) },
  })})
  t.after(() => server.close())
  const client = await peer((await server.start()).port)
  runtimeHello(client.socket)
  const ready = await client.next()
  connect(client.socket, ready.connection_id)
  await client.next()
  const host = ['session.update', 'conversation.item.create', 'conversation.item.delete', 'conversation.item.truncate',
    'input_audio_buffer.clear', 'response.create', 'response.cancel']
  for (const [index, type] of host.entries()) {
    await hook.send({type, ...(index === 0 ? {session: {instructions: 'x'.repeat(32_768)}} : {})})
    const frame = await client.next()
    assert.equal(frame.sequence, index + 1)
    assert.equal((frame.event as Record<string, unknown>).type, type)
  }
  for (const event of [{type: 'session.updated'}, {type: 'response.audio.delta', delta: 'AAAA'},
    {type: 'input_audio_buffer.append', audio: 'AAAA'}, {type: 'conversation.item.create', item: {content: [{type: 'input_audio', audio: 'AAAA'}]}},
    {type: 'session.update', session: {instructions: 'x'.repeat(65_536)}}]) await assert.rejects(hook.send(event))
  await hook.send({type: 'response.cancel'})
  assert.equal((await client.next()).sequence, 8, 'invalid sends do not consume sequence numbers')
  const inbound = ['session.created', 'session.updated', 'error', 'input_audio_buffer.speech_started',
    'input_audio_buffer.speech_stopped', 'input_audio_buffer.committed', 'input_audio_buffer.cleared',
    'conversation.item.created', 'conversation.item.deleted', 'conversation.item.truncated',
    'conversation.item.input_audio_transcription.completed', 'conversation.item.input_audio_transcription.failed',
    'conversation.item.input_audio_transcription.delta', 'conversation.item.ambient_audio_transcription.delta',
    'conversation.item.ambient_audio_transcription.completed',
    'response.created', 'response.done', 'response.output_item.added', 'response.output_item.done',
    'response.content_part.added', 'response.content_part.done', 'response.audio_transcript.delta', 'response.audio_transcript.done',
    'response.output_audio_transcript.delta', 'response.output_audio_transcript.done', 'response.text.delta', 'response.text.done',
    'response.output_text.delta', 'response.output_text.done',
    'response.function_call_arguments.delta', 'response.function_call_arguments.done', 'response.audio.done']
  for (const [index, type] of inbound.entries()) providerEvent(client.socket, hook.id, index + 1,
    {type, ...(type === 'response.text.delta' ? {delta: 'x'.repeat(32_768)} : {})})
  await once(client.socket, 'ping')
  assert.deepEqual(received, inbound)
  await assert.rejects(server.sendText(JSON.stringify({type: 'caption', text: 'x'.repeat(16_384)})))
  client.socket.send(JSON.stringify({type: 'client.command', connection_id: hook.id, request_id: 'too-big',
    payload: {type: 'project.confirmation_decision', proposal_id: 'x'.repeat(16_384), confirmed: true}}))
  assert.equal((await client.closed)[0], 1002)
})

test('runtime lifecycle hook failures close safely and release only initialized owners', {timeout: 5000}, async t => {
  for (const failure of ['auth-sync', 'auth-async', 'provider-connect', 'provider-event', 'allocation'] as const) {
    const calls: string[] = []
    const server = new AoqChatServer({token, port: 0,
      issueCredential: () => failure === 'allocation' ? Promise.reject(new Error('private allocation')) : Promise.resolve(allocation),
      runtime: runtimeOptions({
        onClientAuthenticated: () => {
          if (failure === 'auth-sync') throw new Error('private auth')
          if (failure === 'auth-async') return Promise.reject(new Error('private async auth'))
        },
        onClientDisconnect: () => { calls.push('client') },
        onProviderConnect: () => { calls.push('connect'); if (failure === 'provider-connect') throw new Error('private connect') },
        onProviderEvent: () => { throw new Error('private event') },
        onProviderDisconnect: () => { calls.push('provider'); throw new Error('private disconnect') },
      })})
    t.after(() => server.close())
    const client = await peer((await server.start()).port)
    runtimeHello(client.socket)
    const ready = await client.next()
    if (!failure.startsWith('auth')) {
      connect(client.socket, ready.connection_id)
      const response = await client.next()
      if (failure === 'provider-event') {
        assert.equal(response.type, 'aoq.credentials')
        providerEvent(client.socket, ready.connection_id, 1, {type: 'session.created'})
      } else assert.deepEqual(response, {type: 'aoq.error', code: 'credential_unavailable'})
    }
    await client.closed
    assert.deepEqual(calls, failure.startsWith('auth') || failure === 'allocation' ? ['client'] : ['connect', 'client', 'provider'])
  }
})

test('runtime blocked control lane is bounded and fenced while late controls finish', {timeout: 5000}, async t => {
  let finish!: () => void
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  let calls = 0
  const server = new AoqChatServer({token, port: 0, issueCredential: () => Promise.resolve(allocation), runtime: runtimeOptions({
    onControl: () => { calls++; entered(); return new Promise<void>(resolve => { finish = resolve }) },
  })})
  t.after(() => server.close())
  const {port} = await server.start()
  const first = await peer(port)
  runtimeHello(first.socket)
  const ready = await first.next()
  const command = (id: number) => JSON.stringify({type: 'client.command', connection_id: ready.connection_id, request_id: `r${id}`,
    payload: {type: 'project.confirmation_decision', proposal_id: 'proposal', confirmed: true}})
  first.socket.send(command(0))
  await started
  for (let i = 1; i <= 128; i++) first.socket.send(command(i))
  await first.closed
  const second = await peer(port)
  runtimeHello(second.socket)
  await second.next()
  finish()
  await server.sendText('{"type":"desktop.ready"}')
  assert.deepEqual(await second.next(), {type: 'desktop.ready'})
  assert.equal(calls, 1)
  assert.deepEqual(first.frames, [])
})

test('runtime outbound queues bound both bytes and message count', {timeout: 5000}, async t => {
  for (const large of [false, true]) {
    let hook!: ProviderConnection
    const server = new AoqChatServer({token, port: 0, issueCredential: () => Promise.resolve(allocation),
      runtime: runtimeOptions({onProviderConnect: connection => { hook = connection }})})
    t.after(() => server.close())
    const client = await peer((await server.start()).port)
    runtimeHello(client.socket)
    const ready = await client.next()
    connect(client.socket, ready.connection_id)
    await client.next()
    const results = await Promise.allSettled(Array.from({length: large ? 5 : 129}, () => hook.send(
      large ? {type: 'session.update', session: {instructions: 'x'.repeat(60_000)}} : {type: 'response.cancel'})))
    assert.equal(results.at(-1)?.status, 'rejected')
    assert.equal((await client.closed)[0], 4008)
  }
})

test('protocol rejection diagnostics contain only safe type and reason; auth keeps 4003', {timeout: 5000}, async t => {
  for (const mode of ['auth', 'unknown', 'payload', 'unsafe-type'] as const) {
    const diagnostics: string[] = []
    const server = new AoqChatServer({token, port: 0, issueCredential: () => Promise.resolve(allocation),
      runtime: runtimeOptions(), onDiagnostic: line => { diagnostics.push(line) }})
    t.after(() => server.close())
    const client = await peer((await server.start()).port)
    if (mode === 'auth') hello(client.socket, {token: 'private-token-value'})
    else {
      runtimeHello(client.socket)
      const ready = await client.next()
      connect(client.socket, ready.connection_id)
      await client.next()
      providerEvent(client.socket, ready.connection_id, 1, mode === 'payload'
        ? {type: 'response.content_part.done', part: {type: 'audio', audio: null}, private: 'secret-body'}
        : {type: mode === 'unknown' ? 'sdk.unknown' : 'secret\nBearer abc123', private: 'secret-body'})
    }
    assert.equal((await client.closed)[0], mode === 'auth' ? 4003 : 1002)
    assert.equal(diagnostics.length, 1)
    assert.match(diagnostics[0]!, /^\[runtime-diagnostic\] aoq_protocol_rejected type=[a-z_.]{1,80} reason=[a-z_]+$/u)
    assert.ok(!diagnostics[0]!.includes('secret') && !diagnostics[0]!.includes('private') && !diagnostics[0]!.includes('Bearer'))
    if (mode === 'unknown') assert.ok(diagnostics[0]!.includes('type=sdk.unknown reason=unsupported_event'))
    if (mode === 'payload') assert.ok(diagnostics[0]!.includes('type=response.content_part.done reason=invalid_event_payload'))
  }
})
