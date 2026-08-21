/** The compiled realtime desktop entry Electron launches with `utilityProcess.fork()`. */

import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'

import {loadSettings} from './config.js'
import {createCodexAssemblyResource, unavailableCodexBackendTransportFactory} from './codex-factory.js'
import {resolveCodexHostConfig} from './codex-host-config.js'
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
  construct: async () => {
    const settings = loadSettings()
    const telemetry = new NullTelemetry()
    const clock = new RealClock()
    // Task 8 replaces this empty packaged catalog and unavailable transport host with audited,
    // signed resources. Until then an explicitly selected Codex fails before provider/socket work.
    const codexConfig = resolveCodexHostConfig(settings, {
      canonicalBinaries: [],
      canonicalWorkspaces: [],
      defaultBinary: null,
      homeDirectory: homedir(),
    })
    const codexResource = codexConfig === null
      ? null
      : await createCodexAssemblyResource({
          config: codexConfig,
          composition: 'realtime',
          transportFactory: unavailableCodexBackendTransportFactory,
          clock,
          idFactory: () => randomUUID().replaceAll('-', ''),
        })
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
        return buildQwenRealtimeAssembly({
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
