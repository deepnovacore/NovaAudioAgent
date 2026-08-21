import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'
import {ConfigurationError, loadSettings, type Settings} from '../src/config.js'
import {
  buildProductionRealtimeAssembly,
  type BuildProductionRealtimeAssemblyOptions,
} from '../src/production-realtime-assembly.js'
import {QwenAudioRealtimeAdapter} from '../src/realtime/qwen.js'
import type {RealtimeAssembly} from '../src/realtime-assembly.js'
import type {ArkEvent, ArkResponsesGateway, ArkStreamInput} from '../src/realtime/volcengine/ark.js'
import {VolcengineRealtimeProvider} from '../src/realtime/volcengine/provider.js'

function settings(provider: 'qwen' | 'volcengine'): Settings {
  return loadSettings({
    NOVA_AUDIO_AGENT_REALTIME_PROVIDER: provider,
    NOVA_AUDIO_AGENT_MODEL_API_KEY: 'model-key',
    TAVILY_API_KEY: 'tavily-key',
  })
}

function options(configured: Settings): BuildProductionRealtimeAssemblyOptions {
  return {settings: configured}
}

class EmptyArk implements ArkResponsesGateway {
  async *stream(input: ArkStreamInput): AsyncIterable<ArkEvent> {
    void input
    await Promise.resolve()
  }

  close(): Promise<void> { return Promise.resolve() }
}

test('production selector constructs exactly the validated provider branch', () => {
  const qwenResult = {kind: 'qwen'} as unknown as RealtimeAssembly
  const volcResult = {kind: 'volcengine'} as unknown as RealtimeAssembly
  for (const [provider, expected] of [
    ['qwen', qwenResult], ['volcengine', volcResult],
  ] as const) {
    const calls: string[] = []
    const result = buildProductionRealtimeAssembly(options(settings(provider)), {
      qwen: () => { calls.push('qwen'); return qwenResult },
      volcengine: () => { calls.push('volcengine'); return volcResult },
    })
    assert.equal(result, expected)
    assert.deepEqual(calls, [provider])
  }
})

test('provider failures never fail over and unknown runtime values are credential-safe', () => {
  const calls: string[] = []
  const failure = new Error('selected provider failed')
  assert.throws(
    () => buildProductionRealtimeAssembly(options(settings('volcengine')), {
      qwen: () => { calls.push('qwen'); return {} as RealtimeAssembly },
      volcengine: () => { calls.push('volcengine'); throw failure },
    }),
    error => error === failure,
  )
  assert.deepEqual(calls, ['volcengine'])

  const invalid = {
    ...settings('qwen'), realtime_provider: 'renderer-controlled-value',
  } as unknown as Settings
  assert.throws(
    () => buildProductionRealtimeAssembly(options(invalid), {
      qwen: () => { calls.push('invalid-qwen'); return {} as RealtimeAssembly },
      volcengine: () => { calls.push('invalid-volc'); return {} as RealtimeAssembly },
    }),
    error => error instanceof ConfigurationError
      && error.message === 'NOVA_AUDIO_AGENT_REALTIME_PROVIDER 无效'
      && !error.message.includes('renderer-controlled-value'),
  )
  assert.deepEqual(calls, ['volcengine'])
})

test('selector uses the supplied Settings snapshot and never rereads the environment', () => {
  const previous = process.env.NOVA_AUDIO_AGENT_REALTIME_PROVIDER
  process.env.NOVA_AUDIO_AGENT_REALTIME_PROVIDER = 'volcengine'
  const calls: string[] = []
  try {
    buildProductionRealtimeAssembly(options(settings('qwen')), {
      qwen: () => { calls.push('qwen'); return {} as RealtimeAssembly },
      volcengine: () => { calls.push('volcengine'); return {} as RealtimeAssembly },
    })
  } finally {
    if (previous === undefined) delete process.env.NOVA_AUDIO_AGENT_REALTIME_PROVIDER
    else process.env.NOVA_AUDIO_AGENT_REALTIME_PROVIDER = previous
  }
  assert.deepEqual(calls, ['qwen'])
})

test('real selector construction validates only the selected provider credentials and resources', () => {
  const qwenCalls: string[] = []
  const qwen = buildProductionRealtimeAssembly({
    settings: loadSettings({
      NOVA_AUDIO_AGENT_REALTIME_PROVIDER: 'qwen',
      NOVA_AUDIO_AGENT_MODEL_API_KEY: 'model-key',
      TAVILY_API_KEY: 'tavily-key',
    }),
    connector: () => { qwenCalls.push('qwen.connect'); return Promise.reject(new Error('unused')) },
    endpointingCapability: () => {
      qwenCalls.push('volc.endpointing')
      return Promise.reject(new Error('unused'))
    },
    asrClient: () => { qwenCalls.push('volc.asr'); throw new Error('unused') },
    ttsClient: () => { qwenCalls.push('volc.tts'); throw new Error('unused') },
    arkFactory: () => { qwenCalls.push('volc.ark'); return new EmptyArk() },
    searchTransport: {search: () => Promise.reject(new Error('unused'))},
  })
  assert.ok(qwen.provider instanceof QwenAudioRealtimeAdapter)
  assert.deepEqual(qwenCalls, [])

  const volcCalls: string[] = []
  const volc = buildProductionRealtimeAssembly({
    settings: loadSettings({
      NOVA_AUDIO_AGENT_REALTIME_PROVIDER: 'volcengine',
      ARK_API_KEY: 'ark-key',
      DOUBAO_BIGMODEL_API_KEY: 'doubao-key',
      TAVILY_API_KEY: 'tavily-key',
    }),
    connector: () => { volcCalls.push('qwen.connect'); return Promise.reject(new Error('unused')) },
    endpointingCapability: () => {
      volcCalls.push('volc.endpointing')
      return Promise.reject(new Error('unused'))
    },
    asrClient: () => { volcCalls.push('volc.asr'); throw new Error('unused') },
    ttsClient: () => { volcCalls.push('volc.tts'); throw new Error('unused') },
    arkFactory: () => { volcCalls.push('volc.ark'); return new EmptyArk() },
    searchTransport: {search: () => Promise.reject(new Error('unused'))},
  })
  assert.ok(volc.provider instanceof VolcengineRealtimeProvider)
  assert.deepEqual(volcCalls, [])
})

test('desktop entry loads settings and invokes the production selector exactly once', async () => {
  const source = await readFile(
    fileURLToPath(new URL('../../src/desktop-entry.ts', import.meta.url)),
    'utf8',
  )
  assert.equal([...source.matchAll(/\bloadSettings\(\)/gu)].length, 1)
  assert.equal([...source.matchAll(/\bbuildProductionRealtimeAssembly\(\{/gu)].length, 1)
  assert.doesNotMatch(source, /\bbuildQwenRealtimeAssembly\b/u)
  assert.match(source, /ownership\.own\(\(\) => telemetry\.close\(\)\)/u)
})
