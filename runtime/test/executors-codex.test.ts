import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {test} from 'node:test'

import type {
  CodexAppServerTransport,
  SafePreflightReport,
  TransportDeadline,
  TransportObserver,
  TransportOutcome,
} from '../src/codex-app-server-transport.js'
import {CODEX_BASE_MANIFEST} from '../src/codex-contract.js'
import type {
  ExecutorAdapter,
  ExecutorDispatchContext,
  ExecutorHandoff,
} from '../src/causal-runtime.js'
import {VirtualClock} from '../src/clock.js'
import type {JsonValue} from '../src/events.js'
import {CodexTransportError} from '../src/codex-app-server-transport.js'
import {CodexAdapter, CODEX_MANIFEST} from '../src/executors/codex.js'
import {delegateSchema} from '../src/ports.js'
import {compileToolSchema} from '../src/tool-schema.js'
import * as runtimeIndex from '../src/index.js'

const PREFLIGHT: SafePreflightReport = Object.freeze({
  version: '0.145.0',
  root_matches: true,
  mount: 'workspace_only',
  subprocess: 'contained',
  network: 'blocked',
  credential: {present: true, identity: 'chatgpt', policy: 'saved_login'},
  limits: {cpu: 'finite'},
})

class ScriptedTransport implements CodexAppServerTransport {
  readonly calls: string[] = []
  readonly deadlines: TransportDeadline[] = []
  readonly workOrders: string[] = []
  preflightValue: unknown = PREFLIGHT
  preflightError: Error | null = null
  preflightAction: (() => void) | null = null
  outcome: unknown = Object.freeze({
    classification: 'completed',
    code: 'completed',
    turnStartWritten: true,
    completion: {status: 'completed', final_text: 'done', internal_activity: 1},
  })
  runAction: ((observer: TransportObserver, deadline: TransportDeadline) => Promise<unknown>) | null = null

  preflight(deadline: TransportDeadline): Promise<SafePreflightReport> {
    this.calls.push('preflight')
    this.deadlines.push(deadline)
    this.preflightAction?.()
    if (this.preflightError !== null) return Promise.reject(this.preflightError)
    return Promise.resolve(this.preflightValue as SafePreflightReport)
  }

  prewarm(): Promise<SafePreflightReport | null> {
    this.calls.push('prewarm')
    return Promise.resolve(PREFLIGHT)
  }

  async run(
    input: {readonly workOrder: string},
    observer: TransportObserver,
    _deadline: TransportDeadline,
  ): Promise<TransportOutcome> {
    this.calls.push('run')
    this.deadlines.push(_deadline)
    this.workOrders.push(input.workOrder)
    if (this.runAction !== null) return await this.runAction(observer, _deadline) as TransportOutcome
    observer.onThreadReady?.()
    observer.onProgress?.({phase: 'started', internal_activity: 0, elapsed: 0, summary: null})
    return this.outcome as TransportOutcome
  }

  steer(): Promise<{readonly code: 'no_active_turn'; readonly written: false}> {
    this.calls.push('steer')
    return Promise.resolve({code: 'no_active_turn', written: false})
  }

  close(): Promise<void> {
    this.calls.push('close')
    return Promise.resolve()
  }
}

function context(clock = new VirtualClock(7)): ExecutorDispatchContext {
  return {
    clock,
    delegate: delegateSchema.parse({
      delegate_id: 'd-codex-1', executor: 'codex', op: 'run',
      request: {work_order: 'do work'}, origin_ref: 'conversation:1',
      deadline: 607, routing_class: 'user_awaited', dispatched_at: 7,
    }),
    signal: new AbortController().signal,
    progress: () => undefined,
  }
}

function contextFor(
  op: string,
  request: Readonly<Record<string, JsonValue>>,
  options: {
    readonly clock?: VirtualClock
    readonly signal?: AbortSignal
    readonly progress?: ExecutorDispatchContext['progress']
  } = {},
): ExecutorDispatchContext {
  const clock = options.clock ?? new VirtualClock(7)
  return {
    clock,
    delegate: delegateSchema.parse({
      delegate_id: `d-codex-${op}`, executor: 'codex', op, request,
      origin_ref: 'conversation:1', deadline: clock.now() + 600,
      routing_class: 'user_awaited', dispatched_at: clock.now(),
    }),
    signal: options.signal ?? new AbortController().signal,
    progress: options.progress ?? (() => undefined),
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>(resolve => { resolvePromise = resolve })
  return {promise, resolve: resolvePromise}
}

const COMPLETE_OUTCOME: TransportOutcome = Object.freeze({
  classification: 'completed',
  code: 'completed',
  turnStartWritten: true,
  completion: {status: 'completed' as const, final_text: 'done', internal_activity: 1},
})

type CodexAdapterConstructor = new (transport: CodexAppServerTransport) => ExecutorAdapter

test('ordinary adapter projects a valid app-server run into bounded public evidence', async () => {
  // This fails if 6A/6B remain disconnected or if the adapter copies transport-private state.
  const Constructor = (runtimeIndex as Readonly<Record<string, unknown>>).CodexAdapter
  const adapter: ExecutorAdapter = typeof Constructor === 'function'
    ? new (Constructor as CodexAdapterConstructor)(new ScriptedTransport())
    : {
        manifest: CODEX_BASE_MANIFEST,
        dispatch: (): Promise<ExecutorHandoff> => Promise.resolve({
          outcome: 'failed', trust: 'trusted_system', content: {error: 'not_implemented'},
        }),
      }

  const handoff = await adapter.dispatch('run', {work_order: '  do work  '}, context())

  assert.equal(handoff.outcome, 'ok')
  assert.equal(handoff.trust, 'untrusted_external')
  assert.deepEqual(handoff.content, {
    op: 'run',
    worker: 'codex',
    code: 'completed',
    events: [
      {type: 'thread.started'},
      {type: 'turn.started'},
      {type: 'internal_activity', count: 1},
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
    result: {final_message: {
      text: 'done', original_chars: 4, truncated: false,
      sha256: createHash('sha256').update('done', 'utf8').digest('hex'),
    }},
    preflight: PREFLIGHT,
    goal_verification: 'unverified',
  })
})

test('ordinary manifest compiles the exact public tool order and schema', () => {
  // This fails if the adapter advertises a project/live op or the compiler receives a look-alike manifest.
  const adapter: ExecutorAdapter = new CodexAdapter(new ScriptedTransport())
  assert.equal(adapter.manifest, CODEX_MANIFEST)
  assert.equal(CODEX_MANIFEST, CODEX_BASE_MANIFEST)
  assert.deepEqual(CODEX_MANIFEST.ops.map(op => op.name), ['run', 'status'])
  const compiled = compileToolSchema([adapter.manifest])
  assert.deepEqual([...compiled.bindings.keys()].slice(-2), ['codex__run', 'codex__status'])
  assert.deepEqual(compiled.schemas.slice(-2), [
    {type: 'function', function: {
      name: 'codex__run',
      description: '在配置好的工作区中执行一个有界、非交互的 Codex 工作单',
      parameters: {
        type: 'object',
        properties: {
          work_order: {type: 'string', minLength: 1, maxLength: 4000},
          origin_ref: {type: 'string', description: '当前 ContextView 中、这次动作所回答内容的 ref'},
        },
        required: ['work_order', 'origin_ref'],
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
})

test('ordinary validation is exact, Python-compatible, and transport-free on rejection', async () => {
  // This fails if validation uses trim/UTF-16 length, accepts decorated objects, or calls the transport first.
  const invalid: readonly [string, unknown][] = [
    ['missing', {}],
    ['status', {extra: true}],
    ['run', {}],
    ['run', {work_order: '\u001c\u0085'}],
    ['run', {work_order: 'x'.repeat(4001)}],
    ['run', {work_order: new String('boxed')}],
    ['run', {work_order: '\ud800'}],
    ['run', {work_order: 'ok', extra: true}],
  ]
  for (const [op, request] of invalid) {
    const transport = new ScriptedTransport()
    const handoff = await new CodexAdapter(transport).dispatch(
      op,
      request as Readonly<Record<string, JsonValue>>,
      contextFor(op, {}),
    )
    assert.equal(handoff.outcome, 'failed')
    assert.deepEqual(handoff.content, {error: op === 'missing' ? 'unknown_op' : 'invalid_params', op})
    assert.deepEqual(transport.calls, [])
  }

  let getterReads = 0
  const hostile = Object.create(null) as Record<string, unknown>
  Object.defineProperty(hostile, 'work_order', {
    enumerable: true,
    get: () => { getterReads += 1; return 'private getter' },
  })
  const hostileTransport = new ScriptedTransport()
  const hostileResult = await new CodexAdapter(hostileTransport).dispatch(
    'run', hostile as Readonly<Record<string, JsonValue>>, contextFor('run', {}),
  )
  assert.deepEqual(hostileResult.content, {error: 'invalid_params', op: 'run'})
  assert.equal(getterReads, 0)
  assert.deepEqual(hostileTransport.calls, [])

  const transport = new ScriptedTransport()
  const accepted = await new CodexAdapter(transport).dispatch(
    'run', {work_order: `\u001c${'😀'.repeat(4000)}\u0085`}, contextFor('run', {}),
  )
  assert.equal(accepted.outcome, 'ok')
  assert.deepEqual(transport.workOrders, ['😀'.repeat(4000)])
})

test('ordinary status, busy rejection, and one absolute deadline follow the active run', async () => {
  // This fails if runs queue, status uses stale time, or preflight/run receive different budgets.
  const clock = new VirtualClock(7)
  const release = deferred<TransportOutcome>()
  const started = deferred<void>()
  const transport = new ScriptedTransport()
  transport.runAction = async observer => {
    observer.onThreadReady?.()
    observer.onProgress?.({phase: 'started', internal_activity: 0, elapsed: 0, summary: null})
    started.resolve()
    return await release.promise
  }
  const adapter = new CodexAdapter(transport, {wallNowMilliseconds: () => 1_000})
  const running = adapter.dispatch('run', {work_order: 'one'}, contextFor('run', {}, {clock}))
  await started.promise
  clock.advanceTo(12)

  const status = await adapter.dispatch('status', {}, contextFor('status', {}, {clock}))
  const busyWork = adapter.dispatch('run', {work_order: 'two'}, contextFor('run', {}, {clock}))
  const nextTurn = deferred<'next-turn'>()
  setImmediate(() => { nextTurn.resolve('next-turn') })
  const busyWinner = await Promise.race([busyWork, nextTurn.promise])
  assert.notEqual(busyWinner, 'next-turn', 'busy rejection must settle without queueing')
  const busy = busyWinner as ExecutorHandoff
  assert.deepEqual(status.content, {
    op: 'status', state: 'running', run_sequence: 1,
    started_at: 7, finished_at: null, elapsed: 5,
    process: {running: true, exited: false, exit_code: null},
    protocol: {terminal: null}, preflight: {verdict: 'passed'},
  })
  assert.deepEqual(busy.content, {error: 'busy', op: 'run'})
  assert.deepEqual(transport.workOrders, ['one'])
  assert.equal(transport.deadlines[0], transport.deadlines[1])
  assert.equal(transport.deadlines[0]?.expiresAtMs, 541_000)

  release.resolve(COMPLETE_OUTCOME)
  const completed = await running
  assert.equal(completed.outcome, 'ok')
  assert.equal(adapter.status.state, 'exited')
  assert.equal(adapter.status.finished_at, 12)
  assert.equal(adapter.status.elapsed, 5)
})

test('ordinary aggregate deadline stops before run and keeps the preflight report private-safe', async () => {
  // This fails if each phase receives a fresh 540-second budget or expiry is checked only before await.
  const clock = new VirtualClock(7)
  const transport = new ScriptedTransport()
  transport.preflightAction = () => { clock.advanceTo(547) }
  const handoff = await new CodexAdapter(transport).dispatch(
    'run', {work_order: 'bounded'}, contextFor('run', {}, {clock}),
  )
  assert.equal(handoff.outcome, 'failed')
  assert.equal(handoff.trust, 'trusted_system')
  assert.equal(handoff.content.code, 'adapter_timeout')
  assert.deepEqual(transport.calls, ['preflight'])
})

test('ordinary maps pre/post-side-effect failures without leaking internal text', async () => {
  // This fails if preflight success is treated as a turn side effect or arbitrary exception text is copied.
  const cases: readonly Readonly<{
    configure: (transport: ScriptedTransport) => void
    expected: readonly [ExecutorHandoff['outcome'], ExecutorHandoff['trust'], string]
  }>[] = [
    {
      configure: transport => { transport.preflightError = new CodexTransportError('credential_missing') },
      expected: ['failed', 'trusted_system', 'credential_missing'],
    },
    {
      configure: transport => { transport.preflightError = new Error('PRIVATE-PREFLIGHT-SENTINEL') },
      expected: ['failed', 'trusted_system', 'worker_exception_before_start'],
    },
    {
      configure: transport => {
        transport.outcome = {classification: 'refused', code: 'server_rejected', turnStartWritten: false, completion: null}
      },
      expected: ['failed', 'trusted_system', 'worker_refused'],
    },
    {
      configure: transport => {
        transport.outcome = {classification: 'uncertain', code: 'transport_lost', turnStartWritten: true, completion: null}
      },
      expected: ['unknown', 'untrusted_external', 'transport_lost'],
    },
    {
      configure: transport => {
        transport.outcome = {
          classification: 'completed', code: 'completed', turnStartWritten: true,
          completion: {status: 'failed', final_text: null, internal_activity: 0},
        }
      },
      expected: ['unknown', 'untrusted_external', 'invalid_worker_result'],
    },
    {
      configure: transport => {
        transport.runAction = () => Promise.reject(new Error('PRIVATE-BEFORE-WRITE-SENTINEL'))
      },
      expected: ['failed', 'trusted_system', 'worker_exception_before_start'],
    },
    {
      configure: transport => {
        transport.runAction = observer => {
          observer.onProgress?.({phase: 'started', internal_activity: 0, elapsed: 0, summary: null})
          return Promise.reject(new Error('PRIVATE-RUN-SENTINEL'))
        }
      },
      expected: ['unknown', 'untrusted_external', 'worker_exception_after_start'],
    },
  ]
  for (const entry of cases) {
    const transport = new ScriptedTransport()
    entry.configure(transport)
    const handoff = await new CodexAdapter(transport).dispatch(
      'run', {work_order: 'PRIVATE-WORK-ORDER'}, contextFor('run', {}),
    )
    assert.deepEqual([handoff.outcome, handoff.trust, handoff.content.code], entry.expected)
    const publicText = JSON.stringify({handoff, status: new CodexAdapter(new ScriptedTransport()).status})
    assert.equal(publicText.includes('PRIVATE-PREFLIGHT-SENTINEL'), false)
    assert.equal(publicText.includes('PRIVATE-RUN-SENTINEL'), false)
    assert.equal(JSON.stringify(handoff).includes('PRIVATE-WORK-ORDER'), false)
  }
})

test('ordinary rejects hostile or contradictory completion before public evidence', async () => {
  // This fails if typed transport objects can smuggle accessors, extra fields, or invalid final text.
  let getterReads = 0
  const hostile = Object.create(null) as Record<string, unknown>
  for (const [key, value] of Object.entries({
    classification: 'completed', code: 'completed', turnStartWritten: true,
  })) Object.defineProperty(hostile, key, {value, enumerable: true})
  Object.defineProperty(hostile, 'completion', {
    enumerable: true,
    get: () => { getterReads += 1; return {status: 'completed', final_text: 'PRIVATE', internal_activity: 0} },
  })
  const hostileTransport = new ScriptedTransport()
  hostileTransport.outcome = hostile
  const rejected = await new CodexAdapter(hostileTransport).dispatch(
    'run', {work_order: 'work'}, contextFor('run', {}),
  )
  assert.equal(rejected.content.code, 'invalid_worker_result')
  assert.equal(getterReads, 0)

  for (const completion of [
    {status: 'completed', final_text: '\ud800', internal_activity: 0},
    {status: 'completed', final_text: 'x'.repeat(4001), internal_activity: 0},
    {status: 'completed', final_text: 'line\nfeed', internal_activity: 0},
  ]) {
    const transport = new ScriptedTransport()
    transport.outcome = {
      classification: 'completed', code: 'completed', turnStartWritten: true, completion,
    }
    const handoff = await new CodexAdapter(transport).dispatch(
      'run', {work_order: 'work'}, contextFor('run', {}),
    )
    assert.equal(handoff.outcome, 'unknown')
    assert.equal(handoff.content.code, 'invalid_worker_result')
    assert.equal(JSON.stringify(handoff).includes('line\\nfeed'), false)
  }
})

test('ordinary cancellation waits for transport settlement, rethrows, and releases busy state', async () => {
  // This fails if cancellation fabricates a handoff or leaves the adapter permanently busy.
  const controller = new AbortController()
  const entered = deferred<void>()
  const transport = new ScriptedTransport()
  transport.runAction = async (observer, deadline) => {
    observer.onThreadReady?.()
    observer.onProgress?.({phase: 'started', internal_activity: 0, elapsed: 0, summary: null})
    entered.resolve()
    await new Promise<void>(resolve => {
      deadline.signal?.addEventListener('abort', () => { resolve() }, {once: true})
    })
    return {classification: 'uncertain', code: 'transport_lost', turnStartWritten: true, completion: null}
  }
  const adapter = new CodexAdapter(transport)
  const running = adapter.dispatch(
    'run', {work_order: 'first'}, contextFor('run', {}, {signal: controller.signal}),
  )
  await entered.promise
  controller.abort()
  await assert.rejects(running, {name: 'AbortError'})

  transport.runAction = null
  transport.outcome = COMPLETE_OUTCOME
  const next = await adapter.dispatch('run', {work_order: 'next'}, contextFor('run', {}))
  assert.equal(next.outcome, 'ok')
  assert.equal(adapter.status.run_sequence, 2)
})

test('ordinary pre-aborted dispatch never invokes a transport method', async () => {
  // This fails if the promise is created before the aggregate deadline/abort pre-check.
  const controller = new AbortController()
  controller.abort()
  const transport = new ScriptedTransport()
  const dispatch = new CodexAdapter(transport).dispatch(
    'run', {work_order: 'must not run'}, contextFor('run', {}, {signal: controller.signal}),
  )
  await assert.rejects(dispatch, {name: 'AbortError'})
  assert.deepEqual(transport.calls, [])
})
