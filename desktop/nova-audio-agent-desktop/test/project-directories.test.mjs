import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import {
  ensurePrivateProjectDirectories,
  repairProjectDirectory,
} from '../src/main/project-directories.mjs'

function fixture() {
  const root = 'C:\\Users\\nova\\.nova-audio-agent'
  const fds = new Map([
    ['C:\\Users\\nova', 1],
    [root, 2],
    [`${root}\\state`, 3],
    [`${root}\\workspaces`, 4],
    [`${root}\\workspaces\\default`, 5],
  ])
  const closes = []
  const creates = []
  const protects = []
  const managedPrepares = []
  const nativeHost = {
    mkdirPrivateAt(rootFd, name) {
      creates.push(['bootstrap', rootFd, name])
      return {status: 'ok'}
    },
    rootFiles: {
      mkdirAt(rootFd, name) {
        creates.push(['child', rootFd, name])
        return {status: 'ok'}
      },
    },
    protectDirectoryAt(rootFd, name, childFd) {
      protects.push([rootFd, name, childFd])
      return true
    },
    prepareManagedDirectoryAt(rootFd, name, childFd) {
      managedPrepares.push([rootFd, name, childFd])
      return true
    },
    directoryHandles: {
      open: target => ({
        fd: fds.get(target),
        close: () => { closes.push(target) },
      }),
    },
  }
  return {
    root,
    creates,
    protects,
    managedPrepares,
    closes,
    nativeHost,
  }
}

test('Windows creates and verifies every default directory descriptor-relatively', async () => {
  const value = fixture()
  const config = {
    root: value.root,
    stateRoot: `${value.root}\\state`,
    managedRoot: `${value.root}\\workspaces`,
    workspace: `${value.root}\\workspaces\\default`,
  }
  await ensurePrivateProjectDirectories({
    config,
    home: 'C:\\Users\\nova',
    platform: 'win32',
    nativeHost: value.nativeHost,
    pathApi: path.win32,
    mkdir: async () => { throw new Error('path mkdir must not create defaults') },
  })
  assert.deepEqual(value.creates, [
    ['bootstrap', 1, '.nova-audio-agent'],
    ['child', 2, 'state'],
    ['child', 2, 'workspaces'],
    ['child', 4, 'default'],
  ])
  assert.deepEqual(value.protects, [
    [1, '.nova-audio-agent', 2],
    [2, 'state', 3],
    [4, 'default', 5],
  ])
  assert.deepEqual(value.managedPrepares, [[2, 'workspaces', 4]])
})

test('Windows reuses the protected product root when it is also the state root', async () => {
  const value = fixture()
  const config = {
    root: value.root,
    stateRoot: value.root,
    managedRoot: `${value.root}\\workspaces`,
    workspace: `${value.root}\\workspaces\\default`,
  }
  await ensurePrivateProjectDirectories({
    config,
    home: 'C:\\Users\\nova',
    platform: 'win32',
    nativeHost: value.nativeHost,
    pathApi: path.win32,
    mkdir: async () => { throw new Error('path mkdir must not create defaults') },
  })
  assert.deepEqual(value.creates, [
    ['bootstrap', 1, '.nova-audio-agent'],
    ['child', 2, 'workspaces'],
    ['child', 4, 'default'],
  ])
  assert.deepEqual(value.protects, [
    [1, '.nova-audio-agent', 2],
    [4, 'default', 5],
  ])
  assert.deepEqual(value.managedPrepares, [[2, 'workspaces', 4]])
})

test('repair selects a configured root enum and never consumes a renderer path', async () => {
  const value = fixture()
  const config = {
    stateRoot: `${value.root}\\state`,
    managedRoot: `${value.root}\\workspaces`,
    workspace: `${value.root}\\workspaces\\default`,
  }
  assert.deepEqual(await repairProjectDirectory({
    root: 'state', config, nativeHost: value.nativeHost,
    pathApi: path.win32,
  }), {status: 'ok', code: null})
  assert.deepEqual(value.protects, [[2, 'state', 3]])
  assert.deepEqual(await repairProjectDirectory({
    root: 'managed', config, nativeHost: value.nativeHost,
    pathApi: path.win32,
  }), {status: 'ok', code: null})
  assert.deepEqual(value.managedPrepares, [[2, 'workspaces', 4]])
  assert.deepEqual(await repairProjectDirectory({
    root: 'C:\\attacker', config, nativeHost: value.nativeHost,
    pathApi: path.win32,
  }), {status: 'failed', code: 'invalid_target'})
})

test('Windows directory bootstrap identifies the failed stage without disclosing its path', async () => {
  const value = fixture()
  const config = {
    root: value.root,
    stateRoot: `${value.root}\\state`,
    managedRoot: `${value.root}\\workspaces`,
    workspace: `${value.root}\\workspaces\\default`,
  }
  const originalOpen = value.nativeHost.directoryHandles.open
  value.nativeHost.directoryHandles.open = target => {
    if (target === value.root) throw new Error('private native detail')
    return originalOpen(target)
  }
  await assert.rejects(
    ensurePrivateProjectDirectories({
      config,
      home: 'C:\\Users\\nova',
      platform: 'win32',
      nativeHost: value.nativeHost,
      pathApi: path.win32,
      mkdir: async () => undefined,
    }),
    error => error?.message === 'project_directory_open_failed_root',
  )
})
