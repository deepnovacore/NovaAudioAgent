import assert from 'node:assert/strict'
import {test} from 'node:test'
import {canonicalJson} from '../src/text/canonical-json.js'
import type {EventRecord} from '../src/core/events.js'
import {
  MAX_HOST_FACT_CHARS,
  PREEMPT_MIN_PRIORITY
} from '../src/realtime/service-state.js'
import {SPEECH_FINAL_LIMIT} from '../src/realtime/speech-prep.js'
import type {WakeReason} from '../src/core/slots.js'
import type {Suggestion} from '../src/core/suggestions.js'
import {progressEvent, projectionDocument, projectionGolden, realtimeServiceHarness, runProjection} from './support/realtime-service-harness.js'


test('historical executor terminals settle control state without projecting their body', () => {
  const {service, queued} = realtimeServiceHarness('projection')
  service.session.registerDelegate('d-1', {
    summary: 'old private work order', state: 'running', channel: 'codex',
  })
  service.projectRuntimeEvent({
    kind: 'handoff', seq: 1, ts: 1,
    payload: {
      channel: 'codex', delegate_id: 'd-1', origin_ref: 'conversation:1', outcome: 'ok',
      trust: 'trusted_system', content: {secret: 'old result body'}, refs: [],
    },
  }, false)

  assert.equal(service.session.delegateState('d-1'), 'completed')
  assert.deepEqual(queued(), [])
})

test('every projection matches the Python-exported golden outside Node display localization', () => {
  const divergent: string[] = []
  for (const [index, spec] of projectionDocument.projections.entries()) {
    const actual = runProjection(spec)
    const pythonExpected = projectionGolden.projections[index]
    if (pythonExpected === undefined) throw new Error(`missing projection golden: ${spec.name}`)
    // This branch intentionally remains Node-only. The desktop product localizes built-in executor
    // names, while the Python runtime stays untouched; retain every other byte of the exported golden.
    const localizedName = spec.display_name === 'watch'
      ? '观察'
      : spec.display_name === 'guard' ? '监控' : null
    // Node distinguishes preparation feedback from actual executor startup.
    const expected = spec.name === 'progress-started' ? {...pythonExpected, content: `交给 ${spec.display_name} 执行。`} : localizedName === null || typeof pythonExpected.content !== 'string'
      ? pythonExpected
      : {...pythonExpected, content: pythonExpected.content.replace(spec.display_name, localizedName)}
    if (canonicalJson(actual) !== canonicalJson(expected)) {
      divergent.push(
        `${spec.name}: expected=${canonicalJson(expected)} node=${canonicalJson(actual)}`,
      )
    }
  }
  assert.deepEqual(divergent, [], 'projected text or priority differs from the oracle')
})

test('an executor repeating the same progress summary does not make the agent repeat itself', () => {
  // The same-summary skip. An executor that reports identical progress every few seconds would
  // otherwise have the agent say the same sentence over and over.
  const {service, queued} = realtimeServiceHarness('projection')
  service.projectRuntimeEvent(progressEvent({seq: 1, summary: 'running tests', activity: 1}))
  assert.equal(queued().length, 1, 'the first one is worth saying')
  service.projectRuntimeEvent(progressEvent({seq: 2, summary: 'running tests', activity: 2}))
  assert.equal(queued().length, 1, 'the identical repeat is not')
  service.projectRuntimeEvent(progressEvent({seq: 3, summary: 'linting', activity: 3}))
  assert.equal(queued().length, 2, 'but a changed summary is')
  service.projectRuntimeEvent(progressEvent({seq: 4, summary: 'running tests', activity: 4}))
  assert.equal(queued().length, 3, 'and so is going back to an earlier one')
})

test('routine progress facts do not lead with or append elapsed time', () => {
  const {service, queued} = realtimeServiceHarness('projection')
  service.projectRuntimeEvent(progressEvent({
    seq: 1,
    summary: '正在运行回归测试',
    activity: 3,
    elapsed: 47,
  }))

  assert.deepEqual(queued(), ['Codex 正在执行：正在运行回归测试'])
})

test('identical active executor state publishes once and terminal state publishes removal', () => {
  let publications = 0
  const {service} = realtimeServiceHarness('projection', {
    progressViaSurrogate: true,
    onActiveWorkChanged: () => { publications += 1 },
  })
  const progress = progressEvent({seq: 1, summary: 'running tests', activity: 1, elapsed: 2})
  service.projectRuntimeEvent(progress)
  assert.equal(publications, 1)

  service.projectRuntimeEvent({...progress, seq: 2, ts: 2})
  assert.equal(publications, 1, 'the same normalized provider context is not republished')

  service.projectRuntimeEvent(progressEvent({
    seq: 3, summary: 'running tests', activity: 7, elapsed: 14.9,
  }))
  assert.equal(publications, 1, 'volatile heartbeats inside one bucket do not republish context')

  service.projectRuntimeEvent(progressEvent({
    seq: 4, summary: 'running tests', activity: 8, elapsed: 15,
  }))
  assert.equal(publications, 2, 'the next bounded freshness window publishes once')

  service.projectRuntimeEvent({
    kind: 'handoff',
    seq: 5,
    ts: 5,
    payload: {
      channel: 'codex', delegate_id: 'd-1', origin_ref: 'conversation:1',
      outcome: 'ok', trust: 'trusted_system', content: {done: true}, refs: [],
    },
  })
  assert.equal(publications, 3, 'terminal state publishes removal of the active block')
})

test('a summary-less progress event is never deduped by the summary mechanism', () => {
  // Those keep the field template, which changes with the step count, so suppressing them by summary
  // would suppress genuinely different sentences.
  const {service, queued} = realtimeServiceHarness('projection')
  service.projectRuntimeEvent(progressEvent({seq: 1, summary: null, activity: 1}))
  service.projectRuntimeEvent(progressEvent({seq: 2, summary: null, activity: 2}))
  assert.equal(queued().length, 2)
})

test('a settled delegate leaves no dedup residue for the next run of its id', () => {
  // Otherwise a later delegate reusing the id would inherit a summary it never produced, and its first
  // genuine progress report would be silently swallowed.
  const {service, queued} = realtimeServiceHarness('projection')
  service.projectRuntimeEvent(progressEvent({seq: 1, summary: 'running tests', activity: 1}))
  assert.equal(queued().length, 1)
  service.projectRuntimeEvent({
    kind: 'handoff',
    seq: 2,
    ts: 2,
    payload: {
      channel: 'codex',
      delegate_id: 'd-1',
      origin_ref: 'conversation:1',
      outcome: 'ok',
      trust: 'trusted_system',
      content: {},
      refs: [],
    },
  })
  const afterHandoff = queued().length
  // The same summary again, from a new run of the same id, has to be spoken.
  service.projectRuntimeEvent(progressEvent({seq: 3, summary: 'running tests', activity: 1}))
  assert.equal(
    queued().length,
    afterHandoff + 1,
    'the settled delegate must not suppress the next run',
  )
})

test('a suggestion handoff nobody selected is not announced', () => {
  // It is a proposal the Surrogate never chose. Announcing it would tell the user about something they
  // were not offered.
  const {service, queued} = realtimeServiceHarness('projection', {
    suggest: true,
    delegate: {executor: 'codex', op: 'start', routing_class: 'ambient'},
  })
  service.projectRuntimeEvent({
    kind: 'handoff',
    seq: 1,
    ts: 1,
    payload: {
      channel: 'codex',
      delegate_id: 'd-1',
      origin_ref: 'conversation:1',
      outcome: 'ok',
      trust: 'trusted_system',
      content: {summary: 'something happened'},
      refs: [],
    },
  })
  assert.deepEqual(queued(), [], 'silent')

  // A user-awaited one on the same suggest channel is a direct handoff and does get announced.
  const direct = realtimeServiceHarness('projection', {
    suggest: true,
    delegate: {executor: 'codex', op: 'start', routing_class: 'user_awaited'},
  })
  direct.service.projectRuntimeEvent({
    kind: 'handoff',
    seq: 1,
    ts: 1,
    payload: {
      channel: 'codex',
      delegate_id: 'd-1',
      origin_ref: 'conversation:1',
      outcome: 'ok',
      trust: 'trusted_system',
      content: {summary: 'something happened'},
      refs: [],
    },
  })
  assert.equal(direct.queued().length, 1)
})

test('a successful monitor stop is not announced twice', () => {
  // The stop tool's own continuation is the single spoken confirmation. Both terminal handoffs stay
  // authoritative in Memory, but projecting either duplicates it -- and projecting both produced
  // three lines.
  const {service, queued} = realtimeServiceHarness('projection', {
    delegate: {executor: 'watch', op: 'stop', routing_class: 'user_awaited'},
    operationClass: 'monitor',
    alertDelivery: 'deferred',
  })
  service.projectRuntimeEvent({
    kind: 'handoff',
    seq: 1,
    ts: 1,
    payload: {
      channel: 'watch',
      delegate_id: 'd-1',
      origin_ref: 'conversation:1',
      outcome: 'ok',
      trust: 'trusted_system',
      content: {stopped: true},
      refs: [],
    },
  })
  assert.deepEqual(queued(), [], 'silent')

  // A stop that did not succeed is still worth saying.
  const failed = realtimeServiceHarness('projection', {
    delegate: {executor: 'watch', op: 'stop', routing_class: 'user_awaited'},
  })
  failed.service.projectRuntimeEvent({
    kind: 'handoff',
    seq: 1,
    ts: 1,
    payload: {
      channel: 'watch',
      delegate_id: 'd-1',
      origin_ref: 'conversation:1',
      outcome: 'failed',
      trust: 'trusted_system',
      content: {error: 'could_not_stop'},
      refs: [],
    },
  })
  assert.equal(failed.queued().length, 1)
})

test('a renamed monitor policy keeps a successful stop silent', () => {
  // Renaming a monitor channel must not turn its own stop acknowledgement into a second spoken turn.
  const {service, queued} = realtimeServiceHarness('projection', {
    delegate: {executor: 'sensor-alpha', op: 'stop', routing_class: 'user_awaited'},
    operationClass: 'monitor',
    alertDelivery: 'deferred',
  })
  service.projectRuntimeEvent({
    kind: 'handoff',
    seq: 1,
    ts: 1,
    payload: {
      channel: 'sensor-alpha',
      delegate_id: 'd-1',
      origin_ref: 'conversation:1',
      outcome: 'ok',
      trust: 'trusted_system',
      content: {stopped: true},
      refs: [],
    },
  })
  assert.deepEqual(queued(), [])
})

test('a handoff that claimed nothing is not projected against an earlier claim', () => {
  // A duplicate handoff, or one for a delegate already settled, claims nothing. Projecting it against
  // whatever the previous handoff claimed would announce the same completion twice.
  const {service, queued} = realtimeServiceHarness('projection', {claims: false})
  service.projectRuntimeEvent({
    kind: 'handoff',
    seq: 1,
    ts: 1,
    payload: {
      channel: 'codex',
      delegate_id: 'd-1',
      origin_ref: 'conversation:1',
      outcome: 'ok',
      trust: 'trusted_system',
      content: {summary: 'done'},
      refs: [],
    },
  })
  assert.deepEqual(queued(), [])
})

test('a handoff on a channel the delegate does not belong to is not projected', () => {
  // All the claim proves is that *a* delegate was claimed. If its executor differs, the handoff
  // describes a different run and projecting it would attribute one executor's result to another.
  const {service, queued} = realtimeServiceHarness('projection', {
    delegateOverride: {executor: 'watch'},
  })
  service.projectRuntimeEvent({
    kind: 'handoff',
    seq: 1,
    ts: 1,
    payload: {
      channel: 'codex',
      delegate_id: 'd-1',
      origin_ref: 'conversation:1',
      outcome: 'ok',
      trust: 'trusted_system',
      content: {summary: 'done'},
      refs: [],
    },
  })
  assert.deepEqual(queued(), [])
})

test('only the deadline that terminated a delegate announces its timeout', () => {
  // Not "was terminated by a deadline at some point": a second deadline for the same delegate would
  // otherwise announce the same timeout again.
  const {service, queued} = realtimeServiceHarness('projection', {terminates: false})
  service.projectRuntimeEvent({kind: 'deadline', seq: 1, ts: 1, payload: {delegate_id: 'd-1'}})
  assert.deepEqual(queued(), [])

  const terminating = realtimeServiceHarness('projection', {terminates: true})
  terminating.service.projectRuntimeEvent({
    kind: 'deadline',
    seq: 1,
    ts: 1,
    payload: {delegate_id: 'd-1'},
  })
  assert.equal(terminating.queued().length, 1)
})

test('a timed-out delegate is unknown, not failed', () => {
  // A deadline says nobody knows what happened. Telling the model it failed is a claim the host cannot
  // support, and the model would then narrate a failure that may not have occurred.
  const {service} = realtimeServiceHarness('projection')
  service.projectRuntimeEvent({kind: 'deadline', seq: 1, ts: 1, payload: {delegate_id: 'd-1'}})
  assert.equal(service.session.delegateState('d-1'), 'unknown')
})

test('a sync-result op resolves its own timeout rather than announcing one', () => {
  // Its waiting tool call carries the result, so a spoken timeout would be a second, contradictory
  // account of the same event.
  const {service, queued} = realtimeServiceHarness('projection', {
    delegate: {executor: 'codex', op: 'look', routing_class: 'user_awaited'},
    syncResultOps: true,
  })
  service.projectRuntimeEvent({kind: 'deadline', seq: 1, ts: 1, payload: {delegate_id: 'd-1'}})
  assert.deepEqual(queued(), [])
})

test('an observation is matched to the exact run it belongs to', () => {
  // All four fields, not just the delegate id: a differing channel, op, or origin describes a
  // different run, and projecting it would attribute one executor's finding to another's task.
  for (const override of [
    {executor: 'watch'},
    {op: 'stop'},
    {origin_ref: 'conversation:99'},
  ]) {
    const {service, queued} = realtimeServiceHarness('projection', {delegateOverride: override})
    service.projectRuntimeEvent({
      kind: 'observation',
      seq: 1,
      ts: 1,
      payload: {
        channel: 'codex',
        delegate_id: 'd-1',
        op: 'start',
        origin_ref: 'conversation:1',
        trust: 'trusted_system',
        content: {hit: true, observation: 'found it'},
        refs: [],
      },
    })
    assert.deepEqual(queued(), [], JSON.stringify(override))
  }
  // And the matching one is projected.
  const {service, queued} = realtimeServiceHarness('projection')
  service.projectRuntimeEvent({
    kind: 'observation',
    seq: 1,
    ts: 1,
    payload: {
      channel: 'codex',
      delegate_id: 'd-1',
      op: 'start',
      origin_ref: 'conversation:1',
      trust: 'trusted_system',
      content: {hit: true, observation: 'found it'},
      refs: [],
    },
  })
  assert.equal(queued().length, 1)
})

test('an observation is only worth interrupting for when it is a hit', () => {
  // A heartbeat or a miss registers delegate state and stops there. Announcing every observation would
  // turn a monitor into a narrator.
  const {service, queued} = realtimeServiceHarness('projection')
  service.projectRuntimeEvent({
    kind: 'observation',
    seq: 1,
    ts: 1,
    payload: {
      channel: 'codex',
      delegate_id: 'd-1',
      op: 'start',
      origin_ref: 'conversation:1',
      trust: 'trusted_system',
      content: {hit: false, observation: 'nothing yet'},
      refs: [],
    },
  })
  assert.deepEqual(queued(), [])
  assert.equal(service.session.delegateState('d-1'), 'running', 'state still registered')
})

test('an ambient hit is the Surrogate to arbitrate, not the host to announce', () => {
  const {service, queued} = realtimeServiceHarness('projection', {
    suggest: true,
    delegate: {executor: 'codex', op: 'start', routing_class: 'ambient'},
  })
  service.projectRuntimeEvent({
    kind: 'observation',
    seq: 1,
    ts: 1,
    payload: {
      channel: 'codex',
      delegate_id: 'd-1',
      op: 'start',
      origin_ref: 'conversation:1',
      trust: 'trusted_system',
      content: {hit: true, observation: 'found it'},
      refs: [],
    },
  })
  assert.deepEqual(queued(), [])

  // A user-awaited hit on the same suggest channel is announced.
  const awaited = realtimeServiceHarness('projection', {
    suggest: true,
    delegate: {executor: 'codex', op: 'start', routing_class: 'user_awaited'},
  })
  awaited.service.projectRuntimeEvent({
    kind: 'observation',
    seq: 1,
    ts: 1,
    payload: {
      channel: 'codex',
      delegate_id: 'd-1',
      op: 'start',
      origin_ref: 'conversation:1',
      trust: 'trusted_system',
      content: {hit: true, observation: 'found it'},
      refs: [],
    },
  })
  assert.equal(awaited.queued().length, 1)
})

test('an observation hit outranks routine announcements without reaching the preempt band', () => {
  for (const [priority, expected] of [[40, 55], [55, 55], [60, 60], [90, 90]] as const) {
    const {service, queuedItems} = realtimeServiceHarness('projection', {priority})
    service.projectRuntimeEvent({
      kind: 'observation',
      seq: 1,
      ts: 1,
      payload: {
        channel: 'codex',
        delegate_id: 'd-1',
        op: 'start',
        origin_ref: 'conversation:1',
        trust: 'trusted_system',
        content: {hit: true, observation: 'found it'},
        refs: [],
      },
    })
    assert.equal(queuedItems()[0]?.priority, expected, `manifest priority ${priority}`)
    assert.equal(
      queuedItems()[0]?.preemptive,
      priority >= PREEMPT_MIN_PRIORITY,
      `preemptive at ${priority}`,
    )
  }
})

test('a progress event for a delegate that is no longer in flight is not projected', () => {
  // It describes a run that is over. Reporting it would tell the user work is progressing that has
  // already stopped.
  const {service, queued} = realtimeServiceHarness('projection', {inFlight: false})
  service.projectRuntimeEvent(progressEvent({seq: 1, summary: 'running tests', activity: 1}))
  assert.deepEqual(queued(), [])
})

test('a progress event whose shape the runtime dropped is revalidated here', () => {
  // Observers receive events unconditionally, including ones the runtime validator dropped from
  // Memory, so the shape is checked again rather than trusted.
  const malformed: readonly EventRecord[] = [
    // `started` must carry zero activity.
    {
      kind: 'progress',
      seq: 1,
      ts: 1,
      payload: {
        channel: 'codex',
        delegate_id: 'd-1',
        op: 'start',
        phase: 'started',
        internal_activity: 3,
        elapsed: 1,
        summary: null,
      },
    },
    // `working` must carry at least one step.
    {
      kind: 'progress',
      seq: 2,
      ts: 2,
      payload: {
        channel: 'codex',
        delegate_id: 'd-1',
        op: 'start',
        phase: 'working',
        internal_activity: 0,
        elapsed: 1,
        summary: null,
      },
    },
    // An op the delegate is not running.
    {
      kind: 'progress',
      seq: 3,
      ts: 3,
      payload: {
        channel: 'codex',
        delegate_id: 'd-1',
        op: 'stop',
        phase: 'working',
        internal_activity: 1,
        elapsed: 1,
        summary: null,
      },
    },
  ]
  for (const event of malformed) {
    const {service, queued} = realtimeServiceHarness('projection')
    service.projectRuntimeEvent(event)
    assert.deepEqual(queued(), [], JSON.stringify(event.payload))
  }
})

test('a surrogate-reported channel does not also speak its own working progress', () => {
  // The Surrogate is already narrating it; the host doing so too is the same fact twice.
  const {service, queued} = realtimeServiceHarness('projection', {progressViaSurrogate: true})
  service.projectRuntimeEvent(progressEvent({seq: 1, summary: 'running tests', activity: 1}))
  assert.deepEqual(queued(), [], 'working is silent')

  // Startup is an explicit lifecycle notification, independent of smart working summaries.
  service.projectRuntimeEvent({
    kind: 'progress',
    seq: 2,
    ts: 2,
    payload: {
      channel: 'codex',
      delegate_id: 'd-1',
      op: 'start',
      phase: 'started',
      internal_activity: 0,
      elapsed: 0,
      summary: null,
    },
  })
  assert.deepEqual(queued(), ['交给 Codex 执行。'])
})

test('Guard working heartbeats update state without creating another spoken turn', () => {
  const {service, queued} = realtimeServiceHarness('projection', {
    delegate: {executor: 'guard', op: 'start', routing_class: 'user_awaited'},
    priority: 90,
    operationClass: 'monitor',
    alertDelivery: 'preemptive',
  })
  service.projectRuntimeEvent({
    kind: 'progress',
    seq: 1,
    ts: 1,
    payload: {
      channel: 'guard',
      delegate_id: 'd-1',
      op: 'start',
      phase: 'working',
      internal_activity: 13,
      elapsed: 30,
      summary: '仍在监控：看到水杯',
    },
  })

  assert.deepEqual(queued(), [])
  assert.equal(service.session.delegateState('d-1'), 'running', 'the heartbeat still updates state')
})

test('monitor heartbeats stay in state without creating spoken turns', () => {
  for (const executor of ['watch', 'guard']) {
    const {service, queued} = realtimeServiceHarness('projection', {
      delegate: {executor, op: 'start', routing_class: 'user_awaited'},
      operationClass: 'monitor',
      alertDelivery: executor === 'guard' ? 'preemptive' : 'deferred',
    })
    service.projectRuntimeEvent({
      kind: 'progress',
      seq: 1,
      ts: 1,
      payload: {
        channel: executor,
        delegate_id: 'd-1',
        op: 'start',
        phase: 'working',
        internal_activity: 1,
        elapsed: 30,
        summary: '正在处理',
      },
    })

    assert.deepEqual(queued(), [], `${executor} heartbeat stays silent`)
    assert.equal(service.session.delegateState('d-1'), 'running')
  }
})

test('a renamed monitor heartbeat stays operational rather than speaking', () => {
  const {service, queued} = realtimeServiceHarness('projection', {
    delegate: {executor: 'sensor-alpha', op: 'start', routing_class: 'user_awaited'},
    operationClass: 'monitor',
    alertDelivery: 'deferred',
  })
  service.projectRuntimeEvent({
    kind: 'progress',
    seq: 1,
    ts: 1,
    payload: {
      channel: 'sensor-alpha',
      delegate_id: 'd-1',
      op: 'start',
      phase: 'working',
      internal_activity: 1,
      elapsed: 30,
      summary: 'still monitoring',
    },
  })
  assert.deepEqual(queued(), [])
  assert.equal(service.session.delegateState('d-1'), 'running')
})

test('a monitor projects through its owning public agent rather than its channel', () => {
  const {service, queued} = realtimeServiceHarness('projection', {
    delegate: {executor: 'sensor-alpha', op: 'start', routing_class: 'user_awaited'},
    operationClass: 'monitor',
    alertDelivery: 'deferred',
    agentName: 'vision',
  })
  service.projectRuntimeEvent({
    kind: 'progress',
    seq: 1,
    ts: 1,
    payload: {
      channel: 'sensor-alpha', delegate_id: 'd-1', op: 'start', phase: 'started',
      internal_activity: 0, elapsed: 0, summary: null,
    },
  })
  assert.deepEqual(queued(), ['vision 已开始处理这个任务。'])
})

test('monitor hits speak the current visual evidence instead of executor jargon', () => {
  for (const [executor, priority] of [['watch', 40], ['guard', 90]] as const) {
    const {service, queued, queuedItems} = realtimeServiceHarness('projection', {
      delegate: {executor, op: 'start', routing_class: 'user_awaited'},
      priority,
      operationClass: 'monitor',
      alertDelivery: executor === 'guard' ? 'preemptive' : 'deferred',
    })
    service.projectRuntimeEvent({
      kind: 'observation',
      seq: 2,
      ts: 2,
      payload: {
        channel: executor,
        delegate_id: 'd-1',
        op: 'start',
        origin_ref: 'conversation:1',
        trust: 'untrusted_external',
        content: {
          hit: true,
          condition: '看到水杯',
          observation: '画面中一人正手持浅色带橙色把手的水杯喝水。',
        },
        refs: [],
      },
    })

    assert.deepEqual(queued(), ['检测到了：画面中一人正手持浅色带橙色把手的水杯喝水。'])
    assert.equal(queuedItems()[0]?.priority, executor === 'watch' ? 55 : 90)
    assert.equal(queuedItems()[0]?.preemptive, executor === 'guard')
  }
})

test('monitor hit delivery follows policy after its channel is renamed', () => {
  const hit = (channel: string): EventRecord => ({
    kind: 'observation',
    seq: 2,
    ts: 2,
    payload: {
      channel,
      delegate_id: 'd-1',
      op: 'start',
      origin_ref: 'conversation:1',
      trust: 'untrusted_external',
      content: {hit: true, observation: 'the kettle is boiling'},
      refs: [],
    },
  })
  const deferred = realtimeServiceHarness('projection', {
    delegate: {executor: 'sensor-deferred', op: 'start', routing_class: 'user_awaited'},
    priority: 90,
    operationClass: 'monitor',
    alertDelivery: 'deferred',
  })
  deferred.service.projectRuntimeEvent(hit('sensor-deferred'))
  assert.deepEqual(deferred.queued(), ['检测到了：the kettle is boiling'])
  assert.equal(deferred.queuedItems()[0]?.preemptive, false, 'deferred alert does not interrupt')

  const silent = realtimeServiceHarness('projection', {
    delegate: {executor: 'sensor-silent', op: 'start', routing_class: 'user_awaited'},
    operationClass: 'monitor',
    alertDelivery: 'none',
  })
  silent.service.projectRuntimeEvent(hit('sensor-silent'))
  assert.deepEqual(silent.queued(), [], 'none does not create a user-facing alert')
})

test('a terminal none monitor hit stays recorded without becoming host speech', () => {
  // A future change removing the terminal policy gate would make the final queue non-empty, even
  // though the runtime has already recorded the exact hit and the service has settled its delegate.
  const {service, queued, memory} = realtimeServiceHarness('projection', {
    delegate: {executor: 'sensor-silent', op: 'start', routing_class: 'user_awaited'},
    operationClass: 'monitor',
    alertDelivery: 'none',
  })
  const recorded = memory.append('sensor-silent', {
    ts: 1,
    trust: 'untrusted_external',
    priority: 50,
    content: {hit: true, observation: 'the kettle is boiling'},
    outcome: 'ok',
    refs: ['conversation:1'],
  })

  service.projectRuntimeEvent({
    kind: 'handoff',
    seq: 1,
    ts: 1,
    payload: {
      channel: 'sensor-silent',
      delegate_id: 'd-1',
      origin_ref: 'conversation:1',
      outcome: 'ok',
      trust: 'trusted_system',
      content: {hit: true, observation: 'the kettle is boiling'},
      refs: [],
    },
  })

  assert.deepEqual(queued(), [], 'policy none never becomes a host response at terminal handoff')
  assert.equal(memory.channels.get('sensor-silent')?.items.at(-1), recorded, 'runtime evidence remains in Memory')
  assert.equal(service.session.delegateState('d-1'), 'completed', 'terminal state still publishes')
})

test('a terminal none monitor failure remains a host-visible result', () => {
  // Only a successful hit is intentionally silent. Dropping this terminal would hide the real
  // failure from the user even though the monitor's normal alert delivery is none.
  for (const [outcome, content, state] of [
    ['failed', {code: 'capture_unavailable'}, 'failed'],
    ['refused', {code: 'permission_denied'}, 'refused'],
  ] as const) {
    const {service, queued} = realtimeServiceHarness('projection', {
      delegate: {executor: 'sensor-silent', op: 'start', routing_class: 'user_awaited'},
      operationClass: 'monitor',
      alertDelivery: 'none',
    })
    service.projectRuntimeEvent({
      kind: 'handoff',
      seq: 1,
      ts: 1,
      payload: {
        channel: 'sensor-silent', delegate_id: 'd-1', origin_ref: 'conversation:1',
        outcome, trust: 'trusted_system', content, refs: [],
      },
    })

    assert.equal(queued().length, 1, `${outcome} remains a user-visible terminal fact`)
    assert.equal(service.session.delegateState('d-1'), state)
  }
})

test('silencing monitor heartbeats does not silence ordinary executor progress', () => {
  const {service, queued} = realtimeServiceHarness('projection', {
    delegate: {executor: 'codex', op: 'start', routing_class: 'user_awaited'},
  })
  service.projectRuntimeEvent({
    kind: 'progress',
    seq: 1,
    ts: 1,
    payload: {
      channel: 'codex',
      delegate_id: 'd-1',
      op: 'start',
      phase: 'working',
      internal_activity: 1,
      elapsed: 30,
      summary: '正在处理',
    },
  })

  assert.equal(queued().length, 1)
})

test('a Surrogate-selected working progress becomes one realtime progress fact', () => {
  const {service, queuedItems, memory} = realtimeServiceHarness('projection', {progressViaSurrogate: true})
  memory.append('codex', {ts: 0, trust: 'trusted_system', priority: 50, content: {text: 'expired'}})
  const evidence = memory.append('codex', {
    ts: 1,
    trust: 'trusted_system',
    priority: 50,
    content: {
      delegate_id: 'd-1',
      op: 'start',
      phase: 'working',
      internal_activity: 1,
      elapsed: 1,
      summary: '正在运行回归测试',
    },
  })
  const suggestion: Suggestion = {
    id: 's-1',
    origin: 'surrogate',
    kind: 'notify',
    content: {summary: '正在运行回归测试'},
    evidence_refs: [`codex:${evidence.seq}`],
    salience: 50,
    delivery_policy: 'once',
    condition_key: null,
    cooldown_until: 0,
    expires_at: 60,
    status: 'pending',
  }
  const reason: WakeReason = {
    kind: 'suggestion_selected',
    priority: 50,
    routing_class: 'user_awaited',
    origin: 'd-1',
    selected_suggestion: 's-1',
  }
  memory.channels.get('codex')!.pruneThrough(1)
  service.onSuggestionSelected(suggestion, reason)

  const queued = queuedItems()
  assert.equal(queued.length, 1)
  assert.equal(queued[0]?.intent.item.kind, 'progress')
  assert.equal(queued[0]?.intent.item.event_id, 'suggestion:s-1')
  assert.equal(queued[0]?.intent.item.content, '正在运行回归测试')
})

test('a host fact is already bounded by speech preparation before the outer cap', () => {
  // `MAX_HOST_FACT_CHARS` is a backstop rather than the operative limit: every speech view is cut to
  // `SPEECH_FINAL_LIMIT` (600) first, so the 3000 cap is unreachable through this path and a mutation
  // removing it is correctly undetectable. Both legs agree at 600, which is what this pins -- the cap
  // is kept because the oracle keeps it, and because a future view that skipped preparation would need
  // it.
  const {service, queuedItems} = realtimeServiceHarness('projection', {
    delegate: {executor: 'watch', op: 'start', routing_class: 'user_awaited'},
  })
  service.projectRuntimeEvent({
    kind: 'handoff',
    seq: 1,
    ts: 1,
    payload: {
      channel: 'watch',
      delegate_id: 'd-1',
      origin_ref: 'conversation:1',
      outcome: 'ok',
      trust: 'trusted_system',
      content: {hit: true, observation: '很'.repeat(8_000)},
      refs: [],
    },
  })
  const content = queuedItems()[0]?.intent.item.content ?? ''
  assert.equal([...content].length, SPEECH_FINAL_LIMIT, 'bounded by speech preparation')
  assert.ok([...content].length < MAX_HOST_FACT_CHARS, 'well inside the outer cap')
})

test('a progress event with an empty op is refused', () => {
  // Part of the CP1 revalidation. Redundant as the code stands -- the in-flight match immediately
  // after compares the op against the delegate's, and no delegate has an empty one -- so a mutation
  // removing it is correctly undetectable. Kept because the oracle keeps it, and asserted here so the
  // redundancy is recorded rather than rediscovered by the next sweep.
  const {service, queued} = realtimeServiceHarness('projection')
  service.projectRuntimeEvent({
    kind: 'progress',
    seq: 1,
    ts: 1,
    payload: {
      channel: 'codex',
      delegate_id: 'd-1',
      op: '',
      phase: 'working',
      internal_activity: 1,
      elapsed: 1,
      summary: null,
    },
  })
  assert.deepEqual(queued(), [])
})

test('actual coding startup is announced separately from submission acknowledgement', async () => {
  // An admission receipt must not suppress the later, authoritative execution-start fact.
  const {service} = realtimeServiceHarness('pipeline')
  await service.connect()
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'user_speech_ended',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: 'user-item-1',
    text: 'compile the runtime',
  })
  await service.handleEvent({
    kind: 'response_started',
    session_epoch: 1,
    response_id: 'r-1',
  })
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'call-1',
    item_id: 'tool-item-1',
    name: 'codex__run',
    arguments: {work_order: 'compile the runtime'},
    response_id: 'r-1',
  })
  // The admission created the acknowledgement this suppression depends on.
  assert.equal(service.toolCallAcceptances()[0]?.acceptance.delegate_id, 'd-1')

  service.projectRuntimeEvent({
    kind: 'progress',
    seq: 1,
    ts: 1,
    payload: {
      channel: 'codex',
      delegate_id: 'd-1',
      op: 'run',
      phase: 'started',
      internal_activity: 0,
      elapsed: 0,
      summary: null,
    },
  })
  assert.equal(service.pendingHostItemCount, 1)
  assert.equal(service.session.delegateState('d-1'), 'running')
})

test('coding startup uses the executor display name and announces each delegate only once', () => {
  const {service, queued} = realtimeServiceHarness('projection', {displayName: 'Test Builder'})
  assert.deepEqual(queued(), [], 'admission alone is not a started event')

  const started: EventRecord = {
    kind: 'progress',
    seq: 1,
    ts: 1,
    payload: {
      channel: 'codex',
      delegate_id: 'd-1',
      op: 'start',
      phase: 'started',
      internal_activity: 0,
      elapsed: 0,
      summary: null,
    },
  }
  service.projectRuntimeEvent(started)
  service.projectRuntimeEvent({...started, seq: 2})

  assert.deepEqual(queued(), ['交给 Test Builder 执行。'])
  assert.equal(service.session.delegateState('d-1'), 'running')
})

test('built-in monitoring executors use stable Chinese display names', () => {
  for (const [channel, displayName] of [
    ['guard', '监控'],
    ['watch', '观察'],
  ] as const) {
    const {service, queued} = realtimeServiceHarness('projection', {
      delegate: {executor: channel, op: 'start', routing_class: 'user_awaited'},
      operationClass: 'monitor',
      alertDelivery: channel === 'guard' ? 'preemptive' : 'deferred',
    })

    service.projectRuntimeEvent({
      kind: 'progress',
      seq: 1,
      ts: 1,
      payload: {
        channel,
        delegate_id: 'd-1',
        op: 'start',
        phase: 'started',
        internal_activity: 0,
        elapsed: 0,
        summary: null,
      },
    })

    assert.deepEqual(queued(), [`${displayName} 已开始处理这个任务。`])
  }
})

test('continuous coding progress is direct, deduplicated, nonempty and coalesced', () => {
  const {service, queued} = realtimeServiceHarness('projection', {progressViaSurrogate: true})
  service.setCodingProgressNarration('continuous')
  service.projectRuntimeEvent(progressEvent({seq: 1, summary: '验证了登录故障', activity: 1}))
  service.projectRuntimeEvent(progressEvent({seq: 2, summary: '验证了登录故障', activity: 2}))
  assert.equal(queued().length, 1)
  service.projectRuntimeEvent(progressEvent({seq: 3, summary: null, activity: 3}))
  assert.equal(queued().length, 1)
  service.projectRuntimeEvent(progressEvent({seq: 4, summary: '回归测试通过', activity: 4}))
  assert.equal(queued().length, 1, 'bounded latest update per task')
  assert.match(queued()[0]!, /回归测试通过/u)
  service.setCodingProgressNarration('smart')
  assert.equal(queued().length, 0, 'mode switch withdraws queued progress')
  service.setCodingProgressNarration('continuous')
  service.projectRuntimeEvent(progressEvent({seq: 5, summary: '新的验证结果', activity: 5}))
  assert.equal(queued().length, 1, 'continuous mode resumes with the next new summary')
})

test('continuous coding progress leaves final delivery available', () => {
  const {service, queuedItems} = realtimeServiceHarness('projection', {progressViaSurrogate: true})
  service.setCodingProgressNarration('continuous')
  service.projectRuntimeEvent({kind: 'handoff', seq: 1, ts: 1, payload: {
    channel: 'codex', delegate_id: 'd-1', origin_ref: 'conversation:1', outcome: 'ok',
    trust: 'trusted_system', content: {summary: '验证通过，任务完成'}, refs: [],
  }})
  assert.equal(queuedItems().length, 1)
  assert.equal(queuedItems()[0]!.intent.item.kind, 'final')
})

test('coding preference listener is restored after service close and reconnect', async () => {
  const {service, queued} = realtimeServiceHarness('projection', {progressViaSurrogate: true})
  await service.connect()
  await service.close()
  await service.connect()
  service.setCodingProgressNarration('continuous')
  service.projectRuntimeEvent(progressEvent({seq: 1, summary: '新的进展', activity: 1}))
  assert.equal(queued().length, 1)
  service.setCodingProgressNarration('smart')
  assert.equal(queued().length, 0)
  await service.close()
})

test('received coding summaries deduplicate across smart continuous and repeated mode switches', () => {
  const {service, queued} = realtimeServiceHarness('projection', {progressViaSurrogate: true})
  service.projectRuntimeEvent(progressEvent({seq: 1, summary: '**A**', activity: 1}))
  service.setCodingProgressNarration('continuous')
  service.projectRuntimeEvent(progressEvent({seq: 2, summary: 'A', activity: 2}))
  assert.equal(queued().length, 0, 'a smart received fact is not new after switching modes')
  service.projectRuntimeEvent(progressEvent({seq: 3, summary: 'B', activity: 3}))
  assert.equal(queued().length, 1)
  service.setCodingProgressNarration('smart')
  service.projectRuntimeEvent(progressEvent({seq: 4, summary: 'C', activity: 4}))
  service.setCodingProgressNarration('continuous')
  service.projectRuntimeEvent(progressEvent({seq: 5, summary: 'B', activity: 5}))
  assert.equal(queued().length, 1, 'B is new relative to intervening smart C')
  service.setCodingProgressNarration('smart')
  service.setCodingProgressNarration('continuous')
  service.projectRuntimeEvent(progressEvent({seq: 6, summary: 'B', activity: 6}))
  assert.equal(queued().length, 0, 'withdrawn queued facts are received, not claimed delivered or replayed')
})
test('latency telemetry binds accepted speech, audio and playback without conversation bodies', async () => {
  const {service, session, telemetry} = realtimeServiceHarness('pipeline')
  await service.connect()
  await service.handleEvent({kind: 'user_speech_started', session_epoch: 1, speech_id: 's', provider_item_id: 'i'})
  await service.handleEvent({kind: 'user_speech_ended', session_epoch: 1, speech_id: 's', provider_item_id: 'i'})
  await service.handleEvent({kind: 'user_transcript_final', session_epoch: 1, item_id: 'i', text: 'private profiling test'})
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r'})
  for (let i = 0; i < 2; i++) await service.handleEvent({kind: 'response_audio_delta', session_epoch: 1, response_id: 'r', pcm: new Uint8Array([0, 1])})
  const generation = session.currentGeneration!
  assert.equal(service.playbackStarted(generation.utterance_id, generation.generation_epoch), true)
  await service.handleEvent({kind: 'response_terminal', session_epoch: 1, response_id: 'r', status: 'completed', reason: ''})
  const kinds = ['provider.user_speech_ended', 'provider.user_transcript_final', 'provider.first_audio_delta', 'playback.started', 'provider.response_terminal']
  for (const kind of kinds) assert.equal(telemetry.filter(row => row.kind === kind).length, 1, kind)
  assert.deepEqual(telemetry.find(row => row.kind === 'provider.first_audio_delta')?.payload, {session_epoch: 1, response_id: 'r'})
  assert.equal(JSON.stringify(telemetry.filter(row => kinds.includes(row.kind))).includes('private profiling test'), false)
})

test('caption source identity distinguishes adjacent same-role provider turns without final delivery',async()=>{
  const captions:{turn_id?:string;text:string}[]=[]
  const {service}=realtimeServiceHarness('pipeline', {onCaption:frame=>captions.push(frame)})
  await service.connect()
  try {
    const epoch=service.session.sessionEpoch
    await service.handleEvent({kind:'user_transcript_delta',session_epoch:epoch,item_id:'one',text:'first'})
    await service.handleEvent({kind:'user_transcript_delta',session_epoch:epoch,item_id:'one',text:' continuation'})
    await service.handleEvent({kind:'user_transcript_delta',session_epoch:epoch,item_id:'two',text:'second'})
    assert.equal(captions.length,3)
    assert.ok(captions[0]!.turn_id)
    assert.equal(captions[0]!.turn_id,captions[1]!.turn_id)
    assert.notEqual(captions[0]!.turn_id,captions[2]!.turn_id)
  } finally {await service.close()}
})


test('steer receipts settle internally without startup or final narration', () => {
  const {service, queued} = realtimeServiceHarness('projection', {delegate: {executor: 'codex', op: 'steer', routing_class: 'user_awaited'}})
  service.projectRuntimeEvent({kind: 'progress', seq: 1, ts: 1, payload: {
    channel: 'codex', delegate_id: 'd-1', op: 'steer', phase: 'started', internal_activity: 0, elapsed: 0, summary: null,
  }})
  service.projectRuntimeEvent({kind: 'handoff', seq: 2, ts: 2, payload: {
    channel: 'codex', delegate_id: 'd-1', origin_ref: 'conversation:1', outcome: 'ok', trust: 'trusted_system',
    content: {op: 'steer', code: 'accepted'}, refs: [],
  }})
  assert.equal(service.session.delegateState('d-1'), 'completed')
  assert.deepEqual(queued(), [])
})
