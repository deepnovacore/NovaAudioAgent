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
  }
  return {
    root,
    creates,
    protects,
    closes,
    nativeHost,
    openDirectory: async target => ({
      fd: fds.get(target),
      close: async () => { closes.push(target) },
    }),
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
    openDirectory: value.openDirectory,
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
    [2, 'workspaces', 4],
    [4, 'default', 5],
  ])
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
    pathApi: path.win32, openDirectory: value.openDirectory,
  }), {status: 'ok', code: null})
  assert.deepEqual(value.protects, [[2, 'state', 3]])
  assert.deepEqual(await repairProjectDirectory({
    root: 'C:\\attacker', config, nativeHost: value.nativeHost,
    pathApi: path.win32, openDirectory: value.openDirectory,
  }), {status: 'failed', code: 'invalid_target'})
})
