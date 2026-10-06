export const SELF_HOSTED_STAGES = Object.freeze([
  {stage: 'asr', provider: 'cascadedAsrProvider', endpoint: 'selfHostedAsrUrl', secret: 'selfHostedAsrApiKey', field: 'url'},
  {stage: 'llm', provider: 'cascadedLlmProvider', endpoint: 'selfHostedLlmBaseUrl', secret: 'selfHostedLlmApiKey', field: 'baseUrl'},
  {stage: 'tts', provider: 'cascadedTtsProvider', endpoint: 'selfHostedTtsUrl', secret: 'selfHostedTtsApiKey', field: 'url'},
])
const cloudStage = (stage, provider) => stage === 'asr' && provider === 'volcengine' || stage === 'llm' && provider === 'deepseek'
export const MAX_PRESET_BYTES = 65_536
export function validSelfHostedUrl(value, stage) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\u0000-\u001f\u007f\\?#]/.test(value)) return null
  if (value === '') return ''
  try {
    const url = new URL(value)
    const protocols = stage === 'asr' ? ['wss:', 'ws:'] : ['https:', 'http:']
    if (!protocols.includes(url.protocol) || url.username || url.password || value.includes('@')) return null
    const authority = value.match(/^\w+:\/\/([^/]+)/)?.[1]
    const literal = authority?.replace(/:\d+$/, '')
    const loopback = literal === '[::1]' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(literal ?? '') && literal.split('.').every(part => Number(part) <= 255)
    if (['http:', 'ws:'].includes(url.protocol) && !loopback) return null
    return value
  } catch { return null }
}
export function endpointOrigin(value) {
  try { return new URL(value).origin } catch { return '' }
}
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value, max) => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
function exact(value, keys) {
  return record(value) && Object.keys(value).every(key => keys.includes(key))
}
export function parseVoicePreset(raw) {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > MAX_PRESET_BYTES) throw new Error('invalid_voice_preset')
  let value
  try { value = JSON.parse(raw.replace(/^\uFEFF/, '')) } catch { throw new Error('invalid_voice_preset') }
  if (!exact(value, ['schema', 'version', 'name', 'asr', 'llm', 'tts']) || value.schema !== 'nova.voice-preset' || value.version !== 1 || !text(value.name, 128)) throw new Error('invalid_voice_preset')
  const patch = {pipelineMode: 'cascaded'}
  let count = 0
  for (const {stage, provider, endpoint, field} of SELF_HOSTED_STAGES) {
    if (!Object.hasOwn(value, stage)) continue
    const part = value[stage]
    if (record(part) && cloudStage(stage, part.provider)) {
      if (!exact(part, ['provider', ...(stage === 'llm' ? ['model'] : [])]) || stage === 'llm' && !text(part.model, 64)) throw new Error('invalid_voice_preset')
      patch[provider] = part.provider
      if (stage === 'llm') patch.cascadedLlmModels = {[part.provider]: part.model}
      count++
      continue
    }
    if (!exact(part, ['provider', field, ...(stage === 'llm' ? ['model'] : [])]) || part.provider !== 'self-hosted' || !part[field] || validSelfHostedUrl(part[field], stage) === null || stage === 'llm' && !text(part.model, 64)) throw new Error('invalid_voice_preset')
    patch[provider] = 'self-hosted'
    patch[endpoint] = part[field]
    if (stage === 'llm') patch.cascadedLlmModels = {'self-hosted': part.model}
    count++
  }
  if (!count) throw new Error('invalid_voice_preset')
  return {name: value.name, patch}
}
export function exportVoicePreset(settings, name = 'Voice pipeline') {
  const preset = {schema: 'nova.voice-preset', version: 1, name}
  for (const {stage, provider, endpoint, field} of SELF_HOSTED_STAGES) {
    if (cloudStage(stage, settings[provider])) {
      preset[stage] = {provider: settings[provider], ...(stage === 'llm' ? {model: settings.cascadedLlmModels?.[settings[provider]]} : {})}
      continue
    }
    if (settings[provider] !== 'self-hosted') continue
    preset[stage] = {provider: 'self-hosted', [field]: settings[endpoint], ...(stage === 'llm' ? {model: settings.cascadedLlmModels?.['self-hosted']} : {})}
  }
  const raw = JSON.stringify(preset, null, 2) + '\n'
  parseVoicePreset(raw)
  return raw
}
