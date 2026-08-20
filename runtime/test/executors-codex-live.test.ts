import assert from 'node:assert/strict'
import {setImmediate as yieldImmediate} from 'node:timers/promises'
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
  steerAction: ((input: SteerInput, deadline: TransportDeadline) => Promise<unknown>) | null = null
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

  async steer(input: SteerInput, deadline: TransportDeadline): Promise<SteerTransportResult> {
    this.calls.push('steer')
    this.instructions.push(input.instruction)
    if (this.steerAction !== null) {
      return await this.steerAction(input, deadline) as SteerTransportResult
    }
    return (this.steerResults.shift() ?? {code: 'accepted', written: true}) as SteerTransportResult
  }

  close(): Promise<void> {
    this.calls.push('close')
    this.closeCalls += 1
    return Promise.resolve()
  }
}

function markTurnStartWritten(observer: TransportObserver): void {
  const extended = observer as TransportObserver & {onTurnStartWritten?: () => void}
  extended.onTurnStartWritten?.()
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

test('live reserves busy before joining warmup and includes the join in the 540-second deadline', async () => {
  // This fails if warm join happens before run admission/deadline ownership.
  const clock = new VirtualClock(7)
  const entered = deferred<void>()
  const release = deferred<void>()
  const transport = new LiveTransport()
  transport.prewarmAction = async () => {
    entered.resolve()
    await release.promise
    return PREFLIGHT
  }
  const adapter = new CodexLiveAdapter(transport, {
    wallNowMilliseconds: () => 1_000,
    lifecycleClock: clock,
  })
  const warming = adapter.prewarm()
  await entered.promise
  const first = adapter.dispatch('run', {work_order: 'first'}, context('run', {}, {clock}))
  const second = adapter.dispatch('run', {work_order: 'second'}, context('run', {}, {clock}))
  const busyWinner = await Promise.race([
    second.then(value => value),
    yieldImmediate().then(() => 'queued' as const),
  ])
  clock.advanceTo(547)
  release.resolve()
  await warming
  const firstHandoff = await first
  const secondHandoff = await second

  assert.notEqual(busyWinner, 'queued')
  assert.deepEqual(secondHandoff.content, {error: 'busy', op: 'run'})
  assert.deepEqual([firstHandoff.outcome, firstHandoff.trust, firstHandoff.content.code], [
    'failed', 'trusted_system', 'adapter_timeout',
  ])
  assert.deepEqual(transport.calls, ['prewarm'])
})

test('live pre-aborted run neither waits for nor consumes shared warm state', async () => {
  // This fails if cancellation is checked only after the warm join.
  const entered = deferred<void>()
  const release = deferred<void>()
  const transport = new LiveTransport()
  transport.prewarmAction = async () => {
    entered.resolve()
    await release.promise
    return PREFLIGHT
  }
  const adapter = new CodexLiveAdapter(transport)
  const warming = adapter.prewarm()
  await entered.promise
  const controller = new AbortController()
  controller.abort()
  const running = adapter.dispatch(
    'run', {work_order: 'cancelled'}, context('run', {}, {signal: controller.signal}),
  )
  const winner = await Promise.race([
    running.then(() => 'handoff' as const, error => error instanceof Error ? error.name : 'other'),
    yieldImmediate().then(() => 'warming' as const),
  ])
  release.resolve()
  await warming
  await assert.rejects(running, {name: 'AbortError'})

  assert.equal(winner, 'AbortError')
  assert.equal(adapter.status.prewarm, 'ready')
  assert.deepEqual(transport.calls, ['prewarm'])
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
    markTurnStartWritten(observer)
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

test('late observer callbacks cannot resurrect progress, process state, or steer ownership', async () => {
  // This fails if a settled run's retained observer can mutate current adapter state.
  let retained: TransportObserver | null = null
  const transport = new LiveTransport()
  transport.runAction = observer => {
    retained = observer
    markTurnStartWritten(observer)
    return Promise.resolve({
      classification: 'uncertain', code: 'transport_lost',
      turnStartWritten: true, completion: null,
    })
  }
  const adapter = new CodexLiveAdapter(transport)
  await adapter.dispatch('run', {work_order: 'first'}, context('run', {}))
  const before = adapter.status
  const late = retained as TransportObserver | null
  late?.onThreadReady?.()
  late?.onProgress?.({phase: 'started', internal_activity: 0, elapsed: 0, summary: null})
  late?.onProgress?.({phase: 'working', internal_activity: 2, elapsed: 3, summary: 'late'})
  const status = await adapter.dispatch('status', {}, context('status', {}))
  const steer = await adapter.dispatch('steer', {instruction: 'late'}, context('steer', {}))

  assert.equal(adapter.status, before)
  assert.equal(Object.hasOwn(status.content, 'progress'), false)
  assert.equal(steer.content.code, 'no_active_turn')
  assert.equal(transport.calls.includes('steer'), false)
})

test('live steer is available only for a bound turn and maps written uncertainty exactly', async () => {
  // This fails if steer waits behind run, leaks instructions, or ignores the transport written boundary.
  const release = deferred<TransportOutcome>()
  const entered = deferred<void>()
  const transport = new LiveTransport()
  transport.runAction = async observer => {
    observer.onThreadReady?.()
    markTurnStartWritten(observer)
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

test('two concurrent bound steers reach transport and retain their own response order', async () => {
  // This fails if an adapter lock serializes steer behind a pending request or swaps correlations.
  const runRelease = deferred<TransportOutcome>()
  const runEntered = deferred<void>()
  const firstRelease = deferred<SteerTransportResult>()
  const secondRelease = deferred<SteerTransportResult>()
  const transport = new LiveTransport()
  transport.runAction = async observer => {
    markTurnStartWritten(observer)
    runEntered.resolve()
    return await runRelease.promise
  }
  transport.steerAction = input => input.instruction === 'first'
    ? firstRelease.promise
    : secondRelease.promise
  const adapter = new CodexLiveAdapter(transport)
  const run = adapter.dispatch('run', {work_order: 'work'}, context('run', {}))
  await runEntered.promise

  const first = adapter.dispatch('steer', {instruction: 'first'}, context('steer', {}))
  const second = adapter.dispatch('steer', {instruction: 'second'}, context('steer', {}))
  await yieldImmediate()
  assert.deepEqual(transport.instructions, ['first', 'second'])
  secondRelease.resolve({code: 'accepted', written: true})
  firstRelease.resolve({code: 'server_rejected', written: true})
  const [firstResult, secondResult] = await Promise.all([first, second])

  assert.deepEqual([firstResult.outcome, firstResult.content.code], ['failed', 'server_rejected'])
  assert.deepEqual([secondResult.outcome, secondResult.content.code], ['ok', 'accepted'])
  runRelease.resolve(COMPLETE_OUTCOME)
  await run
})

test('live invalid and throwing steer results become fixed transport loss without instruction leak', async () => {
  // This fails if an exception/result payload becomes public or if an invalid result is optimistic success.
  const release = deferred<TransportOutcome>()
  const entered = deferred<void>()
  const transport = new LiveTransport()
  transport.runAction = async observer => {
    markTurnStartWritten(observer)
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

test('live steer preserves only a safely observed written boundary', async () => {
  // This fails if malformed/pre-write results are optimistically classified unknown.
  const release = deferred<TransportOutcome>()
  const entered = deferred<void>()
  const transport = new LiveTransport()
  transport.runAction = async observer => {
    markTurnStartWritten(observer)
    entered.resolve()
    return await release.promise
  }
  const adapter = new CodexLiveAdapter(transport)
  const run = adapter.dispatch('run', {work_order: 'work'}, context('run', {}))
  await entered.promise
  for (const [raw, expected] of [
    [{code: 'accepted', written: false}, ['failed', 'transport_lost']],
    [{code: 'transport_lost', written: false, extra: true}, ['failed', 'transport_lost']],
    [{code: 'transport_lost', written: true, extra: true}, ['unknown', 'transport_lost']],
  ] as const) {
    transport.steerAction = () => Promise.resolve(raw)
    const handoff = await adapter.dispatch('steer', {instruction: 'safe'}, context('steer', {}))
    assert.deepEqual([handoff.outcome, handoff.content.code], expected)
  }
  transport.steerAction = () => Promise.reject(new Error('PRIVATE-STEER'))
  const thrown = await adapter.dispatch('steer', {instruction: 'safe'}, context('steer', {}))
  assert.deepEqual([thrown.outcome, thrown.content.code], ['failed', 'transport_lost'])
  release.resolve(COMPLETE_OUTCOME)
  await run
})

test('live deadline retains a late written steer result but not a pre-write one', async () => {
  // This fails if deadline cleanup discards SteerTransportResult.written.
  const runRelease = deferred<TransportOutcome>()
  const runEntered = deferred<void>()
  const transport = new LiveTransport()
  transport.runAction = async observer => {
    markTurnStartWritten(observer)
    runEntered.resolve()
    return await runRelease.promise
  }
  const clock = new VirtualClock(7)
  const adapter = new CodexLiveAdapter(transport, {wallNowMilliseconds: () => 1_000})
  const run = adapter.dispatch('run', {work_order: 'work'}, context('run', {}, {clock}))
  await runEntered.promise
  for (const written of [false, true]) {
    const steerEntered = deferred<void>()
    transport.steerAction = async (_input, deadline) => {
      steerEntered.resolve()
      await new Promise<void>(resolve => {
        deadline.signal?.addEventListener('abort', () => { resolve() }, {once: true})
      })
      return {code: 'transport_lost', written}
    }
    const steering = adapter.dispatch('steer', {instruction: 'safe'}, context('steer', {}, {clock}))
    await steerEntered.promise
    clock.advanceTo(clock.now() + 30)
    const handoff = await steering
    assert.equal(handoff.outcome, written ? 'unknown' : 'failed')
    assert.equal(handoff.content.code, 'transport_lost')
  }
  runRelease.resolve(COMPLETE_OUTCOME)
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

test('live refusal exposes only reviewed safe codes and rejects contradictory outcome pairs', async () => {
  // This fails if internal Task-6B codes such as busy/completed escape the adapter.
  for (const [outcome, expectedCode] of [
    [{classification: 'refused', code: 'credential_missing', turnStartWritten: false, completion: null},
      'credential_missing'],
    [{classification: 'refused', code: 'busy', turnStartWritten: false, completion: null},
      'worker_refused'],
    [{classification: 'uncertain', code: 'completed', turnStartWritten: true, completion: null},
      'invalid_worker_result'],
  ] as const) {
    const transport = new LiveTransport()
    transport.runAction = () => Promise.resolve(outcome)
    const handoff = await new CodexLiveAdapter(transport).dispatch(
      'run', {work_order: 'work'}, context('run', {}),
    )
    assert.equal(handoff.content.code, expectedCode)
  }
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

test('live close aborts a run joining warmup before it can touch run transport', async () => {
  // This fails if a warm-join continuation can pass the close boundary and resurrect dispatch.
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
  const running = adapter.dispatch('run', {work_order: 'must not start'}, context('run', {}))
  const closing = adapter.close()
  await closing
  await warming
  await assert.rejects(running, {name: 'AbortError'})
  const afterClose = adapter.status
  await yieldImmediate()

  assert.equal(adapter.status, afterClose)
  assert.equal(adapter.status.prewarm, 'cold')
  assert.deepEqual(transport.calls, ['prewarm', 'close'])
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

test('live close permanently rejects run and steer without touching transport or status', async () => {
  // This fails if close is terminal only for prewarm but not public dispatch.
  const transport = new LiveTransport()
  const adapter = new CodexLiveAdapter(transport)
  await adapter.close()
  const before = adapter.status

  const run = await adapter.dispatch('run', {work_order: 'after close'}, context('run', {}))
  const steer = await adapter.dispatch('steer', {instruction: 'after close'}, context('steer', {}))

  assert.deepEqual(run.content, {error: 'closed', op: 'run'})
  assert.deepEqual(steer.content, {error: 'closed', op: 'steer'})
  assert.equal(adapter.status, before)
  assert.deepEqual(transport.calls, ['close'])
})
