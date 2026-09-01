import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  NativeResourceError,
  expectedNativeResources,
  generateNativeResourceManifest,
  generateSourceHostResourceManifest,
  verifyNativeResourceManifest,
} from '../scripts/native-resource-contract.mjs'

test('supported targets have closed host-owned and dependency-owned native resource slots', () => {
  assert.deepEqual(
    expectedNativeResources('darwin-arm64').map(value => value.id),
    [
      'project_native_addon',
      'codex_sandbox_probe',
      'macos_voice_io',
      'livekit_local_inference',
      'livekit_rtc',
      'livekit_probe_manifest',
      'livekit_probe_license',
      'livekit_probe_silence',
      'livekit_probe_speech',
    ],
  )
  assert.deepEqual(
    expectedNativeResources('win32-x64').map(value => value.id),
    [
      'windows_job_guardian',
      'project_native_addon',
      'codex_sandbox_probe',
      'livekit_local_inference',
      'livekit_rtc',
      'livekit_probe_manifest',
      'livekit_probe_license',
      'livekit_probe_silence',
      'livekit_probe_speech',
    ],
  )
  assert.throws(() => expectedNativeResources('renderer-selected-target'), NativeResourceError)
})

test('resource manifest generation fails closed while audited native owners are absent', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'nova-native-resource-contract-'))
  try {
    await assert.rejects(
      generateNativeResourceManifest({ resourcesRoot: root, targetId: 'darwin-arm64' }),
      error => {
        assert.equal(error.code, 'native_resource_missing')
        assert.doesNotMatch(error.message, /nova-native-resource-contract/u)
        return true
      },
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('source host manifest binds only the fixed Codex host resources', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'nova-source-native-resource-'))
  const header = Buffer.alloc(64)
  header.writeUInt32LE(0xfeedfacf, 0)
  header.writeUInt32LE(0x0100000c, 4)
  header.writeUInt32LE(1, 16)
  header.writeUInt32LE(24, 20)
  header.writeUInt32LE(0x32, 32)
  header.writeUInt32LE(24, 36)
  header.writeUInt32LE(1, 40)
  header.writeUInt32LE(0x000c0000, 44)
  try {
    for (const [relativePath, kind] of [
      ['native/project-native/nova_project_native.node', 'node_addon'],
      ['native/codex-sandbox-probe', 'executable'],
    ]) {
      const path = resolve(root, relativePath)
      await mkdir(resolve(path, '..'), {recursive: true})
      const body = Buffer.from(header)
      body.writeUInt32LE(kind === 'executable' ? 2 : 8, 12)
      await writeFile(path, body)
      if (kind === 'executable') await chmod(path, 0o755)
    }

    const manifest = await generateSourceHostResourceManifest({
      resourcesRoot: root,
      targetId: 'darwin-arm64',
    })

    assert.deepEqual(manifest.resources.map(record => record.logical_id), [
      'codex_sandbox_probe',
      'project_native_addon',
    ])
    assert.equal(manifest.target, 'darwin-arm64')
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('macOS executable inspection accepts a load-command table larger than one page', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'nova-large-mach-header-'))
  const addon = Buffer.alloc(64)
  addon.writeUInt32LE(0xfeedfacf, 0)
  addon.writeUInt32LE(0x0100000c, 4)
  addon.writeUInt32LE(8, 12)
  const paddingCommandBytes = 4080
  const buildVersionBytes = 24
  const executable = Buffer.alloc(32 + paddingCommandBytes + buildVersionBytes)
  executable.writeUInt32LE(0xfeedfacf, 0)
  executable.writeUInt32LE(0x0100000c, 4)
  executable.writeUInt32LE(2, 12)
  executable.writeUInt32LE(2, 16)
  executable.writeUInt32LE(paddingCommandBytes + buildVersionBytes, 20)
  executable.writeUInt32LE(0, 32)
  executable.writeUInt32LE(paddingCommandBytes, 36)
  const buildVersionOffset = 32 + paddingCommandBytes
  executable.writeUInt32LE(0x32, buildVersionOffset)
  executable.writeUInt32LE(buildVersionBytes, buildVersionOffset + 4)
  executable.writeUInt32LE(1, buildVersionOffset + 8)
  executable.writeUInt32LE(0x000c0000, buildVersionOffset + 12)
  try {
    const addonPath = resolve(root, 'native/project-native/nova_project_native.node')
    const probePath = resolve(root, 'native/codex-sandbox-probe')
    await mkdir(resolve(addonPath, '..'), {recursive: true})
    await writeFile(addonPath, addon)
    await writeFile(probePath, executable)
    await chmod(probePath, 0o755)

    await assert.doesNotReject(generateSourceHostResourceManifest({
      resourcesRoot: root,
      targetId: 'darwin-arm64',
    }))
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('native manifest maps every external native resource exactly once', async () => {
  assert.equal(typeof verifyNativeResourceManifest, 'function')
  const root = await mkdtemp(resolve(tmpdir(), 'nova-native-resource-complete-'))
  const header = Buffer.alloc(64)
  header.writeUInt32LE(0xfeedfacf, 0)
  header.writeUInt32LE(0x0100000c, 4)
  header.writeUInt32LE(1, 16)
  header.writeUInt32LE(24, 20)
  header.writeUInt32LE(0x32, 32)
  header.writeUInt32LE(24, 36)
  header.writeUInt32LE(1, 40)
  header.writeUInt32LE(0x000c0000, 44)
  try {
    for (const expected of expectedNativeResources('darwin-arm64')) {
      const path = resolve(root, expected.relative_path)
      await mkdir(resolve(path, '..'), { recursive: true })
      if (expected.kind === 'data') {
        await writeFile(path, Buffer.from(`fixed-${expected.id}`, 'utf8'))
        continue
      }
      const body = Buffer.from(header)
      body.writeUInt32LE(
        expected.kind === 'executable' ? 2 : expected.id === 'livekit_rtc' ? 6 : 8,
        12,
      )
      await writeFile(path, body)
      if (expected.kind === 'executable') await chmod(path, 0o755)
    }
    const manifest = await generateNativeResourceManifest({
      resourcesRoot: root,
      targetId: 'darwin-arm64',
    })
    await writeFile(
      resolve(root, 'native-resources-v1.json'),
      JSON.stringify(manifest),
      'utf8',
    )
    await assert.doesNotReject(verifyNativeResourceManifest({
      resourcesRoot: root,
      targetId: 'darwin-arm64',
    }))

    const uppercaseAddon = resolve(
      root,
      'app.asar.unpacked/node_modules/alpha/NATIVE.NODE',
    )
    await mkdir(resolve(uppercaseAddon, '..'), {recursive: true})
    const uppercaseBody = Buffer.from(header)
    uppercaseBody.writeUInt32LE(8, 12)
    await writeFile(uppercaseAddon, uppercaseBody)
    const dependencyReport = {
      schema_version: 1,
      target: 'darwin-arm64',
      packages: [{
        install_key: 'node_modules/alpha',
        files: [{path: 'NATIVE.NODE', integrity_owner: 'native_manifest'}],
      }],
    }
    const uppercaseManifest = await generateNativeResourceManifest({
      resourcesRoot: root,
      targetId: 'darwin-arm64',
      dependencyReport,
    })
    assert.equal(
      uppercaseManifest.resources.find(
        record => record.relative_path.endsWith('/NATIVE.NODE'),
      )?.kind,
      'node_addon',
    )
    await writeFile(
      resolve(root, 'native-resources-v1.json'),
      JSON.stringify(uppercaseManifest),
      'utf8',
    )
    await assert.doesNotReject(verifyNativeResourceManifest({
      resourcesRoot: root,
      targetId: 'darwin-arm64',
      dependencyReport,
    }))
    await rm(uppercaseAddon)
    await writeFile(
      resolve(root, 'native-resources-v1.json'),
      JSON.stringify(manifest),
      'utf8',
    )

    const invalidAbi = structuredClone(manifest)
    invalidAbi.resources[0].electron_abi = 999
    await writeFile(
      resolve(root, 'native-resources-v1.json'),
      JSON.stringify(invalidAbi),
      'utf8',
    )
    await assert.rejects(
      verifyNativeResourceManifest({ resourcesRoot: root, targetId: 'darwin-arm64' }),
      error => error.code === 'native_resource_manifest_invalid',
    )
    await writeFile(
      resolve(root, 'native-resources-v1.json'),
      JSON.stringify(manifest),
      'utf8',
    )

    const projectAddon = resolve(root, 'native/project-native/nova_project_native.node')
    const wrongArchitecture = Buffer.from(header)
    wrongArchitecture.writeUInt32LE(0x01000007, 4)
    wrongArchitecture.writeUInt32LE(8, 12)
    await writeFile(projectAddon, wrongArchitecture)
    await assert.rejects(
      verifyNativeResourceManifest({ resourcesRoot: root, targetId: 'darwin-arm64' }),
      error => error.code === 'native_resource_arch',
    )
    const restoredAddon = Buffer.from(header)
    restoredAddon.writeUInt32LE(8, 12)
    await writeFile(projectAddon, restoredAddon)

    const probe = resolve(root, 'native/codex-sandbox-probe')
    const wrongKind = Buffer.from(header)
    wrongKind.writeUInt32LE(8, 12)
    await writeFile(probe, wrongKind)
    await assert.rejects(
      verifyNativeResourceManifest({ resourcesRoot: root, targetId: 'darwin-arm64' }),
      error => error.code === 'native_resource_kind',
    )
    const restoredProbe = Buffer.from(header)
    restoredProbe.writeUInt32LE(2, 12)
    await writeFile(probe, restoredProbe)
    await chmod(probe, 0o755)

    if (process.platform !== 'win32') {
      await chmod(probe, 0o644)
      await assert.rejects(
        verifyNativeResourceManifest({ resourcesRoot: root, targetId: 'darwin-arm64' }),
        error => error.code === 'native_resource_mode',
      )
      await chmod(probe, 0o755)
    }
    const wrongMinimum = Buffer.from(restoredProbe)
    wrongMinimum.writeUInt32LE(0x000f0000, 44)
    await writeFile(probe, wrongMinimum)
    await chmod(probe, 0o755)
    await assert.rejects(
      verifyNativeResourceManifest({ resourcesRoot: root, targetId: 'darwin-arm64' }),
      error => error.code === 'native_resource_min_os',
    )
    await writeFile(probe, restoredProbe)
    await chmod(probe, 0o755)

    const duplicate = resolve(root, 'native/orphan-helper')
    await mkdir(resolve(duplicate, '..'), { recursive: true })
    await writeFile(duplicate, header)
    await assert.rejects(
      verifyNativeResourceManifest({ resourcesRoot: root, targetId: 'darwin-arm64' }),
      error => error.code === 'native_resource_orphan',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
