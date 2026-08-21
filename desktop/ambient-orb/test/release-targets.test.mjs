import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

import { readReleaseTargets } from '../scripts/release-dependency-closure.mjs'

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
        ],
      },
      {
        id: 'darwin-x64', platform: 'darwin', architecture: 'x64', libc: 'none',
        installers: ['dmg', 'app'],
        native_resources: [
          'project_native_addon', 'codex_sandbox_probe', 'macos_voice_io',
          'livekit_local_inference', 'livekit_rtc',
        ],
      },
      {
        id: 'win32-x64', platform: 'win32', architecture: 'x64', libc: 'none',
        installers: ['nsis'],
        native_resources: [
          'windows_job_guardian', 'project_native_addon', 'codex_sandbox_probe',
          'livekit_local_inference', 'livekit_rtc',
        ],
      },
      {
        id: 'linux-x64-gnu', platform: 'linux', architecture: 'x64', libc: 'glibc',
        installers: ['appimage', 'deb'],
        native_resources: [
          'project_native_addon', 'codex_sandbox_probe',
          'livekit_local_inference', 'livekit_rtc',
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
