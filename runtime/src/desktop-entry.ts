/** The compiled realtime desktop entry Electron launches with `utilityProcess.fork()`. */

import {loadSettings} from './config.js'
import {
  buildDesktopRealtimeComposition,
  runDesktopEntryWithStopSources,
  type DesktopStopParentSource,
} from './desktop-service.js'
import {announceReadiness} from './desktop.js'
import {selectDesktopCameraSource} from './desktop-camera-source.js'
import {ChromiumFrameSource} from './executors/chromium-frame-source.js'
import {RealClock} from './clock.js'
import {buildQwenRealtimeAssembly} from './qwen-realtime-assembly.js'
import {NullTelemetry} from './realtime/telemetry.js'

type UtilityProcess = NodeJS.Process & {readonly parentPort?: DesktopStopParentSource}

const token = process.env.NOVA_AUDIO_AGENT_DESKTOP_TOKEN ?? ''
const readyEndpoint = process.env.NOVA_AUDIO_AGENT_DESKTOP_READY_ENDPOINT ?? ''
const stop = new AbortController()
const parentPort = (process as UtilityProcess).parentPort

const onDiagnostic = (line: string): void => {
  process.stderr.write(`${line}\n`)
}

process.exitCode = await runDesktopEntryWithStopSources({
  token,
  readyEndpoint,
  stop,
  announce: (endpoint, readiness, signal) => announceReadiness(
    endpoint,
    readiness,
    {signal},
  ),
  onDiagnostic,
  construct: () => {
    const settings = loadSettings()
    const telemetry = new NullTelemetry()
    const clock = new RealClock()
    const camera = selectDesktopCameraSource(process.env)
    const composition = buildDesktopRealtimeComposition({
      token,
      stop,
      telemetry,
      buildRealtime: (callbacks, transport) => {
        const frameSource = new ChromiumFrameSource({
          source: camera.source,
          transport,
          clock,
        })
        return buildQwenRealtimeAssembly({
          settings,
          telemetry,
          onDiagnostic,
          clock,
          frameSource,
          ...callbacks,
        })
      },
    })
    return {
      ...composition,
      closeAuxiliary: () => telemetry.close(),
    }
  },
}, {
  processEvents: process,
  stdin: process.stdin,
  ...(parentPort === undefined ? {} : {parentPort}),
})
