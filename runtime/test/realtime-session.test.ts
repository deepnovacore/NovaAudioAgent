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
import { PlaybackRegistry } from '../src/playback.js'
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
      return Promise.resolve({session_epoch: epoch, host_item_id: item.host_item_id})
    },
    createResponse: (intent: HostResponseIntent) => {
      actions.push(`create_response:${intent.kind}`)
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
