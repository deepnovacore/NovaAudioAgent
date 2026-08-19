import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  NO_ACTION,
  runFastBrainCall,
  runSurrogateCall,
  type CallRecord,
  type SpeechSink,
} from '../src/calls.js'
import type { Affordance, ContextView } from '../src/context-view.js'
import type { FastBrainDelta } from '../src/model-adapters.js'
import { wakeReasonSchema } from '../src/slots.js'

const view: ContextView = {
  structured: {
    intent: {objective_hypothesis: '', constraints: [], unresolved_questions: [],
      uncertainty: 0.5, revision: 0},
    goal: {objective: '', acceptance_criteria: [], status: 'unset', revision: 0},
    authorization: {allow: [], deny: [], evidence_refs: [], revision: 0},
  },
  channels: [],
  in_flight: [],
  affordances: [
    {source: 'suggestion', ref: 's-1', content: {kind: 'notify'}, conclusive: null},
    {source: 'unresolved_question', ref: 'q-1', content: {question: '?'}, conclusive: null},
    {source: 'suggestion', ref: 's-2', content: {kind: 'question'}, conclusive: null},
  ],
  floor: 'idle',
  now: 1,
  trigger_kind: 'user_input',
}

const reason = wakeReasonSchema.parse({kind: 'user_input', priority: 100})

interface Recorder extends SpeechSink {
  readonly emitted: string[]
  readonly ended: string[]
}

function recorder(): Recorder {
  const emitted: string[] = []
  const ended: string[] = []
  return {
    emitted,
    ended,
    emit(utteranceId, text) { emitted.push(`${utteranceId}:${text}`) },
    end(utteranceId) { ended.push(utteranceId) },
  }
}

function scripted(deltas: readonly FastBrainDelta[]) {
  return {
    async *call(): AsyncIterable<FastBrainDelta> {
      for (const delta of deltas) {
        await Promise.resolve()
        yield delta
      }
    },
  }
}

async function run(
  deltas: readonly FastBrainDelta[],
  allow: boolean,
  sink: Recorder,
  openCalls: {utteranceId: string, priority: number}[] = [],
): Promise<CallRecord> {
  return runFastBrainCall(scripted(deltas), {
    view,
    reason,
    utteranceId: 'u-1',
    sink,
    openFloor: (utteranceId, priority) => {
      openCalls.push({utteranceId, priority})
      return allow
    },
    closeFloor: () => undefined,
  })
}

test('the Floor is consulted at the first non-empty chunk, exactly once', async () => {
  const sink = recorder()
  const openCalls: {utteranceId: string, priority: number}[] = []
  const record = await run([
    {kind: 'text', text: ''},
    {kind: 'text', text: '你'},
    {kind: 'text', text: '好'},
  ], true, sink, openCalls)

  // An empty first chunk must not burn a Floor turn.
  assert.deepEqual(openCalls, [{utteranceId: 'u-1', priority: 100}])
  assert.deepEqual(sink.emitted, ['u-1:你', 'u-1:好'])
  assert.deepEqual(sink.ended, ['u-1'])
  assert.equal(record.spoken_text, '你好')
  assert.equal(record.deferred, false)
})

test('a call with no text at all never consults the Floor', async () => {
  const sink = recorder()
  const openCalls: {utteranceId: string, priority: number}[] = []
  const record = await run([
    {kind: 'text', text: ''},
    {kind: 'action', action: {act: 'update', update: {target: 'intent', delta: {revision: 1}}}},
  ], true, sink, openCalls)

  // A (none, update) turn must not burn a Floor turn, and preempt must not fire.
  assert.deepEqual(openCalls, [])
  assert.deepEqual(sink.emitted, [])
  assert.deepEqual(sink.ended, [])
  assert.equal(record.spoken_text, '')
  assert.equal(record.deferred, false, 'no speech is not the same as deferred speech')
})

test('a deferred utterance is collected in full but never reaches the sink', async () => {
  const sink = recorder()
  const record = await run([
    {kind: 'text', text: '被'},
    {kind: 'text', text: '压下'},
    {kind: 'action', action: {act: 'delegate', delegate: {
      executor: 'slow_sim', op: 'peek', request: {}, origin_ref: 'conversation:1',
    }}},
  ], false, sink)

  assert.deepEqual(sink.emitted, [], 'a deferred utterance is not voiced')
  assert.deepEqual(sink.ended, [], 'and its utterance is never ended')
  assert.equal(record.spoken_text, '被压下', 'but the pool needs the whole text')
  assert.equal(record.deferred, true)
  // Defer decides the speech axis only; the action must survive.
  assert.equal(record.action.act, 'delegate')
})

test('every action is kept and the surplus is counted, not overwritten', async () => {
  const sink = recorder()
  const first = {act: 'delegate' as const, delegate: {
    executor: 'slow_sim', op: 'peek', request: {room: '客厅'}, origin_ref: 'conversation:1',
  }}
  const second = {act: 'delegate' as const, delegate: {
    executor: 'slow_sim', op: 'peek', request: {room: '卧室'}, origin_ref: 'conversation:1',
  }}
  const record = await run([
    {kind: 'action', action: first},
    {kind: 'action', action: second},
  ], true, sink)

  // Overwriting would have silently dropped the living-room half of the request.
  assert.deepEqual(record.action, first)
  assert.equal(record.extra_actions, 1)
})

test('contract failures are collected without their payloads and do not stop the call',
  async () => {
    const sink = recorder()
    const record = await run([
      {kind: 'contract_failure', code: 'unknown_tool', tool_name: 'nope__missing'},
      {kind: 'text', text: '仍然说话'},
      {kind: 'contract_failure', code: 'invalid_tool_arguments', tool_name: 'codex__run'},
    ], true, sink)

    assert.deepEqual(record.contract_failures, [
      {code: 'unknown_tool', tool_name: 'nope__missing'},
      {code: 'invalid_tool_arguments', tool_name: 'codex__run'},
    ])
    assert.equal(record.spoken_text, '仍然说话')
    assert.equal(record.action, NO_ACTION)
  })

test('a call with no action reports the singular none action', async () => {
  const sink = recorder()
  const record = await run([{kind: 'text', text: '只说话'}], true, sink)
  assert.equal(record.action, NO_ACTION)
  assert.equal(record.extra_actions, 0)
  assert.equal(record.speak_act, 'say', 'an untagged utterance is a statement')
})

test('the Surrogate records the suggestion table it actually saw', async () => {
  const record = await runSurrogateCall({
    watch: () => Promise.resolve({speak: true, suggestion_id: 's-2', reason: '因为'}),
  }, {view, reason, trigger: {
    suggestion_id: 's-2', delegate_id: 'd-1', channel: 'codex', memory_ref: 'codex:3',
  }})

  // Only suggestion affordances, in view order, and no non-suggestion refs.
  assert.deepEqual(record.offered, ['s-1', 's-2'])
  assert.equal(record.output.suggestion_id, 's-2')
  assert.equal(record.trigger?.delegate_id, 'd-1')
  assert.equal(record.reason, reason)
})

test('the Surrogate table is captured before the call, not after it', async () => {
  // A suggestion that rearms mid-flight must not appear in `offered`, otherwise a
  // selection the Surrogate never saw would pass the core check.
  const affordances: Affordance[] = [...view.affordances]
  const mutable: ContextView = {...view, affordances}
  const record = await runSurrogateCall({
    watch: () => {
      affordances.push({
        source: 'suggestion', ref: 's-3-arrived-late', content: {}, conclusive: null,
      })
      return Promise.resolve({speak: false, suggestion_id: null, reason: 'no'})
    },
  }, {view: mutable, reason})

  assert.deepEqual(record.offered, ['s-1', 's-2'])
  assert.ok(!record.offered.includes('s-3-arrived-late'))
})

/** Records Floor traffic so a stranded reservation is visible. */
function floorRecorder() {
  const opened: string[] = []
  const closed: string[] = []
  return {
    opened,
    closed,
    openFloor: (utteranceId: string) => { opened.push(utteranceId); return true },
    closeFloor: (utteranceId: string) => { closed.push(utteranceId) },
  }
}

test('a throwing sink still releases the Floor and preserves the cause', async () => {
  // Once speak_start is posted and the Floor reserved, a stranded reservation makes every
  // later equal-or-lower-priority utterance defer forever against a stale utterance.
  const floor = floorRecorder()
  const boom = new Error('transport died mid-utterance')
  await assert.rejects(runFastBrainCall(scripted([
    {kind: 'text', text: '第一块'},
    {kind: 'text', text: '第二块'},
  ]), {
    view,
    reason,
    utteranceId: 'u-1',
    sink: {emit: () => { throw boom }, end: () => undefined},
    openFloor: floor.openFloor,
    closeFloor: floor.closeFloor,
  }), (error: unknown) => error === boom)

  assert.deepEqual(floor.opened, ['u-1'])
  assert.deepEqual(floor.closed, ['u-1'], 'the reservation must not be stranded')
})

test('a sink whose end throws still releases the Floor', async () => {
  const floor = floorRecorder()
  const boom = new Error('end failed')
  await assert.rejects(runFastBrainCall(scripted([{kind: 'text', text: '话'}]), {
    view,
    reason,
    utteranceId: 'u-2',
    sink: {emit: () => undefined, end: () => { throw boom }},
    openFloor: floor.openFloor,
    closeFloor: floor.closeFloor,
  }), (error: unknown) => error === boom)
  assert.deepEqual(floor.closed, ['u-2'])
})

test('a stream that rejects after the first chunk still releases the Floor', async () => {
  const floor = floorRecorder()
  const boom = new Error('provider hung up')
  const failing = {
    async *call(): AsyncIterable<FastBrainDelta> {
      await Promise.resolve()
      yield {kind: 'text', text: '开头'}
      throw boom
    },
  }
  await assert.rejects(runFastBrainCall(failing, {
    view,
    reason,
    utteranceId: 'u-3',
    sink: {emit: () => undefined, end: () => undefined},
    openFloor: floor.openFloor,
    closeFloor: floor.closeFloor,
  }), (error: unknown) => error === boom)
  assert.deepEqual(floor.closed, ['u-3'])
})

test('a failure before any text never opens or closes the Floor', async () => {
  const floor = floorRecorder()
  const failing = {
    async *call(): AsyncIterable<FastBrainDelta> {
      await Promise.resolve()
      throw new Error('died before speaking')
    },
  }
  await assert.rejects(runFastBrainCall(failing, {
    view,
    reason,
    utteranceId: 'u-4',
    sink: {emit: () => undefined, end: () => undefined},
    openFloor: floor.openFloor,
    closeFloor: floor.closeFloor,
  }))
  assert.deepEqual(floor.opened, [])
  assert.deepEqual(floor.closed, [], 'nothing to release when nothing was reserved')
})

test('a deferred utterance releases nothing, because it reserved nothing', async () => {
  const opened: string[] = []
  const closed: string[] = []
  await runFastBrainCall(scripted([{kind: 'text', text: '被压下'}]), {
    view,
    reason,
    utteranceId: 'u-5',
    sink: {emit: () => { throw new Error('a deferred utterance must not be emitted') },
      end: () => undefined},
    openFloor: utteranceId => { opened.push(utteranceId); return false },
    closeFloor: utteranceId => { closed.push(utteranceId) },
  })
  assert.deepEqual(opened, ['u-5'])
  assert.deepEqual(closed, [])
})

test('a Floor release that itself fails does not mask the original cause', async () => {
  const boom = new Error('the real problem')
  await assert.rejects(runFastBrainCall(scripted([{kind: 'text', text: '话'}]), {
    view,
    reason,
    utteranceId: 'u-6',
    sink: {emit: () => { throw boom }, end: () => undefined},
    openFloor: () => true,
    closeFloor: () => { throw new Error('release also failed') },
  }), (error: unknown) => error === boom)
})
