'use strict'

const assert = require('node:assert/strict')
const {
  closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} = require('node:fs')
const {join} = require('node:path')
const {spawn, spawnSync} = require('node:child_process')

const addonPath = process.argv[2]
if (addonPath === undefined) process.exit(0)
const mode = process.argv[3] ?? 'driver'
const lockPath = process.argv[4]
const addon = require(addonPath)

assert.equal(process.versions.electron, '43.2.0')
assert.equal(process.versions.modules, '148')

const REMOVE_TREE_DEPTH_BUDGET = 64
const DEEP_DELETE_DEPTH = REMOVE_TREE_DEPTH_BUDGET

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

function supportsDirectoryLinks(root) {
  const target = join(root, 'directory-link-probe-target')
  const link = join(root, 'directory-link-probe')
  mkdirSync(target)
  try {
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') return false
    throw error
  } finally {
    rmSync(link, {recursive: true, force: true})
    rmSync(target, {recursive: true, force: true})
  }
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
    if (process.platform === 'win32' && process.env.SystemRoot) {
      assertNativeDirectoryRejected(process.env.SystemRoot)
    }

    const container = mkdtempSync(join(process.cwd(), 'build', 'nova-project-native-behavior-'))
    const root = join(container, 'root')
    mkdirSync(root)
    let directoryLinksSupported = process.platform !== 'win32'
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
      if (process.platform === 'win32') {
        const protectedRootAcl = spawnSync('icacls.exe', [root], {
          encoding: 'utf8',
          windowsHide: true,
        })
        assert.equal(
          protectedRootAcl.status,
          0,
          protectedRootAcl.stderr || protectedRootAcl.stdout,
        )
        assert.match(protectedRootAcl.stdout, /\(OI\)\(CI\)\(F\)/u)
        const readers = spawnSync('icacls.exe', [
          root,
          '/grant:r',
          '*S-1-5-32-545:(RX)',
        ], {encoding: 'utf8', windowsHide: true})
        assert.equal(readers.status, 0, readers.stderr || readers.stdout)
        assert.deepEqual(addon.probe(rootDescriptor), {status: 'ok'})

        const writable = spawnSync('icacls.exe', [
          root,
          '/grant:r',
          '*S-1-5-32-545:(M)',
        ], {encoding: 'utf8', windowsHide: true})
        assert.equal(writable.status, 0, writable.stderr || writable.stdout)
        assert.deepEqual(addon.probe(rootDescriptor), {status: 'failed'})
        assert.deepEqual(addon.protectAt(containerDescriptor, 'root', rootDescriptor), {status: 'ok'})
        assert.deepEqual(addon.probe(rootDescriptor), {status: 'ok'})
      }
      assert.deepEqual(addon.lookupAt(rootDescriptor, '../escape'), {status: 'failed'})
      assert.deepEqual(addon.createFileAt(rootDescriptor, '/absolute', true), {status: 'failed'})

      const created = addon.createFileAt(rootDescriptor, 'state.tmp', true)
      assert.equal(created.status, 'ok')
      assert.equal(typeof created.identity.device, 'bigint')
      assert.equal(typeof created.identity.inode, 'bigint')
      assert.deepEqual(addon.createFileAt(rootDescriptor, 'state.tmp', true), {status: 'exists'})
      assert.deepEqual(addon.lookupAt(rootDescriptor, 'missing'), {status: 'missing'})
      assert.deepEqual(addon.syncDirectory(rootDescriptor), {status: 'ok'})

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

      const renameSource = addon.mkdirPrivateAt(rootDescriptor, 'rename-source')
      const renameCollision = addon.mkdirPrivateAt(rootDescriptor, 'rename-collision')
      assert.equal(renameSource.status, 'ok')
      assert.equal(renameCollision.status, 'ok')
      assert.deepEqual(
        addon.renameNoReplaceAt(
          rootDescriptor, 'rename-source', 'rename-collision', renameSource.identity,
        ),
        {status: 'exists'},
      )
      assert.deepEqual(
        addon.lookupAt(rootDescriptor, 'rename-collision'),
        {status: 'ok', identity: renameCollision.identity},
      )
      assert.deepEqual(
        addon.renameNoReplaceAt(
          rootDescriptor, 'rename-source', 'rename-final', {device: 0n, inode: 0n},
        ),
        {status: 'mismatch'},
      )
      assert.deepEqual(
        addon.unlinkAt(rootDescriptor, 'rename-collision', renameCollision.identity, 'directory'),
        {status: 'ok'},
      )
      assert.deepEqual(
        addon.renameNoReplaceAt(
          rootDescriptor, 'rename-source', 'rename-final', renameSource.identity,
        ),
        {status: 'ok'},
      )
      assert.deepEqual(
        addon.unlinkAt(rootDescriptor, 'rename-final', renameSource.identity, 'directory'),
        {status: 'ok'},
      )

      const repairDirectory = join(root, 'repair-me')
      mkdirSync(repairDirectory)
      const repairDescriptor = openDirectory(repairDirectory)
      try {
        assert.deepEqual(
          addon.protectAt(rootDescriptor, 'repair-me', repairDescriptor),
          {status: 'ok'},
        )
      } finally {
        closeSync(repairDescriptor)
      }

      if (process.platform === 'win32') {
        const managedContainer = addon.mkdirAt(rootDescriptor, 'managed-container')
        assert.equal(managedContainer.status, 'ok')
        const managedContainerPath = join(root, 'managed-container')
        const managedIdentity = statSync(managedContainerPath, {bigint: true})
        const managedHandle = openNativeDirectory(managedContainerPath)
        try {
          assert.deepEqual(
            addon.prepareManagedAt(rootDescriptor, 'managed-container', rootDescriptor),
            {status: 'failed'},
          )
          assert.deepEqual(
            addon.prepareManagedAt(
              rootDescriptor,
              'managed-container',
              managedHandle.descriptor,
            ),
            {status: 'ok'},
          )
          const managedChild = addon.mkdirAt(managedHandle.descriptor, 'managed-child')
          assert.equal(managedChild.status, 'ok')
          assert.deepEqual(
            addon.unlinkAt(
              managedHandle.descriptor,
              'managed-child',
              managedChild.identity,
              'directory',
            ),
            {status: 'ok'},
          )
        } finally {
          managedHandle.close()
        }
        const preparedIdentity = statSync(managedContainerPath, {bigint: true})
        assert.equal(preparedIdentity.dev, managedIdentity.dev)
        assert.equal(preparedIdentity.ino, managedIdentity.ino)
        const preparedAcl = spawnSync('icacls.exe', [managedContainerPath], {
          encoding: 'utf8',
          windowsHide: true,
        })
        assert.equal(preparedAcl.status, 0, preparedAcl.stderr || preparedAcl.stdout)
        assert.match(preparedAcl.stdout, /\(OI\)\(CI\)\(F\)/u)
        const inheritableReaders = spawnSync('icacls.exe', [
          root,
          '/grant:r',
          '*S-1-5-32-545:(OI)(CI)(RX)',
        ], {encoding: 'utf8', windowsHide: true})
        assert.equal(
          inheritableReaders.status,
          0,
          inheritableReaders.stderr || inheritableReaders.stdout,
        )
        const managedAcl = spawnSync('icacls.exe', [managedContainerPath], {
          encoding: 'utf8',
          windowsHide: true,
        })
        assert.equal(managedAcl.status, 0, managedAcl.stderr || managedAcl.stdout)
        assert.match(managedAcl.stdout, /\(I\)[^\r\n]*\(RX\)/u)
        const removeInheritableReaders = spawnSync('icacls.exe', [
          root,
          '/remove:g',
          '*S-1-5-32-545',
        ], {encoding: 'utf8', windowsHide: true})
        assert.equal(
          removeInheritableReaders.status,
          0,
          removeInheritableReaders.stderr || removeInheritableReaders.stdout,
        )

        directoryLinksSupported = supportsDirectoryLinks(root)
        if (directoryLinksSupported) {
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
        }

        const readonlyDirectory = join(root, 'repair-readonly')
        mkdirSync(readonlyDirectory)
        const currentIdentity = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
          encoding: 'utf8',
          windowsHide: true,
        })
        assert.equal(currentIdentity.status, 0, currentIdentity.stderr)
        const currentSid = /,"(S-1-(?:[0-9]+-){1,15}[0-9]+)"\r?\n?$/u.exec(
          currentIdentity.stdout,
        )?.[1]
        assert.notEqual(currentSid, undefined)
        const restricted = spawnSync('icacls.exe', [
          readonlyDirectory,
          '/inheritance:r',
          '/grant:r',
          `*${currentSid}:(OI)(CI)(RX)`,
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

      if (process.platform === 'win32') {
        const sandboxWorkspace = addon.mkdirAt(rootDescriptor, 'sandbox-workspace')
        assert.equal(sandboxWorkspace.status, 'ok')
        const sandboxWorkspacePath = join(root, 'sandbox-workspace')
        const writable = spawnSync('icacls.exe', [
          sandboxWorkspacePath,
          '/grant:r',
          '*S-1-5-32-545:(OI)(CI)(M)',
        ], {encoding: 'utf8', windowsHide: true})
        assert.equal(writable.status, 0, writable.stderr || writable.stdout)
        assert.deepEqual(addon.lookupAt(rootDescriptor, 'sandbox-workspace'), {status: 'failed'})
        assert.deepEqual(addon.lookupWorkspaceAt(rootDescriptor, 'sandbox-workspace'), {
          status: 'ok',
          identity: sandboxWorkspace.identity,
        })
        const sandboxWorkspaceDescriptor = openDirectory(sandboxWorkspacePath)
        try {
          assert.deepEqual(
            addon.matchesWorkspaceAt(
              rootDescriptor,
              'sandbox-workspace',
              sandboxWorkspaceDescriptor,
            ),
            {status: 'ok'},
          )
          assert.deepEqual(
            addon.protectAt(rootDescriptor, 'sandbox-workspace', sandboxWorkspaceDescriptor),
            {status: 'ok'},
          )
        } finally {
          closeSync(sandboxWorkspaceDescriptor)
        }
        assert.deepEqual(
          addon.unlinkAt(
            rootDescriptor,
            'sandbox-workspace',
            sandboxWorkspace.identity,
            'directory',
          ),
          {status: 'ok'},
        )
      }
      assert.deepEqual(
        addon.unlinkAt(rootDescriptor, 'bootstrap-root', bootstrapDirectory.identity, 'directory'),
        {status: 'ok'},
      )

      const unrelated = join(root, 'unrelated.txt')
      writeFileSync(unrelated, 'keep')
      const outside = join(root, 'outside-target')
      mkdirSync(outside)
      writeFileSync(join(outside, 'data.txt'), 'outside')
      const tombstone = addon.mkdirAt(rootDescriptor, 'tombstone')
      assert.equal(tombstone.status, 'ok')
      mkdirSync(join(root, 'tombstone', 'nested'))
      writeFileSync(join(root, 'tombstone', 'nested', 'data.txt'), 'delete')
      if (directoryLinksSupported) {
        symlinkSync(
          outside,
          join(root, 'tombstone', 'link-to-outside'),
          process.platform === 'win32' ? 'junction' : 'dir',
        )
      }
      assert.deepEqual(
        addon.removeTreeAt(rootDescriptor, 'tombstone', tombstone.identity),
        {status: 'ok'},
      )
      assert.equal(existsSync(join(root, 'tombstone')), false)
      assert.equal(readFileSync(unrelated, 'utf8'), 'keep')
      assert.equal(readFileSync(join(outside, 'data.txt'), 'utf8'), 'outside')

      const deepSibling = join(root, 'deep-delete-sibling.txt')
      writeFileSync(deepSibling, 'keep-deep-sibling')
      const deepTombstone = addon.mkdirAt(rootDescriptor, 'deep-tombstone')
      assert.equal(deepTombstone.status, 'ok')
      let deepCursor = join(root, 'deep-tombstone')
      for (let depth = 0; depth < DEEP_DELETE_DEPTH; depth += 1) {
        deepCursor = join(deepCursor, 'd')
        mkdirSync(deepCursor)
      }
      writeFileSync(join(deepCursor, 'data.txt'), 'delete-deep')
      assert.deepEqual(
        addon.removeTreeAt(
          rootDescriptor, 'deep-tombstone', deepTombstone.identity,
        ),
        {status: 'ok'},
      )
      assert.equal(existsSync(join(root, 'deep-tombstone')), false)
      assert.equal(readFileSync(deepSibling, 'utf8'), 'keep-deep-sibling')

      const overBudget = addon.mkdirAt(rootDescriptor, 'over-budget-tombstone')
      assert.equal(overBudget.status, 'ok')
      let overBudgetCursor = join(root, 'over-budget-tombstone')
      for (let depth = 0; depth <= REMOVE_TREE_DEPTH_BUDGET; depth += 1) {
        overBudgetCursor = join(overBudgetCursor, 'd')
        mkdirSync(overBudgetCursor)
      }
      writeFileSync(join(overBudgetCursor, 'data.txt'), 'keep-over-budget')
      assert.deepEqual(
        addon.removeTreeAt(
          rootDescriptor, 'over-budget-tombstone', overBudget.identity,
        ),
        {status: 'failed'},
      )
      assert.equal(existsSync(join(root, 'over-budget-tombstone')), true)
      assert.equal(
        readFileSync(join(overBudgetCursor, 'data.txt'), 'utf8'),
        'keep-over-budget',
      )
      assert.equal(readFileSync(deepSibling, 'utf8'), 'keep-deep-sibling')
      rmSync(join(root, 'over-budget-tombstone'), {recursive: true})

      const swapped = addon.mkdirAt(rootDescriptor, 'swapped')
      assert.equal(swapped.status, 'ok')
      renameSync(join(root, 'swapped'), join(root, 'swapped-original'))
      mkdirSync(join(root, 'swapped'))
      assert.deepEqual(
        addon.removeTreeAt(rootDescriptor, 'swapped', swapped.identity),
        {status: 'mismatch'},
      )
      rmSync(join(root, 'swapped'), {recursive: true})
      rmSync(join(root, 'swapped-original'), {recursive: true})

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
      const lockChildExit = new Promise(resolve => child.once('exit', resolve))
      child.kill('SIGKILL')
      await lockChildExit
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
      if (process.platform === 'win32') {
        spawnSync('icacls.exe', [root, '/reset', '/T', '/Q', '/C'], {
          encoding: 'utf8',
          windowsHide: true,
        })
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
