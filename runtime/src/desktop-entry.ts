import { NodeDesktopServer, announceReadiness } from './desktop.js'

interface UtilityParentPort {
  on(event: 'message' | 'close', listener: (event?: unknown) => void): void
  start?(): void
}

type UtilityProcess = NodeJS.Process & {readonly parentPort?: UtilityParentPort}

const token = process.env.NOVA_AUDIO_AGENT_DESKTOP_TOKEN ?? ''
const readyEndpoint = process.env.NOVA_AUDIO_AGENT_DESKTOP_READY_ENDPOINT ?? ''
const stop = new AbortController()
const parentPort = (process as UtilityProcess).parentPort
// Renderer disconnect is deliberately NOT a shutdown trigger. The Python runtime
// (realtime/desktop.py) drains only on parent stdin EOF or SIGINT/SIGTERM, so a
// window reload must be able to reconnect to a live backend instead of killing it.
const server = new NodeDesktopServer({token})

process.once('SIGINT', () => stop.abort())
process.once('SIGTERM', () => stop.abort())
if (parentPort === undefined) {
  process.once('disconnect', () => stop.abort())
  process.stdin.once('end', () => stop.abort())
  process.stdin.resume()
} else {
  parentPort.on('message', event => {
    const message = event !== null && typeof event === 'object' && 'data' in event
      ? event.data
      : event
    if (
      message !== null
      && typeof message === 'object'
      && 'type' in message
      && message.type === 'nova.shutdown'
    ) stop.abort()
  })
  parentPort.on('close', () => stop.abort())
  parentPort.start?.()
}

try {
  const readiness = await server.start()
  await announceReadiness(readyEndpoint, readiness)
  if (!stop.signal.aborted) {
    await new Promise<void>(resolve => stop.signal.addEventListener('abort', () => resolve(), {
      once: true,
    }))
  }
} finally {
  await server.close()
}
