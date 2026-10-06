import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp, realpath, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {conversationRuntimeFactory} from '../src/personal-agent/conversation-runtime.js'
import {createConversation} from '../src/personal-agent/conversations.js'
import {buildCascadedTextProvider} from '../src/cascaded-text-provider.js'
import {loadSettings} from '../src/config/config.js'
import {VirtualClock} from '../src/core/clock.js'
import {executorManifestSchema} from '../src/core/ports.js'
import {buildCascadedRealtimeAssembly, buildTextRealtimeAssembly, cascadedProviderRegistries} from '../src/composition/cascaded-realtime-assembly.js'
import type {CodingAgentControllerFactory} from '../src/composition/realtime-assembly.js'
import {codexAgentDescriptor, CodexAgentController} from '../src/executors/codex/controller.js'
import type {CodexAssemblyResource} from '../src/executors/codex/factory.js'
import {ProjectConfirmationController} from '../src/projects/project-confirmation.js'

test('host and desktop text/voice children keep resolved support models paired after configuration changes', async () => {
  const coding = {
    dispatch: () => Promise.resolve({outcome: 'ok' as const, trust: 'trusted_system' as const, content: {}, refs: []}),
    manifest: executorManifestSchema.parse({
      name: 'workspace_coder', display_name: 'Workspace coder', model_visibility: 'hidden', roles: ['coding'],
      policy: {channel: 'workspace_coder', priority: 50, wake: 'fast', typical_latency: 5, compress_watermark: 8},
      ops: [
        {name: 'run', description: 'run', params: {type: 'object', properties: {work_order: {type: 'string'}}, required: ['work_order'], additionalProperties: false}},
        {name: 'status', description: 'status', readonly: true, params: {type: 'object', properties: {}, additionalProperties: false}},
      ],
    }),
  }
  const contexts: Parameters<CodingAgentControllerFactory['create']>[0][] = []
  const factory: CodingAgentControllerFactory = {
    create: context => {
      contexts.push(context)
      return new CodexAgentController({
        channel: context.channel,
        ...(context.intake === undefined ? {} : {intake: context.intake}),
        ...(context.executor === undefined ? {} : {executor: context.executor}),
        dispatchPort: context.dispatchPort,
        resolveCancelTarget: context.resolveCancelTarget,
      })
    },
  }
  const confirmationController = new ProjectConfirmationController({
    clock: new VirtualClock(), idFactory: () => 'cascaded-coding-confirmation',
  })
  const adapter = {
    ...coding,
    confirmationController,
    initialize: () => Promise.resolve(),
    commitConfirmed: () => Promise.resolve({accepted: false, code: 'unused'}),
    publicProjectView: () => ({workspace_display_name: null, session_title: null, pending_confirmation: false}),
    publicProjectContext: () => ({
      workspace_id: null,
      view: {workspace_display_name: null, session_title: null, pending_confirmation: false},
    }),
    activeCommittedWorkspace: () => Promise.resolve(null),
    observeProjectView: () => () => undefined,
    observeProjectContext: () => () => undefined,
  }
  const resource: CodexAssemblyResource = {
    adapter, agentDescriptor: codexAgentDescriptor('workspace_coder'), agentControllerFactory: factory,
    mode: 'project', projectView: null, approvalPolicy: 'never', approvalController: null,
    start: () => Promise.resolve(), close: () => Promise.resolve(),
  }
  for (const scenario of [
    {provider: 'deepseek', model: 'deepseek-flash', endpoint: 'https://api.deepseek.com/chat/completions'},
    {provider: 'ark', model: 'ark-selected', endpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions'},
    {provider: 'qwen', model: 'qwen-turbo', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'},
    {provider: 'deepseek', model: 'deepseek-flash', endpoint: 'https://generic.example/v1/chat/completions', generic: true},
    {provider: 'deepseek', model: 'deepseek-flash', endpoint: 'https://api.deepseek.com/chat/completions', planner: 'deepseek-v4-pro'},
    {provider: 'qwen', model: 'qwen-turbo', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', integrated: true},
    {provider: 'qwen', model: 'qwen-turbo', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', integrated: true, planner: 'qwen-plus'},
    {provider: 'qwen', model: 'qwen-turbo', endpoint: 'https://generic.example/v1/chat/completions', integrated: true, generic: true},
  ]) {
    contexts.length = 0
    const records: {endpoint: string; model: string}[] = []
    const previous = globalThis.fetch
    globalThis.fetch = (url, init) => {
      assert.equal(typeof init?.body, 'string')
      const body = JSON.parse(init!.body as string) as {model: string; thinking?: unknown; messages: {role:string;content:string}[]}
      assert.deepEqual(body.thinking, scenario.provider === 'deepseek' && !scenario.generic ? {type: 'disabled'} : undefined)
      records.push({endpoint: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url, model: body.model})
      const system = body.messages.find(message=>message.role==='system')?.content ?? ''
      const missing = {state:'missing',note:''}
      const value = system.includes('target.resolve slot')
        ? {intake_id:'routing',revision:1,kind:'work',project:null,project_evidence:null,session:{mode:'new'},question:null}
        : system.includes('intake.assess slot')
          ? {intake_id:'routing',revision:1,slots:{goal:missing,scope:missing,acceptance:missing,constraints:missing},readiness:0,intent_to_proceed:false,candidate_question:null,discovery:[],early_exit:false,abandon:false}
          : {target_work_id:'running-work'}
      return Promise.resolve(new Response(JSON.stringify({choices: [{message: {content: JSON.stringify(value)}}]}), {status: 200}))
    }
    const configured = loadSettings({
      PIPELINE_MODE: scenario.integrated ? 'integrated' : 'cascaded',
      ...(scenario.integrated ? {INTEGRATED_PROVIDER: 'stepfun', STEPFUN_API_KEY: 'fixture'} : {}),
      CASCADE_LLM_PROVIDER: scenario.provider,
      CASCADE_LLM_MODEL: scenario.model,
      EXECUTORS: 'workspace_coder',
      CAMERA_MODULE_ENABLED: 'false',
      MEMORY_CONNECTION: 'disabled',
      DEEPSEEK_API_KEY: 'fixture', ARK_API_KEY: 'fixture', DASHSCOPE_API_KEY: 'fixture',
      DOUBAO_BIGMODEL_API_KEY: 'fixture', TAVILY_API_KEY: 'fixture',
      ...(scenario.generic ? {MODEL_API_KEY: 'fixture', MODEL_BASE_URL: 'https://generic.example/v1'} : {}),
      ...(scenario.planner ? {PLANNER_MODEL: scenario.planner} : {}),
    }, !!scenario.integrated)
    const dir = await mkdtemp(join(await realpath(tmpdir()), 'nova-support-routing-'))
    let realtime: ReturnType<typeof buildCascadedRealtimeAssembly> | undefined
    try {
      for (const build of scenario.integrated ? [buildTextRealtimeAssembly] : [buildCascadedRealtimeAssembly, buildTextRealtimeAssembly]) {
        contexts.length = 0
        realtime = build({
          settings: configured,
          blackboard: {path: join(dir, 'blackboard.sqlite'), ownerId: 'test'},
          codexResource: resource,
          agentDescriptors: [codexAgentDescriptor('workspace_coder')],
          codingAgentControllerFactory: factory,
          metrics: {record: () => undefined},
        })
        const checkRequests = async () => {
          records.length = 0
          const models = contexts.at(-1)?.intake?.models
          assert.ok(models)
          await models.assess({intake_id:'routing',revision:1,running: []}, new AbortController().signal)
          await models.plan({}, new AbortController().signal)
          assert.equal(await models.targets.resolveWork('stop task',[{work_id:'running-work',project:'project',title:'task'}],new AbortController().signal),'running-work')
          assert.deepEqual(records, [
            {endpoint: scenario.endpoint, model: scenario.generic ? 'qwen-plus' : scenario.model},
            {endpoint: scenario.endpoint, model: scenario.generic ? 'qwen-plus' : scenario.model},
            {endpoint: scenario.endpoint, model: scenario.generic ? 'qwen3-vl-plus' : scenario.planner ?? scenario.model},
            {endpoint: scenario.endpoint, model: scenario.generic ? 'qwen-plus' : scenario.model},
          ], scenario.provider)
        }
        await checkRequests()
        if (build === buildTextRealtimeAssembly) {
          const host = realtime.personalAgent
          await host.open()
          const providerModes: string[] = []
          const llm = () => ({open: () => ({
            stream: () => {throw Error('unexpected conversation request')},
            restoreHistory: () => Promise.resolve(), abandonPendingResponse: () => Promise.resolve(), close: () => Promise.resolve(),
          })})
          const createProvider: typeof buildCascadedTextProvider = options => buildCascadedTextProvider(options, {
            ...cascadedProviderRegistries, llm: {qwen: llm, ark: llm},
          })
          const children = conversationRuntimeFactory({
            settings: realtime.core.settings,
            gateway: realtime.core.gateway, host, memory: () => undefined, codexResource: resource,
            createTextProvider: options => {providerModes.push('text'); return createProvider(options)},
            createVoiceProvider: options => {providerModes.push('voice'); return createProvider(options)},
          })
          for (const mode of ['text', 'voice'] as const) {
            const before = contexts.length
            const child = await children(createConversation('chat', mode), () => undefined, mode)
            try {
              assert.equal(contexts.length, before + 1, 'inspect the actual child intake')
              await checkRequests()
            } finally { await child.close() }
          }
          assert.deepEqual(providerModes, ['text', 'voice'])
        }
        await realtime.stop()
        realtime = undefined
      }
      assert.equal(configured.support_model, 'qwen-plus', 'source settings remain unchanged')
    } finally {
      globalThis.fetch = previous
      await realtime?.stop()
      await rm(dir, {recursive: true, force: true})
    }
  }
})
