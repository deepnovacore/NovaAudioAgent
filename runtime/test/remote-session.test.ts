import assert from 'node:assert/strict'
import {test} from 'node:test'
import {setImmediate as tick} from 'node:timers/promises'
import {DesktopRealtime} from '../src/desktop-realtime.js'
import type {BridgeService} from '../src/desktop-bridge.js'
import type {DesktopServerOptions} from '../src/desktop.js'

function harness() {
  const stop = new AbortController()
  const sent: (string | Uint8Array)[] = []
  let disconnected = 0
  let playbackDisconnected = 0
  let options!: DesktopServerOptions
  let write: () => Promise<void> = () => Promise.resolve()
  const service: BridgeService = {
    executorState: 'running', sendAudio: () => Promise.resolve(), localSpeechOnset: () => Promise.resolve(),
    playbackStarted: () => true, playbackDone: () => true, playbackStopped: () => Promise.resolve(true),
    playbackCleared: () => true, projectConfirmationDecision: () => Promise.resolve(),
    executorApprovalDecision: () => true,
    playbackDisconnected: () => { playbackDisconnected++; return Promise.resolve(true) },
  }
  const realtime = new DesktopRealtime({
    token: '1'.repeat(32), stop, service, maxOutboundFrames: 1,
    transportFailure: 'disconnect',
    executor: {executor: 'codex', display_name: 'Codex'},
    createServer: input => {
      options = input
      return {
        start: () => Promise.resolve({token: input.token, host: '127.0.0.1', port: 19876}),
        close: () => Promise.reject(new Error('connection failure must not close listener')),
        disconnectClient: () => { disconnected++; options.onClientDisconnect?.(); return Promise.resolve() },
        sendText: async raw => { sent.push(raw); await write() },
        sendBinary: async raw => { sent.push(raw); await write() },
      }
    },
  })
  return {realtime, stop, sent, options, setWrite: (value: () => Promise<void>) => { write = value },
    counts: () => ({disconnected, playbackDisconnected})}
}

for (const failure of ['send', 'overflow', 'preempt-overflow'] as const) test(`remote ${failure} releases only the connection and replays state`, async () => {
  const h = harness()
  await h.options.onClientAuthenticated?.()
  await tick()
  let release!: () => void
  h.setWrite(failure === 'send' ? () => Promise.reject(new Error('transport failed'))
    : () => new Promise<void>(resolve => { release = resolve }))
  h.realtime.bridge.onAudioTerminal('work-a', 1)
  if (failure === 'overflow') {
    h.realtime.bridge.onAudioTerminal('work-a', 1)
    h.realtime.bridge.onAudioTerminal('work-a', 1)
  } else if (failure === 'preempt-overflow') {
    h.realtime.bridge.onAudioClear('work-a', 1)
    h.realtime.bridge.onAudioClear('work-a', 1)
  }
  await tick()
  assert.equal(h.stop.signal.aborted, false)
  assert.equal(h.counts().disconnected, 1)
  assert.equal(h.counts().playbackDisconnected, 1)
  release?.()
  await tick()
  h.setWrite(() => Promise.resolve())
  h.sent.length = 0
  await h.options.onClientAuthenticated?.()
  await tick()
  assert.equal(h.sent.length, 1)
  assert.match(String(h.sent[0]), /"state":"running"/u)
})

test('a rejected send from an old connection cannot disconnect its replacement', async () => {
  const h = harness()
  await h.options.onClientAuthenticated?.()
  await tick()
  let reject!: (reason: Error) => void
  h.setWrite(() => new Promise<void>((_resolve, fail) => { reject = fail }))
  h.realtime.bridge.onAudioTerminal('old', 1)
  h.options.onClientDisconnect?.()
  h.setWrite(() => Promise.resolve())
  await h.options.onClientAuthenticated?.()
  reject(new Error('old write failed late'))
  await tick()
  assert.equal(h.stop.signal.aborted, false)
  assert.equal(h.counts().disconnected, 0)
  assert.match(String(h.sent.at(-1)), /"state":"running"/u)
})

for (const failure of ['disconnect', 'send'] as const) test(`real realtime playback ${failure} preserves the worker and reconnects to the same work ID`, async t => {
  const {buildAssembly} = await import('../src/assembly.js')
  const {buildRealtimeAssembly} = await import('../src/realtime-assembly.js')
  const {buildDesktopRealtimeComposition, runDesktopEntry} = await import('../src/desktop-service.js')
  const {settingsSchema} = await import('../src/config.js')
  const {parseCapabilityRegistry} = await import('../src/capability-registry.js')
  const {VirtualClock} = await import('../src/clock.js')
  const {slowSimManifest} = await import('../src/sims.js')
  const stop = new AbortController()
  const sent: (string | Uint8Array)[] = []
  let options!: DesktopServerOptions
  let failSend = false
  let listenerCloses = 0
  let providerEpoch = 0
  let providerCloses = 0
  let providerCancels = 0
  let workerSignal: AbortSignal | undefined
  let finish!: () => void
  let launches = 0
  let endEvents!: () => void
  const core = buildAssembly({
    settings: settingsSchema.parse({executors: ['slow_sim'], model_api_key: 'test-only', workspace_graph_enabled: false}),
    capabilities: parseCapabilityRegistry({version: 1, modules: {
      search: {enabled: false}, camera: {enabled: false}, coding: {enabled: false}, knowledge: {enabled: false},
    }}),
    clock: new VirtualClock(),
    gateway: {
      complete: () => Promise.reject(new Error('no external model calls in this test')),
      async *stream() { await Promise.resolve(); throw new Error('no external model calls in this test') },
    },
    executors: [{manifest: slowSimManifest, dispatch: async (_op, _request, context) => {
      launches++
      workerSignal = context.signal
      context.progress({phase: 'started', internal_activity: 0, elapsed: 0, summary: null})
      await new Promise<void>(resolve => { finish = resolve })
      return {outcome: 'ok', trust: 'trusted_system', content: {summary: 'Finished'}}
    }}],
  })
  const coreStop = t.mock.method(core, 'stop')
  const composition = buildDesktopRealtimeComposition({token: 'a'.repeat(32), stop, transportFailure: 'disconnect',
    createServer: input => {
      options = input
      const send = (raw: string | Uint8Array): Promise<void> => {
        if (failSend) return Promise.reject(new Error('network disappeared'))
        sent.push(raw)
        return Promise.resolve()
      }
      return {
        start: () => Promise.resolve({token: input.token, host: '127.0.0.1', port: 19876}),
        close: () => { listenerCloses++; return Promise.resolve() },
        disconnectClient: () => { options.onClientDisconnect?.(); return Promise.resolve() },
        sendText: send, sendBinary: send,
      }
    },
    buildRealtime: callbacks => buildRealtimeAssembly({core, ...callbacks,
      provider: {
        connect: () => Promise.resolve({epoch: ++providerEpoch, provider_session_id: `test-session-${providerEpoch}`}),
        sendAudio: () => Promise.resolve(),
        injectHostItem: item => Promise.resolve({session_epoch: providerEpoch, host_item_id: item.host_item_id, provider_item_id: item.host_item_id}),
        createResponse: () => Promise.resolve(),
        cancelResponse: () => { providerCancels++; return Promise.resolve() },
        async *events(signal) {
          await new Promise<void>(resolve => {
            endEvents = resolve
            if (signal.aborted) resolve()
            else signal.addEventListener('abort', () => resolve(), {once: true})
          })
          // Keep the real service event loop alive until its actual owner shuts down.
          yield* []
        },
        close: () => { providerCloses++; endEvents?.(); return Promise.resolve() },
      },
    }),
  })
  let ready!: () => void
  const started = new Promise<void>(resolve => { ready = resolve })
  const running = runDesktopEntry({token: 'a'.repeat(32), stop,
    construct: () => composition,
    announce: () => { ready(); return Promise.resolve() },
    onDiagnostic: () => { /* Stable owner diagnostics are not the test's assertions. */ },
  })
  const waitFor = async (predicate: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 50 && !predicate(); attempt++) await tick()
    assert.ok(predicate(), 'real service event did not settle')
  }
  const runtime = composition.realtime.runtime
  try {
    await Promise.race([started, running.then(() => assert.fail('owner exited before readiness'))])
    await options.onClientAuthenticated?.()
    const origin = runtime.memory.append('conversation', {
      ts: 0, trust: 'trusted_user', priority: 100, content: {text: 'Perform the controlled task'},
    })
    const admission = runtime.dispatchExternal({executor: 'slow_sim', op: 'set_light', request: {room: 'office', brightness: 50},
      origin_ref: `${origin.channel}:${origin.seq}`}, {
      kind: 'realtime_tool', priority: 100, routing_class: 'ambient', origin: null, selected_suggestion: null,
    })
    assert.equal(admission.accepted, true, JSON.stringify(admission))
    await waitFor(() => workerSignal !== undefined)
    const service = composition.realtime.service
    await service.handleEvent({kind: 'response_started', session_epoch: 1, response_id: 'active-playback'})
    await service.handleEvent({kind: 'response_audio_delta', session_epoch: 1,
      response_id: 'active-playback', pcm: new Uint8Array([0, 1, 2, 3])})
    const generation = composition.realtime.session.currentGeneration
    assert.ok(generation, 'the disconnect must interrupt a real active playback generation')
    await options.onControl?.({type: 'playback.started', utterance_id: generation.utterance_id,
      generation_epoch: generation.generation_epoch})
    if (failure === 'disconnect') options.onClientDisconnect?.()
    else {
      failSend = true
      await service.handleEvent({kind: 'response_audio_delta', session_epoch: 1,
        response_id: 'active-playback', pcm: new Uint8Array([4, 5])})
    }
    await waitFor(() => providerCancels > 0 && providerEpoch === 2 && composition.realtime.session.currentGeneration === null)
    assert.equal(workerSignal!.aborted, false)
    assert.ok(runtime.inFlightDelegate(admission.delegate_id!))
    assert.equal(coreStop.mock.callCount(), 0)
    assert.equal(providerCloses, 1)
    assert.equal(listenerCloses, 0)
    assert.equal(stop.signal.aborted, false)
    failSend = false
    sent.length = 0
    await options.onClientAuthenticated?.()
    await tick()
    assert.equal(sent.some(raw => raw instanceof Uint8Array), false, 'old audio is not replayed')
    const replay = sent.filter((raw): raw is string => typeof raw === 'string')
      .map(raw => JSON.parse(raw) as {type: string; work_id?: string; result?: unknown})
    assert.ok(replay.some(frame => frame.type === 'executor.result'
      && frame.work_id === admission.delegate_id && frame.result === null))
    finish()
    await waitFor(() => runtime.inFlightDelegate(admission.delegate_id!) === undefined)
    assert.equal(launches, 1)
    assert.equal(workerSignal!.aborted, false)
    assert.equal(coreStop.mock.callCount(), 0)
    assert.equal(providerCloses, 1)
  } finally {
    finish?.()
    stop.abort()
    await running
  }
  assert.equal(coreStop.mock.callCount(), 1, 'only explicit service shutdown releases core resources')
  assert.equal(providerCloses, 2)
  assert.equal(listenerCloses, 1)
})
