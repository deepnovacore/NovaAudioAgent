import assert from 'node:assert/strict'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  CAMERA_FILE_CAPABILITY_SENTINEL,
  CAMERA_FILE_FIXTURE,
  ChromiumCapabilityError,
  assertVisualEvidence,
  integrationExitCode,
  integrationResultLine,
  verifyCameraFileFixture,
} from '../scripts/camera-file-integration-contract.mjs'
import * as cameraFileContract from '../scripts/camera-file-integration-contract.mjs'
import {compareLandmarks} from '../scripts/camera-file-integration-renderer.mjs'
import * as cameraFileRenderer from '../scripts/camera-file-integration-renderer.mjs'

const repositoryRoot = resolve(import.meta.dirname, '../../..')

test('camera file fixture authority verifies the committed cat-sofa bytes', async () => {
  const verified = await verifyCameraFileFixture(repositoryRoot)
  assert.equal(verified.bytes, 1_638_698)
  assert.equal(
    verified.sha256,
    '5e1347560512794bb106dd15ccf33ab4339693b0d952c12cc25e43d6f48b80c6',
  )
  assert.equal(verified.width, 1280)
  assert.equal(verified.height, 720)
  assert.equal(verified.codec, 'h264')
  assert.equal(verified.sampleEntry, 'avc1')
  assert.equal(verified.chromaSubsampling, '4:2:0')
  assert.equal(verified.timescale, 15_360)
  assert.equal(verified.sampleCount, 211)
  assert.equal(verified.frameRate, 30)
  assert.ok(Math.abs(verified.durationSeconds - 7.033008) <= 0.001)
  assert.equal(verified.positions.at(-1), 86_400_000)
  assert.ok(Object.isFrozen(verified))
  assert.equal(CAMERA_FILE_FIXTURE.assetRelative,
    'assets/demos/cat-sofa-guard/cat-sofa-guard.mp4')
})

test('locked MP4 parser rejects codec, dimensions, sample count, timing, and malformed boxes', async () => {
  assert.equal(typeof cameraFileContract.inspectLockedCameraMp4, 'function')
  const original = new Uint8Array(await readFile(resolve(
    repositoryRoot, CAMERA_FILE_FIXTURE.assetRelative,
  )))
  const metadata = cameraFileContract.inspectLockedCameraMp4(original)
  assert.deepEqual(metadata, {
    codec: 'h264',
    sampleEntry: 'avc1',
    chromaSubsampling: '4:2:0',
    width: 1280,
    height: 720,
    timescale: 15_360,
    sampleCount: 211,
    frameRate: 30,
    durationSeconds: 7.033,
  })

  const corruptions = [
    ['codec', 461, 0x68],
    ['width', 490, 0x04],
    ['sample count', 2345, 0xd2],
    ['sample timing', 656, 0x03],
  ]
  for (const [label, offset, value] of corruptions) {
    const corrupted = new Uint8Array(original)
    corrupted[offset] = value
    assert.throws(
      () => cameraFileContract.inspectLockedCameraMp4(corrupted),
      /camera fixture invalid/u,
      label,
    )
  }
  assert.throws(
    () => cameraFileContract.inspectLockedCameraMp4(original.subarray(0, 700)),
    /camera fixture invalid/u,
  )
  const invalidExtendedSize = new Uint8Array(original)
  invalidExtendedSize.set([0, 0, 0, 1], 0)
  invalidExtendedSize.set([0x00, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], 8)
  assert.throws(
    () => cameraFileContract.inspectLockedCameraMp4(invalidExtendedSize),
    /camera fixture invalid/u,
  )
})

test('test-only encode barrier waits after real encoding and is explicitly releasable', async () => {
  assert.equal(typeof cameraFileRenderer.createEncodeBarrier, 'function')
  const barrier = cameraFileRenderer.createEncodeBarrier()
  let settled = false
  const held = barrier.hold(Promise.resolve('encoded')).finally(() => { settled = true })
  await new Promise(resolveWait => setImmediate(resolveWait))
  assert.equal(barrier.pendingCount(), 1)
  assert.equal(settled, false)
  assert.equal(barrier.releaseAll(), 1)
  assert.equal(await held, 'encoded')
  assert.equal(barrier.pendingCount(), 0)
})

test('renderer codec capability requires an explicit AVC canPlayType result', () => {
  assert.equal(typeof cameraFileRenderer.supportsLockedFileCodec, 'function')
  assert.equal(cameraFileRenderer.supportsLockedFileCodec(() => 'probably'), true)
  assert.equal(cameraFileRenderer.supportsLockedFileCodec(() => 'maybe'), true)
  assert.equal(cameraFileRenderer.supportsLockedFileCodec(() => ''), false)
  assert.throws(
    () => cameraFileRenderer.supportsLockedFileCodec(() => { throw new Error('page failure') }),
    /page failure/u,
  )
  assert.throws(() => cameraFileRenderer.supportsLockedFileCodec(), /codec probe unavailable/u)
})

test('camera file fixture verification fails closed when the repository asset is absent', async () => {
  const emptyRoot = await mkdtemp(resolve(tmpdir(), 'nova-camera-fixture-'))
  try {
    await assert.rejects(
      verifyCameraFileFixture(emptyRoot),
      /camera fixture invalid/u,
    )
  } finally {
    await rm(emptyRoot, {recursive: true, force: true})
  }
})

test('renderer landmark aggregation measures fixed opaque RGB grid distance', () => {
  const black = Array.from({length: 32 * 18}, () => 0)
  const twelve = Array.from({length: 32 * 18}, () => 0x0c0c0c)
  const fifty = Array.from({length: 32 * 18}, () => 0x323232)
  assert.deepEqual(compareLandmarks(black, twelve), {
    meanAbsoluteError: 12,
    maxAbsoluteError: 12,
    within48Ratio: 1,
  })
  assert.deepEqual(compareLandmarks(black, fifty), {
    meanAbsoluteError: 50,
    maxAbsoluteError: 50,
    within48Ratio: 0,
  })
  assert.throws(() => compareLandmarks(black.slice(1), black), /invalid landmarks/u)
})

test('visual oracle requires reference baselines, boundary proximity, and moving landmarks', () => {
  const evidence = {
    referenceSelfFirst: {meanAbsoluteError: 0, maxAbsoluteError: 0, within48Ratio: 1},
    referenceSelfLast: {meanAbsoluteError: 0, maxAbsoluteError: 0, within48Ratio: 1},
    capture0ToFirst: {meanAbsoluteError: 17.9, maxAbsoluteError: 60, within48Ratio: 0.96},
    capturePastEndToLast: {meanAbsoluteError: 18, maxAbsoluteError: 70, within48Ratio: 0.95},
    capture0To2500: {meanAbsoluteError: 12},
    capture0To5000: {meanAbsoluteError: 12},
    capture2500To5000: {meanAbsoluteError: 8},
  }
  assert.doesNotThrow(() => assertVisualEvidence(evidence))
  for (const [field, patch] of [
    ['capture0ToFirst', {meanAbsoluteError: 18.01}],
    ['capturePastEndToLast', {within48Ratio: 0.949}],
    ['capture0To2500', {meanAbsoluteError: 11.99}],
    ['capture0To5000', {meanAbsoluteError: 11.99}],
    ['capture2500To5000', {meanAbsoluteError: 7.99}],
  ]) {
    assert.throws(
      () => assertVisualEvidence({...evidence, [field]: {...evidence[field], ...patch}}),
      /camera visual evidence rejected/u,
      field,
    )
  }
})

test('integration result output is one bounded credential-safe line', () => {
  assert.equal(
    integrationResultLine(new ChromiumCapabilityError('codec_not_supported')),
    CAMERA_FILE_CAPABILITY_SENTINEL,
  )
  const line = integrationResultLine({ok: true, positions: [0, 2500, 5000, 86_400_000]})
  assert.deepEqual(JSON.parse(line), {
    ok: true,
    positions: [0, 2500, 5000, 86_400_000],
  })
  assert.equal(line.includes('\n'), false)
  assert.deepEqual(JSON.parse(integrationResultLine(new Error('/private/fixture.mp4'))), {
    ok: false,
    classification: 'product_failure',
  })
  assert.throws(
    () => integrationResultLine({detail: '/secret/cat-sofa-guard.mp4'}),
    /camera integration result rejected/u,
  )
})

test('capability is visible and non-green while product failures stay distinct', () => {
  assert.equal(integrationExitCode({ok: true}), 0)
  assert.equal(integrationExitCode(new ChromiumCapabilityError('app_ready_timeout')), 75)
  for (const failure of [
    new Error('renderer page load failed'),
    new Error('first Chromium capture generic error'),
    new Error('camera visual evidence rejected'),
    new Error('ordinary timeout'),
  ]) assert.equal(integrationExitCode(failure), 1, failure.message)
})

test('integration operation boundary preserves page, capture, and visual product failures', async () => {
  assert.equal(typeof cameraFileContract.settleIntegrationOperation, 'function')
  for (const failure of [
    new Error('renderer page load failed'),
    new Error('first Chromium capture generic error'),
    new Error('camera visual evidence rejected'),
    new Error('ordinary timeout'),
  ]) {
    const result = await cameraFileContract.settleIntegrationOperation(async () => {
      throw failure
    })
    assert.strictEqual(result, failure)
    assert.equal(integrationExitCode(result), 1)
  }
  const capability = new ChromiumCapabilityError('codec_not_supported')
  assert.strictEqual(
    await cameraFileContract.settleIntegrationOperation(async () => { throw capability }),
    capability,
  )
  assert.equal(
    integrationExitCode(await cameraFileContract.settleIntegrationOperation(async () => {
      throw '/private/path-sentinel'
    })),
    1,
  )
})
