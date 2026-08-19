/**
 * The compiled desktop entry Electron launches with `utilityProcess.fork()`.
 *
 * Startup order matters and is the same as the Python runtime's: bind the loopback
 * server, announce readiness so the parent can stop waiting, then serve. The runtime is
 * built before readiness is announced, so a configuration failure is reported by the
 * process exiting rather than by a renderer connecting to a backend that cannot answer.
 */

import { buildAssembly, type Assembly } from './assembly.js'
import { runFromEnvironment } from './desktop-service.js'
import { NodeDesktopServer, announceReadiness } from './desktop.js'
import { loadSettings } from './config.js'

interface UtilityParentPort {
  on(event: 'message' | 'close', listener: (event?: unknown) => void): void
  start?(): void
}

type UtilityProcess = NodeJS.Process & {readonly parentPort?: UtilityParentPort}

const token = process.env.NOVA_AUDIO_AGENT_DESKTOP_TOKEN ?? ''
const readyEndpoint = process.env.NOVA_AUDIO_AGENT_DESKTOP_READY_ENDPOINT ?? ''
const stop = new AbortController()
const parentPort = (process as UtilityProcess).parentPort

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

let assembly: Assembly | undefined
try {
  assembly = buildAssembly({settings: loadSettings()})
} catch (error) {
  // A configuration failure must not reach readiness: the parent would then hand a
  // renderer a backend that cannot answer. Fail the process instead, with the bounded
  // message the assembly produced and no configuration values.
  process.stderr.write(`[runtime-diagnostic] assembly_failed ${
    error instanceof Error ? error.message : 'unknown'
  }\n`)
  process.exitCode = 2
}

if (assembly !== undefined) {
  // Renderer disconnect is deliberately NOT a shutdown trigger. The Python runtime drains
  // only on parent stdin EOF or a signal, so a window reload must be able to reconnect to
  // a live backend instead of killing it.
  const server = new NodeDesktopServer({token})
  await runFromEnvironment({
    assembly,
    server,
    readyEndpoint,
    stop,
    announce: announceReadiness,
  })
}
