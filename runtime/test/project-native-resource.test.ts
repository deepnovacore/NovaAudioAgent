import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync, writeFileSync} from 'node:fs'
import {mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename, join} from 'node:path'
import {posix} from 'node:path'
import {test} from 'node:test'

import {
  loadProjectNativeHostFromResources,
  protectDefaultProjectDirectories,
  type ProjectNativeHost,
} from '../src/project-native-resource.js'

function fakeMachAddon(): Buffer {
  const body = Buffer.alloc(64)
  body.writeUInt32LE(0xfeedfacf, 0)
  body.writeUInt32LE(0x0100000c, 4)
  body.writeUInt32LE(8, 12)
  return body
}

function fakeWindowsAddon(): Buffer {
  const body = Buffer.alloc(128)
  body.write('MZ', 0, 'ascii')
  body.writeUInt32LE(64, 0x3c)
  body.write('PE\0\0', 64, 'binary')
  body.writeUInt16LE(0x8664, 68)
  body.writeUInt16LE(0x2000, 86)
  return body
}

function fakeAddon(): Record<string, (...args: readonly unknown[]) => unknown> {
  return {
    acquire: () => ({status: 'busy'}),
    openDirectory: () => ({status: 'ok', descriptor: 41, close: () => undefined}),
    probe: () => ({status: 'ok'}),
    protectAt: () => ({status: 'ok'}),
    matchesAt: () => ({status: 'ok'}),
    lookupAt: () => ({status: 'missing'}),
    createFileAt: () => ({status: 'exists'}),
    mkdirAt: () => ({status: 'exists'}),
    mkdirPrivateAt: () => ({status: 'ok', identity: {device: 1n, inode: 2n}}),
    renameAt: () => ({status: 'ok'}),
    renameNoReplaceAt: () => ({status: 'exists'}),
    syncDirectory: () => ({status: 'ok'}),
    unlinkAt: () => ({status: 'ok'}),
    removeTreeAt: () => ({status: 'ok'}),
  }
}

test('project native host loads only one fixed manifest-bound addon for the exact Electron tuple', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nova-project-native-resource-')))
  const addonPath = join(root, 'native', 'project-native', 'nova_project_native.node')
  const body = fakeMachAddon()
  try {
    await mkdir(join(root, 'native', 'project-native'), {recursive: true})
    await writeFile(addonPath, body)
    const record = {
      logical_id: 'project_native_addon',
      relative_path: 'native/project-native/nova_project_native.node',
      byte_size: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
      kind: 'node_addon',
      platform: 'darwin',
      architecture: 'arm64',
      electron_abi: 148,
      build_contract_version: 1,
    }
    await writeFile(join(root, 'native-resources-v1.json'), JSON.stringify({
      schema_version: 1,
      target: 'darwin-arm64',
      resources: [record],
    }))
    let loads = 0
    const module = fakeAddon()
    const loaded = loadProjectNativeHostFromResources({
      resourcesPath: root,
      platform: 'darwin',
      arch: 'arm64',
      electronAbi: '148',
      moduleLoader: path => {
        loads += 1
        assert.notEqual(path, addonPath)
        assert.equal(basename(path), 'nova_project_native.node')
        assert.deepEqual(readFileSync(path), body)
        return module
      },
    })
    assert.notEqual(loaded, null)
    assert.equal(loads, 1)
    assert.deepEqual(loaded?.nativeLocks.acquire(7), {status: 'busy'})
    assert.deepEqual(loaded?.rootFiles.probe(8), {status: 'ok'})
    assert.equal(Object.hasOwn(loaded?.rootFiles ?? {}, 'matchesWorkspaceAt'), false)
    assert.equal(Object.hasOwn(loaded?.rootFiles ?? {}, 'lookupWorkspaceAt'), false)
    assert.deepEqual(loaded?.rootFiles.removeTreeAt(8, 'tombstone', {device: 1n, inode: 2n}), {
      status: 'ok',
    })
    const maintenanceFiles = loaded?.rootFiles as unknown as {
      renameNoReplaceAt(
        root: number,
        from: string,
        to: string,
        identity: {device: bigint; inode: bigint},
      ): unknown
      syncDirectory(root: number): unknown
    }
    assert.deepEqual(maintenanceFiles.renameNoReplaceAt(
      8,
      'source',
      'destination',
      {device: 1n, inode: 2n},
    ), {status: 'exists'})
    assert.deepEqual(maintenanceFiles.syncDirectory(8), {status: 'ok'})
    const directory = loaded?.directoryHandles.open('/home/nova')
    assert.equal(directory?.fd, 41)
    assert.equal(directory?.close(), undefined)
    assert.equal(Object.hasOwn(loaded ?? {}, 'protectDirectory'), false)
    assert.equal(loaded?.protectDirectoryAt(8, 'state', 9), true)
    assert.deepEqual(loaded?.mkdirPrivateAt(8, 'state'), {
      status: 'ok', identity: {device: 1n, inode: 2n},
    })

    const swappedDuringLoad = loadProjectNativeHostFromResources({
      resourcesPath: root,
      platform: 'darwin',
      arch: 'arm64',
      electronAbi: '148',
      moduleLoader: path => {
        loads += 1
        assert.notEqual(path, addonPath)
        assert.deepEqual(readFileSync(path), body)
        writeFileSync(addonPath, Buffer.concat([body, Buffer.from('swapped')]))
        return module
      },
    })
    assert.equal(swappedDuringLoad, null, 'source replacement during safe-copy load fails closed')

    await writeFile(addonPath, Buffer.concat([body, Buffer.from('changed')]))
    const rejected = loadProjectNativeHostFromResources({
      resourcesPath: root,
      platform: 'darwin',
      arch: 'arm64',
      electronAbi: '148',
      moduleLoader: () => {
        loads += 1
        return module
      },
    })
    assert.equal(rejected, null)
    assert.equal(loads, 2, 'changed native bytes must fail before module loading')
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('project native host rejects wrong ABI and decorated addon exports without throwing details', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nova-project-native-resource-')))
  const addonPath = join(root, 'native', 'project-native', 'nova_project_native.node')
  const body = fakeMachAddon()
  try {
    await mkdir(join(root, 'native', 'project-native'), {recursive: true})
    await writeFile(addonPath, body)
    await writeFile(join(root, 'native-resources-v1.json'), JSON.stringify({
      schema_version: 1,
      target: 'darwin-arm64',
      resources: [{
        logical_id: 'project_native_addon',
        relative_path: 'native/project-native/nova_project_native.node',
        byte_size: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
        kind: 'node_addon', platform: 'darwin', architecture: 'arm64',
        electron_abi: 148, build_contract_version: 1,
      }],
    }))
    assert.equal(loadProjectNativeHostFromResources({
      resourcesPath: root, platform: 'darwin', arch: 'arm64', electronAbi: '127',
      moduleLoader: () => fakeAddon(),
    }), null)
    const decorated = {...fakeAddon(), arbitraryPath: () => '/private/secret'}
    assert.equal(loadProjectNativeHostFromResources({
      resourcesPath: root, platform: 'darwin', arch: 'arm64', electronAbi: '148',
      moduleLoader: () => decorated,
    }), null)

    const nativeResources = await import('../src/project-native-resource.js') as unknown as {
      inspectProjectNativeHostFromResources?: (options: {
        readonly resourcesPath: string
        readonly platform: string
        readonly arch: string
        readonly electronAbi: string | undefined
        readonly moduleLoader?: (path: string) => unknown
      }) => unknown
    }
    assert.equal(typeof nativeResources.inspectProjectNativeHostFromResources, 'function')
    const inspect = nativeResources.inspectProjectNativeHostFromResources!
    assert.deepEqual(inspect({
      resourcesPath: root, platform: 'darwin', arch: 'arm64', electronAbi: '127',
      moduleLoader: () => fakeAddon(),
    }), {status: 'present_failure', host: null})
    assert.deepEqual(inspect({
      resourcesPath: root, platform: 'freebsd', arch: 'x64', electronAbi: '148',
      moduleLoader: () => fakeAddon(),
    }), {status: 'absent', host: null})
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('Windows project native host forwards managed-directory preparation to the native addon', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nova-project-native-resource-')))
  const addonPath = join(root, 'native', 'project-native', 'nova_project_native.node')
  const body = fakeWindowsAddon()
  const calls: Readonly<[number, string, number]>[] = []
  try {
    await mkdir(join(root, 'native', 'project-native'), {recursive: true})
    await writeFile(addonPath, body)
    await writeFile(join(root, 'native-resources-v1.json'), JSON.stringify({
      schema_version: 1,
      target: 'win32-x64',
      resources: [{
        logical_id: 'project_native_addon',
        relative_path: 'native/project-native/nova_project_native.node',
        byte_size: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
        kind: 'node_addon', platform: 'win32', architecture: 'x64',
        electron_abi: 148, build_contract_version: 1,
      }],
    }))
    const addon = {
      ...fakeAddon(),
      lookupWorkspaceAt: () => ({status: 'missing'}),
      matchesWorkspaceAt: () => ({status: 'ok'}),
      prepareManagedAt: (parent: number, name: string, child: number) => {
        calls.push([parent, name, child])
        return {status: child === 9 ? 'ok' : 'failed'}
      },
    }
    const loaded = loadProjectNativeHostFromResources({
      resourcesPath: root,
      platform: 'win32',
      arch: 'x64',
      electronAbi: '148',
      moduleLoader: () => addon,
    })
    assert.notEqual(loaded, null)
    assert.equal(loaded?.prepareManagedDirectoryAt(7, 'workspaces', 9), true)
    assert.equal(loaded?.prepareManagedDirectoryAt(7, 'workspaces', 10), false)
    assert.deepEqual(calls, [
      [7, 'workspaces', 9],
      [7, 'workspaces', 10],
    ])
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('default project directories protect private defaults and prepare the managed container', () => {
  const opened: string[] = []
  const closed: number[] = []
  const protectedChildren: Readonly<[number, string, number]>[] = []
  const managedChildren: Readonly<[number, string, number]>[] = []
  let pathProtectionCalls = 0
  const descriptors = new Map([
    ['/home/nova/.nova-audio-agent', 10],
    ['/home/nova/.nova-audio-agent/state', 11],
    ['/home/nova/.nova-audio-agent/workspaces', 12],
    ['/home/nova/.nova-audio-agent/workspaces/default', 13],
  ])
  const host = {
    protectDirectory: () => {
      pathProtectionCalls += 1
      return true
    },
    protectDirectoryAt: (parent: number, name: string, child: number) => {
      protectedChildren.push([parent, name, child])
      return true
    },
    prepareManagedDirectoryAt: (parent: number, name: string, child: number) => {
      managedChildren.push([parent, name, child])
      return true
    },
  } as unknown as ProjectNativeHost
  const configuredDefaults = {
    homeDirectory: '/home/nova',
    stateRoot: '/home/nova/.nova-audio-agent/state',
    managedRoot: '/home/nova/.nova-audio-agent/workspaces',
    workspace: '/home/nova/.nova-audio-agent/workspaces/default',
    pathApi: posix,
    directoryHandles: {
      open: (path: string) => {
        opened.push(path)
        const descriptor = descriptors.get(path)
        if (descriptor === undefined) throw new Error('unexpected test path')
        return {fd: descriptor, close: () => { closed.push(descriptor) }}
      },
    },
  }
  assert.equal(protectDefaultProjectDirectories(host, configuredDefaults), true)
  assert.equal(pathProtectionCalls, 0)
  assert.deepEqual(opened, [
    '/home/nova/.nova-audio-agent',
    '/home/nova/.nova-audio-agent/state',
    '/home/nova/.nova-audio-agent',
    '/home/nova/.nova-audio-agent/workspaces',
    '/home/nova/.nova-audio-agent/workspaces',
    '/home/nova/.nova-audio-agent/workspaces/default',
  ])
  assert.deepEqual(protectedChildren, [
    [10, 'state', 11],
    [12, 'default', 13],
  ])
  assert.deepEqual(managedChildren, [[10, 'workspaces', 12]])
  assert.deepEqual(closed, [11, 10, 12, 10, 13, 12])

  opened.length = 0
  const customPaths = {
    homeDirectory: '/home/nova',
    stateRoot: '/srv/custom-state',
    managedRoot: '/srv/custom-workspaces',
    workspace: '/srv/custom-workspace',
    pathApi: posix,
    directoryHandles: configuredDefaults.directoryHandles,
  }
  assert.equal(protectDefaultProjectDirectories(host, customPaths), true)
  assert.deepEqual(opened, [])
})

test('default project protection fails closed when managed preparation fails', () => {
  const protectedChildren: Readonly<[number, string, number]>[] = []
  const managedChildren: Readonly<[number, string, number]>[] = []
  const host = {
    protectDirectoryAt: (parent: number, name: string, child: number) => {
      protectedChildren.push([parent, name, child])
      return true
    },
    prepareManagedDirectoryAt: (parent: number, name: string, child: number) => {
      managedChildren.push([parent, name, child])
      return false
    },
  } as unknown as ProjectNativeHost
  const result = protectDefaultProjectDirectories(host, {
    homeDirectory: '/home/nova',
    stateRoot: null,
    managedRoot: '/home/nova/.nova-audio-agent/workspaces',
    workspace: null,
    pathApi: posix,
    directoryHandles: {
      open: (path: string) => ({
        fd: path.endsWith('workspaces') ? 12 : 10,
        close: () => undefined,
      }),
    },
  })
  assert.equal(result, false)
  assert.deepEqual(protectedChildren, [])
  assert.deepEqual(managedChildren, [[10, 'workspaces', 12]])
})

test('default project protection fails closed and closes a retained parent when child open fails', () => {
  const closed: number[] = []
  const paths = {
    homeDirectory: '/home/nova',
    stateRoot: '/home/nova/.nova-audio-agent/state',
    managedRoot: null,
    workspace: null,
    pathApi: posix,
    directoryHandles: {
      open: (path: string) => {
        if (path.endsWith('state')) throw new Error('private open detail')
        return {fd: 21, close: () => { closed.push(21) }}
      },
    },
  }
  const host = {
    protectDirectory: () => true,
    protectDirectoryAt: () => true,
  } as unknown as ProjectNativeHost
  assert.equal(protectDefaultProjectDirectories(host, paths), false)
  assert.deepEqual(closed, [21])
})
