import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import {
  backendLaunchSpec,
  parseReadiness,
  readReadiness,
} from '../src/main/backend.mjs'

test('passes token only through environment and reserves an inherited readiness pipe', () => {
  const token = 'b'.repeat(32)
  const spec = backendLaunchSpec({
    python: '/venv/bin/python',
    workspace: '/workspace',
    token,
    parentEnv: { PATH: '/usr/bin' },
  })

  assert.deepEqual(spec.argv, ['-m', 'nova_audio_agent.realtime.desktop'])
  assert.equal(spec.env.NOVA_AUDIO_AGENT_DESKTOP_TOKEN, token)
  assert.equal(spec.env.NOVA_AUDIO_AGENT_DESKTOP_READY_FD, '3')
  assert.equal(spec.env.NOVA_AUDIO_AGENT_CODEX_WORKSPACE, '/workspace')
  assert.deepEqual(spec.stdio, ['pipe', 'pipe', 'pipe', 'pipe'])
  assert.equal(JSON.stringify(spec.argv).includes(token), false)
})

test('readiness timeout rejects and invokes backend cleanup', async () => {
  const stream = new PassThrough()
  let cleanups = 0
  const guard = setTimeout(() => stream.end(), 100)

  await assert.rejects(
    readReadiness(stream, {
      timeoutMs: 5,
      onTimeout: () => { cleanups += 1 },
    }),
    /timed out/,
  )

  clearTimeout(guard)
  assert.equal(cleanups, 1)
})

test('readiness accepts one bounded loopback port and contains no token', () => {
  assert.deepEqual(parseReadiness('{"host":"127.0.0.1","port":49152}\n'), {
    endpoint: 'ws://127.0.0.1:49152/',
  })
  assert.throws(
    () => parseReadiness('{"host":"0.0.0.0","port":49152}\n'),
    /loopback/,
  )
  assert.throws(
    () => parseReadiness(`{"host":"127.0.0.1","port":1,"token":"${'x'.repeat(32)}"}\n`),
    /fields/,
  )
})
