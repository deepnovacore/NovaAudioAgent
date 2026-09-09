import assert from 'node:assert/strict'
import test from 'node:test'

import {
  lockedCameraCodecSupported,
  validReleaseCameraResult,
} from '../src/renderer/release-camera-contract.mjs'

test('installed file-camera capability accepts only the locked AVC codec and closed results', () => {
  assert.equal(lockedCameraCodecSupported(() => 'probably'), true)
  assert.equal(lockedCameraCodecSupported(() => 'maybe'), true)
  assert.equal(lockedCameraCodecSupported(() => ''), false)
  assert.equal(lockedCameraCodecSupported(null), false)
  for (const value of ['passed', 'chromium_codec_unavailable', 'capture_failed']) {
    assert.equal(validReleaseCameraResult(value), true)
  }
  assert.equal(validReleaseCameraResult('permission/path/detail'), false)
})
