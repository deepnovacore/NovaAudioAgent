import { spawn } from 'node:child_process'

const MAX_PCM_BYTES = 64 * 1024
const MAX_LINE_BYTES = 100 * 1024
const NATIVE_CLEAR_TIMEOUT_MS = 250

export function startNativeAudio({ binary, spawnImpl = spawn, onEvent = () => {} }) {
  if (process.platform !== 'darwin') throw new Error('VoiceProcessingIO requires macOS')
  const child = spawnImpl(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let ready = false
  let closing = false
  let settled = false
  let clearSequence = 0
  const pendingClears = new Map()
  const completedPlayback = new Map()
  let resolveReady
  let rejectReady
  const readyPromise = new Promise((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  let resolveClosed
  const closedPromise = new Promise(resolve => { resolveClosed = resolve })
  const timer = setTimeout(() => {
    if (!settled) settle(new Error('VoiceProcessingIO readiness timed out'))
    child.kill('SIGTERM')
  }, 10_000)

  const settle = (error, value) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (error) rejectReady(error)
    else resolveReady(value)
  }
  const send = value => {
    if (!child.stdin.writable || child.stdin.destroyed) return false
    child.stdin.write(`${JSON.stringify(value)}\n`)
    return true
  }
  const settlePendingClear = (requestId, {
    renderedSamples = 0,
    includePlaybackEvidence = false,
  } = {}) => {
    const pendingClear = pendingClears.get(requestId)
    if (!pendingClear) return false
    pendingClears.delete(requestId)
    clearTimeout(pendingClear.timer)
    const key = `${pendingClear.utteranceId}:${pendingClear.generationEpoch}`
    const samples = includePlaybackEvidence
      ? Math.max(renderedSamples, completedPlayback.get(key) || 0)
      : renderedSamples
    if (includePlaybackEvidence) completedPlayback.delete(key)
    pendingClear.resolve(Object.freeze({ playedMs: Math.round(samples / 48) }))
    return true
  }
  const settlePendingClears = () => {
    for (const requestId of [...pendingClears.keys()]) settlePendingClear(requestId)
  }
  const handleLine = line => {
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) return
    let event
    try { event = JSON.parse(line) } catch { return }
    if (event.type === 'ready' && event.aecMode === 'voice_processing_io') {
      ready = true
      settle(null, event)
    } else if (event.type === 'error') {
      if (!ready) settle(new Error('VoiceProcessingIO unavailable'))
      onEvent({ type: 'error', code: 'voice_processing_unavailable' })
    } else if (event.type === 'audio' && typeof event.audio === 'string') {
      const pcm = Buffer.from(event.audio, 'base64')
      if (pcm.length && pcm.length <= MAX_PCM_BYTES && pcm.length % 2 === 0) {
        onEvent({ type: 'audio', pcm })
      }
    } else if (
      event.type === 'playback.cleared'
      && typeof event.requestId === 'string'
      && typeof event.utteranceId === 'string'
      && Number.isInteger(event.generationEpoch)
      && Number.isInteger(event.renderedSamples)
      && event.renderedSamples >= 0
    ) {
      const pendingClear = pendingClears.get(event.requestId)
      if (
        pendingClear
        && pendingClear.utteranceId === event.utteranceId
        && pendingClear.generationEpoch === event.generationEpoch
      ) {
        settlePendingClear(event.requestId, {
          renderedSamples: event.renderedSamples,
          includePlaybackEvidence: true,
        })
      }
    } else if (
      ['playback.started', 'playback.done'].includes(event.type)
      && typeof event.utteranceId === 'string'
      && Number.isInteger(event.generationEpoch)
      && event.generationEpoch > 0
    ) {
      const playbackEvent = {
        type: event.type,
        utteranceId: event.utteranceId,
        generationEpoch: event.generationEpoch,
      }
      if (
        event.type === 'playback.done'
        && Number.isInteger(event.renderedSamples)
        && event.renderedSamples >= 0
      ) {
        const key = `${event.utteranceId}:${event.generationEpoch}`
        completedPlayback.delete(key)
        completedPlayback.set(key, event.renderedSamples)
        while (completedPlayback.size > 32) {
          completedPlayback.delete(completedPlayback.keys().next().value)
        }
        playbackEvent.playedMs = Math.round(event.renderedSamples / 48)
      }
      onEvent(playbackEvent)
    }
  }
  child.stdout.on('data', chunk => {
    stdout += chunk.toString('utf8')
    if (Buffer.byteLength(stdout) > MAX_LINE_BYTES * 2) stdout = ''
    let newline
    while ((newline = stdout.indexOf('\n')) >= 0) {
      const line = stdout.slice(0, newline)
      stdout = stdout.slice(newline + 1)
      handleLine(line)
    }
  })
  child.on('error', () => {
    settlePendingClears()
    settle(new Error('VoiceProcessingIO failed to start'))
    resolveClosed()
  })
  child.on('close', () => {
    settlePendingClears()
    if (!ready) settle(new Error('VoiceProcessingIO exited before readiness'))
    else if (!closing) onEvent({ type: 'exit' })
    resolveClosed()
  })

  return readyPromise.then(status => ({
    status,
    setCaptureEnabled(enabled) {
      return send({ type: 'capture', enabled: enabled === true })
    },
    play(pcm, utteranceId, generationEpoch) {
      const bytes = Buffer.from(pcm)
      if (!bytes.length || bytes.length > MAX_PCM_BYTES || bytes.length % 2) return false
      completedPlayback.delete(`${utteranceId}:${generationEpoch}`)
      return send({
        type: 'play',
        audio: bytes.toString('base64'),
        utteranceId,
        generationEpoch,
      })
    },
    terminal(utteranceId, generationEpoch) {
      return send({ type: 'terminal', utteranceId, generationEpoch })
    },
    clear(utteranceId, generationEpoch) {
      if (typeof utteranceId !== 'string' || !Number.isInteger(generationEpoch)) {
        return send({ type: 'clear' })
      }
      const requestId = `clear-${++clearSequence}`
      return new Promise(resolve => {
        const pendingClear = {
          utteranceId,
          generationEpoch,
          resolve,
          timer: null,
        }
        pendingClears.set(requestId, pendingClear)
        pendingClear.timer = setTimeout(() => {
          if (settlePendingClear(requestId, { includePlaybackEvidence: true })) {
            onEvent({ type: 'error', code: 'native_clear_timeout' })
          }
        }, NATIVE_CLEAR_TIMEOUT_MS)
        if (!send({ type: 'clear', requestId, utteranceId, generationEpoch })) {
          settlePendingClear(requestId)
        }
      })
    },
    async close() {
      closing = true
      settlePendingClears()
      if (!send({ type: 'close' })) child.kill('SIGTERM')
      let closeTimer
      await Promise.race([
        closedPromise,
        new Promise(resolve => {
          closeTimer = setTimeout(() => {
            child.kill('SIGTERM')
            resolve()
          }, 2_000)
        }),
      ])
      clearTimeout(closeTimer)
    },
  }))
}

export function createNativeAudioManager({
  binary,
  startImpl = startNativeAudio,
  onEvent = () => {},
}) {
  let audio = null
  let pending = null

  const ensure = async () => {
    if (audio) return audio
    pending ||= startImpl({
      binary,
      onEvent: event => {
        if (event?.type === 'error' || event?.type === 'exit') {
          const failed = audio
          audio = null
          if (event.type === 'error' && failed) void failed.close()
        }
        onEvent(event)
      },
    })
    try {
      audio = await pending
      return audio
    } finally {
      pending = null
    }
  }

  const closeCurrent = async () => {
    const current = audio
    audio = null
    if (current) await current.close()
  }

  return Object.freeze({
    get ready() { return audio !== null },
    async activate() {
      try {
        const current = await ensure()
        if (!current.setCaptureEnabled(true)) throw new Error('native capture command failed')
        return Object.freeze({ audioMode: 'voice_processing_io' })
      } catch {
        await closeCurrent()
        return Object.freeze({ audioMode: 'browser_aec' })
      }
    },
    async deactivate() {
      await closeCurrent()
      return Object.freeze({ audioMode: 'inactive' })
    },
    play(pcm, utteranceId, generationEpoch) {
      return audio?.play(pcm, utteranceId, generationEpoch) === true
    },
    terminal(utteranceId, generationEpoch) {
      return audio?.terminal(utteranceId, generationEpoch) === true
    },
    clear(utteranceId, generationEpoch) {
      if (typeof utteranceId === 'string' && Number.isInteger(generationEpoch)) {
        return audio?.clear(utteranceId, generationEpoch)
          || Promise.resolve(Object.freeze({ playedMs: 0 }))
      }
      return audio?.clear() === true
    },
  })
}
