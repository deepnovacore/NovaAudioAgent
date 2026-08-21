import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  NativeResourceError,
  expectedNativeResources,
  generateNativeResourceManifest,
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
