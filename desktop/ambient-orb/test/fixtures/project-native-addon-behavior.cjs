'use strict'

const assert = require('node:assert/strict')
const {closeSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync} = require('node:fs')
const {homedir} = require('node:os')
const {join} = require('node:path')
const {spawn, spawnSync} = require('node:child_process')

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

function openNativeDirectory(path) {
  const opened = addon.openDirectory(path)
  assert.equal(opened.status, 'ok', JSON.stringify(opened))
  assert.equal(Number.isInteger(opened.descriptor), true)
  assert.equal(opened.descriptor >= 0, true)
  assert.equal(typeof opened.close, 'function')
  return opened
}

function assertNativeDirectoryRejected(path) {
  const opened = addon.openDirectory(path)
  if (opened.status === 'ok') opened.close()
  assert.deepEqual(opened.status, 'failed')
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
    const homeHandle = openNativeDirectory(homedir())
    assert.equal(homeHandle.close(), undefined)
    assert.equal(homeHandle.close(), undefined)
    if (process.platform === 'win32' && process.env.SystemRoot) {
      assertNativeDirectoryRejected(process.env.SystemRoot)
    }

    const container = mkdtempSync(join(process.cwd(), 'build', 'nova-project-native-behavior-'))
    const root = join(container, 'root')
    mkdirSync(root)
    const containerHandle = openNativeDirectory(container)
    const rootHandle = openNativeDirectory(root)
    const containerDescriptor = containerHandle.descriptor
    const rootDescriptor = rootHandle.descriptor
    let lockChild = null
    try {
      const bootstrapDirectory = addon.mkdirPrivateAt(rootDescriptor, 'bootstrap-root')
      assert.equal(bootstrapDirectory.status, 'ok')
      assert.equal(addon.protectDirectory, undefined)
      assert.deepEqual(addon.protectAt(containerDescriptor, 'root', rootDescriptor), {status: 'ok'})
      assert.deepEqual(addon.probe(rootDescriptor), {status: 'ok'})
      assert.deepEqual(addon.lookupAt(rootDescriptor, '../escape'), {status: 'failed'})
      assert.deepEqual(addon.createFileAt(rootDescriptor, '/absolute', true), {status: 'failed'})

      const created = addon.createFileAt(rootDescriptor, 'state.tmp', true)
      assert.equal(created.status, 'ok')
      assert.equal(typeof created.identity.device, 'bigint')
      assert.equal(typeof created.identity.inode, 'bigint')
      assert.deepEqual(addon.createFileAt(rootDescriptor, 'state.tmp', true), {status: 'exists'})
      assert.deepEqual(addon.lookupAt(rootDescriptor, 'missing'), {status: 'missing'})

      let childDescriptor = openSync(join(root, 'state.tmp'), 'r+')
      try {
        assert.deepEqual(addon.protectAt(rootDescriptor, 'state.tmp', childDescriptor), {status: 'failed'})
        assert.deepEqual(addon.matchesAt(rootDescriptor, 'state.tmp', childDescriptor), {status: 'ok'})
        if (process.platform === 'win32') {
          closeSync(childDescriptor)
          childDescriptor = null
        }
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
        if (childDescriptor !== null) closeSync(childDescriptor)
      }

      mkdirSync(join(root, 'repair-me'))
      const repairDescriptor = openDirectory(join(root, 'repair-me'))
      try {
        assert.deepEqual(
          addon.protectAt(rootDescriptor, 'repair-me', repairDescriptor),
          {status: 'ok'},
        )
      } finally {
        closeSync(repairDescriptor)
      }

      if (process.platform === 'win32') {
        const finalJunctionTarget = join(root, 'final-junction-target')
        const finalJunction = join(root, 'final-junction')
        mkdirSync(finalJunctionTarget)
        symlinkSync(finalJunctionTarget, finalJunction, 'junction')
        assertNativeDirectoryRejected(finalJunction)
        const finalCanonicalHandle = openNativeDirectory(finalJunctionTarget)
        finalCanonicalHandle.close()

        const intermediateJunctionTarget = join(root, 'intermediate-junction-target')
        const intermediateCanonicalChild = join(intermediateJunctionTarget, 'child')
        const intermediateJunction = join(root, 'intermediate-junction')
        mkdirSync(intermediateCanonicalChild, {recursive: true})
        symlinkSync(intermediateJunctionTarget, intermediateJunction, 'junction')
        assertNativeDirectoryRejected(join(intermediateJunction, 'child'))
        const intermediateCanonicalHandle = openNativeDirectory(intermediateCanonicalChild)
        intermediateCanonicalHandle.close()

        const readonlyDirectory = join(root, 'repair-readonly')
        mkdirSync(readonlyDirectory)
        const restricted = spawnSync('icacls.exe', [
          readonlyDirectory,
          '/inheritance:r',
          '/grant:r',
          `${process.env.USERNAME}:(OI)(CI)(RX)`,
        ], {encoding: 'utf8', windowsHide: true})
        assert.equal(restricted.status, 0, restricted.stderr || restricted.stdout)
        const readonlyHandle = openNativeDirectory(readonlyDirectory)
        try {
          assert.deepEqual(
            addon.protectAt(rootDescriptor, 'repair-readonly', readonlyHandle.descriptor),
            {status: 'ok'},
          )
        } finally {
          readonlyHandle.close()
        }
      }

      const directory = addon.mkdirAt(rootDescriptor, 'workspace-01')
      assert.equal(directory.status, 'ok')
      assert.deepEqual(
        addon.unlinkAt(rootDescriptor, 'workspace-01', directory.identity, 'directory'),
        {status: 'ok'},
      )
      assert.deepEqual(
        addon.unlinkAt(rootDescriptor, 'bootstrap-root', bootstrapDirectory.identity, 'directory'),
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
      assert.equal(rootHandle.close(), undefined)
      assert.equal(containerHandle.close(), undefined)
      rmSync(container, {recursive: true, force: true})
    }
    process.stdout.write('project native behavior passed\n')
  })().catch(error => {
    process.stderr.write(`${error.stack ?? error}\n`)
    process.exitCode = 1
  })
}
