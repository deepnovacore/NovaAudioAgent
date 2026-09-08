import assert from 'node:assert/strict'
import {test} from 'node:test'
import {reportUsage, usageReporterForEndpoint, type UsageReport} from '../src/realtime/usage.js'

test('usage validates meters, strips extraneous fields and isolates reporting failures', () => {
  const reports: UsageReport[] = []
  const report: UsageReport = {id: 'request-1', provider: 'qwen', service: 'llm', model: 'qwen-flash', status: 'complete', inputTokens: 100, outputTokens: 20}
  reportUsage(value => reports.push(value), {...report, secret: 'never-forward'} as UsageReport)
  assert.deepEqual(reports, [report])
  reportUsage(value => reports.push(value), {...report, outputTokens: NaN})
  assert.equal(reports[1]?.status, 'missing')
  assert.equal(reports[1]?.outputTokens, undefined)
  reportUsage(value => reports.push(value), {...report, inputTokens: -1})
  assert.equal(reports[2]?.status, 'missing')
  assert.doesNotThrow(() => reportUsage(() => {throw new Error('closed IPC')}, report))
})

test('endpoint pricing identity is host resolved and never forwards URL credentials', () => {
  const reports: UsageReport[] = []
  const report: UsageReport = {id: 'request', provider: 'qwen', service: 'llm', model: 'qwen-flash', status: 'complete', inputTokens: 1, outputTokens: 1}
  for (const endpoint of ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime', 'https://custom.invalid', 'https://dashscope.aliyuncs.com.evil.invalid']) {
    usageReporterForEndpoint(value => reports.push(value), endpoint)?.(report)
  }
  assert.deepEqual(reports.map(value => value.pricingRegion), ['cn-beijing', 'singapore', 'unknown', 'unknown'])
  assert.equal(usageReporterForEndpoint(undefined, 'invalid'), undefined)
})

test('production cascade forwards usage independently from semantic events with selected endpoint region', async () => {
  const {buildCascadedRealtimeAssembly, cascadedProviderRegistries} = await import('../src/cascaded-realtime-assembly.js')
  const {loadSettings} = await import('../src/config.js')
  const reports: UsageReport[] = []
  const settings = loadSettings({NOVA_AUDIO_AGENT_PIPELINE_MODE: 'cascaded', DASHSCOPE_API_KEY: 'test', DOUBAO_ASR_API_KEY: 'test', DOUBAO_BIGMODEL_API_KEY: 'test', TAVILY_API_KEY: 'test'})
  buildCascadedRealtimeAssembly({settings, onUsage: value => reports.push(value)}, {
    ...cascadedProviderRegistries,
    asr: {volcengine: input => {
      input.onUsage?.({id: 'asr', service: 'asr', provider: 'volcengine', model: input.config.resourceId, status: 'complete', audioDurationMs: 1200})
      return cascadedProviderRegistries.asr.volcengine(input)
    }},
    llm: {...cascadedProviderRegistries.llm, qwen: input => {
      input.onUsage?.({id: 'llm', service: 'llm', provider: 'qwen', model: input.config.model, status: 'complete', inputTokens: 100, outputTokens: 20})
      return cascadedProviderRegistries.llm.qwen(input)
    }},
    tts: {volcengine: input => {
      input.onUsage?.({id: 'tts', service: 'tts', provider: 'volcengine', model: input.config.resourceId, status: 'complete', characters: 20})
      return cascadedProviderRegistries.tts.volcengine(input)
    }},
  })
  assert.deepEqual(reports.map(report => [report.service, report.pricingRegion]), [['asr', 'cn-beijing'], ['llm', 'cn-beijing'], ['tts', 'cn-beijing']])
})
