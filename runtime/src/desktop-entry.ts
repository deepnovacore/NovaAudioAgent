/** The compiled realtime desktop entry Electron launches with `utilityProcess.fork()`. */

import {randomUUID} from 'node:crypto'

import {loadSettings} from './config.js'
import {createCodexAssemblyResource} from './codex-factory.js'
import {resolveCodexHostConfig} from './codex-host-config.js'
import {createProductionCodexHost} from './codex-production-host.js'
import {
  buildDesktopRealtimeComposition,
  runDesktopEntryWithStopSources,
  type DesktopStopParentSource,
} from './desktop-service.js'
import {announceReadiness} from './desktop.js'
import {selectDesktopCameraSource} from './desktop-camera-source.js'
import {ChromiumFrameSource} from './executors/chromium-frame-source.js'
import {RealClock} from './clock.js'
import {buildProductionRealtimeAssembly} from './production-realtime-assembly.js'
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
  construct: async ownership => {
    const settings = loadSettings()
    const telemetry = new NullTelemetry()
    ownership.own(() => telemetry.close())
    const clock = new RealClock()
    const codexHost = createProductionCodexHost(settings)
    const codexConfig = resolveCodexHostConfig(settings, codexHost.catalog)
    const codexResource = codexConfig === null
      ? null
      : await createCodexAssemblyResource({
          config: codexConfig,
          composition: 'realtime',
          transportFactory: codexHost.transportFactory,
          clock,
          idFactory: () => randomUUID().replaceAll('-', ''),
          ...(codexHost.projectHost === null ? {} : {projectHost: codexHost.projectHost}),
        })
    if (codexResource !== null) {
      ownership.own(() => codexResource.close())
      await codexResource.start()
    }
    const camera = selectDesktopCameraSource(process.env)
    const composition = buildDesktopRealtimeComposition({
      token,
      stop,
      telemetry,
      ...(codexResource?.projectView === null || codexResource === null
        ? {}
        : {projectView: codexResource.projectView}),
      buildRealtime: (callbacks, transport) => {
        const frameSource = new ChromiumFrameSource({
          source: camera.source,
          transport,
          clock,
        })
        return buildProductionRealtimeAssembly({
          settings,
          telemetry,
          onDiagnostic,
          clock,
          frameSource,
          ...(codexResource === null ? {} : {codexResource}),
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
