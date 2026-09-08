import assert from 'node:assert/strict'
import {test, type TestContext} from 'node:test'
import {setImmediate as tick} from 'node:timers/promises'
import {buildAssembly} from '../src/assembly.js'
import {buildRealtimeAssembly} from '../src/realtime-assembly.js'
import {buildDesktopRealtimeComposition, runDesktopEntry} from '../src/desktop-service.js'
import {settingsSchema} from '../src/config.js'
import {parseCapabilityRegistry} from '../src/capability-registry.js'
import {ApprovalHost} from '../src/approval.js'
import {VirtualClock} from '../src/clock.js'
import {slowSimManifest} from '../src/sims.js'
import type {DesktopServerOptions} from '../src/desktop.js'
import type {RealtimeProvider} from '../src/realtime/protocol.js'
import {CascadedRealtimeProvider} from '../src/realtime/cascaded/provider.js'
import {SilenceVolcEndpointing} from '../src/realtime/volcengine/silence-endpointing.js'
import {AoqRuntimeLink, AoqRealtimeAdapter} from '../src/realtime/aoq.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return {promise, resolve}
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await tick()
  assert.ok(predicate(), 'input boundary did not settle')
}
function speech(value: number) {
  const pcm = Buffer.alloc(1024)
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(value, i)
  return pcm
}
async function serviceHarness(t: TestContext, provider: RealtimeProvider) {
  const stop = new AbortController()
  let options!: DesktopServerOptions
  let workerSignal: AbortSignal | undefined
  let launches = 0
  const finished = deferred<void>()
  const sent: string[] = []
  const core = buildAssembly({settings: settingsSchema.parse({executors: ['slow_sim'], model_api_key: 'fixture'}),
    capabilities: parseCapabilityRegistry({version: 1, modules: {search: {enabled: false}, camera: {enabled: false}, coding: {enabled: false}, knowledge: {enabled: false}}}),
    clock: new VirtualClock(),
    gateway: {
      complete: () => Promise.reject(new Error('no external model calls')),
      async *stream() { await Promise.resolve(); throw new Error('no external model calls') },
    },
    executors: [{manifest: slowSimManifest, dispatch: async (_op, _request, context) => {
      launches++; workerSignal = context.signal
      context.progress({phase: 'started', internal_activity: 0, elapsed: 0, summary: null})
      await finished.promise
      return {outcome: 'ok', trust: 'trusted_system', content: {summary: 'done'}}
    }}],
  })
  const close = t.mock.method(core, 'stop')
  const composition = buildDesktopRealtimeComposition({token: 'a'.repeat(32), stop, transportFailure: 'disconnect',
    createServer: input => {
      options = input
      return {start: () => Promise.resolve({token: input.token, host: '127.0.0.1', port: 19876}),
        close: () => Promise.resolve(), disconnectClient: () => {input.onClientDisconnect?.(); return Promise.resolve()},
        sendText: raw => {sent.push(raw); return Promise.resolve()}, sendBinary: () => Promise.resolve()}
    }, buildRealtime: callbacks => buildRealtimeAssembly({core, provider, ...callbacks}),
  })
  const ready = deferred<void>()
  const running = runDesktopEntry({token: 'a'.repeat(32), stop, construct: () => composition,
    announce: () => {ready.resolve(); return Promise.resolve()}, onDiagnostic: () => undefined})
  t.after(async () => {finished.resolve(); stop.abort(); await running})
  await Promise.race([ready.promise, running.then(() => assert.fail('service failed to start'))])
  await options.onClientAuthenticated?.()
  const runtime = composition.realtime.runtime
  const origin = runtime.memory.append('conversation', {ts: 0, trust: 'trusted_user', priority: 100, content: {text: 'run authorized worker'}})
  const admitted = runtime.dispatchExternal({executor: 'slow_sim', op: 'set_light', request: {room: 'office', brightness: 50}, origin_ref: `${origin.channel}:${origin.seq}`},
    {kind: 'realtime_tool', priority: 100, routing_class: 'ambient', origin: null, selected_suggestion: null})
  assert.equal(admitted.accepted, true)
  await until(() => workerSignal !== undefined)
  return {options, composition, sent, alive: () => {
    assert.equal(workerSignal!.aborted, false)
    assert.ok(runtime.inFlightDelegate(admitted.delegate_id!))
    assert.equal(close.mock.callCount(), 0)
    assert.equal(launches, 1)
    assert.equal(stop.signal.aborted, false)
  }}
}

test('AOQ phone detach preserves an authorized worker and reattaches the same Runtime', {timeout: 5000}, async t => {
  const link = new AoqRuntimeLink()
  const provider = new AoqRealtimeAdapter({link, url: 'wss://unused.invalid', apiKey: 'unused',
    model: 'qwen-audio-3.0-realtime-plus', voice: 'longanqian'})
  const attach = (id: string) => {
    link.attach({id, disconnect: () => link.detach(id), send: event => {
      if (event.type === 'session.update') link.receive(id, {type: 'session.updated', session: {id}})
      if (event.type === 'conversation.item.create') {
        link.receive(id, {type: 'conversation.item.created', item: event.item})
      }
      return Promise.resolve()
    }})
    link.receive(id, {type: 'session.created', session: {id}})
  }
  attach('phone-a')
  const h = await serviceHarness(t, provider)
  const runtime = h.composition.realtime.runtime
  const firstEpoch = h.composition.realtime.service.session.sessionEpoch
  h.options.onClientDisconnect?.()
  link.detach('phone-a')
  for (let i = 0; i < 5; i++) await tick()
  h.alive()
  await h.options.onClientAuthenticated?.()
  attach('phone-b')
  await until(() => h.composition.realtime.service.session.sessionEpoch > firstEpoch)
  assert.equal(h.composition.realtime.runtime, runtime)
  h.alive()
})

test('real endpointing discards speech A, late ASR and queued PCM before admitting speech B', {timeout: 5000}, async t => {
  const asr: {pcm: number[]; closed: boolean; final: ReturnType<typeof deferred<string>>}[] = []
  const texts: string[] = []
  let llmClosed = 0
  let holdFeed = false
  const feedStarted = deferred<void>()
  const releaseFeed = deferred<void>()
  let id = 0
  const provider = new CascadedRealtimeProvider({idFactory: () => `input-${++id}`,
    endpointingFactory: async () => {
      await Promise.resolve()
      const endpoint = new SilenceVolcEndpointing({vadPreRollMs: 0, vadMinSpeechMs: 1, vadSilenceEndMs: 32, vadSpeechPadMs: 0, vadMaxUtteranceMs: 2000})
      return {feed: async (pcm, signal) => {
      const result = await endpoint.feed(pcm, signal)
      if (holdFeed) {feedStarted.resolve(); await releaseFeed.promise}
      return result
    }, reset: () => endpoint.reset(), close: () => endpoint.close()}},
    asrFactory: {openClient: () => ({open: () => {
      const entry = {pcm: [] as number[], closed: false, final: deferred<string>()}; asr.push(entry)
      return Promise.resolve({append: pcm => {entry.pcm.push(Buffer.from(pcm).readInt16LE()); return Promise.resolve()},
        finish: () => {entry.final.resolve(entry.pcm[0] === 8000 ? 'A' : 'B'); return Promise.resolve()},
        async *events() {yield {text: await entry.final.promise, final: true}},
        close: () => {entry.closed = true; entry.final.resolve('A-late'); return Promise.resolve()}})
    }})},
    llmFactory: {open: () => ({async *stream(input) {
      texts.push(...input.inputs.filter(item => item.kind === 'user_text').map(item => item.text))
      await Promise.resolve(); yield {kind: 'response_started', response_id: 'reply'}
      yield {kind: 'response_completed', response_id: 'reply'}
    }, abandonPendingResponse: () => Promise.resolve(), close: () => {llmClosed++; return Promise.resolve()}})},
    ttsFactory: {openClient: () => ({open: () => Promise.reject(new Error('no spoken response in this test'))})},
  })
  const h = await serviceHarness(t, provider)
  await h.options.onAudio?.(speech(8000))
  assert.equal(asr.length, 1)
  holdFeed = true
  const oldFeed = Promise.resolve(h.options.onAudio?.(speech(8000))).catch(() => undefined)
  await feedStarted.promise
  const oldQueued = Promise.resolve(h.options.onAudio?.(speech(8000))).catch(() => undefined)
  h.options.onClientDisconnect?.()
  await h.options.onClientAuthenticated?.()
  const newFeed = Promise.resolve(h.options.onAudio?.(speech(12000)))
  assert.equal(asr.length, 1)
  holdFeed = false
  releaseFeed.resolve()
  await Promise.all([oldFeed, oldQueued, newFeed])
  assert.equal(asr[0]!.closed, true, 'disconnect must discard the unfinished ASR session')
  assert.equal(asr.length, 2)
  assert.deepEqual(asr[1]!.pcm, [12000], 'B must not contain old queued PCM')
  await h.options.onAudio?.(Buffer.alloc(1024))
  await until(() => texts.length > 0)
  assert.deepEqual(texts, ['B'])
  assert.equal(llmClosed, 1)
  h.alive()
})

for (const repeat of [false, true]) for (const preEvent of [false, true]) for (const failReconnect of [false, true]) test(`provider-only input replacement preserves workers and fails closed=${failReconnect}, prior event=${preEvent}, repeated=${repeat}`, async t => {
  let epoch = 0
  let closes = 0
  const received: number[] = []
  const replacement = deferred<void>()
  const secondReplacement = deferred<void>()
  const freshEvent = deferred<void>()
  let streams = 0
  const provider: RealtimeProvider = {
    connect: async () => {epoch++; if (epoch > 1) {await (epoch === 2 ? replacement.promise : secondReplacement.promise); if (failReconnect) throw new Error('replacement failed')}
      return {epoch, provider_session_id: `provider-${epoch}`}},
    sendAudio: pcm => {received.push(Buffer.from(pcm).readInt16LE()); return Promise.resolve()},
    injectHostItem: item => Promise.resolve({session_epoch: epoch, host_item_id: item.host_item_id, provider_item_id: item.host_item_id}),
    createResponse: () => Promise.resolve(), cancelResponse: () => Promise.resolve(),
    async *events(signal) {
      const current = epoch
      streams++
      if (current === 1 && preEvent) yield {kind: 'user_speech_started', session_epoch: current, speech_id: 'old'}
      if (current > 1) {
        await freshEvent.promise
        yield {kind: 'user_speech_started', session_epoch: current, speech_id: 'fresh'}
      }
      await new Promise<void>(resolve => {if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), {once: true})})
    },
    close: () => {closes++; return Promise.resolve()},
  }
  const h = await serviceHarness(t, provider)
  const handled = t.mock.method(h.composition.realtime.service, 'handleEvent')
  await tick()
  await h.options.onAudio?.(speech(8000))
  h.options.onClientDisconnect?.()
  await h.options.onClientAuthenticated?.()
  const fresh = Promise.resolve(h.options.onAudio?.(speech(12000)))
  void fresh.catch(() => undefined)
  await tick()
  assert.deepEqual(received, [8000], 'new input waits for replacement')
  assert.equal(epoch, 2)
  let lastFeed = fresh
  if (repeat) {
    h.options.onClientDisconnect?.()
    await h.options.onClientAuthenticated?.()
    lastFeed = Promise.resolve(h.options.onAudio?.(speech(14000)))
    void lastFeed.catch(() => undefined)
  }
  replacement.resolve()
  if (repeat) {
    await until(() => epoch === 3)
    assert.deepEqual(received, [8000])
    secondReplacement.resolve()
  }
  if (failReconnect) {
    await assert.rejects(fresh)
    if (repeat) await assert.rejects(lastFeed)
    await assert.rejects(Promise.resolve(h.options.onAudio?.(speech(12000))))
    assert.deepEqual(received, [8000])
  } else {
    await fresh; await lastFeed; assert.deepEqual(received, [8000, repeat ? 14000 : 12000]); assert.equal(closes, repeat ? 2 : 1)
    await until(() => streams === 2)
    freshEvent.resolve()
    await until(() => handled.mock.calls.some(call => call.arguments[0].session_epoch === (repeat ? 3 : 2)))
  }
  await tick()
  h.alive()
})

test('disconnect fences a final transcript suspended before admission', async t => {
  let epoch = 0
  const provider: RealtimeProvider = {
    connect: () => Promise.resolve({epoch: ++epoch, provider_session_id: `provider-${epoch}`}),
    sendAudio: () => Promise.resolve(),
    injectHostItem: item => Promise.resolve({session_epoch: epoch, host_item_id: item.host_item_id, provider_item_id: item.host_item_id}),
    createResponse: () => Promise.resolve(), cancelResponse: () => Promise.resolve(), close: () => Promise.resolve(),
    async *events(signal) {
      await new Promise<void>(resolve => {if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), {once: true})})
      yield* []
    },
  }
  const h = await serviceHarness(t, provider)
  const blocked = deferred<void>()
  const release = deferred<void>()
  t.mock.method(ApprovalHost.prototype, 'reserveExecutorApprovalItem', async (_sessionEpoch: number, itemId: string | null) => {
    if (itemId === 'A') {blocked.resolve(); await release.promise}
  })
  const admitted = t.mock.method(h.composition.realtime.bridge, 'acceptUserTranscript')
  const old = h.composition.realtime.service.handleEvent({kind: 'user_transcript_final', session_epoch: 1, item_id: 'A', text: 'A'})
  await blocked.promise
  h.options.onClientDisconnect?.()
  await h.options.onClientAuthenticated?.()
  await h.options.onAudio?.(speech(12000))
  release.resolve()
  await old
  assert.equal(admitted.mock.callCount(), 0)
  await h.composition.realtime.service.handleEvent({kind: 'user_transcript_final', session_epoch: 2, item_id: 'B', text: 'B'})
  assert.deepEqual(admitted.mock.calls.map(call => call.arguments[0]), ['B'])
  h.alive()
})

test('a later disconnect retries failed input reset and resumes PCM and provider events', async t => {
  let epoch = 0
  const received: number[] = []
  const recovery = deferred<void>()
  const eventReady = deferred<void>()
  let streams = 0
  const provider: RealtimeProvider = {
    connect: async () => {
      epoch++
      if (epoch === 2) throw new Error('transient reset failure')
      if (epoch === 3) await recovery.promise
      return {epoch, provider_session_id: `provider-${epoch}`}
    },
    sendAudio: pcm => {received.push(Buffer.from(pcm).readInt16LE()); return Promise.resolve()},
    injectHostItem: item => Promise.resolve({session_epoch: epoch, host_item_id: item.host_item_id, provider_item_id: item.host_item_id}),
    createResponse: () => Promise.resolve(), cancelResponse: () => Promise.resolve(), close: () => Promise.resolve(),
    async *events(signal) {
      const current = epoch
      streams++
      if (current === 3) {
        await eventReady.promise
        yield {kind: 'user_speech_started', session_epoch: current, speech_id: 'recovered'}
      }
      await new Promise<void>(resolve => {if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), {once: true})})
    },
  }
  const h = await serviceHarness(t, provider)
  const handled = t.mock.method(h.composition.realtime.service, 'handleEvent')
  await h.options.onAudio?.(speech(8000))
  h.options.onClientDisconnect?.()
  await h.options.onClientAuthenticated?.()
  await assert.rejects(Promise.resolve(h.options.onAudio?.(speech(12000))))
  await tick()
  await assert.rejects(Promise.resolve(h.options.onAudio?.(speech(12000))))
  h.alive()
  h.options.onClientDisconnect?.()
  await h.options.onClientAuthenticated?.()
  const fresh = Promise.resolve(h.options.onAudio?.(speech(14000)))
  void fresh.catch(() => undefined)
  await until(() => epoch === 3)
  assert.deepEqual(received, [8000])
  recovery.resolve()
  await fresh
  assert.deepEqual(received, [8000, 14000])
  await until(() => streams === 2)
  eventReady.resolve()
  await until(() => handled.mock.calls.some(call => call.arguments[0].session_epoch === 3))
  await tick()
  h.alive()
})
