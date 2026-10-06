import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {TaskService} from '../src/personal-agent/tasks.js'
import {canonicalJson} from '../src/text/canonical-json.js'
import type {JsonValue} from '../src/core/events.js'
import {ItemDeliveryUncertainError} from '../src/realtime/protocol.js'
import {
  PREEMPT_MIN_PRIORITY
} from '../src/realtime/service-state.js'
import {RealtimeService} from '../src/realtime/service.js'
import {deliveryPassScenarios, document, finishProviderResponse, golden, guardFact, hostFact, openCompletedAcknowledgementPlayback, queueOnlyOptions, realtimeServiceHarness, runScenario, twoTurns} from './support/realtime-service-harness.js'


test('every service queue scenario matches the Python-exported golden', () => {
  const mismatched: string[] = []
  for (const [index, scenario] of document.scenarios.entries()) {
    const actual = runScenario(scenario)
    if (canonicalJson(actual) !== canonicalJson(golden.scenarios[index])) {
      mismatched.push(scenario.name)
    }
  }
  assert.deepEqual(mismatched, [], 'queue ordering differs from the oracle')
})

test('tracked executor handoff settles activity without publishing an unverified task completion',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'tracked-handoff-')),tasks=new TaskService(join(dir,'tasks.json'))
 const {service,actions}=realtimeServiceHarness('pipeline',{taskHost:{tasks,conversation_id:'chat:main'}})
 try{
  await tasks.open();await service.connect()
  const task=await tasks.delegate('task',{conversation_id:'chat:main',goal:'Fix counter',acceptance:['Browser observations verified'],origin_ref:'conversation:1'})
  const fence={task_id:task.id,control_revision:0,goal_revision:0};await tasks.bindWork(fence,'d-1','session')
  const content={result:{final_message:{text:'任务已完成，我把 counter.mjs 修好了。'}}}
  await tasks.recordWorkOutcome('d-1','ok',content);await tasks.wait(fence,'completion evidence gate')
  service.projectRuntimeEvent({kind:'handoff',seq:1,ts:1,payload:{channel:'codex',delegate_id:'d-1',origin_ref:'conversation:1',outcome:'ok',trust:'trusted_system',content,refs:[]}})
  await service.flushHostItems()
  assert.equal(service.session.delegateState('d-1'),'completed','executor activity still settles')
  assert.equal(tasks.get(task.id).phase,'waiting');assert.equal(tasks.get(task.id).waiting_reason,'completion evidence gate')
  assert.equal(service.pendingHostItemCount,0);assert.equal(actions.some(action=>action==='inject:final:d-1'),false,'only the task verifier may publish completion')
 }finally{await service.close();await tasks.close();await rm(dir,{recursive:true,force:true})}
})

test('the bounds the golden records are the bounds the module uses', () => {
  // The constants are behavior: `PREEMPT_MIN_PRIORITY` is the line between a fact that waits and one
  // that interrupts. Reading them from the golden rather than restating them means a change on either
  // side has to be a deliberate re-export.
  assert.equal(PREEMPT_MIN_PRIORITY, golden.constants.preempt_min_priority)
})

test('every scenario declares what it covers', () => {
  for (const scenario of document.scenarios) {
    assert.ok(scenario.covers.length > 0, scenario.name)
    assert.ok(scenario.steps.length > 0, scenario.name)
  }
})

test('the scenario set exercises all three ordering fields', () => {
  // A set that only varied priority would pass with the other two fields deleted.
  const kinds = new Set(document.scenarios.flatMap(scenario => scenario.covers))
  for (const expected of [
    'service.queue_priority',
    'service.queue_fifo_within_priority',
    'service.queue_preemptive_tiebreak',
    'service.priority_clamp',
    'service.armed_preempt',
  ]) {
    assert.ok(kinds.has(expected), `no scenario covers ${expected}`)
  }
})

test('a cancel rejection is ignored unless controlled reconnect is enabled', async () => {
  // Replacing the whole provider session is a heavy remedy for a case that should not happen, so it is
  // gated. With the gate closed the event is simply consumed: the provider refused a cancel, and the
  // ordinary alert deadline is what handles that.
  const service = realtimeServiceHarness('queue')
  await service.handleEvent({
    kind: 'response_cancel_rejected',
    session_epoch: 1,
    response_id: 'r-1',
    cancel_request_id: 'cancel-1',
    reason: 'no_active_response',
  })
  assert.equal(service.stopped, false, 'and it does not take the service down')
})

test('driving continuations with nothing queued is a no-op, not a refusal', () => {
  // The drive runs on every accepted event, so its empty case is the common one. It has to return
  // quietly rather than throw or block, or an ordinary event would fail.
  const service = realtimeServiceHarness('queue')
  return service.driveContinuations()
})

test('the preemptive-alert history arms are the measured ones, and nothing else', () => {
  // 1, 2, or 4 rather than any positive number: these are the arms the recovery experiment has, and
  // an unlisted value would silently be a fifth arm nobody measured.
  for (const pairs of [0, 3, 5, 8, -1, 1.5]) {
    assert.throws(
      () => new RealtimeService({
        ...queueOnlyOptions(),
        preemptiveAlertHistoryPairs: pairs,
      }),
      /pair budget must be 1, 2, or 4/u,
      `pairs=${pairs}`,
    )
  }
  for (const pairs of [1, 2, 4]) {
    assert.doesNotThrow(() => new RealtimeService({...queueOnlyOptions(), preemptiveAlertHistoryPairs: pairs}))
  }
  assert.throws(
    () => new RealtimeService({
      ...queueOnlyOptions(),
      preemptiveAlertHistoryRecovery: 'sideways' as 'none',
    }),
    /unknown preemptive-alert history recovery arm/u,
  )
})

test('the provider schemas are copied, not aliased', () => {
  // They are handed to the provider on every connect, including after a reconnect. A caller mutating
  // its own array afterwards would change what the model is told its tools are, mid-session.
  const schemas: Record<string, JsonValue>[] = [{function: {name: 'a', parameters: {}}}]
  const service = new RealtimeService({...queueOnlyOptions(), providerSchemas: schemas})
  const before = canonicalJson(service.providerSchemasForTest)
  schemas[0]!.function = {name: 'tampered', parameters: {}}
  schemas.push({function: {name: 'added', parameters: {}}})
  assert.equal(
    canonicalJson(service.providerSchemasForTest),
    before,
    'the caller mutating its array must not change what the service will send',
  )
  assert.equal(service.providerSchemasForTest.length, 1)
  assert.equal(
    canonicalJson(service.providerSchemasForTest[0]),
    canonicalJson({function: {name: 'a', parameters: {}}}),
  )
})

test('a recovery item that comes back uncertain stops the service rather than retrying', async () => {
  // Retrying a recovery injection means reconnecting, and a recovery injection is what a reconnect
  // *is* -- so the retry would recurse. Two uncertainties for the same item mean the transport cannot
  // be trusted to report anything, and guessing whether the model has seen a fact is worse than
  // stopping.
  const diagnostics: string[] = []
  const service = new RealtimeService({
    ...queueOnlyOptions(),
    onDiagnostic: line => diagnostics.push(line),
  })
  const uncertain = new ItemDeliveryUncertainError({
    session_epoch: 1,
    host_item_id: 'host-1',
    provider_item_id: 'provider-1',
    item_kind: 'recovery',
  })
  await service.reportUncertainDeliveryForTest(uncertain)
  assert.equal(service.stopped, true)
  assert.deepEqual(diagnostics, ['[realtime-diagnostic] uncertain_delivery_exhausted'])
})

test('an ordinary item is retried once, and a second uncertainty stops the service', async () => {
  // One retry per item: the first uncertainty is a transport that might recover, the second is a
  // transport that cannot be trusted to report anything. Guessing whether the model has seen a fact
  // is worse than stopping, so the second attempt does not happen.
  const diagnostics: string[] = []
  const service = new RealtimeService({
    ...queueOnlyOptions(),
    onDiagnostic: line => diagnostics.push(line),
  })
  const uncertain = (hostItemId: string): ItemDeliveryUncertainError => new ItemDeliveryUncertainError({
    session_epoch: 1,
    host_item_id: hostItemId,
    provider_item_id: 'provider-1',
    item_kind: 'final',
  })

  // The first attempt spends the retry on a reconnect, which the queue-only fixture has no session
  // for -- so it throws from there rather than reporting the budget as exhausted.
  await assert.rejects(() => service.reportUncertainDeliveryForTest(uncertain('host-1')))
  assert.equal(service.stopped, false, 'a first uncertainty must not stop the service')
  assert.deepEqual(diagnostics, [])

  // The same item again: the retry is already spent, so it never reaches the reconnect.
  await service.reportUncertainDeliveryForTest(uncertain('host-1'))
  assert.equal(service.stopped, true)
  assert.deepEqual(diagnostics, ['[realtime-diagnostic] uncertain_delivery_exhausted'])
})

test('the retry budget is per item, not global', async () => {
  // A different item gets its own first attempt: one flaky injection must not spend the budget of
  // every later one.
  const service = new RealtimeService(queueOnlyOptions())
  const uncertain = (hostItemId: string): ItemDeliveryUncertainError => new ItemDeliveryUncertainError({
    session_epoch: 1,
    host_item_id: hostItemId,
    provider_item_id: 'provider-1',
    item_kind: 'final',
  })
  await assert.rejects(() => service.reportUncertainDeliveryForTest(uncertain('host-1')))
  // A second item still gets its own retry rather than inheriting a spent one, so it reaches the
  // reconnect too instead of reporting the budget as exhausted.
  await assert.rejects(() => service.reportUncertainDeliveryForTest(uncertain('host-2')))
  assert.equal(service.stopped, false)
})

test('an immediate Codex startup failure waits behind a playing acknowledgement and is still spoken', async () => {
  const {service, actions, session} = realtimeServiceHarness('pipeline')
  await service.connect()
  await service.handleEvent({
    kind: 'user_speech_started', session_epoch: 1,
    speech_id: 'speech-1', provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'user_speech_ended', session_epoch: 1,
    speech_id: 'speech-1', provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'user_transcript_final', session_epoch: 1,
    item_id: 'user-item-1', text: 'build the game',
  })
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'tool_call_ready', session_epoch: 1, call_id: 'call-1', item_id: 'tool-1',
    name: 'codex__run', arguments: {work_order: 'build the game'}, response_id: 'r-1',
  })
  await service.handleEvent({
    kind: 'response_terminal', session_epoch: 1, response_id: 'r-1',
    status: 'completed', reason: '',
  })
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-ack'})
  await service.handleEvent({
    kind: 'response_audio_delta', session_epoch: 1,
    response_id: 'r-ack', pcm: new Uint8Array([0, 1]),
  })
  const generation = session.currentGeneration
  assert.notEqual(generation, null)
  assert.equal(session.playbackStarted(generation!.utterance_id, generation!.generation_epoch), true)
  assert.equal(service.semanticAcknowledgementFor('r-ack'), 'background:d-1')

  service.projectRuntimeEvent({
    kind: 'handoff', seq: 1, ts: 1,
    payload: {
      channel: 'codex', delegate_id: 'd-1', origin_ref: 'conversation:1',
      outcome: 'failed', trust: 'trusted_system',
      content: {error: 'spawn_failed', op: 'run', stage: 'spawn'}, refs: [],
    },
  })

  assert.equal(service.pendingHostItemCount, 1, 'the failure remains queued while audio is playing')
  assert.equal(
    service.queuedHostItems()[0]?.intent.item.content,
    'Codex 进程未能启动，这次任务没有成功启动。',
  )
  assert.equal(
    actions.includes('cancel:r-ack'),
    false,
    'a terminal handoff does not cancel a continuation response carrying broader protocol state',
  )
  await service.handleEvent({
    kind: 'response_terminal', session_epoch: 1, response_id: 'r-ack',
    status: 'completed', reason: '',
  })
  assert.equal(session.playbackDone(generation!.utterance_id, generation!.generation_epoch), true)
  await service.flushHostItems()
  assert.ok(
    actions.includes('inject:final:d-1'),
    `the queued failure is delivered after the acknowledgement: ${JSON.stringify(actions)}`,
  )
})

test('a terminal Codex handoff cancels its playing standalone acknowledgement before speaking final', async () => {
  const {service, actions, session} = realtimeServiceHarness('pipeline')
  await service.connect()
  await service.handleEvent({
    kind: 'user_speech_started', session_epoch: 1,
    speech_id: 'speech-1', provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'user_speech_ended', session_epoch: 1,
    speech_id: 'speech-1', provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'user_transcript_final', session_epoch: 1,
    item_id: 'user-item-1', text: 'create test.py',
  })
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'origin'})
  await service.handleEvent({
    kind: 'tool_call_ready', session_epoch: 1, call_id: 'call-1', item_id: 'tool-1',
    name: 'codex__run', arguments: {work_order: 'create test.py'}, response_id: 'origin',
  })
  await service.handleEvent({
    kind: 'response_terminal', session_epoch: 1, response_id: 'origin',
    status: 'completed', reason: '',
  })
  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'empty-continuation',
  })
  await service.handleEvent({
    kind: 'response_terminal', session_epoch: 1, response_id: 'empty-continuation',
    status: 'completed', reason: '',
  })
  assert.ok(actions.includes('inject:background:d-1'))

  await service.handleEvent({
    kind: 'response_started', session_epoch: 1, response_id: 'standalone-ack',
  })
  await service.handleEvent({
    kind: 'response_audio_delta', session_epoch: 1,
    response_id: 'standalone-ack', pcm: new Uint8Array([0, 1]),
  })
  const generation = session.currentGeneration
  assert.notEqual(generation, null)
  assert.equal(service.playbackStarted(generation!.utterance_id, generation!.generation_epoch), true)
  assert.equal(service.semanticAcknowledgementFor('standalone-ack'), 'background:d-1')

  service.projectRuntimeEvent({
    kind: 'handoff', seq: 1, ts: 1,
    payload: {
      channel: 'codex', delegate_id: 'd-1', origin_ref: 'conversation:1',
      outcome: 'ok', trust: 'trusted_system',
      content: {result: {final_message: {text: 'test.py created'}}}, refs: [],
    },
  })

  assert.equal(service.pendingHostItemCount, 1, 'the final waits only for exact cancellation to settle')
  assert.ok(
    actions.includes('cancel:standalone-ack'),
    `the final supersedes its exact standalone acknowledgement: ${JSON.stringify(actions)}`,
  )
  assert.equal(
    service.queuedHostItems()[0]?.intent.item.content,
    '任务已完成：test.py created',
  )
  assert.equal(
    service.playbackCleared(generation!.utterance_id, generation!.generation_epoch, 0),
    true,
  )
  await service.handleEvent({
    kind: 'response_terminal', session_epoch: 1, response_id: 'standalone-ack',
    status: 'cancelled', reason: 'cancelled',
  })
  await service.flushHostItems()
  assert.equal(
    actions.filter(action => action === 'inject:final:d-1').length,
    1,
    `the final is delivered exactly once after cancellation: ${JSON.stringify(actions)}`,
  )
})

test('failed handoff fences an undelivered semantic acknowledgement', async () => {
  const {service} = realtimeServiceHarness('pipeline')
  await service.connect()
  await service.handleEvent({
    kind: 'user_speech_started', session_epoch: 1,
    speech_id: 'speech-1', provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'user_speech_ended', session_epoch: 1,
    speech_id: 'speech-1', provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'user_transcript_final', session_epoch: 1,
    item_id: 'user-item-1', text: 'build timer',
  })
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'origin'})
  await service.handleEvent({
    kind: 'tool_call_ready', session_epoch: 1, call_id: 'call-1', item_id: 'tool-1',
    name: 'codex__run', arguments: {work_order: 'build timer'}, response_id: 'origin',
  })
  assert.equal(service.deliveryState().acknowledgementPhases['background:d-1'], 'pending')

  service.projectRuntimeEvent({
    kind: 'handoff', seq: 1, ts: 1,
    payload: {
      channel: 'codex', delegate_id: 'd-1', origin_ref: 'conversation:1',
      outcome: 'failed', trust: 'trusted_system',
      content: {error: 'spawn_failed', stage: 'spawn'}, refs: [],
    },
  })

  assert.equal(service.deliveryState().acknowledgementPhases['background:d-1'], 'cancelled')
  assert.deepEqual(service.queuedHostItems().map(item => item.intent.item.event_id), ['final:d-1'])
  assert.equal(service.session.delegateState('d-1'), 'failed')
})

test('successful handoff fences an undelivered semantic acknowledgement before the final result', async () => {
  const {service} = realtimeServiceHarness('pipeline')
  await service.connect()
  await service.handleEvent({
    kind: 'user_speech_started', session_epoch: 1,
    speech_id: 'speech-1', provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'user_speech_ended', session_epoch: 1,
    speech_id: 'speech-1', provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'user_transcript_final', session_epoch: 1,
    item_id: 'user-item-1', text: 'build timer',
  })
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'origin'})
  await service.handleEvent({
    kind: 'tool_call_ready', session_epoch: 1, call_id: 'call-1', item_id: 'tool-1',
    name: 'codex__run', arguments: {work_order: 'build timer'}, response_id: 'origin',
  })
  assert.equal(service.deliveryState().acknowledgementPhases['background:d-1'], 'pending')

  service.projectRuntimeEvent({
    kind: 'handoff', seq: 1, ts: 1,
    payload: {
      channel: 'codex', delegate_id: 'd-1', origin_ref: 'conversation:1',
      outcome: 'ok', trust: 'trusted_system',
      content: {result: {final_message: {text: 'timer completed'}}}, refs: [],
    },
  })

  assert.equal(service.deliveryState().acknowledgementPhases['background:d-1'], 'cancelled')
  assert.deepEqual(service.queuedHostItems().map(item => item.intent.item.event_id), ['final:d-1'])
  assert.equal(service.session.delegateState('d-1'), 'completed')
})

test('a settled delegate cannot deliver progress that was queued while it was running', async () => {
  const {service, actions} = realtimeServiceHarness('pipeline')
  await service.connect()
  service.projectRuntimeEvent({
    kind: 'progress', seq: 1, ts: 1,
    payload: {
      channel: 'codex', delegate_id: 'd-1', op: 'run', phase: 'working',
      internal_activity: 1, elapsed: 1, summary: 'implementing timer',
    },
  })
  service.projectRuntimeEvent({
    kind: 'handoff', seq: 2, ts: 2,
    payload: {
      channel: 'codex', delegate_id: 'd-1', origin_ref: 'conversation:1',
      outcome: 'ok', trust: 'trusted_system',
      content: {result: {final_message: {text: 'timer completed'}}}, refs: [],
    },
  })

  await service.flushHostItems()

  assert.equal(
    actions.some(action => action.startsWith('inject:progress:d-1:')),
    false,
    'stale progress is rejected at the provider boundary',
  )
  assert.ok(actions.includes('inject:final:d-1'), 'the final result remains deliverable')
})

test('a terminal delegate retires progress already visible in provider history', async () => {
  const {service, actions} = realtimeServiceHarness('pipeline')
  await service.connect()
  service.projectRuntimeEvent({
    kind: 'progress', seq: 1, ts: 1,
    payload: {
      channel: 'codex', delegate_id: 'd-1', op: 'run', phase: 'working',
      internal_activity: 1, elapsed: 1, summary: 'implementing timer',
    },
  })
  await service.flushHostItems()
  assert.ok(actions.includes('inject:progress:d-1:working:1'))

  service.projectRuntimeEvent({
    kind: 'handoff', seq: 2, ts: 2,
    payload: {
      channel: 'codex', delegate_id: 'd-1', origin_ref: 'conversation:1',
      outcome: 'ok', trust: 'trusted_system',
      content: {result: {final_message: {text: 'timer completed'}}}, refs: [],
    },
  })

  assert.ok(
    actions.includes('retire:provider:progress:d-1:working:1'),
    'stale progress is removed from the provider conversation on settlement',
  )
})

test('provider retirement failure is diagnostic-only and leaves the final result deliverable', async () => {
  const {service, diagnostics} = realtimeServiceHarness('pipeline', {retireFailure: true})
  await service.connect()
  service.projectRuntimeEvent({
    kind: 'progress', seq: 1, ts: 1,
    payload: {
      channel: 'codex', delegate_id: 'd-1', op: 'run', phase: 'working',
      internal_activity: 1, elapsed: 1, summary: 'implementing timer',
    },
  })
  await service.flushHostItems()

  service.projectRuntimeEvent({
    kind: 'handoff', seq: 2, ts: 2,
    payload: {
      channel: 'codex', delegate_id: 'd-1', origin_ref: 'conversation:1',
      outcome: 'ok', trust: 'trusted_system',
      content: {result: {final_message: {text: 'timer completed'}}}, refs: [],
    },
  })
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(service.queuedHostItems().map(item => item.intent.item.event_id), ['final:d-1'])
  assert.ok(diagnostics.some(line => (
    line === '[realtime-diagnostic] host_item_retire_failure type=RealtimeDeliveryError'
  )))
})

test('ordinary progress expires while final facts remain durable', async () => {
  const {service, actions, clock} = realtimeServiceHarness('pipeline')
  await service.connect()
  service.projectRuntimeEvent({
    kind: 'progress', seq: 1, ts: 1,
    payload: {
      channel: 'codex', delegate_id: 'd-1', op: 'run', phase: 'working',
      internal_activity: 1, elapsed: 1, summary: 'implementing timer',
    },
  })
  clock.advanceTo(clock.now() + 46)

  await service.flushHostItems()

  assert.equal(
    actions.some(action => action.startsWith('inject:progress:d-1:')),
    false,
    'expired progress never crosses the provider boundary',
  )
})

test('delegate settlement during provider injection prevents stale response creation', async () => {
  let releaseInjection!: () => void
  const injectionGate = new Promise<void>(resolve => { releaseInjection = resolve })
  const {service, actions} = realtimeServiceHarness('pipeline', {
    beforeInjectConfirmation: () => injectionGate,
  })
  await service.connect()
  service.projectRuntimeEvent({
    kind: 'progress', seq: 1, ts: 1,
    payload: {
      channel: 'codex', delegate_id: 'd-1', op: 'run', phase: 'working',
      internal_activity: 1, elapsed: 1, summary: 'implementing timer',
    },
  })
  const delivery = service.flushHostItems()
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(actions.includes('inject:progress:d-1:working:1'), 'injection is awaiting confirmation')

  service.projectRuntimeEvent({
    kind: 'handoff', seq: 2, ts: 2,
    payload: {
      channel: 'codex', delegate_id: 'd-1', origin_ref: 'conversation:1',
      outcome: 'ok', trust: 'trusted_system',
      content: {result: {final_message: {text: 'timer completed'}}}, refs: [],
    },
  })
  releaseInjection()
  await delivery
  await new Promise(resolve => setImmediate(resolve))

  const retirement = actions.indexOf('retire:provider:progress:d-1:working:1')
  const response = actions.findIndex(action => action.startsWith('create_response:'))
  assert.ok(
    retirement >= 0,
    'the provider identity learned after settlement is still retired',
  )
  assert.ok(
    response === -1 || retirement < response,
    `stale progress is retired before the durable final may create a response: ${actions.join(',')}`,
  )
})

test('progress expiring during provider injection prevents stale response creation', async () => {
  let releaseInjection!: () => void
  const injectionGate = new Promise<void>(resolve => { releaseInjection = resolve })
  const {service, actions, clock} = realtimeServiceHarness('pipeline', {
    beforeInjectConfirmation: () => injectionGate,
  })
  await service.connect()
  service.projectRuntimeEvent({
    kind: 'progress', seq: 1, ts: 1,
    payload: {
      channel: 'codex', delegate_id: 'd-1', op: 'run', phase: 'working',
      internal_activity: 1, elapsed: 1, summary: 'implementing timer',
    },
  })
  const delivery = service.flushHostItems()
  await new Promise(resolve => setImmediate(resolve))
  clock.advanceTo(clock.now() + 46)
  releaseInjection()
  await delivery
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(
    actions.some(action => action.startsWith('create_response:')),
    false,
    'expired progress cannot request a response after injection resumes',
  )
  assert.ok(actions.includes('retire:provider:progress:d-1:working:1'))
})

test('unknown handoff fences acknowledgement but remains open to a late verdict', async () => {
  const {service} = realtimeServiceHarness('pipeline')
  await service.connect()
  await service.handleEvent({
    kind: 'user_speech_started', session_epoch: 1,
    speech_id: 'speech-1', provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'user_speech_ended', session_epoch: 1,
    speech_id: 'speech-1', provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'user_transcript_final', session_epoch: 1,
    item_id: 'user-item-1', text: 'build timer',
  })
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'origin'})
  await service.handleEvent({
    kind: 'tool_call_ready', session_epoch: 1, call_id: 'call-1', item_id: 'tool-1',
    name: 'codex__run', arguments: {work_order: 'build timer'}, response_id: 'origin',
  })

  service.projectRuntimeEvent({
    kind: 'handoff', seq: 1, ts: 1,
    payload: {
      channel: 'codex', delegate_id: 'd-1', origin_ref: 'conversation:1',
      outcome: 'unknown', trust: 'trusted_system',
      content: {error: 'transport_timeout'}, refs: [],
    },
  })

  assert.equal(service.deliveryState().acknowledgementPhases['background:d-1'], 'cancelled')
  assert.equal(service.session.delegateState('d-1'), 'unknown')

  service.projectRuntimeEvent({
    kind: 'handoff', seq: 2, ts: 2,
    payload: {
      channel: 'codex', delegate_id: 'd-1', origin_ref: 'conversation:1',
      outcome: 'ok', trust: 'trusted_system',
      content: {result: {final_message: {text: 'timer completed'}}}, refs: [],
    },
  })

  assert.equal(service.session.delegateState('d-1'), 'completed')
})

test('failed handoff suppresses a bound unspoken acknowledgement', async () => {
  const {service, session} = realtimeServiceHarness('pipeline')
  await service.connect()
  await service.handleEvent({
    kind: 'user_speech_started', session_epoch: 1,
    speech_id: 'speech-1', provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'user_speech_ended', session_epoch: 1,
    speech_id: 'speech-1', provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'user_transcript_final', session_epoch: 1,
    item_id: 'user-item-1', text: 'build timer',
  })
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'origin'})
  await service.handleEvent({
    kind: 'tool_call_ready', session_epoch: 1, call_id: 'call-1', item_id: 'tool-1',
    name: 'codex__run', arguments: {work_order: 'build timer'}, response_id: 'origin',
  })
  await service.handleEvent({
    kind: 'response_terminal', session_epoch: 1, response_id: 'origin',
    status: 'completed', reason: '',
  })
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'ack'})
  assert.equal(service.deliveryState().acknowledgementPhases['background:d-1'], 'bound')

  service.projectRuntimeEvent({
    kind: 'handoff', seq: 1, ts: 1,
    payload: {
      channel: 'codex', delegate_id: 'd-1', origin_ref: 'conversation:1',
      outcome: 'failed', trust: 'trusted_system',
      content: {error: 'spawn_failed', stage: 'spawn'}, refs: [],
    },
  })
  await service.handleEvent({
    kind: 'response_audio_delta', session_epoch: 1,
    response_id: 'ack', pcm: new Uint8Array([0, 1]),
  })

  assert.equal(service.deliveryState().acknowledgementPhases['background:d-1'], 'cancelled')
  assert.equal(session.currentGeneration, null)
  assert.deepEqual(service.queuedHostItems().map(item => item.intent.item.event_id), ['final:d-1'])
})

test('failed handoff suppresses a requested acknowledgement when its response starts', async () => {
  const {service, session} = realtimeServiceHarness('pipeline')
  await service.connect()
  await service.handleEvent({
    kind: 'user_speech_started', session_epoch: 1,
    speech_id: 'speech-1', provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'user_speech_ended', session_epoch: 1,
    speech_id: 'speech-1', provider_item_id: 'user-item-1',
  })
  await service.handleEvent({
    kind: 'user_transcript_final', session_epoch: 1,
    item_id: 'user-item-1', text: 'build timer',
  })
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'origin'})
  await service.handleEvent({
    kind: 'tool_call_ready', session_epoch: 1, call_id: 'call-1', item_id: 'tool-1',
    name: 'codex__run', arguments: {work_order: 'build timer'}, response_id: 'origin',
  })
  await service.reconnectForTest()
  assert.equal(service.deliveryState().acknowledgementPhases['background:d-1'], 'requested')

  service.projectRuntimeEvent({
    kind: 'handoff', seq: 1, ts: 1,
    payload: {
      channel: 'codex', delegate_id: 'd-1', origin_ref: 'conversation:1',
      outcome: 'failed', trust: 'trusted_system',
      content: {error: 'spawn_failed', stage: 'spawn'}, refs: [],
    },
  })
  await service.handleEvent({kind: 'response_started', session_epoch: 2, response_id: 'late-ack'})
  await service.handleEvent({
    kind: 'response_audio_delta', session_epoch: 2,
    response_id: 'late-ack', pcm: new Uint8Array([0, 1]),
  })

  assert.equal(service.deliveryState().acknowledgementPhases['background:d-1'], 'cancelled')
  assert.equal(session.currentGeneration, null)
  assert.deepEqual(service.queuedHostItems().map(item => item.intent.item.event_id), ['final:d-1'])
})

test('an acknowledgement bound to an unfinished continuation is reopened by the reconnect', async () => {
  // Its turn was speaking when the session died, so the user heard part of nothing. Left `bound` it
  // would never be queued again -- the queue helper refuses anything already bound -- and the user
  // would simply never be told the work started.
  const {service, actions, session} = realtimeServiceHarness('pipeline')
  await service.connect()
  await twoTurns(service)
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: 'user-item-1',
    text: 'compile the runtime',
  })
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'call-1',
    item_id: 'tool-1',
    name: 'codex__run',
    arguments: {work_order: 'compile the runtime'},
    response_id: 'r-1',
  })
  await service.handleEvent({
    kind: 'response_terminal',
    session_epoch: 1,
    response_id: 'r-1',
    status: 'completed',
    reason: '',
  })
  const toolOutputEventId = service.toolCallAcceptances()[0]?.acceptance.host_item.event_id
  assert.notEqual(toolOutputEventId, undefined, 'the continuation owns a real tool output')
  // The continuation turn starts -- binding the acknowledgement to it -- and then never finishes.
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-2'})
  assert.equal(
    service.deliveryState().acknowledgementPhases['background:d-1'],
    'bound',
    'bound to a turn that is still speaking',
  )
  assert.equal(session.hostEventIsDeduplicated(toolOutputEventId!), true)
  const before = actions.filter(action => action === 'inject:background:d-1').length

  await service.reconnectForTest()
  assert.equal(
    session.hostEventIsDeduplicated(toolOutputEventId!),
    true,
    'reopening the semantic acknowledgement must not release the tool output ledger',
  )
  assert.equal(
    actions.filter(action => action === 'inject:background:d-1').length,
    before + 1,
    'reopened and delivered in the new session',
  )
})

test('an acknowledgement bound to an unfinished fallback is reopened by the reconnect', async () => {
  const {service, actions} = realtimeServiceHarness('pipeline')
  await service.connect()
  await twoTurns(service)
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'user_transcript_final', session_epoch: 1,
    item_id: 'user-item-1', text: 'compile the runtime',
  })
  await service.handleEvent({
    kind: 'tool_call_ready', session_epoch: 1,
    call_id: 'call-1', item_id: 'tool-1', name: 'codex__run',
    arguments: {work_order: 'compile the runtime'}, response_id: 'r-1',
  })

  // The first reconnect abandons the continuation and requests the standalone fallback fact.
  await service.reconnectForTest()
  const fallbackEpoch = service.session.sessionEpoch
  await service.handleEvent({
    kind: 'response_started', session_epoch: fallbackEpoch, response_id: 'r-fallback',
  })
  assert.equal(service.deliveryState().acknowledgementPhases['background:d-1'], 'bound')
  const before = actions.filter(action => action === 'inject:background:d-1').length

  await service.reconnectForTest()

  assert.equal(
    actions.filter(action => action === 'inject:background:d-1').length,
    before + 1,
    'the dead fallback binding is re-offered in the replacement session',
  )
})

test('a zero-audio fallback completion reopens response authority without reinjection', async () => {
  const {service, actions} = realtimeServiceHarness('pipeline')
  await service.connect()
  await twoTurns(service)
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'user_transcript_final', session_epoch: 1,
    item_id: 'user-item-1', text: 'compile the runtime',
  })
  await service.handleEvent({
    kind: 'tool_call_ready', session_epoch: 1,
    call_id: 'call-1', item_id: 'tool-1', name: 'codex__run',
    arguments: {work_order: 'compile the runtime'}, response_id: 'r-1',
  })

  await service.reconnectForTest()
  const fallbackEpoch = service.session.sessionEpoch
  await service.handleEvent({
    kind: 'response_started', session_epoch: fallbackEpoch, response_id: 'r-fallback-1',
  })
  assert.equal(service.deliveryState().acknowledgementPhases['background:d-1'], 'bound')
  const responsesBefore = actions.filter(action => action === 'create_response:host_fact').length
  const injectionsBefore = actions.filter(action => action === 'inject:background:d-1').length

  await service.handleEvent({
    kind: 'response_terminal', session_epoch: fallbackEpoch,
    response_id: 'r-fallback-1', status: 'completed', reason: '',
  })

  assert.equal(
    actions.filter(action => action === 'create_response:host_fact').length,
    responsesBefore + 1,
    'the same provider fact can request a replacement response after zero audio',
  )
  assert.equal(
    actions.filter(action => action === 'inject:background:d-1').length,
    injectionsBefore,
    'reopening response authority preserves the confirmed provider item',
  )
  assert.equal(service.deliveryState().acknowledgementPhases['background:d-1'], 'requested')
})

test('an acknowledgement heard from its continuation is not reopened by a reconnect', async () => {
  const {service, actions, session} = realtimeServiceHarness('pipeline')
  await service.connect()
  await twoTurns(service)
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: 'user-item-1',
    text: 'compile the runtime',
  })
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'call-1',
    item_id: 'tool-1',
    name: 'codex__run',
    arguments: {work_order: 'compile the runtime'},
    response_id: 'r-1',
  })
  await service.handleEvent({
    kind: 'response_terminal',
    session_epoch: 1,
    response_id: 'r-1',
    status: 'completed',
    reason: '',
  })
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-2'})
  await service.handleEvent({
    kind: 'response_audio_delta',
    session_epoch: 1,
    response_id: 'r-2',
    pcm: new Uint8Array([0, 1]),
  })
  const generation = session.currentGeneration
  assert.notEqual(generation, null)
  assert.equal(
    service.playbackStarted(generation!.utterance_id, generation!.generation_epoch),
    true,
  )
  await service.handleEvent({
    kind: 'response_terminal',
    session_epoch: 1,
    response_id: 'r-2',
    status: 'completed',
    reason: '',
  })
  assert.equal(
    service.deliveryState().acknowledgementPhases['background:d-1'],
    'bound',
    'provider completion is not proof that renderer playback reached the user',
  )
  assert.equal(
    service.playbackDone(generation!.utterance_id, generation!.generation_epoch, 250),
    true,
  )
  assert.equal(service.deliveryState().acknowledgementPhases['background:d-1'], 'delivered')
  const before = actions.filter(action => action === 'inject:background:d-1').length

  await service.reconnectForTest()

  assert.equal(
    actions.filter(action => action === 'inject:background:d-1').length,
    before,
    'audibly delivered acknowledgement stays retired across provider replacement',
  )
})

test('playback clear reopens an unheard acknowledgement until its delegate settles', async () => {
  const {service, session, actions} = realtimeServiceHarness('pipeline')
  await service.connect()
  const generation = await openCompletedAcknowledgementPlayback(service, session)

  await service.localSpeechOnset('local-speech-1')
  assert.equal(
    service.playbackCleared(generation.utterance_id, generation.generation_epoch, 0),
    true,
  )
  assert.equal(service.deliveryState().acknowledgementPhases['background:d-1'], 'queued')

  service.projectRuntimeEvent({
    kind: 'handoff', seq: 1, ts: 1,
    payload: {
      channel: 'codex', delegate_id: 'd-1', origin_ref: 'conversation:1',
      outcome: 'ok', trust: 'trusted_system',
      content: {result: {final_message: {text: 'timer completed'}}}, refs: [],
    },
  })
  assert.equal(service.deliveryState().acknowledgementPhases['background:d-1'], 'cancelled')
  const before = actions.filter(action => action === 'inject:background:d-1').length
  await service.reconnectForTest()
  assert.equal(
    actions.filter(action => action === 'inject:background:d-1').length,
    before,
    'settlement prevents the interrupted acknowledgement from returning after reconnect',
  )
})

test('local speech after partial acknowledgement playback suppresses a repeated acknowledgement', async () => {
  const {service, session, actions} = realtimeServiceHarness('pipeline')
  await service.connect()
  const generation = await openCompletedAcknowledgementPlayback(service, session)

  await service.localSpeechOnset('local-speech-1')
  assert.equal(
    service.playbackCleared(generation.utterance_id, generation.generation_epoch, 4_000),
    true,
  )
  assert.equal(
    service.deliveryState().acknowledgementPhases['background:d-1'],
    'cancelled',
    'the user already heard part of this acknowledgement and then took the floor',
  )
  const before = actions.filter(action => action === 'inject:background:d-1').length

  await service.reconnectForTest()

  assert.equal(
    actions.filter(action => action === 'inject:background:d-1').length,
    before,
    'a user-interrupted acknowledgement is not replayed after provider replacement',
  )
})

test('playback stop reopens an unheard acknowledgement for the still-running delegate', async () => {
  const {service, session, actions} = realtimeServiceHarness('pipeline')
  await service.connect()
  const generation = await openCompletedAcknowledgementPlayback(service, session)

  assert.equal(
    await service.playbackStopped(generation.utterance_id, generation.generation_epoch, 0),
    true,
  )
  assert.equal(service.deliveryState().acknowledgementPhases['background:d-1'], 'queued')
  const before = actions.filter(action => action === 'inject:background:d-1').length

  await service.reconnectForTest()

  assert.equal(
    actions.filter(action => action === 'inject:background:d-1').length,
    before + 1,
    'the replacement session re-offers the acknowledgement that renderer never completed',
  )
})

test('renderer disconnect fences the current generation even before its first frame arrives', async () => {
  const {service, session} = realtimeServiceHarness('pipeline')
  await service.connect()
  await service.handleEvent({
    kind: 'response_started',
    session_epoch: 1,
    response_id: 'r-disconnected-before-audio',
  })
  assert.equal(session.currentGeneration, null)

  assert.equal(await service.playbackDisconnected(), true)
  assert.equal(session.currentGeneration, null)
  await service.handleEvent({
    kind: 'response_audio_delta',
    session_epoch: 1,
    response_id: 'r-disconnected-before-audio',
    pcm: new Uint8Array([0, 1]),
  })
  assert.equal(session.currentGeneration, null)
})

test('renderer reconnect releases an abandoned provider VAD hold before new agent audio', async (t) => {
  const {service, session, clock, actions} = realtimeServiceHarness('pipeline', {parkProviderEvents: true})
  t.after(async () => { await service.close() })
  await service.start()
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-before-disconnect',
    provider_item_id: 'user-before-disconnect',
  })
  assert.equal(session.floor.state, 'user_speaking')

  service.queueHostItem(hostFact('queued-during-renderer-disconnect'))
  await new Promise<void>(resolve => { setImmediate(resolve) })
  assert.equal(
    actions.includes('inject:queued-during-renderer-disconnect'),
    false,
    'the user hold initially keeps the real host delivery queue closed',
  )

  await service.playbackDisconnected()
  assert.equal(session.floor.state, 'idle')
  service.queueHostItem(hostFact('queued-after-renderer-disconnect'))
  await new Promise<void>(resolve => { setImmediate(resolve) })
  assert.equal(
    actions.includes('inject:queued-during-renderer-disconnect'),
    false,
    'a disconnected renderer does not reopen provider delivery',
  )
  assert.equal(
    actions.includes('inject:queued-after-renderer-disconnect'),
    false,
    'new host work also stays paused until a renderer authenticates',
  )

  await service.playbackDisconnected({resumeDelivery: true})
  await new Promise<void>(resolve => { setImmediate(resolve) })
  assert.equal(
    actions.includes('inject:queued-during-renderer-disconnect'),
    true,
    'releasing the abandoned hold wakes the real host delivery queue',
  )

  await service.handleEvent({
    kind: 'response_started',
    session_epoch: 1,
    response_id: 'response-after-renderer-reconnect',
  })
  await service.handleEvent({
    kind: 'response_audio_delta',
    session_epoch: 1,
    response_id: 'response-after-renderer-reconnect',
    pcm: new Uint8Array([0, 1]),
  })

  assert.equal(clock.now(), 0, 'recovery does not wait for the 30 second stale-hold deadline')
  assert.notEqual(session.currentGeneration, null)
})

test('renderer disconnect keeps delivery paused while completed audio is still playing', async (t) => {
  const {service, session, actions} = realtimeServiceHarness('pipeline', {parkProviderEvents: true})
  t.after(async () => { await service.close() })
  await service.start()
  await service.handleEvent({
    kind: 'response_started',
    session_epoch: 1,
    response_id: 'completed-before-disconnect',
  })
  await service.handleEvent({
    kind: 'response_audio_delta',
    session_epoch: 1,
    response_id: 'completed-before-disconnect',
    pcm: new Uint8Array([0, 1]),
  })
  await service.handleEvent({
    kind: 'response_terminal',
    session_epoch: 1,
    response_id: 'completed-before-disconnect',
    status: 'completed',
    reason: '',
  })
  assert.notEqual(session.currentGeneration, null)
  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-over-completed-playback',
    provider_item_id: 'user-over-completed-playback',
  })
  service.queueHostItem(hostFact('queued-behind-completed-playback'))
  await new Promise<void>(resolve => { setImmediate(resolve) })

  await service.playbackDisconnected()
  await new Promise<void>(resolve => { setImmediate(resolve) })
  assert.equal(
    actions.includes('inject:queued-behind-completed-playback'),
    false,
    'stopping the old generation does not resume delivery while disconnected',
  )

  await service.playbackDisconnected({resumeDelivery: true})
  await new Promise<void>(resolve => { setImmediate(resolve) })
  assert.equal(
    actions.includes('inject:queued-behind-completed-playback'),
    true,
    'the authenticated replacement resumes the held delivery',
  )
})

test('a late authenticated resume cannot reopen delivery after its renderer disconnects', async (t) => {
  let reportCancelStarted: (() => void) | undefined
  let releaseCancel: (() => void) | undefined
  const cancelStarted = new Promise<void>(resolve => { reportCancelStarted = resolve })
  const cancelReleased = new Promise<void>(resolve => { releaseCancel = resolve })
  const {service, actions} = realtimeServiceHarness('pipeline', {
    parkProviderEvents: true,
    beforeCancelResponse: async () => {
      reportCancelStarted?.()
      await cancelReleased
    },
  })
  t.after(async () => { await service.close() })
  await service.start()
  await service.handleEvent({
    kind: 'response_started',
    session_epoch: 1,
    response_id: 'response-fenced-during-authentication',
  })
  await service.handleEvent({
    kind: 'response_audio_delta',
    session_epoch: 1,
    response_id: 'response-fenced-during-authentication',
    pcm: new Uint8Array([0, 1]),
  })

  const lateResume = service.playbackDisconnected({resumeDelivery: true})
  await cancelStarted
  await service.playbackDisconnected()
  releaseCancel?.()
  await lateResume
  await service.handleEvent({
    kind: 'response_terminal',
    session_epoch: 1,
    response_id: 'response-fenced-during-authentication',
    status: 'cancelled',
    reason: '',
  })
  service.queueHostItem(hostFact('queued-after-reconnect-race'))
  await new Promise<void>(resolve => { setImmediate(resolve) })
  assert.equal(
    actions.includes('inject:queued-after-reconnect-race'),
    false,
    'the later disconnect owns the paused state',
  )

  await service.playbackDisconnected({resumeDelivery: true})
  await new Promise<void>(resolve => { setImmediate(resolve) })
  assert.equal(
    actions.includes('inject:queued-after-reconnect-race'),
    true,
    'only a newer authenticated boundary may resume delivery',
  )
})

test('an authenticated resume releases delivery even when its playback fence fails', async (t) => {
  const fenceFailure = new Error('renderer fence failed')
  const {service, actions} = realtimeServiceHarness('pipeline', {
    parkProviderEvents: true,
    beforeCancelResponse: () => Promise.reject(fenceFailure),
  })
  t.after(async () => { await service.close() })
  await service.start()
  await service.handleEvent({
    kind: 'response_started',
    session_epoch: 1,
    response_id: 'response-with-failing-fence',
  })
  await service.handleEvent({
    kind: 'response_audio_delta',
    session_epoch: 1,
    response_id: 'response-with-failing-fence',
    pcm: new Uint8Array([0, 1]),
  })
  service.queueHostItem(hostFact('queued-behind-failing-fence'))

  await assert.rejects(
    service.playbackDisconnected({resumeDelivery: true}),
    error => error === fenceFailure,
  )
  await service.handleEvent({
    kind: 'response_terminal',
    session_epoch: 1,
    response_id: 'response-with-failing-fence',
    status: 'cancelled',
    reason: '',
  })
  await new Promise<void>(resolve => { setImmediate(resolve) })
  assert.equal(
    actions.includes('inject:queued-behind-failing-fence'),
    true,
    'the authenticated renderer can receive later host work despite the reported fence failure',
  )
})

test('playback stop requeues an acknowledgement when provider cancellation terminates first', async () => {
  let reportCancelStarted: (() => void) | undefined
  let releaseCancel: (() => void) | undefined
  const cancelStarted = new Promise<void>(resolve => {
    reportCancelStarted = resolve
  })
  const cancelReleased = new Promise<void>(resolve => {
    releaseCancel = resolve
  })
  const {service, session} = realtimeServiceHarness('pipeline', {
    beforeCancelResponse: async () => {
      reportCancelStarted?.()
      await cancelReleased
    },
  })
  await service.connect()
  const generation = await openCompletedAcknowledgementPlayback(service, session, false)

  const stopped = service.playbackStopped(
    generation.utterance_id,
    generation.generation_epoch,
    0,
  )
  await cancelStarted
  await service.handleEvent({
    kind: 'user_speech_started', session_epoch: 1,
    speech_id: 'speech-1', provider_item_id: 'user-item-2',
  })
  await service.handleEvent({
    kind: 'response_terminal', session_epoch: 1,
    response_id: 'r-2', status: 'cancelled', reason: 'renderer stopped',
  })
  assert.equal(
    service.deliveryState().acknowledgementPhases['background:d-1'],
    'queued',
    'the terminal event cannot strand the recovered acknowledgement while cancel is pending',
  )

  releaseCancel?.()
  assert.equal(await stopped, true)
  assert.equal(
    service.deliveryState().acknowledgementPhases['background:d-1'],
    'queued',
    'the renderer interruption still makes the unheard acknowledgement eligible for delivery',
  )
})

test('a completed continuation that renderer never played is reopened by a reconnect', async () => {
  const {service, session} = realtimeServiceHarness('pipeline')
  await service.connect()
  await twoTurns(service)
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'user_transcript_final',
    session_epoch: 1,
    item_id: 'user-item-1',
    text: 'compile the runtime',
  })
  await service.handleEvent({
    kind: 'tool_call_ready',
    session_epoch: 1,
    call_id: 'call-1',
    item_id: 'tool-1',
    name: 'codex__run',
    arguments: {work_order: 'compile the runtime'},
    response_id: 'r-1',
  })
  await service.handleEvent({
    kind: 'response_terminal',
    session_epoch: 1,
    response_id: 'r-1',
    status: 'completed',
    reason: '',
  })
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-2'})
  await service.handleEvent({
    kind: 'response_audio_delta',
    session_epoch: 1,
    response_id: 'r-2',
    pcm: new Uint8Array([0, 1]),
  })
  const generation = session.currentGeneration
  assert.notEqual(generation, null)
  assert.equal(
    service.playbackStarted(generation!.utterance_id, generation!.generation_epoch),
    true,
  )
  await service.handleEvent({
    kind: 'response_terminal',
    session_epoch: 1,
    response_id: 'r-2',
    status: 'completed',
    reason: '',
  })
  await service.reconnectForTest()

  assert.equal(
    service.deliveryState().acknowledgementPhases['background:d-1'],
    'queued',
    'the replacement session retains the acknowledgement until it has activation',
  )
  assert.deepEqual(
    service.queuedHostItems().map(item => item.intent.item.event_id),
    ['background:d-1'],
    'provider completion without renderer delivery cannot retire the acknowledgement',
  )
})

test('a preemptive item does not interrupt an idle agent', async () => {
  // There is nothing to interrupt, so it is delivered the ordinary way. Preempting an idle session
  // would cancel a turn that does not exist.
  const {service, actions} = realtimeServiceHarness('guard')
  await service.connect()
  service.queueHostItem(guardFact(), {priority: 90, preemptive: true})
  await service.flushHostItems()
  assert.ok(actions.includes('inject:final:d-guard'), 'delivered')
  assert.equal(
    actions.some(action => action.startsWith('cancel:')),
    false,
    'and nothing was cancelled',
  )
})

test('a preemptive item interrupts a speaking agent, and cancels its turn', async () => {
  const {service, actions} = realtimeServiceHarness('guard')
  await service.connect()
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'response_audio_delta',
    session_epoch: 1,
    response_id: 'r-1',
    pcm: new Uint8Array([0, 1]),
  })
  service.queueHostItem(guardFact(), {priority: 90, preemptive: true})
  await service.flushHostItems()
  assert.ok(actions.includes('cancel:r-1'), 'the old turn was cancelled')
})

test('the alert deadline stops waiting for a provider that will not confirm', async () => {
  // The provider was asked to stop and has not said it did. Past the deadline the host acts as though
  // it had — the alternative is the user hearing the old turn continue while an urgent alert waits.
  const {service, clock} = realtimeServiceHarness('guard')
  await service.connect()
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'response_audio_delta',
    session_epoch: 1,
    response_id: 'r-1',
    pcm: new Uint8Array([0, 1]),
  })
  service.queueHostItem(guardFact(), {priority: 90, preemptive: true})
  await service.flushHostItems()
  assert.notEqual(service.deliveryState().preemptiveAlert, null, 'a preemption is in flight')
  assert.equal(service.deliveryState().preemptiveAlert?.deadline_fired, false)

  // Past the preemptive-alert deadline with no terminal from the provider.
  clock.advanceTo(clock.now() + 1)
  await new Promise<void>(resolve => setTimeout(resolve, 5))
  assert.equal(
    service.deliveryState().preemptiveAlert?.deadline_fired ?? 'cleared',
    true,
    'the host stopped waiting',
  )
})

test('a preemptive monitor policy keeps the 350ms alert deadline after a channel rename', async () => {
  const {service, actions, clock} = realtimeServiceHarness('guard', {
    channel: 'sensor-preemptive',
    priority: 40,
    operationClass: 'monitor',
    alertDelivery: 'preemptive',
  })
  await service.connect()
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'response_audio_delta', session_epoch: 1, response_id: 'r-1', pcm: new Uint8Array([0, 1]),
  })
  service.projectRuntimeEvent({
    kind: 'observation',
    seq: 1,
    ts: 1,
    payload: {
      channel: 'sensor-preemptive', delegate_id: 'd-alert', op: 'start', origin_ref: 'conversation:1',
      trust: 'untrusted_external', content: {hit: true, observation: 'the kettle is boiling'}, refs: [],
    },
  })
  await service.flushHostItems()
  assert.ok(actions.includes('cancel:r-1'), 'the policy, not priority or channel name, authorizes preemption')
  clock.advanceTo(clock.now() + 1)
  await new Promise<void>(resolve => setTimeout(resolve, 5))
  assert.equal(service.deliveryState().preemptiveAlert?.deadline_fired ?? 'cleared', true)
})

test('a user speaking revokes the reconnect permit a preemption was holding', async () => {
  // The preemption borrows the user's authority to interrupt. Once the user is speaking themselves,
  // that authority is theirs again — so a permit not yet spent is disallowed outright.
  const {service} = realtimeServiceHarness('guard', {controlledReconnect: true})
  await service.connect()
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'response_audio_delta',
    session_epoch: 1,
    response_id: 'r-1',
    pcm: new Uint8Array([0, 1]),
  })
  service.queueHostItem(guardFact(), {priority: 90, preemptive: true})
  await service.flushHostItems()
  assert.equal(service.deliveryState().preemptiveAlert?.reconnect_disallowed, false)

  await service.handleEvent({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: 'user-item-1',
  })
  assert.equal(
    service.deliveryState().preemptiveAlert?.reconnect_disallowed,
    true,
    'the permit is revoked before it can be spent',
  )
})

test('a cancel rejection does nothing when controlled reconnect is off', async () => {
  const {service, actions} = realtimeServiceHarness('guard', {controlledReconnect: false})
  await service.connect()
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'response_audio_delta',
    session_epoch: 1,
    response_id: 'r-1',
    pcm: new Uint8Array([0, 1]),
  })
  service.queueHostItem(guardFact(), {priority: 90, preemptive: true})
  await service.flushHostItems()
  const connects = actions.filter(action => action.startsWith('connect:')).length
  await service.handleEvent({
    kind: 'response_cancel_rejected',
    session_epoch: 1,
    response_id: 'r-1',
    cancel_request_id: 'cancel-1',
    reason: 'no_active_response',
  })
  assert.equal(
    actions.filter(action => action.startsWith('connect:')).length,
    connects,
    'no reconnect: the gate is closed',
  )
  assert.equal(service.stopped, false)
})

test('a cancel rejection with the gate open replaces the provider session', async () => {
  // The last resort: the provider said it would not stop, and the alert is still waiting. Replacing the
  // session is heavy, which is why it is gated — but letting the old turn run to completion is worse.
  const {service, actions} = realtimeServiceHarness('guard', {controlledReconnect: true})
  await service.connect()
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'response_audio_delta',
    session_epoch: 1,
    response_id: 'r-1',
    pcm: new Uint8Array([0, 1]),
  })
  service.queueHostItem(guardFact(), {priority: 90, preemptive: true})
  await service.flushHostItems()
  const before = actions.filter(action => action.startsWith('connect:')).length
  await service.handleEvent({
    kind: 'response_cancel_rejected',
    session_epoch: 1,
    response_id: 'r-1',
    cancel_request_id: 'cancel-1',
    reason: 'no_active_response',
  })
  assert.ok(
    actions.filter(action => action.startsWith('connect:')).length > before,
    'the session was replaced',
  )
  assert.equal(service.deliveryState().preemptiveAlert?.reconnect_permit_consumed, true, 'permit spent')
})

test('Guard recovery telemetry counts Python code points in astral history', async () => {
  const {service, telemetry} = realtimeServiceHarness('guard', {
    controlledReconnect: true,
    recoveryTexts: ['😀', 'A😀'],
  })
  await service.connect()
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'response_audio_delta',
    session_epoch: 1,
    response_id: 'r-1',
    pcm: new Uint8Array([0, 1]),
  })
  service.queueHostItem(guardFact(), {priority: 90, preemptive: true})
  await service.flushHostItems()
  await service.handleEvent({
    kind: 'response_cancel_rejected',
    session_epoch: 1,
    response_id: 'r-1',
    cancel_request_id: 'cancel-1',
    reason: 'no_active_response',
  })
  const recovery = telemetry.find(item => item.kind === 'guard.history_recovery')
  assert.equal(recovery?.payload.character_count, 3)
})

test('a cancel rejection for a turn that already spoke is ignored', async () => {
  // Replacing the session under it would lose whatever it said to the user.
  const {service, actions} = realtimeServiceHarness('guard', {controlledReconnect: true})
  await service.connect()
  service.queueHostItem(guardFact('final:d-other'), {priority: 50})
  await service.flushHostItems()
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({
    kind: 'response_audio_delta',
    session_epoch: 1,
    response_id: 'r-1',
    pcm: new Uint8Array([0, 1]),
  })
  service.queueHostItem(guardFact(), {priority: 90, preemptive: true})
  await service.flushHostItems()
  const before = actions.filter(action => action.startsWith('connect:')).length
  // r-1 carries the delivered fact's event id, so it has produced something.
  await service.handleEvent({
    kind: 'response_cancel_rejected',
    session_epoch: 1,
    response_id: 'r-1',
    cancel_request_id: 'cancel-1',
    reason: 'no_active_response',
  })
  assert.equal(
    actions.filter(action => action.startsWith('connect:')).length,
    before,
    'a turn that already spoke is not replaced under',
  )
})

test('Guard history flush occurs after the reconnect lock and gates its new provider', async () => {
  const {service, actions} = realtimeServiceHarness('guard', {controlledReconnect: true, recoveryTexts: ['old user', 'old assistant']})
  let releaseLock!: () => void
  let enteredLock!: () => void
  let releaseFlush!: () => void
  let enteredFlush!: () => void
  let flushCalls = 0
  const lockGate = new Promise<void>(resolve => { releaseLock = resolve })
  const lockEntered = new Promise<void>(resolve => { enteredLock = resolve })
  const flushGate = new Promise<void>(resolve => { releaseFlush = resolve })
  const flushEntered = new Promise<void>(resolve => { enteredFlush = resolve })
  Object.defineProperty(service.internals.runtime, 'flushMemory', {value: () => {
    flushCalls += 1
    enteredFlush()
    return flushGate
  }})
  await service.connect()
  await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'r-1'})
  await service.handleEvent({kind: 'response_audio_delta', session_epoch: 1, response_id: 'r-1', pcm: new Uint8Array([0, 1])})
  service.queueHostItem(guardFact(), {priority: 90, preemptive: true})
  await service.flushHostItems()
  const holding = service.internals.reconnectLock.run(async () => { enteredLock(); await lockGate })
  await lockEntered
  const handling = service.handleEvent({kind: 'response_cancel_rejected', session_epoch: 1, response_id: 'r-1',
    cancel_request_id: 'cancel-1', reason: 'no_active_response'})
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(flushCalls, 0, 'a flush before waiting for the lock cannot protect the later snapshot')
    releaseLock()
    await flushEntered
    assert.equal(actions.includes('connect:2'), false)
    releaseFlush()
    await handling
    assert.equal(actions.includes('connect:2'), true)
    assert.equal(flushCalls, 1)
  } finally { releaseLock(); releaseFlush(); await holding; await handling; await service.close() }
})

for (const scenario of deliveryPassScenarios) {
  test(`delivery-pass fixture: ${scenario.name}`, async (t) => {
    const {service, clock, actions} = realtimeServiceHarness('pipeline')
    t.after(() => service.close())
    await service.connect()
    const initial = service.deliveryState()
    for (const step of scenario.steps) {
      switch (step.event) {
        case 'queue': service.queueHostItem(hostFact('fixture')); break
        case 'flush': await service.flushHostItems(); break
        case 'response': await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'fixture-response'}); break
        case 'terminal': await finishProviderResponse(service, 'fixture-response'); break
        case 'speech': await service.handleEvent({kind: 'user_speech_started', session_epoch: 1, speech_id: 'fixture-speech', provider_item_id: 'fixture-user'}); break
        case 'at-deadline': clock.advanceTo(30); await service.flushHostItems(); break
        case 'past-deadline': clock.advanceTo(30.001); await service.flushHostItems(); break
        case 'disconnect': await service.playbackDisconnected(); break
        case 'resume': await service.playbackDisconnected({resumeDelivery: true}); await service.flushHostItems(); break
      }
      const state = service.deliveryState()
      assert.deepEqual({queued: state.queuedEventIds, floor: state.floor, idle: state.foregroundIdle, paused: state.rendererPaused},
        {queued: step.queued, floor: step.floor, idle: step.idle, paused: 'paused' in step && step.paused}, step.event)
    }
    assert.deepEqual(initial.queuedEventIds, [], 'an earlier snapshot stays detached')
    assert.equal(actions.filter(action => action === 'inject:fixture').length, 1, 'exactly one host injection')
  })
}

test('delivery-pass fixture: urgent preempt cancels once and snapshots cannot mutate its owner', async (t) => {
  const {service, actions} = realtimeServiceHarness('guard')
  t.after(() => service.close())
  await service.connect()
  for (const step of [
    {event: 'response', queued: [], armed: null, cancel: false},
    {event: 'queue', queued: ['final:d-guard'], armed: 90, cancel: false},
    {event: 'flush', queued: ['final:d-guard'], armed: 90, cancel: true},
    {event: 'flush', queued: ['final:d-guard'], armed: 90, cancel: true},
  ] as const) {
    if (step.event === 'response') {
      await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'fixture-response'})
      await service.handleEvent({kind: 'response_audio_delta', session_epoch: 1, response_id: 'fixture-response', pcm: new Uint8Array([0, 1])})
    } else if (step.event === 'queue') service.queueHostItem(guardFact(), {priority: 90, preemptive: true})
    else await service.flushHostItems()
    const state = service.deliveryState()
    assert.deepEqual({queued: state.queuedEventIds, armed: state.armedPreemptPriority, cancel: state.preemptiveAlert?.cancel_sent ?? false},
      {queued: step.queued, armed: step.armed, cancel: step.cancel}, step.event)
  }
  const snapshot = service.deliveryState()
  const before = structuredClone(snapshot)
  ;(snapshot.queuedEventIds as string[]).push('tampered')
  Object.assign(snapshot.preemptiveAlert!, {cancel_sent: false})
  Object.assign(snapshot.preemptiveAlert!.old_generation!, {response_id: 'tampered'})
  assert.deepEqual(service.deliveryState(), before)
  assert.equal(actions.filter(action => action === 'cancel:fixture-response').length, 1)
})

test('delivery-pass fixture: requested user response reserves the provider before queued host work', async (t) => {
  const {service, actions} = realtimeServiceHarness('pipeline', {userResponseMode: 'requested'})
  t.after(() => service.close())
  await service.connect()
  await service.handleEvent({kind: 'user_speech_started', session_epoch: 1, speech_id: 'fixture-speech', provider_item_id: 'fixture-user'})
  await service.handleEvent({kind: 'user_speech_ended', session_epoch: 1, speech_id: 'fixture-speech', provider_item_id: 'fixture-user'})
  service.queueHostItem(hostFact('fixture'))
  await service.handleEvent({kind: 'user_transcript_final', session_epoch: 1, item_id: 'fixture-user', text: 'hello'})
  await service.flushHostItems()
  const state = service.deliveryState()
  assert.equal(state.userResponseMode, 'requested')
  assert.equal(state.providerIdle, false)
  assert.deepEqual(state.queuedEventIds, ['fixture'])
  assert.equal(actions.filter(action => action === 'ensure_response').length, 1)
  assert.equal(actions.includes('inject:fixture'), false)
})

test('coding final narration carries only its correlated work order as task context', () => {
  const {service} = realtimeServiceHarness('projection', {
    delegateOverride: {request: {work_order: '列出已有文件，不修改它们。'}},
  })
  service.projectRuntimeEvent({kind: 'handoff', seq: 1, ts: 1, payload: {
    channel: 'codex', delegate_id: 'd-1', origin_ref: 'conversation:1', outcome: 'ok',
    trust: 'untrusted_external', content: {result: {final_message: {text: 'a.txt b.txt'}}}, refs: [],
  }})
  const content = service.queuedHostItems()[0]?.intent.item.content ?? ''
  assert.ok(content.includes('a.txt b.txt'))
  assert.ok(content.includes('列出已有文件，不修改它们。'))
  assert.ok(content.includes('不是执行结果'))
})
