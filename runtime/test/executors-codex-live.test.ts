import assert from 'node:assert/strict'
import {test} from 'node:test'

import type {
  CodexAppServerTransport,
  SafePreflightReport,
  SteerInput,
  SteerTransportResult,
  TransportDeadline,
  TransportObserver,
  TransportOutcome,
} from '../src/codex-app-server-transport.js'
import {CODEX_LIVE_MANIFEST} from '../src/codex-contract.js'
import type {ExecutorDispatchContext, ExecutorProgress} from '../src/causal-runtime.js'
import {VirtualClock} from '../src/clock.js'
import {CodexLiveAdapter} from '../src/executors/codex-live.js'
import type {JsonValue} from '../src/events.js'
import {delegateSchema} from '../src/ports.js'
import {compileToolSchema} from '../src/tool-schema.js'

const PREFLIGHT: SafePreflightReport = Object.freeze({
  version: '0.145.0',
  root_matches: true,
  mount: 'workspace_only',
  subprocess: 'contained',
  network: 'blocked',
  credential: {present: true, identity: 'chatgpt', policy: 'saved_login'},
  limits: {cpu: 'finite'},
})

const COMPLETE_OUTCOME: TransportOutcome = Object.freeze({
  classification: 'completed',
  code: 'completed',
  turnStartWritten: true,
  completion: {status: 'completed' as const, final_text: 'done', internal_activity: 1},
})

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>(resolve => { resolvePromise = resolve })
  return {promise, resolve: resolvePromise}
}

class LiveTransport implements CodexAppServerTransport {
  readonly calls: string[] = []
  readonly workOrders: string[] = []
  readonly instructions: string[] = []
  prewarmValue: unknown = PREFLIGHT
  prewarmError: Error | null = null
  prewarmAction: ((deadline: TransportDeadline) => Promise<unknown>) | null = null
  preflightValue: unknown = PREFLIGHT
  runAction: ((observer: TransportObserver, deadline: TransportDeadline) => Promise<unknown>) | null = null
  steerResults: unknown[] = []
  closeCalls = 0

  preflight(): Promise<SafePreflightReport> {
    this.calls.push('preflight')
    return Promise.resolve(this.preflightValue as SafePreflightReport)
  }

  async prewarm(deadline: TransportDeadline): Promise<SafePreflightReport | null> {
    this.calls.push('prewarm')
    if (this.prewarmAction !== null) return await this.prewarmAction(deadline) as SafePreflightReport | null
    if (this.prewarmError !== null) return Promise.reject(this.prewarmError)
    return this.prewarmValue as SafePreflightReport | null
  }

  async run(
    input: {readonly workOrder: string},
    observer: TransportObserver,
    deadline: TransportDeadline,
  ): Promise<TransportOutcome> {
    this.calls.push('run')
    this.workOrders.push(input.workOrder)
    if (this.runAction !== null) return await this.runAction(observer, deadline) as TransportOutcome
    observer.onThreadReady?.()
    observer.onProgress?.({phase: 'started', internal_activity: 0, elapsed: 0, summary: null})
    return COMPLETE_OUTCOME
  }

  steer(input: SteerInput): Promise<SteerTransportResult> {
    this.calls.push('steer')
    this.instructions.push(input.instruction)
    return Promise.resolve(
      (this.steerResults.shift() ?? {code: 'accepted', written: true}) as SteerTransportResult,
    )
  }

  close(): Promise<void> {
    this.calls.push('close')
    this.closeCalls += 1
    return Promise.resolve()
  }
}

function context(
  op: string,
  request: Readonly<Record<string, JsonValue>>,
  options: {
    readonly clock?: VirtualClock
    readonly signal?: AbortSignal
    readonly progress?: (progress: ExecutorProgress) => void
  } = {},
): ExecutorDispatchContext {
  const clock = options.clock ?? new VirtualClock(7)
  return {
    clock,
    delegate: delegateSchema.parse({
      delegate_id: `d-live-${op}`, executor: 'codex', op, request,
      origin_ref: 'conversation:1', deadline: clock.now() + (op === 'steer' ? 30 : 600),
      routing_class: 'user_awaited', dispatched_at: clock.now(),
    }),
    signal: options.signal ?? new AbortController().signal,
    progress: options.progress ?? (() => undefined),
  }
}

test('live manifest compiles exact run, steer, status order and sensitivity', () => {
  // This fails if live accidentally inherits project operations or loses the sensitive steer boundary.
  const adapter = new CodexLiveAdapter(new LiveTransport())
  assert.equal(adapter.manifest, CODEX_LIVE_MANIFEST)
  assert.deepEqual(adapter.manifest.ops.map(op => op.name), ['run', 'steer', 'status'])
  assert.deepEqual(adapter.manifest.ops[1]?.sensitive_params, ['instruction'])
  assert.deepEqual([...compileToolSchema([adapter.manifest]).bindings.keys()].slice(-3), [
    'codex__run', 'codex__steer', 'codex__status',
  ])
  assert.deepEqual(adapter.status, {
    state: 'idle', run_sequence: 0, started_at: null, finished_at: null, elapsed: null,
    process_running: false, process_exited: false, terminal: null, exit_code: null,
    preflight: 'not_run', prewarm: 'cold',
  })
  assert.equal(Object.isFrozen(adapter.status), true)
})

test('live validation rejects before transport and uses Python strip/code-point limits', async () => {
  // This fails if steer accepts extra keys, UTF-16 limits, boxed strings, or JavaScript-only whitespace.
  const invalid: unknown[] = [
    {},
    {instruction: '\u001c\u0085'},
    {instruction: '😀'.repeat(2001)},
    {instruction: new String('boxed')},
    {instruction: '\ud800'},
    {instruction: 'ok', extra: true},
  ]
  for (const request of invalid) {
    const transport = new LiveTransport()
    const handoff = await new CodexLiveAdapter(transport).dispatch(
      'steer', request as Readonly<Record<string, JsonValue>>, context('steer', {}),
    )
    assert.deepEqual(handoff.content, {error: 'invalid_params', op: 'steer'})
    assert.deepEqual(transport.calls, [])
  }

  const transport = new LiveTransport()
  const noTurn = await new CodexLiveAdapter(transport).dispatch(
    'steer', {instruction: `\u001c${'😀'.repeat(2000)}\u0085`}, context('steer', {}),
  )
  assert.deepEqual(noTurn.content, {op: 'steer', worker: 'codex', code: 'no_active_turn'})
  assert.deepEqual(transport.instructions, [])
})

test('concurrent prewarms share one task and a ready run consumes it without lazy preflight', async () => {
  // This fails if warmups race, the run duplicates preflight, or completed work leaves reusable warm state.
  const gate = deferred<unknown>()
  const entered = deferred<void>()
  const transport = new LiveTransport()
  transport.prewarmAction = async () => {
    entered.resolve()
    return await gate.promise
  }
  const adapter = new CodexLiveAdapter(transport)
  const first = adapter.prewarm()
  const second = adapter.prewarm()
  assert.equal(first, second)
  assert.equal(adapter.status.prewarm, 'warming')
  await entered.promise
  assert.deepEqual(transport.calls, ['prewarm'])

  const running = adapter.dispatch('run', {work_order: ' warm work '}, context('run', {}))
  await Promise.resolve()
  assert.deepEqual(transport.workOrders, [])
  gate.resolve(PREFLIGHT)
  await first
  const handoff = await running

  assert.equal(handoff.outcome, 'ok')
  assert.deepEqual(transport.calls, ['prewarm', 'run'])
  assert.deepEqual(transport.workOrders, ['warm work'])
  assert.equal(adapter.status.prewarm, 'cold')
  assert.deepEqual(handoff.content.preflight, PREFLIGHT)
})

test('failed or malformed prewarm is visible then falls back to one lazy preflight', async () => {
  // This fails if a failed warm report is reused or prevents the cold path from recovering.
  for (const warmFailure of [new Error('PRIVATE-WARM-ERROR'), {version: 'bad'}]) {
    const transport = new LiveTransport()
    if (warmFailure instanceof Error) transport.prewarmError = warmFailure
    else transport.prewarmValue = warmFailure
    const adapter = new CodexLiveAdapter(transport)
    await adapter.prewarm()
    assert.equal(adapter.status.prewarm, 'failed')

    const handoff = await adapter.dispatch('run', {work_order: 'cold'}, context('run', {}))
    assert.equal(handoff.outcome, 'ok')
    assert.deepEqual(transport.calls, ['prewarm', 'preflight', 'run'])
    assert.equal(adapter.status.prewarm, 'cold')
    assert.equal(JSON.stringify(handoff).includes('PRIVATE-WARM-ERROR'), false)
  }
})

test('live prewarm uses the injected lifecycle clock for its exact twenty-second deadline', async () => {
  // This fails if prewarm hard-codes RealClock or leaves an ambient wall timer in VirtualClock tests.
  const clock = new VirtualClock(10)
  const entered = deferred<void>()
  const transport = new LiveTransport()
  let transportDeadline = 0
  transport.prewarmAction = async deadline => {
    transportDeadline = deadline.expiresAtMs
    entered.resolve()
    await new Promise<void>(resolve => {
      deadline.signal?.addEventListener('abort', () => { resolve() }, {once: true})
    })
    return null
  }
  const scheduler = {wallNowMilliseconds: () => 1_000, lifecycleClock: clock}
  const adapter = new CodexLiveAdapter(transport, scheduler)
  const warming = adapter.prewarm()
  await entered.promise
  const waiterCount = clock.waiterCount()
  if (waiterCount === 0) {
    await adapter.close()
    await warming
  } else {
    clock.advanceTo(30)
    await warming
  }

  assert.equal(waiterCount, 1)
  assert.equal(transportDeadline, 21_000)
  assert.equal(clock.waiterCount(), 0)
  assert.equal(adapter.status.prewarm, 'failed')
})

test('live progress is forwarded, retained only while running, and callback failure is decorative', async () => {
  // This fails if progress is stale after settlement, raw invalid payload enters status, or callbacks own dispatch.
  const release = deferred<TransportOutcome>()
  const entered = deferred<void>()
  const transport = new LiveTransport()
  transport.runAction = async observer => {
    observer.onThreadReady?.()
    observer.onProgress?.({phase: 'started', internal_activity: 0, elapsed: 0, summary: null})
    observer.onProgress?.({phase: 'working', internal_activity: 3, elapsed: 2, summary: '正在写测试。'})
    observer.onProgress?.({phase: 'working', internal_activity: -1, elapsed: 2, summary: 'INVALID'})
    entered.resolve()
    return await release.promise
  }
  const forwarded: ExecutorProgress[] = []
  const adapter = new CodexLiveAdapter(transport)
  let callbacks = 0
  const running = adapter.dispatch('run', {work_order: 'work'}, context('run', {}, {
    progress: value => {
      forwarded.push(value)
      callbacks += 1
      if (callbacks === 2) throw new Error('consumer failure')
    },
  }))
  await entered.promise

  const status = await adapter.dispatch('status', {}, context('status', {}))
  assert.deepEqual(status.content.progress, {internal_activity: 3, summary: '正在写测试。'})
  assert.deepEqual(forwarded, [
    {phase: 'started', internal_activity: 0, elapsed: 0, summary: null},
    {phase: 'working', internal_activity: 3, elapsed: 2, summary: '正在写测试。'},
  ])

  release.resolve(COMPLETE_OUTCOME)
  assert.equal((await running).outcome, 'ok')
  const settled = await adapter.dispatch('status', {}, context('status', {}))
  assert.equal(Object.hasOwn(settled.content, 'progress'), false)
})

test('live steer is available only for a bound turn and maps written uncertainty exactly', async () => {
  // This fails if steer waits behind run, leaks instructions, or ignores the transport written boundary.
  const release = deferred<TransportOutcome>()
  const entered = deferred<void>()
  const transport = new LiveTransport()
  transport.runAction = async observer => {
    observer.onThreadReady?.()
    observer.onProgress?.({phase: 'started', internal_activity: 0, elapsed: 0, summary: null})
    entered.resolve()
    return await release.promise
  }
  transport.steerResults.push(
    {code: 'accepted', written: true},
    {code: 'server_rejected', written: true},
    {code: 'transport_lost', written: false},
    {code: 'transport_lost', written: true},
  )
  const adapter = new CodexLiveAdapter(transport)
  const before = await adapter.dispatch('steer', {instruction: 'before'}, context('steer', {}))
  assert.equal(before.content.code, 'no_active_turn')
  assert.deepEqual(transport.instructions, [])

  const run = adapter.dispatch('run', {work_order: 'work'}, context('run', {}))
  await entered.promise
  const results = []
  for (const instruction of [' one ', 'two', 'three', 'four']) {
    results.push(await adapter.dispatch('steer', {instruction}, context('steer', {})))
  }
  assert.deepEqual(results.map(result => [result.outcome, result.trust, result.content.code]), [
    ['ok', 'trusted_system', 'accepted'],
    ['failed', 'trusted_system', 'server_rejected'],
    ['failed', 'trusted_system', 'transport_lost'],
    ['unknown', 'trusted_system', 'transport_lost'],
  ])
  assert.deepEqual(transport.instructions, ['one', 'two', 'three', 'four'])
  assert.equal(JSON.stringify(results).includes('one'), false)

  release.resolve(COMPLETE_OUTCOME)
  assert.equal((await run).outcome, 'ok')
  const after = await adapter.dispatch('steer', {instruction: 'after'}, context('steer', {}))
  assert.equal(after.content.code, 'no_active_turn')
})

test('live invalid and throwing steer results become fixed transport loss without instruction leak', async () => {
  // This fails if an exception/result payload becomes public or if an invalid result is optimistic success.
  const release = deferred<TransportOutcome>()
  const entered = deferred<void>()
  const transport = new LiveTransport()
  transport.runAction = async observer => {
    observer.onProgress?.({phase: 'started', internal_activity: 0, elapsed: 0, summary: null})
    entered.resolve()
    return await release.promise
  }
  transport.steerResults.push({code: 'accepted', written: true, remote: 'PRIVATE-REMOTE'})
  const adapter = new CodexLiveAdapter(transport)
  const run = adapter.dispatch('run', {work_order: 'work'}, context('run', {}))
  await entered.promise
  const invalid = await adapter.dispatch(
    'steer', {instruction: 'PRIVATE-INSTRUCTION'}, context('steer', {}),
  )
  assert.deepEqual(
    [invalid.outcome, invalid.trust, invalid.content],
    ['unknown', 'trusted_system', {op: 'steer', worker: 'codex', code: 'transport_lost'}],
  )
  assert.equal(JSON.stringify(invalid).includes('PRIVATE'), false)
  release.resolve(COMPLETE_OUTCOME)
  await run
})

test('uncertain live settlement and close never invent process exit or transport evidence', async () => {
  // This fails if the adapter claims tree-gone facts absent from Task-6B TransportOutcome.
  const transport = new LiveTransport()
  transport.runAction = observer => {
    observer.onThreadReady?.()
    observer.onProgress?.({phase: 'started', internal_activity: 0, elapsed: 0, summary: null})
    return Promise.resolve({
      classification: 'uncertain', code: 'transport_lost',
      turnStartWritten: true, completion: null,
    })
  }
  const adapter = new CodexLiveAdapter(transport)
  const handoff = await adapter.dispatch('run', {work_order: 'work'}, context('run', {}))
  assert.deepEqual([handoff.outcome, handoff.trust, handoff.content.code], [
    'unknown', 'untrusted_external', 'transport_lost',
  ])
  assert.equal(Object.hasOwn(handoff.content, 'process'), false)
  assert.equal(Object.hasOwn(handoff.content, 'protocol'), false)
  assert.deepEqual(adapter.status, {
    state: 'running', run_sequence: 1, started_at: 7, finished_at: null, elapsed: 0,
    process_running: true, process_exited: false, terminal: null, exit_code: null,
    preflight: 'passed', prewarm: 'cold',
  })

  await adapter.close()
  assert.equal(adapter.status.state, 'running')
  assert.equal(adapter.status.process_exited, false)
  assert.equal(adapter.status.prewarm, 'cold')
})

test('live close aborts and joins warmup, closes the shared transport once, and resets cold', async () => {
  // This fails if close leaves an unobserved warmup or double-closes shared lifecycle authority.
  const entered = deferred<void>()
  const transport = new LiveTransport()
  transport.prewarmAction = async deadline => {
    entered.resolve()
    await new Promise<void>(resolve => {
      deadline.signal?.addEventListener('abort', () => { resolve() }, {once: true})
    })
    return null
  }
  const adapter = new CodexLiveAdapter(transport)
  const warming = adapter.prewarm()
  await entered.promise
  const firstClose = adapter.close()
  const secondClose = adapter.close()
  assert.equal(firstClose, secondClose)
  await firstClose
  await warming

  assert.equal(transport.closeCalls, 1)
  assert.equal(adapter.status.prewarm, 'cold')
})

test('live close permanently prevents prewarm from resurrecting transport work', async () => {
  // This fails if a post-close lifecycle call can recreate timers or touch a closed transport.
  const transport = new LiveTransport()
  const adapter = new CodexLiveAdapter(transport)

  await adapter.close()
  await adapter.prewarm()

  assert.deepEqual(transport.calls, ['close'])
  assert.equal(adapter.status.prewarm, 'cold')
})
