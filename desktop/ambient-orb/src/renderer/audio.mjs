const MAX_HEADER_BYTES = 2048
const MAX_PCM_BYTES = 64 * 1024
const DEFAULT_MAX_QUEUED_BYTES = 256 * 1024
const DEFAULT_AUDIO_RESUME_TIMEOUT_MS = 250

export async function resumeAudioContextWithWatchdog(context, {
  timeoutMs = DEFAULT_AUDIO_RESUME_TIMEOUT_MS,
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancel = handle => clearTimeout(handle),
} = {}) {
  if (context.state === 'running') return
  let timeoutHandle = null
  const timeout = new Promise((resolve, reject) => {
    timeoutHandle = schedule(
      () => reject(new Error('Web Audio playback is unavailable')),
      timeoutMs,
    )
  })
  try {
    await Promise.race([context.resume(), timeout])
  } finally {
    if (timeoutHandle !== null) cancel(timeoutHandle)
  }
  if (context.state !== 'running') throw new Error('Web Audio playback is unavailable')
}

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
    hangoverMs = ONSET_HANGOVER_MS, refreshMs = ONSET_REFRESH_MS,
    clock = () => performance.now(), schedule = (callback, delay) => setTimeout(callback, delay),
    cancel = handle => clearTimeout(handle), onInactive = null } = {}) {
    this.mintId = mintId
    this.level = level
    this.attackMs = attackMs
    this.hangoverMs = hangoverMs
    this.refreshMs = refreshMs
    this.clock = clock
    this.schedule = schedule
    this.cancel = cancel
    this.onInactive = typeof onInactive === 'function' ? onInactive : null
    this.idleTimer = null
    this.active = false
    this.candidateMs = 0
    this.speechId = null
    this.lastSpeechAt = 0
    this.lastSentAt = 0
  }

  // The attack window, surfaced for the orb: speech is over the threshold but
  // has not held for `attackMs` yet, which is exactly the 'candidate' state.
  // A read-only view of the same counter `observe` thresholds — no new
  // thresholds, and nothing here can change the verdict.
  get pending() {
    return !this.active && this.candidateMs > 0
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
        this.#armIdleDeadline()
        return { type: 'onset', speechId: this.speechId }
      }
      this.#armIdleDeadline()
      if (now - this.lastSentAt >= this.refreshMs) {
        this.lastSentAt = now
        return { type: 'refresh', speechId: this.speechId }
      }
      return null
    }
    this.candidateMs = 0
    if (this.active && now - this.lastSpeechAt > this.hangoverMs) {
      this.active = false
      this.#clearIdleDeadline()
    }
    return null
  }

  reset() {
    this.#clearIdleDeadline()
    this.active = false
    this.candidateMs = 0
    this.speechId = null
  }

  #armIdleDeadline() {
    if (!this.active || this.onInactive === null || this.idleTimer !== null) return
    const remaining = this.hangoverMs - (this.clock() - this.lastSpeechAt)
    this.idleTimer = this.schedule(() => {
      this.idleTimer = null
      const now = this.clock()
      if (this.active && now - this.lastSpeechAt > this.hangoverMs) {
        this.active = false
        this.candidateMs = 0
        this.onInactive()
      } else {
        this.#armIdleDeadline()
      }
    }, Math.max(1, remaining + 1))
  }

  #clearIdleDeadline() {
    if (this.idleTimer === null) return
    const timer = this.idleTimer
    this.idleTimer = null
    this.cancel(timer)
  }
}

function pcmSampleCount(pcm) {
  if (!(pcm instanceof Uint8Array) || !pcm.byteLength || pcm.byteLength % 2) {
    throw new Error('capture PCM16 is invalid')
  }
  return pcm.byteLength / 2
}

// The onset detector and the orb's amplitude meter want the same thing — the
// RMS of each 10 ms window of a frame — so the loop lives here once and callers
// only decide what a window's level means to them.
function eachPcmWindowLevel(pcm, sampleCount, visit) {
  const samplesPerWindow = CAPTURE_SAMPLE_RATE * ONSET_WINDOW_MS / 1000
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  for (let start = 0; start < sampleCount; start += samplesPerWindow) {
    const end = Math.min(sampleCount, start + samplesPerWindow)
    let power = 0
    for (let index = start; index < end; index += 1) {
      const sample = view.getInt16(index * 2, true) / 0x8000
      power += sample * sample
    }
    visit(Math.sqrt(power / (end - start)), start, end)
  }
}

export function observePcmOnset(pcm, tracker, now) {
  const sampleCount = pcmSampleCount(pcm)
  const frameMs = sampleCount / CAPTURE_SAMPLE_RATE * 1000
  let verdict = null
  eachPcmWindowLevel(pcm, sampleCount, (level, start, end) => {
    const durationMs = (end - start) / CAPTURE_SAMPLE_RATE * 1000
    const windowEnd = now - frameMs + end / CAPTURE_SAMPLE_RATE * 1000
    const observed = tracker.observe(level, windowEnd, durationMs)
    if (verdict === null && observed !== null) verdict = observed
  })
  return verdict
}

// The loudest window rather than the frame-wide RMS: the orb should light up on
// the same evidence the onset detector thresholds, so a single loud syllable in
// an otherwise quiet frame reads as speech in the visual too.
export function measurePcmLevel(pcm) {
  const sampleCount = pcmSampleCount(pcm)
  let peak = 0
  eachPcmWindowLevel(pcm, sampleCount, level => {
    if (level > peak) peak = level
  })
  return peak
}

// The frame-wide RMS rather than the loudest window: unlike the mic path above,
// a provider playback frame can span hundreds of milliseconds, so holding its
// loudest instant flat for the whole frame would flatten syllable dynamics into
// a high-biased staircase. This recomposes eachPcmWindowLevel's per-window RMS
// back into one frame RMS by weighting each window's power by its own sample
// count (the last window in a frame can be shorter than the rest), which is the
// same total-sum-of-squares-over-total-samples RMS as measuring the whole frame
// in one pass.
export function measurePcmFrameLevel(pcm) {
  const sampleCount = pcmSampleCount(pcm)
  let power = 0
  eachPcmWindowLevel(pcm, sampleCount, (level, start, end) => {
    power += level * level * (end - start)
  })
  return Math.sqrt(power / sampleCount)
}

const ANALYSER_FFT_SIZE = 256
const BYTE_TIME_DOMAIN_ZERO = 128

export class OutputMuteController {
  constructor({ apply, onChange = () => {}, muted = false }) {
    if (typeof apply !== 'function') throw new TypeError('apply must be a function')
    this.apply = apply
    this.onChange = onChange
    this.muted = muted === true
    this.pending = false
  }

  async toggle() {
    if (this.pending) return false
    const previousMuted = this.muted
    this.muted = !previousMuted
    this.pending = true
    this.onChange(this.muted, this.pending)
    let accepted = false
    try {
      accepted = await this.apply(this.muted) === true
    } catch { /* the confirmed state below remains authoritative */ }
    if (!accepted) this.muted = previousMuted
    this.pending = false
    this.onChange(this.muted, this.pending)
    return accepted
  }
}

// Amplitude of what the user is actually hearing, for the browser playback path.
// Every buffer source connects to one master gain at unity — the mix is
// untouched — and that gain feeds an analyser before the speakers. Reading the
// time domain rather than the frequency bins keeps this an amplitude meter and
// not a spectrum: the orb only ever asks "how loud".
export class PlaybackMeter {
  constructor(context, isPlaying = () => true) {
    this.isPlaying = isPlaying
    this.muted = false
    this.gain = context.createGain()
    this.gain.gain.value = 1
    this.analyser = context.createAnalyser()
    this.analyser.fftSize = ANALYSER_FFT_SIZE
    this.samples = new Uint8Array(ANALYSER_FFT_SIZE)
    this.gain.connect(this.analyser)
    this.analyser.connect(context.destination)
  }

  get destination() {
    return this.gain
  }

  setMuted(muted) {
    this.muted = muted === true
    this.gain.gain.value = this.muted ? 0 : 1
  }

  // An analyser keeps returning the tail of its last window forever, so a
  // drained queue has to read as silence from the caller's own bookkeeping
  // rather than from the node.
  level() {
    if (this.muted || !this.isPlaying()) return 0
    this.analyser.getByteTimeDomainData(this.samples)
    let power = 0
    for (let index = 0; index < this.samples.length; index += 1) {
      const sample = (this.samples[index] - BYTE_TIME_DOMAIN_ZERO) / BYTE_TIME_DOMAIN_ZERO
      power += sample * sample
    }
    return Math.min(1, Math.sqrt(power / this.samples.length))
  }
}

// The native backend plays PCM out of process, where there is no analyser to
// read. Each frame's amplitude is measured where it is dispatched and replayed
// on a wall-clock queue, which is what the speaker is doing a few milliseconds
// later — close enough for a visual, and it costs nothing per frame.
export class NativeLevelEnvelope {
  constructor() {
    this.segments = []
    this.cursor = 0
  }

  push(pcm, now) {
    // A hidden window (tray toggle) stops the visual tick that would otherwise
    // drain level(now), but playback keeps dispatching frames — so push also
    // drains anything that has already finished playing, keeping the queue
    // bounded to whatever is still audible instead of the whole hidden period.
    while (this.segments.length && this.segments[0].endAt <= now) this.segments.shift()
    // measurePcmFrameLevel windows at the capture rate, which at the 24 kHz
    // playback rate is a slightly shorter window — an amplitude, not a
    // duration, so the reading is unaffected.
    const level = measurePcmFrameLevel(pcm)
    const startAt = Math.max(now, this.cursor)
    const endAt = startAt + pcm.byteLength / PCM_BYTES_PER_MS
    this.segments.push({ startAt, endAt, level })
    this.cursor = endAt
  }

  level(now) {
    while (this.segments.length && this.segments[0].endAt <= now) this.segments.shift()
    const segment = this.segments[0]
    if (!segment || segment.startAt > now) return 0
    return segment.level
  }

  clear() {
    this.segments.length = 0
    this.cursor = 0
  }
}

export function playbackTelemetryControl(event, rejectionMetrics = null) {
  return {
    type: 'playback.telemetry',
    utterance_id: event.utteranceId,
    generation_epoch: event.generationEpoch,
    final: event.final,
    window_ms: event.windowMs,
    queued_samples: event.queuedSamples,
    queued_samples_max: event.queuedSamplesMax,
    underrun_samples: event.underrunSamples,
    underrun_callbacks: event.underrunCallbacks,
    max_consecutive_underrun_samples: event.maxConsecutiveUnderrunSamples,
    render_callbacks: event.renderCallbacks,
    max_callback_us: event.maxCallbackUs,
    frame_gap_ms_max: event.frameGapMsMax,
    pcm_near_silence_ms_max: event.pcmNearSilenceMsMax,
    sequence_gaps: rejectionMetrics?.sequenceGaps ?? 0,
    rejected_frames: rejectionMetrics?.rejectedFrames ?? 0,
    stdin_buffered_bytes_max: event.stdinBufferedBytesMax,
    stdin_backpressure_count: event.stdinBackpressureCount,
    stdin_drain_ms_max: event.stdinDrainMsMax,
  }
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
    this.telemetry = new Map()
  }

  accept(frame, backend = 'browser') {
    if (!['browser', 'native'].includes(backend)) return this.#reject(frame, false)
    if (!frame || frame.generationEpoch <= this.fencedEpoch) return this.#reject(frame, false)
    if (this.current === null) {
      if (frame.sequence !== 0) return this.#reject(frame, true)
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
      this.#metrics(frame)
    }
    const sameGeneration = frame.utteranceId === this.current.utteranceId
      && frame.generationEpoch === this.current.generationEpoch
    if (!sameGeneration) return this.#reject(frame, false)
    if (frame.sequence !== this.current.nextSequence) return this.#reject(frame, true)
    if (backend !== this.current.backend) return this.#reject(frame, false)
    if (this.queuedBytes + frame.pcm.byteLength > this.maxQueuedBytes) {
      return this.#reject(frame, false)
    }
    this.current.nextSequence += 1
    this.queue.push(frame)
    this.queuedBytes += frame.pcm.byteLength
    return true
  }

  telemetryFor(utteranceId, generationEpoch, { final = false } = {}) {
    const key = `${utteranceId}:${generationEpoch}`
    const metrics = this.telemetry.get(key)
    if (!metrics) return null
    const snapshot = {...metrics}
    if (final) this.telemetry.delete(key)
    return snapshot
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

  disconnect() {
    if (!this.current) {
      this.queue = []
      this.queuedBytes = 0
      this.active.clear()
      return null
    }
    const generationEpoch = this.current.generationEpoch
    this.fencedEpoch = Math.max(this.fencedEpoch, generationEpoch)
    const inFlightMs = Number(this.stopAll()) || 0
    const playedMs = Math.round(this.playedMs + Math.max(0, inFlightMs))
    this.current = null
    this.queue = []
    this.queuedBytes = 0
    this.active.clear()
    this.providerTerminal = false
    this.acknowledged = false
    this.started = false
    this.playedMs = 0
    return {playedMs, generationEpoch}
  }

  backendExited() {
    const disconnected = this.disconnect()
    this.fencedEpoch = 0
    this.lastCompletion = null
    this.telemetry.clear()
    return disconnected
  }

  #matches(utteranceId, generationEpoch) {
    return Boolean(
      this.current
      && this.current.utteranceId === utteranceId
      && this.current.generationEpoch === generationEpoch,
    )
  }

  #metrics(frame) {
    const key = `${frame.utteranceId}:${frame.generationEpoch}`
    let metrics = this.telemetry.get(key)
    if (!metrics) {
      metrics = {rejectedFrames: 0, sequenceGaps: 0}
      this.telemetry.set(key, metrics)
      while (this.telemetry.size > 32) this.telemetry.delete(this.telemetry.keys().next().value)
    }
    return metrics
  }

  #reject(frame, sequenceGap) {
    if (!frame || typeof frame.utteranceId !== 'string' || !Number.isInteger(frame.generationEpoch)) {
      return false
    }
    const metrics = this.#metrics(frame)
    metrics.rejectedFrames += 1
    if (sequenceGap) metrics.sequenceGaps += 1
    return false
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

export async function admitBrowserPlayback(playback, frame, ensureRunning) {
  if (!playback.accept(frame, 'browser')) return {status: 'rejected'}
  try {
    await ensureRunning()
  } catch {
    const current = playback.current
    if (
      !current
      || current.utteranceId !== frame.utteranceId
      || current.generationEpoch !== frame.generationEpoch
    ) return {status: 'cleared'}
    const stopped = playback.clear(frame.utteranceId, frame.generationEpoch)
    return stopped
      ? {status: 'stopped', playedMs: stopped.playedMs}
      : {status: 'cleared'}
  }
  const current = playback.current
  if (
    !current
    || current.utteranceId !== frame.utteranceId
    || current.generationEpoch !== frame.generationEpoch
  ) return {status: 'cleared'}
  return {status: 'ready'}
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
