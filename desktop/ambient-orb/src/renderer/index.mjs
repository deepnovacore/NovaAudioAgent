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
  classifyMicrophoneFailure,
  preflightMicrophone,
} from './microphone-permission.mjs'
import {
  cameraPermissionResultMessage,
  parseCameraPermissionRequest,
  RendererCameraController,
  RendererCameraToggle,
  RendererSocketRouter,
} from './camera.mjs'
import { OrbDragGesture } from './drag-gesture.mjs'
import { createOrbVisualSafe } from './orb-visual.mjs'
import { ConfirmationCountdown } from './confirmation-countdown.mjs'
import { ConfirmationDecisionController } from './confirmation-controls.mjs'
import { deriveOrbState } from './state.mjs'

const PROJECT_CONFIRMATION_TTL_SECONDS = 360

const shell = document.querySelector('#shell')
const orb = document.querySelector('#orb')
const muteToggle = document.querySelector('#mute-toggle')
const cameraToggle = document.querySelector('#camera-toggle')
const openSettingsButton = document.querySelector('#open-settings')
const stateLabel = document.querySelector('#state-label')
const codexLabel = document.querySelector('#codex-label')
const codexSummary = document.querySelector('#codex-summary')
const codexOperation = document.querySelector('#codex-operation')
const codexExpiry = document.querySelector('#codex-expiry')
const confirmationActions = document.querySelector('#codex-confirmation-actions')
const confirmationConfirm = document.querySelector('#codex-confirm')
const confirmationCancel = document.querySelector('#codex-cancel')
const confirmationAnnouncement = document.querySelector('#confirmation-announcement')
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
  muted: false,
  capture: 'idle',
  playback: 'idle',
  codex: 'idle',
  workspace: '',
  session: '',
  pendingConfirmation: false,
  pendingConfirmationId: null,
  pendingAction: null,
  pendingWorkspace: '',
  pendingSession: '',
  pendingExpiresInSeconds: null,
  connected: false,
  backendState: 'stopped',
  microphone: 'checking',
  error: '',
  shellExpanded: false,
  audioMode: 'inactive',
  activationPending: false,
  platform: 'unknown',
  camera: 'off',
  cameraSource: 'local',
}

const cameraToggleController = new RendererCameraToggle({
  cameraController,
  requestPermission: () => window.novaAudioAgentDesktop.camera.requestPermission(),
  onState: state => {
    axes.camera = state
    render()
  },
})

const confirmationCountdown = new ConfirmationCountdown({
  onTick: seconds => {
    if (!axes.pendingConfirmation) return
    axes.pendingExpiresInSeconds = seconds
    render()
  },
})

const confirmationDecision = new ConfirmationDecisionController({send})

let socket
let activeConnection = null
let context
let media
let processor
let source
let workletLoaded = false
let nativeAvailable = false
let nativeReady = false
let microphoneSystemStatus = 'unknown'
let playbackCursor = 0
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

const socketRouter = new RendererSocketRouter({
  cameraController,
  handleGeneric: (event, delivery) => handleSocketMessage(event, delivery),
  onGenericError: () => {
    axes.error = 'playback'
    render()
  },
  onCurrentClose: ({socket: closedSocket}) => {
    if (socket !== closedSocket) return
    socket = undefined
    axes.connected = false
    confirmationDecision.deliveryLost()
    alertTone.stop()
    playback.stopAll()
    clearCaption()
    render()
  },
})

function render() {
  const state = deriveOrbState(axes)
  shell.dataset.state = state.name
  setText(stateLabel, state.statusLine)
  setText(codexSummary, state.projectLabel)
  setText(codexOperation, state.confirmationOperation)
  setText(codexExpiry, state.confirmationStatus)
  codexLabel.dataset.mode = state.codexMode
  const decisionEnabled = confirmationDecision.enabled && axes.connected
  confirmationActions.hidden = !axes.pendingConfirmation || axes.pendingConfirmationId === null
  confirmationConfirm.disabled = !decisionEnabled
  confirmationCancel.disabled = !decisionEnabled
  setText(aecLabel, state.aecLabel)
  setAttribute(orb, 'aria-label', `${state.label}；${state.accessibleCodexLabel}`)
  orb.setAttribute('aria-pressed', String(axes.activated))
  muteToggle.disabled = !axes.activated
  muteToggle.setAttribute('aria-pressed', String(axes.muted))
  muteToggle.setAttribute('aria-label', axes.muted ? '取消闭麦' : '闭麦')
  cameraToggle.hidden = axes.cameraSource === 'file'
  cameraToggle.disabled = axes.booting
    || axes.cameraSource !== 'local'
    || axes.camera === 'requesting'
  cameraToggle.dataset.cameraState = axes.camera
  cameraToggle.setAttribute('aria-pressed', String(axes.camera === 'on'))
  cameraToggle.setAttribute('aria-busy', String(axes.camera === 'requesting'))
  cameraToggle.setAttribute('aria-label', ({
    off: '打开摄像头',
    requesting: '正在请求摄像头权限',
    on: '关闭摄像头',
    denied: '摄像头权限被拒绝，点击重试',
    unavailable: '摄像头不可用，点击重试',
    file: '使用测试视频源',
  })[axes.camera] ?? '打开摄像头')
  visual.setState(state.name, { codexWorking: axes.codex === 'working' })
}

function setText(element, value) {
  if (element.textContent !== value) element.textContent = value
}

function setAttribute(element, name, value) {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value)
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
  if (socket?.readyState !== WebSocket.OPEN) return false
  socket.send(JSON.stringify(value))
  return true
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

// Soft mute: the capture device stays hot (both paths keep producing frames)
// and the backend session stays up; the two ingress gates simply drop every
// frame, so nothing reaches the socket, the onset tracker, or the orb level.
//
// The gates check at delivery time, but capture batches are ~10-20 ms (512
// samples) and can straddle the unmute click — or arrive late out of a
// stalled event queue — so audio captured while muted could otherwise slip
// through right after unmute. Ingress therefore stays closed for a short
// drain window after unmute; mute itself still lands instantly.
const UNMUTE_DRAIN_MS = 120
let muteDrainUntil = 0

function microphoneGated() {
  return axes.muted || performance.now() < muteDrainUntil
}

function toggleMute() {
  if (!axes.activated) return
  axes.muted = !axes.muted
  if (axes.muted) {
    onsetTracker.reset()
    axes.capture = 'idle'
  } else {
    muteDrainUntil = performance.now() + UNMUTE_DRAIN_MS
  }
  render()
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
    axes.microphone = 'granted'
    window.novaAudioAgentDesktop.microphone.report(axes.microphone)
    axes.error = ''
  } catch (error) {
    nativeReady = false
    axes.microphone = error?.novaMicrophoneStatus
      ?? classifyMicrophoneFailure(error, microphoneSystemStatus)
    window.novaAudioAgentDesktop.microphone.report(axes.microphone)
  } finally {
    axes.activationPending = false
  }
  render()
}

async function startBrowserCapture() {
  const nextMedia = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  try {
    await ensurePlaybackContext()
    if (!workletLoaded) {
      await context.audioWorklet.addModule('nova://orb/capture-worklet.mjs')
      workletLoaded = true
    }
    const nextSource = context.createMediaStreamSource(nextMedia)
    const nextProcessor = new AudioWorkletNode(context, 'nova-capture')
    nextProcessor.port.onmessage = event => {
      if (!axes.activated || microphoneGated() || socket?.readyState !== WebSocket.OPEN) return
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
    const pipelineError = new Error('audio pipeline unavailable')
    pipelineError.novaMicrophoneStatus = 'audio_pipeline_error'
    throw pipelineError
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
    axes.muted = false
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
    axes.muted = false
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
    axes.microphone = 'granted'
    window.novaAudioAgentDesktop.microphone.report(axes.microphone)
    axes.error = ''
  } catch (error) {
    if (axes.activated) {
      axes.microphone = error?.novaMicrophoneStatus
        ?? classifyMicrophoneFailure(error, microphoneSystemStatus)
      window.novaAudioAgentDesktop.microphone.report(axes.microphone)
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
  } else if (message.type === 'workspace_graph.board') {
    window.novaAudioAgentDesktop.graphBoard.publish(message)
  } else if (message.type === 'codex.state') {
    axes.codex = message.state === 'running' ? 'working' : 'idle'
  } else if (message.type === 'codex.project') {
    const keys = Object.keys(message).sort().join(',')
    const workspace = message.workspace_display_name
    const session = message.session_title
    const pendingAction = message.pending_action
    const pendingConfirmationId = message.pending_confirmation_id
    const pendingWorkspace = message.pending_workspace_display_name
    const pendingSession = message.pending_session_title
    const pendingExpires = message.pending_expires_in_seconds
    const validAction = pendingAction === null
      || pendingAction === 'create_workspace'
      || pendingAction === 'reuse_workspace'
      || pendingAction === 'select_workspace'
      || pendingAction === 'resume_session'
    const pendingMetadata = pendingAction !== null
      || pendingWorkspace !== null
      || pendingSession !== null
      || pendingExpires !== null
    const baseKeys = [
      'pending_action',
      'pending_confirmation',
      'pending_expires_in_seconds',
      'pending_session_title',
      'pending_workspace_display_name',
      'session_title',
      'type',
      'workspace_display_name',
    ]
    const validKeys = keys === baseKeys.join(',')
      || keys === [...baseKeys, 'pending_confirmation_id'].sort().join(',')
    const validConfirmationId = pendingConfirmationId === undefined
      || (typeof pendingConfirmationId === 'string'
        && [...pendingConfirmationId].length > 0
        && [...pendingConfirmationId].length <= 128)
    const valid = validKeys
      && (workspace === null || (typeof workspace === 'string' && [...workspace].length <= 120))
      && (session === null || (typeof session === 'string' && [...session].length <= 120))
      && typeof message.pending_confirmation === 'boolean'
      && validConfirmationId
      && (message.pending_confirmation || pendingConfirmationId === undefined)
      && validAction
      && (pendingWorkspace === null
        || (typeof pendingWorkspace === 'string' && [...pendingWorkspace].length <= 120))
      && (pendingSession === null
        || (typeof pendingSession === 'string' && [...pendingSession].length <= 120))
      && (pendingExpires === null
        || (Number.isFinite(pendingExpires)
          && pendingExpires >= 0
          && pendingExpires <= PROJECT_CONFIRMATION_TTL_SECONDS))
      && (message.pending_confirmation
        ? (!pendingMetadata || (pendingAction !== null
          && pendingWorkspace !== null
          && pendingExpires !== null
          && (pendingAction !== 'resume_session' || pendingSession !== null)))
        : !pendingMetadata)
    if (valid) {
      const wasPending = axes.pendingConfirmation
      axes.workspace = workspace || ''
      axes.session = session || ''
      axes.pendingConfirmation = message.pending_confirmation
      axes.pendingConfirmationId = message.pending_confirmation ? pendingConfirmationId ?? null : null
      axes.pendingAction = pendingAction
      axes.pendingWorkspace = pendingWorkspace || ''
      axes.pendingSession = pendingSession || ''
      axes.pendingExpiresInSeconds = pendingExpires
      confirmationDecision.sync({
        pending: message.pending_confirmation,
        proposalId: axes.pendingConfirmationId,
      })
      if (message.pending_confirmation) {
        confirmationCountdown.start(pendingExpires)
        const state = deriveOrbState(axes)
        setText(
          confirmationAnnouncement,
          `${state.confirmationOperation}；尚未执行，需要你的确认。`,
        )
      } else {
        confirmationCountdown.stop()
        if (wasPending) setText(confirmationAnnouncement, '项目确认已结束。')
      }
    }
  } else if (message.type === 'error') {
    axes.error = 'backend'
  }
  render()
}

async function handleSocketMessage(event, delivery) {
  if (typeof event.data === 'string') {
    const permission = parseCameraPermissionRequest(event.data)
    if (permission !== null) {
      const status = axes.cameraSource === 'local'
        ? await cameraToggleController.admitForHost()
        : 'unavailable'
      if (delivery?.isCurrent?.()) {
        delivery.sendText(cameraPermissionResultMessage(permission.request_id, status))
      }
      render()
      return
    }
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
  axes.error = ''
  confirmationDecision.deliveryLost()
  alertTone.stop()
  playback.stopAll()
  render()
}

function connectBackend(connection) {
  if (!connection || typeof connection.endpoint !== 'string' || typeof connection.token !== 'string') {
    return handleBackendExit()
  }
  try {
    activeConnection?.close(false)
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close()
    const nextSocket = new WebSocket(connection.endpoint)
    const nextConnection = socketRouter.connect(nextSocket)
    activeConnection = nextConnection
    socket = nextSocket
    nextSocket.binaryType = 'arraybuffer'
    nextSocket.onopen = () => {
      if (!nextConnection.isCurrent()) return
      nextConnection.delivery.sendText(JSON.stringify({ type: 'hello', token: connection.token }))
      axes.connected = true
      axes.backendState = 'connected'
      axes.error = ''
      render()
    }
    nextSocket.onmessage = nextConnection.onMessage
    nextSocket.onclose = () => { nextConnection.close() }
    nextSocket.onerror = () => {
      if (!nextConnection.isCurrent()) return
      axes.error = 'connection'
      render()
    }
  } catch {
    handleBackendExit()
  }
}

async function refreshMicrophonePermission() {
  axes.microphone = 'checking'
  render()
  try {
    const system = await window.novaAudioAgentDesktop.microphone.requestPermission()
    microphoneSystemStatus = system?.status ?? 'unknown'
    const result = await preflightMicrophone({
      mediaDevices: navigator.mediaDevices,
      systemStatus: microphoneSystemStatus,
    })
    axes.microphone = result.status
  } catch {
    axes.microphone = 'capture_unavailable'
  }
  window.novaAudioAgentDesktop.microphone.report(axes.microphone)
  render()
  return axes.microphone
}

async function boot() {
  try {
    const bootstrap = await window.novaAudioAgentDesktop.bootstrap()
    cameraController.setSourceMode(bootstrap.cameraSource)
    axes.cameraSource = bootstrap.cameraSource
    axes.camera = bootstrap.cameraSource === 'file' ? 'file' : 'off'
    axes.audioMode = bootstrap.audioMode
    axes.platform = bootstrap.platform
    axes.backendState = typeof bootstrap.backendStatus === 'string'
      ? bootstrap.backendStatus
      : 'stopped'
    // Only the renderer-owned subset reaches the orb; credentials, executable
    // paths, and service endpoints stay in the main process/settings panel.
    visual.setPalette(bootstrap.settings?.palette)
    if (bootstrap.opaque === true) document.body.dataset.opaque = '1'
    nativeAvailable = bootstrap.nativeAvailable === true
    window.novaAudioAgentDesktop.onBackendExit(handleBackendExit)
    window.novaAudioAgentDesktop.onBackendReady(connectBackend)
    window.novaAudioAgentDesktop.onBackendStatus?.(status => {
      if (!status || typeof status.state !== 'string') return
      axes.backendState = status.state
      render()
    })
    window.novaAudioAgentDesktop.microphone.onRetry(() => {
      void refreshMicrophonePermission()
    })
    // Palette updates are the only live renderer setting. Runtime settings
    // trigger a supervised backend restart in main.
    window.novaAudioAgentDesktop.settings?.onChanged?.(next => visual.setPalette(next.palette))
    window.novaAudioAgentDesktop.memoryBoard.onFetch(requestId => {
      send({ type: 'memory.board.request', request_id: requestId })
    })
    window.novaAudioAgentDesktop.graphBoard.onFetch(requestId => {
      send({ type: 'workspace_graph.board.request', request_id: requestId })
    })
    window.novaAudioAgentDesktop.nativeAudio.onEvent(event => {
      if (event.type === 'audio') {
        if (!nativeReady || microphoneGated()) return
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
    axes.booting = false
    if (bootstrap.backend) connectBackend(bootstrap.backend)
    else handleBackendExit()
    const microphone = await refreshMicrophonePermission()
    if (microphone === 'granted' && bootstrap.settings?.startListeningOnLaunch === true) {
      await activateCapture()
    }
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
muteToggle.addEventListener('click', () => toggleMute())
cameraToggle.addEventListener('click', () => { void cameraToggleController.toggle() })
openSettingsButton.addEventListener('click', () => window.novaAudioAgentDesktop.orbMenu.openSettings?.())
confirmationConfirm.addEventListener('click', () => {
  if (confirmationDecision.decide(true)) render()
})
confirmationCancel.addEventListener('click', () => {
  if (confirmationDecision.decide(false)) render()
})
window.addEventListener('beforeunload', () => {
  socketRouter.dispose()
  cameraController.dispose()
  visual.destroy()
  void deactivateCapture()
})
render()
void boot()
