/** The compiled realtime desktop entry Electron launches with `utilityProcess.fork()`. */

import {randomUUID} from 'node:crypto'

import {loadSettings} from './config.js'
import {
  createCodexAssemblyResource,
  createProductionCodexHost,
  resolveCodexHostConfig,
} from './executors/codex/host.js'
import {
  buildDesktopRealtimeComposition,
  runDesktopEntryWithStopSources,
  type DesktopStopParentSource,
} from './desktop-service.js'
import {announceReadiness} from './desktop.js'
import {selectDesktopCameraSource} from './desktop-camera-source.js'
import {ChromiumFrameSource} from './executors/chromium-frame-source.js'
import {RealClock} from './clock.js'
import {
  buildProductionRealtimeAssembly,
  type BuildProductionRealtimeAssemblyOptions,
} from './production-realtime-assembly.js'
import {createRealtimeTelemetry} from './realtime/telemetry.js'
import type {ApprovalView as ExecutorApprovalView} from './approval-port.js'

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
    const clock = new RealClock()
    const telemetry = createRealtimeTelemetry(process.env, {clock})
    ownership.own(() => telemetry.close())
    const sourceResourcesPath = process.env.NOVA_AUDIO_AGENT_CODEX_RESOURCES_PATH
    const codexHost = createProductionCodexHost(settings, {
      ...(sourceResourcesPath === undefined ? {} : {resourcesPath: sourceResourcesPath}),
      onDiagnostic: code => onDiagnostic(`[runtime-diagnostic] ${code}`),
    })
    const codexConfig = resolveCodexHostConfig(settings, codexHost.catalog)
    let publishExecutorApproval: (view: ExecutorApprovalView) => void = () => undefined
    const codexResource = codexConfig === null
      ? null
      : await createCodexAssemblyResource({
          config: codexConfig,
          composition: 'realtime',
          transportFactory: codexHost.transportFactory,
          clock,
          idFactory: () => randomUUID().replaceAll('-', ''),
          onDiagnostic,
          codexApprovalBroker: {
            publish: view => { publishExecutorApproval(view) },
          },
          ...(codexHost.projectHost === null ? {} : {projectHost: codexHost.projectHost}),
        })
    if (codexResource !== null) ownership.own(() => codexResource.close())
    const camera = selectDesktopCameraSource(process.env)
    const composition = buildDesktopRealtimeComposition({
      token,
      stop,
      telemetry,
      progressBubbles: settings.progress_bubbles,
      ...(codexResource?.projectView === null || codexResource === null
        ? {}
        : {projectView: codexResource.projectView}),
      ...(codexResource?.approvalController === null || codexResource === null
        ? {}
        : {approvalView: codexResource.approvalController.view}),
      buildRealtime: (callbacks, transport) => {
        const frameSource = new ChromiumFrameSource({
          source: camera.source,
          transport,
          clock,
        })
        const realtimeOptions: BuildProductionRealtimeAssemblyOptions = {
          settings,
          telemetry,
          onDiagnostic,
          clock,
          frameSource,
          cameraModuleEnabled: settings.camera_module_enabled,
          ...(codexResource === null ? {} : {codexResource}),
          ...callbacks,
        }
        return buildProductionRealtimeAssembly(realtimeOptions)
      },
    })
    publishExecutorApproval = view => { composition.desktop.bridge.onExecutorApproval(view) }
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
