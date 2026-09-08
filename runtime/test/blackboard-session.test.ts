import assert from 'node:assert/strict'
import {test} from 'node:test'
import {spawn} from 'node:child_process'
import {mkdtemp, realpath, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {once} from 'node:events'
import {Worker} from 'node:worker_threads'
import {setTimeout as delay} from 'node:timers/promises'
import {Memory} from '../src/memory.js'
import {CausalRuntime, type ModelPort} from '../src/causal-runtime.js'
import {RealClock} from '../src/clock.js'
import {MonotonicIdFactory} from '../src/ids.js'
import {executorManifestSchema} from '../src/ports.js'
import {RealtimeRuntimeBridge} from '../src/realtime/bridge.js'
import {compileToolSchema} from '../src/tool-schema.js'
import {compileMemoryRecall} from '../src/realtime/recall.js'
import {wakeReasonSchema} from '../src/slots.js'
import {BlackboardSession} from '../src/memory/blackboard-session.js'

const append = (memory: Memory, text: string) => memory.append('conversation', {
  ts: 1, trust: 'trusted_user', priority: 100, content: {text},
})

test('session flush covers records added while a real SQLite commit is waiting', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-board-session-'))
  const options = {path: join(directory, 'board.sqlite'), ownerId: 'local'}
  let memory = new Memory({scope: {conversation_id: 'session-test'}})
  let session = new BlackboardSession(memory, options)
  let blocker: Worker | undefined
  try {
    await session.open()
    blocker = new Worker(`
      const {parentPort,workerData}=require('node:worker_threads');
      const {DatabaseSync}=require('node:sqlite');
      const db=new DatabaseSync(workerData.path); db.exec('BEGIN IMMEDIATE');
      parentPort.postMessage('locked');
      parentPort.once('message',()=>{db.exec('COMMIT');db.close();parentPort.close();});
    `, {eval: true, workerData: options})
    await once(blocker, 'message')
    append(memory, 'first')
    let acknowledged = false
    const first = session.flush().then(() => { acknowledged = true })
    await delay(20)
    assert.equal(acknowledged, false)
    append(memory, 'second')
    const second = session.flush()
    blocker.postMessage('release')
    await Promise.all([first, second])
    await session.close()
    memory = new Memory({scope: {conversation_id: 'session-test'}})
    session = new BlackboardSession(memory, options)
    await session.open()
    assert.deepEqual(memory.channels.get('conversation')!.items.map(item => item.content.text), ['first', 'second'])
    assert.equal(append(memory, 'third').seq, 3)
    // close also drains direct host records even when no reducer event follows them.
    await session.close()
    memory = new Memory({scope: {conversation_id: 'session-test'}})
    session = new BlackboardSession(memory, options)
    await session.open()
    assert.equal(memory.channels.get('conversation')!.items.at(-1)?.content.text, 'third')
  } finally { await blocker?.terminate(); await session.close(); await rm(directory, {recursive: true, force: true}) }
})

test('session applies retention receipts and rejects stale compression and uncommitted local pruning', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-board-session-'))
  const memory = new Memory({scope: {conversation_id: 'session-test'}})
  const session = new BlackboardSession(memory, {path: join(directory, 'board.sqlite'), ownerId: 'local', retention: {maxItems: 2}})
  try {
    await session.open()
    const channel = memory.channels.get('conversation')!
    append(memory, 'first'); append(memory, 'second')
    channel.replaceSummary('both', 2, 0)
    await session.flush()
    append(memory, 'third')
    await session.flush()
    assert.deepEqual(channel.items.map(item => item.seq), [2, 3])
    assert.equal(channel.summary, null)
    assert.equal(channel.retentionRevision, 1)
    assert.equal(channel.replaceSummary('stale sources', 2, 0), false)
    channel.replaceSummary('current sources', 3, 1)
    await session.flush()
    append(memory, 'not committed')
    channel.pruneThrough(4)
    await assert.rejects(session.flush(), /retention|sequence/u)
  } finally { await session.close().catch(() => undefined); await rm(directory, {recursive: true, force: true}) }
})

test('session maintenance expires idle records while keeping the memory object and sequence highwater', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-board-session-'))
  const memory = new Memory({scope: {conversation_id: 'session-test'}})
  const session = new BlackboardSession(memory, {path: join(directory, 'board.sqlite'), ownerId: 'local', retention: {ttlMs: 100}})
  try {
    await session.open()
    append(memory, 'short-lived')
    memory.channels.get('conversation')!.replaceSummary('short-lived summary', 1, 0)
    await session.flush()
    await delay(150)
    await session.flush(true)
    const channel = memory.channels.get('conversation')!
    assert.deepEqual(channel.items, [])
    assert.equal(channel.summary, null)
    assert.equal(channel.highWater, 1)
    assert.equal(append(memory, 'after expiry').seq, 2)
    await session.flush()
  } finally { await session.close(); await rm(directory, {recursive: true, force: true}) }
})

test('session clear drains unflushed writes, keeps channel highwater and recovers only new records', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-board-clear-'))
  const options = {path: join(directory, 'board.sqlite'), ownerId: 'local'}
  let memory = new Memory({scope: {conversation_id: 'session-test'}})
  let session = new BlackboardSession(memory, options)
  try {
    await session.open()
    append(memory, 'old one')
    append(memory, 'old two')
    memory.channels.get('conversation')!.replaceSummary('old summary', 2, 0)

    await session.clear()
    const channel = memory.channels.get('conversation')!
    assert.deepEqual(channel.items, [])
    assert.equal(channel.summary, null)
    assert.equal(channel.highWater, 2)
    assert.equal(channel.retentionRevision, 1)
    assert.equal(append(memory, 'new three').seq, 3)
    assert.equal(channel.replaceSummary('stale compressor', 3, 0), false)
    await session.flush()
    await session.close()

    memory = new Memory({scope: {conversation_id: 'session-test'}})
    session = new BlackboardSession(memory, options)
    await session.open()
    const recovered = memory.channels.get('conversation')!
    assert.deepEqual(recovered.items.map(item => item.content.text), ['new three'])
    assert.equal(recovered.highWater, 3)
    assert.equal(recovered.summary, null)
  } finally { await session.close().catch(() => undefined); await rm(directory, {recursive: true, force: true}) }
})

test('session clear makes concurrent flush and close wait for its committed receipt', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-board-clear-'))
  const options = {path: join(directory, 'board.sqlite'), ownerId: 'local'}
  let memory = new Memory({scope: {conversation_id: 'session-test'}})
  let session = new BlackboardSession(memory, options)
  let blocker: Worker | undefined
  try {
    await session.open()
    append(memory, 'old')
    blocker = await lockDatabase(options.path)
    const priorFlush = session.flush()
    await delay(20)
    const clearing = session.clear()
    const joiningFlush = session.flush()
    const closing = session.close()
    blocker.postMessage('release')
    await Promise.all([priorFlush, clearing, joiningFlush, closing])

    memory = new Memory({scope: {conversation_id: 'session-test'}})
    session = new BlackboardSession(memory, options)
    await session.open()
    const channel = memory.channels.get('conversation')!
    assert.deepEqual(channel.items, [])
    assert.equal(channel.highWater, 1)
    assert.equal(append(memory, 'after close').seq, 2)
  } finally { await blocker?.terminate(); await session.close().catch(() => undefined); await rm(directory, {recursive: true, force: true}) }
})

test('session clear latches a failed receipt and leaves the live projection unchanged', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-board-clear-'))
  const options = {path: join(directory, 'board.sqlite'), ownerId: 'local'}
  const memory = new Memory({scope: {conversation_id: 'session-test'}})
  const session = new BlackboardSession(memory, options)
  let mutator: Worker | undefined
  try {
    await session.open()
    append(memory, 'must remain on failed clear')
    await session.flush()
    mutator = new Worker(`
      const {parentPort,workerData}=require('node:worker_threads');
      const {DatabaseSync}=require('node:sqlite');
      const db=new DatabaseSync(workerData); db.exec('DELETE FROM conversations'); db.close(); parentPort.postMessage('done'); parentPort.close();
    `, {eval: true, workerData: options.path})
    await once(mutator, 'message')

    await assert.rejects(session.clear(), /generation/u)
    assert.deepEqual(memory.channels.get('conversation')!.items.map(item => item.content.text), ['must remain on failed clear'])
    await assert.rejects(session.flush(), /generation/u)
  } finally { await mutator?.terminate(); await session.close().catch(() => undefined); await rm(directory, {recursive: true, force: true}) }
})

test('session splits count and byte limited batches and advances only committed cursors', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-board-batches-'))
  const options = {path: join(directory, 'board.sqlite'), ownerId: 'local', retention: {maxItems: 600, maxBytes: 16 * 1024 * 1024}}
  let memory = new Memory({scope: {conversation_id: 'session-test'}})
  let session = new BlackboardSession(memory, options)
  try {
    await session.open()
    for (let index = 0; index < 520; index += 1) append(memory, `small-${index}`)
    await session.flush()
    for (let index = 0; index < 25; index += 1) append(memory, `${index}:` + '大'.repeat(70_000))
    memory.channels.get('conversation')!.replaceSummary('all committed records', 545, 0)
    await session.flush()
    await session.close()
    memory = new Memory({scope: {conversation_id: 'session-test'}})
    session = new BlackboardSession(memory, options)
    await session.open()
    const channel = memory.channels.get('conversation')!
    assert.equal(channel.items.length, 545)
    assert.equal(channel.highWater, 545)
    assert.equal(channel.summary, 'all committed records')
  } finally { await session.close(); await rm(directory, {recursive: true, force: true}) }
})

async function lockDatabase(path: string): Promise<Worker> {
  const worker = new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    const {DatabaseSync}=require('node:sqlite');
    const db=new DatabaseSync(workerData); db.exec('BEGIN IMMEDIATE'); parentPort.postMessage('locked');
    parentPort.once('message',()=>{db.exec('COMMIT');db.close();parentPort.close();});
  `, {eval: true, workerData: path})
  await once(worker, 'message')
  return worker
}
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i += 1) { if (check()) return; await delay(10) }
  assert.fail('condition timed out')
}
const workerManifest = executorManifestSchema.parse({
  name: 'worker', display_name: 'worker', probe_policy: 'readonly_ops',
  policy: {channel: 'worker', priority: 50, wake: 'none', typical_latency: 1, compress_watermark: 40},
  ops: [{name: 'read', description: 'read', params: {type: 'object', properties: {}, additionalProperties: false}, readonly: true, deadline_budget: 30}],
})
const dispatchReason = wakeReasonSchema.parse({kind: 'realtime_tool', priority: 100, routing_class: 'user_awaited'})

test('runtime durability gates ingress, observers and model context after retention', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-runtime-barrier-'))
  const blackboard = {path: join(directory, 'board.sqlite'), ownerId: 'local', retention: {maxItems: 1}}
  const calls: Parameters<ModelPort['complete']>[0][] = []
  const runtime = new CausalRuntime({blackboard, clock: new RealClock(), ids: new MonotonicIdFactory(),
    models: {fast: {complete: call => { calls.push(call); return Promise.resolve({speak: {act: 'none'}, action: {act: 'none'}}) }}}})
  const stop = new AbortController()
  let blocker: Worker | undefined
  let serving: Promise<void> | undefined
  try {
    await runtime.openMemory()
    append(runtime.memory, 'expired context must not reach the model')
    await runtime.flushMemory()
    blocker = await lockDatabase(blackboard.path)
    let observed = false
    runtime.observe(event => { if (event.kind === 'user_input') observed = true })
    serving = runtime.serve(stop.signal)
    let acknowledged = false
    const ingress = runtime.ingestUserInput({text: 'current user'}).then(ref => { acknowledged = true; return ref })
    await delay(30)
    assert.equal(acknowledged, false)
    assert.equal(observed, false)
    assert.equal(calls.length, 0)
    blocker.postMessage('release')
    assert.equal(await ingress, 'conversation:2')
    await until(() => calls.length === 1)
    assert.equal(observed, true)
    assert.doesNotMatch(JSON.stringify(calls[0]), /expired context/u)
    assert.match(JSON.stringify(calls[0]), /current user/u)
  } finally { stop.abort(); await blocker?.terminate(); await serving; await rm(directory, {recursive: true, force: true}) }
})

for (const stillWanted of [true, false]) test(`durable external admission publishes before launch, wanted=${stillWanted}, and recovers only history`, async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-runtime-dispatch-'))
  const blackboard = {path: join(directory, 'board.sqlite'), ownerId: 'local'}
  let published = false
  let wanted = true
  let launches = 0
  const options = {blackboard, clock: new RealClock(), ids: new MonotonicIdFactory(), executors: [{
    manifest: workerManifest, dispatch: () => {
      assert.equal(published, true)
      launches += 1
      return Promise.resolve({outcome: 'ok' as const, trust: 'trusted_system' as const, content: {summary: 'finished milestone'}, refs: []})
    },
  }]}
  let runtime = new CausalRuntime(options)
  let stop = new AbortController()
  let serving: Promise<void> | undefined
  let blocker: Worker | undefined
  try {
    serving = runtime.serve(stop.signal)
    const origin = await runtime.ingestUserInput({text: 'read project progress'})
    blocker = await lockDatabase(blackboard.path)
    const admission = runtime.dispatchExternal({executor: 'worker', op: 'read', request: {}, origin_ref: origin},
      dispatchReason, undefined, () => wanted).then(result => { published = true; return result })
    await delay(30)
    assert.equal(published, false)
    assert.equal(launches, 0)
    wanted = stillWanted
    blocker.postMessage('release')
    assert.equal((await admission).accepted, true)
    await until(() => runtime.core.activeDelegates().length === 0)
    assert.equal(launches, stillWanted ? 1 : 0)
    stop.abort(); await serving
    runtime = new CausalRuntime({...options, ids: new MonotonicIdFactory()})
    stop = new AbortController()
    serving = runtime.serve(stop.signal)
    await runtime.openMemory()
    assert.equal(runtime.core.activeDelegates().length, 0)
    assert.equal(launches, stillWanted ? 1 : 0)
    const records = runtime.memory.channels.get('worker')!.items
    assert.equal(records[0]?.content.kind, 'task_admitted')
    assert.equal(records.at(-1)?.outcome, stillWanted ? 'ok' : 'refused')
    assert.ok(records.every(item => runtime.memory.isHistorical(item)))
    assert.equal((await runtime.dispatchExternal({executor: 'worker', op: 'read', request: {}, origin_ref: origin}, dispatchReason)).problem, 'historical_origin')
    assert.equal(launches, stillWanted ? 1 : 0)
  } finally { stop.abort(); await blocker?.terminate(); await serving; await rm(directory, {recursive: true, force: true}) }
})

test('storage failure rejects ingress and never calls the model or publishes an applied observer', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-runtime-failure-'))
  const blackboard = {path: join(directory, 'board.sqlite'), ownerId: 'local'}
  let calls = 0
  const runtime = new CausalRuntime({blackboard, clock: new RealClock(), ids: new MonotonicIdFactory(),
    models: {fast: {complete: () => { calls += 1; return Promise.resolve({}) }}}})
  runtime.observe(() => { calls += 1 })
  const stop = new AbortController()
  try {
    const serving = runtime.serve(stop.signal)
    const rejectedServe = assert.rejects(serving, /capacity/u)
    await assert.rejects(runtime.ingestUserInput({text: 'x'.repeat(270_000)}), /capacity/u)
    await rejectedServe
    assert.equal(calls, 0)
    assert.equal(runtime.core.appliedEvents.some(event => event.kind === 'model_done'), false)
    const memory = new Memory({scope: {conversation_id: 'session-test'}})
    const session = new BlackboardSession(memory, blackboard)
    try { await session.open(); assert.equal(memory.channels.get('conversation')!.items.length, 0) }
    finally { await session.close() }
  } finally { stop.abort(); await rm(directory, {recursive: true, force: true}) }
})

test('a killed serving runtime recovers its published admission without relaunching the task', {timeout: 15_000}, async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-runtime-kill-'))
  const blackboard = {path: join(directory, 'board.sqlite'), ownerId: 'local'}
  const writer = join(directory, 'writer.mjs')
  await writeFile(writer, `
    import {CausalRuntime} from ${JSON.stringify(new URL('../src/causal-runtime.js', import.meta.url).href)};
    import {RealClock} from ${JSON.stringify(new URL('../src/clock.js', import.meta.url).href)};
    import {MonotonicIdFactory} from ${JSON.stringify(new URL('../src/ids.js', import.meta.url).href)};
    const runtime=new CausalRuntime({blackboard:${JSON.stringify(blackboard)},clock:new RealClock(),ids:new MonotonicIdFactory(),
      executors:[{manifest:${JSON.stringify(workerManifest)},dispatch:()=>{console.log('LAUNCHED');return new Promise(()=>{});}}]});
    void runtime.serve(new AbortController().signal);
    const origin=await runtime.ingestUserInput({text:'project checkpoint awaiting external result'});
    const admission=await runtime.dispatchExternal({executor:'worker',op:'read',request:{},origin_ref:origin},${JSON.stringify(dispatchReason)});
    if(!admission.accepted)throw new Error('admission failed');
    console.log('ADMITTED');
  `)
  const child = spawn(process.execPath, [writer], {stdio: ['ignore', 'pipe', 'pipe']})
  const exited = once(child, 'exit')
  t.after(async () => { child.kill('SIGKILL'); await exited; await rm(directory, {recursive: true, force: true}) })
  let output = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  await until(() => output.includes('ADMITTED') && output.includes('LAUNCHED'))
  child.kill('SIGKILL')
  await exited
  let launches = 0
  const runtime = new CausalRuntime({blackboard, clock: new RealClock(), ids: new MonotonicIdFactory(),
    executors: [{manifest: workerManifest, dispatch: () => { launches += 1; return Promise.resolve({
      outcome: 'ok', trust: 'trusted_system', content: {}, refs: [],
    }) }}]})
  const stop = new AbortController()
  const serving = runtime.serve(stop.signal)
  try {
    await runtime.openMemory()
    assert.equal(runtime.memory.channels.get('conversation')!.items[0]?.content.text, 'project checkpoint awaiting external result')
    assert.equal(runtime.memory.channels.get('worker')!.items[0]?.content.kind, 'task_admitted')
    await delay(30)
    assert.equal(launches, 0)
    assert.equal(runtime.core.activeDelegates().length, 0)
    assert.equal(runtime.ownedTaskCount, 0)
    const origin = await runtime.ingestUserInput({text: 'what was worker doing?'})
    const recall = compileMemoryRecall(runtime.memory, {query: 'worker', scope: 'any', beforeRef: origin})
    const admission = recall.hits.find(hit => hit.channel === 'worker')
    assert.equal(admission?.historical, true)
    assert.match(admission?.evidence ?? '', /已接收.*不表示任务仍在运行/u)
  } finally { stop.abort(); await serving }
})

test('session recall waits for an outstanding real commit before publishing optimistic records', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-recall-barrier-'))
  const blackboard = {path: join(directory, 'board.sqlite'), ownerId: 'local'}
  const runtime = new CausalRuntime({blackboard, clock: new RealClock(), ids: new MonotonicIdFactory(),
    executors: [{manifest: workerManifest, dispatch: () => Promise.reject(new Error('must not dispatch'))}]})
  const stop = new AbortController()
  const serving = runtime.serve(stop.signal)
  let blocker: Worker | undefined
  try {
    const origin = await runtime.ingestUserInput({text: 'what progress was made?'})
    blocker = await lockDatabase(blackboard.path)
    runtime.memory.append('worker', {ts: 1, trust: 'trusted_system', priority: 50, outcome: 'ok', content: {summary: 'optimistic milestone'}})
    const flushing = runtime.flushMemory()
    const bridge = new RealtimeRuntimeBridge({runtime, tools: compileToolSchema([workerManifest], {includeMemoryRecall: true}), idFactory: () => 'recall'})
    let published = false
    const recall = bridge.acceptToolCall({kind: 'tool_call_ready', call_id: 'recall', item_id: 'recall-item',
      name: 'memory__recall', arguments: {query: 'milestone', scope: 'any'}, response_id: 'response', session_epoch: 1},
    {originRef: origin}).then(value => { published = true; return value })
    await delay(30)
    assert.equal(published, false)
    blocker.postMessage('release')
    await flushing
    const result = await recall
    assert.equal(result.accepted, true)
    assert.match(result.host_item.content, /optimistic milestone/u)
  } finally { stop.abort(); await blocker?.terminate(); await serving; await rm(directory, {recursive: true, force: true}) }
})

test('shutdown bounds a blackboard flush blocked by another SQLite writer', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-board-close-'))
  const options = {path: join(directory, 'board.sqlite'), ownerId: 'local'}
  const memory = new Memory()
  const session = new BlackboardSession(memory, options)
  let blocker: Worker | undefined
  try {
    await session.open()
    blocker = new Worker(`
      const {parentPort,workerData}=require('node:worker_threads');
      const {DatabaseSync}=require('node:sqlite');
      const db=new DatabaseSync(workerData); db.exec('BEGIN IMMEDIATE');
      parentPort.on('message', () => {});
      parentPort.postMessage('locked');
    `, {eval: true, workerData: options.path})
    await once(blocker, 'message')
    append(memory, 'not acknowledged')
    const started = performance.now()
    await assert.rejects(session.close())
    assert.ok(performance.now() - started < 1_500)
  } finally {
    await blocker?.terminate()
    await session.close().catch(() => undefined)
    await rm(directory, {recursive: true, force: true})
  }
})
