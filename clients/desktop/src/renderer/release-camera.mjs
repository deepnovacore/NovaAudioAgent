import {
  CAMERA_FRAME_MAGIC,
  RendererCameraController,
} from './camera.mjs'
import {lockedCameraCodecSupported} from './release-camera-contract.mjs'

let reported = false
const report = result => {
  if (reported) return
  reported = true
  window.novaAudioAgentDesktop.releaseCamera.report(result)
}

async function probeDecode() {
  const video = document.createElement('video')
  if (!lockedCameraCodecSupported(video.canPlayType?.bind(video))) return false
  video.preload = 'auto'
  video.muted = true
  video.playsInline = true
  video.src = 'nova://orb/camera-source'
  return await new Promise((resolveProbe, rejectProbe) => {
    const finish = value => {
      clearTimeout(timer)
      video.removeEventListener('loadeddata', loaded)
      video.removeEventListener('error', failed)
      try { video.pause() } catch {}
      video.removeAttribute('src')
      try { video.load() } catch {}
      resolveProbe(value)
    }
    const loaded = () => finish(true)
    const failed = () => finish(false)
    const timer = setTimeout(() => rejectProbe(new Error('camera decode probe timed out')), 5_000)
    video.addEventListener('loadeddata', loaded, {once: true})
    video.addEventListener('error', failed, {once: true})
    video.load()
  })
}

async function run() {
  let decodes
  try { decodes = await probeDecode() } catch { return report('capture_failed') }
  if (!decodes) return report('chromium_codec_unavailable')
  const controller = new RendererCameraController({
    mediaDevices: navigator.mediaDevices,
    ImageCapture: globalThis.ImageCapture,
    OffscreenCanvas: globalThis.OffscreenCanvas,
    createVideo: () => document.createElement('video'),
  })
  controller.setSourceMode('file')
  const generation = Object.freeze({})
  const timer = setTimeout(() => report('capture_failed'), 6_000)
  const finish = result => {
    clearTimeout(timer)
    controller.closeGeneration(generation)
    controller.dispose()
    report(result)
  }
  controller.enqueue(JSON.stringify({
    type: 'camera.capture',
    request_id: 'camera-release-smoke',
    source: 'file',
    position_ms: 0,
  }), Object.freeze({
    generation,
    isCurrent: () => !reported,
    sendText: () => finish('capture_failed'),
    sendBinary: value => {
      const valid = value instanceof Uint8Array
        && value.byteLength > CAMERA_FRAME_MAGIC.byteLength
        && CAMERA_FRAME_MAGIC.every((byte, index) => value[index] === byte)
      finish(valid ? 'passed' : 'capture_failed')
    },
  }))
}

void run()
