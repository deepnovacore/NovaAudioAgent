import assert from 'node:assert/strict'
import { posix, win32 } from 'node:path'
import test from 'node:test'

import * as codexDiscovery from '../src/main/codex-discovery.mjs'

const { codexCandidates, discoverCodex } = codexDiscovery

test('Windows candidates include PATH executables and npm native package layouts', () => {
  const candidates = codexCandidates({
    platform: 'win32',
    arch: 'x64',
    env: {
      APPDATA: 'C:\\Users\\nova\\AppData\\Roaming',
      PATH: 'C:\\CodexApp;C:\\Tools',
    },
    home: 'C:\\Users\\nova',
    pathApi: win32,
  })
  const paths = candidates.filter(candidate => candidate.kind === 'native')
    .map(candidate => candidate.command)

  assert.deepEqual(paths.slice(0, 4), [
    'C:\\CodexApp\\codex.exe',
    'C:\\CodexApp\\codex',
    'C:\\Tools\\codex.exe',
    'C:\\Tools\\codex',
  ])
  assert.ok(paths.includes(
    'C:\\Users\\nova\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe',
  ))
  assert.ok(paths.includes(
    'C:\\Users\\nova\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe',
  ))
  assert.equal(paths.some(path => path.endsWith('codex.cmd')), false)
  assert.ok(candidates.some(candidate => candidate.kind === 'npm-launcher'
    && candidate.launcherPath.endsWith('codex.cmd')
    && candidate.command.endsWith('node.exe')
    && candidate.prefixArgs[0].endsWith('bin\\codex.js')))
})

test('POSIX candidates preserve PATH order before reviewed common locations', () => {
  const candidates = codexCandidates({
    platform: 'linux',
    arch: 'x64',
    env: { PATH: '/one:/two' },
    home: '/home/nova',
    pathApi: posix,
  })

  assert.deepEqual(candidates.slice(0, 3), [
    { kind: 'native', command: '/one/codex', prefixArgs: [], source: 'path' },
    { kind: 'native', command: '/two/codex', prefixArgs: [], source: 'path' },
    { kind: 'native', command: '/home/nova/.local/bin/codex', prefixArgs: [], source: 'common' },
  ])
})

test('macOS candidates include the npm native binary without relying on GUI PATH', () => {
  const candidates = codexCandidates({
    platform: 'darwin',
    arch: 'arm64',
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    home: '/Users/nova',
    pathApi: posix,
  })

  assert.ok(candidates.some(candidate => candidate.kind === 'native'
    && candidate.source === 'common'
    && candidate.command === '/opt/homebrew/bin/codex'))
  assert.ok(candidates.some(candidate => candidate.kind === 'native'
    && candidate.source === 'npm-user'
    && candidate.command === '/Users/nova/.npm-global/bin/codex'))
})

test('Windows candidates include the npm native binary without relying on GUI PATH', () => {
  const candidates = codexCandidates({
    platform: 'win32',
    arch: 'x64',
    env: { APPDATA: 'C:\\Users\\nova\\AppData\\Roaming', PATH: '' },
    home: 'C:\\Users\\nova',
    pathApi: win32,
  })

  assert.ok(candidates.some(candidate => candidate.kind === 'native'
    && candidate.source === 'npm-user'
    && candidate.command === 'C:\\Users\\nova\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe'))
})

test('GUI discovery executes the direct npm native binary on macOS and Windows', async () => {
  const cases = [
    {
      platform: 'darwin',
      arch: 'arm64',
      env: {PATH: '/usr/bin:/bin:/usr/sbin:/sbin'},
      home: '/Users/nova',
      pathApi: posix,
      expected: '/opt/homebrew/bin/codex',
    },
    {
      platform: 'win32',
      arch: 'x64',
      env: {APPDATA: 'C:\\Users\\nova\\AppData\\Roaming', PATH: 'C:\\Windows\\System32'},
      home: 'C:\\Users\\nova',
      pathApi: win32,
      expected: 'C:\\Users\\nova\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe',
    },
  ]

  for (const fixture of cases) {
    const status = await discoverCodex({
      candidates: codexCandidates(fixture),
      canonicalize: candidate => candidate.command === fixture.expected
        ? {command: candidate.command, prefixArgs: []}
        : null,
      inspect: async () => ({version: 'codex-cli 0.152.0'}),
    })
    assert.equal(status.status, 'ready')
    assert.equal(status.path, fixture.expected)
    assert.deepEqual(status.prefixArgs, [])
  }
})

test('discovery returns the first canonical executable with a bounded version', async () => {
  const inspected = []
  const status = await discoverCodex({
    candidates: [
      { kind: 'native', command: '/missing/codex', prefixArgs: [], source: 'path' },
      { kind: 'native', command: '/installed/codex', prefixArgs: [], source: 'common' },
    ],
    canonicalize: candidate => candidate.command === '/installed/codex'
      ? {command: '/real/codex', prefixArgs: []} : null,
    inspect: async invocation => {
      inspected.push(invocation)
      return { version: 'codex-cli 0.147.0' }
    },
  })

  assert.deepEqual(status, {
    status: 'ready',
    invocation: {command: '/real/codex', prefixArgs: []},
    path: '/real/codex',
    prefixArgs: [],
    source: 'common',
    version: 'codex-cli 0.147.0',
  })
  assert.deepEqual(inspected, [{command: '/real/codex', prefixArgs: []}])
})

test('discovery rejects malformed probes without exposing their content', async () => {
  const missing = await discoverCodex({
    candidates: [{ kind: 'native', command: '/private/codex', prefixArgs: [], source: 'manual' }],
    canonicalize: () => ({command: '/private/codex', prefixArgs: []}),
    inspect: async () => ({ version: 'x'.repeat(129), private: 'secret' }),
  })

  assert.deepEqual(missing, {
    status: 'missing', invocation: null, path: null, prefixArgs: null,
    source: null, version: null,
  })
  assert.doesNotMatch(JSON.stringify(missing), /private|secret/)
})

test('desktop Codex resolution probes only the manual override and clears an invalid path', async () => {
  const inspected = []
  const result = await codexDiscovery.resolveDesktopCodex({
    config: {
      codexBinaryMode: 'manual',
      codexBinaryPath: '/manual/codex',
      workspace: '/workspace',
    },
    automaticCandidates: [{ kind: 'native', command: '/automatic/codex', prefixArgs: [], source: 'path' }],
    canonicalize: candidate => ({command: candidate.command, prefixArgs: []}),
    inspect: async invocation => {
      inspected.push(invocation)
      return { version: 'private malformed\nversion' }
    },
  })

  assert.deepEqual(inspected, [{command: '/manual/codex', prefixArgs: []}])
  assert.equal(result.config.codexBinaryPath, '')
  assert.equal(result.config.workspace, '/workspace')
  assert.deepEqual(result.status, {
    status: 'missing', invocation: null, path: null, prefixArgs: null,
    source: null, version: null,
  })
})
