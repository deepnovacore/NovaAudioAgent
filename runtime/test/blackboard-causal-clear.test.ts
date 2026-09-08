import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp, realpath, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {once} from 'node:events'
import {Worker} from 'node:worker_threads'
import {CausalRuntime, type ExecutorDispatchContext, type ExecutorHandoff} from '../src/causal-runtime.js'
import {RealClock} from '../src/clock.js'
import {MonotonicIdFactory} from '../src/ids.js'
import {executorManifestSchema} from '../src/ports.js'
import {wakeReasonSchema} from '../src/slots.js'

const manifest = executorManifestSchema.parse({
  name: 'worker', display_name: 'worker', policy: {channel: 'worker', priority: 50, wake: 'none', typical_latency: 1, compress_watermark: 40},
  ops: [{name: 'read', description: 'read', params: {type: 'object', properties: {}, additionalProperties: false}, readonly: true, deadline_budget: 30}],
})
const reason = wakeReasonSchema.parse({kind: 'realtime_tool', priority: 100, routing_class: 'user_awaited'})
const deferred = <T>(): {promise: Promise<T>; resolve: (value: T) => void} => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return {promise, resolve}
}
async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 300; index += 1) { if (predicate()) return; await delay(10) }
  assert.fail('condition did not become true')
}

test('causal clear fences old model and executor bodies while independent work still completes', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-causal-clear-'))
  const blackboard = {path: join(directory, 'board.sqlite'), ownerId: 'local'}
  const model = deferred<unknown>()
  const executor = deferred<ExecutorHandoff>()
  let context: ExecutorDispatchContext | undefined
  let modelStarted = false
  let modelAborted = false
  let calls = 0
  let oldHandoffObserved = false
  const runtime = new CausalRuntime({blackboard, clock: new RealClock(), ids: new MonotonicIdFactory(),
    models: {fast: {complete: (_call, signal) => {
      calls += 1
      if (calls > 1) return Promise.resolve({speak: {act: 'none'}, action: {act: 'none'}})
      modelStarted = true
      signal.addEventListener('abort', () => { modelAborted = true }, {once: true})
      return model.promise
    }}},
    executors: [{manifest, dispatch: (_op, _request, input) => { context = input; return executor.promise }}],
  })
  const stop = new AbortController()
  const serving = runtime.serve(stop.signal)
  let blocker: Worker | undefined
  try {
    const origin = await runtime.ingestUserInput({text: 'old project question'})
    const admission = await runtime.dispatchExternal({executor: 'worker', op: 'read', request: {}, origin_ref: origin}, reason)
    await until(() => context !== undefined && modelStarted)
    runtime.memory.channels.get('conversation')!.replaceSummary('old project summary', 1, 0)
    await runtime.flushMemory()
    runtime.observe((event, currentConversation) => { if (event.kind === 'handoff' && currentConversation !== false) oldHandoffObserved = true })
    blocker = new Worker(`
      const {parentPort,workerData}=require('node:worker_threads');
      const {DatabaseSync}=require('node:sqlite');
      const db=new DatabaseSync(workerData); db.exec('BEGIN IMMEDIATE'); parentPort.postMessage('locked');
      parentPort.once('message',()=>{db.exec('COMMIT');db.close();parentPort.close();});
    `, {eval: true, workerData: blackboard.path})
    await once(blocker, 'message')
    const clearing = runtime.clearConversation()
    assert.equal(runtime.clearConversation(), clearing)
    await assert.rejects(runtime.ingestUserInput({text: 'during clear'}), /clearing/u)
    assert.throws(() => runtime.post({kind: 'assistant_spoken', payload: {text: 'late old speech', utterance_id: 'old', delivery: 'spoken', played_ms: 100}}), /clearing/u)
    const refused = await runtime.dispatchExternal({executor: 'worker', op: 'read', request: {}, origin_ref: origin}, reason)
    assert.equal(refused.accepted, false)
    assert.equal(modelAborted, true)
    assert.equal(context!.signal.aborted, false)
    context!.progress({phase: 'working', internal_activity: 1, elapsed: 1, summary: 'old progress'})
    context!.observe?.({trust: 'trusted_system', content: {text: 'old observation'}})
    model.resolve({speak: {act: 'say', text: 'old model output'}, action: {act: 'none'}})
    executor.resolve({outcome: 'ok', trust: 'trusted_system', content: {summary: 'old final result'}})
    let cleared = false
    void clearing.then(() => { cleared = true })
    await delay(30)
    assert.equal(cleared, false)
    blocker.postMessage('release')
    await clearing
    await until(() => runtime.core.inFlightDelegate(admission.delegate_id!) === undefined && runtime.ownedTaskCount === 0)
    assert.equal(oldHandoffObserved, false)
    assert.deepEqual([...runtime.memory.channels.values()].flatMap(channel => channel.items), [])
    assert.equal(runtime.memory.channels.get('conversation')!.summary, null)
    assert.equal(await runtime.ingestUserInput({text: 'new project question'}), 'conversation:2')
    await until(() => calls === 2 && runtime.ownedTaskCount === 0)
    stop.abort()
    await serving
    const reopened = new CausalRuntime({blackboard, clock: new RealClock(), ids: new MonotonicIdFactory(), executors: [{manifest, dispatch: () => Promise.reject(new Error('must not recover work'))}]})
    try {
      await reopened.openMemory()
      assert.deepEqual(reopened.memory.channels.get('conversation')!.items.map(item => item.content.text), ['new project question'])
      assert.deepEqual(reopened.memory.channels.get('worker')!.items, [])
    } finally { await reopened.closeMemory() }
  } finally { stop.abort(); await blocker?.terminate(); await serving; await rm(directory, {recursive: true, force: true}) }
})

test('an admission callback cannot launch old work by synchronously clearing the conversation', async () => {
  let launches = 0
  let clearing: Promise<void> | undefined
  const runtime = new CausalRuntime({clock: new RealClock(), ids: new MonotonicIdFactory(),
    executors: [{manifest, dispatch: () => { launches += 1; return Promise.resolve({outcome: 'ok', trust: 'trusted_system', content: {}}) }}],
  })
  const stop = new AbortController()
  const serving = runtime.serve(stop.signal)
  try {
    const origin = await runtime.ingestUserInput({text: 'old question'})
    await runtime.dispatchExternal({executor: 'worker', op: 'read', request: {}, origin_ref: origin}, reason, undefined, () => {
      clearing = runtime.clearConversation()
      return true
    })
    await until(() => clearing !== undefined)
    await clearing
    await until(() => runtime.ownedTaskCount === 0 && runtime.core.activeDelegates().length === 0)
    assert.equal(launches, 0)
    assert.deepEqual([...runtime.memory.channels.values()].flatMap(channel => channel.items), [])
  } finally { stop.abort(); await serving }
})

test('failed clear refuses later ingress even when serving has not started', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-causal-clear-failure-'))
  const blackboard = {path: join(directory, 'board.sqlite'), ownerId: 'local'}
  const runtime = new CausalRuntime({blackboard, clock: new RealClock(), ids: new MonotonicIdFactory()})
  let blocker: Worker | undefined
  try {
    await runtime.openMemory()
    blocker = new Worker(`
      const {parentPort,workerData}=require('node:worker_threads');
      const {DatabaseSync}=require('node:sqlite');
      const db=new DatabaseSync(workerData); db.exec('BEGIN IMMEDIATE'); parentPort.postMessage('locked');
      parentPort.once('message',()=>{db.exec('COMMIT');db.close();parentPort.close();});
    `, {eval: true, workerData: blackboard.path})
    await once(blocker, 'message')
    await assert.rejects(runtime.clearConversation())
    await assert.rejects(runtime.ingestUserInput({text: 'must reject, not hang'}))
    assert.throws(() => runtime.post({kind: 'user_input', payload: {text: 'must reject'}}))
    assert.equal(runtime.core.queue.size, 0)
  } finally {
    await blocker?.terminate()
    await runtime.closeMemory().catch(() => undefined)
    await rm(directory, {recursive: true, force: true})
  }
})
