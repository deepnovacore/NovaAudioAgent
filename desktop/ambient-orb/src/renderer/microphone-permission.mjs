const PERMISSION_FAILURES = new Set([
  'NotAllowedError',
  'PermissionDeniedError',
  'SecurityError',
])
const NO_DEVICE_FAILURES = new Set(['NotFoundError', 'DevicesNotFoundError'])
const BUSY_FAILURES = new Set(['NotReadableError', 'TrackStartError', 'AbortError'])

export function classifyMicrophoneFailure(error, systemStatus = 'unknown') {
  if (systemStatus === 'restricted') return 'restricted'
  if (systemStatus === 'denied') return 'permission_denied'
  if (PERMISSION_FAILURES.has(error?.name)) return 'permission_denied'
  if (NO_DEVICE_FAILURES.has(error?.name)) return 'no_input_device'
  if (BUSY_FAILURES.has(error?.name)) return 'device_busy'
  return 'capture_unavailable'
}

export async function preflightMicrophone({ mediaDevices, systemStatus = 'unknown' }) {
  if (typeof mediaDevices?.getUserMedia !== 'function') {
    return Object.freeze({ status: 'capture_unavailable' })
  }
  try {
    const stream = await mediaDevices.getUserMedia({ audio: true, video: false })
    stream?.getTracks?.().forEach(track => track.stop())
    return Object.freeze({ status: 'granted' })
  } catch (error) {
    return Object.freeze({ status: classifyMicrophoneFailure(error, systemStatus) })
  }
}
