/** Shared production graph for the Electron child and the headless remote service. */
import {randomUUID} from 'node:crypto'
import {loadCapabilityRegistry} from './capability-registry.js'
import {prepareExternalMcp} from './executors/mcp.js'
import {loadSettings, requireIntegratedRealtime} from './config.js'
import {requireSelectedCascadedRealtimeConfig} from './cascaded-realtime-config.js'
import {remoteClientMedia} from './server-config.js'
import type {ClientMedia} from './client-protocol.js'
import {buildDesktopRealtimeComposition, type DesktopConstructionOwnership} from './desktop-service.js'
import type {DesktopRealtimeOptions} from './desktop-realtime.js'
import {selectDesktopCameraSource} from './desktop-camera-source.js'
import {ChromiumFrameSource} from './executors/chromium-frame-source.js'
import {RealClock} from './clock.js'
import {buildProductionRealtimeAssembly, type BuildProductionRealtimeAssemblyOptions} from './production-realtime-assembly.js'
import {createRealtimeTelemetry} from './realtime/telemetry.js'
import type {ApprovalView as ExecutorApprovalView} from './approval-port.js'
import {buildIntegratedRealtimeAssembly, type IntegratedProviderRegistry} from './integrated-realtime-assembly.js'

export async function buildProductionComposition({token, stop, ownership, onDiagnostic, remote = false, createServer, integratedProviders, environment = process.env}: {
  readonly token: string
  readonly stop: AbortController
  readonly ownership: DesktopConstructionOwnership
  readonly onDiagnostic: (line: string) => void
  readonly remote?: boolean
  readonly environment?: NodeJS.ProcessEnv
  readonly integratedProviders?: IntegratedProviderRegistry
  readonly createServer?: (options: Parameters<NonNullable<DesktopRealtimeOptions['createServer']>>[0], media?: ClientMedia) => ReturnType<NonNullable<DesktopRealtimeOptions['createServer']>>
}) {
  const loadedSettings = loadSettings(environment)
  const media = remote ? remoteClientMedia(loadedSettings) : undefined
  if (loadedSettings.pipeline_mode === 'integrated') requireIntegratedRealtime(loadedSettings)
  else requireSelectedCascadedRealtimeConfig(loadedSettings)
  const externalMcp = await prepareExternalMcp(loadCapabilityRegistry({environment: remote
      ? {...environment, NOVA_AUDIO_AGENT_CAMERA_MODULE_ENABLED: 'false'} : environment}), stop.signal)
  const releaseExternal = ownership.own(() => externalMcp.close())
  const capabilities = externalMcp.capabilities
  // This entry owns the concrete Codex package; core gates injected adapters by their declared role.
  const settings = capabilities.modules.coding.enabled ? loadedSettings : {
    ...loadedSettings, executors: loadedSettings.executors.filter(name => name !== 'codex'),
  }
  for (const override of capabilities.overrides) onDiagnostic(`[capability-override] ${override}`)
  const clock = new RealClock()
  const telemetry = createRealtimeTelemetry(environment, {clock})
  ownership.own(() => telemetry.close())
  let publishExecutorApproval: (view: ExecutorApprovalView) => void = () => undefined
  const codexResource = !capabilities.modules.coding.enabled || !settings.executors.includes('codex')
    ? null
    : await (async () => {
      const {createCodexAssemblyResource, createProductionCodexHost, resolveCodexHostConfig} = await import('./executors/codex/host.js')
      const sourceResourcesPath = environment.NOVA_AUDIO_AGENT_CODEX_RESOURCES_PATH
      const codexHost = createProductionCodexHost(settings, {
        ...(sourceResourcesPath === undefined ? {} : {resourcesPath: sourceResourcesPath}),
        onDiagnostic: code => onDiagnostic(`[runtime-diagnostic] ${code}`),
      })
      const codexConfig = resolveCodexHostConfig(settings, codexHost.catalog)
      return codexConfig === null
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
    })()
  const releaseCodex = codexResource === null ? undefined : ownership.own(() => codexResource.close())
  const camera = remote ? null : selectDesktopCameraSource(environment)
  const composition = buildDesktopRealtimeComposition({
    token,
    stop,
    ...(createServer === undefined ? {} : {createServer: options => createServer(options, media)}),
    ...(remote ? {transportFailure: 'disconnect' as const} : {}),
    telemetry,
    progressBubbles: settings.progress_bubbles,
    ...(codexResource?.projectView === null || codexResource === null
      ? {}
      : {projectView: codexResource.projectView}),
    ...(codexResource?.approvalController === null || codexResource === null
      ? {}
      : {approvalView: codexResource.approvalController.view}),
    buildRealtime: (callbacks, transport) => {
      const frameSource = camera === null ? undefined : new ChromiumFrameSource({
        source: camera.source,
        transport,
        clock,
      })
      const realtimeOptions: BuildProductionRealtimeAssemblyOptions = {
        settings,
        capabilities,
        externalMcp,
        telemetry,
        onDiagnostic,
        clock,
        ...(frameSource === undefined ? {} : {frameSource}),
        ...(codexResource === null ? {} : {codexResource}),
        ...callbacks,
      }
      const realtime = buildProductionRealtimeAssembly(realtimeOptions, integratedProviders === undefined ? {} : {
        integrated: options => buildIntegratedRealtimeAssembly(options, integratedProviders),
      })
      ownership.own(() => realtime.stop())
      releaseExternal()
      releaseCodex?.()
      return realtime
    },
  })
  ownership.own(() => composition.desktop.server.close())
  publishExecutorApproval = view => { composition.desktop.bridge.onExecutorApproval(view) }
  return {
    ...composition,
    closeAuxiliary: () => telemetry.close(),
  }
}
