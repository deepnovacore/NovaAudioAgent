import assert from 'node:assert/strict'
import {test} from 'node:test'

import {loadSettings} from '../src/config/config.js'
import {
  buildIntegratedRealtimeAssembly,
  type IntegratedProviderRegistry,
} from '../src/composition/cascaded-realtime-assembly.js'
import {QwenAudioRealtimeAdapter} from '../src/realtime/qwen.js'
import {createStepFunWireProfile} from '../src/realtime/integrated-wire-profile.js'

test('integrated registry resolves only Qwen and passes an immutable selected config', () => {
  const calls: string[] = []
  let expected: QwenAudioRealtimeAdapter | undefined
  const registry: IntegratedProviderRegistry = {
    qwen: input => {
      calls.push('integrated:qwen')
      assert.equal(Object.isFrozen(input.config), true)
      assert.deepEqual(input.config, {
        url: 'wss://qwen.example/realtime',
        model: 'qwen-audio-test',
        voice: 'voice-test',
        apiKey: 'dash-secret',
      })
      assert.equal(input.executorApproval, false)
      expected = new QwenAudioRealtimeAdapter({
        ...input.config,
        connector: () => Promise.reject(new Error('unused')),
        idFactory: input.idFactory,
        now: input.now,
        executorApproval: input.executorApproval,
      })
      return expected
    },
  }

  const actual = buildIntegratedRealtimeAssembly({
    settings: loadSettings({MEMORY_CONNECTION: 'disabled',
      PIPELINE_MODE: 'integrated',
      INTEGRATED_PROVIDER: 'qwen',
      QWEN_REALTIME_URL: 'wss://qwen.example/realtime',
      QWEN_REALTIME_MODEL: 'qwen-audio-test',
      QWEN_REALTIME_VOICE: 'voice-test',
      DASHSCOPE_API_KEY: 'dash-secret',
      TAVILY_API_KEY: 'search-secret',
    }),
  }, registry)

  assert.equal(actual.provider, expected)
  assert.deepEqual(calls, ['integrated:qwen'])
})

test('integrated registry receives only selected provider inputs and cannot inspect host composition', () => {
  const connector = () => Promise.reject(new Error('unused'))
  let insideRegistry = false
  const settings = new Proxy(loadSettings({MEMORY_CONNECTION: 'disabled',
    PIPELINE_MODE: 'integrated',
    DASHSCOPE_API_KEY: 'selected-dash-secret',
    TAVILY_API_KEY: 'host-search-secret',
  }), {
    get(target, property, receiver) {
      if (insideRegistry && property === 'ark_api_key') {
        throw new Error('registry read unrelated credential')
      }
      return Reflect.get(target, property, receiver) as unknown
    },
  })
  const searchTransport = {search: () => Promise.reject(new Error('unused'))}
  const registry = {
    qwen: (input: Record<string, unknown>) => {
      insideRegistry = true
      try {
        const exposed = input.options as {
          readonly settings?: Record<string, unknown>
          readonly searchTransport?: unknown
          readonly codexResource?: unknown
        } | undefined
        if (exposed !== undefined) {
          void exposed.settings?.ark_api_key
          void exposed.searchTransport
          void exposed.codexResource
        }
        assert.equal('options' in input, false)
        assert.equal('settings' in input, false)
        assert.equal('searchTransport' in input, false)
        assert.equal('codexResource' in input, false)
        assert.deepEqual(Object.keys(input).sort(), [
          'config', 'connector', 'executorApproval', 'idFactory', 'language', 'modules', 'now',
        ])
        assert.equal(input.executorApproval, false)
        assert.equal(Object.isFrozen(input.config), true)
        const config = input.config as {
          readonly url: string
          readonly apiKey: string
          readonly model: string
          readonly voice: string
        }
        return new QwenAudioRealtimeAdapter({
          ...config,
          connector,
          idFactory: input.idFactory as () => string,
          now: input.now as () => number,
          executorApproval: input.executorApproval,
        })
      } finally {
        insideRegistry = false
      }
    },
  } as unknown as IntegratedProviderRegistry

  const hostOptions = {
    settings,
    connector,
    get searchTransport() {
      if (insideRegistry) throw new Error('registry read host search transport')
      return searchTransport
    },
  }
  const realtime = buildIntegratedRealtimeAssembly(hostOptions, registry)

  assert.ok(realtime.provider instanceof QwenAudioRealtimeAdapter)
})

test('StepFun selection passes only its own immutable endpoint and credential', () => {
  let selected = false
  const registry: IntegratedProviderRegistry = {
    stepfun: input => {
      selected = true
      assert.deepEqual(input.config, {
        url: 'wss://api.stepfun.com/v1/realtime',
        model: 'stepaudio-3-realtime-preview', voice: '', apiKey: 'step-secret',
      })
      assert.equal(Object.isFrozen(input.config), true)
      return new QwenAudioRealtimeAdapter({...input.config, wireProfile: createStepFunWireProfile(),
        connector: () => Promise.reject(new Error('unused'))})
    },
  }
  const assembly = buildIntegratedRealtimeAssembly({settings: loadSettings({
    MEMORY_CONNECTION: 'disabled',
    PIPELINE_MODE: 'integrated',
    INTEGRATED_PROVIDER: 'stepfun',
    STEPFUN_API_KEY: 'step-secret',
    TAVILY_API_KEY: 'search-secret',
  })}, registry)
  assert.equal(selected, true)
  assert.ok(assembly.provider instanceof QwenAudioRealtimeAdapter)
})


test('integrated selection rejects a missing own registry entry before provider construction', () => {
  assert.throws(() => buildIntegratedRealtimeAssembly({
    settings: loadSettings({MEMORY_CONNECTION: 'disabled', DASHSCOPE_API_KEY: 'selected-dash-secret'}),
  }, Object.create({qwen: () => { throw new Error('inherited factory invoked') }}) as IntegratedProviderRegistry),
  /INTEGRATED_PROVIDER/)
})
