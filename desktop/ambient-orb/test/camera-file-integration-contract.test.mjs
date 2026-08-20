import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
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
import {compareLandmarks} from '../scripts/camera-file-integration-renderer.mjs'

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
  assert.equal(verified.positions.at(-1), 86_400_000)
  assert.ok(Object.isFrozen(verified))
  assert.equal(CAMERA_FILE_FIXTURE.assetRelative,
    'assets/demos/cat-sofa-guard/cat-sofa-guard.mp4')
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
    integrationResultLine(new ChromiumCapabilityError()),
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
  assert.equal(integrationExitCode(new ChromiumCapabilityError()), 75)
  assert.equal(integrationExitCode(new Error('product failure')), 1)
})
