import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  deriveLockedProductionClosure,
  readReleaseTargets,
} from '../scripts/release-dependency-closure.mjs'

const VOICEMEM_PACKAGE = 'voicemem'

function dependencyLock(resolved) {
  return {
    lockfileVersion: 3,
    packages: {
      'desktop/ambient-orb': {
        name: '@nova-audio-agent/ambient-orb',
        dependencies: { '@nova-audio-agent/runtime': '0.1.1' },
      },
      'node_modules/@nova-audio-agent/runtime': { link: true, resolved: 'runtime' },
      runtime: {
        name: '@nova-audio-agent/runtime',
        version: '0.1.1',
        dependencies: {
          '@livekit/agents': '1.6.4',
          '@livekit/rtc-node': '0.13.33',
          [VOICEMEM_PACKAGE]: resolved,
          registry: '1.0.0',
        },
      },
      'node_modules/@livekit/agents': { version: '1.6.4' },
      'node_modules/@livekit/rtc-node': { version: '0.13.33' },
      [`node_modules/${VOICEMEM_PACKAGE}`]: { version: '0.0.1', resolved },
      'node_modules/registry': {
        version: '1.0.0',
        resolved: 'https://registry.example/registry-1.0.0.tgz',
        integrity: 'sha512-registry',
      },
    },
  }
}

function identityHash(identity) {
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

test('release target parser rejects duplicate JSON keys before validation', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'nova-release-targets-'))
  const path = resolve(root, 'targets.json')
  try {
    await writeFile(path, '{"schema_version":1,"schema_version":1,"electron":{"version":"43.2.0","module_abi":148},"targets":[]}', 'utf8')
    await assert.rejects(
      readReleaseTargets(path),
      error => error.code === 'target_manifest_invalid',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('release targets require each canonical tuple, installer, and resource exactly once', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'nova-release-targets-'))
  const path = resolve(root, 'targets.json')
  const manifest = {
    schema_version: 1,
    electron: { version: '43.2.0', module_abi: 148 },
    targets: [
      {
        id: 'darwin-arm64', platform: 'darwin', architecture: 'arm64', libc: 'none',
        installers: ['app', 'dmg'],
        native_resources: [
          'project_native_addon', 'codex_sandbox_probe', 'macos_voice_io',
          'livekit_local_inference', 'livekit_rtc',
          'livekit_probe_manifest', 'livekit_probe_license',
          'livekit_probe_silence', 'livekit_probe_speech',
        ],
      },
      {
        id: 'darwin-x64', platform: 'darwin', architecture: 'x64', libc: 'none',
        installers: ['dmg', 'app'],
        native_resources: [
          'project_native_addon', 'codex_sandbox_probe', 'macos_voice_io',
          'livekit_local_inference', 'livekit_rtc',
          'livekit_probe_manifest', 'livekit_probe_license',
          'livekit_probe_silence', 'livekit_probe_speech',
        ],
      },
      {
        id: 'win32-x64', platform: 'win32', architecture: 'x64', libc: 'none',
        installers: ['nsis'],
        native_resources: [
          'windows_job_guardian', 'project_native_addon', 'codex_sandbox_probe',
          'livekit_local_inference', 'livekit_rtc',
          'livekit_probe_manifest', 'livekit_probe_license',
          'livekit_probe_silence', 'livekit_probe_speech',
        ],
      },
      {
        id: 'linux-x64-gnu', platform: 'linux', architecture: 'x64', libc: 'glibc',
        installers: ['appimage', 'deb'],
        native_resources: [
          'project_native_addon', 'codex_sandbox_probe',
          'livekit_local_inference', 'livekit_rtc',
          'livekit_probe_manifest', 'livekit_probe_license',
          'livekit_probe_silence', 'livekit_probe_speech',
        ],
      },
    ],
  }
  try {
    await writeFile(path, JSON.stringify(manifest), 'utf8')
    await assert.rejects(
      readReleaseTargets(path),
      error => error.code === 'target_manifest_invalid',
      'reordered installer formats are not a second canonical tuple',
    )
    manifest.targets[0].installers = ['dmg', 'app']
    manifest.targets[0].native_resources.push('livekit_rtc')
    await writeFile(path, JSON.stringify(manifest), 'utf8')
    await assert.rejects(
      readReleaseTargets(path),
      error => error.code === 'target_manifest_invalid',
      'duplicate logical native slots must fail closed',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('locked Git dependencies require a full commit and include it in their identity', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'nova-release-lock-'))
  const lockPath = resolve(root, 'package-lock.json')
  const resolvedA = 'git+ssh://git@github.com/deepnovacore/VoiceMem-TS.git#5e05457121f50c7c1d044d8d0b7acdf85b3892d4'
  const resolvedB = `git+ssh://git@github.com/deepnovacore/VoiceMem-TS.git#${'b'.repeat(40)}`
  try {
    await writeFile(lockPath, JSON.stringify(dependencyLock(resolvedA)), 'utf8')
    const closureA = await deriveLockedProductionClosure({ lockPath, targetId: 'darwin-arm64' })
    await writeFile(lockPath, JSON.stringify(dependencyLock(resolvedB)), 'utf8')
    const closureB = await deriveLockedProductionClosure({ lockPath, targetId: 'darwin-arm64' })

    const voiceMemA = closureA.packages.find(value => value.name === VOICEMEM_PACKAGE)
    const voiceMemB = closureB.packages.find(value => value.name === VOICEMEM_PACKAGE)
    assert.equal(voiceMemA.content_sha256, identityHash({
      integrity: null,
      name: VOICEMEM_PACKAGE,
      version: '0.0.1',
      resolved: resolvedA,
    }))
    assert.notEqual(voiceMemA.content_sha256, voiceMemB.content_sha256)

    const registry = closureA.packages.find(value => value.name === 'registry')
    assert.equal(registry.content_sha256, identityHash({
      integrity: 'sha512-registry',
      name: 'registry',
      version: '1.0.0',
    }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('locked Git dependencies reject branches, tags, and short commits', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'nova-release-lock-'))
  const lockPath = resolve(root, 'package-lock.json')
  const invalidResolved = [
    'git+https://github.com/deepnovacore/VoiceMem-TS.git#main',
    'git+https://github.com/deepnovacore/VoiceMem-TS.git#v0.0.1',
    'git+https://github.com/deepnovacore/VoiceMem-TS.git#5e05457',
  ]
  try {
    for (const resolved of invalidResolved) {
      await writeFile(lockPath, JSON.stringify(dependencyLock(resolved)), 'utf8')
      await assert.rejects(
        deriveLockedProductionClosure({ lockPath, targetId: 'darwin-arm64' }),
        error => error.code === 'locked_dependency_invalid',
        resolved,
      )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
