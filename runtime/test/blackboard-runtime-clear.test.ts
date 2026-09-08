import assert from 'node:assert/strict'
import {test} from 'node:test'
import {MonotonicIdFactory, ScriptedIdFactory} from '../src/ids.js'
import {handoffPolicySchema} from '../src/memory.js'
import {executorManifestSchema, fastBrainOutputSchema} from '../src/ports.js'
import {CoreRuntime, type ModelCall} from '../src/runtime.js'

const manifest = executorManifestSchema.parse({
  name: 'worker', display_name: 'worker', probe_policy: 'readonly_ops',
  policy: handoffPolicySchema.parse({channel: 'worker', priority: 50, wake: 'fast', typical_latency: 5, compress_watermark: 8}),
  ops: [{name: 'read', description: 'read', params: {type: 'object', properties: {}, additionalProperties: false}, readonly: true, deadline_budget: 5}],
})

function dispatch(runtime: CoreRuntime): void {
  const user = runtime.post({kind: 'user_input', payload: {text: 'old request'}}, 0)
  const reason = runtime.apply(runtime.queue.popReady(0)!)
  assert.notEqual(reason, null)
  runtime.consumeFastBrain(fastBrainOutputSchema.parse({
    speak: {act: 'none'},
    action: {act: 'delegate', delegate: {executor: 'worker', op: 'read', request: {}, origin_ref: 'conversation:1'}},
  }), reason!, user.seq)
}

test('conversation reset frees model state and drops old nonterminal work without reusing its epoch', () => {
  const calls: ModelCall[] = []
  const runtime = new CoreRuntime({
    manifests: [], ids: new MonotonicIdFactory(), modelSlots: ['fast'], onModelCall: call => calls.push(call),
  })
  const input = runtime.post({kind: 'user_input', payload: {text: 'old context'}}, 0)
  runtime.apply(runtime.queue.popReady(0)!)
  const call = calls[0]!
  runtime.suggestions.add({origin: 'fast_brain', kind: 'notify', content: {text: 'old suggestion'}})
  const staleSpeech = runtime.post({kind: 'assistant_spoken', payload: {
    text: 'late old audio', utterance_id: 'old-audio', delivery: 'spoken', played_ms: 1,
  }}, 1)

  runtime.resetConversationState()

  assert.equal(runtime.conversationEpoch, 1)
  assert.equal(runtime.slots.inflight.fast, false)
  assert.equal(runtime.slots.pending.fast, null)
  assert.equal(runtime.slots.activeJobId.fast, null)
  assert.deepEqual(runtime.suggestions.all(), [])
  assert.equal(runtime.openFloor(call.job_id, call.utterance_id!, 100, 1), false)
  assert.equal(runtime.isCurrentConversationEvent(input), false)
  assert.equal(runtime.isCurrentConversationEvent(staleSpeech), false)
  assert.equal(runtime.queue.size, 0)
})

test('old executor terminal events settle control but never repopulate a cleared conversation', () => {
  const runtime = new CoreRuntime({manifests: [manifest], ids: new ScriptedIdFactory({delegate: ['old-task']})})
  dispatch(runtime)
  assert.equal(runtime.activeDelegates().length, 1)

  runtime.resetConversationState()
  const progress = runtime.postExecutorProgress(0, {
    phase: 'working', internal_activity: 1, elapsed: 1, summary: 'old private progress',
  }, 1)
  const observation = runtime.postExecutorObservation(0, {
    trust: 'trusted_system', content: {hit: true, text: 'old observation'}, refs: [],
  }, 1)
  const handoff = runtime.postExecutorCompletion(0, {
    outcome: 'ok', trust: 'trusted_system', content: {text: 'old terminal body'}, refs: [],
  }, 1)
  assert.equal(runtime.isCurrentConversationEvent(progress), false)
  assert.equal(runtime.isCurrentConversationEvent(observation), false)
  assert.equal(runtime.isCurrentConversationEvent(handoff), false)

  for (;;) {
    const event = runtime.queue.popReady(1)
    if (event === undefined) break
    runtime.apply(event)
  }
  assert.equal(runtime.activeDelegates().length, 0)
  assert.equal(runtime.claimedHandoff(handoff.seq)?.delegate_id, 'old-task')
  assert.deepEqual(runtime.memory.channels.get('worker')!.items, [])
  assert.equal(runtime.appliedEvents.some(event => event === handoff), false)

  const current = runtime.post({kind: 'user_input', payload: {text: 'new request'}}, 2)
  assert.equal(runtime.isCurrentConversationEvent(current), true)
  runtime.apply(runtime.queue.popReady(2)!)
  assert.equal(runtime.memory.channels.get('conversation')!.items.at(-1)?.content.text, 'new request')
})

test('new model context excludes an old running delegate while execution control retains it', () => {
  const calls: ModelCall[] = []
  const runtime = new CoreRuntime({
    manifests: [manifest], ids: new ScriptedIdFactory({delegate: ['old-task']}), modelSlots: ['fast'],
    onModelCall: call => calls.push(call),
  })
  dispatch(runtime)
  assert.equal(runtime.activeDelegates().length, 1)

  runtime.resetConversationState()
  runtime.memory.clear()
  runtime.post({kind: 'user_input', payload: {text: 'new context'}}, 1)
  runtime.apply(runtime.queue.popReady(1)!)
  const current = calls.at(-1)!
  const refreshed = runtime.refreshModelCall(current)
  assert.equal(runtime.activeDelegates().length, 1)
  assert.deepEqual(current.context_view?.in_flight, [])
  assert.deepEqual(refreshed.context_view?.in_flight, [])
  assert.doesNotMatch(JSON.stringify(refreshed.context_view), /old-task|old request/u)
})

test('old deadline then definitive handoff settles executor control without restoring its body', () => {
  const runtime = new CoreRuntime({manifests: [manifest], ids: new ScriptedIdFactory({delegate: ['old-task']})})
  dispatch(runtime)
  runtime.resetConversationState()

  const deadline = runtime.queue.popReady(5)!
  assert.equal(deadline.kind, 'deadline')
  runtime.apply(deadline)
  assert.equal(runtime.activeDelegates().length, 0)
  assert.equal(runtime.terminatedByDeadline(deadline.seq, 'old-task'), true)

  const handoff = runtime.postExecutorCompletion(0, {
    outcome: 'ok', trust: 'trusted_system', content: {text: 'late old terminal'}, refs: [],
  }, 6)
  runtime.apply(runtime.queue.popReady(6)!)
  assert.equal(runtime.claimedHandoff(handoff.seq)?.delegate_id, 'old-task')
  assert.deepEqual(runtime.memory.channels.get('worker')!.items, [])
})
