import {
  activateCaptureMode,
  AlertTone,
  applyAlertCommand,
  decodeAudioFrame,
  fallbackToBrowserCapture,
  floatToPcm16,
  GenerationPlayback,
  observePcmOnset,
  OnsetTracker,
} from './audio.mjs'
import { OrbDragGesture } from './drag-gesture.mjs'
import { deriveOrbState } from './state.mjs'

const shell = document.querySelector('#shell')
const orb = document.querySelector('#orb')
const stateLabel = document.querySelector('#state-label')
const codexLabel = document.querySelector('#codex-label')
const aecLabel = document.querySelector('#aec-label')
const captionLabel = document.querySelector('#caption')

const axes = {
  booting: true,
  activated: false,
  capture: 'idle',
  playback: 'idle',
  codex: 'idle',
  connected: false,
  permission: 'unknown',
  error: '',
  shellExpanded: false,
  audioMode: 'inactive',
  activationPending: false,
}

let socket
let context
let media
let processor
let source
let workletLoaded = false
let nativeAvailable = false
let nativeReady = false
let playbackCursor = 0
let socketMessageTail = Promise.resolve()
const playingSources = new Set()
const nativeFrames = new Map()
const dragGesture = new OrbDragGesture()

const onsetTracker = new OnsetTracker({ mintId: () => crypto.randomUUID() })
const alertTone = new AlertTone()

const playback = new GenerationPlayback({
  stopAll: () => {
    let inFlightMs = 0
    for (const node of playingSources) {
      if (context && typeof node.novaStartAt === 'number') {
        const elapsed = (context.currentTime - node.novaStartAt) * 1000
        const duration = (node.buffer?.duration ?? 0) * 1000
        inFlightMs += Math.max(0, Math.min(elapsed, duration))
      }
      try { node.stop() } catch { /* already stopped */ }
    }
    playingSources.clear()
    playbackCursor = 0
    return inFlightMs
  },
})

function render() {
  const state = deriveOrbState(axes)
  shell.dataset.state = state.name
  stateLabel.textContent = state.label
  codexLabel.textContent = state.codexLabel
  aecLabel.textContent = state.aecLabel
  orb.setAttribute('aria-label', `${state.label}；${state.codexLabel}`)
  orb.setAttribute('aria-pressed', String(axes.activated))
}

function send(value) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value))
}

function startAlertTone() {
  try {
    context ||= new AudioContext()
    if (context.state !== 'running') void context.resume().catch(() => {})
    alertTone.play(context)
  } catch { /* the concrete Guard speech still follows */ }
}

function scheduleFrames() {
  if (!context) return
  let frame
  while ((frame = playback.dequeue())) {
    const samples = new Float32Array(frame.pcm.byteLength / 2)
    const view = new DataView(frame.pcm.buffer, frame.pcm.byteOffset, frame.pcm.byteLength)
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = view.getInt16(index * 2, true) / 0x8000
    }
    const buffer = context.createBuffer(1, samples.length, 24_000)
    buffer.copyToChannel(samples, 0)
    const node = context.createBufferSource()
    node.buffer = buffer
    node.connect(context.destination)
    playingSources.add(node)
    axes.playback = 'speaking'
    render()
    node.onended = () => {
      playingSources.delete(node)
      const acknowledgement = playback.frameEnded(frame)
      if (acknowledgement) send({ ...acknowledgement, t_render_ms: performance.now() })
      if (!playingSources.size) axes.playback = 'idle'
      render()
    }
    const startAt = Math.max(context.currentTime + 0.02, playbackCursor)
    playbackCursor = startAt + buffer.duration
    node.novaStartAt = startAt
    node.start(startAt)
    if (!playback.started) {
      // Report start at audibility, not at scheduling: a barge-in inside the
      // scheduling lead must not turn silence into "interrupted" evidence.
      const generation = playback.current
      const delayMs = Math.max(0, (startAt - context.currentTime) * 1000)
      setTimeout(() => {
        if (playback.current === generation) {
          const started = playback.markStarted()
          if (started) {
            send({
              ...started,
              t_render_ms: performance.now(),
              context_time: context.currentTime,
              start_at: startAt,
            })
          }
        }
      }, delayMs)
    }
  }
}

async function ensurePlaybackContext() {
  context ||= new AudioContext()
  if (context.state !== 'running') await context.resume()
  if (context.state !== 'running') throw new Error('Web Audio playback is unavailable')
}

function detectLocalOnset(pcm) {
  const now = performance.now()
  const verdict = observePcmOnset(pcm, onsetTracker, now)
  axes.capture = onsetTracker.active ? 'listening' : 'idle'
  if (verdict) {
    alertTone.stop()
    send({ type: 'speech.onset', speech_id: verdict.speechId, t_render_ms: now })
  }
  render()
}

function scheduleNativeFrames() {
  let frame
  while ((frame = playback.dequeue())) {
    const key = `${frame.utteranceId}:${frame.generationEpoch}`
    const frames = nativeFrames.get(key) || []
    frames.push(frame)
    nativeFrames.set(key, frames)
    window.novaAudioAgentDesktop.nativeAudio.play(
      frame.pcm,
      frame.utteranceId,
      frame.generationEpoch,
    )
  }
}

async function activateCapture() {
  if (axes.activated) return deactivateCapture()
  if (axes.activationPending) return
  axes.activationPending = true
  try {
    const result = await activateCaptureMode({
      nativeAvailable,
      activateNative: async () => {
        const selected = await window.novaAudioAgentDesktop.nativeAudio.setCaptureEnabled(true)
        nativeReady = selected.audioMode === 'voice_processing_io'
        return selected
      },
      activateBrowser: startBrowserCapture,
    })
    axes.audioMode = result.audioMode
    axes.activated = true
    axes.permission = 'granted'
    axes.error = ''
  } catch {
    nativeReady = false
    axes.permission = 'denied'
  } finally {
    axes.activationPending = false
  }
  render()
}

async function startBrowserCapture() {
  await ensurePlaybackContext()
  const nextMedia = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  try {
    if (!workletLoaded) {
      await context.audioWorklet.addModule('nova://orb/capture-worklet.mjs')
      workletLoaded = true
    }
    const nextSource = context.createMediaStreamSource(nextMedia)
    const nextProcessor = new AudioWorkletNode(context, 'nova-capture')
    nextProcessor.port.onmessage = event => {
      if (!axes.activated || socket?.readyState !== WebSocket.OPEN) return
      const samples = event.data
      if (!(samples instanceof Float32Array) || !samples.length) return
      const pcm = floatToPcm16(samples, context.sampleRate)
      socket.send(pcm)
      detectLocalOnset(pcm)
    }
    nextSource.connect(nextProcessor)
    nextProcessor.connect(context.destination)
    media = nextMedia
    source = nextSource
    processor = nextProcessor
  } catch (error) {
    nextMedia.getTracks().forEach(track => track.stop())
    throw error
  }
  return Object.freeze({ audioMode: 'browser_aec' })
}

function releaseBrowserCapture() {
  media?.getTracks().forEach(track => track.stop())
  processor?.disconnect()
  source?.disconnect()
  media = processor = source = null
}

function stopCurrentNativePlayback() {
  const current = playback.current
  if (!current || current.backend !== 'native') return
  const { utteranceId, generationEpoch } = current
  const cleared = playback.clear(utteranceId, generationEpoch)
  nativeFrames.clear()
  window.novaAudioAgentDesktop.nativeAudio.clear()
  send({
    type: 'playback.stopped',
    utterance_id: utteranceId,
    generation_epoch: generationEpoch,
    played_ms: cleared ? cleared.playedMs : 0,
  })
}

async function deactivateCapture() {
  if (axes.activationPending) {
    axes.activated = false
    axes.permission = 'unknown'
    axes.audioMode = 'inactive'
    axes.capture = 'idle'
    onsetTracker.reset()
    return render()
  }
  axes.activationPending = true
  try {
    if (nativeReady) {
      stopCurrentNativePlayback()
      await window.novaAudioAgentDesktop.nativeAudio.setCaptureEnabled(false)
    }
  } finally {
    nativeReady = false
    releaseBrowserCapture()
    onsetTracker.reset()
    axes.activated = false
    axes.permission = 'unknown'
    axes.audioMode = 'inactive'
    axes.capture = 'idle'
    axes.activationPending = false
    render()
  }
}

async function fallBackAfterNativeFailure() {
  if (!nativeReady && axes.audioMode !== 'voice_processing_io') return
  stopCurrentNativePlayback()
  nativeReady = false
  axes.audioMode = 'inactive'
  try {
    const result = await fallbackToBrowserCapture({
      state: axes,
      activateBrowser: startBrowserCapture,
      releaseBrowser: releaseBrowserCapture,
    })
    if (!result) return render()
    axes.audioMode = result.audioMode
    axes.permission = 'granted'
    axes.error = ''
  } catch {
    if (axes.activated) {
      axes.permission = 'denied'
      axes.error = 'native-audio'
    }
  }
  render()
}

function clearAssistantCaption() {
  if (captionLabel.dataset.role !== 'user') {
    captionLabel.textContent = ''
    captionLabel.hidden = true
  }
}

function clearCaption() {
  captionLabel.textContent = ''
  captionLabel.hidden = true
}

async function handleControl(message) {
  if (message.type === 'playback.clear') {
    clearAssistantCaption()
    const backend = playback.current?.backend
    const cleared = playback.clear(message.utterance_id, message.generation_epoch)
    let nativeEvidence = null
    if (cleared) {
      if (backend === 'native') {
        nativeFrames.delete(`${message.utterance_id}:${message.generation_epoch}`)
        nativeEvidence = await window.novaAudioAgentDesktop.nativeAudio.clear(
          message.utterance_id,
          message.generation_epoch,
        )
      }
      axes.playback = 'interrupted'
    }
    let playedMs = cleared
      ? Math.max(cleared.playedMs, Number(nativeEvidence?.playedMs) || 0)
      : 0
    if (
      !cleared
      && playback.lastCompletion
      && playback.lastCompletion.utterance_id === message.utterance_id
      && playback.lastCompletion.generation_epoch === message.generation_epoch
    ) {
      // The clear raced a locally completed generation: reply with the real
      // audible evidence instead of fabricating zero.
      playedMs = playback.lastCompletion.played_ms
    }
    send({
      type: 'playback.cleared',
      utterance_id: message.utterance_id,
      generation_epoch: message.generation_epoch,
      played_ms: playedMs,
      t_render_ms: performance.now(),
    })
  } else if (message.type === 'playback.alert') {
    clearAssistantCaption()
    const hasIdentity = Object.hasOwn(message, 'utterance_id')
    const result = await applyAlertCommand(playback, message, {
      startTone: startAlertTone,
      clearNative: (utteranceId, generationEpoch) => {
        nativeFrames.delete(`${utteranceId}:${generationEpoch}`)
        return window.novaAudioAgentDesktop.nativeAudio.clear(utteranceId, generationEpoch)
      },
    })
    if (result.cleared) axes.playback = 'interrupted'
    if (hasIdentity) {
      send({
        type: 'playback.cleared',
        utterance_id: message.utterance_id,
        generation_epoch: message.generation_epoch,
        played_ms: result.playedMs,
        t_render_ms: performance.now(),
      })
    }
  } else if (message.type === 'playback.terminal') {
    const backend = playback.current?.backend
    const acknowledgement = playback.markProviderTerminal(
      message.utterance_id,
      message.generation_epoch,
    )
    if (acknowledgement) send(acknowledgement)
    if (backend === 'native') {
      window.novaAudioAgentDesktop.nativeAudio.terminal(
        message.utterance_id,
        message.generation_epoch,
      )
    }
  } else if (message.type === 'clock.ping') {
    send({ type: 'clock.pong', ping_id: message.ping_id, t_render_ms: performance.now() })
  } else if (message.type === 'caption') {
    captionLabel.textContent = message.text
    captionLabel.dataset.role = message.role
    captionLabel.hidden = !message.text
  } else if (message.type === 'memory.board') {
    window.novaAudioAgentDesktop.memoryBoard.publish(message)
  } else if (message.type === 'codex.state') {
    axes.codex = message.state === 'running' ? 'working' : 'idle'
  } else if (message.type === 'error') {
    axes.error = 'backend'
  }
  render()
}

async function handleSocketMessage(event) {
  if (typeof event.data === 'string') {
    await handleControl(JSON.parse(event.data))
    return
  }
  alertTone.stop()
  const frame = decodeAudioFrame(new Uint8Array(event.data))
  const backend = playback.current?.backend || (nativeReady ? 'native' : 'browser')
  try {
    if (backend === 'browser') await ensurePlaybackContext()
  } catch {
    send({
      type: 'playback.stopped',
      utterance_id: frame.utteranceId,
      generation_epoch: frame.generationEpoch,
    })
    axes.error = 'playback'
    return render()
  }
  if (playback.accept(frame, backend)) {
    if (backend === 'native') scheduleNativeFrames()
    else scheduleFrames()
  }
}

async function boot() {
  try {
    const bootstrap = await window.novaAudioAgentDesktop.bootstrap()
    axes.audioMode = bootstrap.audioMode
    nativeAvailable = bootstrap.nativeAvailable === true
    window.novaAudioAgentDesktop.onBackendExit(() => {
      axes.connected = false
      axes.error = 'backend-exit'
      alertTone.stop()
      playback.stopAll()
      render()
    })
    window.novaAudioAgentDesktop.memoryBoard.onFetch(requestId => {
      send({ type: 'memory.board.request', request_id: requestId })
    })
    window.novaAudioAgentDesktop.nativeAudio.onEvent(event => {
      if (event.type === 'audio') {
        if (!nativeReady) return
        const pcm = new Uint8Array(event.pcm)
        detectLocalOnset(pcm)
        if (socket?.readyState === WebSocket.OPEN) socket.send(pcm)
      } else if (event.type === 'playback.started') {
        axes.playback = 'speaking'
        if (
          playback.current
          && playback.current.utteranceId === event.utteranceId
          && playback.current.generationEpoch === event.generationEpoch
        ) {
          const started = playback.markStarted()
          if (started) send({ ...started, t_render_ms: performance.now() })
        }
        render()
      } else if (event.type === 'playback.done') {
        const key = `${event.utteranceId}:${event.generationEpoch}`
        let acknowledgement = null
        for (const frame of nativeFrames.get(key) || []) {
          acknowledgement = playback.frameEnded(frame) || acknowledgement
        }
        nativeFrames.delete(key)
        if (acknowledgement) send(acknowledgement)
        axes.playback = 'idle'
        render()
      } else if (event.type === 'error' || event.type === 'exit') {
        void fallBackAfterNativeFailure()
      }
    })
    socket = new WebSocket(bootstrap.endpoint)
    socket.binaryType = 'arraybuffer'
    socket.onopen = () => send({ type: 'hello', token: bootstrap.token })
    socket.onmessage = event => {
      socketMessageTail = socketMessageTail.then(() => handleSocketMessage(event))
        .catch(() => {
          axes.error = 'playback'
          render()
        })
    }
    socket.onclose = () => {
      axes.connected = false
      alertTone.stop()
      playback.stopAll()
      clearCaption()
      render()
    }
    socket.onerror = () => {
      axes.error = 'connection'
      render()
    }
    axes.connected = true
    axes.booting = false
  } catch {
    axes.booting = false
    axes.error = 'bootstrap'
  }
  render()
}

orb.addEventListener('pointerdown', event => {
  if (event.button !== 0) return
  // Client coordinates only ever gate the six-pixel drag threshold below;
  // once main starts polling the cursor, the window tracks it 1:1 and the
  // pointer stays put relative to the page, so these never drive movement.
  dragGesture.start(event.clientX, event.clientY)
  orb.setPointerCapture(event.pointerId)
  window.novaAudioAgentDesktop.windowDrag.start()
})

orb.addEventListener('pointermove', event => {
  // A contentless tick: main derives the new window position entirely from
  // its own screen.getCursorScreenPoint() poll, so this delta only proves
  // the six-pixel threshold has been crossed and never reaches the drag math.
  const delta = dragGesture.move(event.clientX, event.clientY)
  if (delta) window.novaAudioAgentDesktop.windowDrag.move(delta.dx, delta.dy)
})

function finishDrag(cancelled = false) {
  const result = cancelled ? dragGesture.cancel() : dragGesture.finish()
  if (result.active) window.novaAudioAgentDesktop.windowDrag.end()
}

orb.addEventListener('pointerup', () => finishDrag(false))
orb.addEventListener('pointercancel', () => finishDrag(true))
orb.addEventListener('click', () => {
  if (dragGesture.consumeClick()) void activateCapture()
})
orb.addEventListener('contextmenu', event => {
  event.preventDefault()
  window.novaAudioAgentDesktop.orbMenu.show()
})
window.addEventListener('beforeunload', () => { void deactivateCapture() })
render()
void boot()
