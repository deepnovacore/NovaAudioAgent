import assert from 'node:assert/strict'
import {test} from 'node:test'

import {loadSettings} from '../src/config.js'
import {
  buildIntegratedRealtimeAssembly,
  type IntegratedProviderRegistry,
} from '../src/integrated-realtime-assembly.js'
import {QwenAudioRealtimeAdapter} from '../src/realtime/qwen.js'
import type {RealtimeAssembly} from '../src/realtime-assembly.js'

test('integrated registry resolves only Qwen and passes an immutable selected config', () => {
  const expected = {kind: 'integrated-qwen'} as unknown as RealtimeAssembly
  const calls: string[] = []
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

  assert.equal(actual, expected)
  assert.deepEqual(calls, ['integrated:qwen'])
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
