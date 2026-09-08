import assert from 'node:assert/strict'
import {once} from 'node:events'
import {test} from 'node:test'
import {WebSocket} from 'ws'

import {ClientServer} from '../src/client-server.js'
import type {ClientMedia} from '../src/client-protocol.js'
const token = '0123456789abcdef0123456789abcdef'

async function peer(port: number, path = '/client/v1'): Promise<{socket: WebSocket; next: () => Promise<Record<string, unknown>>}> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`)
  const frames: Record<string, unknown>[] = []
  const readers: ((frame: Record<string, unknown>) => void)[] = []
  socket.on('message', data => {
    const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
    const frame = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
    const read = readers.shift()
    if (read) read(frame)
    else frames.push(frame)
  })
  await once(socket, 'open')
  return {socket, next: async () => frames.shift() ?? new Promise(resolve => readers.push(resolve))}
}

function hello(socket: WebSocket, credential = token): void {
  socket.send(JSON.stringify({type: 'hello', token: credential, protocol_version: 1}))
}

test('private endpoint authenticates before ready and routes controls once', {timeout: 5000}, async t => {
  let controls = 0
  const server = new ClientServer({token, port: 0, onControl: () => { controls++ }})
  t.after(() => server.close())
  const {port} = await server.start()
  const client = await peer(port)
  t.after(() => client.socket.terminate())
  hello(client.socket)
  const ready = await client.next()
  assert.equal(ready.type, 'client.ready')
  assert.equal(ready.protocol_version, 1)
  assert.equal(ready.media, undefined, 'unconfigured transport must not invent a production pipeline')
  const command = {type: 'client.command', request_id: 'r', connection_id: ready.connection_id,
    payload: {type: 'project.confirmation_decision', proposal_id: 'p', confirmed: true}}
  client.socket.send(JSON.stringify(command))
  assert.equal((await client.next()).status, 'applied')
  client.socket.send(JSON.stringify(command))
  assert.equal((await client.next()).status, 'applied')
  assert.equal(controls, 1)
})

test('bad token, unknown version, unauthenticated audio and non-versioned paths cannot access runtime', {timeout: 5000}, async t => {
  let authenticated = 0
  const server = new ClientServer({token, port: 0, onClientAuthenticated: () => { authenticated++ }})
  t.after(() => server.close())
  const {port} = await server.start()
  const wrong = await peer(port)
  const closed = once(wrong.socket, 'close')
  hello(wrong.socket, 'ffffffffffffffffffffffffffffffff')
  assert.equal((await closed)[0], 4003)
  const version = await peer(port)
  const versionClosed = once(version.socket, 'close')
  version.socket.send(JSON.stringify({type: 'hello', token, protocol_version: 2}))
  assert.equal((await versionClosed)[0], 4006)
  const audio = await peer(port)
  const audioClosed = once(audio.socket, 'close')
  audio.socket.send(Buffer.from([0, 0]))
  assert.equal((await audioClosed)[0], 4003)
  const debug = await peer(port, '/debug-board')
  assert.equal((await once(debug.socket, 'close'))[0], 4004)
  assert.equal(authenticated, 0)
})

test('disconnect fences queued controls and fresh connection resumes same service', {timeout: 5000}, async t => {
  let unblock: (() => void) | undefined
  let audioEntered: (() => void) | undefined
  const entered = new Promise<void>(resolve => { audioEntered = resolve })
  const hold = new Promise<void>(resolve => { unblock = resolve })
  let controls = 0
  const server = new ClientServer({token, port: 0, onControl: () => { controls++ },
    onAudio: async () => { audioEntered?.(); await hold }})
  t.after(() => server.close())
  const {port} = await server.start()
  const first = await peer(port)
  hello(first.socket)
  const ready1 = await first.next()
  first.socket.send(Buffer.from([0, 0]))
  await entered
  first.socket.send(JSON.stringify({type: 'client.command', request_id: 'stale', connection_id: ready1.connection_id,
    payload: {type: 'project.confirmation_decision', proposal_id: 'p', confirmed: true}}))
  await server.disconnectClient()
  unblock?.()
  const second = await peer(port)
  t.after(() => second.socket.terminate())
  hello(second.socket)
  const ready2 = await second.next()
  assert.equal(ready2.server_instance_id, ready1.server_instance_id)
  assert.notEqual(ready2.connection_id, ready1.connection_id)
  assert.equal(controls, 0)
})

test('second client is busy and unsafe frames terminate only their connection', {timeout: 5000}, async t => {
  const server = new ClientServer({token, port: 0})
  t.after(() => server.close())
  const {port} = await server.start()
  const first = await peer(port)
  hello(first.socket)
  await first.next()
  const second = await peer(port)
  assert.equal((await once(second.socket, 'close'))[0], 4009)
  const closed = once(first.socket, 'close')
  first.socket.send(Buffer.from([0]))
  assert.equal((await closed)[0], 4003)
  const third = await peer(port)
  t.after(() => third.socket.terminate())
  hello(third.socket)
  assert.equal((await third.next()).type, 'client.ready')
})

test('a missing control consumer rejects rather than caching a false delivery receipt', {timeout: 5000}, async t => {
  const server = new ClientServer({token, port: 0})
  t.after(() => server.close())
  const client = await peer((await server.start()).port)
  t.after(() => client.socket.terminate())
  hello(client.socket)
  const ready = await client.next()
  const command = JSON.stringify({type: 'client.command', request_id: 'missing', connection_id: ready.connection_id,
    payload: {type: 'project.confirmation_decision', proposal_id: 'p', confirmed: true}})
  client.socket.send(command)
  assert.equal((await client.next()).status, 'rejected')
  client.socket.send(command)
  assert.equal((await client.next()).status, 'rejected')
})

test('a blocked provider cannot accumulate unbounded empty input messages', {timeout: 5000}, async t => {
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const blocked = new Promise<void>(resolve => { release = resolve })
  const server = new ClientServer({token, port: 0, onAudio: async () => { entered(); await blocked }})
  t.after(async () => { release(); await server.close() })
  const {port} = await server.start()
  const client = await peer(port)
  hello(client.socket)
  await client.next()
  client.socket.send(Buffer.from([0, 0]))
  await waiting
  const closed = once(client.socket, 'close')
  for (let n = 0; n < 129; n++) client.socket.send(Buffer.alloc(0))
  assert.equal((await closed)[0], 4003)
})

test('media negotiation selects configured relay and rejects incompatible offers before admission', {timeout: 5000}, async t => {
  let admissions = 0
  const server = new ClientServer({token, port: 0,
    media: {transport: 'host_pcm_v1', path: 'relay', audio_owner: 'client', pipeline: 'cascaded'},
    onClientAuthenticated: () => { admissions++ },
  })
  t.after(() => server.close())
  const {port} = await server.start()
  for (const media of [{transports: ['qwen_aoq_v1']}, {transports: []}, null, {transports: ['host_pcm_v1'], endpoint: 'https://untrusted'}]) {
    const client = await peer(port)
    const closed = once(client.socket, 'close')
    client.socket.send(JSON.stringify({type: 'hello', token, protocol_version: 1, media}))
    assert.equal((await closed)[0], 4006)
  }
  assert.equal(admissions, 0)
  const client = await peer(port)
  t.after(() => client.socket.terminate())
  client.socket.send(JSON.stringify({type: 'hello', token, protocol_version: 1,
    media: {transports: ['qwen_aoq_v1', 'host_pcm_v1']}}))
  const ready = await client.next()
  assert.deepEqual(ready.media, {transport: 'host_pcm_v1', path: 'relay', audio_owner: 'client', pipeline: 'cascaded'})
  assert.equal(admissions, 1)
})


test('server rejects an invalid configured media path before allocating a listener', () => {
  for (const media of [null, {transport: 'qwen_aoq_v1', path: 'direct'},
    {transport: 'host_pcm_v1', path: 'relay', audio_owner: 'client', pipeline: 'integrated', token: 'must-not-leak'}]) {
    assert.throws(() => new ClientServer({token, port: 0, media: media as unknown as ClientMedia}))
  }
})
