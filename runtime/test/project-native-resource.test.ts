import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync, writeFileSync} from 'node:fs'
import {mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {loadProjectNativeHostFromResources} from '../src/project-native-resource.js'

function fakeMachAddon(): Buffer {
  const body = Buffer.alloc(64)
  body.writeUInt32LE(0xfeedfacf, 0)
  body.writeUInt32LE(0x0100000c, 4)
  body.writeUInt32LE(8, 12)
  return body
}

function fakeAddon(): Record<string, (...args: readonly unknown[]) => unknown> {
  return {
    acquire: () => ({status: 'busy'}),
    probe: () => ({status: 'ok'}),
    matchesAt: () => ({status: 'ok'}),
    lookupAt: () => ({status: 'missing'}),
    createFileAt: () => ({status: 'exists'}),
    mkdirAt: () => ({status: 'exists'}),
    renameAt: () => ({status: 'ok'}),
    unlinkAt: () => ({status: 'ok'}),
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
        assert.equal(path.endsWith('/nova_project_native.node'), true)
        assert.deepEqual(readFileSync(path), body)
        return module
      },
    })
    assert.notEqual(loaded, null)
    assert.equal(loads, 1)
    assert.deepEqual(loaded?.nativeLocks.acquire(7), {status: 'busy'})
    assert.deepEqual(loaded?.rootFiles.probe(8), {status: 'ok'})

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
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})
