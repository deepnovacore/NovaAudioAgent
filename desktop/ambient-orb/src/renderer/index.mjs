import {
  activateCaptureMode,
  AlertTone,
  applyAlertCommand,
  decodeAudioFrame,
  fallbackToBrowserCapture,
  floatToPcm16,
  GenerationPlayback,
  measurePcmLevel,
  NativeLevelEnvelope,
  observePcmOnset,
  OnsetTracker,
  PlaybackMeter,
} from './audio.mjs'
import {
  isCameraCaptureText,
  RendererCameraController,
} from './camera.mjs'
import { OrbDragGesture } from './drag-gesture.mjs'
import { createOrbVisualSafe } from './orb-visual.mjs'
import { deriveOrbState } from './state.mjs'

const shell = document.querySelector('#shell')
const orb = document.querySelector('#orb')
const stateLabel = document.querySelector('#state-label')
const codexLabel = document.querySelector('#codex-label')
const aecLabel = document.querySelector('#aec-label')
const captionLabel = document.querySelector('#caption')
const cameraController = new RendererCameraController({
  mediaDevices: navigator.mediaDevices,
  ImageCapture: globalThis.ImageCapture,
  OffscreenCanvas: globalThis.OffscreenCanvas,
  createVideo: () => document.createElement('video'),
})

// Declared ahead of the visual because the visual's loop pulls this: the
// browser meter reads a Web Audio analyser, the native envelope replays what was
// handed to the out-of-process player. Only one backend is ever live for a
// generation, so the louder of the two is the one actually reaching a speaker.
let playbackMeter = null
const nativeLevel = new NativeLevelEnvelope()

function getPlaybackLevel() {
  return Math.max(
    nativeLevel.level(performance.now()),
    playbackMeter ? playbackMeter.level() : 0,
  )
}

// The particle field is a second, parallel consumer of the same derived state:
// `data-state` and the labels above stay the authoritative contract, and the
// visual only ever reads from render() below.
//
// Amplitude arrives from two directions. The microphone is pushed in from the
// capture path, which already walks every PCM frame for onset detection; the
// speaker is pulled by the visual's own loop, because only it knows when it is
// about to draw a speaking frame.
// The palette itself arrives later, from bootstrap.settings (a future task's
// preload channel), so construction always starts on the 'ember' default and
// boot() below swaps it live once settings are known.
// Guarded, not raw: the orb is the one decorative part of this renderer, and a
// canvas it cannot acquire (or one that throws mid-draw) must not take the
// socket, the drag handle, or the accessibility labels down with it.
const visual = createOrbVisualSafe(document.querySelector('.orb-canvas'), {
  reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  highContrast: window.matchMedia('(prefers-contrast: more)').matches,
  palette: 'ember',
  getSpeakingLevel: () => getPlaybackLevel(),
})

const axes = {
  booting: true,
  activated: false,
  capture: 'idle',
  playback: 'idle',
  codex: 'idle',
  workspace: '',
  session: '',
  pendingConfirmation: false,
  connected: false,
  permission: 'unknown',
  error: '',
  shellExpanded: false,
  audioMode: 'inactive',
  activationPending: false,
  platform: 'unknown',
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
let cameraCaptureTail = Promise.resolve()
let currentSocketGeneration = null
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
  visual.setState(state.name, { codexWorking: axes.codex === 'working' })
}

// The one door onto the interrupted playback axis. A real barge-in — the user
// talking over playback — has the capture axis already in 'listening' by the
// time the clear lands, so deriveOrbState keeps returning 'listening' and the
// 'interrupted' state never renders. The scatter is therefore applied as a
// one-shot impulse over whatever field is on screen, independent of the derived
// name, while the label contract itself stays untouched.
function markPlaybackInterrupted() {
  if (axes.playback !== 'interrupted') visual.interrupt()
  axes.playback = 'interrupted'
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

// Every buffer source goes through one master gain into an analyser, at unity:
// the mix the user hears is unchanged, and the orb gets a real amplitude to
// read instead of guessing from the queue.
function playbackDestination() {
  playbackMeter ||= new PlaybackMeter(context, () => playingSources.size > 0)
  return playbackMeter.destination
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
    node.connect(playbackDestination())
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

// Both capture paths — the browser worklet and the native voice-processing tap —
// land here, so this is the one place the microphone reaches the orb.
function detectLocalOnset(pcm) {
  const now = performance.now()
  const verdict = observePcmOnset(pcm, onsetTracker, now)
  visual.setLevel(measurePcmLevel(pcm))
  // Three-way, not two: the tracker's 50 ms attack window is what 'candidate'
  // names, so a syllable that has not held long enough to mint a speech id
  // still lights the orb instead of leaving it idle.
  axes.capture = onsetTracker.active
    ? 'listening'
    : onsetTracker.pending ? 'candidate' : 'idle'
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
    // Native PCM is played out of process, where there is no analyser to read,
    // so its amplitude is measured here and replayed on a wall-clock envelope.
    nativeLevel.push(frame.pcm, performance.now())
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
  nativeLevel.clear()
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
        nativeLevel.clear()
        nativeEvidence = await window.novaAudioAgentDesktop.nativeAudio.clear(
          message.utterance_id,
          message.generation_epoch,
        )
      }
      markPlaybackInterrupted()
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
        nativeLevel.clear()
        return window.novaAudioAgentDesktop.nativeAudio.clear(utteranceId, generationEpoch)
      },
    })
    if (result.cleared) markPlaybackInterrupted()
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
  } else if (message.type === 'codex.project') {
    const keys = Object.keys(message).sort().join(',')
    const workspace = message.workspace_display_name
    const session = message.session_title
    const valid = keys === 'pending_confirmation,session_title,type,workspace_display_name'
      && (workspace === null || (typeof workspace === 'string' && workspace.length <= 80))
      && (session === null || (typeof session === 'string' && session.length <= 120))
      && typeof message.pending_confirmation === 'boolean'
    if (valid) {
      axes.workspace = workspace || ''
      axes.session = session || ''
      axes.pendingConfirmation = message.pending_confirmation
    }
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

// Named, module-level, and idempotent: both doors onto a dead backend — the pushed
// 'nova:backend-exit' event and the verdict carried on the bootstrap reply — land here.
function handleBackendExit() {
  axes.connected = false
  axes.error = 'backend-exit'
  alertTone.stop()
  playback.stopAll()
  render()
}

async function boot() {
  let bootGeneration = null
  try {
    const bootstrap = await window.novaAudioAgentDesktop.bootstrap()
    axes.audioMode = bootstrap.audioMode
    axes.platform = bootstrap.platform
    // bootstrap.settings does not exist yet (it lands with the settings task);
    // the optional chain reads as undefined today, and setPalette already
    // falls back to 'ember' for anything that isn't a known palette name.
    visual.setPalette(bootstrap.settings?.palette)
    if (bootstrap.opaque === true) document.body.dataset.opaque = '1'
    nativeAvailable = bootstrap.nativeAvailable === true
    window.novaAudioAgentDesktop.onBackendExit(handleBackendExit)
    // Same guard for the live-push side: window.novaAudioAgentDesktop.settings
    // is not exposed by the preload script until that same future task, so
    // this must not throw in the meantime.
    window.novaAudioAgentDesktop.settings?.onChanged?.(next => visual.setPalette(next.palette))
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
    const nextSocket = new WebSocket(bootstrap.endpoint)
    const socketGeneration = Object.freeze({})
    bootGeneration = socketGeneration
    currentSocketGeneration = socketGeneration
    const delivery = Object.freeze({
      generation: socketGeneration,
      isCurrent: () => currentSocketGeneration === socketGeneration
        && socket === nextSocket
        && nextSocket.readyState === WebSocket.OPEN,
      sendText: value => nextSocket.send(value),
      sendBinary: value => nextSocket.send(value),
    })
    socket = nextSocket
    nextSocket.binaryType = 'arraybuffer'
    nextSocket.onopen = () => send({ type: 'hello', token: bootstrap.token })
    nextSocket.onmessage = event => {
      if (typeof event.data === 'string' && isCameraCaptureText(event.data)) {
        cameraCaptureTail = cameraCaptureTail.then(() => {
          cameraController.enqueue(event.data, delivery)
        }, () => {
          cameraController.enqueue(event.data, delivery)
        }).catch(() => {})
        return
      }
      socketMessageTail = socketMessageTail.then(() => handleSocketMessage(event))
        .catch(() => {
          axes.error = 'playback'
          render()
        })
    }
    socket.onclose = () => {
      cameraController.closeGeneration(socketGeneration)
      if (currentSocketGeneration === socketGeneration) currentSocketGeneration = null
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
    // Applied after the optimistic connect, which would otherwise overwrite it: the
    // backend may have died before this renderer existed, in which case its exit was
    // never pushed here and only the bootstrap reply above knows about it.
    if (bootstrap.backendExited === true) handleBackendExit()
  } catch {
    if (bootGeneration) {
      cameraController.closeGeneration(bootGeneration)
      if (currentSocketGeneration === bootGeneration) currentSocketGeneration = null
    }
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
  // This gate stays open through a live drag only because move() returns a
  // truthy {dx: 0, dy: 0} once latched, even with unchanged coordinates;
  // main's cursor-poll ticks depend on that contract, not on dx/dy being nonzero.
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
window.addEventListener('beforeunload', () => {
  if (currentSocketGeneration) cameraController.closeGeneration(currentSocketGeneration)
  currentSocketGeneration = null
  cameraController.dispose()
  visual.destroy()
  void deactivateCapture()
})
render()
void boot()
