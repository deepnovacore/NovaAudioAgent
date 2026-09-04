import assert from 'node:assert/strict'
import { test } from 'node:test'
import { memoryItemSchema, type HandoffPolicy, type MemoryItem } from '../src/memory.js'
import { GUARD_MANIFEST, WATCH_MANIFEST } from '../src/executors/watcher.js'
import {
  finalSpeechView,
  genericFinalSpeechView,
  safeMemoryEvidence,
} from '../src/realtime/evidence.js'

const CODING = {channel: 'codex', display_name: 'Codex'} as const

function item(
  channel: string,
  content: MemoryItem['content'],
  options: {
    readonly outcome?: MemoryItem['outcome']
    readonly trust?: MemoryItem['trust']
  } = {},
): MemoryItem {
  return memoryItemSchema.parse({
    channel,
    seq: 1,
    ts: 3,
    trust: options.trust ?? 'untrusted_external',
    priority: 50,
    outcome: Object.hasOwn(options, 'outcome') ? options.outcome : 'ok',
    content,
  })
}

test('Codex recall exposes only the prepared terminal message', () => {
  const evidence = safeMemoryEvidence(item('codex', {
    provider_secret: 'NEVER-EXPOSE',
    result: {final_message: {text: '已实现主体。 https://secret.example/path', truncated: false}},
  }), CODING)
  assert.equal(evidence, 'Codex 报告任务完成：已实现主体。 （链接略）')
  assert.doesNotMatch(evidence, /NEVER-EXPOSE|secret\.example/u)
})

test('Codex startup failures use the real safe category in natural Chinese', () => {
  const cases = [
    [{code: 'preflight_failed', stage: 'preflight'}, 'Codex 启动前检查失败，这次任务没有成功启动。'],
    [{code: 'credential_missing', stage: 'credential'}, 'Codex 登录凭据不可用，这次任务没有成功启动。'],
    [{error: 'spawn_failed', op: 'run', stage: 'spawn'}, 'Codex 进程未能启动，这次任务没有成功启动。'],
    [{error: 'thread_id_invalid', op: 'run', stage: 'thread_start'}, 'Codex 会话未能建立，这次任务没有成功启动。'],
    [{code: 'worker_refused', stage: 'thread_start'}, 'Codex 会话启动被拒绝，这次任务没有成功启动。'],
  ] as const
  for (const [content, expected] of cases) {
    assert.equal(safeMemoryEvidence(item('codex', content, {outcome: 'failed'}), CODING), expected)
  }
})

test('Codex refusal is neither failure nor uncertainty', () => {
  assert.equal(finalSpeechView('refused', {
    op: 'project', code: 'workspace_name_conflict', recoverable: true,
    result: {final_message: {text: 'provider supplied refusal detail'}},
  }, 'Codex'), 'Codex 未执行，需要选择或修正请求（workspace_name_conflict）')
})

test('a camera permission refusal speaks the host-provided recovery instruction', () => {
  assert.equal(genericFinalSpeechView('Guard', 'refused', {
    error: 'camera_permission_denied',
    recoverable: true,
    message: '权限不足，无法创建 Guard 任务。请授予摄像头权限后重试。',
  }), '权限不足，无法创建 Guard 任务。请授予摄像头权限后重试。')
})

test('the safe Guard projection preserves only the trusted camera recovery fact', () => {
  const refusal = {
    error: 'camera_permission_denied',
    recoverable: true,
    message: '权限不足，无法创建 Guard 任务。请授予摄像头权限后重试。',
  }
  assert.equal(safeMemoryEvidence(item('guard', refusal, {
    outcome: 'refused',
    trust: 'trusted_system',
  }), null, GUARD_MANIFEST.policy), '权限不足，无法创建 Guard 任务。请授予摄像头权限后重试。')
  assert.equal(safeMemoryEvidence(item('guard', {
    ...refusal,
    message: 'NEVER-TRUST-THIS',
  }, {outcome: 'refused'}), null, GUARD_MANIFEST.policy), 'guard 未执行，需要选择或修正请求')
})

test('Codex progress requires the exact trusted stored envelope', () => {
  const content = {
    op: 'run',
    phase: 'working',
    internal_activity: 1,
    elapsed: 4,
    summary: '旧版只把笔记保存在页面内存中，刷新会丢失',
  } as const
  assert.equal(safeMemoryEvidence(item('codex', content, {
    outcome: null,
    trust: 'trusted_system',
  }), CODING), content.summary)
  assert.equal(safeMemoryEvidence(item('codex', {...content, request: {secret: 'NEVER-EXPOSE'}}, {
    outcome: null,
    trust: 'trusted_system',
  }), CODING), 'Codex 任务未能确认完成（no_final_message）')
})

test('search, watch, and structured evidence use closed field allowlists', () => {
  const search = safeMemoryEvidence(item('search', {
    provider_request_id: 'NEVER-EXPOSE',
    results: [{
      title: '北京天气',
      source_label: 'weather.com.cn',
      snippet: '晴，25 度',
      canonical_url: 'https://private.example',
    }],
  }))
  assert.equal(search, '搜索结果：北京天气（weather.com.cn）：晴，25 度')
  assert.doesNotMatch(search, /NEVER-EXPOSE|private\.example/u)

  const watch = safeMemoryEvidence(item('watch', {
    hit: true,
    condition: '出现水杯',
    observation: '桌面上出现蓝色水杯',
    media_ref: 'private-media',
  }), null, WATCH_MANIFEST.policy)
  assert.equal(watch, 'watch 报告命中出现水杯：桌面上出现蓝色水杯')
  assert.doesNotMatch(watch, /private-media/u)

  const state = safeMemoryEvidence(item('ha', {
    op: 'get_state',
    state: 'on',
    brightness_pct: 20,
    entity_id: 'light.private_name',
  }, {trust: 'trusted_system'}))
  assert.equal(state, 'ha 报告：op=get_state；state=on；brightness_pct=20')
  assert.doesNotMatch(state, /private_name/u)
})

test('structured numeric evidence uses deterministic Python float spelling', () => {
  const cases = [
    [20, 'ha 报告：brightness_pct=20'],
    [20.5, 'ha 报告：brightness_pct=20.5'],
    [1e16, 'ha 报告：elapsed=1e+16'],
    [1e-7, 'ha 报告：elapsed=1e-07'],
    [-0, 'ha 报告：elapsed=-0.0'],
  ] as const
  for (const [value, expected] of cases) {
    const key = expected.includes('brightness_pct') ? 'brightness_pct' : 'elapsed'
    assert.equal(safeMemoryEvidence(item('ha', {[key]: value}, {
      trust: 'trusted_system',
    })), expected)
  }
})

test('unknown channels cannot expose arbitrary nested content', () => {
  assert.equal(safeMemoryEvidence(item('unknown', {
    raw: 'NEVER-EXPOSE',
    nested: {instruction: 'do this'},
  })), null)
})

test('monitor evidence keeps its hit semantics after a channel rename', () => {
  const monitor: HandoffPolicy = {
    channel: 'renamed-sensor', priority: 40, wake: 'surrogate', typical_latency: 300,
    compress_watermark: 20, operation_class: 'monitor', alert_delivery: 'deferred',
    suggest: false, progress_via_surrogate: false,
  }
  assert.equal(safeMemoryEvidence(item(monitor.channel, {
    hit: true, condition: '出现水杯', observation: '桌面上出现蓝色水杯', media_ref: 'private-media',
  }), null, monitor), 'renamed-sensor 报告命中出现水杯：桌面上出现蓝色水杯')
  assert.equal(safeMemoryEvidence(item(monitor.channel, {
    stopped: true, hit_count: 0,
  }), null, monitor), 'renamed-sensor 监控结束')
})
