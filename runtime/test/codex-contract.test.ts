import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {test} from 'node:test'
import {
  CODEX_BASE_MANIFEST,
  CODEX_LIVE_MANIFEST,
  CODEX_PROJECT_MANIFEST,
  INTERNAL_CODEX_RUN_DEADLINE,
  classifyCodexResult,
  createCodexRunEnvelope,
  createInitialCodexStatus,
  projectCodexStatus,
  sanitizeCodexEvidence,
  sanitizeCodexPreflightReport,
  sanitizePublicPreflightCode,
  validateCodexRequest,
} from '../src/codex-contract.js'
import {compileToolSchema} from '../src/tool-schema.js'
import * as runtimeIndex from '../src/index.js'

function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function validEvidence(): Record<string, unknown> {
  return {
    events: [
      {type: 'thread.started'},
      {type: 'turn.started'},
      {type: 'error'},
      {type: 'internal_activity', count: 3},
      {type: 'turn.completed'},
    ],
    protocol: {
      thread_started: true,
      turn_started: true,
      terminal: 'completed',
      transport_closed: true,
      unknown_event_count: 0,
    },
    process: {started: true, exit_code: 0, stop: 'none'},
    result: {
      final_message: {text: '完成', original_chars: 2, truncated: false, sha256: digest('完成')},
    },
  }
}

function record(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, 'object')
  assert.notEqual(value, null)
  assert.equal(Array.isArray(value), false)
  return value as Record<string, unknown>
}

function finalMessage(value: Record<string, unknown>): Record<string, unknown> {
  return record(record(value.result).final_message)
}

function replaceFinalText(value: Record<string, unknown>, text: string): void {
  const message = finalMessage(value)
  message.text = text
  message.original_chars = Array.from(text).length
  message.truncated = false
  message.sha256 = digest(text)
}

test('base, live, and project manifests pin exact immutable public operations and policy', () => {
  assert.deepEqual(CODEX_BASE_MANIFEST.ops.map(op => op.name), ['run', 'status'])
  assert.deepEqual(CODEX_LIVE_MANIFEST.ops.map(op => op.name), ['run', 'steer', 'status'])
  assert.deepEqual(CODEX_PROJECT_MANIFEST.ops.map(op => op.name), ['run', 'project', 'steer', 'status'])
  for (const manifest of [CODEX_BASE_MANIFEST, CODEX_LIVE_MANIFEST, CODEX_PROJECT_MANIFEST]) {
    assert.equal(manifest.name, 'codex')
    assert.deepEqual(manifest.policy, {
      channel: 'codex',
      priority: 50,
      wake: 'fast',
      typical_latency: 180,
      compress_watermark: 5,
      suggest: false,
      progress_via_surrogate: true,
    })
    assert.equal(Object.isFrozen(manifest), true)
    assert.equal(Object.isFrozen(manifest.ops), true)
  }
  assert.equal(INTERNAL_CODEX_RUN_DEADLINE, 540)
})

test('the runtime package root exposes only the pure Codex foundation', () => {
  const exports = runtimeIndex as Readonly<Record<string, unknown>>
  assert.equal(exports.CODEX_BASE_MANIFEST, CODEX_BASE_MANIFEST)
  assert.equal(exports.JsonRpcConnection !== undefined, true)
  assert.equal(exports.CodexJsonlParser !== undefined, true)
  assert.equal(exports.AppServerTurnProjection !== undefined, true)
  for (const forbidden of ['CodexProcess', 'CodexTransport', 'CodexAdapter', 'spawnCodex']) {
    assert.equal(Object.hasOwn(exports, forbidden), false)
  }
})

test('compileToolSchema emits exact Codex names, descriptions, deadlines, and bindings', () => {
  const compiled = compileToolSchema([CODEX_PROJECT_MANIFEST])
  assert.deepEqual([...compiled.bindings.keys()], [
    'update_intent', 'update_goal', 'update_authorization',
    'codex__run', 'codex__project', 'codex__steer', 'codex__status',
  ])
  const codexSchemas = compiled.schemas.slice(3)
  assert.deepEqual(codexSchemas, [
    {type: 'function', function: {
      name: 'codex__run',
      description: '在当前工作区启动一个新的 Codex Session 执行工作单',
      parameters: {
        type: 'object',
        properties: {
          work_order: {type: 'string', minLength: 1, maxLength: 4000},
          session: {type: 'string', minLength: 1, maxLength: 120},
          origin_ref: {type: 'string', description: '当前 ContextView 中、这次动作所回答内容的 ref'},
        },
        required: ['work_order', 'origin_ref'],
        additionalProperties: false,
      },
    }},
    {type: 'function', function: {
      name: 'codex__project',
      description: '列出、创建或切换工作区，以及列出或继续其中的 Session',
      parameters: {
        type: 'object',
        properties: {
          action: {type: 'string', enum: ['list', 'create', 'select', 'sessions', 'resume']},
          workspace: {type: 'string', minLength: 1, maxLength: 80},
          session: {type: 'string', minLength: 1, maxLength: 120},
          work_order: {type: 'string', minLength: 1, maxLength: 4000},
          origin_ref: {type: 'string', description: '当前 ContextView 中、这次动作所回答内容的 ref'},
        },
        required: ['action', 'origin_ref'],
        additionalProperties: false,
      },
    }},
    {type: 'function', function: {
      name: 'codex__steer',
      description: '向当前仍在执行的 Codex turn 追加约束；不终止、不重启、不创建下一轮。',
      parameters: {
        type: 'object',
        properties: {
          instruction: {type: 'string', minLength: 1, maxLength: 2000},
          origin_ref: {type: 'string', description: '当前 ContextView 中、这次动作所回答内容的 ref'},
        },
        required: ['instruction', 'origin_ref'],
        additionalProperties: false,
      },
    }},
    {type: 'function', function: {
      name: 'codex__status',
      description: '读取当前或最近一次 Codex 运行的进程状态',
      parameters: {
        type: 'object',
        properties: {
          origin_ref: {type: 'string', description: '当前 ContextView 中、这次动作所回答内容的 ref'},
        },
        additionalProperties: false,
        required: ['origin_ref'],
      },
    }},
  ])
  assert.equal(CODEX_PROJECT_MANIFEST.ops[0]?.deadline_budget, 600)
  assert.equal(CODEX_PROJECT_MANIFEST.ops[1]?.deadline_budget, 10)
  assert.equal(CODEX_PROJECT_MANIFEST.ops[2]?.deadline_budget, 30)
  assert.equal(CODEX_PROJECT_MANIFEST.ops[3]?.deadline_budget, 5)
  assert.deepEqual(CODEX_PROJECT_MANIFEST.ops[0]?.sensitive_params, ['work_order'])
  assert.deepEqual(CODEX_PROJECT_MANIFEST.ops[2]?.sensitive_params, ['instruction'])
})

test('base and live request validators use primitive strings, Python strip, and code points', () => {
  assert.deepEqual(validateCodexRequest('base', 'run', {work_order: '  做事\u001c'}), {
    ok: true, value: {work_order: '做事'},
  })
  assert.deepEqual(validateCodexRequest('live', 'steer', {instruction: ' 约束 '}), {
    ok: true, value: {instruction: '约束'},
  })
  assert.equal(validateCodexRequest('base', 'run', {work_order: '😀'.repeat(4000)}).ok, true)
  assert.equal(validateCodexRequest('base', 'run', {work_order: '😀'.repeat(4001)}).ok, false)
  assert.equal(validateCodexRequest('base', 'run', {work_order: '\u001c\u0085'}).ok, false)
  assert.equal(validateCodexRequest('base', 'run', {work_order: '\ufeff'}).ok, true)
  assert.equal(validateCodexRequest('base', 'run', {work_order: new String('boxed')}).ok, false)
  assert.equal(validateCodexRequest('base', 'run', {work_order: 'ok', extra: true}).ok, false)
  assert.deepEqual(validateCodexRequest('base', 'missing', {}), {
    ok: false, error: 'unknown_op', op: 'missing',
  })
  assert.deepEqual(validateCodexRequest('base', 'status', {}), {ok: true, value: {}})
  assert.equal(validateCodexRequest('base', 'status', {extra: true}).ok, false)
})

test('project request validator enforces action-specific exact keys and bounds', () => {
  assert.deepEqual(validateCodexRequest('project', 'run', {
    work_order: ' build ', session: ' sprint ',
  }), {ok: true, value: {work_order: 'build', session: 'sprint'}})
  assert.deepEqual(validateCodexRequest('project', 'project', {action: 'list'}), {
    ok: true, value: {action: 'list'},
  })
  assert.equal(validateCodexRequest('project', 'project', {action: 'list', workspace: 'x'}).ok, false)
  assert.equal(validateCodexRequest('project', 'project', {action: 'create'}).ok, false)
  assert.equal(validateCodexRequest('project', 'project', {
    action: 'create', workspace: '新'.repeat(80), work_order: 'do',
  }).ok, true)
  assert.equal(validateCodexRequest('project', 'project', {
    action: 'create', workspace: '😀'.repeat(81),
  }).ok, false)
  assert.equal(validateCodexRequest('project', 'project', {
    action: 'resume', work_order: 'continue', session: 's'.repeat(121),
  }).ok, false)
  assert.equal(validateCodexRequest('live', 'project', {action: 'list'}).ok, false)
})

test('status and run envelope helpers have fixed private-safe nesting', () => {
  assert.deepEqual(createInitialCodexStatus({live: false}), {
    op: 'status',
    state: 'idle',
    run_sequence: 0,
    started_at: null,
    finished_at: null,
    elapsed: null,
    process: {running: false, exited: false, exit_code: null},
    protocol: {terminal: null},
    preflight: {verdict: 'not_run'},
  })
  assert.deepEqual(createInitialCodexStatus({live: true}), {
    ...createInitialCodexStatus({live: false}),
    prewarm: {state: 'cold'},
  })
  assert.deepEqual(createCodexRunEnvelope('completed', {version: 'codex-cli 1.2.3'}), {
    op: 'run',
    worker: 'codex',
    code: 'completed',
    preflight: {version: 'codex-cli 1.2.3'},
    goal_verification: 'unverified',
  })
  assert.equal(JSON.stringify(createCodexRunEnvelope('PRIVATE BAD', {})).includes('PRIVATE'), false)

  const withEvidence = createCodexRunEnvelope('completed', {}, validEvidence())
  assert.deepEqual(withEvidence.events, validEvidence().events)
  assert.deepEqual(withEvidence.protocol, validEvidence().protocol)
  assert.deepEqual(withEvidence.process, validEvidence().process)
  assert.deepEqual(withEvidence.result, validEvidence().result)

  const hostileEvidence = structuredClone(validEvidence())
  hostileEvidence.private = 'PRIVATE'
  const rejectedEvidence = createCodexRunEnvelope('completed', {}, hostileEvidence)
  assert.equal(Object.hasOwn(rejectedEvidence, 'events'), false)
  assert.equal(JSON.stringify(rejectedEvidence).includes('PRIVATE'), false)
})

test('live status projects current elapsed and only bounded running progress', () => {
  const snapshot = {
    state: 'running' as const,
    run_sequence: 1,
    started_at: 11,
    finished_at: null,
    elapsed: null,
    process_running: true,
    process_exited: false,
    terminal: null,
    exit_code: null,
    preflight: 'passed' as const,
    prewarm: 'ready' as const,
  }
  assert.deepEqual(projectCodexStatus(snapshot, 12, {
    live: true,
    progress: {
      phase: 'working', internal_activity: 3, elapsed: 1,
      summary: '已实现旋转与消行，正在写测试。',
    },
  }), {
    op: 'status',
    state: 'running',
    run_sequence: 1,
    started_at: 11,
    finished_at: null,
    elapsed: 1,
    process: {running: true, exited: false, exit_code: null},
    protocol: {terminal: null},
    preflight: {verdict: 'passed'},
    prewarm: {state: 'ready'},
    progress: {internal_activity: 3, summary: '已实现旋转与消行，正在写测试。'},
  })
  assert.equal(Object.hasOwn(projectCodexStatus(
    {...snapshot, state: 'exited', process_running: false, process_exited: true},
    12,
    {live: true, progress: {
      phase: 'working', internal_activity: 3, elapsed: 1, summary: 'PRIVATE-STALE',
    }},
  ), 'progress'), false)
  assert.equal(Object.hasOwn(projectCodexStatus(snapshot, 12, {
    live: true,
    progress: {
      phase: 'working', internal_activity: 3, elapsed: 1, summary: '😀'.repeat(401),
    },
  }), 'progress'), false)
})

test('evidence admission preserves only exact bounded credential-free data', () => {
  assert.deepEqual(sanitizeCodexEvidence(validEvidence()), validEvidence())
  const rendered = JSON.stringify(sanitizeCodexEvidence(validEvidence()))
  assert.equal(rendered.includes('command'), false)
  assert.equal(rendered.includes('path'), false)
  assert.equal(rendered.includes('token'), false)

  const hostile = validEvidence()
  hostile.private = 'PRIVATE'
  assert.equal(sanitizeCodexEvidence(hostile), null)

  const event = validEvidence()
  ;(event.events as unknown[]).splice(2, 0, {type: 'command', command: 'PRIVATE'})
  assert.equal(sanitizeCodexEvidence(event), null)

  const duplicateActivity = validEvidence()
  ;(duplicateActivity.events as unknown[]).splice(3, 0, {type: 'internal_activity', count: 1})
  assert.equal(sanitizeCodexEvidence(duplicateActivity), null)
})

test('final evidence requires pinned NFC, Python printable text, truthful lengths, and SHA-256', () => {
  const mutations: ((value: Record<string, unknown>) => void)[] = [
    value => { replaceFinalText(value, 'e\u0301') },
    value => { replaceFinalText(value, 'bad\nline') },
    value => { replaceFinalText(value, '\u00a0') },
    value => { finalMessage(value).original_chars = 1 },
    value => { finalMessage(value).truncated = true },
    value => { finalMessage(value).sha256 = 'A'.repeat(64) },
    value => { record(value.process).exit_code = Number.MAX_SAFE_INTEGER + 1 },
    value => { record(value.protocol).unknown_event_count = -1 },
  ]
  for (const mutate of mutations) {
    const value = structuredClone(validEvidence())
    mutate(value)
    assert.equal(sanitizeCodexEvidence(value), null)
  }

  const astral = validEvidence()
  const text = '😀'.repeat(4000)
  record(astral.result).final_message = {
    text, original_chars: 4000, truncated: false, sha256: digest(text),
  }
  assert.equal(sanitizeCodexEvidence(astral) !== null, true)
  finalMessage(astral).text = `${String(finalMessage(astral).text)}😀`
  assert.equal(sanitizeCodexEvidence(astral), null)
})

test('classification and preflight code boundaries depend only on safe host state', () => {
  assert.deepEqual(classifyCodexResult({classification: 'completed', turnWritten: true}), {
    outcome: 'ok', trust: 'untrusted_external',
  })
  assert.deepEqual(classifyCodexResult({classification: 'refused', turnWritten: false}), {
    outcome: 'failed', trust: 'trusted_system',
  })
  assert.deepEqual(classifyCodexResult({classification: 'refused', turnWritten: true}), {
    outcome: 'unknown', trust: 'untrusted_external',
  })
  assert.deepEqual(classifyCodexResult({classification: 'uncertain', turnWritten: true}), {
    outcome: 'unknown', trust: 'untrusted_external',
  })
  assert.equal(sanitizePublicPreflightCode('binary_missing', 'preflight_failed'), 'binary_missing')
  assert.equal(sanitizePublicPreflightCode('PRIVATE_RAW', 'preflight_failed'), 'preflight_failed')
  assert.equal(sanitizePublicPreflightCode(new String('binary_missing'), 'spawn_failed'), 'spawn_failed')
  assert.equal(sanitizePublicPreflightCode('PRIVATE_RAW', 'PRIVATE_FALLBACK'), 'preflight_failed')
})

test('preflight report sanitizer drops unknown content and admits only typed safe verdicts', () => {
  assert.deepEqual(sanitizeCodexPreflightReport({
    version: 'codex-cli 1.2.3',
    root_matches: true,
    mount: 'workspace_only',
    subprocess: 'contained',
    network: 'blocked',
    credential: {present: true, identity: 'chatgpt', policy: 'saved_login', token: 'PRIVATE'},
    limits: {stdout: 'finite'},
    raw_path: '/PRIVATE/PATH',
  }), {
    version: 'codex-cli 1.2.3',
    root_matches: true,
    mount: 'workspace_only',
    subprocess: 'contained',
    network: 'blocked',
    credential: {present: true, identity: 'chatgpt', policy: 'saved_login'},
    limits: {stdout: 'finite'},
  })
  assert.equal(sanitizeCodexPreflightReport({version: 'PRIVATE VERSION'}), null)
  assert.equal(sanitizeCodexPreflightReport({credential: {identity: 'PRIVATE'}}), null)
})

test('public contract helpers fail closed when hostile objects throw during inspection', () => {
  const hostile = new Proxy({}, {
    ownKeys: () => { throw new Error('PRIVATE OWN KEYS') },
    getOwnPropertyDescriptor: () => { throw new Error('PRIVATE PROPERTY') },
  })
  assert.doesNotThrow(() => {
    assert.deepEqual(validateCodexRequest('base', 'run', hostile), {
      ok: false, error: 'invalid_params', op: 'run',
    })
    assert.equal(sanitizeCodexEvidence(hostile), null)
    assert.equal(sanitizeCodexPreflightReport(hostile), null)
  })
})
