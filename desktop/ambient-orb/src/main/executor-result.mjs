import {parseProjectRoster, validProjectLabel} from '../renderer/bubbles.mjs'

const OUTCOMES = new Set(['ok', 'failed', 'refused', 'unknown', 'cancelled'])

/** Trust boundary for the orb renderer's request to show a native result panel. */
export function parseExecutorResult(value) {
  if (!value || typeof value !== 'object') return null
  const canonical = Object.hasOwn(value, 'delegateId')
    ? value
    : {
        delegateId: value.delegate_id,
        project: value.project, title: value.title,
        executor: value.executor,
        outcome: value.outcome,
        summary: value.summary,
        startedAt: value.started_at,
        endedAt: value.ended_at,
        changedFiles: value.changed_files,
      }
  if (!validText(canonical.delegateId, 128)
    || !validText(canonical.executor, 128)
    || (canonical.project !== undefined && !validProjectLabel(canonical.project))
    || (canonical.title !== undefined && !validProjectLabel(canonical.title))
    || !OUTCOMES.has(canonical.outcome)
    || !validSummary(canonical.summary)
    || !validTime(canonical.startedAt)
    || !validTime(canonical.endedAt)
    || canonical.endedAt < canonical.startedAt
    || !(canonical.changedFiles === null
      || (Number.isSafeInteger(canonical.changedFiles) && canonical.changedFiles >= 0))) return null
  return Object.freeze({
    delegateId: canonical.delegateId,
    ...(canonical.project === undefined ? {} : {project: canonical.project}),
    ...(canonical.title === undefined ? {} : {title: canonical.title}),
    executor: canonical.executor,
    outcome: canonical.outcome,
    summary: canonical.summary,
    startedAt: canonical.startedAt,
    endedAt: canonical.endedAt,
    changedFiles: canonical.changedFiles,
  })
}

export function executorResultDialogOptions(result) {
  const outcome = {
    ok: '已完成', failed: '失败', refused: '已拒绝', unknown: '结果未知', cancelled: '已停止',
  }[result.outcome]
  return Object.freeze({
    type: result.outcome === 'ok' ? 'info' : 'warning',
    title: '任务结果',
    message: outcome,
    detail: `${result.project ?? result.executor} · ${result.title ?? result.delegateId}\n${result.summary}\n\n变更文件：${result.changedFiles === null ? '未知' : result.changedFiles}\n开始：${formatSeconds(result.startedAt)}\n结束：${formatSeconds(result.endedAt)}\n耗时：${formatSeconds(result.endedAt - result.startedAt, false)}`,
    buttons: ['打开 Memory Board', '关闭'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
}

/** Native menus scroll; each choice opens the existing single-result detail dialog. */
export function executorResultMenuTemplate(value, openResult) {
  if (!value || !Array.isArray(value.results) || value.results.length > 64) return null
  const roster = parseProjectRoster(value.roster)
  const results = value.results.map(parseExecutorResult)
  if (roster === null || results.some(result => result === null)) return null
  return [
    ...roster.flatMap(entry => [
      {label: entry.name, enabled: false},
      ...entry.running.map(work => ({label: `进行中 · ${work.title}`, enabled: false})),
    ]),
    ...(roster.length && results.length ? [{type: 'separator'}] : []),
    ...results.map(result => ({
      label: `${result.project ?? result.executor} · ${result.title ?? result.delegateId} · ${executorResultDialogOptions(result).message}`,
      click: () => openResult(result),
    })),
  ]
}

function formatSeconds(value, relative = true) {
  return `${relative ? 't=' : ''}${value.toFixed(1)}s`
}

function validText(value, maximum) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

function validSummary(value) {
  return validText(value, 180)
    && !/(^|\s)\/(?:Users|home|private|tmp|var|etc)(?:\/|\b)/u.test(value)
    && !/\b[A-Za-z]:[\\/]/u.test(value)
}

function validTime(value) {
  return Number.isFinite(value) && value >= 0
}
