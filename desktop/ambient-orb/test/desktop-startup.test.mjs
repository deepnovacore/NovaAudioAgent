import assert from 'node:assert/strict'
import { posix } from 'node:path'
import test from 'node:test'

import * as desktopStartup from '../src/main/desktop-startup.mjs'

test('desktop startup creates defaults then resolves an installed Codex candidate', async () => {
  const events = []
  const result = await desktopStartup.prepareDesktopStartup({
    settings: {},
    environment: { PATH: '/opt/codex/bin' },
    home: '/home/nova',
    platform: 'linux',
    arch: 'x64',
    pathApi: posix,
    canonicalizePath: value => value,
    canonicalizeExecutable: value => value === '/opt/codex/bin/codex' ? value : null,
    mkdir: async path => { events.push(`mkdir:${path}`) },
    inspectCodex: async path => {
      events.push(`inspect:${path}`)
      return { version: 'codex-cli 0.147.0' }
    },
  })

  assert.equal(result.config.workspace, '/home/nova/.nova-audio-agent/workspaces/default')
  assert.equal(result.config.codexBinaryPath, '/opt/codex/bin/codex')
  assert.deepEqual(result.codexStatus, {
    status: 'ready',
    path: '/opt/codex/bin/codex',
    source: 'path',
    version: 'codex-cli 0.147.0',
  })
  assert.deepEqual(events, [
    'mkdir:/home/nova/.nova-audio-agent',
    'mkdir:/home/nova/.nova-audio-agent/state',
    'mkdir:/home/nova/.nova-audio-agent/workspaces',
    'mkdir:/home/nova/.nova-audio-agent/workspaces/default',
    'inspect:/opt/codex/bin/codex',
  ])
})

test('Codex version inspection uses a bounded credential-free child environment', () => {
  let invocation
  const result = desktopStartup.inspectCodexVersion('/opt/codex', {
    environment: {
      PATH: '/usr/bin',
      HOME: '/home/nova',
      DASHSCOPE_API_KEY: 'secret',
      OPENAI_API_KEY: 'secret',
    },
    run: (command, args, options) => {
      invocation = { command, args, options }
      return { status: 0, stdout: 'codex-cli 0.147.0\n' }
    },
  })

  assert.deepEqual(result, { version: 'codex-cli 0.147.0' })
  assert.equal(invocation.command, '/opt/codex')
  assert.deepEqual(invocation.args, ['--version'])
  assert.equal(invocation.options.timeout, 5_000)
  assert.equal(invocation.options.maxBuffer, 1_024)
  assert.deepEqual(invocation.options.env, { PATH: '/usr/bin', HOME: '/home/nova' })
})

test('canonical executable validation rejects Windows script shims', () => {
  const dependencies = {
    platform: 'win32',
    realpath: value => `C:\\Real\\${value.split('\\').at(-1)}`,
    stat: () => ({ isFile: () => true }),
    access: () => {},
  }

  assert.equal(
    desktopStartup.canonicalInstalledExecutable('C:\\Bin\\codex.exe', dependencies),
    'C:\\Real\\codex.exe',
  )
  assert.equal(
    desktopStartup.canonicalInstalledExecutable('C:\\Bin\\codex.cmd', dependencies),
    null,
  )
})
