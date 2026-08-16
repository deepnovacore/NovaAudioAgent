const MAX_HEADER_BYTES = 2048
const MAX_PCM_BYTES = 64 * 1024
const DEFAULT_MAX_QUEUED_BYTES = 256 * 1024

export async function activateCaptureMode({
  nativeAvailable,
  activateNative,
  activateBrowser,
}) {
  if (nativeAvailable) {
    const result = await activateNative()
    if (result?.audioMode === 'voice_processing_io') return result
  }
  return activateBrowser()
}

export async function fallbackToBrowserCapture({
  state,
  activateBrowser,
  releaseBrowser,
}) {
  if (state.activationPending || !state.activated) return null
  state.activationPending = true
  try {
    const result = await activateBrowser()
    if (state.activated) return result
    releaseBrowser()
    return null
  } finally {
    state.activationPending = false
  }
}

export class CaptureAccumulator {
  constructor(frameLength = 512) {
    if (!Number.isInteger(frameLength) || frameLength < 1) {
      throw new Error('capture frame length is invalid')
    }
    this.frameLength = frameLength
    this.frame = new Float32Array(frameLength)
    this.offset = 0
  }

  push(inputs) {
    const samples = inputs?.[0]?.[0]
    if (!(samples instanceof Float32Array) || samples.length === 0) return []
    const batches = []
    let sourceOffset = 0
    while (sourceOffset < samples.length) {
      const amount = Math.min(
        samples.length - sourceOffset,
        this.frameLength - this.offset,
      )
      this.frame.set(samples.subarray(sourceOffset, sourceOffset + amount), this.offset)
      this.offset += amount
      sourceOffset += amount
      if (this.offset === this.frameLength) {
        batches.push(this.frame)
        this.frame = new Float32Array(this.frameLength)
        this.offset = 0
      }
    }
    return batches
  }
}

export function floatToPcm16(input, fromRate, toRate = 16_000) {
  if (!(input instanceof Float32Array) || input.length === 0) {
    throw new Error('capture samples are required')
  }
  if (!Number.isFinite(fromRate) || !Number.isFinite(toRate) || fromRate <= 0 || toRate <= 0) {
    throw new Error('sample rates are invalid')
  }
  const ratio = fromRate / toRate
  const length = Math.max(1, Math.round(input.length / ratio))
  const output = new Uint8Array(length * 2)
  const view = new DataView(output.buffer)
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio
    const before = Math.min(input.length - 1, Math.floor(position))
    const after = Math.min(input.length - 1, before + 1)
    const fraction = position - before
    const sample = Math.max(-1, Math.min(1, input[before] * (1 - fraction) + input[after] * fraction))
    const pcm = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff)
    view.setInt16(index * 2, pcm, true)
  }
  return output
}

export function decodeAudioFrame(value) {
  const raw = value instanceof Uint8Array ? value : new Uint8Array(value)
  if (raw.byteLength < 8) throw new Error('audio frame is truncated')
  const prefix = new TextDecoder('ascii').decode(raw.subarray(0, 4))
  if (prefix !== 'NOVA') throw new Error('audio frame magic is invalid')
  const headerSize = new DataView(raw.buffer, raw.byteOffset + 4, 2).getUint16(0, false)
  if (headerSize < 2 || headerSize > MAX_HEADER_BYTES || 6 + headerSize >= raw.byteLength) {
    throw new Error('audio frame header is invalid')
  }
  let header
  try {
    header = JSON.parse(new TextDecoder().decode(raw.subarray(6, 6 + headerSize)))
  } catch {
    throw new Error('audio frame header is invalid')
  }
  const pcm = raw.slice(6 + headerSize)
  if (!pcm.byteLength || pcm.byteLength % 2 || pcm.byteLength > MAX_PCM_BYTES) {
    throw new Error('audio frame PCM16 is invalid')
  }
  if (
    typeof header.utterance_id !== 'string'
    || !header.utterance_id
    || !Number.isInteger(header.generation_epoch)
    || header.generation_epoch < 1
    || !Number.isInteger(header.sequence)
    || header.sequence < 0
  ) {
    throw new Error('audio frame identity is invalid')
  }
  return Object.freeze({
    utteranceId: header.utterance_id,
    generationEpoch: header.generation_epoch,
    sequence: header.sequence,
    pcm,
  })
}

const PCM_BYTES_PER_MS = 48
const CAPTURE_SAMPLE_RATE = 16_000
const ONSET_WINDOW_MS = 10
const ONSET_LEVEL = 0.045
const ONSET_ATTACK_MS = 50
const ONSET_HANGOVER_MS = 180
const ONSET_REFRESH_MS = 10_000

export class OnsetTracker {
  // One utterance = one speech id. Continuous speech re-sends the SAME id as a
  // periodic detector/telemetry refresh; provider VAD alone owns Floor hold.
  // A new id is minted only after the local hangover expires.
  constructor({ mintId, level = ONSET_LEVEL, attackMs = ONSET_ATTACK_MS,
    hangoverMs = ONSET_HANGOVER_MS, refreshMs = ONSET_REFRESH_MS } = {}) {
    this.mintId = mintId
    this.level = level
    this.attackMs = attackMs
    this.hangoverMs = hangoverMs
    this.refreshMs = refreshMs
    this.active = false
    this.candidateMs = 0
    this.speechId = null
    this.lastSpeechAt = 0
    this.lastSentAt = 0
  }

  observe(level, now, durationMs = 0) {
    if (level >= this.level) {
      this.lastSpeechAt = now
      if (!this.active) {
        this.candidateMs += Math.max(0, durationMs)
        if (this.candidateMs < this.attackMs) return null
        this.active = true
        this.candidateMs = 0
        this.speechId = this.mintId()
        this.lastSentAt = now
        return { type: 'onset', speechId: this.speechId }
      }
      if (now - this.lastSentAt >= this.refreshMs) {
        this.lastSentAt = now
        return { type: 'refresh', speechId: this.speechId }
      }
      return null
    }
    this.candidateMs = 0
    if (this.active && now - this.lastSpeechAt > this.hangoverMs) {
      this.active = false
    }
    return null
  }

  reset() {
    this.active = false
    this.candidateMs = 0
    this.speechId = null
  }
}

export function observePcmOnset(pcm, tracker, now) {
  if (!(pcm instanceof Uint8Array) || !pcm.byteLength || pcm.byteLength % 2) {
    throw new Error('capture PCM16 is invalid')
  }
  const sampleCount = pcm.byteLength / 2
  const samplesPerWindow = CAPTURE_SAMPLE_RATE * ONSET_WINDOW_MS / 1000
  const frameMs = sampleCount / CAPTURE_SAMPLE_RATE * 1000
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  let verdict = null
  for (let start = 0; start < sampleCount; start += samplesPerWindow) {
    const end = Math.min(sampleCount, start + samplesPerWindow)
    let power = 0
    for (let index = start; index < end; index += 1) {
      const sample = view.getInt16(index * 2, true) / 0x8000
      power += sample * sample
    }
    const durationMs = (end - start) / CAPTURE_SAMPLE_RATE * 1000
    const level = Math.sqrt(power / (end - start))
    const windowEnd = now - frameMs + end / CAPTURE_SAMPLE_RATE * 1000
    const observed = tracker.observe(level, windowEnd, durationMs)
    if (verdict === null && observed !== null) verdict = observed
  }
  return verdict
}

export class GenerationPlayback {
  constructor({ maxQueuedBytes = DEFAULT_MAX_QUEUED_BYTES, stopAll = () => {} } = {}) {
    this.maxQueuedBytes = maxQueuedBytes
    this.stopAll = stopAll
    this.fencedEpoch = 0
    this.current = null
    this.queue = []
    this.queuedBytes = 0
    this.active = new Set()
    this.providerTerminal = false
    this.acknowledged = false
    this.started = false
    this.playedMs = 0
    this.lastCompletion = null
  }

  accept(frame, backend = 'browser') {
    if (!['browser', 'native'].includes(backend)) return false
    if (!frame || frame.generationEpoch <= this.fencedEpoch) return false
    if (this.current === null) {
      if (frame.sequence !== 0) return false
      this.current = {
        utteranceId: frame.utteranceId,
        generationEpoch: frame.generationEpoch,
        nextSequence: 0,
        backend,
      }
      this.providerTerminal = false
      this.acknowledged = false
      this.started = false
      this.playedMs = 0
    }
    if (
      frame.utteranceId !== this.current.utteranceId
      || frame.generationEpoch !== this.current.generationEpoch
      || frame.sequence !== this.current.nextSequence
      || backend !== this.current.backend
      || this.queuedBytes + frame.pcm.byteLength > this.maxQueuedBytes
    ) return false
    this.current.nextSequence += 1
    this.queue.push(frame)
    this.queuedBytes += frame.pcm.byteLength
    return true
  }

  dequeue() {
    const frame = this.queue.shift() || null
    if (frame) {
      this.queuedBytes -= frame.pcm.byteLength
      this.active.add(frame)
    }
    return frame
  }

  markStarted() {
    if (!this.current || this.started) return null
    this.started = true
    return {
      type: 'playback.started',
      utterance_id: this.current.utteranceId,
      generation_epoch: this.current.generationEpoch,
    }
  }

  markProviderTerminal(utteranceId, generationEpoch) {
    if (!this.#matches(utteranceId, generationEpoch)) return null
    this.providerTerminal = true
    return this.#completion()
  }

  frameEnded(frame) {
    if (!this.active.delete(frame)) return null
    this.playedMs += frame.pcm.byteLength / PCM_BYTES_PER_MS
    return this.#completion()
  }

  clear(utteranceId, generationEpoch) {
    if (!this.current) {
      this.fencedEpoch = Math.max(this.fencedEpoch, generationEpoch)
      return null
    }
    if (!this.#matches(utteranceId, generationEpoch)) return null
    this.fencedEpoch = Math.max(this.fencedEpoch, generationEpoch)
    const inFlightMs = Number(this.stopAll()) || 0
    const playedMs = Math.round(this.playedMs + Math.max(0, inFlightMs))
    this.current = null
    this.queue = []
    this.queuedBytes = 0
    this.active.clear()
    this.providerTerminal = false
    this.started = false
    this.playedMs = 0
    return { playedMs }
  }

  #matches(utteranceId, generationEpoch) {
    return Boolean(
      this.current
      && this.current.utteranceId === utteranceId
      && this.current.generationEpoch === generationEpoch,
    )
  }

  #completion() {
    if (
      !this.current
      || !this.providerTerminal
      || this.queue.length
      || this.active.size
      || this.acknowledged
    ) return null
    this.acknowledged = true
    const acknowledgement = {
      type: 'playback.done',
      utterance_id: this.current.utteranceId,
      generation_epoch: this.current.generationEpoch,
      played_ms: Math.round(this.playedMs),
    }
    this.lastCompletion = acknowledgement
    this.current = null
    return acknowledgement
  }
}

export async function applyAlertCommand(playback, message, { startTone, clearNative }) {
  const hasUtterance = Object.hasOwn(message, 'utterance_id')
  const hasGeneration = Object.hasOwn(message, 'generation_epoch')
  if (hasUtterance !== hasGeneration) throw new Error('alert identity must be complete')
  if (
    hasUtterance
    && (
      typeof message.utterance_id !== 'string'
      || !message.utterance_id
      || !Number.isInteger(message.generation_epoch)
      || message.generation_epoch < 1
    )
  ) throw new Error('alert identity is invalid')

  let cleared = null
  let playedMs = 0
  let nativeClear = null
  if (hasUtterance) {
    const native = Boolean(
      playback.current
      && playback.current.utteranceId === message.utterance_id
      && playback.current.generationEpoch === message.generation_epoch
      && playback.current.backend === 'native'
    )
    cleared = playback.clear(message.utterance_id, message.generation_epoch)
    if (cleared) {
      playedMs = cleared.playedMs
      if (native) {
        nativeClear = clearNative(
          message.utterance_id,
          message.generation_epoch,
        )
      }
    } else if (
      playback.lastCompletion
      && playback.lastCompletion.utterance_id === message.utterance_id
      && playback.lastCompletion.generation_epoch === message.generation_epoch
    ) {
      playedMs = playback.lastCompletion.played_ms
    }
  }
  startTone()
  if (nativeClear) {
    const evidence = await nativeClear
    playedMs = Math.max(playedMs, Number(evidence?.playedMs) || 0)
  }
  return { cleared: Boolean(cleared), playedMs }
}

export class AlertTone {
  constructor() {
    this.oscillator = null
    this.gain = null
  }

  play(context) {
    this.stop()
    const now = context.currentTime
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(880, now)
    gain.gain.setValueAtTime(0, now)
    gain.gain.linearRampToValueAtTime(0.18, now + 0.01)
    gain.gain.linearRampToValueAtTime(0, now + 0.100)
    oscillator.connect(gain)
    gain.connect(context.destination)
    this.oscillator = oscillator
    this.gain = gain
    oscillator.onended = () => {
      if (this.oscillator !== oscillator) return
      oscillator.disconnect()
      gain.disconnect()
      this.oscillator = null
      this.gain = null
    }
    oscillator.start(now)
    oscillator.stop(now + 0.100)
  }

  stop() {
    const oscillator = this.oscillator
    const gain = this.gain
    if (!oscillator) return
    this.oscillator = null
    this.gain = null
    oscillator.onended = null
    try { oscillator.stop() } catch { /* already stopped */ }
    oscillator.disconnect()
    gain?.disconnect()
  }
}
