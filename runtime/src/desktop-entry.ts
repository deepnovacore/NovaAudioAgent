/** The compiled realtime desktop entry Electron launches with `utilityProcess.fork()`. */

import {loadSettings} from './config.js'
import {
  buildDesktopRealtimeComposition,
  isDesktopShutdownMessage,
  runDesktopEntry,
} from './desktop-service.js'
import {announceReadiness} from './desktop.js'
import {buildQwenRealtimeAssembly} from './qwen-realtime-assembly.js'
import {NullTelemetry} from './realtime/telemetry.js'

interface UtilityParentPort {
  on(event: 'message' | 'close', listener: (event?: unknown) => void): void
  start?(): void
}

type UtilityProcess = NodeJS.Process & {readonly parentPort?: UtilityParentPort}

const token = process.env.NOVA_AUDIO_AGENT_DESKTOP_TOKEN ?? ''
const readyEndpoint = process.env.NOVA_AUDIO_AGENT_DESKTOP_READY_ENDPOINT ?? ''
const stop = new AbortController()
const parentPort = (process as UtilityProcess).parentPort
const requestStop = (): void => stop.abort()

process.once('SIGINT', requestStop)
process.once('SIGTERM', requestStop)
if (parentPort === undefined) {
  process.once('disconnect', requestStop)
  process.stdin.once('end', requestStop)
  process.stdin.resume()
} else {
  parentPort.on('message', event => {
    if (isDesktopShutdownMessage(event)) requestStop()
  })
  parentPort.on('close', requestStop)
  parentPort.start?.()
}

const onDiagnostic = (line: string): void => {
  process.stderr.write(`${line}\n`)
}

process.exitCode = await runDesktopEntry({
  token,
  readyEndpoint,
  stop,
  announce: announceReadiness,
  onDiagnostic,
  construct: () => {
    const settings = loadSettings()
    const telemetry = new NullTelemetry()
    const composition = buildDesktopRealtimeComposition({
      token,
      stop,
      telemetry,
      buildRealtime: callbacks => buildQwenRealtimeAssembly({
        settings,
        telemetry,
        onDiagnostic,
        ...callbacks,
      }),
    })
    return {
      ...composition,
      closeAuxiliary: () => telemetry.close(),
    }
  },
})
