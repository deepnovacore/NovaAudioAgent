import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp, realpath, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {BlackboardStore} from '../src/memory/blackboard-store.js'
import {Memory, memoryItemSchema} from '../src/memory.js'
import {CoreRuntime} from '../src/runtime.js'
import {MonotonicIdFactory} from '../src/ids.js'
import {executorManifestSchema} from '../src/ports.js'
import {wakeReasonSchema} from '../src/slots.js'
import {compileContextView} from '../src/context-view.js'
import {renderContextSnapshot} from '../src/prompting.js'
import {compileMemoryRecall, conversationCutoff, encodeMemoryRecall} from '../src/realtime/recall.js'
import {memoryBoardMessage} from '../src/realtime/memory-board.js'

const manifest = executorManifestSchema.parse({
  name: 'worker', display_name: 'worker', probe_policy: 'readonly_ops',
  policy: {channel: 'worker', priority: 50, wake: 'none', typical_latency: 1, compress_watermark: 40},
  ops: [{name: 'read', description: 'read', params: {}, readonly: true, deadline_budget: 5}],
})
const reason = wakeReasonSchema.parse({kind: 'realtime_tool', priority: 100, routing_class: 'user_awaited'})
const record = (channel: string, seq: number, ts: number, text: string) => memoryItemSchema.parse({
  channel, seq, ts, trust: channel === 'conversation' ? 'trusted_user' : 'trusted_system',
  priority: 100, content: channel === 'conversation' ? {text} : {summary: text},
  outcome: channel === 'conversation' ? null : 'unknown',
})

test('reopened blackboard restores context without restarting work or reusing historical authority', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-recovery-'))
  const options = {path: join(directory, 'board.sqlite'), ownerId: 'local', conversationId: 'one',
    channels: ['conversation', 'worker', 'retired']}
  let store = new BlackboardStore(options)
  try {
    const {generation} = await store.open()
    await store.commit({generation, revision: 1, mutations: [
      {kind: 'append', item: record('conversation', 1, 9000, 'project old milestone')},
      {kind: 'append', item: record('worker', 1, 1, 'project newer result')},
      {kind: 'append', item: record('retired', 1, 5000, 'project retired observation')},
      {kind: 'summary', channel: 'conversation', text: 'project summary', throughSequence: 1, retentionRevision: 0},
    ]})
    await store.close()
    store = new BlackboardStore(options)
    const snapshot = await store.open()
    let launches = 0
    const runtime = new CoreRuntime({manifests: [manifest], ids: new MonotonicIdFactory(),
      recovery: snapshot.channels, onExecutorDispatch: () => { launches += 1 }, onModelCall: () => { launches += 1 }})
    const view = compileContextView(runtime.memory, runtime.floor.state, 2, {manifests: [manifest]})
    assert.equal(launches, 0)
    assert.deepEqual(view.in_flight, [])
    assert.deepEqual(view.affordances, [], 'old unknowns cannot trigger probes or fresh channel updates')
    assert.equal(view.channels.find(channel => channel.name === 'conversation')?.summary, 'project summary')
    assert.match(renderContextSnapshot(view), /历史记录/u)
    assert.equal(runtime.memory.policies.has('retired'), false)
    assert.throws(() => runtime.memory.append('retired', {ts: 2, trust: 'trusted_system', priority: 1, content: {}}), /read-only/u)
    assert.throws(() => conversationCutoff(runtime.memory, 'conversation:1'))
    const current = runtime.memory.append('conversation', {ts: 0.1, trust: 'trusted_user', priority: 100,
      content: {text: 'project current milestone'}})
    assert.equal(current.seq, 2)
    runtime.memory.append('conversation', {ts: 0.2, trust: 'trusted_user', priority: 100, content: {text: 'recall'}})
    const recall = compileMemoryRecall(runtime.memory, {query: 'unmatchedzzzz', scope: 'any', beforeRef: 'conversation:3'})
    assert.deepEqual(recall.hits.slice(0, 4).map(hit => hit.ref), ['conversation:2', 'retired:1', 'worker:1', 'conversation:1'])
    const encoded = JSON.parse(encodeMemoryRecall(recall)) as {hits: {historical?: boolean; recorded_at_ms?: number}[]}
    assert.throws(() => encodeMemoryRecall({...recall, hits: [{...recall.hits[0]!, historical: true}]}), /recorded_at_ms/u)
    assert.equal(encoded.hits[0]?.historical, undefined)
    assert.equal(encoded.hits[1]?.historical, true)
    assert.ok((encoded.hits[1]?.recorded_at_ms ?? 0) > 0)
    const board = JSON.parse(memoryBoardMessage('recovery', runtime.memory)) as {
      channels: {name: string; historical_through_seq?: number; items: {seq: number; historical?: boolean; recorded_at_ms?: number}[]}[]
    }
    const old = board.channels.find(channel => channel.name === 'conversation')!.items[0]!
    assert.equal(old.historical, true)
    assert.equal(board.channels.find(channel => channel.name === 'conversation')!.historical_through_seq, 1)
    assert.ok(old.recorded_at_ms! > 0)
    for (const origin_ref of ['conversation:1', 'worker:1']) {
      const admission = runtime.dispatchExternal({executor: 'worker', op: 'read', request: {}, origin_ref}, reason)
      assert.equal(admission.accepted, false)
      assert.equal(admission.problem, 'historical_origin')
    }
    const admission = runtime.dispatchExternal({executor: 'worker', op: 'read', request: {}, origin_ref: 'conversation:2'}, reason)
    assert.equal(admission.accepted, true)
    assert.equal(launches, 1)
  } finally { await store.close(); await rm(directory, {recursive: true, force: true}) }
})

test('empty recovered channels preserve high water and reject malformed recovery', () => {
  const recovery = {name: 'conversation', highWater: 9, retentionRevision: 3, summary: null, items: []}
  const memory = new Memory({recovery: [recovery]})
  assert.equal(memory.append('conversation', {ts: 0, trust: 'trusted_user', priority: 100, content: {}}).seq, 10)
  assert.equal(memory.channels.get('conversation')!.retentionRevision, 3)
  assert.throws(() => new Memory({recovery: [recovery, recovery]}), /duplicate/u)
  assert.throws(() => new Memory({recovery: [{...recovery, items: [{item: record('other', 1, 1, 'wrong scope'), recordedAtMs: 1, ordinal: 1}]}]}))
})
