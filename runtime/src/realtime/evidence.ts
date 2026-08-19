import { validProgressSummary, type JsonValue } from '../events.js'
import { CONVERSATION_CHANNEL, type MemoryItem } from '../memory.js'
import { prepareForSpeech, SPEECH_FINAL_LIMIT } from './speech-prep.js'

const GENERIC_SCALAR_KEYS = [
  'op',
  'state',
  'summary',
  'message',
  'observation',
  'condition',
  'hit',
  'error',
  'brightness_pct',
  'color_temp_kelvin',
  'power',
  'direction',
  'elapsed',
] as const
const STRUCTURED_EVIDENCE_CHANNELS = new Set(['ha', 'fast_sim', 'slow_sim', 'autoglm', 'cam'])
const UNKNOWN_PROSE_KEYS = ['observation', 'summary', 'message', 'error'] as const
const CODEX_PROGRESS_KEYS = new Set(['op', 'phase', 'internal_activity', 'elapsed', 'summary'])

export function finalSpeechView(outcome: string, content: unknown): string {
  let finalMessage: unknown
  let code: unknown
  if (isObject(content)) {
    code = content.code
    if (isObject(content.result)) finalMessage = content.result.final_message
  }
  let text: string | undefined
  let upstreamTruncated = false
  if (isObject(finalMessage)) {
    if (typeof finalMessage.text === 'string' && finalMessage.text.trim().length > 0) {
      text = finalMessage.text
    }
    upstreamTruncated = finalMessage.truncated === true
  }
  if (text === undefined) {
    const category = typeof code === 'string' && code.length > 0 ? code : 'no_final_message'
    return `Codex 任务未能确认完成（${category}）`
  }
  const prepared = prepareForSpeech(text, {limit: SPEECH_FINAL_LIMIT})
  const note = upstreamTruncated || prepared.truncated ? '（结果较长，已截取要点）' : ''
  if (outcome === 'ok') return `Codex 报告任务完成：${prepared.text}${note}`
  if (outcome === 'failed') {
    const category = typeof code === 'string' && code.length > 0 ? `（${code}）` : ''
    return `Codex 任务失败${category}：${prepared.text}${note}`
  }
  return `Codex 任务结果不确定：${prepared.text}${note}`
}

export function genericFinalSpeechView(
  displayName: string,
  outcome: string,
  content: unknown,
): string {
  const values = isObject(content) ? content : {}
  const prose = ['observation', 'summary', 'message']
    .map(key => values[key])
    .find(value => typeof value === 'string' && value.trim().length > 0)
  let text: string
  if (outcome === 'ok' && values.hit === true) {
    const condition = values.condition
    const prefix = typeof condition === 'string' && condition.trim().length > 0
      ? `${displayName} 报告命中${condition.trim()}`
      : `${displayName} 报告命中`
    text = typeof prose === 'string' ? `${prefix}：${prose.trim()}` : prefix
  } else if (outcome === 'ok' && values.hit === false) {
    text = `${displayName} 监控结束，未命中条件`
  } else if (outcome === 'ok') {
    text = typeof prose === 'string'
      ? `${displayName} 报告：${prose.trim()}`
      : `${displayName} 报告任务完成`
  } else if (outcome === 'failed') {
    text = `${displayName} 任务失败`
  } else {
    text = `${displayName} 任务结果不确定`
  }
  if (outcome !== 'ok' && typeof values.error === 'string' && values.error.trim().length > 0) {
    const category = prepareForSpeech(values.error.trim(), {limit: 80}).text
    text += `（${category}）`
  }
  return prepareForSpeech(text, {limit: SPEECH_FINAL_LIMIT}).text
}

export function safeMemoryEvidence(item: MemoryItem): string | null {
  const content = item.content
  const outcome = item.outcome ?? 'unknown'

  if (item.channel === CONVERSATION_CHANNEL) {
    const text = content.text
    if (typeof text !== 'string' || text.trim().length === 0) return null
    return nonemptyPrepared(text)
  }

  if (item.channel === 'codex') {
    if (item.outcome !== null) return finalSpeechView(outcome, content)
    const summary = storedCodexProgressSummary(item)
    return summary === null ? finalSpeechView(outcome, content) : nonemptyPrepared(summary)
  }

  if (item.channel === 'search') return searchEvidence(content)

  if (item.channel === 'watch' || item.channel === 'guard') {
    return genericFinalSpeechView(item.channel, outcome, selectKeys(content, [
      'condition',
      'hit',
      'observation',
    ]))
  }

  if (!STRUCTURED_EVIDENCE_CHANNELS.has(item.channel)) {
    const filtered = selectKeys(content, UNKNOWN_PROSE_KEYS)
    if (Object.keys(filtered).length === 0) return null
    return genericFinalSpeechView(item.channel, outcome, filtered)
  }

  const fields: string[] = []
  for (const key of GENERIC_SCALAR_KEYS) {
    const value = content[key]
    let rendered: string | undefined
    if (typeof value === 'boolean') rendered = value ? 'true' : 'false'
    else if (typeof value === 'string' || typeof value === 'number') rendered = String(value).trim()
    if (rendered !== undefined && rendered.length > 0) fields.push(`${key}=${rendered}`)
  }
  if (fields.length === 0) return null
  return prepareForSpeech(`${item.channel} 报告：${fields.join('；')}`, {
    limit: SPEECH_FINAL_LIMIT,
  }).text
}

function storedCodexProgressSummary(item: MemoryItem): string | null {
  const keys = Object.keys(item.content)
  if (
    item.trust !== 'trusted_system'
    || item.outcome !== null
    || keys.length !== CODEX_PROGRESS_KEYS.size
    || keys.some(key => !CODEX_PROGRESS_KEYS.has(key))
    || item.content.op !== 'run'
    || item.content.phase !== 'working'
  ) return null
  const activity = item.content.internal_activity
  const elapsed = item.content.elapsed
  const summary = item.content.summary
  if (
    typeof activity !== 'number'
    || !Number.isInteger(activity)
    || activity < 1
    || activity > 1_048_576
    || typeof elapsed !== 'number'
    || !Number.isFinite(elapsed)
    || elapsed < 0
    || !validProgressSummary(summary, 'working')
    || typeof summary !== 'string'
  ) return null
  return summary
}

function searchEvidence(content: Readonly<Record<string, JsonValue>>): string | null {
  const renderedResults: string[] = []
  if (Array.isArray(content.results)) {
    for (const result of content.results.slice(0, 3)) {
      if (!isObject(result)) continue
      const title = preparedScalar(result.title, 120)
      const source = preparedScalar(result.source_label, 80)
      const snippet = preparedScalar(result.snippet, 240)
      const head = title.length > 0 && source.length > 0 ? `${title}（${source}）` : title || source
      const rendered = head.length > 0 && snippet.length > 0 ? `${head}：${snippet}` : head || snippet
      if (rendered.length > 0) renderedResults.push(rendered)
    }
  }
  if (renderedResults.length === 0) return null
  return prepareForSpeech(`搜索结果：${renderedResults.join('；')}`, {
    limit: SPEECH_FINAL_LIMIT,
  }).text
}

function preparedScalar(value: unknown, limit: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) return ''
  return prepareForSpeech(value, {limit}).text
}

function nonemptyPrepared(value: string): string | null {
  const prepared = prepareForSpeech(value, {limit: SPEECH_FINAL_LIMIT}).text
  return prepared.length > 0 ? prepared : null
}

function selectKeys(
  content: Readonly<Record<string, JsonValue>>,
  keys: readonly string[],
): Record<string, JsonValue> {
  return Object.fromEntries(keys.flatMap(key => (
    Object.hasOwn(content, key) ? [[key, content[key]!]] : []
  )))
}

function isObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
