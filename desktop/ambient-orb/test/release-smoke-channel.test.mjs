import assert from 'node:assert/strict'
import {PassThrough} from 'node:stream'
import test from 'node:test'

import {
  RELEASE_SMOKE_MODE,
  createReleaseSmokeChannel,
} from '../src/main/release-smoke-channel.mjs'

const TOKEN = '0123456789abcdef0123456789abcdef'

test('release smoke control is packaged-only and inert during ordinary source launches', () => {
  let opened = 0
  for (const input of [
    {environment: {}, isPackaged: true},
    {environment: {NOVA_AUDIO_AGENT_RELEASE_SMOKE: RELEASE_SMOKE_MODE}, isPackaged: false},
  ]) {
    assert.equal(createReleaseSmokeChannel({
      ...input,
      openOutput: () => { opened += 1 },
      openInput: () => { opened += 1 },
      onQuit: () => assert.fail('quit must stay disabled'),
    }), null)
  }
  assert.equal(opened, 0)
})

test('release smoke channel privately reports readiness and accepts only one exact quit command', async () => {
  const output = new PassThrough()
  const input = new PassThrough()
  let written = ''
  let quits = 0
  output.on('data', chunk => { written += chunk.toString('utf8') })
  const channel = createReleaseSmokeChannel({
    environment: {NOVA_AUDIO_AGENT_RELEASE_SMOKE: RELEASE_SMOKE_MODE},
    isPackaged: true,
    openOutput: () => output,
    openInput: () => input,
    onQuit: () => { quits += 1 },
  })
  assert.ok(channel)
  channel.ready({endpoint: 'ws://127.0.0.1:49152/', token: TOKEN})
  assert.equal(written, `{"type":"ready","endpoint":"ws://127.0.0.1:49152/","token":"${TOKEN}"}\n`)

  input.write('quit\n')
  await new Promise(resolve => setImmediate(resolve))
  input.write('quit\n')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(quits, 1)
  channel.close()
})

test('release smoke channel refuses malformed control and readiness without leaking input', async () => {
  const output = new PassThrough()
  const input = new PassThrough()
  let quits = 0
  const channel = createReleaseSmokeChannel({
    environment: {NOVA_AUDIO_AGENT_RELEASE_SMOKE: RELEASE_SMOKE_MODE},
    isPackaged: true,
    openOutput: () => output,
    openInput: () => input,
    onQuit: () => { quits += 1 },
  })
  assert.throws(
    () => channel.ready({endpoint: 'ws://private.invalid/', token: TOKEN}),
    /release_smoke_invalid/u,
  )
  input.write('private malformed command that is too long\n')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(quits, 0)
  channel.close()
})
