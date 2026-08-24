import assert from 'node:assert/strict'
import { posix, win32 } from 'node:path'
import test from 'node:test'

import {
  productPaths,
  resolveDesktopConfig,
} from '../src/main/platform-config.mjs'

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

test('desktop configuration resolves settings before environment before defaults', () => {
  const canonicalized = []
  const resolved = resolveDesktopConfig({
    settings: {
      codexBinaryMode: 'manual',
      codexBinaryPath: 'C:\\Tools\\codex.cmd',
      codexProjectsEnabled: true,
      codexWorkspace: 'C:\\Work\\Nova',
      codexManagedRoot: '',
      modelBaseUrl: 'https://settings.example/v1',
      startListeningOnLaunch: true,
    },
    environment: {
      NOVA_AUDIO_AGENT_CODEX_BIN: 'C:\\Env\\codex.exe',
      NOVA_AUDIO_AGENT_CODEX_PROJECTS_ENABLED: 'false',
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
    codexBinaryPath: 'C:\\Tools\\codex.cmd',
    codexProjectsEnabled: true,
    modelBaseUrl: 'https://settings.example/v1',
    startListeningOnLaunch: true,
  })
  assert.deepEqual(canonicalized, [
    'C:\\Users\\nova\\.nova-audio-agent',
    'C:\\Users\\nova\\.nova-audio-agent\\state',
    'C:\\Env\\Managed',
    'C:\\Work\\Nova',
    'C:\\Tools\\codex.cmd',
  ])
})

test('empty desktop settings admit environment and hidden-root defaults', () => {
  const resolved = resolveDesktopConfig({
    settings: {},
    environment: {
      NOVA_AUDIO_AGENT_CODEX_PROJECTS_ENABLED: 'true',
    },
    home: '/home/nova',
    platform: 'linux',
    pathApi: posix,
    canonicalize: value => value,
  })

  assert.equal(resolved.codexBinaryMode, 'auto')
  assert.equal(resolved.codexBinaryPath, '')
  assert.equal(resolved.codexProjectsEnabled, true)
  assert.equal(resolved.managedRoot, '/home/nova/.nova-audio-agent/workspaces')
  assert.equal(resolved.workspace, '/home/nova/.nova-audio-agent/workspaces/default')
  assert.equal(resolved.startListeningOnLaunch, false)
})
