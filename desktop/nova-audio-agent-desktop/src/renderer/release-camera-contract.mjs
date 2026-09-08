export const RELEASE_CAMERA_RESULTS = Object.freeze([
  'passed',
  'chromium_codec_unavailable',
  'capture_failed',
])

export function lockedCameraCodecSupported(canPlayType) {
  if (typeof canPlayType !== 'function') return false
  const value = canPlayType('video/mp4; codecs="avc1.64001f"')
  return value === 'probably' || value === 'maybe'
}

export function validReleaseCameraResult(value) {
  return RELEASE_CAMERA_RESULTS.includes(value)
}
