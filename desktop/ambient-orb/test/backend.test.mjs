import assert from 'node:assert/strict'
import net from 'node:net'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

import {
  backendLaunchSpec,
  createReadinessListener,
  parseReadiness,
} from '../src/main/backend.mjs'

const TOKEN = 'b'.repeat(32)

function readinessLine(overrides = {}) {
  return `${JSON.stringify({ token: TOKEN, host: '127.0.0.1', port: 49152, ...overrides })}\n`
}

// Dials the listener the way the backend does: one line, then close. Resolves
// with the socket outcome so a rejected handshake is observable in the test.
function dial(endpoint, payload) {
  const [host, rawPort] = endpoint.split(':')
  return new Promise(done => {
    const socket = net.connect({ host, port: Number(rawPort) }, () => {
      if (payload === undefined) socket.end()
      else socket.end(payload)
    })
    socket.once('error', error => done({ code: error.code }))
    socket.once('close', () => done({ closed: true }))
  })
}

// Same dial, but the client never closes: only the listener destroying the
// socket can settle this, so a missing socket.destroy() is observable.
function dialOpen(endpoint, payload) {
  const [host, rawPort] = endpoint.split(':')
  return new Promise(done => {
    const socket = net.connect({ host, port: Number(rawPort) }, () => socket.write(payload))
    const give = setTimeout(() => {
      socket.destroy()
      done({ open: true })
    }, 1000)
    const finish = outcome => {
      clearTimeout(give)
      done(outcome)
    }
    socket.once('error', error => finish({ code: error.code }))
    socket.once('close', () => finish({ closed: true }))
  })
}

function pending(promise, ms = 60) {
  return Promise.race([
    promise.then(() => 'settled', () => 'settled'),
    new Promise(done => setTimeout(() => done('pending'), ms)),
  ])
}

test('passes token only through environment and dials back over loopback', () => {
  const spec = backendLaunchSpec({
    python: '/venv/bin/python',
    workspace: '/workspace',
    token: TOKEN,
    readyEndpoint: '127.0.0.1:49152',
    parentEnv: { PATH: '/usr/bin' },
  })

  assert.deepEqual(spec.argv, ['-m', 'nova_audio_agent.realtime.desktop'])
  assert.equal(spec.env.NOVA_AUDIO_AGENT_DESKTOP_TOKEN, TOKEN)
  assert.equal(spec.env.NOVA_AUDIO_AGENT_DESKTOP_READY_ENDPOINT, '127.0.0.1:49152')
  assert.equal('NOVA_AUDIO_AGENT_DESKTOP_READY_FD' in spec.env, false)
  assert.equal(spec.env.NOVA_AUDIO_AGENT_CODEX_WORKSPACE, '/workspace')
  assert.deepEqual(spec.stdio, ['pipe', 'pipe', 'pipe'])
  assert.equal(spec.stdio.length, 3)
  assert.equal(JSON.stringify(spec.argv).includes(TOKEN), false)
})

test('launch spec strips a stale inherited readiness pipe', () => {
  const spec = backendLaunchSpec({
    python: '/venv/bin/python',
    workspace: '/workspace',
    token: TOKEN,
    readyEndpoint: '127.0.0.1:49152',
    parentEnv: { NOVA_AUDIO_AGENT_DESKTOP_READY_FD: '3' },
  })

  assert.equal('NOVA_AUDIO_AGENT_DESKTOP_READY_FD' in spec.env, false)
})

test('launch spec refuses any readiness endpoint that is not a loopback port', () => {
  const base = {
    python: '/venv/bin/python',
    workspace: '/workspace',
    token: TOKEN,
    parentEnv: {},
  }
  for (const readyEndpoint of [
    'localhost:49152',
    '0.0.0.0:49152',
    '127.0.0.1',
    '127.0.0.1:0',
    '127.0.0.1:70000',
    '127.0.0.1:49152 ',
    '',
  ]) {
    assert.throws(
      () => backendLaunchSpec({ ...base, readyEndpoint }),
      /readiness endpoint/,
      `expected ${JSON.stringify(readyEndpoint)} to be rejected`,
    )
  }
})

test('readiness accepts one bounded loopback port and matching token', () => {
  assert.deepEqual(parseReadiness(readinessLine(), TOKEN), {
    host: '127.0.0.1',
    port: 49152,
    endpoint: 'ws://127.0.0.1:49152/',
  })
  assert.throws(() => parseReadiness(readinessLine({ host: '0.0.0.0' }), TOKEN), /loopback/)
  assert.throws(() => parseReadiness(readinessLine({ host: 'localhost' }), TOKEN), /loopback/)
  assert.throws(() => parseReadiness(readinessLine({ port: 0 }), TOKEN), /port/)
  assert.throws(() => parseReadiness(readinessLine({ port: 70000 }), TOKEN), /port/)
  assert.throws(() => parseReadiness(readinessLine({ port: 1.5 }), TOKEN), /port/)
  assert.throws(() => parseReadiness('{"host":"127.0.0.1","port":49152}\n', TOKEN), /fields/)
  assert.throws(() => parseReadiness(readinessLine({ extra: 1 }), TOKEN), /fields/)
  assert.throws(() => parseReadiness(readinessLine({ token: 'a'.repeat(32) }), TOKEN), /token/)
  assert.throws(() => parseReadiness(readinessLine({ token: 'b'.repeat(31) }), TOKEN), /token/)
  assert.throws(() => parseReadiness(readinessLine({ token: 49152 }), TOKEN), /token/)
  assert.throws(() => parseReadiness(`${' '.repeat(5000)}\n`, TOKEN), /too large/)
  assert.throws(() => parseReadiness('not json\n', TOKEN), /invalid/)
})

test('readiness listener resolves the first authenticated loopback payload', async () => {
  const listener = createReadinessListener({ token: TOKEN })
  const endpoint = await listener.endpoint

  assert.match(endpoint, /^127\.0\.0\.1:\d+$/)
  await dial(endpoint, readinessLine({ port: 51515 }))

  assert.deepEqual(await listener.readiness, {
    host: '127.0.0.1',
    port: 51515,
    endpoint: 'ws://127.0.0.1:51515/',
  })
  listener.close()
})

test('readiness listener keeps waiting after a forged token', async () => {
  const listener = createReadinessListener({ token: TOKEN })
  const endpoint = await listener.endpoint

  const forged = await dialOpen(endpoint, readinessLine({ token: 'a'.repeat(32) }))
  assert.notEqual(forged.open, true, 'a forged token must be destroyed by the listener')
  assert.equal(await pending(listener.readiness), 'pending')

  await dial(endpoint, readinessLine({ port: 51516 }))
  assert.equal((await listener.readiness).port, 51516)
  listener.close()
})

test('readiness listener drops an oversized line and keeps waiting', async () => {
  const listener = createReadinessListener({ token: TOKEN })
  const endpoint = await listener.endpoint

  const flood = await dialOpen(endpoint, 'x'.repeat(8192))
  assert.notEqual(flood.open, true, 'an oversized line must be destroyed by the listener')
  assert.equal(await pending(listener.readiness), 'pending')

  await dial(endpoint, readinessLine({ port: 51517 }))
  assert.equal((await listener.readiness).port, 51517)
  listener.close()
})

test('readiness listener drops a malformed line and keeps waiting', async () => {
  const listener = createReadinessListener({ token: TOKEN })
  const endpoint = await listener.endpoint

  const malformed = await dialOpen(endpoint, '{"token":\n')
  assert.notEqual(malformed.open, true, 'a malformed line must be destroyed by the listener')
  assert.equal(await pending(listener.readiness), 'pending')

  await dial(endpoint, readinessLine({ port: 51518 }))
  assert.equal((await listener.readiness).port, 51518)
  listener.close()
})

test('readiness listener refuses later clients once a payload has landed', async () => {
  const listener = createReadinessListener({ token: TOKEN })
  const endpoint = await listener.endpoint

  await dial(endpoint, readinessLine({ port: 51519 }))
  await listener.readiness

  assert.equal((await dial(endpoint, readinessLine({ port: 51520 }))).code, 'ECONNREFUSED')
  listener.close()
})

test('readiness timeout rejects and invokes backend cleanup', async () => {
  let cleanups = 0
  const listener = createReadinessListener({
    token: TOKEN,
    timeoutMs: 5,
    onTimeout: () => { cleanups += 1 },
  })
  const endpoint = await listener.endpoint

  await assert.rejects(listener.readiness, /timed out/)
  assert.equal(cleanups, 1)
  assert.equal((await dial(endpoint, readinessLine())).code, 'ECONNREFUSED')
  listener.close()
})

test('closing the listener fails a handshake that can no longer arrive', async () => {
  const listener = createReadinessListener({ token: TOKEN })
  const endpoint = await listener.endpoint

  listener.close(new Error('desktop backend exited before readiness'))

  await assert.rejects(listener.readiness, /exited before readiness/)
  assert.equal((await dial(endpoint, readinessLine())).code, 'ECONNREFUSED')
})

test('closing the listener after success leaves the result untouched', async () => {
  const listener = createReadinessListener({ token: TOKEN })
  const endpoint = await listener.endpoint

  await dial(endpoint, readinessLine({ port: 51521 }))
  await listener.readiness
  listener.close()
  listener.close()

  assert.equal((await listener.readiness).port, 51521)
})

test('readiness listener rejects an invalid token or timeout up front', () => {
  assert.throws(() => createReadinessListener({ token: 'nope' }), /token/)
  assert.throws(() => createReadinessListener({ token: TOKEN, timeoutMs: 0 }), /timeout/)
  assert.throws(() => createReadinessListener({ token: TOKEN, timeoutMs: Number.NaN }), /timeout/)
})

test('a spawned backend reaches readiness through the launch spec environment', async () => {
  const listener = createReadinessListener({ token: TOKEN })
  const endpoint = await listener.endpoint
  const spec = backendLaunchSpec({
    python: process.execPath,
    workspace: process.cwd(),
    token: TOKEN,
    readyEndpoint: endpoint,
    parentEnv: process.env,
  })
  const script = `
    const net = require('node:net')
    const [host, port] = process.env.NOVA_AUDIO_AGENT_DESKTOP_READY_ENDPOINT.split(':')
    if (process.env.NOVA_AUDIO_AGENT_DESKTOP_READY_FD) throw new Error('fd 3 must be gone')
    const payload = JSON.stringify({
      token: process.env.NOVA_AUDIO_AGENT_DESKTOP_TOKEN,
      host: '127.0.0.1',
      port: 52525,
    })
    const socket = net.connect({ host, port: Number(port) }, () => socket.end(payload + '\\n'))
    socket.on('close', () => process.exit(0))
    socket.on('error', () => process.exit(1))
  `
  const child = spawn(spec.command, ['-e', script], { env: spec.env, stdio: spec.stdio })

  try {
    assert.deepEqual(await listener.readiness, {
      host: '127.0.0.1',
      port: 52525,
      endpoint: 'ws://127.0.0.1:52525/',
    })
    const [code] = await once(child, 'exit')
    assert.equal(code, 0)
  } finally {
    listener.close()
    if (child.exitCode === null) child.kill('SIGKILL')
  }
})
