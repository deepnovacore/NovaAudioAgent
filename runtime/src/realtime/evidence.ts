import { validProgressSummary, type JsonValue } from '../events.js'
import { CONVERSATION_CHANNEL, type MemoryItem } from '../memory.js'
import {pythonFloat} from '../python-number.js'
import {codePointLengthLikePython, stripLikePython} from '../python-text.js'
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
  const confirmation = outcome === 'ok' ? codexConfirmationSpeech(content) : null
  if (confirmation !== null) return confirmation
  let finalMessage: unknown
  let code: unknown
  let error: unknown
  let stage: unknown
  if (isObject(content)) {
    code = content.code
    error = content.error
    stage = content.stage
    if (isObject(content.result)) finalMessage = content.result.final_message
  }
  const category = typeof code === 'string' && code !== ''
    ? code
    : typeof error === 'string' && error !== '' ? error : 'no_final_message'
  if (outcome === 'refused') {
    return `Codex 未执行，需要选择或修正请求（${category}）`
  }
  let text: string | undefined
  let upstreamTruncated = false
  if (isObject(finalMessage)) {
    if (typeof finalMessage.text === 'string' && stripLikePython(finalMessage.text) !== '') {
      text = finalMessage.text
    }
    upstreamTruncated = finalMessage.truncated === true
  }
  if (text === undefined) {
    if (outcome === 'failed') {
      const failure = codexStartupFailureSpeech(category, stage)
      if (failure !== null) return failure
    }
    return `Codex 任务未能确认完成（${category}）`
  }
  const prepared = prepareForSpeech(text, {limit: SPEECH_FINAL_LIMIT})
  const note = upstreamTruncated || prepared.truncated ? '（结果较长，已截取要点）' : ''
  if (outcome === 'ok') return `Codex 报告任务完成：${prepared.text}${note}`
  if (outcome === 'failed') {
    const category = typeof code === 'string' && code !== '' ? `（${code}）` : ''
    return `Codex 任务失败${category}：${prepared.text}${note}`
  }
  return `Codex 任务结果不确定：${prepared.text}${note}`
}

/**
 * Render only a host-generated confirmation prompt whose exact shape matches the public action
 * fields beside it. This keeps proposal ids, work orders, and forged prose out of speech while still
 * preserving the question that used to be lost by the generic no-final-message fallback.
 */
function codexConfirmationSpeech(content: unknown): string | null {
  if (!isObject(content) || content.code !== 'confirmation_required') return null
  const action = content.action
  const workspace = content.workspace
  const session = content.session
  const prompt = content.confirmation_prompt
  if (
    typeof action !== 'string'
    || typeof workspace !== 'string'
    || stripLikePython(workspace) === ''
    || codePointLengthLikePython(workspace) > 120
    || typeof prompt !== 'string'
    || codePointLengthLikePython(prompt) > 512
  ) return genericCodexConfirmationSpeech()

  let expected: readonly string[]
  if (action === 'create_workspace') {
    expected = [
      `是否创建工作区“${workspace}”并开始任务？请确认或取消。`,
      `准备创建并切换到工作区${workspace}，请确认或取消。`,
    ]
  } else if (action === 'reuse_workspace') {
    expected = [`是否使用现有工作区“${workspace}”并开始任务？请确认或取消。`]
  } else if (action === 'select_workspace') {
    expected = [`准备切换到工作区${workspace}，请确认或取消。`]
  } else if (
    action === 'resume_session'
    && typeof session === 'string'
    && stripLikePython(session) !== ''
    && codePointLengthLikePython(session) <= 120
  ) {
    expected = [`准备切换到${workspace}，并继续 Session“${session}”，请确认或取消。`]
  } else {
    return genericCodexConfirmationSpeech()
  }
  if (!expected.includes(prompt)) return genericCodexConfirmationSpeech()
  return prompt
}

function genericCodexConfirmationSpeech(): string {
  return 'Codex 有一项项目操作等待你的确认。'
    + '这项操作尚未执行，Codex 也还没有开始任务。请确认或取消。'
}

function codexStartupFailureSpeech(category: string, stage: unknown): string | null {
  if (category === 'credential_missing' || stage === 'credential') {
    return 'Codex 登录凭据不可用，这次任务没有成功启动。'
  }
  if (category === 'spawn_failed' || stage === 'spawn') {
    return 'Codex 进程未能启动，这次任务没有成功启动。'
  }
  if (category === 'thread_id_invalid' || category === 'session_thread_mismatch') {
    return 'Codex 会话未能建立，这次任务没有成功启动。'
  }
  if (category === 'worker_refused' || category === 'server_rejected') {
    return 'Codex 会话启动被拒绝，这次任务没有成功启动。'
  }
  if (stage === 'preflight') {
    return 'Codex 启动前检查失败，这次任务没有成功启动。'
  }
  if (stage === 'thread_start') {
    return 'Codex 会话启动失败，这次任务没有成功启动。'
  }
  return null
}

export function genericFinalSpeechView(
  displayName: string,
  outcome: string,
  content: unknown,
): string {
  const values = isObject(content) ? content : {}
  const prose = ['observation', 'summary', 'message']
    .map(key => values[key])
    .find(value => typeof value === 'string' && stripLikePython(value) !== '')
  let text: string
  if (outcome === 'ok' && values.hit === true) {
    const condition = values.condition
    const prefix = typeof condition === 'string' && stripLikePython(condition) !== ''
      ? `${displayName} 报告命中${stripLikePython(condition)}`
      : `${displayName} 报告命中`
    text = typeof prose === 'string' ? `${prefix}：${stripLikePython(prose)}` : prefix
  } else if (outcome === 'ok' && values.hit === false) {
    text = `${displayName} 监控结束，未命中条件`
  } else if (outcome === 'ok') {
    text = typeof prose === 'string'
      ? `${displayName} 报告：${stripLikePython(prose)}`
      : `${displayName} 报告任务完成`
  } else if (outcome === 'failed') {
    text = `${displayName} 任务失败`
  } else if (outcome === 'refused') {
    text = `${displayName} 未执行，需要选择或修正请求`
  } else {
    text = `${displayName} 任务结果不确定`
  }
  if (outcome !== 'ok' && typeof values.error === 'string' && stripLikePython(values.error) !== '') {
    const category = prepareForSpeech(stripLikePython(values.error), {limit: 80}).text
    text += `（${category}）`
  }
  return prepareForSpeech(text, {limit: SPEECH_FINAL_LIMIT}).text
}

export function safeMemoryEvidence(item: MemoryItem): string | null {
  const content = item.content
  const outcome = item.outcome ?? 'unknown'

  if (item.channel === CONVERSATION_CHANNEL) {
    const text = content.text
    if (typeof text !== 'string' || stripLikePython(text) === '') return null
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
    else if (typeof value === 'string') rendered = stripLikePython(value)
    else if (typeof value === 'number') {
      rendered = key === 'elapsed' ? pythonFloat(value) : String(value)
    }
    if (rendered !== undefined && rendered !== '') fields.push(`${key}=${rendered}`)
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
      const head = title !== '' && source !== '' ? `${title}（${source}）` : title || source
      const rendered = head !== '' && snippet !== '' ? `${head}：${snippet}` : head || snippet
      if (rendered !== '') renderedResults.push(rendered)
    }
  }
  if (renderedResults.length === 0) return null
  return prepareForSpeech(`搜索结果：${renderedResults.join('；')}`, {
    limit: SPEECH_FINAL_LIMIT,
  }).text
}

function preparedScalar(value: unknown, limit: number): string {
  if (typeof value !== 'string' || stripLikePython(value) === '') return ''
  return prepareForSpeech(value, {limit}).text
}

function nonemptyPrepared(value: string): string | null {
  const prepared = prepareForSpeech(value, {limit: SPEECH_FINAL_LIMIT}).text
  return prepared !== '' ? prepared : null
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
