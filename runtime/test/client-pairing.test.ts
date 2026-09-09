import assert from 'node:assert/strict'
import {existsSync, chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {once} from 'node:events'
import {test} from 'node:test'
import {WebSocket} from 'ws'
import {ClientPairing, pairingEndpoint} from '../src/client-pairing.js'
import {ClientServer} from '../src/client-server.js'
import {AoqChatServer} from '../src/aoq-chat-server.js'

const master = 'a'.repeat(32)
const endpoint = 'wss://mac.example/client/v1'

test('pairing codes expire, rotate and redeem once; device hashes persist and revoke independently', {skip: process.platform === 'win32' && 'POSIX device store integration'}, t => {
  const dir = mkdtempSync(join(tmpdir(), 'nova-pair-'))
  t.after(() => rmSync(dir, {recursive: true, force: true}))
  const path = join(dir, 'devices.json')
  let now = 1000
  const pairing = new ClientPairing(master, path, () => now)
  const expired = pairing.create(endpoint)
  now = expired.expires_at
  assert.throws(() => pairing.redeem(expired.code, 'iPhone'))
  const old = pairing.create(endpoint)
  const current = pairing.create(endpoint)
  assert.throws(() => pairing.redeem(old.code, 'iPhone'))
  assert.throws(() => pairing.redeem(current.code, ''))
  const first = pairing.redeem(current.code, 'iPhone')
  assert.throws(() => pairing.redeem(current.code, 'iPhone'))
  const second = pairing.redeem(pairing.create(endpoint).code, 'iPad')
  assert.notEqual(first.token, second.token)
  assert.notEqual(first.token, master)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  const disk = readFileSync(path, 'utf8')
  assert.ok(!disk.includes(first.token) && !disk.includes(master))
  const restarted = new ClientPairing(master, path)
  assert.equal(restarted.accepts(first.token), true)
  assert.equal(restarted.accepts(master), true)
  assert.equal(restarted.accepts('b'.repeat(32)), false)
  let closed = 0
  restarted.track(first.token, () => { closed++ })
  restarted.revoke(first.device_id)
  assert.equal(closed, 1)
  assert.equal(restarted.accepts(first.token), false)
  assert.equal(restarted.accepts(second.token), true)
  assert.equal(new ClientPairing(master, path).accepts(first.token), false)
  for (const url of ['ws://mac.example', 'wss://user:pass@mac.example', 'wss://mac.example/?token=x', 'wss://mac.example/other']) {
    assert.throws(() => pairing.create(url))
  }
})

test('device store fails closed on unsafe permissions, corruption, symlinks and owner rotation', {skip: process.platform === 'win32' && 'POSIX device store integration'}, t => {
  const dir = mkdtempSync(join(tmpdir(), 'nova-pair-store-'))
  t.after(() => rmSync(dir, {recursive: true, force: true}))
  const path = join(dir, 'devices.json')
  const pairing = new ClientPairing(master, path)
  pairing.redeem(pairing.create(endpoint).code, 'iPhone')
  assert.throws(() => new ClientPairing('b'.repeat(32), path))
  const link = join(dir, 'linked.json')
  symlinkSync(path, link)
  assert.throws(() => new ClientPairing(master, link))
  chmodSync(path, 0o644)
  assert.throws(() => new ClientPairing(master, path))
  chmodSync(path, 0o600)
  writeFileSync(path, 'corrupt')
  assert.throws(() => new ClientPairing(master, path))
})

async function request(port: number, path: string, frame: object): Promise<Record<string, unknown>> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`)
  try {
    await once(socket, 'open')
    const response = once(socket, 'message')
    socket.send(JSON.stringify(frame))
    return JSON.parse(String((await response)[0])) as Record<string, unknown>
  } finally { socket.terminate() }
}

for (const aoq of [false, true]) {
  test(`scan redemption and revocation work on ${aoq ? 'AOQ' : 'relay'} without runtime access before hello`, {timeout: 5000, skip: process.platform === 'win32' && 'POSIX device store integration'}, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'nova-pair-socket-'))
    t.after(() => rmSync(dir, {recursive: true, force: true}))
    const pairing = new ClientPairing(master, join(dir, 'devices.json'))
    let authenticated = 0
    const server = aoq
      ? new AoqChatServer({token: master, port: 0, pairing, issueCredential: () => Promise.reject(new Error('must not allocate'))})
      : new ClientServer({token: master, port: 0, pairing, onClientAuthenticated: () => { authenticated++ }})
    t.after(() => server.close())
    const {port} = await server.start()
    const denied = await request(port, '/client/pair-admin', {type: 'pair.create', token: 'b'.repeat(32), server: endpoint})
    assert.equal(denied.type, 'pair.error')
    const qr = await request(port, '/client/pair-admin', {type: 'pair.create', token: master, server: endpoint})
    assert.equal(qr.type, 'nova.pair')
    assert.equal((await request(port, '/client/pair-admin', {type: 'pair.list', token: master, code: qr.code})).pairing_active, true)
    assert.equal(authenticated, 0)
    const device = await request(port, '/client/pair', {type: 'pair.redeem', code: qr.code, device_name: 'iPhone'})
    assert.equal(device.type, 'pair.ready')
    assert.equal((await request(port, '/client/pair-admin', {type: 'pair.list', token: master, code: qr.code})).pairing_active, false)
    const replay = await request(port, '/client/pair', {type: 'pair.redeem', code: qr.code, device_name: 'iPhone'})
    assert.equal(replay.type, 'pair.error')
    const escalation = await request(port, '/client/pair-admin', {type: 'pair.list', token: device.token})
    assert.equal(escalation.type, 'pair.error')
    const socket = new WebSocket(`ws://127.0.0.1:${port}/client/v1`)
    t.after(() => socket.terminate())
    await once(socket, 'open')
    const ready = once(socket, 'message')
    socket.send(JSON.stringify({type: 'hello', token: device.token, protocol_version: 1,
      ...(aoq ? {media: {transports: ['qwen_aoq_chat_v1']}} : {})}))
    assert.equal((JSON.parse(String((await ready)[0])) as Record<string, unknown>).type, 'client.ready')
    const closed = once(socket, 'close')
    const revoked = await request(port, '/client/pair-admin', {type: 'pair.revoke', token: master, device_id: device.device_id})
    assert.equal(revoked.type, 'pair.devices')
    assert.equal((await closed)[0], 4003)
    assert.equal(pairing.accepts(device.token), false)
  })
}

test('pairing endpoint validation is independent of host storage', () => {
  assert.equal(pairingEndpoint('wss://mac.example'), endpoint)
  for (const url of ['ws://mac.example', 'wss://user:pass@mac.example', 'wss://mac.example/?token=x', 'wss://mac.example/other']) {
    assert.throws(() => pairingEndpoint(url))
  }
})

test('Windows rejects pairing storage before creating a device file', {skip: process.platform !== 'win32'}, t => {
  const dir = mkdtempSync(join(tmpdir(), 'nova-pair-unsupported-'))
  t.after(() => rmSync(dir, {recursive: true, force: true}))
  const path = join(dir, 'devices.json')
  assert.throws(() => new ClientPairing(master, path), /requires POSIX/u)
  assert.equal(existsSync(path), false)
})
