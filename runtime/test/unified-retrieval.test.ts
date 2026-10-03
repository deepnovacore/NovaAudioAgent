import assert from 'node:assert/strict'
import test from 'node:test'
import {UnifiedRetrieval} from '../src/memory/retrieval.js'
import type {MemoryEntry, PersonalMemoryResource, PersonalMemoryRecallHit} from '../src/memory/personal-memory.js'
import type {JsonValue} from '../src/core/events.js'

const entry = (id: string, version = 1): MemoryEntry => ({id, version, content: `记忆 ${id}`, kind: 'fact', origin: 'stated', source_refs: [{type: 'conversation', ref: 'source', observed_at: '2026-09-12T00:00:00Z'}], observed_at: '2026-09-12T00:00:00Z', recorded_at: '2026-09-12T00:00:00Z', topic: '', status: 'active', corrected_to: null, confidence_note: null})
const memoryHit = (id: string): PersonalMemoryRecallHit => ({memoryId: id, revision: 1, text: `记忆 ${id}`, evidenceIds: [`e:${id}`, `e:${id}`], score: 1e9})
const raw = (id: string) => ({evidence_id: id, source_kind: 'im', locator: `feishu://fixture/${id}`, text: '原始消息'.repeat(300), observed_at: '2026-09-12T00:00:00Z', trust: 'untrusted_external' as const})
const memory = (hits: PersonalMemoryRecallHit[]): {-readonly [Key in keyof PersonalMemoryResource]: PersonalMemoryResource[Key]} => ({
  open: () => Promise.resolve(), close: () => Promise.resolve(),
  recall: () => Promise.resolve({source: 'personal', state: hits.length ? 'ok' : 'empty', scope: 'any', hits, degraded: false}),
  get: (id) => Promise.resolve(entry(id)), readEvidence: (id) => Promise.resolve(raw(id)),
})

test('one projection blends entries and canonical A snippets with bounded, deduplicated output', async () => {
  const personal = memory(['m1', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'].map(memoryHit));
  const engine = new UnifiedRetrieval({memory: () => personal,
    rawRecall: (_query, k) => { assert.equal(k, 8); return Promise.resolve(['e:m1', 'e:m1', 'e:d1', 'e:d2', 'e:d3'].map(evidence_id => ({evidence_id, score: -1e9}))); },
  });
  const result = await engine.recall('项目', {limit: 99});
  const json: JsonValue = result;
  assert.deepEqual(JSON.parse(JSON.stringify(json)), result);
  assert.equal(result.entries.length + result.snippets.length, 8);
  assert(result.entries.length > 0); assert(result.snippets.length > 0);
  assert.equal(new Set(result.snippets.map(hit => hit.evidence_id)).size, result.snippets.length);
  assert.equal(result.snippets.filter(hit => hit.evidence_id === 'e:m1').length, 1);
  assert(result.snippets.every(hit => Buffer.byteLength(hit.text) <= 1000 && hit.trust === 'untrusted_external'));
  assert.equal(result.entries[0]!.reference, 'm1@1'); assert.deepEqual(result.entries[0]!.evidence_refs, ['e:m1']);
  const original = await engine.evidence('e:m1');
  assert.equal(original.state, 'ok'); assert(Buffer.byteLength(original.evidence!.text) <= 2000);
  assert(!original.evidence!.text.includes('\ufffd'));
});

test('post-hydration checks suppress corrected memory and deleted evidence', async () => {
  const personal = memory([memoryHit('m1')]);
  let changed = false, reads = 0;
  personal.get = () => Promise.resolve(changed ? {...entry('m1', 2), content: '纠正后的内容'} : entry('m1'));
  personal.readEvidence = id => { reads++; changed = true; return Promise.resolve(reads > 1 ? null : raw(id)); };
  const result = await new UnifiedRetrieval({memory: () => personal}).recall('项目');
  assert.deepEqual(result.entries, []); assert.deepEqual(result.snippets, []); assert.equal(result.state, 'empty');
});

test('partial-transcript cache revalidates deleted evidence and corrected revisions without querying again', async () => {
  const personal = memory([memoryHit('m1')]);
  let recalls = 0, rawQueries = 0;
  const originalRecall = personal.recall;
  personal.recall = (...args) => {recalls++; return originalRecall(...args);};
  const engine = new UnifiedRetrieval({memory: () => personal, rawRecall: () => {rawQueries++; return Promise.resolve([{evidence_id: 'e:m1'}]);}});
  const partial = await engine.recall('项目');
  assert.equal(partial.entries.length, 1); assert.equal(partial.snippets.length, 1);
  personal.get = () => Promise.resolve(entry('m1', 2));
  personal.readEvidence = () => Promise.resolve(null);
  const final = await engine.revalidate(partial, new AbortController().signal);
  assert.equal(final.state, 'empty'); assert.deepEqual(final.entries, []); assert.deepEqual(final.snippets, []);
  assert.equal(recalls, 1); assert.equal(rawQueries, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(engine.revalidate(partial, controller.signal));
});

test('raw index never supplies authoritative text or invents an evidence ID', async () => {
  const personal = memory([]);
  const reads: string[] = [];
  personal.readEvidence = id => { reads.push(id); return Promise.resolve(null); };
  const engine = new UnifiedRetrieval({memory: () => personal, rawRecall: () => Promise.resolve([
    {evidence_id: 'deleted', score: 1e9}, {evidence_id: '', score: 1e9},
  ])});
  const result = await engine.recall('项目');
  assert.deepEqual(result.snippets, []); assert(result.degraded); assert.deepEqual(reads, ['deleted']);
  assert.equal((await engine.evidence('deleted')).state, 'gone');
});

test('index failure preserves memory, and identity changes or cancellation fence everything', async () => {
  const personal = memory([memoryHit('m1')]);
  const partial = await new UnifiedRetrieval({memory: () => personal, rawRecall: () => Promise.reject(new Error('private index details'))}).recall('项目');
  assert.equal(partial.entries.length, 1); assert(partial.degraded); assert(!JSON.stringify(partial).includes('private index'));
  let current: PersonalMemoryResource | undefined = personal;
  const switched = await new UnifiedRetrieval({memory: () => current, rawRecall: () => { current = memory([]); return Promise.resolve([]); }}).recall('项目');
  assert.equal(switched.state, 'unavailable'); assert.deepEqual(switched.entries, []);
  const controller = new AbortController();
  const waiting = new UnifiedRetrieval({memory: () => ({...personal, recall: () => new Promise(() => { /* Uncooperative provider. */ })})}).recall('项目', {signal: controller.signal});
  controller.abort(); await assert.rejects(waiting, {name: 'AbortError'});
});

test('expired and unversioned entries or sensitive originals remain inaccessible', async () => {
  const personal = memory(['expired', 'unversioned'].map(memoryHit));
  personal.get = id => Promise.resolve(id === 'expired' ? {...entry(id), status: 'expired'} : {...entry(id), version: null});
  personal.readEvidence = id => Promise.resolve({...raw(id), text: '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----'});
  const engine = new UnifiedRetrieval({memory: () => personal});
  const result = await engine.recall('项目');
  assert.deepEqual(result.entries, []); assert.deepEqual(result.snippets, []);
  assert.equal((await engine.evidence('private')).state, 'gone');
  await assert.rejects(engine.recall(''), /invalid_retrieval_request/);
  await assert.rejects(engine.evidence(''), /invalid_evidence_request/);
});

test('recent stays within the memory candidate window and its linked originals', async () => {
  const personal = memory([memoryHit('m1')]);
  let rawQueries = 0;
  const engine = new UnifiedRetrieval({memory: () => personal, rawRecall: () => { rawQueries++; return Promise.resolve([{evidence_id: 'historical-document'}]); }});
  const result = await engine.recall('项目', {scope: 'recent'});
  assert.equal(rawQueries, 0);
  assert.deepEqual(result.snippets.map(hit => hit.evidence_id), ['e:m1']);
  await engine.recall('项目', {scope: 'any'}); assert.equal(rawQueries, 1);
});

test('model-facing recall and evidence require the actual consumer while local reads remain available',async()=>{
 const personal=memory([memoryHit('m1')]);let granted=true
 personal.canReadConversationEvidence=(_id,consumer)=>Promise.resolve(granted&&consumer==='allowed-model')
 const engine=new UnifiedRetrieval({memory:()=>personal})
 const permitted=await engine.recall('项目',{consumer:'allowed-model'});assert.equal(permitted.entries.length,1);assert.equal(permitted.snippets.length,1)
 const denied=await engine.recall('项目',{consumer:'other-model'});assert.equal(denied.entries.length,0);assert.equal(denied.snippets.length,0)
 assert.equal((await engine.evidence('e:m1',{consumer:'other-model'})).state,'gone')
 assert.equal((await engine.evidence('e:m1')).state,'ok')
 granted=false
 const revoked=await engine.revalidate(permitted,new AbortController().signal);assert.equal(revoked.entries.length,0);assert.equal(revoked.snippets.length,0)
})
