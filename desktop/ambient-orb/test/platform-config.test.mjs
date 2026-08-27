import assert from 'node:assert/strict'
import { posix, win32 } from 'node:path'
import test from 'node:test'

import * as platformConfig from '../src/main/platform-config.mjs'

const { productPaths, resolveDesktopConfig } = platformConfig

test('product paths use the hidden Nova root on Windows and POSIX', () => {
  assert.deepEqual(productPaths({ home: 'C:\\Users\\nova', pathApi: win32 }), {
    root: 'C:\\Users\\nova\\.nova-audio-agent',
    stateRoot: 'C:\\Users\\nova\\.nova-audio-agent\\state',
    managedRoot: 'C:\\Users\\nova\\.nova-audio-agent\\workspaces',
    defaultWorkspace: 'C:\\Users\\nova\\.nova-audio-agent\\workspaces\\default',
  })
  assert.deepEqual(productPaths({ home: '/home/nova', pathApi: posix }), {
    root: '/home/nova/.nova-audio-agent',
    stateRoot: '/home/nova/.nova-audio-agent/state',
    managedRoot: '/home/nova/.nova-audio-agent/workspaces',
    defaultWorkspace: '/home/nova/.nova-audio-agent/workspaces/default',
  })
})

test('desktop configuration lets the explicit process binary override saved discovery settings', () => {
  const canonicalized = []
  const resolved = resolveDesktopConfig({
    settings: {
      codexBinaryMode: 'manual',
      codexBinaryPath: 'C:\\Tools\\codex.exe',
      codexWorkspace: 'C:\\Work\\Nova',
      codexManagedRoot: '',
      modelBaseUrl: 'https://settings.example/v1',
      startListeningOnLaunch: true,
    },
    environment: {
      NOVA_AUDIO_AGENT_CODEX_BIN: 'C:\\Env\\codex.exe',
      NOVA_AUDIO_AGENT_CODEX_WORKSPACE: 'C:\\Env\\Workspace',
      NOVA_AUDIO_AGENT_CODEX_MANAGED_ROOT: 'C:\\Env\\Managed',
      NOVA_AUDIO_AGENT_MODEL_BASE_URL: 'https://env.example/v1',
    },
    home: 'C:\\Users\\nova',
    platform: 'win32',
    pathApi: win32,
    canonicalize: value => {
      canonicalized.push(value)
      return win32.normalize(value)
    },
  })

  assert.deepEqual(resolved, {
    root: 'C:\\Users\\nova\\.nova-audio-agent',
    stateRoot: 'C:\\Users\\nova\\.nova-audio-agent\\state',
    managedRoot: 'C:\\Env\\Managed',
    workspace: 'C:\\Work\\Nova',
    codexBinaryMode: 'manual',
    codexBinaryPath: 'C:\\Env\\codex.exe',
    codexConfigurationError: null,
    modelBaseUrl: 'https://settings.example/v1',
    modelConfigurationError: null,
    startListeningOnLaunch: true,
  })
  assert.deepEqual(canonicalized, [
    'C:\\Users\\nova\\.nova-audio-agent',
    'C:\\Users\\nova\\.nova-audio-agent\\state',
    'C:\\Env\\Managed',
    'C:\\Work\\Nova',
    'C:\\Env\\codex.exe',
  ])
})

test('empty desktop settings admit environment and hidden-root defaults', () => {
  const resolved = resolveDesktopConfig({
    settings: {},
    environment: {},
    home: '/home/nova',
    platform: 'linux',
    pathApi: posix,
    canonicalize: value => value,
  })

  assert.equal(resolved.codexBinaryMode, 'auto')
  assert.equal(resolved.codexBinaryPath, '')
  assert.equal(resolved.codexConfigurationError, null)
  assert.equal(Object.hasOwn(resolved, 'codexProjectsEnabled'), false)
  assert.equal(resolved.managedRoot, '/home/nova/.nova-audio-agent/workspaces')
  assert.equal(resolved.workspace, '/home/nova/.nova-audio-agent/workspaces/default')
  assert.equal(resolved.startListeningOnLaunch, false)
})

test('an environment Codex binary remains effective after settings normalization saves auto mode', () => {
  const resolved = resolveDesktopConfig({
    settings: {codexBinaryMode: 'auto', codexBinaryPath: 'C:\\Stale\\codex.exe'},
    environment: {NOVA_AUDIO_AGENT_CODEX_BIN: 'C:\\Env\\codex.exe'},
    home: 'C:\\Users\\nova', platform: 'win32', pathApi: win32,
    canonicalize: value => value,
  })
  assert.equal(resolved.codexBinaryMode, 'manual')
  assert.equal(resolved.codexBinaryPath, 'C:\\Env\\codex.exe')
  assert.equal(resolved.codexConfigurationError, null)
})

test('an environment Codex binary fills a saved empty manual path', () => {
  const resolved = resolveDesktopConfig({
    settings: {codexBinaryMode: 'manual', codexBinaryPath: ''},
    environment: {NOVA_AUDIO_AGENT_CODEX_BIN: 'C:\\Env\\codex.exe'},
    home: 'C:\\Users\\nova', platform: 'win32', pathApi: win32,
    canonicalize: value => value,
  })
  assert.equal(resolved.codexBinaryMode, 'manual')
  assert.equal(resolved.codexBinaryPath, 'C:\\Env\\codex.exe')
  assert.equal(resolved.codexConfigurationError, null)
})

test('environment model URL uses the same safety validator as Settings', () => {
  const invalid = resolveDesktopConfig({
    settings: {}, environment: {NOVA_AUDIO_AGENT_MODEL_BASE_URL: 'http://models.example/v1'},
    home: '/home/nova', platform: 'linux', pathApi: posix, canonicalize: value => value,
  })
  assert.equal(invalid.modelBaseUrl, '')
  assert.equal(invalid.modelConfigurationError, 'model_base_url_invalid')
  const loopback = resolveDesktopConfig({
    settings: {}, environment: {NOVA_AUDIO_AGENT_MODEL_BASE_URL: 'http://127.0.0.1:8080/v1'},
    home: '/home/nova', platform: 'linux', pathApi: posix, canonicalize: value => value,
  })
  assert.equal(loopback.modelBaseUrl, 'http://127.0.0.1:8080/v1')
  assert.equal(loopback.modelConfigurationError, null)
})

test('startup creates every application-owned default directory before spawn', async () => {
  const created = []
  const config = resolveDesktopConfig({
    settings: {},
    environment: {},
    home: '/home/nova',
    platform: 'linux',
    pathApi: posix,
    canonicalize: value => value,
  })

  const result = await platformConfig.ensureProductDirectories(config, {
    mkdir: async (path, options) => created.push({ path, options }),
    pathApi: posix,
  })

  assert.equal(result, config)
  assert.deepEqual(created, [
    { path: '/home/nova/.nova-audio-agent', options: { recursive: true, mode: 0o700 } },
    { path: '/home/nova/.nova-audio-agent/state', options: { recursive: true, mode: 0o700 } },
    { path: '/home/nova/.nova-audio-agent/workspaces', options: { recursive: true, mode: 0o700 } },
    { path: '/home/nova/.nova-audio-agent/workspaces/default', options: { recursive: true, mode: 0o700 } },
  ])
})
