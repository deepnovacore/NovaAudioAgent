export async function preflightMicrophone({ mediaDevices }) {
  if (typeof mediaDevices?.getUserMedia !== 'function') {
    return Object.freeze({ status: 'unavailable' })
  }
  try {
    const stream = await mediaDevices.getUserMedia({ audio: true, video: false })
    stream?.getTracks?.().forEach(track => track.stop())
    return Object.freeze({ status: 'granted' })
  } catch {
    return Object.freeze({ status: 'denied' })
  }
}
