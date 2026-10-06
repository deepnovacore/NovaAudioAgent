import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compileContextView, FRESH_WINDOW } from '../src/core/context-view.js'
import {
  CONVERSATION_CHANNEL,
  Memory,
  handoffPolicySchema,
} from '../src/core/memory.js'
import { delegateSchema, executorManifestSchema } from '../src/core/ports.js'
import {renderContextView} from '../src/model/prompting.js'
import { SuggestionPool } from '../src/core/suggestions.js'
const slowPolicy = handoffPolicySchema.parse({
  channel: 'slow_sim',
  priority: 50,
  wake: 'fast',
  typical_latency: 5,
  compress_watermark: 8,
})

function loadedMemory(): Memory {
  const memory = new Memory({policies: [slowPolicy]})
  memory.append(CONVERSATION_CHANNEL, {
    ts: 0,
    trust: 'trusted_user',
    priority: 100,
    content: {text: 'dim the living-room light'},
  })
  memory.append('slow_sim', {
    ts: 5,
    trust: 'trusted_system',
    priority: 50,
    content: {room: 'living room', brightness: 30},
    outcome: 'ok',
    refs: ['conversation:1'],
  })
  return memory
}

test('context compilation is deterministic, bounded, and leaves memory untouched', () => {
  const memory = loadedMemory()
  for (let index = 0; index < 6; index += 1) {
    memory.append(CONVERSATION_CHANNEL, {
      ts: 6 + index,
      trust: 'trusted_user',
      priority: 100,
      content: {text: `line ${index}`},
    })
  }
  const before = structuredClone(memory.channels.get(CONVERSATION_CHANNEL)?.items)
  const first = compileContextView(memory, 'idle', 12)
  const second = compileContextView(memory, 'idle', 12)

  assert.deepEqual(first, second)
  assert.deepEqual(memory.channels.get(CONVERSATION_CHANNEL)?.items, before)
  const conversation = first.channels.find(channel => channel.name === CONVERSATION_CHANNEL)!
  assert.equal(conversation.recent.length, 7)
  assert.equal(conversation.omitted, 0)
})

test('affordance sources are probe, suggestion, then update', () => {
  const memory = loadedMemory()
  memory.append('slow_sim', {
    ts: 6.5,
    trust: 'trusted_system',
    priority: 50,
    content: {error: 'timeout', op: 'set_light'},
    outcome: 'unknown',
    refs: ['conversation:1'],
  })
  const pool = new SuggestionPool()
  const suggestion = pool.add({
    origin: 'fast_brain',
    kind: 'question',
    content: {text: 'how dim?'},
  })
  const manifest = executorManifestSchema.parse({
    name: 'slow_sim',
    display_name: 'Slow Sim',
    policy: slowPolicy,
    ops: [{
      name: 'get_state',
      description: 'read state',
      params: {},
      readonly: true,
      verifies: ['set_light'],
    }],
  })

  const view = compileContextView(memory, 'idle', 7, {
    suggestions: pool.all(),
    manifests: [manifest],
    selectedSuggestion: suggestion.id,
  })
  assert.deepEqual(
    view.affordances.map(affordance => affordance.source),
    ['probe', 'suggestion', 'channel_update'],
  )
  assert.equal(view.affordances[0]?.conclusive, true)
  assert.equal(view.affordances[1]?.content.selected, true)
})

test('channel updates exclude conversation and stale observations', () => {
  const memory = loadedMemory()
  const fresh = compileContextView(memory, 'idle', 6)
  const stale = compileContextView(memory, 'idle', 5 + FRESH_WINDOW + 1)
  assert.deepEqual(
    fresh.affordances.filter(item => item.source === 'channel_update').map(item => item.ref),
    ['slow_sim:1'],
  )
  assert.equal(stale.affordances.some(item => item.source === 'channel_update'), false)
})

test('in-flight projection sorts tasks and excludes host-private capability', () => {
  const memory = loadedMemory()
  const capability = {secret: 'never project'}
  const later = {
    ...delegateSchema.parse({
      delegate_id: 'd-2',
      executor: 'slow_sim',
      op: 'set_light',
      request: {room: 'living room', brightness: 30},
      origin_ref: 'conversation:1',
      deadline: 10,
      routing_class: 'user_awaited',
      dispatched_at: 2,
    }),
    private: capability,
  }
  const earlier = delegateSchema.parse({
    delegate_id: 'd-1',
    executor: later.executor,
    op: later.op,
    request: later.request,
    origin_ref: later.origin_ref,
    deadline: later.deadline,
    routing_class: later.routing_class,
    dispatched_at: 1,
  })

  const view = compileContextView(memory, 'idle', 3, {inFlight: [later, earlier]})
  assert.deepEqual(view.in_flight.map(item => item.delegate_id), ['d-1', 'd-2'])
  assert.equal(
    view.in_flight[0]?.what,
    'slow_sim.set_light({"brightness":30,"room":"living room"})',
  )
  assert.equal(JSON.stringify(view).includes('never project'), false)
})

test('in-flight descriptions use language-neutral canonical JSON', () => {
  const memory = new Memory({policies: [slowPolicy]})
  const delegate = delegateSchema.parse({
    delegate_id: 'd-repr',
    executor: 'slow_sim',
    op: 'set_light',
    request: {
      both: `a'"b`,
      control: 'line\nbreak',
      nested: {'10': 10, '2': 2, float: 1, negative_zero: -0},
      single: `a'b`,
      unicode: '\u2028',
    },
    origin_ref: 'conversation:1',
    deadline: 10,
    routing_class: 'user_awaited',
    dispatched_at: 1,
  })
  const view = compileContextView(memory, 'idle', 1, {inFlight: [delegate]})
  const expected = 'slow_sim.set_light({"both":"a\'\\"b","control":"line\\nbreak",'
    + '"nested":{"10":10,"2":2,"float":1,"negative_zero":0},'
    + '"single":"a\'b","unicode":"'
    + String.fromCodePoint(0x2028)
    + '"})'
  assert.equal(
    view.in_flight[0]?.what,
    expected,
  )
})


test('uncompressed records remain visible during compression cooldown, with bounded overflow', () => {
  const memory = new Memory({policies: []})
  for (let i = 0; i < 40; i++) memory.append(CONVERSATION_CHANNEL, {ts:i,trust:'trusted_user',priority:100,content:{text:`record-${i}`}})
  const channel = memory.channels.get(CONVERSATION_CHANNEL)!
  channel.replaceSummary('first forty',40,channel.retentionRevision)
  for (let i = 40; i < 80; i++) memory.append(CONVERSATION_CHANNEL, {ts:i,trust:'trusted_user',priority:100,content:{text:`record-${i}`}})
  let view = compileContextView(memory,'idle',80).channels[0]!
  assert.deepEqual(view.recent.map(item=>item.seq),Array.from({length:40},(_,i)=>i+41))
  assert.equal(view.uncompressed_omitted,undefined)
  for (let i = 80; i < 90; i++) memory.append(CONVERSATION_CHANNEL, {ts:i,trust:'trusted_user',priority:100,content:{text:`record-${i}`}})
  view = compileContextView(memory,'idle',90).channels[0]!
  assert.equal(view.recent.length,40)
  assert.equal(view.uncompressed_omitted,10)
  assert.deepEqual(view.recent.map(item=>item.seq),Array.from({length:40},(_,i)=>i+51))
  assert.match(renderContextView(compileContextView(memory,'idle',90)),/还有 10 条未压缩记录未展示.*序号 40/u)
  channel.replaceSummary('all ninety',90,channel.retentionRevision)
  assert.equal(compileContextView(memory,'idle',90).channels[0]!.recent.length,5)
})


test('expanded pending rows have a character budget and do not revive old probes', () => {
  const memory = new Memory({policies:[slowPolicy]})
  memory.append('slow_sim',{ts:0,trust:'untrusted_external',priority:50,content:{text:'x'.repeat(17000)},outcome:'unknown'})
  for(let i=0;i<5;i++) memory.append('slow_sim',{ts:i+1,trust:'trusted_system',priority:50,content:{text:'small'},outcome:'ok'})
  const manifest = executorManifestSchema.parse({name:'slow_sim',display_name:'Slow',policy:slowPolicy,ops:[{name:'check',description:'check',params:{},readonly:true,verifies:[]}]})
  let view=compileContextView(memory,'idle',6,{manifests:[manifest]})
  assert.equal(view.channels.find(c=>c.name==='slow_sim')!.recent.length,5)
  assert.match(renderContextView(view),/还有 1 条未压缩记录未展示；尚无摘要/u)
  assert.equal(view.affordances.filter(a=>a.source==='probe').length,0)
  // A small old unknown is visible as evidence, but must not create a newly revived probe.
  const other = new Memory({policies:[slowPolicy]})
  for(let i=0;i<6;i++) other.append('slow_sim',{ts:i,trust:'trusted_system',priority:50,content:{text:'small'},outcome:i===0?'unknown':'ok'})
  view=compileContextView(other,'idle',6,{manifests:[manifest]})
  assert.equal(view.channels.find(c=>c.name==='slow_sim')!.recent.length,6)
  assert.equal(view.affordances.filter(a=>a.source==='probe').length,0)
})
