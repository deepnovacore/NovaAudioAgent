'use strict'

const assert = require('node:assert/strict')
const {closeSync, mkdtempSync, openSync, rmSync} = require('node:fs')
const {tmpdir} = require('node:os')
const {join} = require('node:path')
const {spawn} = require('node:child_process')

const addonPath = process.argv[2]
if (addonPath === undefined) process.exit(0)
const mode = process.argv[3] ?? 'driver'
const lockPath = process.argv[4]
const addon = require(addonPath)

assert.equal(process.versions.electron, '43.2.0')
assert.equal(process.versions.modules, '148')

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function openDirectory(path) {
  return openSync(path, process.platform === 'darwin' ? 0x100000 : 0)
}

if (mode === 'hold') {
  const descriptor = openSync(lockPath, 'r+')
  const held = addon.acquire(descriptor)
  assert.equal(held.status, 'acquired')
  closeSync(descriptor)
  process.stdout.write('locked\n')
  setInterval(() => {}, 1_000)
} else {
  void (async () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-project-native-behavior-'))
    const rootDescriptor = openDirectory(root)
    let lockChild = null
    try {
      assert.deepEqual(addon.probe(rootDescriptor), {status: 'ok'})
      assert.deepEqual(addon.lookupAt(rootDescriptor, '../escape'), {status: 'failed'})
      assert.deepEqual(addon.createFileAt(rootDescriptor, '/absolute', true), {status: 'failed'})

      const created = addon.createFileAt(rootDescriptor, 'state.tmp', true)
      assert.equal(created.status, 'ok')
      assert.equal(typeof created.identity.device, 'bigint')
      assert.equal(typeof created.identity.inode, 'bigint')
      assert.deepEqual(addon.createFileAt(rootDescriptor, 'state.tmp', true), {status: 'exists'})
      assert.deepEqual(addon.lookupAt(rootDescriptor, 'missing'), {status: 'missing'})

      const childDescriptor = openSync(join(root, 'state.tmp'), 'r+')
      try {
        assert.deepEqual(addon.matchesAt(rootDescriptor, 'state.tmp', childDescriptor), {status: 'ok'})
        assert.deepEqual(addon.renameAt(rootDescriptor, 'state.tmp', 'state.json'), {status: 'ok'})
        assert.deepEqual(
          addon.unlinkAt(rootDescriptor, 'state.json', {device: 0n, inode: 0n}, 'file'),
          {status: 'mismatch'},
        )
        assert.deepEqual(
          addon.unlinkAt(rootDescriptor, 'state.json', created.identity, 'file'),
          {status: 'ok'},
        )
      } finally {
        closeSync(childDescriptor)
      }

      const directory = addon.mkdirAt(rootDescriptor, 'workspace-01')
      assert.equal(directory.status, 'ok')
      assert.deepEqual(
        addon.unlinkAt(rootDescriptor, 'workspace-01', directory.identity, 'directory'),
        {status: 'ok'},
      )

      const lock = addon.createFileAt(rootDescriptor, 'owner.lock', true)
      assert.equal(lock.status, 'ok')
      const lockFile = join(root, 'owner.lock')
      const child = spawn(process.execPath, [__filename, addonPath, 'hold', lockFile], {
        env: {...process.env, ELECTRON_RUN_AS_NODE: '1'},
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      lockChild = child
      let output = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => { output += chunk })
      const deadline = Date.now() + 5_000
      while (!output.includes('locked') && Date.now() < deadline) await delay(10)
      assert.match(output, /locked/)

      const contender = openSync(lockFile, 'r+')
      assert.deepEqual(addon.acquire(contender), {status: 'busy'})
      child.kill('SIGKILL')
      await new Promise(resolve => child.once('exit', resolve))
      lockChild = null
      let acquired = addon.acquire(contender)
      for (let attempt = 0; acquired.status === 'busy' && attempt < 100; attempt += 1) {
        await delay(10)
        acquired = addon.acquire(contender)
      }
      assert.equal(acquired.status, 'acquired')
      closeSync(contender)

      const second = openSync(lockFile, 'r+')
      assert.deepEqual(addon.acquire(second), {status: 'busy'})
      acquired.release()
      const released = addon.acquire(second)
      assert.equal(released.status, 'acquired')
      released.release()
      closeSync(second)
      assert.deepEqual(addon.unlinkAt(rootDescriptor, 'owner.lock', lock.identity, 'file'), {status: 'ok'})
    } finally {
      if (lockChild !== null && lockChild.exitCode === null) {
        lockChild.kill('SIGKILL')
        await Promise.race([
          new Promise(resolve => lockChild.once('exit', resolve)),
          delay(1_000),
        ])
      }
      closeSync(rootDescriptor)
      rmSync(root, {recursive: true, force: true})
    }
    process.stdout.write('project native behavior passed\n')
  })().catch(error => {
    process.stderr.write(`${error.stack ?? error}\n`)
    process.exitCode = 1
  })
}
