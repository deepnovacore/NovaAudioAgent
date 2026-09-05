import assert from 'node:assert/strict'
import {test} from 'node:test'

import {ConfigurationError, loadSettings, type Settings} from '../src/config.js'
import {VirtualClock} from '../src/clock.js'
import {CODEX_PROJECT_MANIFEST} from '../src/executors/codex/contract.js'
import type {CodexAssemblyResource} from '../src/executors/codex/factory.js'
import {ProjectConfirmationController} from '../src/project-confirmation.js'
import {
  buildIntegratedRealtimeAssembly,
  type IntegratedProviderRegistry,
} from '../src/integrated-realtime-assembly.js'
import {
  buildProductionRealtimeAssembly,
  type BuildProductionRealtimeAssemblyOptions,
} from '../src/production-realtime-assembly.js'
import {QwenAudioRealtimeAdapter} from '../src/realtime/qwen.js'
import type {RealtimeAssembly} from '../src/realtime-assembly.js'

type SelectedCodingComposition = Pick<
  BuildProductionRealtimeAssemblyOptions,
  'codingAgentControllerFactory' | 'agentDescriptors'
>

function options(settings: Settings): BuildProductionRealtimeAssemblyOptions {
  return {settings}
}

function projectResource(): CodexAssemblyResource {
  const confirmationController = new ProjectConfirmationController({
    clock: new VirtualClock(), idFactory: () => 'production-coding-confirmation',
  })
  const adapter = {
    manifest: CODEX_PROJECT_MANIFEST,
    dispatch: () => Promise.resolve({outcome: 'ok', trust: 'trusted_system', content: {}, refs: []}),
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
    observeCommittedWorkspace: () => () => undefined,
    observeTerminalWorkOrder: () => () => undefined,
  } as never
  return {
    adapter,
    mode: 'project', projectView: null, approvalPolicy: 'never', approvalController: null,
    start: () => Promise.resolve(), close: () => Promise.resolve(),
  }
}

function integratedRegistry(): IntegratedProviderRegistry {
  return {
    qwen: input => new QwenAudioRealtimeAdapter({
      ...input.config,
      connector: () => Promise.reject(new Error('network was not expected')),
      idFactory: input.idFactory,
      now: input.now,
      executorApproval: input.executorApproval,
    }),
  }
}

test('production selector constructs only the integrated branch', () => {
  const expected = {kind: 'integrated'} as unknown as RealtimeAssembly
  let selected: SelectedCodingComposition | undefined
  const actual = buildProductionRealtimeAssembly(options(loadSettings({
    NOVA_AUDIO_AGENT_PIPELINE_MODE: 'integrated',
  })), {
    integrated: input => { selected = input; return expected },
    cascaded: () => { throw new Error('unselected') },
  })
  assert.equal(actual, expected)
  assert.equal(selected?.codingAgentControllerFactory, undefined)
  assert.equal(selected?.agentDescriptors, undefined)
})

test('production selector supplies the paired coding factory and descriptor only with a Codex resource', () => {
  for (const mode of ['integrated', 'cascaded'] as const) {
    const expected = {kind: mode} as unknown as RealtimeAssembly
    let selected: SelectedCodingComposition | undefined
    const actual = buildProductionRealtimeAssembly({
      ...options(loadSettings({NOVA_AUDIO_AGENT_PIPELINE_MODE: mode})),
      codexResource: {adapter: {manifest: {name: 'workspace_coder'}}},
    } as never, {
      integrated: input => {
        if (mode !== 'integrated') throw new Error('unselected')
        selected = input
        return expected
      },
      cascaded: input => {
        if (mode !== 'cascaded') throw new Error('unselected')
        selected = input
        return expected
      },
    })
    assert.equal(actual, expected)
    assert.equal(typeof (selected?.codingAgentControllerFactory as {readonly create?: unknown} | undefined)?.create, 'function')
    assert.deepEqual(selected?.agentDescriptors, [{
      name: 'codex', summary: '在已配置的项目工作区里执行编码任务（改代码、修 bug、写测试、重构）',
      ownedChannels: ['workspace_coder'],
    }])
  }
})

test('production integrated composition registers the default coding controller with its paired descriptor', async () => {
  const realtime = buildProductionRealtimeAssembly({
    settings: loadSettings({
      NOVA_AUDIO_AGENT_PIPELINE_MODE: 'integrated',
      NOVA_AUDIO_AGENT_EXECUTOR: 'codex',
      NOVA_AUDIO_AGENT_QWEN_REALTIME_URL: 'wss://qwen.example/realtime',
      NOVA_AUDIO_AGENT_QWEN_REALTIME_MODEL: 'qwen-audio-test',
      NOVA_AUDIO_AGENT_QWEN_REALTIME_VOICE: 'voice-test',
      DASHSCOPE_API_KEY: 'dash-secret', TAVILY_API_KEY: 'search-secret',
    }),
    codexResource: projectResource(),
  }, {
    integrated: composition => buildIntegratedRealtimeAssembly(composition, integratedRegistry()),
    cascaded: () => { throw new Error('unselected') },
  })
  try {
    assert.deepEqual(realtime.tools.agent_descriptors.find(descriptor => descriptor.name === 'codex'), {
      name: 'codex',
      summary: '在已配置的项目工作区里执行编码任务（改代码、修 bug、写测试、重构）',
      ownedChannels: ['codex'],
    })
    assert.equal(realtime.service.agentNameForChannel('codex'), 'codex')
  } finally {
    await realtime.stop()
  }
})

test('production composition rejects descriptors that collide with the coding controller', () => {
  const base: BuildProductionRealtimeAssemblyOptions = {
    ...options(loadSettings({NOVA_AUDIO_AGENT_PIPELINE_MODE: 'integrated'})),
    codexResource: {adapter: {manifest: {name: 'workspace_coder'}}} as never,
  }
  for (const descriptor of [
    {name: 'codex', summary: 'duplicate public name', ownedChannels: ['other']},
    {name: 'other', summary: 'duplicate owned channel', ownedChannels: ['workspace_coder']},
  ]) {
    assert.throws(
      () => buildProductionRealtimeAssembly({...base, agentDescriptors: [descriptor]}),
      error => error instanceof ConfigurationError
        && error.code === 'invalid_configuration'
        && error.message === 'production coding descriptor cannot be overridden',
    )
  }
})

test('production selector constructs only the cascaded branch', () => {
  const expected = {kind: 'cascaded'} as unknown as RealtimeAssembly
  const actual = buildProductionRealtimeAssembly(options(loadSettings({
    NOVA_AUDIO_AGENT_PIPELINE_MODE: 'cascaded',
  })), {
    integrated: () => { throw new Error('unselected') },
    cascaded: () => expected,
  })
  assert.equal(actual, expected)
})

test('production selector preserves cameraModuleEnabled for either selected composition', () => {
  for (const mode of ['integrated', 'cascaded'] as const) {
    const selected: boolean[] = []
    buildProductionRealtimeAssembly({
      settings: loadSettings({NOVA_AUDIO_AGENT_PIPELINE_MODE: mode}),
      cameraModuleEnabled: false,
    }, {
      integrated: options => {
        if (mode !== 'integrated') throw new Error('unselected')
        selected.push(options.cameraModuleEnabled ?? true)
        return {mode} as unknown as RealtimeAssembly
      },
      cascaded: options => {
        if (mode !== 'cascaded') throw new Error('unselected')
        selected.push(options.cameraModuleEnabled ?? true)
        return {mode} as unknown as RealtimeAssembly
      },
    })
    assert.deepEqual(selected, [false])
  }
})

test('production selector reads only pipeline_mode before invoking the selected builder', () => {
  for (const mode of ['integrated', 'cascaded'] as const) {
    const settings = new Proxy({pipeline_mode: mode} as Settings, {
      get(target, property, receiver) {
        if (property !== 'pipeline_mode') throw new Error(`unexpected setting read: ${String(property)}`)
        return Reflect.get(target, property, receiver)
      },
    })
    const expected = {mode} as unknown as RealtimeAssembly
    const actual = buildProductionRealtimeAssembly({settings}, {
      integrated: () => mode === 'integrated' ? expected : (() => { throw new Error('unselected') })(),
      cascaded: () => mode === 'cascaded' ? expected : (() => { throw new Error('unselected') })(),
    })
    assert.equal(actual, expected)
  }
})

test('production selector never resolves the unselected builder property', () => {
  const expected = {kind: 'integrated'} as unknown as RealtimeAssembly
  const builders = Object.create(null) as {
    integrated: () => RealtimeAssembly
    cascaded: () => RealtimeAssembly
  }
  Object.defineProperties(builders, {
    integrated: {value: () => expected, enumerable: true},
    cascaded: {get: () => { throw new Error('unselected builder resolved') }, enumerable: true},
  })
  assert.equal(buildProductionRealtimeAssembly(options(loadSettings({})), builders), expected)
})

test('selected branch failures never fail over and invalid modes are credential-safe', () => {
  const failure = new Error('selected branch failed')
  assert.throws(
    () => buildProductionRealtimeAssembly(options(loadSettings({
      NOVA_AUDIO_AGENT_PIPELINE_MODE: 'cascaded',
    })), {
      integrated: () => { throw new Error('unselected') },
      cascaded: () => { throw failure },
    }),
    error => error === failure,
  )

  const invalid = {
    ...loadSettings({}), pipeline_mode: 'renderer-controlled-value',
  } as unknown as Settings
  assert.throws(
    () => buildProductionRealtimeAssembly(options(invalid), {
      integrated: () => { throw new Error('unselected') },
      cascaded: () => { throw new Error('unselected') },
    }),
    error => error instanceof ConfigurationError
      && error.message === 'NOVA_AUDIO_AGENT_PIPELINE_MODE 无效'
      && !error.message.includes('renderer-controlled-value'),
  )
})

test('registry Coding/Vision gates compose all four controller combinations', async () => {
  const {parseCapabilityRegistry} = await import('../src/capability-registry.js')
  for (const coding of [false, true]) {
    for (const camera of [false, true]) {
      const resource = projectResource()
      const assembly = buildProductionRealtimeAssembly({
        settings: loadSettings({DASHSCOPE_API_KEY: 'test-only', NOVA_AUDIO_AGENT_EXECUTORS: 'codex'}),
        capabilities: parseCapabilityRegistry({version: 1, modules: {search: {enabled: false}, coding: {enabled: coding}, camera: {enabled: camera}}}),
        codexResource: resource,
      })
      assert.equal(assembly.runtime.executors.has('codex'), coding)
      assert.equal(assembly.core.visionController !== undefined, camera)
      assert.deepEqual(assembly.tools.agent_descriptors.map(descriptor => descriptor.name).sort(), [
        ...(coding ? ['codex'] : []), ...(camera ? ['vision'] : []),
      ].sort())
      for (const tool of ['dispatch', 'cancel', 'confirm']) assert.equal(assembly.tools.bindings.has(tool), coding || camera)
      assert.equal(assembly.capabilityStatus.toolCount, assembly.tools.schemas.length)
      await assembly.core.stop()
    }
  }
})
