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
const MAX_MP4_BOXES = 4_096
const EXPECTED_VIDEO = Object.freeze({
  codec: 'h264',
  sampleEntry: 'avc1',
  chromaSubsampling: '4:2:0',
  width: 1280,
  height: 720,
  timescale: 15_360,
  sampleCount: 211,
  frameRate: 30,
  durationSeconds: 7.033008,
})

export class ChromiumCapabilityError extends Error {
  constructor(reason) {
    if (reason !== 'app_ready_timeout' && reason !== 'codec_not_supported') {
      throw new TypeError('invalid Chromium capability reason')
    }
    super('chromium camera capability is unavailable')
    this.name = 'ChromiumCapabilityError'
    this.reason = reason
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
    const metadata = inspectLockedCameraMp4(asset)
    return Object.freeze({
      assetFile,
      firstFile,
      lastFile,
      bytes: assetStatus.size,
      sha256: CAMERA_FILE_FIXTURE.assetSha256,
      ...metadata,
      positions: POSITIONS,
    })
  } catch (error) {
    if (error instanceof CameraFileIntegrationError) throw error
    throw new CameraFileIntegrationError('camera fixture invalid')
  }
}

export function inspectLockedCameraMp4(input) {
  try {
    if (!(input instanceof Uint8Array)
      || input.byteLength !== CAMERA_FILE_FIXTURE.assetBytes) throw new Error('invalid MP4')
    const state = {boxes: 0}
    const top = readBoxes(input, 0, input.byteLength, state)
    const movie = requireSingleBox(top, 'moov')
    const movieChildren = readBoxes(input, movie.dataStart, movie.end, state)
    const movieHeader = requireSingleBox(movieChildren, 'mvhd')
    const movieTimescale = readTimescale(input, movieHeader)
    const videoTracks = movieChildren
      .filter(box => box.type === 'trak')
      .map(track => inspectVideoTrack(input, track, movieTimescale, state))
      .filter(value => value !== null)
    if (videoTracks.length !== 1) throw new Error('invalid video track count')
    const metadata = videoTracks[0]
    if (metadata.codec !== EXPECTED_VIDEO.codec
      || metadata.sampleEntry !== EXPECTED_VIDEO.sampleEntry
      || metadata.chromaSubsampling !== EXPECTED_VIDEO.chromaSubsampling
      || metadata.width !== EXPECTED_VIDEO.width
      || metadata.height !== EXPECTED_VIDEO.height
      || metadata.timescale !== EXPECTED_VIDEO.timescale
      || metadata.sampleCount !== EXPECTED_VIDEO.sampleCount
      || Math.abs(metadata.frameRate - EXPECTED_VIDEO.frameRate) > 1e-9
      || Math.abs(metadata.durationSeconds - EXPECTED_VIDEO.durationSeconds) > 0.001) {
      throw new Error('unexpected video metadata')
    }
    return Object.freeze(metadata)
  } catch {
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

export async function settleIntegrationOperation(operation) {
  if (typeof operation !== 'function') throw new TypeError('invalid integration operation')
  try {
    return await operation()
  } catch (error) {
    return error instanceof Error ? error : new CameraFileIntegrationError()
  }
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function inspectVideoTrack(bytes, track, movieTimescale, state) {
  const trackChildren = readBoxes(bytes, track.dataStart, track.end, state)
  const media = requireSingleBox(trackChildren, 'mdia')
  const mediaChildren = readBoxes(bytes, media.dataStart, media.end, state)
  const handler = requireSingleBox(mediaChildren, 'hdlr')
  requireRange(handler.dataStart, 12, handler.end)
  if (asciiType(bytes, handler.dataStart + 8) !== 'vide') return null
  const mediaHeader = requireSingleBox(mediaChildren, 'mdhd')
  const timescale = readTimescale(bytes, mediaHeader)
  const mediaInfo = requireSingleBox(mediaChildren, 'minf')
  const mediaInfoChildren = readBoxes(bytes, mediaInfo.dataStart, mediaInfo.end, state)
  const sampleTable = requireSingleBox(mediaInfoChildren, 'stbl')
  const sampleBoxes = readBoxes(bytes, sampleTable.dataStart, sampleTable.end, state)
  const sampleDescription = requireSingleBox(sampleBoxes, 'stsd')
  const sampleEntry = readVisualSampleEntry(bytes, sampleDescription, state)
  const timing = readSampleTiming(bytes, requireSingleBox(sampleBoxes, 'stts'))
  const sampleCount = readSampleCount(bytes, requireSingleBox(sampleBoxes, 'stsz'))
  if (timing.sampleCount !== sampleCount || timing.duration === 0) {
    throw new Error('invalid sample timing')
  }
  const trackDuration = readTrackDuration(bytes, trackChildren, movieTimescale, state)
  return {
    codec: 'h264',
    sampleEntry: sampleEntry.type,
    chromaSubsampling: sampleEntry.chromaFormatIdc === 1 ? '4:2:0' : 'unsupported',
    width: sampleEntry.width,
    height: sampleEntry.height,
    timescale,
    sampleCount,
    frameRate: (sampleCount * timescale) / timing.duration,
    durationSeconds: trackDuration / movieTimescale,
  }
}

function readVisualSampleEntry(bytes, stsd, state) {
  requireRange(stsd.dataStart, 8, stsd.end)
  if (readU32(bytes, stsd.dataStart + 4) !== 1) throw new Error('invalid sample descriptions')
  const entries = readBoxes(bytes, stsd.dataStart + 8, stsd.end, state)
  if (entries.length !== 1 || entries[0].type !== 'avc1') throw new Error('invalid sample entry')
  const entry = entries[0]
  requireRange(entry.dataStart, 78, entry.end)
  const width = readU16(bytes, entry.dataStart + 24)
  const height = readU16(bytes, entry.dataStart + 26)
  const entryChildren = readBoxes(bytes, entry.dataStart + 78, entry.end, state)
  const configuration = requireSingleBox(entryChildren, 'avcC')
  const chromaFormatIdc = readAvcChromaFormat(bytes, configuration)
  return {type: entry.type, width, height, chromaFormatIdc}
}

function readAvcChromaFormat(bytes, configuration) {
  requireRange(configuration.dataStart, 8, configuration.end)
  if (bytes[configuration.dataStart] !== 1) throw new Error('invalid AVC config')
  const profile = bytes[configuration.dataStart + 1]
  const spsCount = bytes[configuration.dataStart + 5] & 0x1f
  if (spsCount < 1) throw new Error('missing SPS')
  const spsBytes = readU16(bytes, configuration.dataStart + 6)
  const spsStart = configuration.dataStart + 8
  requireRange(spsStart, spsBytes, configuration.end)
  const sps = bytes.subarray(spsStart, spsStart + spsBytes)
  if (sps.byteLength < 4 || (sps[0] & 0x1f) !== 7 || sps[1] !== profile) {
    throw new Error('invalid SPS')
  }
  const rbsp = removeEmulationPrevention(sps.subarray(1))
  const reader = new BitReader(rbsp)
  const profileIdc = reader.readBits(8)
  reader.readBits(8)
  reader.readBits(8)
  reader.readUnsignedExpGolomb()
  if (![100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc)) {
    return 1
  }
  return reader.readUnsignedExpGolomb()
}

function readSampleTiming(bytes, box) {
  requireRange(box.dataStart, 8, box.end)
  const entryCount = readU32(bytes, box.dataStart + 4)
  if (entryCount < 1 || entryCount > 1_024) throw new Error('invalid timing entries')
  requireRange(box.dataStart + 8, entryCount * 8, box.end)
  let sampleCount = 0
  let duration = 0
  for (let index = 0; index < entryCount; index += 1) {
    const offset = box.dataStart + 8 + (index * 8)
    const count = readU32(bytes, offset)
    const delta = readU32(bytes, offset + 4)
    if (count === 0 || delta === 0) throw new Error('invalid timing entry')
    sampleCount = safeAdd(sampleCount, count)
    duration = safeAdd(duration, safeMultiply(count, delta))
  }
  return {sampleCount, duration}
}

function readSampleCount(bytes, box) {
  requireRange(box.dataStart, 12, box.end)
  const constantSize = readU32(bytes, box.dataStart + 4)
  const count = readU32(bytes, box.dataStart + 8)
  if (count < 1) throw new Error('invalid sample count')
  if (constantSize === 0) requireRange(box.dataStart + 12, count * 4, box.end)
  return count
}

function readTrackDuration(bytes, trackChildren, movieTimescale, state) {
  const edit = requireSingleBox(trackChildren, 'edts')
  const editChildren = readBoxes(bytes, edit.dataStart, edit.end, state)
  const list = requireSingleBox(editChildren, 'elst')
  requireRange(list.dataStart, 12, list.end)
  const version = bytes[list.dataStart]
  if (readU32(bytes, list.dataStart + 4) !== 1) throw new Error('invalid edit list')
  const duration = version === 0
    ? readU32(bytes, list.dataStart + 8)
    : version === 1 ? readU64(bytes, list.dataStart + 8) : 0
  if (duration < 1 || movieTimescale < 1) throw new Error('invalid track duration')
  return duration
}

function readTimescale(bytes, box) {
  requireRange(box.dataStart, 20, box.end)
  const version = bytes[box.dataStart]
  const offset = version === 0 ? box.dataStart + 12 : version === 1 ? box.dataStart + 20 : -1
  if (offset < 0) throw new Error('invalid media header')
  requireRange(offset, 4, box.end)
  const timescale = readU32(bytes, offset)
  if (timescale < 1) throw new Error('invalid timescale')
  return timescale
}

function readBoxes(bytes, start, end, state) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 0 || end < start || end > bytes.byteLength) throw new Error('invalid box range')
  const boxes = []
  let offset = start
  while (offset < end) {
    requireRange(offset, 8, end)
    const size32 = readU32(bytes, offset)
    let size = size32
    let headerBytes = 8
    if (size32 === 1) {
      requireRange(offset, 16, end)
      size = readU64(bytes, offset + 8)
      headerBytes = 16
    } else if (size32 === 0) {
      size = end - offset
    }
    if (!Number.isSafeInteger(size) || size < headerBytes || size > end - offset) {
      throw new Error('invalid box size')
    }
    state.boxes += 1
    if (state.boxes > MAX_MP4_BOXES) throw new Error('too many boxes')
    const boxEnd = offset + size
    boxes.push(Object.freeze({
      type: asciiType(bytes, offset + 4),
      dataStart: offset + headerBytes,
      end: boxEnd,
    }))
    offset = boxEnd
  }
  if (offset !== end) throw new Error('invalid box boundary')
  return boxes
}

function requireSingleBox(boxes, type) {
  const matched = boxes.filter(box => box.type === type)
  if (matched.length !== 1) throw new Error('required box missing')
  return matched[0]
}

function asciiType(bytes, offset) {
  requireRange(offset, 4, bytes.byteLength)
  let value = ''
  for (let index = 0; index < 4; index += 1) {
    const code = bytes[offset + index]
    if (code < 0x20 || code > 0x7e) throw new Error('invalid box type')
    value += String.fromCharCode(code)
  }
  return value
}

function readU16(bytes, offset) {
  requireRange(offset, 2, bytes.byteLength)
  return (bytes[offset] * 0x100) + bytes[offset + 1]
}

function readU32(bytes, offset) {
  requireRange(offset, 4, bytes.byteLength)
  return ((bytes[offset] * 0x1000000)
    + (bytes[offset + 1] * 0x10000)
    + (bytes[offset + 2] * 0x100)
    + bytes[offset + 3])
}

function readU64(bytes, offset) {
  const high = readU32(bytes, offset)
  const low = readU32(bytes, offset + 4)
  const value = (high * 0x100000000) + low
  if (!Number.isSafeInteger(value)) throw new Error('unsafe 64-bit integer')
  return value
}

function requireRange(offset, count, end) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(count)
    || offset < 0 || count < 0 || offset > end || count > end - offset) {
    throw new Error('out of bounds')
  }
}

function safeAdd(left, right) {
  const result = left + right
  if (!Number.isSafeInteger(result)) throw new Error('unsafe integer')
  return result
}

function safeMultiply(left, right) {
  const result = left * right
  if (!Number.isSafeInteger(result)) throw new Error('unsafe integer')
  return result
}

function removeEmulationPrevention(input) {
  const output = []
  for (let index = 0; index < input.byteLength; index += 1) {
    if (index >= 2 && input[index] === 0x03
      && input[index - 1] === 0x00 && input[index - 2] === 0x00) continue
    output.push(input[index])
  }
  return new Uint8Array(output)
}

class BitReader {
  #bytes
  #bitOffset = 0

  constructor(bytes) { this.#bytes = bytes }

  readBits(count) {
    if (!Number.isSafeInteger(count) || count < 1 || count > 32
      || this.#bitOffset + count > this.#bytes.byteLength * 8) throw new Error('invalid SPS')
    let value = 0
    for (let index = 0; index < count; index += 1) {
      const byteOffset = Math.floor(this.#bitOffset / 8)
      const shift = 7 - (this.#bitOffset % 8)
      value = (value * 2) + ((this.#bytes[byteOffset] >>> shift) & 1)
      this.#bitOffset += 1
    }
    return value
  }

  readUnsignedExpGolomb() {
    let leadingZeros = 0
    while (this.readBits(1) === 0) {
      leadingZeros += 1
      if (leadingZeros > 30) throw new Error('invalid SPS')
    }
    const suffix = leadingZeros === 0 ? 0 : this.readBits(leadingZeros)
    return (2 ** leadingZeros) - 1 + suffix
  }
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
