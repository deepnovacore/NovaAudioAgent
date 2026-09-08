/** Out-of-band metering; reporting must never interrupt a voice response. */
export type UsageService = 'realtime' | 'llm' | 'asr' | 'tts'
export interface UsageReport {
  readonly id: string
  readonly service: UsageService
  readonly provider: 'qwen' | 'ark' | 'volcengine'
  readonly model: string
  readonly status: 'complete' | 'missing'
  readonly pricingRegion?: 'cn-beijing' | 'singapore' | 'unknown'
  readonly outputModality?: 'audio' | 'text'
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly inputTextTokens?: number
  readonly inputAudioTokens?: number
  readonly outputTextTokens?: number
  readonly outputAudioTokens?: number
  readonly cachedTokens?: number
  readonly reasoningTokens?: number
  readonly audioDurationMs?: number
  readonly characters?: number
}
export type UsageReporter = (report: UsageReport) => void
const meters = ['inputTokens', 'outputTokens', 'inputTextTokens', 'inputAudioTokens',
  'outputTextTokens', 'outputAudioTokens', 'cachedTokens', 'reasoningTokens',
  'audioDurationMs', 'characters'] as const

export function reportUsage(reporter: UsageReporter | undefined, report: UsageReport): void {
  if (reporter === undefined) return
  if (!['qwen', 'ark', 'volcengine'].includes(report.provider)
    || !['llm', 'realtime', 'asr', 'tts'].includes(report.service)
    || typeof report.id !== 'string' || !report.id || report.id.length > 256
    || typeof report.model !== 'string' || !report.model || report.model.length > 256) return
  const counts: Partial<Record<typeof meters[number], number>> = {}
  let complete = report.status === 'complete'
  for (const key of meters) {
    const value = report[key]
    if (value === undefined || value === null) continue
    if (!Number.isSafeInteger(value) || value < 0) complete = false
    else counts[key] = value
  }
  const required = report.service === 'asr' ? ['audioDurationMs'] as const
    : report.service === 'tts' ? ['characters'] as const : ['inputTokens', 'outputTokens'] as const
  if (required.some(key => counts[key] === undefined)) complete = false
  try {
    reporter(Object.freeze({id: report.id, service: report.service, provider: report.provider,
      model: report.model, status: complete ? 'complete' : 'missing', ...counts,
      ...(report.pricingRegion === undefined ? {} : {pricingRegion: report.pricingRegion}),
      ...(report.outputModality === undefined ? {} : {outputModality: report.outputModality}),
    }))
  } catch { /* A closed UI/IPC channel cannot change generation or cancellation. */ }
}

/** Pricing is tied to the selected host endpoint, never inferred from a model name alone. */
export function usageReporterForEndpoint(reporter: UsageReporter | undefined, endpoint: string): UsageReporter | undefined {
  if (reporter === undefined) return undefined
  let pricingRegion: UsageReport['pricingRegion'] = 'unknown'
  try {
    const url = new URL(endpoint)
    if (url.username === '' && url.password === '' && (!url.port || url.port === '443')
      && ['https:', 'wss:'].includes(url.protocol)) {
      if (['dashscope.aliyuncs.com', 'ark.cn-beijing.volces.com', 'openspeech.bytedance.com'].includes(url.hostname)
        || /^[a-zA-Z0-9-]+\.cn-beijing\.maas\.aliyuncs\.com$/u.test(url.hostname)) pricingRegion = 'cn-beijing'
      else if (url.hostname === 'dashscope-intl.aliyuncs.com') pricingRegion = 'singapore'
    }
  } catch { /* Custom/invalid endpoints have no known public price. */ }
  return report => reportUsage(reporter, {...report, pricingRegion})
}
