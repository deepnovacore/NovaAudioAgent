import assert from 'node:assert/strict'
import {chmod, mkdtemp, realpath, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {loadSettings} from '../src/config.js'
import {
  buildIntegratedRealtimeAssembly,
  type IntegratedProviderRegistry,
} from '../src/integrated-realtime-assembly.js'
import {QwenAudioRealtimeAdapter} from '../src/realtime/qwen.js'

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
      assert.equal(input.workspaceGraphPolicy, false)
      expected = new QwenAudioRealtimeAdapter({
        ...input.config,
        connector: () => Promise.reject(new Error('unused')),
        idFactory: input.idFactory,
        now: input.now,
      })
      return expected
    },
  }

  const actual = buildIntegratedRealtimeAssembly({
    settings: loadSettings({
      NOVA_AUDIO_AGENT_PIPELINE_MODE: 'integrated',
      NOVA_AUDIO_AGENT_INTEGRATED_PROVIDER: 'qwen',
      NOVA_AUDIO_AGENT_QWEN_REALTIME_URL: 'wss://qwen.example/realtime',
      NOVA_AUDIO_AGENT_QWEN_REALTIME_MODEL: 'qwen-audio-test',
      NOVA_AUDIO_AGENT_QWEN_REALTIME_VOICE: 'voice-test',
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
  const settings = new Proxy(loadSettings({
    NOVA_AUDIO_AGENT_PIPELINE_MODE: 'integrated',
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
          'config', 'connector', 'idFactory', 'now', 'workspaceGraphPolicy',
        ])
        assert.equal(input.workspaceGraphPolicy, false)
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

test('integrated Qwen receives graph policy while the complete builder owns graph storage',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'nova-integrated-graph-')))
    await chmod(root, 0o700)
    try {
      let graphPolicy: boolean | undefined
      const registry: IntegratedProviderRegistry = {
        qwen: input => {
          graphPolicy = input.workspaceGraphPolicy
          return new QwenAudioRealtimeAdapter({
            ...input.config,
            connector: () => Promise.reject(new Error('unused')),
            idFactory: input.idFactory,
            now: input.now,
            workspaceGraphPolicy: input.workspaceGraphPolicy,
          })
        },
      }

      const realtime = buildIntegratedRealtimeAssembly({
        settings: loadSettings({
          NOVA_AUDIO_AGENT_PIPELINE_MODE: 'integrated',
          DASHSCOPE_API_KEY: 'selected-dash-secret',
          TAVILY_API_KEY: 'host-search-secret',
          NOVA_AUDIO_AGENT_WORKSPACE_GRAPH_ENABLED: 'true',
          NOVA_AUDIO_AGENT_WORKSPACE_GRAPH_PATH: join(root, 'graph.sqlite'),
        }),
      }, registry)
      try {
        assert.equal(graphPolicy, true)
        assert.ok(realtime.workspaceGraph !== undefined)
      } finally {
        await realtime.stop()
      }
    } finally {
      await rm(root, {recursive: true, force: true})
    }
  })

test('default integrated Qwen delegates without acquiring its socket before start', () => {
  let connections = 0
  const realtime = buildIntegratedRealtimeAssembly({
    settings: loadSettings({
      NOVA_AUDIO_AGENT_PIPELINE_MODE: 'integrated',
      DASHSCOPE_API_KEY: 'dash-secret',
      TAVILY_API_KEY: 'search-secret',
    }),
    connector: () => {
      connections += 1
      return Promise.reject(new Error('unused'))
    },
    searchTransport: {search: () => Promise.reject(new Error('unused'))},
  })

  assert.ok(realtime.provider instanceof QwenAudioRealtimeAdapter)
  assert.equal(connections, 0)
})
