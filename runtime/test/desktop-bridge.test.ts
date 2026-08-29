/**
 * The desktop socket bridge: four outbound queues, and the rules that make them worth separating.
 *
 * The renderer is one websocket and the runtime is a state machine. Everything here is about the
 * mismatch: a socket that can block, a queue that can fill, and audio that becomes wrong the instant
 * the agent is interrupted. These are Node-only tests — the queue structure is `asyncio.Queue` in the
 * oracle and arrays here, so a shared golden would compare two schedulers rather than two behaviours.
 * The *wire format* those queues carry is pinned by `desktop-wire.test.ts` against the Python golden.
 */

import assert from 'node:assert/strict'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import { test } from 'node:test'
import { VirtualClock } from '../src/clock.js'
import {
  DesktopSocketBridge,
  type BridgeService,
  type DesktopBridgeOptions,
} from '../src/desktop-bridge.js'
import { DesktopProtocolError, encodeAudioFrame } from '../src/desktop-wire.js'
import type { CodexState } from '../src/realtime/service-state.js'
import type { JsonValue } from '../src/events.js'
import type { RealtimeTelemetry } from '../src/realtime/telemetry.js'
import {JsonlTelemetry} from '../src/realtime/telemetry.js'

interface TelemetryRecord {
  readonly kind: string
  readonly payload: Readonly<Record<string, JsonValue>>
}

/**
 * A telemetry sink that keeps what it is handed.
 *
 * The production sinks either discard or write to a file, and neither is inspectable — but what the
 * bridge *chooses* to record is behaviour: the first-frame timing, the clear, the clock sample.
 */
class RecordingTelemetry implements RealtimeTelemetry {
  readonly records: TelemetryRecord[] = []

  record(kind: string, payload: Readonly<Record<string, JsonValue>>): void {
    this.records.push({kind, payload})
  }

  close(): void {
    // Nothing to release.
  }
}

const TOKEN = '0'.repeat(32)

interface Harness {
  readonly bridge: DesktopSocketBridge
  readonly stopped: () => boolean
  readonly calls: string[]
  readonly clock: VirtualClock
  readonly telemetry: RecordingTelemetry
}

function harness(
  overrides: Partial<DesktopBridgeOptions> & {
    readonly codexState?: CodexState
    /** Drop the clock entirely, which is what makes telemetry inert. */
    readonly withoutClock?: boolean
  } = {},
): Harness {
  const calls: string[] = []
  let aborted = false
  const clock = new VirtualClock()
  const telemetry = new RecordingTelemetry()
  const service: BridgeService = {
    codexState: overrides.codexState ?? 'idle',
    sendAudio: (pcm) => {
      calls.push(`sendAudio:${pcm.length}`)
      return Promise.resolve()
    },
    localSpeechOnset: (speechId) => {
      calls.push(`onset:${speechId}`)
      return Promise.resolve()
    },
    playbackStarted: (utteranceId, epoch) => {
      calls.push(`started:${utteranceId}:${epoch}`)
      return true
    },
    playbackDone: (utteranceId, epoch, playedMs) => {
      calls.push(`done:${utteranceId}:${epoch}:${playedMs ?? 'null'}`)
      return true
    },
    playbackStopped: (utteranceId, epoch, playedMs) => {
      calls.push(`stopped:${utteranceId}:${epoch}:${playedMs ?? 'null'}`)
      return Promise.resolve(true)
    },
    playbackCleared: (utteranceId, epoch, playedMs) => {
      calls.push(`cleared:${utteranceId}:${epoch}:${playedMs ?? 'null'}`)
      return true
    },
    projectConfirmationDecision: (proposalId, confirmed) => {
      calls.push(`project-decision:${proposalId}:${confirmed}`)
      return Promise.resolve()
    },
  }
  const {withoutClock, codexState, ...bridgeOverrides} = overrides
  // Consumed above as the service's initial state; not a bridge option.
  void codexState
  const bridge = new DesktopSocketBridge({
    token: TOKEN,
    service,
    stop: {abort: () => {
      aborted = true
    }},
    // Spread rather than assigned undefined: `exactOptionalPropertyTypes` distinguishes an absent
    // optional from one explicitly undefined, and "no clock" is the former.
    ...(withoutClock === true ? {} : {clock}),
    telemetry,
    ...bridgeOverrides,
  })
  return {bridge, stopped: () => aborted, calls, clock, telemetry}
}

function frame(epoch: number, sequence: number): Parameters<DesktopSocketBridge['onAudioFrame']>[0] {
  return {
    utterance_id: `u-${epoch}`,
    generation_epoch: epoch,
    sequence,
    pcm: new Uint8Array([0, 1]),
  }
}

test('a token that is not 128 bits of hex is refused at construction', () => {
  for (const token of ['', '0'.repeat(31), '0'.repeat(33), 'g'.repeat(32), '0'.repeat(16)]) {
    assert.throws(
      () => harness({token}),
      /desktop token must be 128-bit hexadecimal/u,
      `token length ${token.length}`,
    )
  }
  assert.doesNotThrow(() => harness({token: 'abcdefABCDEF0123456789abcdefABCD'}))
})

test('a clear overtakes the audio it cancels', () => {
  // A clear that queued behind two seconds of stale PCM is two seconds of the user hearing something
  // the agent has already abandoned. That is the whole reason for a second queue.
  const {bridge} = harness()
  bridge.onAudioFrame(frame(1, 0))
  bridge.onAudioFrame(frame(1, 1))
  bridge.onAudioClear('u-1', 1)
  const first = bridge.takeNextFrame()
  assert.equal(typeof first, 'string', 'the clear comes out first')
  assert.ok(String(first).startsWith('{"type":"playback.clear"'))
})

test('audio for a cleared generation is dropped on the way out, not on the way in', () => {
  // The fence rises *after* the audio is queued — a clear is exactly what raises it — so filtering at
  // enqueue time would miss every frame already waiting.
  const {bridge} = harness()
  bridge.onAudioFrame(frame(1, 0))
  bridge.onAudioFrame(frame(1, 1))
  bridge.onAudioFrame(frame(2, 0))
  bridge.onAudioClear('u-1', 1)
  assert.equal(bridge.fencedGenerationEpoch, 1)

  // The clear, then the *newer* generation's audio. Generation 1's frames are gone.
  assert.ok(String(bridge.takeNextFrame()).startsWith('{"type":"playback.clear"'))
  const audio = bridge.takeNextFrame()
  assert.ok(audio instanceof Uint8Array, 'audio, not text')
  assert.equal(bridge.takeNextFrame(), null, 'and nothing stale behind it')
})

test('the fence only rises, so a late clear for an older generation cannot un-fence a newer one', () => {
  const {bridge} = harness()
  bridge.onAudioClear('u-5', 5)
  assert.equal(bridge.fencedGenerationEpoch, 5)
  bridge.onAudioClear('u-2', 2)
  assert.equal(bridge.fencedGenerationEpoch, 5, 'still 5')
})

test('an alert fences even when it carries no generation', () => {
  // An alert means the agent's audio is not reaching the user. Continuing to send it would be sending
  // sound nobody hears into a turn that has already gone wrong.
  const {bridge} = harness()
  bridge.onCaption({role: 'assistant', text: 'hello', final: false})
  bridge.onAudioAlert(null, null)
  // The alert comes out on the preempt queue.
  assert.ok(String(bridge.takeNextFrame()).startsWith('{"type":"playback.alert"'))
  // And the assistant caption queued before it is now stale.
  assert.equal(bridge.takeNextFrame(), null)
})

test('a user caption is never fenced by a clear about the agent audio', () => {
  // A fence says the *agent* stopped talking. What the user said is unaffected, and dropping it would
  // lose transcript the renderer has no other source for.
  const {bridge} = harness()
  bridge.onCaption({role: 'user', text: 'compile it', final: true})
  bridge.onCaption({role: 'assistant', text: 'starting', final: false})
  bridge.onAudioClear('u-1', 1)
  assert.ok(String(bridge.takeNextFrame()).startsWith('{"type":"playback.clear"'))
  const caption = bridge.takeNextFrame()
  assert.ok(String(caption).includes('"role":"user"'), 'the user caption survives')
  assert.equal(bridge.takeNextFrame(), null, 'the assistant one does not')
})

test('a terminal for a cleared generation is dropped', () => {
  const {bridge} = harness()
  bridge.onAudioTerminal('u-1', 1)
  bridge.onAudioTerminal('u-2', 2)
  bridge.onAudioClear('u-1', 1)
  assert.ok(String(bridge.takeNextFrame()).startsWith('{"type":"playback.clear"'))
  const survivor = bridge.takeNextFrame()
  assert.ok(String(survivor).includes('"generation_epoch":2'), 'only the newer terminal')
  assert.equal(bridge.takeNextFrame(), null)
})

test('an overflowing audio queue stops the transport, and an overflowing caption does not', () => {
  // A dropped audio frame leaves the renderer's picture of playback wrong in a way it cannot detect. A
  // dropped caption is a cosmetic gap.
  const audio = harness({maxOutboundFrames: 2})
  audio.bridge.onAudioFrame(frame(1, 0))
  audio.bridge.onAudioFrame(frame(1, 1))
  assert.equal(audio.stopped(), false)
  audio.bridge.onAudioFrame(frame(1, 2))
  assert.equal(audio.stopped(), true, 'a lost audio frame is not survivable')

  const caption = harness({maxOutboundFrames: 2})
  caption.bridge.onCaption({role: 'user', text: 'a', final: false})
  caption.bridge.onCaption({role: 'user', text: 'b', final: false})
  caption.bridge.onCaption({role: 'user', text: 'c', final: false})
  assert.equal(caption.stopped(), false, 'a lost caption is')
})

test('an overflowing preempt queue always stops the transport', () => {
  // A clear that does not arrive means the user keeps hearing an abandoned turn, so there is no
  // droppable case here at all.
  const {bridge, stopped} = harness({maxOutboundFrames: 1})
  bridge.onAudioClear('u-1', 1)
  assert.equal(stopped(), false)
  bridge.onAudioClear('u-2', 2)
  assert.equal(stopped(), true)
})

test('outbound availability is announced only after a frame is actually queued', () => {
  let available = 0
  const {bridge} = harness({
    onOutboundAvailable: () => { available += 1 },
    maxOutboundFrames: 1,
  })

  bridge.onAudioFrame(frame(1, 0))
  assert.equal(available, 1, 'the queued frame wakes a drain')
  bridge.onCaption({role: 'user', text: 'dropped', final: false})
  assert.equal(available, 1, 'an overflowed droppable frame does not announce unavailable work')
})

test('delivery envelopes identify required, droppable, and latest policy without parsing frames', () => {
  const {bridge} = harness({projectView: {
    workspace_display_name: 'project',
    session_title: null,
    pending_confirmation: false,
    pending_confirmation_busy: false,
  }})
  bridge.onAudioFrame(frame(1, 0))
  bridge.onCaption({role: 'user', text: 'caption', final: true})
  bridge.markAuthenticated()

  assert.equal(bridge.takeNextDelivery()?.policy, 'required')
  assert.equal(bridge.takeNextDelivery()?.policy, 'droppable')
  assert.equal(bridge.takeNextDelivery()?.policy, 'latest')
  assert.equal(bridge.takeNextDelivery()?.policy, 'latest')
})

test('typed audio and controls route once through the same bridge behavior', async () => {
  const {bridge, calls} = harness()

  await bridge.receiveAudio(new Uint8Array([0, 1, 2, 3]))
  await bridge.receiveControl({type: 'speech.onset', speech_id: 's-typed'})
  await bridge.receiveControl({
    type: 'playback.stopped',
    utterance_id: 'u-typed',
    generation_epoch: 4,
    played_ms: 25,
  })
  assert.deepEqual(calls, [
    'sendAudio:4',
    'onset:s-typed',
    'stopped:u-typed:4:25',
  ])
})

test('the Codex state queue holds only the latest', () => {
  // A backlog of stale states is worse than none: the renderer would show `running` after the work
  // finished, briefly, for no reason.
  const {bridge} = harness()
  bridge.markAuthenticated()
  bridge.onCodexState('running')
  bridge.onCodexState('idle')
  bridge.onCodexState('running')
  assert.equal(bridge.pendingCounts.codex, true)
  assert.equal(bridge.takeNextFrame(), '{"type":"codex.state","state":"running"}')
  assert.equal(bridge.takeNextFrame(), null, 'the intermediate states are not sent')
})

test('nothing is queued for an unauthenticated connection', () => {
  // Until the renderer has proven itself, it gets no state at all.
  const {bridge} = harness()
  bridge.onCodexState('running')
  assert.equal(bridge.pendingCounts.codex, false)
  bridge.markAuthenticated()
  assert.equal(bridge.pendingCounts.codex, true, 'and then it does')
})

test('a state already sent is not sent again', () => {
  const {bridge} = harness()
  bridge.markAuthenticated()
  bridge.onCodexState('running')
  assert.equal(bridge.takeNextFrame(), '{"type":"codex.state","state":"running"}')
  bridge.onCodexState('running')
  assert.equal(bridge.takeNextFrame(), null)
})

test('releasing forgets what the previous renderer was told', () => {
  // The next renderer has been told nothing. Without resetting, it would never receive the current
  // state, having "already been sent" it.
  const {bridge} = harness()
  bridge.markAuthenticated()
  bridge.onCodexState('running')
  assert.ok(bridge.takeNextFrame() !== null)
  bridge.release()
  assert.equal(bridge.claim(), true, 'a new renderer may connect')
  bridge.markAuthenticated()
  assert.equal(
    bridge.takeNextFrame(),
    '{"type":"codex.state","state":"running"}',
    'and is told the current state',
  )
})

test('only one renderer may hold the connection', () => {
  const {bridge} = harness()
  assert.equal(bridge.claim(), true)
  assert.equal(bridge.claim(), false, 'a second is refused rather than replacing the first')
  bridge.release()
  assert.equal(bridge.claim(), true)
})

test('the project view is deduplicated by value, not by identity', () => {
  // The service rebuilds the view object on every change, so identity would make every publish look
  // new and the renderer would redraw constantly.
  const {bridge} = harness()
  bridge.markAuthenticated()
  // Authenticating queues the current Codex state, and the state queue is drained before the project
  // one -- so it has to come out first before this test can see the project frames at all.
  assert.equal(bridge.takeNextFrame(), '{"type":"codex.state","state":"idle"}')
  bridge.onCodexProject({
    workspace_display_name: '研究项目',
    session_title: null,
    pending_confirmation: false,
    pending_confirmation_busy: false,
  })
  assert.ok(String(bridge.takeNextFrame()).startsWith('{"type":"codex.project"'))
  bridge.onCodexProject({
    workspace_display_name: '研究项目',
    session_title: null,
    pending_confirmation: false,
    pending_confirmation_busy: false,
  })
  assert.equal(bridge.takeNextFrame(), null, 'an equal view is not resent')
  bridge.onCodexProject({
    workspace_display_name: '研究项目',
    session_title: null,
    pending_confirmation: true,
    pending_confirmation_busy: false,
    pending_action: 'create_workspace',
    pending_workspace_display_name: 'tetris-game',
    pending_session_title: null,
    pending_expires_in_seconds: 90,
  })
  assert.ok(
    String(bridge.takeNextFrame()).includes('"pending_confirmation":true'),
    'a changed one is',
  )
  bridge.onCodexProject({
    workspace_display_name: '研究项目',
    session_title: null,
    pending_confirmation: true,
    pending_confirmation_busy: false,
    pending_action: 'select_workspace',
    pending_workspace_display_name: 'beta',
    pending_session_title: null,
    pending_expires_in_seconds: 75,
  })
  assert.ok(
    String(bridge.takeNextFrame()).includes('"pending_workspace_display_name":"beta"'),
    'a changed pending target is resent',
  )
})

test('microphone PCM reaches the service, and a misaligned frame does not', async () => {
  const {bridge, calls} = harness()
  await bridge.receive(new Uint8Array([0, 1, 2, 3]), {authenticated: true})
  assert.deepEqual(calls, ['sendAudio:4'])
  await assert.rejects(
    () => bridge.receive(new Uint8Array([0, 1, 2]), {authenticated: true}),
    DesktopProtocolError,
  )
  assert.deepEqual(calls, ['sendAudio:4'], 'and nothing reached the service')
})

test('an unauthenticated connection can only say hello', async () => {
  const {bridge, calls} = harness()
  await assert.rejects(
    () => bridge.receive(new Uint8Array([0, 1]), {authenticated: false}),
    /desktop authentication frame must be text/u,
  )
  await assert.rejects(
    () => bridge.receive(
      '{"type":"playback.started","utterance_id":"u-1","generation_epoch":1}',
      {authenticated: false},
    ),
    /desktop authentication failed/u,
  )
  assert.deepEqual(calls, [], 'nothing reached the service on an unproven connection')
  await bridge.receive(`{"type":"hello","token":"${TOKEN}"}`, {authenticated: false})
})

test('each renderer control frame reaches its service call', async () => {
  const {bridge, calls} = harness()
  for (const raw of [
    '{"type":"speech.onset","speech_id":"s-1"}',
    '{"type":"playback.started","utterance_id":"u-1","generation_epoch":1}',
    '{"type":"playback.done","utterance_id":"u-1","generation_epoch":1,"played_ms":40}',
    '{"type":"playback.stopped","utterance_id":"u-1","generation_epoch":1}',
    '{"type":"playback.cleared","utterance_id":"u-1","generation_epoch":1,"played_ms":0}',
  ]) {
    await bridge.receive(raw, {authenticated: true})
  }
  assert.deepEqual(calls, [
    'onset:s-1',
    'started:u-1:1',
    'done:u-1:1:40',
    'stopped:u-1:1:null',
    'cleared:u-1:1:0',
  ])
})

test('a banner decision carries the exact proposal binding to the service', async () => {
  const {bridge, calls} = harness()
  await bridge.receive(
    '{"type":"project.confirmation_decision","proposal_id":"proposal-1","confirmed":true}',
    {authenticated: true},
  )
  await bridge.receive(
    '{"type":"project.confirmation_decision","proposal_id":"proposal-2","confirmed":false}',
    {authenticated: true},
  )
  assert.deepEqual(calls, [
    'project-decision:proposal-1:true',
    'project-decision:proposal-2:false',
  ])
  await assert.rejects(() => bridge.receive(
    '{"type":"project.confirmation_decision","proposal_id":"proposal-1","confirmed":true,"extra":1}',
    {authenticated: true},
  ), DesktopProtocolError)
})

test('a memory board request is answered when a provider is wired, and ignored otherwise', async () => {
  const answered = harness({memoryBoard: requestId => `{"type":"memory.board","id":"${requestId}"}`})
  await answered.bridge.receive(
    '{"type":"memory.board.request","request_id":"req-1"}',
    {authenticated: true},
  )
  assert.equal(answered.bridge.takeNextFrame(), '{"type":"memory.board","id":"req-1"}')

  const unwired = harness()
  await unwired.bridge.receive(
    '{"type":"memory.board.request","request_id":"req-1"}',
    {authenticated: true},
  )
  assert.equal(unwired.bridge.takeNextFrame(), null)
  assert.equal(unwired.stopped(), false, 'and not treated as an overflow')
})

test('workspace graph board requests use a distinct latest read-only response slot', async () => {
  const {bridge, calls} = harness({
    workspaceGraphBoard: requestId => JSON.stringify({
      type: 'workspace_graph.board', request_id: requestId,
    }),
  })
  await bridge.receive(
    '{"type":"workspace_graph.board.request","request_id":"graph-1"}',
    {authenticated: true},
  )
  await bridge.receive(
    '{"type":"workspace_graph.board.request","request_id":"graph-2"}',
    {authenticated: true},
  )
  assert.deepEqual(calls, [], 'a graph read never reaches voice service methods')
  assert.deepEqual(bridge.pendingCounts, {
    outbound: 0, preempt: 0, codex: false, project: false, workspaceGraph: true,
  })
  assert.equal(
    bridge.takeNextDelivery()?.frame,
    '{"type":"workspace_graph.board","request_id":"graph-2"}',
  )
  assert.equal(bridge.takeNextDelivery(), null, 'the superseded graph-1 response is gone')
})

test('workspace graph board latest delivery never consumes or stops the voice queue', async () => {
  const {bridge, stopped} = harness({
    maxOutboundFrames: 1,
    workspaceGraphBoard: requestId => JSON.stringify({
      type: 'workspace_graph.board', request_id: requestId,
    }),
  })
  bridge.onAudioFrame(frame(2, 0))
  await bridge.receive(
    '{"type":"workspace_graph.board.request","request_id":"graph-full"}',
    {authenticated: true},
  )
  assert.equal(stopped(), false)
  assert.equal(bridge.pendingCounts.outbound, 1)
  assert.equal(bridge.pendingCounts.workspaceGraph, true)
  assert.ok(bridge.takeNextFrame() instanceof Uint8Array, 'voice remains ahead of graph UI data')
  assert.equal(
    bridge.takeNextDelivery()?.policy,
    'latest',
    'graph UI data is refreshable latest state',
  )
})

test('malformed workspace graph frames are rejected without changing transport state', async () => {
  const {bridge, stopped} = harness({
    workspaceGraphBoard: () => '{"type":"workspace_graph.board"}',
  })
  await assert.rejects(() => bridge.receive(
    '{"type":"workspace_graph.board.request","request_id":""}',
    {authenticated: true},
  ), /unsupported|request_id/u)
  assert.equal(stopped(), false)
  assert.equal(bridge.takeNextFrame(), null)
  await assert.rejects(() => bridge.receive(
    '{"type":"workspace_graph.board.request","request_id":"\\ud800"}',
    {authenticated: true},
  ), /request_id/u)
})

test('a clock pong is only measured against a ping that was actually sent', async () => {
  // Otherwise a renderer could report an arbitrary round trip for an id nobody issued.
  const {bridge, telemetry, clock} = harness()
  const ids = bridge.sendClockPings(3)
  assert.deepEqual([...ids], ['ping-0', 'ping-1', 'ping-2'])
  clock.advanceTo(0.25)
  await bridge.receive(
    '{"type":"clock.pong","ping_id":"ping-1","t_render_ms":18.5}',
    {authenticated: true},
  )
  const synced = telemetry.records.filter(record => record.kind === 'renderer.clock_sync')
  assert.equal(synced.length, 1)
  assert.equal(synced[0]?.payload.ping_id, 'ping-1')
  assert.equal(synced[0]?.payload.round_trip_ms, 250)

  // The same pong again is not measured twice.
  await bridge.receive(
    '{"type":"clock.pong","ping_id":"ping-1","t_render_ms":19}',
    {authenticated: true},
  )
  assert.equal(
    telemetry.records.filter(record => record.kind === 'renderer.clock_sync').length,
    1,
  )
  // And an id nobody issued is ignored.
  await bridge.receive(
    '{"type":"clock.pong","ping_id":"ping-99","t_render_ms":5}',
    {authenticated: true},
  )
  assert.equal(
    telemetry.records.filter(record => record.kind === 'renderer.clock_sync').length,
    1,
  )
})

test('clock pings are queued as droppable output', () => {
  const {bridge, stopped} = harness()
  assert.deepEqual(bridge.sendClockPings(2), ['ping-0', 'ping-1'])
  assert.deepEqual(bridge.takeNextDelivery(), {
    frame: '{"type":"clock.ping","ping_id":"ping-0"}',
    policy: 'droppable',
  })
  assert.deepEqual(bridge.takeNextDelivery(), {
    frame: '{"type":"clock.ping","ping_id":"ping-1"}',
    policy: 'droppable',
  })
  assert.equal(stopped(), false)
})

test('uplink volume is reported at most once a second', async () => {
  const {bridge, telemetry, clock} = harness()
  await bridge.receive(new Uint8Array([0, 1]), {authenticated: true})
  bridge.flushUplink()
  assert.equal(telemetry.records.filter(r => r.kind === 'renderer.uplink').length, 0, 'too soon')
  clock.advanceTo(1.5)
  bridge.flushUplink()
  const reported = telemetry.records.filter(r => r.kind === 'renderer.uplink')
  assert.equal(reported.length, 1)
  assert.equal(reported[0]?.payload.frames, 2 / 2, 'one frame')
  assert.equal(reported[0]?.payload.bytes, 2)
  // Nothing since, so nothing more is reported.
  clock.advanceTo(3)
  bridge.flushUplink()
  assert.equal(telemetry.records.filter(r => r.kind === 'renderer.uplink').length, 1)
})

test('only the first frame of a generation is timed', () => {
  // The metric is time-to-first-audio. A re-sent sequence zero for the same generation is the transport
  // retrying, not a new turn starting.
  const {bridge, telemetry} = harness()
  bridge.onAudioFrame(frame(1, 0))
  bridge.onAudioFrame(frame(1, 0))
  bridge.onAudioFrame(frame(1, 1))
  bridge.onAudioFrame(frame(2, 0))
  const timed = telemetry.records.filter(r => r.kind === 'playback.first_frame_enqueued')
  assert.deepEqual(timed.map(r => r.payload.generation_epoch), [1, 2])
})

test('authenticated playback telemetry is recorded as bounded native evidence', async () => {
  const {bridge, telemetry, calls} = harness()
  const payload = {
    type: 'playback.telemetry',
    utterance_id: 'utterance-1',
    generation_epoch: 7,
    final: true,
    window_ms: 850,
    queued_samples: 0,
    queued_samples_max: 960,
    underrun_samples: 480,
    underrun_callbacks: 1,
    max_consecutive_underrun_samples: 240,
    render_callbacks: 10,
    max_callback_us: 1200,
    frame_gap_ms_max: 120_000,
    pcm_near_silence_ms_max: 20,
    sequence_gaps: 1,
    rejected_frames: 2,
    stdin_buffered_bytes_max: 4096,
    stdin_backpressure_count: 1,
    stdin_drain_ms_max: 120_000,
  }

  await bridge.receive(JSON.stringify(payload), {authenticated: true})

  assert.deepEqual(calls, [])
  assert.deepEqual(telemetry.records.filter(record => record.kind === 'playback.native'), [{
    kind: 'playback.native',
    payload: Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'type')),
  }])
  assert.equal(telemetry.records.some(record => (
    record.kind === 'renderer.ack' && record.payload.kind === 'playback_telemetry'
  )), false)
})

test('rejected playback telemetry is counted without invoking service controls', async () => {
  const {bridge, telemetry, calls} = harness()
  await bridge.receiveControl({type: 'playback.telemetry_rejected'})
  await bridge.receiveControl({type: 'playback.telemetry_rejected'})

  assert.deepEqual(calls, [])
  assert.deepEqual(
    telemetry.records.filter(record => record.kind === 'playback.telemetry_rejected'),
    [
      {kind: 'playback.telemetry_rejected', payload: {count: 1}},
      {kind: 'playback.telemetry_rejected', payload: {count: 2}},
    ],
  )
})

test('authenticated playback telemetry reaches the configured JSONL sink', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-playback-telemetry-'))
  t.after(async () => { await rm(directory, {recursive: true, force: true}) })
  const path = join(directory, 'telemetry.jsonl')
  const clock = new VirtualClock(4.5)
  const telemetry = new JsonlTelemetry(path, {clock})
  const {bridge} = harness({clock, telemetry})
  await bridge.receive(JSON.stringify({
    type: 'playback.telemetry', utterance_id: 'u-jsonl', generation_epoch: 1,
    final: true, window_ms: 10, queued_samples: 0, queued_samples_max: 480,
    underrun_samples: 0, underrun_callbacks: 0, render_callbacks: 1,
    max_consecutive_underrun_samples: 0,
    max_callback_us: 40, frame_gap_ms_max: 0, pcm_near_silence_ms_max: 0,
    sequence_gaps: 0, rejected_frames: 0, stdin_buffered_bytes_max: 0,
    stdin_backpressure_count: 0, stdin_drain_ms_max: 0,
  }), {authenticated: true})
  telemetry.close()

  const records: unknown[] = (await readFile(path, 'utf8')).trim().split('\n')
    .map(line => JSON.parse(line) as unknown)
  assert.deepEqual(records, [{
    ts: 4.5,
    kind: 'playback.native',
    payload: {
      utterance_id: 'u-jsonl', generation_epoch: 1, final: true, window_ms: 10,
      queued_samples: 0, queued_samples_max: 480, underrun_samples: 0,
      underrun_callbacks: 0, max_consecutive_underrun_samples: 0,
      render_callbacks: 1, max_callback_us: 40,
      frame_gap_ms_max: 0, pcm_near_silence_ms_max: 0,
      sequence_gaps: 0, rejected_frames: 0,
      stdin_buffered_bytes_max: 0, stdin_backpressure_count: 0, stdin_drain_ms_max: 0,
    },
  }])
})

test('telemetry is inert without a clock, because every sample it takes is a duration', () => {
  const {bridge, telemetry} = harness({withoutClock: true})
  bridge.onAudioFrame(frame(1, 0))
  bridge.onAudioClear('u-1', 1)
  assert.deepEqual(telemetry.records, [])
  assert.deepEqual([...bridge.sendClockPings(3)], [], 'and no pings are armed')
})

test('an audio frame that cannot be encoded is refused rather than queued', () => {
  // Odd-length PCM would shift every sample after it. Refusing is better than queueing audio that
  // sounds plausible and is wrong.
  const {bridge, stopped} = harness()
  assert.throws(
    () => bridge.onAudioFrame({
      utterance_id: 'u-1',
      generation_epoch: 1,
      sequence: 0,
      pcm: new Uint8Array([0, 1, 2]),
    }),
    DesktopProtocolError,
  )
  assert.equal(bridge.pendingCounts.outbound, 0)
  assert.equal(stopped(), false, 'and not mistaken for an overflow')
})

test('a queued audio frame survives a round trip through the queue unchanged', () => {
  // The queue holds encoded bytes, so what the renderer receives has to be exactly what was framed.
  const {bridge} = harness()
  const original = frame(3, 7)
  bridge.onAudioFrame(original)
  const taken = bridge.takeNextFrame()
  assert.ok(taken instanceof Uint8Array)
  assert.deepEqual([...taken], [...encodeAudioFrame(original)])
})

test('a state that returns to what was already sent clears the queued one', () => {
  // Queue `running`, then go back to `idle` before it is taken. Without clearing the slot the renderer
  // would be told `running` for a state that is already over -- and then never corrected, because the
  // latch would think it was up to date.
  const {bridge} = harness()
  bridge.markAuthenticated()
  assert.equal(bridge.takeNextFrame(), '{"type":"codex.state","state":"idle"}')
  bridge.onCodexState('running')
  assert.equal(bridge.pendingCounts.codex, true)
  bridge.onCodexState('idle')
  assert.equal(
    bridge.pendingCounts.codex,
    false,
    'the stale queued state is dropped, not left to be sent',
  )
  assert.equal(bridge.takeNextFrame(), null)
})

test('a memory board answer is dropped rather than stopping the transport', async () => {
  // The renderer asked for it and can ask again. Treating it like a lost audio frame would tear down a
  // working connection over a refreshable panel.
  const {bridge, stopped} = harness({
    maxOutboundFrames: 1,
    memoryBoard: () => '{"type":"memory.board"}',
  })
  bridge.onAudioFrame(frame(1, 0))
  assert.equal(bridge.pendingCounts.outbound, 1, 'the queue is full')
  await bridge.receive(
    '{"type":"memory.board.request","request_id":"req-1"}',
    {authenticated: true},
  )
  assert.equal(stopped(), false, 'dropped, not fatal')
  assert.equal(bridge.pendingCounts.outbound, 1, 'and nothing was added')
})

test('the project dedup is value-based in both places it is checked', () => {
  // The outer check in `onCodexProject` and the inner one in the delivery sync are the same comparison,
  // so a mutation making the outer one identity-based is correctly undetectable -- the inner one still
  // refuses. Both are value-based on purpose: the service rebuilds the view object on every change, and
  // identity would make every publish look new.
  const {bridge} = harness()
  bridge.markAuthenticated()
  assert.ok(bridge.takeNextFrame() !== null, 'drain the codex state')
  const view = {
    workspace_display_name: '研究项目',
    session_title: null,
    pending_confirmation: false,
    pending_confirmation_busy: false,
  }
  bridge.onCodexProject(view)
  assert.ok(String(bridge.takeNextFrame()).startsWith('{"type":"codex.project"'))
  // A structurally equal but distinct object queues nothing, whichever check catches it.
  bridge.onCodexProject({...view})
  assert.equal(bridge.pendingCounts.project, false)
  assert.equal(bridge.takeNextFrame(), null)
})
