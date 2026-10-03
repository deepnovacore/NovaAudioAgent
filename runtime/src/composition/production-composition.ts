import {ClientServer} from '../server/client-server.js'
import {ClientPairing} from '../server/client-pairing.js'
import {loadServerConfig} from '../server/server-config.js'
import {acceptanceCapabilityRegistry} from '../desktop/workbench-acceptance.js'
import type {ProjectExecutorAdapter} from '../executors/coding-executor.js'
import {MacMailClient} from '../connectors/macos/mail.js'
import {MacCalendarClient} from '../connectors/macos/calendar.js'
import {ComposioConnector} from '../connectors/composio/index.js'
import {ComposioClient} from '../connectors/composio/client.js'
import {scopeApprovalController} from '../personal-agent/approval-scope.js'
import type {PersonalAgentHost} from '../personal-agent/host.js'
import {conversationRuntimeFactory} from '../personal-agent/conversation-runtime.js'
import {join} from 'node:path'
import {FeishuConnector} from '../connectors/feishu/index.js'
import {SubstrateMemoryResource} from '../memory-substrate/resource.js'
import {z} from 'zod'
import {LocalDirectorySources} from '../personal-agent/sources.js'
import {blackboardOptionsFromSettings} from '../memory/blackboard-session.js'
import type {UsageReporter} from '../realtime/usage.js'
import {prepareKnowledge} from '../knowledge/assembly.js'
/** Shared production graph for the Electron child and the headless remote service. */
import {randomUUID} from 'node:crypto'
import {loadCapabilityRegistry} from '../config/capability-registry.js'
import {prepareExternalMcp} from '../executors/mcp.js'
import {loadSettings, requireBlockingCredentials, requireIntegratedRealtime, withoutUncredentialedModules} from '../config/config.js'
import {requireSelectedCascadedLlmConfig, requireSelectedCascadedRealtimeConfig} from '../config/cascaded-realtime-config.js'
import {remoteClientMedia} from '../server/server-config.js'
import type {ClientMedia} from '../server/client-protocol.js'
import {buildDesktopRealtimeComposition, type DesktopConstructionOwnership} from '../desktop/desktop-session.js'
import type {DesktopRealtimeOptions} from '../desktop/desktop-session.js'
import {selectDesktopCameraSource} from '../desktop/desktop-camera-source.js'
import {ChromiumFrameSource} from '../executors/chromium-frame-source.js'
import {RealClock} from '../core/clock.js'
import {buildProductionRealtimeAssembly, type BuildProductionRealtimeAssemblyOptions} from './cascaded-realtime-assembly.js'
import {createRealtimeTelemetry} from '../realtime/telemetry.js'
import type {ApprovalView as ExecutorApprovalView} from '../core/approval-port.js'
import {buildIntegratedRealtimeAssembly, type IntegratedProviderRegistry} from './cascaded-realtime-assembly.js'

export async function buildProductionComposition({token, stop, ownership, onDiagnostic, remote = false, createServer, integratedProviders, onKnowledge, onUsage, environment = process.env}: {
  readonly onUsage?: UsageReporter
  readonly token: string
  readonly stop: AbortController
  readonly ownership: DesktopConstructionOwnership
  readonly onDiagnostic: (line: string) => void
  readonly onKnowledge?: (knowledge: NonNullable<Awaited<ReturnType<typeof prepareKnowledge>>>) => void
  readonly remote?: boolean
  readonly environment?: NodeJS.ProcessEnv
  readonly integratedProviders?: IntegratedProviderRegistry
  readonly createServer?: (options: Parameters<NonNullable<DesktopRealtimeOptions['createServer']>>[0], media?: ClientMedia) => ReturnType<NonNullable<DesktopRealtimeOptions['createServer']>>
}) {
  const loadedSettings = loadSettings(environment, !remote)
  const media = remote ? remoteClientMedia(loadedSettings) : undefined
  if (!remote) requireSelectedCascadedLlmConfig(loadedSettings)
  else if (loadedSettings.pipeline_mode === 'integrated') requireIntegratedRealtime(loadedSettings)
  else requireSelectedCascadedRealtimeConfig(loadedSettings)
  if (remote) requireBlockingCredentials(loadedSettings)
  const configuredCapabilities=loadCapabilityRegistry({environment:remote?{...environment,CAMERA_MODULE_ENABLED:'false'}:environment})
  const acceptanceCapabilities=acceptanceCapabilityRegistry(configuredCapabilities)
  const externalMcp = await prepareExternalMcp(withoutUncredentialedModules(acceptanceCapabilities, loadedSettings), stop.signal)
  const releaseExternal = ownership.own(() => externalMcp.close())
  const capabilities = externalMcp.capabilities
  // This entry owns the concrete Codex package; core gates injected adapters by their declared role.
  const settings = capabilities.modules.coding.enabled ? loadedSettings : {
    ...loadedSettings, executors: loadedSettings.executors.filter(name => name !== 'codex'),
  }
  for (const override of capabilities.overrides) onDiagnostic(`[capability-override] ${override}`)
  const knowledge = await prepareKnowledge(settings, capabilities, stop.signal)
  if (knowledge !== undefined) {
    ownership.own(() => knowledge.close())
    onKnowledge?.(knowledge)
  }
  const clock = new RealClock()
  const telemetry = createRealtimeTelemetry(environment, {clock})
  ownership.own(() => telemetry.close())
  telemetry.record('pipeline.configuration', {
    pipeline: settings.pipeline_mode,
    provider: settings.pipeline_mode === 'cascaded' ? settings.cascade_llm_provider : settings.integrated_provider,
    model: settings.pipeline_mode === 'cascaded'
      ? requireSelectedCascadedLlmConfig(settings).config.model
      : settings.integrated_provider === 'stepfun' ? settings.stepfun_realtime_model : settings.qwen_realtime_model,
    asr: settings.cascade_asr_provider, tts: settings.cascade_tts_provider,
    vision: settings.conversation_vision_enabled,
  })
  let publishExecutorApproval: (view: ExecutorApprovalView) => void = () => undefined
  const codexResource = !capabilities.modules.coding.enabled || !settings.executors.includes('codex')
    ? null
    : await (async () => {
      const {createCodexAssemblyResource, createProductionCodexHost, resolveCodexHostConfig, prepareManagedCodexMcp} = await import('../executors/codex/host.js')
      const sourceResourcesPath = environment.CODEX_RESOURCES_PATH
      const codexHost = createProductionCodexHost(settings, {
        ...(sourceResourcesPath === undefined ? {} : {resourcesPath: sourceResourcesPath}),
        onDiagnostic: code => onDiagnostic(`[runtime-diagnostic] ${code}`),
      })
      const codexConfig = resolveCodexHostConfig(settings, codexHost.catalog)
      return codexConfig === null
        ? null
        : await createCodexAssemblyResource({
            managedMcp: prepareManagedCodexMcp(capabilities, knowledge?.codexEntries),
            config: codexConfig,
            composition: 'realtime',
            transportFactory: codexHost.transportFactory,
            clock,
            idFactory: () => randomUUID().replaceAll('-', ''),
            onDiagnostic: code => {
              telemetry.record('executor.diagnostic', {code})
              onDiagnostic(code)
            },
            codexApprovalBroker: {
              publish: view => { publishExecutorApproval(view) },
            },
            ...(codexHost.projectHost === null ? {} : {projectHost: codexHost.projectHost}),
          })
    })()
  const releaseCodex = codexResource === null ? undefined : ownership.own(() => codexResource.close())
  const conversationOwner:{host?:PersonalAgentHost}={}
  const camera = remote ? null : selectDesktopCameraSource(environment)
  let playbackEpoch=0
  const nextPlaybackGeneration=()=>++playbackEpoch
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
        textOnly:!remote,
        nextPlaybackGeneration,
        blackboard: blackboardOptionsFromSettings(settings),
        settings,
        ...(onUsage === undefined ? {} : {onUsage}),
        capabilities,
        externalMcp,
        ...(knowledge === undefined ? {} : {knowledge}),
        telemetry,
        onDiagnostic,
        clock,
        ...(frameSource === undefined ? {} : {frameSource}),
        ...(codexResource === null ? {} : {codexResource}),
        ...callbacks,
        ...(codexResource?.approvalController?{executorApproval:scopeApprovalController(codexResource.approvalController,view=>!view.work||!conversationOwner.host?.workConversation(view.work.work_id))}:{}),
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
  if (knowledge !== undefined) {
    const host = composition.realtime.personalAgent
    let sourceRevision=0
    host.setSources(new LocalDirectorySources({
      path: host.path + '.sources.json', knowledge: knowledge.service,
      priorityWorkspace: async () => codexResource?.mode==='project'
        ? (await (codexResource.adapter as ProjectExecutorAdapter).activeCommittedWorkspace())?.canonical_path??null
        : null,
      processingGrant:(...args)=>composition.realtime.personalMemory?.processingGrant?.(...args),
      onProcessingConsent:async(ids,grant)=>{for(const id of ids)await composition.realtime.personalMemory?.setProcessingConsent?.(id,grant)},
      onChange: changed => changed ? host.sourceChanged({phase:'ready',revision:++sourceRevision}) : host.sourceProgressChanged(),
      onHideEvidenceMany: refs => host.invalidateEvidenceMany(refs),
      onInvalidateMany: async refs => {
        await host.invalidateEvidenceMany(refs)
        const memory = composition.realtime.personalMemory
        if (memory?.forgetSources) await memory.forgetSources(refs)
        else for (const ref of refs) await memory?.forgetSource?.(ref)
        await host.revalidate()
        await host.refreshMemory()
      },
      onInvalidate: async ref => {
        await host.invalidateEvidence(ref)
        await composition.realtime.personalMemory?.forgetSource?.(ref)
        await host.revalidate()
        await host.refreshMemory()
      },
    }))
  }
  const host = composition.realtime.personalAgent
  conversationOwner.host=host
  const projectAdapter=codexResource?.mode==='project'?codexResource.adapter as ProjectExecutorAdapter:undefined
  if(projectAdapter?.targetPort)host.setCodingTargets(projectAdapter.targetPort)
  host.setApprovalView(()=>codexResource?.approvalController?.view)
  if(codexResource?.approvalController)ownership.own(codexResource.approvalController.observe(()=>host.connectionChanged()))
  if(projectAdapter)ownership.own(projectAdapter.observeProjectView(view=>host.recordConfirmation('',view)))
  let presentationPaused=false
  ownership.own(host.subscribePresentation(async(mode,seen)=>{
    const broker=codexResource?.approvalController
    if(mode==='background'){broker?.hold('background');projectAdapter?.confirmationController.setBackground(true)}
    else if(!seen){broker?.release('background',{awaitPresentation:true});projectAdapter?.confirmationController.setBackground(false,{awaitPresentation:true})}
    else if(seen?.approval_id&&broker?.view.pending_approval_id===seen.approval_id)broker.release('background')
    if(mode!=='background'&&seen?.proposal_id&&!seen.conversation_id&&projectAdapter?.confirmationController.view.pending_confirmation_id===seen.proposal_id)projectAdapter.confirmationController.setBackground(false)
    if(!seen){const paused=mode==='background';if(paused||presentationPaused)await composition.realtime.service.playbackDisconnected({resumeDelivery:!paused});presentationPaused=paused}
  }))
  host.setConversationRuntime(conversationRuntimeFactory({settings:composition.realtime.core.settings,capabilities,externalMcp,telemetry,mediaStore:composition.realtime.core.mediaStore,
    ...(onUsage===undefined?{}:{onUsage}),
    ...(composition.realtime.core.frameSource?{frameSource:composition.realtime.core.frameSource}:{}),
    blackboard:blackboardOptionsFromSettings(settings),clock,gateway:composition.realtime.core.gateway,
    ...(knowledge?{knowledge}:{}),...(codexResource?{codexResource}:{}),onDiagnostic,
    host,memory:()=>composition.realtime.personalMemory,nextPlaybackGeneration,
    onExecutorProgress:(progress,result)=>composition.desktop.bridge.onExecutorProgress(progress,result),
    onAudioFrame:frame=>composition.audioBridge()?.onAudioFrame(frame),onAudioClear:(id,epoch)=>composition.audioBridge()?.onAudioClear(id,epoch),onAudioAlert:(id,epoch)=>composition.audioBridge()?.onAudioAlert(id,epoch),onAudioTerminal:(id,epoch)=>composition.audioBridge()?.onAudioTerminal(id,epoch),
  }),frame=>composition.publishPersonal(frame))
  host.setConnectors(new ComposioConnector({...(process.platform==='darwin'&&environment.CODEX_RESOURCES_PATH?{local:new MacCalendarClient(environment.CODEX_RESOURCES_PATH),mail:new MacMailClient(environment.CODEX_RESOURCES_PATH)}:{}),memory:()=>{const memory=composition.realtime.personalMemory;return memory instanceof SubstrateMemoryResource?memory:undefined},client:environment.COMPOSIO_API_KEY?new ComposioClient(environment.COMPOSIO_API_KEY):null,onChange:()=>{void host.connectionChanged()}}))
  const feishu = new FeishuConnector({
    executable: environment.FEISHU_CLI_PATH ?? 'lark-cli',
    credentialRoot: join(host.path + '.feishu', 'credentials'),
    statePath: join(host.path + '.feishu', 'state.json'),
    onChange:()=>host.connectionChanged(),
    processingGrant:(...args)=>composition.realtime.personalMemory?.processingGrant?.(...args),
    onProcessingConsent:async(ids,grant)=>{for(const id of ids)await composition.realtime.personalMemory?.setProcessingConsent?.(id,grant)},
    ingest: async message => {
      const memory = composition.realtime.personalMemory
      if (!(memory instanceof SubstrateMemoryResource)) throw Error('请先启用本地记忆')
      await memory.ingestEvidence({sourceId:message.source_id,locator:message.locator,text:message.raw_text,observedAt:message.observed_at,kind:'im',...(message.processing_consent?{processingConsent:message.processing_consent}:{}),retentionUntil:message.retention_until,senderId:message.sender_id,accountId:message.account_id})
      await host.sourceChanged()
    },
    deleteSource: async ref => {
      const memory = composition.realtime.personalMemory
      if (!memory?.forgetSource) throw Error('memory_unavailable')
      await memory.forgetSource(ref)
      await host.revalidate()
      await host.refreshMemory()
    },
    onAction: async action => {
      // Card feedback is never an execution capability. 'open' only marks the item seen.
      const result = await host.command({type:'personal.command',request_id:'feishu:'+action.event_id,
        method:'feed.action',params:{id:action.proposal_id,action:action.action==='ignore'?'dismiss':action.action,
          ...(action.action==='snooze'?{snooze_until:new Date(Date.now()+60*60000).toISOString()}:{})}})
      if (!(result as {ok?:boolean}).ok) throw Error('feishu_action_rejected')
    },
  })
  host.setFeishu({snapshot:()=>feishu.snapshot(),command:(method,params)=>feishu.command(method,z.record(z.string(),z.unknown()).parse(params)),open:()=>feishu.open(),close:async()=>{await feishu.close()}})
  let delivering = false
  const deliver = async () => {
    if (delivering || stop.signal.aborted) return
    delivering = true
    try {
      for (const item of host.snapshot().feed) {
        if (stop.signal.aborted || item.delivery.im_sent_at || !await host.canDeliver(item.id)) continue
        if (await feishu.sendReminder({id:item.id,title:item.title,body:item.why_now})) await host.imDelivered(item.id)
      }
    } catch { onDiagnostic('[runtime-diagnostic] feishu_delivery_unavailable') }
    finally { delivering = false }
  }
  const unsubscribeFeishu = host.subscribe(() => { void deliver() })
  const deliveryTimer=setInterval(()=>{void deliver()},30000)
  deliveryTimer.unref()
  ownership.own(() => {clearInterval(deliveryTimer);unsubscribeFeishu()})
  ownership.own(() => composition.desktop.server.close())
  publishExecutorApproval = view => { if(view.work&&host.workConversation(view.work.work_id))return;composition.desktop.bridge.onExecutorApproval(view) }
  let phone: ReturnType<typeof composition.createPhone> | undefined
  let phoneQueue: Promise<unknown> = Promise.resolve()
  const closePhone = async () => { const endpoint=phone;phone=undefined;await endpoint?.server.close() }
  ownership.own(closePhone)
  stop.signal.addEventListener('abort',()=>{void phoneQueue.then(closePhone).catch(()=>{})},{once:true})
  const phoneControl = (method:string, params:unknown):Promise<unknown> => {
    const operation=phoneQueue.then(async()=>{
      if(process.platform!=='darwin'||remote)throw Error('unsupported')
      if(method==='phone.start'){
        const input=z.object({port:z.number().int().min(1).max(65535),tokenFile:z.string().min(1)}).strict().parse(params)
        if(stop.signal.aborted)throw Error('stopped')
        if(!phone){
          const config=loadServerConfig({SERVER_PORT:String(input.port),SERVER_TOKEN_FILE:input.tokenFile})
          const media=remoteClientMedia(settings)
          const endpoint=composition.createPhone({token:config.token,createServer:serverOptions=>new ClientServer({...serverOptions,sharedWorkbench:true,prepareLegacyVoice:composition.prepareLegacyPhoneVoice,media,pairing:new ClientPairing(config.token,input.tokenFile+'.devices.json'),port:config.port})})
          try{await endpoint.server.start();phone=endpoint}catch(error){await endpoint.server.close();throw error}
        }
      }else{
        z.object({}).strict().parse(params)
        if(method==='phone.stop')await closePhone()
        else if(method!=='phone.status')throw Error('unavailable')
      }
      return {running:phone!==undefined}
    })
    phoneQueue=operation.catch(()=>{})
    return operation
  }
  return {
    ...composition,
    phoneControl,
    closeAuxiliary: async () => {await phoneQueue;await closePhone();telemetry.close()},
  }
}
