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
  const paths = candidates.map(candidate => candidate.path)

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
    { path: '/one/codex', source: 'path' },
    { path: '/two/codex', source: 'path' },
    { path: '/home/nova/.local/bin/codex', source: 'common' },
  ])
})

test('discovery returns the first canonical executable with a bounded version', async () => {
  const inspected = []
  const status = await discoverCodex({
    candidates: [
      { path: '/missing/codex', source: 'path' },
      { path: '/installed/codex', source: 'common' },
    ],
    canonicalize: path => path === '/installed/codex' ? '/real/codex' : null,
    inspect: async path => {
      inspected.push(path)
      return { version: 'codex-cli 0.147.0' }
    },
  })

  assert.deepEqual(status, {
    status: 'ready',
    path: '/real/codex',
    source: 'common',
    version: 'codex-cli 0.147.0',
  })
  assert.deepEqual(inspected, ['/real/codex'])
})

test('discovery rejects malformed probes without exposing their content', async () => {
  const missing = await discoverCodex({
    candidates: [{ path: '/private/codex', source: 'manual' }],
    canonicalize: () => '/private/codex',
    inspect: async () => ({ version: 'x'.repeat(129), private: 'secret' }),
  })

  assert.deepEqual(missing, { status: 'missing', path: null, source: null, version: null })
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
    automaticCandidates: [{ path: '/automatic/codex', source: 'path' }],
    canonicalize: path => path,
    inspect: async path => {
      inspected.push(path)
      return { version: 'private malformed\nversion' }
    },
  })

  assert.deepEqual(inspected, ['/manual/codex'])
  assert.equal(result.config.codexBinaryPath, '')
  assert.equal(result.config.workspace, '/workspace')
  assert.deepEqual(result.status, {
    status: 'missing', path: null, source: null, version: null,
  })
})
