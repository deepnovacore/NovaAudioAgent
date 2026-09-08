export const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'inputTextTokens', 'inputAudioTokens', 'outputTextTokens', 'outputAudioTokens', 'cachedTokens', 'reasoningTokens', 'audioDurationMs', 'characters']
export const PRICE_DATE = '2026-09-08'
export function publicUsageReport(value) {
  if (!value || !['qwen', 'ark', 'volcengine'].includes(value.provider)
    || !['realtime', 'llm', 'asr', 'tts'].includes(value.service) || !['complete', 'missing'].includes(value.status)
    || typeof value.id !== 'string' || !value.id || value.id.length > 256
    || typeof value.model !== 'string' || !value.model || value.model.length > 256) return null
  const result = {id:value.id, provider:value.provider, service:value.service, model:value.model, status:value.status,
    pricingRegion: ['cn-beijing', 'singapore'].includes(value.pricingRegion) ? value.pricingRegion : 'unknown'}
  if (['audio', 'text'].includes(value.outputModality)) result.outputModality = value.outputModality
  for (const field of USAGE_FIELDS) {
    if (value[field] === undefined) continue
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) return null
    result[field] = value[field]
  }
  return result
}
// Official CNY list prices (including Singapore), checked 2026-09-08; no FX conversion.
// No credits, negotiated discounts or explicit-cache storage charges.
export function priceUsage(report) {
  const unknown = {costCny:null, source:null}
  const {provider, service, model, pricingRegion:region} = report
  if (report.status !== 'complete' || !['cn-beijing', 'singapore'].includes(region)) return unknown
  const known = fields => fields.every(field => Number.isSafeInteger(report[field]) && report[field] >= 0)
  if (provider === 'volcengine' && region === 'cn-beijing') {
    const source = 'https://docs.volcengine.com/docs/6561/1359370'
    if (service === 'asr' && model === 'volc.seedasr.sauc.duration' && known(['audioDurationMs'])) return {costCny:report.audioDurationMs/3600000, source}
    if (service === 'tts' && model === 'seed-tts-2.0' && known(['characters'])) return {costCny:report.characters*3/10000, source}
  }
  if (provider === 'ark' && service === 'llm' && region === 'cn-beijing' && model === 'doubao-seed-2-0-pro-260215') {
    if (!known(['inputTokens','outputTokens']) || report.inputTokens > 256000 || (report.cachedTokens ?? 0) > report.inputTokens) return unknown
    const tier = report.inputTokens <= 32000 ? [3.2,16,.64] : report.inputTokens <= 128000 ? [4.8,24,.96] : [9.6,48,1.92]
    const cached = report.cachedTokens ?? 0
    return {costCny:((report.inputTokens-cached)*tier[0]+report.outputTokens*tier[1]+cached*tier[2])/1e6, source:'https://docs.volcengine.com/docs/82379/1544106'}
  }
  if (provider === 'qwen' && service === 'llm' && ['qwen-flash', 'qwen-flash-2025-07-28'].includes(model)) {
    if (!known(['inputTokens', 'outputTokens']) || report.inputTokens > 1e6 || (report.cachedTokens ?? 0) > report.inputTokens) return unknown
    const tier = region === 'singapore'
      ? (report.inputTokens <= 256000 ? [.367,2.936,.073] : [1.835,14.678,.367])
      : report.inputTokens <= 128000 ? [.15,1.5,.03] : report.inputTokens <= 256000 ? [.6,6,.12] : [1.2,12,.24]
    const cached = report.cachedTokens ?? 0
    return {costCny:((report.inputTokens-cached)*tier[0]+report.outputTokens*tier[1]+cached*tier[2])/1e6,
      source:'https://help.aliyun.com/zh/model-studio/qwen-flash'}
  }
  if (provider === 'qwen' && service === 'realtime' && ['qwen-audio-3.0-realtime-plus', 'qwen-audio-3.0-realtime-flash'].includes(model)) {
    // These models publish no cache rate and list context caching as unsupported. Never invent a discount.
    if (!known(['inputTextTokens','inputAudioTokens','outputTextTokens','outputAudioTokens']) || (report.cachedTokens ?? 0) > 0) return unknown
    const plus = model.endsWith('plus')
    const rates = region === 'singapore' ? (plus ? [5.995,47.963,47.963,179.861] : [3.372,33.724,33.724,112.413]) : (plus ? [5,40,40,150] : [3,30,30,100])
    const audio = report.outputModality === 'audio' || report.outputAudioTokens > 0
    return {costCny:(report.inputTextTokens*rates[0]+report.inputAudioTokens*rates[1]+(audio ? report.outputAudioTokens*rates[3] : report.outputTextTokens*rates[2]))/1e6,
      source:`https://help.aliyun.com/zh/model-studio/qwen-audio-3-0-realtime-${plus ? 'plus' : 'flash'}`}
  }
  return unknown
}

/** Main-process lifetime; backend restarts only change the deduplication namespace. */
export function createFrontendUsage() {
  const seen = new Set(), rows = new Map()
  // Lost lifetime usage stays incomplete after a backend restart.
  let currentGeneration = -1, truncated = false
  return {
    add(generation, input) {
      if (!Number.isSafeInteger(generation) || generation < currentGeneration) return false
      if (generation > currentGeneration) { currentGeneration = generation; seen.clear() }
      const report = publicUsageReport(input)
      if (!report) return false
      const id = `${generation}:${report.id}`
      if (seen.has(id)) return false
      // ponytail: cap one child's IDs at 100k; restart the backend to resume, preserving totals.
      if (seen.size >= 100000) { const changed = !truncated; truncated = true; return changed }
      const key = JSON.stringify([report.provider, report.service, report.model, report.pricingRegion])
      if (!rows.has(key) && rows.size >= 1000) { const changed = !truncated; truncated = true; return changed }
      const row = rows.get(key) ?? {provider:report.provider, service:report.service, model:report.model, pricingRegion:report.pricingRegion,
        requests:0, missingReports:0, unpricedReports:0, pricedReports:0, costCny:0, source:null}
      seen.add(id)
      if (USAGE_FIELDS.some(field => report[field] !== undefined && !Number.isSafeInteger((row[field] ?? 0) + report[field]))) { const changed = !truncated; truncated = true; return changed }
      row.requests++
      for (const field of USAGE_FIELDS) if (report[field] !== undefined) row[field] = (row[field] ?? 0) + report[field]
      const price = priceUsage(report)
      if (report.status === 'missing') row.missingReports++
      else if (price.costCny === null) row.unpricedReports++
      else { row.costCny += price.costCny; row.pricedReports++; row.source = price.source }
      rows.set(key,row)
      return true
    },
    snapshot() {
      const result = {truncated, costCny:0, requests:0, missingReports:0, unpricedReports:0, pricedReports:0, priceDate:PRICE_DATE, rows:[...rows.values()].map(row => ({...row}))}
      for (const row of result.rows) for (const key of ['costCny','requests','missingReports','unpricedReports','pricedReports']) result[key] += row[key]
      return result
    },
  }
}
