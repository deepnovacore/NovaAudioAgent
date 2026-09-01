/**
 * Session behavior the fixture goldens cannot reach.
 *
 * The twenty-five committed scenarios pin everything a sequence of provider events and host actions
 * can observe. What they cannot express is a caller passing something malformed -- a fixture is
 * schema-validated before it runs, so an invalid value never reaches the session -- or a surface no
 * scenario drives yet. Those go here.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { VirtualClock } from '../src/clock.js'
import {
  PlaybackRegistry,
  type PlaybackCompletion,
  type PlaybackGeneration,
} from '../src/playback.js'
import { RealtimeSession, type SessionProvider } from '../src/realtime/session.js'
import type { HostContextItem, HostResponseIntent } from '../src/realtime/protocol.js'

/** Shared no-op so the two unused callbacks do not each need an empty-function exemption. */
function noop(): void {
  // Intentionally empty: these tests do not observe frames or diagnostics.
}

function makeSession(options: {readonly ids?: readonly string[]} = {}): {
  readonly session: RealtimeSession
  readonly actions: string[]
} {
  const actions: string[] = []
  const ids = [...(options.ids ?? ['generation-1', 'utterance-1', 'host-1', 'host-2'])]
  let index = 0
  const idFactory = (): string => {
    const value = ids[index]
    if (value === undefined) throw new Error('test id sequence exhausted')
    index += 1
    return value
  }
  let epoch = 0
  const provider: SessionProvider = {
    connect: () => {
      epoch += 1
      actions.push(`connect:${epoch}`)
      return Promise.resolve({epoch})
    },
    injectHostItem: (item: HostContextItem) => {
      actions.push(`inject:${item.host_item_id}`)
      return Promise.resolve({
        session_epoch: epoch,
        host_item_id: item.host_item_id,
        provider_item_id: `provider-${item.host_item_id}`,
      })
    },
    retireHostItem: (providerItemId: string) => {
      actions.push(`retire:${providerItemId}`)
      return Promise.resolve(true)
    },
    createResponse: (intent: HostResponseIntent) => {
      actions.push(`create_response:${intent.kind}`)
      return Promise.resolve()
    },
    ensureResponse: () => {
      actions.push('ensure_response')
      return Promise.resolve()
    },
    cancelResponse: (responseId: string) => {
      actions.push(`cancel:${responseId}`)
      return Promise.resolve()
    },
    close: () => {
      actions.push('close')
      return Promise.resolve()
    },
  }
  const playback = new PlaybackRegistry({
    idFactory,
    onFrame: noop,
    onClear: (utteranceId, generationEpoch) => {
      actions.push(`clear:${utteranceId}:${generationEpoch}`)
    },
    // An alert fence is a distinct message: the renderer is told the utterance was cut off, not
    // merely to drop what it has.
    onAlert: (utteranceId, generationEpoch) => {
      actions.push(`alert:${String(utteranceId)}:${String(generationEpoch)}`)
    },
  })
  const session = new RealtimeSession({
    provider,
    playback,
    idFactory,
    clock: new VirtualClock(),
    onDiagnostic: noop,
  })
  return {session, actions}
}

test('an unknown Guard history mode is refused before the session is touched', async () => {
  // This method closes the provider session, so a malformed argument has to fail before anything is
  // given up rather than after. The TypeScript annotation is not the guard: a value arriving from
  // JSON is unchecked at runtime, which is exactly how a service would pass one.
  const {session, actions} = makeSession()
  await session.connect({tools: []})
  const before = actions.length

  await assert.rejects(
    () => session.reconnectForGuard({
      tools: [],
      oldGeneration: {
        session_epoch: 1,
        generation_epoch: 1,
        generation_id: 'generation-1',
        utterance_id: 'utterance-1',
        response_id: 'resp-1',
      },
      historyMode: 'bogus' as 'none',
    }),
    /unknown Guard history recovery arm/u,
  )
  assert.deepEqual(actions.slice(before), [], 'no provider call may have happened')
  assert.equal(session.sessionEpoch, 1, 'the epoch must not have advanced')
})

test('a Guard handoff refuses a generation the session did not open', async () => {
  const {session} = makeSession()
  await session.connect({tools: []})

  await assert.rejects(
    () => session.reconnectForGuard({
      tools: [],
      oldGeneration: {
        session_epoch: 1,
        generation_epoch: 1,
        generation_id: 'never-opened',
        utterance_id: 'utterance-1',
        response_id: 'resp-1',
      },
    }),
    /known playback generation/u,
  )
})

test('a Guard handoff refuses a generation from a previous session', async () => {
  const {session} = makeSession()
  await session.connect({tools: []})

  await assert.rejects(
    () => session.reconnectForGuard({
      tools: [],
      oldGeneration: {
        session_epoch: 0,
        generation_epoch: 1,
        generation_id: 'generation-1',
        utterance_id: 'utterance-1',
        response_id: 'resp-1',
      },
    }),
    /current session/u,
  )
})

test('a registered delegate reaches the snapshot the recovery item is built from', async () => {
  // A reconnect tells the new provider what work is still running. Without a session-level way to
  // register a delegate, that recovery would claim no active work and the model would lose the
  // context for whatever it is asked next.
  // No playback happens here, so the recovery item is the first id anything asks for.
  const {session, actions} = makeSession({ids: ['recovery-1']})
  await session.connect({tools: []})
  const before = session.snapshot().version

  session.registerDelegate('d-1', {summary: '跑测试', state: 'running'})
  assert.equal(session.delegateState('d-1'), 'running')
  assert.ok(session.snapshot().version > before, 'registering publishes')
  assert.deepEqual(
    session.snapshot().active_delegates.map(([id]) => id),
    ['d-1'],
  )

  await session.reconnect({tools: []})
  assert.deepEqual(actions.slice(-3), ['close', 'connect:2', 'inject:recovery-1'])
  // The delegate survives the reconnect: the work is still running, only the provider changed.
  assert.equal(session.delegateState('d-1'), 'running')
})

test('a completed delegate is history, not active work', () => {
  const {session} = makeSession()
  session.registerDelegate('d-1', {summary: '跑测试', state: 'completed'})
  assert.equal(session.delegateState('d-1'), 'completed')
  assert.deepEqual(session.snapshot().active_delegates, [])
})

test('settling a user response requires the current user input revision', async () => {
  const {session} = makeSession()
  await session.connect({tools: []})
  await session.accept({
    kind: 'user_speech_started', session_epoch: 1,
    speech_id: 'speech-1', provider_item_id: 'user-1',
  })
  await session.accept({
    kind: 'user_speech_ended', session_epoch: 1,
    speech_id: 'speech-1', provider_item_id: 'user-1',
  })
  await session.accept({kind: 'response_started', session_epoch: 1, response_id: 'response-1'})
  await session.accept({
    kind: 'response_terminal', session_epoch: 1, response_id: 'response-1',
    status: 'completed', reason: '',
  })
  await session.accept({
    kind: 'user_transcript_final', session_epoch: 1, item_id: 'user-1', text: '确认',
  })
  assert.equal(session.settleUserResponse('unknown-response'), false)
  assert.equal(session.providerIdle, false, 'an unknown response cannot clear the debt')

  await session.accept({
    kind: 'user_speech_started', session_epoch: 1,
    speech_id: 'speech-2', provider_item_id: 'user-2',
  })
  await session.accept({
    kind: 'user_speech_ended', session_epoch: 1,
    speech_id: 'speech-2', provider_item_id: 'user-2',
  })
  await session.accept({kind: 'response_started', session_epoch: 1, response_id: 'response-2'})
  await session.accept({
    kind: 'response_terminal', session_epoch: 1, response_id: 'response-2',
    status: 'completed', reason: '',
  })
  await session.accept({
    kind: 'user_transcript_final', session_epoch: 1, item_id: 'user-2', text: '确认',
  })

  assert.equal(session.settleUserResponse('response-1'), false)
  assert.equal(session.providerIdle, false, 'a stale response cannot clear the newer debt')
  assert.equal(session.settleUserResponse('response-2'), true)
  assert.equal(session.providerIdle, true, 'the exact current response settles its debt')
  assert.equal(session.settleUserResponse('response-2'), false, 'one debt settles only once')
})

test('settling a response from an old provider epoch cannot clear current debt', async () => {
  const {session} = makeSession({ids: ['recovery-1']})
  await session.connect({tools: []})
  await session.accept({
    kind: 'user_speech_started', session_epoch: 1,
    speech_id: 'speech-old', provider_item_id: 'user-old',
  })
  await session.accept({
    kind: 'user_speech_ended', session_epoch: 1,
    speech_id: 'speech-old', provider_item_id: 'user-old',
  })
  await session.accept({kind: 'response_started', session_epoch: 1, response_id: 'response-old'})
  await session.accept({
    kind: 'response_terminal', session_epoch: 1, response_id: 'response-old',
    status: 'completed', reason: '',
  })
  await session.accept({
    kind: 'user_transcript_final', session_epoch: 1, item_id: 'user-old', text: '确认',
  })
  assert.equal(session.settleUserResponse('response-old'), true)

  await session.reconnect({tools: []})
  assert.equal(await session.requestUserResponse(), true)
  assert.equal(session.providerIdle, false)
  assert.equal(session.settleUserResponse('response-old'), false)
  assert.equal(session.providerIdle, false, 'an old epoch response cannot release the retry debt')
})

test('a tool continuation with no intents is a caller error, not a refusal', async () => {
  // `retryable` and `rejected` are answers about the session's state. An empty batch is neither:
  // there is nothing to narrate, so the caller asked the wrong question.
  const {session} = makeSession()
  await session.connect({tools: []})
  await assert.rejects(
    () => session.requestToolContinuation([]),
    /at least one intent/u,
  )
})

test('a tool continuation refuses an intent that is not tool output', async () => {
  const {session} = makeSession()
  await session.connect({tools: []})
  await assert.rejects(
    () => session.requestToolContinuation([{
      kind: 'host_fact',
      item: {
        kind: 'progress',
        host_item_id: 'host-1',
        event_id: 'progress:1',
        content: '在跑。',
        call_id: null,
      },
      task_summary: null,
      origin_spoken: false,
    }]),
    /requires tool output/u,
  )
})

test('a tool continuation refuses output the provider never confirmed', async () => {
  // Continuing on an unconfirmed item would narrate a fact the provider does not have, so this is
  // an error rather than a retry: waiting cannot make the item confirmed.
  const {session} = makeSession()
  await session.connect({tools: []})
  await assert.rejects(
    () => session.requestToolContinuation([{
      kind: 'tool_result',
      item: {
        kind: 'tool_output',
        host_item_id: 'host-1',
        event_id: 'background:1',
        content: '结果',
        call_id: 'call-1',
      },
      task_summary: null,
      origin_spoken: false,
    }]),
    /confirmed before continuation/u,
  )
})

test('injecting a non-tool-output item through the tool path is refused', async () => {
  const {session} = makeSession()
  await session.connect({tools: []})
  await assert.rejects(
    () => session.injectToolOutput({
      kind: 'progress',
      host_item_id: 'host-1',
      event_id: 'progress:1',
      content: '在跑。',
      call_id: null,
    }),
    /bypass host response gating/u,
  )
})

test('retiring an injected host event deletes its exact provider item and releases injection', async () => {
  const {session, actions} = makeSession()
  await session.connect({tools: []})
  const item: HostContextItem = {
    kind: 'tool_output',
    host_item_id: 'host-1',
    event_id: 'background:1',
    content: '结果',
    call_id: 'call-1',
  }

  assert.equal(await session.injectToolOutput(item), true)
  assert.equal(await session.retireHostEvent(item.event_id), true)
  assert.equal(await session.injectToolOutput(item), true)
  assert.deepEqual(actions, [
    'connect:1',
    'inject:host-1',
    'retire:provider-host-1',
    'inject:host-1',
  ])
})

test('a host response delivered while the foreground is busy is an error, not a refusal', async () => {
  // A refusal would tell the caller the event was handled. It was not: the caller has to decide
  // whether to queue it, and silently dropping it loses the event.
  const {session} = makeSession()
  await session.connect({tools: []})
  const item: HostContextItem = {
    kind: 'progress',
    host_item_id: 'host-1',
    event_id: 'progress:1',
    content: '第一步。',
    call_id: null,
  }
  await session.deliverHostItem(item)

  await assert.rejects(
    () => session.deliverHostItem({
      kind: 'progress',
      host_item_id: 'host-2',
      event_id: 'progress:2',
      content: '第二步。',
      call_id: null,
    }),
    /foreground became busy/u,
  )
})

test('a host fact cannot be built from tool output or dialogue context', async () => {
  const {session} = makeSession()
  await session.connect({tools: []})
  for (const kind of ['tool_output', 'dialogue_context'] as const) {
    await assert.rejects(
      () => session.deliverHostItem({
        kind,
        host_item_id: 'host-1',
        event_id: 'event-1',
        content: '内容',
        call_id: kind === 'tool_output' ? 'call-1' : null,
      }),
      /cannot|must not/u,
      `${kind} must not become a host fact`,
    )
  }
})

/** Drive a response to the point where it owns a renderer generation. */
async function withPlayingResponse(): Promise<{
  readonly session: RealtimeSession
  readonly actions: string[]
  readonly generation: PlaybackGeneration
}> {
  const {session, actions} = makeSession({
    // Two ids per generation, plus a recovery item for the tests that reconnect.
    ids: ['generation-1', 'utterance-1', 'recovery-1', 'generation-2', 'utterance-2'],
  })
  await session.connect({tools: []})
  await session.deliverHostItem({
    kind: 'progress',
    host_item_id: 'host-1',
    event_id: 'progress:1',
    content: '第一步。',
    call_id: null,
  })
  await session.accept({kind: 'response_started', session_epoch: 1, response_id: 'resp-1'})
  await session.accept({
    kind: 'response_audio_delta',
    session_epoch: 1,
    response_id: 'resp-1',
    pcm: new Uint8Array([0, 1, 2, 3]),
  })
  session.playbackStarted('utterance-1', 1)
  const generation = session.currentGeneration
  if (generation === null) throw new Error('the response should own a generation')
  return {session, actions, generation}
}

test('a deferred preempt fence is spent by expiring it, and only once', async () => {
  // `hostPreempt` cancels the provider but leaves the audio playing. Expiring is where that debt is
  // settled: an alert fence, so the renderer says it was interrupted rather than just stopping.
  const {session, actions, generation} = await withPlayingResponse()
  assert.equal(await session.hostPreempt(), true)
  assert.equal(session.providerTurnPhase('resp-1'), 'cancel_requested')
  assert.equal(session.currentGeneration, generation, 'the audio is still playing')

  assert.equal(session.expireHostPreempt(generation), true)
  assert.equal(session.currentGeneration, null, 'the fence has now landed')
  assert.ok(actions.includes('alert:utterance-1:1'), 'the renderer is told it was interrupted')
  // The deferral is spent. Clearing it is what stops the *next* generation being fenced by a debt
  // that was already settled, so that is what has to be observable.
  assert.equal(session.providerTurnPhase('resp-1'), 'cancel_requested')
  assert.equal(session.expireHostPreempt(generation), false)

  // The preempted response keeps the provider slot until its own terminal, so a replacement cannot
  // start before that arrives.
  await session.accept({
    kind: 'response_terminal',
    session_epoch: 1,
    response_id: 'resp-1',
    status: 'cancelled',
    reason: 'host_preempt',
  })
  // The fence it just landed is still unreported, so the foreground is not idle. Delivering
  // preemptively is the path that does not wait for the renderer, which is the point of it.
  await session.deliverPreemptiveHostResponse({
    kind: 'host_fact',
    item: {
      kind: 'progress',
      host_item_id: 'host-2',
      event_id: 'progress:2',
      content: '第二步。',
      call_id: null,
    },
    task_summary: null,
    origin_spoken: false,
  })
  await session.accept({kind: 'response_started', session_epoch: 1, response_id: 'resp-2'})
  await session.accept({
    kind: 'response_audio_delta',
    session_epoch: 1,
    response_id: 'resp-2',
    pcm: new Uint8Array([4, 5]),
  })
  const replacement = session.currentGeneration
  assert.notEqual(replacement, null, 'a new response opened a new generation')
  assert.equal(session.expireHostPreempt(replacement), false, 'the spent debt cannot fence again')
  assert.equal(session.currentGeneration, replacement, 'the new generation survives')
})

test('an expired preempt leaves no deferral for the terminal to act on', async () => {
  // The deferral is observable, through the snapshot version. A terminal on a response whose
  // deferral was already spent takes the plain path and publishes nothing; one that still sees the
  // flag set takes the defer path and publishes. Sampling the version either side of the terminal
  // separates them -- the state afterwards is identical, which is why this first looked untestable.
  const {session, generation} = await withPlayingResponse()
  await session.hostPreempt()
  assert.equal(session.expireHostPreempt(generation), true)

  const beforeTerminal = session.snapshot().version
  await session.accept({
    kind: 'response_terminal',
    session_epoch: 1,
    response_id: 'resp-1',
    status: 'cancelled',
    reason: 'host_preempt',
  })
  assert.equal(
    session.snapshot().version,
    beforeTerminal,
    'the terminal took the plain path, which publishes nothing',
  )
})

test('expiring a preempt for a generation that is not current does not fence anything', async () => {
  const {session, generation} = await withPlayingResponse()
  await session.hostPreempt()

  const other: PlaybackGeneration = {...generation, generation_id: 'other', utterance_id: 'other'}
  // The deferral is still consumed -- it named this response -- but no fence lands on a generation
  // the preempt was not aimed at.
  assert.equal(session.expireHostPreempt(other), true)
  assert.equal(session.currentGeneration, generation, 'the wrong generation was left alone')
})

test('expiring with no preempt outstanding is refused', async () => {
  const {session} = await withPlayingResponse()
  assert.equal(session.expireHostPreempt(null), false)
  assert.equal(session.expireHostPreempt(session.currentGeneration), false)
})

test('a Guard handoff generation can be alert-fenced exactly once', async () => {
  const {session, actions, generation} = await withPlayingResponse()
  await session.reconnectForGuard({tools: [], oldGeneration: generation})
  // The retained generation is still playing under the new provider session.
  assert.equal(session.currentGeneration, generation)

  assert.equal(session.alertGuardHandoff(generation), true)
  assert.ok(actions.includes('alert:utterance-1:1'), 'the retained generation is alert-fenced')
  assert.equal(session.alertGuardHandoff(generation), false, 'the handoff is spent')
})

test('alerting a generation that was never handed off is refused', async () => {
  const {session, generation} = await withPlayingResponse()
  assert.equal(session.alertGuardHandoff(generation), false, 'no handoff is in progress')
})

test('a Guard handoff alert names one exact generation, not whichever is retained', async () => {
  // The check has to be reached with *nothing* current, which is what a live handoff produces once
  // the retained audio finishes: the generation is retired but the handoff is still recorded. With
  // something current, a mismatched generation is refused for a different reason and the
  // exact-match check would look redundant.
  const {session, generation} = await withPlayingResponse()
  await session.reconnectForGuard({tools: [], oldGeneration: generation})
  assert.equal(
    session.playbackDone(generation.utterance_id, generation.generation_epoch, 100),
    true,
  )
  assert.equal(session.currentGeneration, null, 'the retained audio has finished')

  const other: PlaybackGeneration = {...generation, generation_id: 'other', utterance_id: 'other'}
  const before = session.snapshot().version
  assert.equal(session.alertGuardHandoff(other), false, 'a different generation is not it')
  assert.equal(session.snapshot().version, before, 'and nothing was published')
  // The handoff must still be there for the generation it actually names.
  assert.equal(session.alertGuardHandoff(generation), true, 'the real one still works')
})

test('retiring an unaccountable clear frees the slot without inventing a delivery', async () => {
  // The renderer cleared something the session cannot account for. Retiring must not produce a
  // completion: nobody knows whether, or how much of it, was heard.
  const deliveries: PlaybackCompletion[] = []
  const actions: string[] = []
  const ids = ['generation-1', 'utterance-1']
  let index = 0
  const idFactory = (): string => {
    const value = ids[index]
    if (value === undefined) throw new Error('test id sequence exhausted')
    index += 1
    return value
  }
  const playback = new PlaybackRegistry({idFactory, onFrame: noop, onClear: noop})
  const session = new RealtimeSession({
    provider: {
      connect: () => Promise.resolve({epoch: 1}),
      injectHostItem: (item: HostContextItem) =>
        Promise.resolve({session_epoch: 1, host_item_id: item.host_item_id}),
      createResponse: () => Promise.resolve(),
      cancelResponse: (responseId: string) => {
        actions.push(`cancel:${responseId}`)
        return Promise.resolve()
      },
      close: () => Promise.resolve(),
    },
    playback,
    idFactory,
    clock: new VirtualClock(),
    onDelivery: completion => {
      deliveries.push(completion)
    },
    onDiagnostic: noop,
  })
  await session.connect({tools: []})
  await session.deliverHostItem({
    kind: 'progress',
    host_item_id: 'host-1',
    event_id: 'progress:1',
    content: '在跑。',
    call_id: null,
  })
  await session.accept({kind: 'response_started', session_epoch: 1, response_id: 'resp-1'})
  await session.accept({
    kind: 'response_audio_delta',
    session_epoch: 1,
    response_id: 'resp-1',
    pcm: new Uint8Array([0, 1]),
  })
  const generation = session.currentGeneration
  if (generation === null) throw new Error('the response should own a generation')
  await session.localSpeechOnset('local-1')

  assert.equal(session.retirePlaybackClearUnknown(generation), true)
  assert.deepEqual(deliveries, [], 'no delivery evidence may be fabricated')
  assert.equal(session.retirePlaybackClearUnknown(generation), false, 'already retired')
})

test('waiting for a stale hold returns at once when no hold is active', async () => {
  const {session} = makeSession()
  await session.connect({tools: []})
  assert.equal(await session.waitForStaleHold(10), false)
})

test('waiting for a stale hold sleeps past the deadline, then the release succeeds', async () => {
  // The wait is bounded by the injected clock, so a wrong premise fails in milliseconds rather than
  // hanging the suite.
  const clock = new VirtualClock()
  const ids = ['generation-1']
  let index = 0
  const session = new RealtimeSession({
    provider: {
      connect: () => Promise.resolve({epoch: 1}),
      injectHostItem: (item: HostContextItem) =>
        Promise.resolve({session_epoch: 1, host_item_id: item.host_item_id}),
      createResponse: () => Promise.resolve(),
      cancelResponse: () => Promise.resolve(),
      close: () => Promise.resolve(),
    },
    playback: new PlaybackRegistry({
      idFactory: () => ids[index++] ?? 'extra',
      onFrame: noop,
      onClear: noop,
    }),
    idFactory: () => 'host-1',
    clock,
    onDiagnostic: noop,
  })
  await session.connect({tools: []})
  await session.accept({
    kind: 'user_speech_started',
    session_epoch: 1,
    speech_id: 'speech-1',
    provider_item_id: null,
  })

  const waiting = session.waitForStaleHold(10)
  // The margin is directly observable: ask the clock when the timer is due. It has to be *past* the
  // deadline, because the release comparison is strict -- waking exactly on 10 would find the hold
  // not yet stale and the caller would spin. Racing an already-resolved promise cannot show this:
  // it reports "still waiting" whenever the continuation is merely queued.
  assert.equal(clock.nextTimerTimestamp(), 10.05, 'the wait must be due after the deadline')

  clock.advanceTo(10.05)
  assert.equal(await waiting, true)
  assert.equal(session.releaseStaleUserHold(10), true, 'the deadline has now passed')
  assert.equal(session.floor.state, 'idle')
})
