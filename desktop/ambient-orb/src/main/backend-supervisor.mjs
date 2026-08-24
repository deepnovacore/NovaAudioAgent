const DEFAULT_RETRY_DELAYS = Object.freeze([1000, 2000, 5000, 10_000, 30_000])

export function createBackendSupervisor({
  start,
  stopBackend,
  onStatus,
  schedule = setTimeout,
  cancel = clearTimeout,
  retryDelays = DEFAULT_RETRY_DELAYS,
}) {
  if (typeof start !== 'function' || typeof stopBackend !== 'function' || typeof onStatus !== 'function') {
    throw new Error('backend supervisor dependencies are invalid')
  }
  if (!Array.isArray(retryDelays) || retryDelays.length === 0
    || retryDelays.some(delay => !Number.isInteger(delay) || delay < 0 || delay > 60_000)) {
    throw new Error('backend supervisor retry policy is invalid')
  }
  let running = false
  let generation = 0
  let backend = null
  let timer = null
  let retryIndex = 0
  let current = Object.freeze({state: 'idle', connection: null, retryInMs: null})

  const publish = (state, connection = null, retryInMs = null) => {
    current = Object.freeze({state, connection, retryInMs})
    onStatus(current)
  }
  const cancelRetry = () => {
    if (timer !== null) cancel(timer)
    timer = null
  }
  const scheduleRetry = expectedGeneration => {
    if (!running || expectedGeneration !== generation || timer !== null) return
    const delay = retryDelays[Math.min(retryIndex, retryDelays.length - 1)]
    retryIndex += 1
    publish('retry_wait', null, delay)
    timer = schedule(() => {
      timer = null
      return attempt(expectedGeneration)
    }, delay)
  }
  const attempt = async expectedGeneration => {
    if (!running || expectedGeneration !== generation) return
    publish('starting')
    let exitedBeforeReady = false
    let returnedBackend = null
    const onExit = () => {
      if (!running || expectedGeneration !== generation) return
      if (returnedBackend === null) {
        exitedBeforeReady = true
        return
      }
      if (backend === returnedBackend) backend = null
      publish('disconnected')
      scheduleRetry(expectedGeneration)
    }
    try {
      const result = await start(onExit)
      returnedBackend = result?.backend ?? null
      if (!result || returnedBackend === null || !result.connection) throw new Error('backend unavailable')
      if (!running || expectedGeneration !== generation || exitedBeforeReady) {
        await stopBackend(returnedBackend).catch(() => {})
        if (exitedBeforeReady) scheduleRetry(expectedGeneration)
        return
      }
      backend = returnedBackend
      retryIndex = 0
      publish('ready', Object.freeze({...result.connection}))
    } catch {
      if (returnedBackend !== null) await stopBackend(returnedBackend).catch(() => {})
      scheduleRetry(expectedGeneration)
    }
  }
  const restart = async () => {
    running = true
    generation += 1
    const expectedGeneration = generation
    cancelRetry()
    retryIndex = 0
    const previous = backend
    backend = null
    if (previous !== null) await stopBackend(previous).catch(() => {})
    await attempt(expectedGeneration)
  }
  const stop = async () => {
    running = false
    generation += 1
    cancelRetry()
    const previous = backend
    backend = null
    if (previous !== null) await stopBackend(previous).catch(() => {})
    publish('stopped')
  }
  return Object.freeze({
    start: restart,
    restart,
    stop,
    status: () => current,
  })
}
