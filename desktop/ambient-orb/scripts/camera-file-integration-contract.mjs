import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

export const CAMERA_FILE_CAPABILITY_SENTINEL =
  'camera-file-integration: chromium_codec_unavailable'

export const CAMERA_FILE_FIXTURE = Object.freeze({
  assetRelative: 'assets/demos/cat-sofa-guard/cat-sofa-guard.mp4',
  assetSha256: '5e1347560512794bb106dd15ccf33ab4339693b0d952c12cc25e43d6f48b80c6',
  assetBytes: 1_638_698,
  firstRelative: 'assets/demos/cat-sofa-guard/first.png',
  firstSha256: 'bbf4a7a248c3a931185f8c0c9f3fd2b79a6b6ead9b524b3b2042c8944cdcd0c7',
  lastRelative: 'assets/demos/cat-sofa-guard/last.png',
  lastSha256: '28c998d7027f40d3dd4bb8a36435e3c2c2cbd1e41dd31166d71b129ce7b17be8',
})

const POSITIONS = Object.freeze([0, 2_500, 5_000, 86_400_000])
const MAX_RESULT_BYTES = 16 * 1024

export class ChromiumCapabilityError extends Error {
  constructor() {
    super('chromium camera capability is unavailable')
    this.name = 'ChromiumCapabilityError'
  }
}

export class CameraFileIntegrationError extends Error {
  constructor(label = 'camera file integration failed') {
    super(label)
    this.name = 'CameraFileIntegrationError'
  }
}

export async function verifyCameraFileFixture(repositoryRoot) {
  if (typeof repositoryRoot !== 'string' || repositoryRoot === '') {
    throw new CameraFileIntegrationError('camera fixture invalid')
  }
  try {
    const assetFile = resolve(repositoryRoot, CAMERA_FILE_FIXTURE.assetRelative)
    const firstFile = resolve(repositoryRoot, CAMERA_FILE_FIXTURE.firstRelative)
    const lastFile = resolve(repositoryRoot, CAMERA_FILE_FIXTURE.lastRelative)
    const [assetStatus, asset, first, last] = await Promise.all([
      stat(assetFile),
      readFile(assetFile),
      readFile(firstFile),
      readFile(lastFile),
    ])
    if (!assetStatus.isFile()
      || assetStatus.size !== CAMERA_FILE_FIXTURE.assetBytes
      || digest(asset) !== CAMERA_FILE_FIXTURE.assetSha256
      || digest(first) !== CAMERA_FILE_FIXTURE.firstSha256
      || digest(last) !== CAMERA_FILE_FIXTURE.lastSha256) {
      throw new CameraFileIntegrationError('camera fixture invalid')
    }
    return Object.freeze({
      assetFile,
      firstFile,
      lastFile,
      bytes: assetStatus.size,
      sha256: CAMERA_FILE_FIXTURE.assetSha256,
      width: 1280,
      height: 720,
      positions: POSITIONS,
    })
  } catch (error) {
    if (error instanceof CameraFileIntegrationError) throw error
    throw new CameraFileIntegrationError('camera fixture invalid')
  }
}

export function assertVisualEvidence(evidence) {
  requireMetric(evidence?.referenceSelfFirst)
  requireMetric(evidence?.referenceSelfLast)
  requireMetric(evidence?.capture0ToFirst)
  requireMetric(evidence?.capturePastEndToLast)
  requireDifference(evidence?.capture0To2500, 12)
  requireDifference(evidence?.capture0To5000, 12)
  requireDifference(evidence?.capture2500To5000, 8)
  requireNear(evidence.capture0ToFirst, evidence.referenceSelfFirst)
  requireNear(evidence.capturePastEndToLast, evidence.referenceSelfLast)
  return Object.freeze({
    firstMeanLimit: Math.max(18, evidence.referenceSelfFirst.meanAbsoluteError + 8),
    lastMeanLimit: Math.max(18, evidence.referenceSelfLast.meanAbsoluteError + 8),
  })
}

export function integrationResultLine(result) {
  if (result instanceof ChromiumCapabilityError) return CAMERA_FILE_CAPABILITY_SENTINEL
  const safeResult = result instanceof Error
    ? {ok: false, classification: 'product_failure'}
    : result
  let line
  try {
    line = JSON.stringify(safeResult)
  } catch {
    throw new CameraFileIntegrationError('camera integration result rejected')
  }
  if (typeof line !== 'string'
    || Buffer.byteLength(line, 'utf8') > MAX_RESULT_BYTES
    || /(?:file:|cat-sofa|\.mp4|\/Users\/|[A-Za-z]:\\)/iu.test(line)) {
    throw new CameraFileIntegrationError('camera integration result rejected')
  }
  return line
}

export function integrationExitCode(result) {
  if (result instanceof ChromiumCapabilityError) return 75
  return result?.ok === true ? 0 : 1
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function requireMetric(metric) {
  if (!metric
    || !finiteNonnegative(metric.meanAbsoluteError)
    || !finiteNonnegative(metric.maxAbsoluteError)
    || !finiteNonnegative(metric.within48Ratio)
    || metric.within48Ratio > 1) {
    throw new CameraFileIntegrationError('camera visual evidence rejected')
  }
}

function requireNear(metric, baseline) {
  if (metric.meanAbsoluteError > Math.max(18, baseline.meanAbsoluteError + 8)
    || metric.within48Ratio < 0.95) {
    throw new CameraFileIntegrationError('camera visual evidence rejected')
  }
}

function requireDifference(metric, minimum) {
  if (!metric || !finiteNonnegative(metric.meanAbsoluteError)
    || metric.meanAbsoluteError < minimum) {
    throw new CameraFileIntegrationError('camera visual evidence rejected')
  }
}

function finiteNonnegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
