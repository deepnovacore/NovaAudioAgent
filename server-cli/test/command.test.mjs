import assert from 'node:assert/strict'
import {test} from 'node:test'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {main} from '../src/command.mjs'

test('help and malformed arguments never load the runtime', async () => {
  for (const [args, code] of [[['--help'], 0], [['bad'], 2], [['start', 'extra'], 2], [['pair'], 2], [['--env-file'], 2]]) {
    const lines = []
    assert.equal(await main(args, {write: text => lines.push(text), load: () => assert.fail('runtime loaded')}), code)
    assert.match(lines.join(''), /Usage:/)
  }
})

test('server commands reuse runtime entry, credentials and terminal pairing', async () => {
  const calls = []
  const modules = {
    entry: {runServerEntry: async () => {calls.push('start'); return 0}},
    config: {initializeServerToken: path => calls.push(['token', path]), loadServerConfig: () => ({port: 19876, token: 'private'})},
    pair: {terminalPair: async config => calls.push(['pair', config])},
  }
  const options = {environment: {SERVER_TOKEN_FILE: '/tmp/private-token'}, write: () => {}, load: async name => modules[name]}
  assert.equal(await main(['start'], options), 0)
  assert.equal(await main(['token-init'], options), 0)
  assert.equal(await main(['pair', 'wss://example.test'], options), 0)
  assert.deepEqual(calls, ['start', ['token', '/tmp/private-token'], ['pair', {port: 19876, token: 'private', server: 'wss://example.test'}]])
})

test('env file is loaded before runtime composition', async () => {
  const events = []
  assert.equal(await main(['--env-file', '/tmp/server.env', 'start'], {
    environment: {},
    loadEnvFile: path => events.push(path),
    load: async () => ({runServerEntry: async () => {events.push('start'); return 2}}),
  }), 2)
  assert.deepEqual(events, ['/tmp/server.env', 'start'])
})

test('CLI failures do not expose private file paths', () => {
  const privatePath = fileURLToPath(new URL('..', import.meta.url))
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/novaaudio-server.mjs', import.meta.url)), 'start'], {encoding: 'utf8'})
  assert.equal(result.status, 2)
  assert.match(result.stderr, /runtime-diagnostic.*command_failed/u)
  assert.ok(!result.stderr.includes(privatePath))
})
