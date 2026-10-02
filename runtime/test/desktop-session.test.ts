import assert from 'node:assert/strict'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {VirtualClock} from '../src/core/clock.js'
import {
  DesktopSocketBridge,
  type BridgeService,
  type DesktopBridgeOptions,
  DesktopRealtime,
  type DesktopServerTransport,
} from '../src/desktop/desktop-session.js'
import {
  DesktopProtocolError,
  encodeAudioFrame,
  decodeAudioFrame,
  WIRE_FRAME_TYPES,
} from '../src/desktop/desktop-wire.js'
import {type ExecutorState} from '../src/realtime/service-state.js'
import {DictationError} from '../src/realtime/dictation.js'
import {type JsonValue} from '../src/core/events.js'
import {type RealtimeTelemetry, JsonlTelemetry} from '../src/realtime/telemetry.js'
import {WebSocket, type RawData} from 'ws'
import {encodeCameraFrame, serializeCameraPermissionResult} from '../src/desktop/desktop-camera.js'
import {
  DesktopOutboundValidationError,
  NodeDesktopServer,
  type DesktopServerOptions,
} from '../src/desktop.js'

interface TelemetryRecord {
  readonly kind: string
  readonly payload: Readonly<Record<string, JsonValue>>
}
class RecordingTelemetry implements RealtimeTelemetry {
  readonly records: TelemetryRecord[] = []

  record(kind: string, payload: Readonly<Record<string, JsonValue>>): void {
    this.records.push({kind, payload})
  }

  close(): void {
    // Nothing to release.
  }
}

{

interface JsonFrame {
  readonly type?: string
  readonly result?: unknown
  readonly work_id?: string
}

function parseJsonFrame(frame: string | Uint8Array): JsonFrame {
  const parsed = JSON.parse(String(frame)) as unknown
  assert.ok(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), 'expected a JSON object')
  return parsed
}

function nextLegacyFrame(bridge: DesktopSocketBridge): string | Uint8Array | null {
  let frame = bridge.takeNextFrame()
  while (typeof frame === 'string' && (JSON.parse(frame) as {type?: string}).type === 'executor.tasks') frame = bridge.takeNextFrame()
  return frame
}

function drainJsonFrames(bridge: DesktopSocketBridge): JsonFrame[] {
  const frames: JsonFrame[] = []
  for (let frame; (frame = bridge.takeNextFrame()) !== null;) frames.push(parseJsonFrame(frame))
  return frames
}

function findJsonFrame(frames: readonly JsonFrame[], type: string): JsonFrame {
  const frame = frames.find(value => value.type === type)
  assert.ok(frame, `missing ${type} frame`)
  return frame
}

test('bubble filtering never hides retained results, which replay on reconnect and clear only the dispatched work', () => {
  for (const mode of ['off', 'milestones', 'all'] as const) {
    const {bridge} = harness({progressBubbles: mode})
    bridge.markAuthenticated()
    while (bridge.takeNextFrame() !== null) { /* bootstrap */ }
    const base = {type: 'executor.progress' as const, delegate_id: 'd', executor: 'codex', ts: 1}
    bridge.onExecutorProgress({...base, phase: 'working', summary: '正在测试', level: 'detail'})
    assert.equal(drainJsonFrames(bridge).some(frame => frame.type === 'executor.progress'), mode === 'all')
    const result = {delegate_id: 'd', executor: 'codex', outcome: 'ok' as const, summary: '任务完成', started_at: 0, ended_at: 1, changed_files: 2}
    bridge.onExecutorProgress({...base, phase: 'completed', summary: '任务完成', level: 'milestone'}, result)
    const frames = drainJsonFrames(bridge)
    assert.equal(frames.filter(frame => frame.type === 'executor.progress').length, mode === 'off' ? 0 : 1)
    assert.deepEqual(findJsonFrame(frames, 'executor.result').result, result)
    bridge.release()
    bridge.markAuthenticated()
    const replay = drainJsonFrames(bridge)
    assert.deepEqual(findJsonFrame(replay, 'executor.result').result, result)
    bridge.onExecutorProgress({...base, delegate_id: 'next', phase: 'started', summary: '任务开始', level: 'milestone'}, null)
    const cleared = drainJsonFrames(bridge)
    assert.equal(cleared.find(frame => frame.type === 'executor.result' && frame.work_id === 'next')?.result, null)
    assert.deepEqual(cleared.find(frame => frame.type === 'executor.result' && frame.work_id === 'd')?.result, result)
  }
})

const TOKEN = '0'.repeat(32)

interface Harness {
  readonly service: BridgeService
  readonly bridge: DesktopSocketBridge
  readonly stopped: () => boolean
  readonly calls: string[]
  readonly clock: VirtualClock
  readonly telemetry: RecordingTelemetry
}

function harness(
  overrides: Partial<DesktopBridgeOptions> & {
    readonly executorState?: ExecutorState
    /** Drop the clock entirely, which is what makes telemetry inert. */
    readonly withoutClock?: boolean
  } = {},
): Harness {
  const calls: string[] = []
  let aborted = false
  const clock = new VirtualClock()
  const telemetry = new RecordingTelemetry()
  const service: BridgeService = {
    executorState: overrides.executorState ?? 'idle',
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
    playbackDisconnected: (options) => {
      calls.push(`playback-disconnected:${options?.resumeDelivery === true ? 'resume' : 'paused'}`)
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
    executorApprovalDecision: (approvalId, approved) => {
      calls.push(`approval:${approvalId}:${approved}`)
      return true
    },
  }
  const {withoutClock, executorState, ...bridgeOverrides} = overrides
  // Consumed above as the service's initial state; not a bridge option.
  void executorState
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
    executor: {executor: 'codex', display_name: 'Codex'},
    ...bridgeOverrides,
  })
  return {bridge, service, stopped: () => aborted, calls, clock, telemetry}
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
  assert.equal(nextLegacyFrame(bridge), null, 'and nothing stale behind it')
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
  assert.equal(nextLegacyFrame(bridge), null)
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
  assert.equal(nextLegacyFrame(bridge), null, 'the assistant one does not')
})

test('a terminal for a cleared generation is dropped', () => {
  const {bridge} = harness()
  bridge.onAudioTerminal('u-1', 1)
  bridge.onAudioTerminal('u-2', 2)
  bridge.onAudioClear('u-1', 1)
  assert.ok(String(bridge.takeNextFrame()).startsWith('{"type":"playback.clear"'))
  const survivor = bridge.takeNextFrame()
  assert.ok(String(survivor).includes('"generation_epoch":2'), 'only the newer terminal')
  assert.equal(nextLegacyFrame(bridge), null)
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

test('a required frame evicts queued droppable progress before stopping the transport', () => {
  const {bridge, stopped} = harness({maxOutboundFrames: 1})
  bridge.onExecutorProgress({
    type: 'executor.progress', delegate_id: 'd', executor: 'codex', phase: 'started',
    summary: 'Codex 已开始处理任务。', level: 'milestone', ts: 1,
  }, null)

  bridge.onAudioFrame(frame(1, 0))

  assert.equal(stopped(), false)
  assert.equal(bridge.pendingCounts.outbound, 1)
  assert.equal(bridge.takeNextDelivery()?.policy, 'required')
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
  bridge.onExecutorState('running')
  bridge.onExecutorState('idle')
  bridge.onExecutorState('running')
  assert.equal(bridge.pendingCounts.executor, true)
  assert.equal(bridge.takeNextFrame(), '{"type":"executor.state","executor":"codex","display_name":"Codex","state":"running"}')
  assert.equal(nextLegacyFrame(bridge), null, 'the intermediate states are not sent')
})

test('nothing is queued for an unauthenticated connection', () => {
  // Until the renderer has proven itself, it gets no state at all.
  const {bridge} = harness()
  bridge.onExecutorState('running')
  assert.equal(bridge.pendingCounts.executor, false)
  bridge.markAuthenticated()
  assert.equal(bridge.pendingCounts.executor, true, 'and then it does')
})

test('a state already sent is not sent again', () => {
  const {bridge} = harness()
  bridge.markAuthenticated()
  bridge.onExecutorState('running')
  assert.equal(bridge.takeNextFrame(), '{"type":"executor.state","executor":"codex","display_name":"Codex","state":"running"}')
  bridge.onExecutorState('running')
  assert.equal(nextLegacyFrame(bridge), null)
})

test('releasing forgets what the previous renderer was told', () => {
  // The next renderer has been told nothing. Without resetting, it would never receive the current
  // state, having "already been sent" it.
  const {bridge} = harness()
  bridge.markAuthenticated()
  bridge.onExecutorState('running')
  assert.ok(bridge.takeNextFrame() !== null)
  bridge.release()
  assert.equal(bridge.claim(), true, 'a new renderer may connect')
  bridge.markAuthenticated()
  assert.equal(
    bridge.takeNextFrame(),
    '{"type":"executor.state","executor":"codex","display_name":"Codex","state":"running"}',
    'and is told the current state',
  )
})

test('releasing drops transient playback and does not queue partial audio while disconnected', () => {
  const {bridge, calls, stopped} = harness()
  bridge.markAuthenticated()
  assert.equal(bridge.takeNextFrame(), '{"type":"executor.state","executor":"codex","display_name":"Codex","state":"idle"}')
  bridge.onAudioFrame(frame(4, 0))
  bridge.onCaption({role: 'assistant', text: 'old socket', final: false})
  bridge.onAudioTerminal('u-4', 4)

  bridge.release()
  assert.ok(calls.includes('playback-disconnected:paused'))
  bridge.onAudioFrame(frame(4, 1))
  bridge.onCaption({role: 'assistant', text: 'disconnected', final: false})
  bridge.onAudioTerminal('u-4', 4)
  assert.equal(stopped(), false)

  assert.equal(bridge.claim(), true)
  bridge.markAuthenticated()
  assert.equal(
    calls.filter(call => call.startsWith('playback-disconnected:')).length,
    2,
    'both connection boundaries fence playback',
  )
  assert.ok(
    calls.includes('playback-disconnected:resume'),
    'only the authenticated replacement reopens provider delivery',
  )
  assert.equal(
    bridge.takeNextFrame(),
    '{"type":"executor.state","executor":"codex","display_name":"Codex","state":"idle"}',
    'the new renderer receives only reconstructable current state',
  )
  assert.equal(nextLegacyFrame(bridge), null, 'no old or partial playback crosses the generation')

  bridge.onAudioFrame(frame(5, 0))
  assert.ok(bridge.takeNextFrame() instanceof Uint8Array, 'fresh post-auth playback still flows')
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
  assert.equal(bridge.takeNextFrame(), '{"type":"executor.state","executor":"codex","display_name":"Codex","state":"idle"}')
  bridge.onProjectView({
    workspace_display_name: '研究项目',
    session_title: null,
    pending_confirmation: false,
    pending_confirmation_busy: false,
  })
  assert.ok(String(bridge.takeNextFrame()).startsWith('{"type":"project.state"'))
  bridge.onProjectView({
    workspace_display_name: '研究项目',
    session_title: null,
    pending_confirmation: false,
    pending_confirmation_busy: false,
  })
  assert.equal(nextLegacyFrame(bridge), null, 'an equal view is not resent')
  bridge.onProjectView({
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
  bridge.onProjectView({
    workspace_display_name: '研究项目',
    session_title: null,
    pending_confirmation: true,
    pending_confirmation_busy: false,
    pending_action: 'create_workspace',
    pending_workspace_display_name: 'beta',
    pending_session_title: null,
    pending_expires_in_seconds: 75,
  })
  assert.ok(
    String(bridge.takeNextFrame()).includes('"pending_workspace_display_name":"beta"'),
    'a changed pending target is resent',
  )
  const base = {workspace_display_name: '研究项目', session_title: null, pending_confirmation: false, pending_confirmation_busy: false}
  bridge.onProjectView({...base, roster: [{name: 'blog', last_used_at: 1, running: [{work_id: 'w1', title: '暗色模式'}]}]})
  assert.ok(String(bridge.takeNextFrame()).includes('"roster":[{"name":"blog"'), 'a roster change is a new frame')
  bridge.onProjectView({...base, roster: [{name: 'blog', last_used_at: 1, running: [{work_id: 'w1', title: '暗色模式'}]}]})
  assert.equal(nextLegacyFrame(bridge), null, 'an identical roster is not')
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

test('AutoGLM approval identity routes clicks and clears with coding disabled or configured', async () => {
  for (const executor of [null, {executor: 'codex', display_name: 'Codex'}]) {
    const {bridge, calls, clock} = harness({executor})
    bridge.markAuthenticated()
    if (executor !== null) bridge.takeNextFrame()
    bridge.onExecutorApproval({
      pending_approval: true, pending_approval_busy: false, pending_approval_id: 'phone-approval',
      executorIdentity: {executor: 'autoglm', display_name: 'AutoGLM'},
      kind: 'permissions', local_detail: {kind: 'permissions', scope: 'Tap'},
      operation_summary: 'Confirm phone action', expires_at: clock.now() + 60, work: null, queued: 0,
    })
    const frame = JSON.parse(String(bridge.takeNextFrame())) as Record<string, unknown>
    assert.equal(frame.executor, 'autoglm')
    assert.equal(frame.display_name, 'AutoGLM')
    for (const name of ['codex', 'autoglm']) {
      await bridge.receive(JSON.stringify({type: 'executor.approval_decision', executor: name,
        approval_id: 'phone-approval', approved: true}), {authenticated: true})
    }
    assert.deepEqual(calls, ['approval:phone-approval:true'])
    bridge.onExecutorApproval({pending_approval: false, pending_approval_busy: false,
      kind: null, local_detail: null, operation_summary: null, expires_at: null, work: null, queued: 0})
    const cleared = JSON.parse(String(bridge.takeNextFrame())) as Record<string, unknown>
    assert.equal(cleared.executor, 'autoglm')
    assert.equal(cleared.pending_approval, false)
  }
})

test('after a phone approval resolves, a conversation-owned Codex approval click is still relayed', async () => {
  const {bridge, calls, clock} = harness({executor: {executor: 'codex', display_name: 'Codex'}})
  bridge.markAuthenticated()
  bridge.takeNextFrame()
  bridge.onExecutorApproval({
    pending_approval: true, pending_approval_busy: false, pending_approval_id: 'phone-approval',
    executorIdentity: {executor: 'mobile', display_name: '手机助手'},
    kind: 'permissions', local_detail: {kind: 'permissions', scope: 'Tap'},
    operation_summary: 'Confirm phone action', expires_at: clock.now() + 60, work: null, queued: 0,
  })
  bridge.takeNextFrame()
  bridge.onExecutorApproval({pending_approval: false, pending_approval_busy: false,
    kind: null, local_detail: null, operation_summary: null, expires_at: null, work: null, queued: 0})
  bridge.takeNextFrame()
  await bridge.receive(JSON.stringify({type: 'executor.approval_decision', executor: 'codex',
    approval_id: 'conversation-approval', approved: true}), {authenticated: true})
  assert.deepEqual(calls, ['approval:conversation-approval:true'])
})

test('a Codex approval frame and click use an independent strict bridge path', async () => {
  const {bridge, calls, clock} = harness()
  bridge.markAuthenticated()
  assert.equal(bridge.takeNextFrame(), '{"type":"executor.state","executor":"codex","display_name":"Codex","state":"idle"}')
  bridge.onExecutorApproval({
    pending_approval: true,
    pending_approval_busy: false,
    pending_approval_id: 'approval-1',
    kind: 'file_change',
    local_detail: {
      kind: 'file_change', changes: [{change: 'update', path: 'src/a.ts', move_path: null}],
    },
    operation_summary: 'Codex 请求修改工作区文件。',
    expires_at: clock.now() + 60,
    work: null,
    queued: 0,
  })
  assert.match(String(bridge.takeNextFrame()), /"type":"executor\.approval".*"src\/a\.ts"/u)
  await bridge.receive(
    '{"type":"executor.approval_decision","executor":"codex","approval_id":"approval-1","approved":true}',
    {authenticated: true},
  )
  assert.deepEqual(calls, ['approval:approval-1:true'])
  await assert.rejects(() => bridge.receive(
    '{"type":"executor.approval_decision","executor":"codex","approval_id":"approval-1","approved":true,"extra":1}',
    {authenticated: true},
  ), DesktopProtocolError)
})

test('independent latest slots deliver both overlapping confirmation views before settlement', () => {
  const {bridge, clock} = harness()
  bridge.markAuthenticated()
  assert.equal(bridge.takeNextFrame(), '{"type":"executor.state","executor":"codex","display_name":"Codex","state":"idle"}')
  bridge.onExecutorApproval({
    pending_approval: true,
    pending_approval_busy: false,
    pending_approval_id: 'approval-1',
    kind: 'command_execution',
    local_detail: {kind: 'command_execution', command: 'npm test', cwd: 'C:\\workspace'},
    operation_summary: 'Codex 请求执行一条工作区命令。',
    expires_at: clock.now() + 60,
    work: null,
    queued: 0,
  })
  bridge.onProjectView({
    workspace_display_name: '研究项目',
    session_title: null,
    pending_confirmation: true,
    pending_confirmation_busy: false,
    pending_confirmation_id: 'proposal-1',
    pending_action: 'create_workspace',
    pending_workspace_display_name: 'beta',
    pending_session_title: null,
    pending_expires_in_seconds: 75,
  })
  assert.match(String(bridge.takeNextFrame()), /"type":"project\.state".*"proposal-1"/u)
  assert.match(String(bridge.takeNextFrame()), /"type":"executor\.approval".*"approval-1"/u)
  bridge.onExecutorApproval({
    pending_approval: false,
    pending_approval_busy: false,
    kind: null,
    local_detail: null,
    operation_summary: null,
    expires_at: null,
    work: null,
    queued: 0,
  })
  assert.match(String(bridge.takeNextFrame()), /"type":"executor\.approval".*"pending_approval":false/u)
})

test('voice bridge rejects debug board requests', async () => {
  const {bridge} = harness()
  for (const raw of [
    '{"type":"memory.board.request","request_id":"req-1"}',
    '{"type":"workspace_graph.board.request","request_id":"graph-1"}',
  ]) {
    await assert.rejects(
      () => bridge.receive(raw, {authenticated: true}),
      DesktopProtocolError,
    )
  }
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

test('sanitized renderer connection recovery diagnostics reach telemetry without generic ack noise', async () => {
  const {bridge, telemetry} = harness()
  await bridge.receive(JSON.stringify({
    type: 'connection.diagnostic',
    phase: 'closed',
    close_code: 1009,
    reason: 'message_too_big',
  }), {authenticated: true})
  await bridge.receive(JSON.stringify({
    type: 'connection.diagnostic',
    phase: 'reconnect_attempt',
    attempt: 1,
    delay_ms: 250,
  }), {authenticated: true})
  await bridge.receive(JSON.stringify({
    type: 'connection.diagnostic',
    phase: 'reconnect_result',
    attempt: 1,
    result: 'connected',
  }), {authenticated: true})

  assert.deepEqual(telemetry.records.filter(record => record.kind.startsWith('desktop.')), [{
    kind: 'desktop.connection_closed',
    payload: {close_code: 1009, reason: 'message_too_big'},
  }, {
    kind: 'desktop.reconnect_attempt',
    payload: {attempt: 1, delay_ms: 250},
  }, {
    kind: 'desktop.reconnect_result',
    payload: {attempt: 1, result: 'connected'},
  }])
  assert.equal(telemetry.records.some(record => (
    record.kind === 'renderer.ack' && record.payload.kind === 'connection_diagnostic'
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
    .map(line => {
      const {run_id, seq, wall_time, ...record} = JSON.parse(line) as Record<string, unknown>
      assert.equal(typeof run_id, 'string')
      assert.equal(seq, 1)
      assert.equal(typeof wall_time, 'string')
      return record
    })
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
  assert.equal(bridge.takeNextFrame(), '{"type":"executor.state","executor":"codex","display_name":"Codex","state":"idle"}')
  bridge.onExecutorState('running')
  assert.equal(bridge.pendingCounts.executor, true)
  bridge.onExecutorState('idle')
  assert.equal(
    bridge.pendingCounts.executor,
    false,
    'the stale queued state is dropped, not left to be sent',
  )
  assert.equal(nextLegacyFrame(bridge), null)
})

test('the project dedup is value-based in both places it is checked', () => {
  // The outer check in `onProjectView` and the inner one in the delivery sync are the same comparison,
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
  bridge.onProjectView(view)
  assert.ok(String(bridge.takeNextFrame()).startsWith('{"type":"project.state"'))
  // A structurally equal but distinct object queues nothing, whichever check catches it.
  bridge.onProjectView({...view})
  assert.equal(bridge.pendingCounts.project, false)
  assert.equal(nextLegacyFrame(bridge), null)
})


test('concurrent retained results survive both completion orders, keyed clear, and reconnect with bubbles off', () => {
  for (const order of [['a', 'b'], ['b', 'a']]) {
    const {bridge} = harness({progressBubbles: 'off'})
    const progress = (id: string, phase: 'started' | 'completed') => ({type: 'executor.progress' as const, delegate_id: id, executor: 'codex', ts: 2, phase, summary: 'task', level: 'milestone' as const})
    bridge.markAuthenticated()
    drainJsonFrames(bridge)
    for (const id of ['a', 'b']) bridge.onExecutorProgress(progress(id, 'started'), null)
    for (const id of order) bridge.onExecutorProgress(progress(id, 'completed'), {delegate_id: id, executor: 'codex', outcome: 'ok', summary: id, started_at: 1, ended_at: 2, changed_files: 1})
    const results = () => drainJsonFrames(bridge).filter(frame => frame.type === 'executor.result').map(frame => frame.result).filter(Boolean)
    assert.equal(results().length, 2)
    bridge.release(); bridge.markAuthenticated()
    assert.equal(results().length, 2)
    bridge.onExecutorProgress(progress('a', 'started'), null)
    assert.deepEqual(results().map(value => (value as {delegate_id: string}).delegate_id), ['b'])
    bridge.onExecutorProgress(progress('c', 'started'), null)
    assert.deepEqual(results().map(value => (value as {delegate_id: string}).delegate_id), ['b'])
  }
})

test('result snapshots are bounded, preserve live slots, refuse overflow and reject mismatched work identity', () => {
  const {bridge, telemetry} = harness({progressBubbles: 'off'})
  bridge.markAuthenticated()
  drainJsonFrames(bridge)
  const progress = (id: string, phase: 'started' | 'completed') => ({type: 'executor.progress' as const, delegate_id: id, executor: 'codex', ts: 2, phase, summary: 'task', level: 'milestone' as const})
  for (let i = 0; i < 64; i++) bridge.onExecutorProgress(progress(`live-${i}`, 'started'), null)
  bridge.onExecutorProgress(progress('overflow', 'started'), null)
  assert.ok(telemetry.records.some(record => record.kind === 'desktop.result_retention_full'))
  const snapshot = drainJsonFrames(bridge)
  assert.equal(snapshot.filter(frame => frame.type === 'executor.result').length, 64)
  assert.equal(snapshot.filter(frame => frame.type === 'executor.results.reset').length, 1)
  const result = {delegate_id: 'live-0', executor: 'codex', outcome: 'ok' as const, summary: '界'.repeat(180), started_at: 1, ended_at: 2, changed_files: 1}
  assert.throws(() => bridge.onExecutorProgress(progress('other', 'completed'), result), /identity/u)
  assert.throws(() => bridge.onExecutorProgress(progress('live-0', 'completed'), {...result, summary: 'x'.repeat(181)}))
  bridge.onExecutorProgress(progress('live-0', 'completed'), result)
  bridge.onExecutorProgress(progress('new-live', 'started'), null)
  const retained = drainJsonFrames(bridge).filter(frame => frame.type === 'executor.result')
  assert.equal(retained.length, 64)
  assert.ok(!retained.some(frame => JSON.stringify(frame).includes('live-0"')))
  assert.ok(retained.some(frame => JSON.stringify(frame).includes('live-63"')))
  bridge.onExecutorProgress(progress('live-63', 'completed'), {...result, delegate_id: 'live-63'})
  for (let frame; (frame = bridge.takeNextFrame()) !== null;) assert.ok(Buffer.byteLength(String(frame)) <= 16 * 1024)
})

test('retained result keeps the work project/title after its running roster entry disappears', () => {
  const {bridge} = harness({progressBubbles: 'off'})
  bridge.markAuthenticated()
  const progress = {type: 'executor.progress' as const, delegate_id: 'a', executor: 'codex', ts: 2, summary: 'task', level: 'milestone' as const}
  const base = {workspace_display_name: 'alpha', session_title: null, pending_confirmation: false, pending_confirmation_busy: false}
  bridge.onExecutorProgress({...progress, phase: 'started'}, null)
  bridge.onProjectView({...base, roster: [{name: 'alpha', last_used_at: 1, running: [{work_id: 'a', title: '🌟'.repeat(120)}]}]})
  bridge.onProjectView({...base, roster: [{name: 'alpha', last_used_at: 1, running: []}]})
  bridge.onExecutorProgress({...progress, phase: 'completed'}, {delegate_id: 'a', executor: 'codex', outcome: 'ok', summary: 'done', started_at: 1, ended_at: 2, changed_files: 1})
  const result = findJsonFrame(drainJsonFrames(bridge), 'executor.result').result
  assert.deepEqual(result, {delegate_id: 'a', executor: 'codex', outcome: 'ok', summary: 'done', started_at: 1, ended_at: 2, changed_files: 1, project: 'alpha', title: '🌟'.repeat(120)})
})

test('desktop activity heartbeat is authenticated and carries only a boolean', () => {
  const {bridge} = harness()
  bridge.onActivity(false)
  bridge.markAuthenticated()
  bridge.onActivity(true)
  const frames = drainJsonFrames(bridge)
  assert.deepEqual(frames.filter(frame => frame.type === 'desktop.activity'), [{type: 'desktop.activity', idle: true}])
})

test('coding tasks snapshot survives bubble filtering and authenticated replay', () => {
  const {bridge} = harness({progressBubbles: 'off', executor: {executor: 'coding', display_name: 'Coding'}})
  bridge.onExecutorProgress({type: 'executor.progress', executor: 'coding', delegate_id: 'a', phase: 'working', summary: '发现原因', level: 'detail', ts: 1})
  assert.equal(nextLegacyFrame(bridge), null)
  bridge.markAuthenticated()
  const snapshot = findJsonFrame(drainJsonFrames(bridge), 'executor.tasks') as unknown as {tasks: {summary: string}[]; revision: number}
  assert.equal(snapshot.tasks[0]?.summary, '发现原因')
  bridge.release()
  bridge.markAuthenticated()
  assert.deepEqual(findJsonFrame(drainJsonFrames(bridge), 'executor.tasks'), snapshot)
})

test('dictation buffers audio without sending it to the model; only explicit edited text is submitted', async () => {
  const {bridge, service, calls} = harness()
  let bytes = 0
  service.transcribeDraft = pcm => {bytes = pcm.length; return Promise.resolve('draft')}
  service.submitText = text => {calls.push('text:' + text); return Promise.resolve()}
  bridge.markAuthenticated(); drainJsonFrames(bridge)
  await bridge.receiveControl({type: 'input.dictation', id: 'd1', action: 'start'})
  await bridge.receiveAudio(new Uint8Array(4))
  assert.deepEqual(calls, [])
  await bridge.receiveControl({type: 'input.dictation', id: 'd1', action: 'finish'})
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(bytes, 4)
  assert.equal(findJsonFrame(drainJsonFrames(bridge), 'input.transcription').type, 'input.transcription')
  await bridge.receiveAudio(new Uint8Array(2))
  assert.deepEqual(calls, [], 'late draft audio must not fall through to live ASR')
  await bridge.receiveControl({type: 'input.text', text: 'edited draft'})
  assert.deepEqual(calls, ['text:edited draft'])
  bridge.release()
})

test('a failed dictation reports recognition_failed to the client and the real cause to telemetry only', async () => {
  const {bridge, service, telemetry} = harness()
  service.transcribeDraft = () => Promise.reject(new Error('empty transcript'))
  bridge.markAuthenticated(); drainJsonFrames(bridge)
  await bridge.receiveControl({type: 'input.dictation', id: 'd2', action: 'start'})
  await bridge.receiveAudio(new Uint8Array(6))
  await bridge.receiveControl({type: 'input.dictation', id: 'd2', action: 'finish'})
  await new Promise(resolve => setImmediate(resolve))
  const frame = findJsonFrame(drainJsonFrames(bridge), 'input.transcription') as unknown as {error?: string}
  assert.equal(frame.error, 'recognition_failed')
  const failed = telemetry.records.filter(record => record.kind === 'dictation.failed')
  assert.equal(failed.length, 1)
  assert.deepEqual(failed[0]?.payload, {bytes: 6, peak: 0, rms: 0, error: 'empty transcript'})
  bridge.release()
})

test('a dictation failure with a known cause reports that cause to the client and its input level to telemetry', async () => {
  const {bridge, service, telemetry} = harness()
  service.transcribeDraft = () => Promise.reject(new DictationError('no_speech', 'empty transcript'))
  bridge.markAuthenticated(); drainJsonFrames(bridge)
  await bridge.receiveControl({type: 'input.dictation', id: 'd4', action: 'start'})
  const pcm = new Uint8Array(4), view = new DataView(pcm.buffer)
  view.setInt16(0, 1200, true); view.setInt16(2, -3000, true)
  await bridge.receiveAudio(pcm)
  await bridge.receiveControl({type: 'input.dictation', id: 'd4', action: 'finish'})
  await new Promise(resolve => setImmediate(resolve))
  const frame = findJsonFrame(drainJsonFrames(bridge), 'input.transcription') as unknown as {error?: string}
  assert.equal(frame.error, 'no_speech')
  const failed = telemetry.records.filter(record => record.kind === 'dictation.failed')
  assert.deepEqual(failed[0]?.payload, {bytes: 4, peak: 3000, rms: 2285, error: 'empty transcript'})
  bridge.release()
})

test('a failed dictation still reports recognition_failed when the telemetry disk cannot be written', async () => {
  const {bridge, service, telemetry} = harness()
  telemetry.record = () => { throw new Error('ENOSPC') }
  service.transcribeDraft = () => Promise.reject(new Error('empty transcript'))
  bridge.markAuthenticated(); drainJsonFrames(bridge)
  await bridge.receiveControl({type: 'input.dictation', id: 'd3', action: 'start'})
  await bridge.receiveAudio(new Uint8Array(6))
  await bridge.receiveControl({type: 'input.dictation', id: 'd3', action: 'finish'})
  await new Promise(resolve => setImmediate(resolve))
  const frame = findJsonFrame(drainJsonFrames(bridge), 'input.transcription') as unknown as {error?: string}
  assert.equal(frame.error, 'recognition_failed')
  bridge.release()
})

test('cancelled dictation drops a late transcript and release aborts recognition', async () => {
  const {bridge, service} = harness()
  let finish!: (text: string) => void
  let signal: AbortSignal | undefined
  service.transcribeDraft = async (_pcm, current) => {signal = current; return new Promise(resolve => {finish = resolve})}
  bridge.markAuthenticated(); drainJsonFrames(bridge)
  await bridge.receiveControl({type: 'input.dictation', id: 'old', action: 'start'})
  await bridge.receiveAudio(new Uint8Array(4))
  await bridge.receiveControl({type: 'input.dictation', id: 'old', action: 'finish'})
  await bridge.receiveControl({type: 'input.dictation', id: 'old', action: 'cancel'})
  assert.equal(signal?.aborted, true)
  finish('late draft'); await new Promise(resolve => setImmediate(resolve))
  assert.equal(drainJsonFrames(bridge).some(frame => frame.type === 'input.transcription'), false)
  bridge.release()
})

test('text acceptance uses a required correlated receipt, not captions; reconnect retries do not resubmit', async () => {
  const {bridge,service,calls}=harness()
  service.submitText=text=>{calls.push('text:'+text);return Promise.resolve()}
  bridge.markAuthenticated();drainJsonFrames(bridge)
  await bridge.receiveControl({type:'input.text',request_id:'text-1',text:'repeat'})
  const delivery=bridge.takeNextDelivery()!
  assert.equal(delivery.policy,'required')
  assert.deepEqual(JSON.parse(String(delivery.frame)),{type:'input.text_result',request_id:'text-1',ok:true})
  bridge.onCaption({role:'user',text:'repeat',final:true});drainJsonFrames(bridge)
  bridge.release();bridge.markAuthenticated();drainJsonFrames(bridge)
  await bridge.receiveControl({type:'input.text',request_id:'text-1',text:'repeat'})
  assert.deepEqual(calls.filter(c=>c.startsWith('text:')),['text:repeat'])
  assert.deepEqual(JSON.parse(String(bridge.takeNextFrame())),{type:'input.text_result',request_id:'text-1',ok:true})
  await bridge.receiveControl({type:'input.text',request_id:'text-1',text:'changed'})
  assert.deepEqual(JSON.parse(String(bridge.takeNextFrame())),{type:'input.text_result',request_id:'text-1',ok:false,error:'request_id_conflict'})
  bridge.release()
})

test('text failure receipts and backend instance fences never turn into repeated submissions', async () => {
  const {bridge,service,calls}=harness()
  service.submitText=()=>{calls.push('submit');return Promise.reject(Error('provider unavailable'))}
  bridge.markAuthenticated();drainJsonFrames(bridge)
  await bridge.receiveControl({type:'input.text',request_id:'failed',text:'draft'})
  assert.deepEqual(JSON.parse(String(bridge.takeNextFrame())),{type:'input.text_result',request_id:'failed',ok:false,error:'submission_failed'})
  await bridge.receiveControl({type:'input.text',request_id:'failed',text:'draft'})
  drainJsonFrames(bridge);assert.equal(calls.filter(c=>c==='submit').length,1)
  await bridge.receiveControl({type:'input.text',request_id:'old-instance',input_instance_id:'a-prior-runtime',text:'draft'})
  assert.deepEqual(JSON.parse(String(bridge.takeNextFrame())),{type:'input.text_result',request_id:'old-instance',ok:false,error:'outcome_unknown'})
  assert.equal(calls.filter(c=>c==='submit').length,1)
  bridge.release()
})

test('caption wire preserves stable source identity even when a previous final is dropped',()=>{
  const {bridge}=harness();bridge.markAuthenticated();drainJsonFrames(bridge)
  bridge.onCaption({role:'user',text:'first',final:false,turn_id:'1:user:item-1'})
  bridge.onCaption({role:'user',text:'next',final:false,turn_id:'1:user:item-2'})
  const frames=drainJsonFrames(bridge).filter(f=>f.type==='caption') as unknown as {turn_id:string}[]
  assert.deepEqual(frames.map(f=>f.turn_id),['1:user:item-1','1:user:item-2'])
  bridge.release()
})

test('text reconnect while provider submission is pending shares one host operation',async()=>{
  const {bridge,service}=harness();let submits=0;let finish!:()=>void
  service.submitText=()=>{submits++;return new Promise<void>(resolve=>{finish=resolve})}
  bridge.markAuthenticated();drainJsonFrames(bridge)
  const command={type:'input.text' as const,request_id:'pending',text:'once'}
  const first=bridge.receiveControl(command);await Promise.resolve()
  bridge.release();bridge.markAuthenticated();drainJsonFrames(bridge)
  const retry=bridge.receiveControl(command);finish();await Promise.all([first,retry])
  assert.equal(submits,1)
  const receipts=drainJsonFrames(bridge).filter(frame=>frame.type==='input.text_result')
  assert.equal(receipts.length,2)
  assert.deepEqual(receipts[0],receipts[1]);bridge.release()
})

test('unscoped PCM and dictation cannot bypass an owned conversation voice',async()=>{
 const checked:(string|undefined)[]=[]
 const {bridge,calls}=harness({validateConversationInput:(_kind,id)=>{checked.push(id);if(id!=='voice')throw Error('voice_not_owned')},sendConversationAudio:()=>Promise.resolve()})
 await assert.rejects(bridge.receiveAudio(new Uint8Array(4)),/voice_not_owned/)
 await assert.rejects(bridge.receiveControl({type:'input.audio'}),/voice_not_owned/)
 await assert.rejects(bridge.receiveControl({type:'input.dictation',id:'draft',action:'start'}),/voice_not_owned/)
 await bridge.receiveControl({type:'input.audio',conversation_id:'voice'});await bridge.receiveAudio(new Uint8Array(4))
 assert.deepEqual(checked,[undefined,undefined,undefined,'voice','voice']);assert.equal(calls.length,0)
})
test('text receipt identity includes conversation and scoped decisions do not fall back',async()=>{
 const routed:string[]=[]
 const target=harness().service
 target.projectConfirmationDecision=(id)=>{routed.push(id);return Promise.resolve()}
 const {bridge,calls}=harness({submitConversationText:(id,text)=>{routed.push(id+':'+text);return Promise.resolve()},conversationService:id=>id==='a'?target:undefined})
 bridge.markAuthenticated();drainJsonFrames(bridge)
 await bridge.receiveControl({type:'input.text',conversation_id:'a',request_id:'same',text:'hello'})
 await bridge.receiveControl({type:'input.text',conversation_id:'b',request_id:'same',text:'hello'})
 const receipts=drainJsonFrames(bridge) as {type:string;ok:boolean;error?:string;conversation_id?:string}[]
 assert.equal(receipts[0]?.conversation_id,'a');assert.equal(receipts[1]?.error,'request_id_conflict')
 await bridge.receiveControl({type:'project.confirmation_decision',conversation_id:'a',proposal_id:'owned',confirmed:true})
 await bridge.receiveControl({type:'project.confirmation_decision',conversation_id:'missing',proposal_id:'stale',confirmed:true})
 assert.deepEqual(routed,['a:hello','owned']);assert.equal(calls.length,0)
})
}

{
const TOKEN = '1'.repeat(32)
const CODEX = {executor: 'codex', display_name: 'Codex'} as const
const SETTLE_MS = 1_000

test('AOQ control-only reconnect releases the UI without queuing another provider replacement', async () => {
  const {service} = serviceHarness()
  let resets = 0
  const realtime = new DesktopRealtime({token: TOKEN, executor: CODEX, stop: new AbortController(),
    transportFailure: 'disconnect', service: {...service, discardInputAudio: () => { resets++; return Promise.resolve() }},
    createServer: () => ({start: () => Promise.resolve({token: TOKEN, host: '127.0.0.1', port: 1}), close: () => Promise.resolve(),
      disconnectClient: () => Promise.resolve(), sendText: () => Promise.resolve(), sendBinary: () => Promise.resolve()}),
  })
  await realtime.serverOptions.onClientAuthenticated?.()
  realtime.serverOptions.onClientDisconnect?.({hadProviderAttachment: true})
  await realtime.serverOptions.onClientAuthenticated?.()
  realtime.serverOptions.onClientDisconnect?.({hadProviderAttachment: false})
  assert.equal(resets, 1)
  await realtime.serverOptions.onClientAuthenticated?.() // Both UI claims were released.
  realtime.serverOptions.onClientDisconnect?.() // Native PCM retains its default reset behavior.
  assert.equal(resets, 2)
})

interface ServiceHarness {
  readonly service: BridgeService
  readonly calls: string[]
}

function serviceHarness(): ServiceHarness {
  const calls: string[] = []
  return {
    calls,
    service: {
      executorState: 'running',
      sendAudio: pcm => { calls.push(`audio:${[...pcm].join(',')}`); return Promise.resolve() },
      localSpeechOnset: speechId => { calls.push(`onset:${speechId}`); return Promise.resolve() },
      playbackStarted: (utteranceId, epoch) => { calls.push(`started:${utteranceId}:${epoch}`); return true },
      playbackStopped: (utteranceId, epoch, playedMs) => {
        calls.push(`stopped:${utteranceId}:${epoch}:${playedMs ?? 'null'}`)
        return Promise.resolve(true)
      },
      playbackDisconnected: () => {
        calls.push('playback-disconnected')
        return Promise.resolve(true)
      },
      playbackDone: (utteranceId, epoch, playedMs) => {
        calls.push(`done:${utteranceId}:${epoch}:${playedMs ?? 'null'}`)
        return true
      },
      playbackCleared: (utteranceId, epoch, playedMs) => {
        calls.push(`cleared:${utteranceId}:${epoch}:${playedMs ?? 'null'}`)
        return true
      },
      projectConfirmationDecision: (proposalId, confirmed) => {
        calls.push(`project-decision:${proposalId}:${confirmed}`)
        return Promise.resolve()
      },
      executorApprovalDecision: (approvalId, approved) => {
        calls.push(`approval:${approvalId}:${approved}`)
        return true
      },
    },
  }
}

function settleWithin<T>(label: string, promise: Promise<T>, timeoutMs = SETTLE_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not settle in time`)), timeoutMs)
    void promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(`${label} rejected`))
      },
    )
  })
}

function connectDesktop(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/`)
  return settleWithin('desktop realtime client connect', new Promise<WebSocket>((resolve, reject) => {
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })).catch(error => {
    socket.terminate()
    throw error
  })
}

function closeDesktop(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve()
  const closed = new Promise<void>(resolve => socket.once('close', () => resolve()))
  socket.close()
  return settleWithin('desktop realtime client close', closed).catch(error => {
    socket.terminate()
    throw error
  })
}

interface ReceivedFrame {readonly binary: boolean; readonly bytes: Uint8Array}

function nextFrames(socket: WebSocket, count: number, label: string): Promise<readonly ReceivedFrame[]> {
  const receiving = new Promise<readonly ReceivedFrame[]>((resolve, reject) => {
    const frames: ReceivedFrame[] = []
    const onMessage = (data: RawData, binary: boolean): void => {
      const bytes = Buffer.isBuffer(data)
        ? new Uint8Array(data)
        : new Uint8Array(Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]))
      frames.push({binary, bytes})
      if (frames.length === count) { cleanup(); resolve(frames) }
    }
    const onClose = (): void => { cleanup(); reject(new Error(`${label} socket closed early`)) }
    const cleanup = (): void => { socket.off('message', onMessage); socket.off('close', onClose) }
    socket.on('message', onMessage)
    socket.once('close', onClose)
  })
  return settleWithin(label, receiving)
}

function sendClient(socket: WebSocket, raw: string | Uint8Array, label: string): Promise<void> {
  return settleWithin(label, new Promise<void>((resolve, reject) => {
    socket.send(raw, error => error == null ? resolve() : reject(error))
  }))
}

function nextClose(socket: WebSocket, label: string): Promise<{readonly code: number; readonly reason: string}> {
  return settleWithin(label, new Promise(resolve => {
    socket.once('close', (code, reason) => resolve({code, reason: reason.toString('utf8')}))
  }))
}

function text(frame: ReceivedFrame): string {
  assert.equal(frame.binary, false)
  return Buffer.from(frame.bytes).toString('utf8')
}

test('real loopback covers every declared orb frame, preemption, and duplex traffic', async () => {
  const {service, calls} = serviceHarness()
  const stop = new AbortController()
  const clock = new VirtualClock()
  const telemetry = new RecordingTelemetry()
  const realtime = new DesktopRealtime({
    executor: CODEX,
    token: TOKEN,
    service,
    stop,
    projectView: {
      workspace_display_name: 'project-a',
      session_title: 'session-a',
      pending_confirmation: false,
      pending_confirmation_busy: false,
    },
    memoryBoard: requestId => JSON.stringify({type: 'memory.board', request_id: requestId}),
    clock,
    telemetry,
  })
  realtime.bridge.onAudioFrame({
    utterance_id: 'stale', generation_epoch: 1, sequence: 0, pcm: new Uint8Array([0, 1]),
  })
  realtime.bridge.onAudioClear('stale', 1)
  const readiness = await settleWithin('desktop realtime server start', realtime.server.start())
  const socket = await connectDesktop(readiness.port)

  try {
    const initial = nextFrames(socket, 5, 'desktop ready and current bridge state')
    await sendClient(socket, JSON.stringify({type: 'hello', token: TOKEN}), 'desktop hello send')
    const initialFrames = await initial
    assert.deepEqual(initialFrames.slice(0, 4).map(frame => text(frame)), [
      '{"type":"desktop.ready"}',
      '{"type":"playback.clear","utterance_id":"stale","generation_epoch":1}',
      '{"type":"executor.state","executor":"codex","display_name":"Codex","state":"running"}',
      '{"type":"project.state","workspace_display_name":"project-a","session_title":"session-a","roster":[],"pending_confirmation":false,"pending_confirmation_busy":false,"pending_action":null,"pending_workspace_display_name":null,"pending_session_title":null,"pending_expires_in_seconds":null}',
    ])

    const downlink = nextFrames(socket, 7, 'desktop bridge downlink families')
    realtime.bridge.onAudioFrame({
      utterance_id: 'u-2', generation_epoch: 2, sequence: 0, pcm: new Uint8Array([2, 3]),
    })
    realtime.bridge.onAudioTerminal('u-2', 2)
    realtime.bridge.onCaption({role: 'user', text: 'caption', final: true})
    realtime.bridge.onExecutorState('idle')
    realtime.bridge.onProjectView({
      workspace_display_name: 'project-b', session_title: null, pending_confirmation: true,
      pending_confirmation_busy: false,
    })
    realtime.bridge.onAudioAlert(null, null)
    const frames = await downlink
    // The first audio write is already in flight when the later alert is enqueued. Preemption applies
    // to queued work (proved above by the pre-auth clear), never to a write the socket has accepted.
    assert.equal(frames[0]?.binary, true)
    assert.deepEqual(decodeAudioFrame(frames[0].bytes), {
      utterance_id: 'u-2', generation_epoch: 2, sequence: 0, pcm: new Uint8Array([2, 3]),
    })
    assert.equal(text(frames[1]!), '{"type":"playback.alert"}')
    assert.match(text(frames[2]!), /"type":"playback\.terminal"/u)
    assert.match(text(frames[3]!), /"type":"caption"/u)
    assert.equal(text(frames[4]!), '{"type":"executor.state","executor":"codex","display_name":"Codex","state":"idle"}')
    assert.match(text(frames[5]!), /"workspace_display_name":"project-b"/u)

    const remaining = nextFrames(socket, 10, 'approval, results, activity, clock and camera producers')
    realtime.bridge.onExecutorApproval({
      pending_approval: false, pending_approval_busy: false, kind: null,
      local_detail: null, operation_summary: null, expires_at: null, work: null, queued: 0,
    })
    realtime.bridge.onExecutorProgress({
      type: 'executor.progress', delegate_id: 'work-1', executor: 'codex', ts: 2,
      phase: 'completed', summary: 'done', level: 'milestone',
    }, {delegate_id: 'work-1', executor: 'codex', outcome: 'ok', summary: 'done',
      started_at: 1, ended_at: 2, changed_files: 0})
    realtime.bridge.onTaskActionResult({type: 'executor.task_action_result', request_id: 'r', work_id: 'work-1', action: 'open', status: 'unavailable'})
    realtime.bridge.onActivity(true)
    realtime.bridge.sendClockPings(1)
    assert.ok(realtime.server instanceof NodeDesktopServer)
    const capture = realtime.server.captureCamera({source: 'local'})
    const permission = realtime.server.requestCameraPermission()
    const remainingFrames = await remaining
    const emittedTypes = [...initialFrames, ...frames, ...remainingFrames]
      .filter(frame => !frame.binary)
      .map(frame => (JSON.parse(text(frame)) as {type: string}).type)
    await sendClient(socket, encodeCameraFrame({
      request_id: 'camera-1', payload: new Uint8Array([0xff, 0xd8, 0x11, 0x22, 0xff, 0xd9]),
    }), 'camera capture response')
    await sendClient(socket, serializeCameraPermissionResult({
      request_id: 'camera-permission-1', status: 'denied',
    }), 'camera permission response')
    await settleWithin('camera capture completed', capture)
    assert.equal(await settleWithin('camera permission completed', permission), 'denied')
    assert.deepEqual(new Set(emittedTypes), new Set(WIRE_FRAME_TYPES),
      'the declared orb contract must equal real authenticated producer output')

    realtime.bridge.registerPing('p-1')
    clock.advanceTo(0.25)
    for (const [label, value] of [
      ['desktop PCM send', new Uint8Array([4, 5, 6, 7])],
      ['desktop speech onset send', JSON.stringify({type: 'speech.onset', speech_id: 's-1'})],
      ['desktop playback started send', JSON.stringify({type: 'playback.started', utterance_id: 'u-2', generation_epoch: 2})],
      ['desktop playback stopped send', JSON.stringify({type: 'playback.stopped', utterance_id: 'u-2', generation_epoch: 2, played_ms: 12})],
      ['desktop playback done send', JSON.stringify({type: 'playback.done', utterance_id: 'u-2', generation_epoch: 2})],
      ['desktop playback cleared send', JSON.stringify({type: 'playback.cleared', utterance_id: 'u-2', generation_epoch: 2, played_ms: 0})],
      ['desktop clock pong send', JSON.stringify({type: 'clock.pong', ping_id: 'p-1', t_render_ms: 4.5})],
    ] as const) await sendClient(socket, value, label)
    await settleWithin('desktop voice controls applied', new Promise<void>(resolve => {
      const check = (): void => {
        if (calls.length >= 6) resolve()
        else setImmediate(check)
      }
      check()
    }))
    assert.deepEqual(calls, [
      'audio:4,5,6,7', 'onset:s-1', 'started:u-2:2', 'stopped:u-2:2:12',
      'done:u-2:2:null', 'cleared:u-2:2:0',
    ])
    assert.deepEqual(telemetry.records.filter(record => record.kind === 'renderer.clock_sync'), [{
      kind: 'renderer.clock_sync',
      payload: {ping_id: 'p-1', round_trip_ms: 250, t_render_ms: 4.5},
    }])
    assert.equal(stop.signal.aborted, false)
  } finally {
    await closeDesktop(socket)
    await settleWithin('desktop realtime server close', realtime.server.close())
  }
})

for (const oversized of [false, true]) test(`personal frames ${oversized ? 'over the bound report errors' : 'above 16 KiB arrive intact'} without stopping realtime`, async () => {
  const {service} = serviceHarness()
  const stop = new AbortController()
  const telemetry = new RecordingTelemetry()
  const snapshot = {type: 'personal.state', revision: 1, tasks: [], feed: [], memory: {entries: []}, conversations: {items: [], messages: []}, data: ''}
  const result = {type: 'personal.result', request_id: 'detail', ok: true, data: ''}
  const bytes = oversized ? 8 * 1024 * 1024 + 1 : 20 * 1024
  snapshot.data = 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(snapshot)))
  result.data = 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(result)))
  const realtime = new DesktopRealtime({token: TOKEN, executor: CODEX, service, stop, telemetry,
    personalCommand: () => Promise.resolve(result), personalSnapshot: () => snapshot})
  const readiness = await realtime.server.start()
  const socket = await connectDesktop(readiness.port)
  try {
    const initial = nextFrames(socket, 3, 'personal frame bootstrap')
    socket.send(JSON.stringify({type: 'hello', token: TOKEN}))
    await initial
    const response = nextFrames(socket, 2, 'personal command and snapshot')
    socket.send(JSON.stringify({type: 'personal.command', request_id: 'detail', method: 'state', params: {}}))
    const frames = (await response).map(frame => JSON.parse(text(frame)) as unknown)
    assert.deepEqual(frames, oversized ? [
      {type: 'personal.result', request_id: 'detail', ok: false, error: 'personal_frame_too_large', input_status: 'unknown'},
      {type: 'personal.error', error: 'personal_frame_too_large'},
    ] : [result, snapshot])
    const update = nextFrames(socket, 1, 'healthy executor update after personal delivery')
    realtime.bridge.onExecutorState('idle')
    assert.equal((JSON.parse(text((await update)[0]!)) as {state: string}).state, 'idle')
    assert.equal(stop.signal.aborted, false)
    if (oversized) assert.deepEqual(telemetry.records.filter(record => record.kind === 'desktop.personal_frame_rejected').map(record => record.payload), [
      {frame_type: 'personal.result', bytes, limit: 8 * 1024 * 1024},
      {frame_type: 'personal.state', bytes, limit: 8 * 1024 * 1024},
    ])
  } finally {
    await closeDesktop(socket)
    await realtime.server.close()
  }
})

test('renderer reconnect receives current state and project without aborting the application', async () => {
  const {service, calls} = serviceHarness()
  const stop = new AbortController()
  let released: (() => void) | undefined
  const connectionReleased = new Promise<void>(resolve => { released = resolve })
  const realtime = new DesktopRealtime({
    executor: CODEX,
    token: TOKEN,
    service,
    stop,
    projectView: {
      workspace_display_name: 'one', session_title: null, pending_confirmation: false,
      pending_confirmation_busy: false,
    },
    onConnectionReleased: () => released?.(),
  })
  const readiness = await settleWithin('reconnect desktop server start', realtime.server.start())
  const first = await connectDesktop(readiness.port)
  try {
    // Include the task snapshot so it cannot spill into the subsequent state-change read.
    const firstState = nextFrames(first, 4, 'first connection current state')
    await sendClient(first, JSON.stringify({type: 'hello', token: TOKEN}), 'first connection hello')
    await firstState
    const changedFrames = nextFrames(first, 2, 'first connection state changes')
    realtime.bridge.onExecutorState('idle')
    realtime.bridge.onProjectView({
      workspace_display_name: 'two', session_title: 'current', pending_confirmation: true,
      pending_confirmation_busy: false,
    })
    const changed = await changedFrames
    assert.equal(text(changed[0]!), '{"type":"executor.state","executor":"codex","display_name":"Codex","state":"idle"}')
    await closeDesktop(first)
    await settleWithin('bridge connection release', connectionReleased)
    assert.ok(calls.includes('playback-disconnected'))
    assert.equal(stop.signal.aborted, false)

    const second = await connectDesktop(readiness.port)
    try {
      const current = nextFrames(second, 3, 'reconnected current state')
      await sendClient(second, JSON.stringify({type: 'hello', token: TOKEN}), 'second connection hello')
      assert.deepEqual((await current).map(frame => text(frame)), [
        '{"type":"desktop.ready"}',
        '{"type":"executor.state","executor":"codex","display_name":"Codex","state":"idle"}',
        '{"type":"project.state","workspace_display_name":"two","session_title":"current","roster":[],"pending_confirmation":true,"pending_confirmation_busy":false,"pending_action":null,"pending_workspace_display_name":null,"pending_session_title":null,"pending_expires_in_seconds":null}',
      ])
    } finally {
      await closeDesktop(second)
    }
  } finally {
    await settleWithin('reconnect desktop server close', realtime.server.close())
  }
})

test('debug board client transfers a large snapshot without owning the renderer connection', async () => {
  const {service} = serviceHarness()
  const stop = new AbortController()
  const realtime = new DesktopRealtime({
    executor: CODEX,
    token: TOKEN,
    service,
    stop,
    memoryBoard: (requestId, detail) => JSON.stringify({
      type: 'memory.board',
      request_id: requestId,
      detail,
      diagnostics: {version: 1, records: []},
      channels: [{items: [{content: 'x'.repeat(20 * 1024)}]}],
    }),
  })
  const readiness = await settleWithin('debug board server start', realtime.server.start())
  const renderer = await connectDesktop(readiness.port)
  let debug: WebSocket | undefined

  try {
    const initial = nextFrames(renderer, 2, 'debug board renderer initial state')
    await sendClient(renderer, JSON.stringify({type: 'hello', token: TOKEN}), 'renderer hello')
    await initial

    debug = await settleWithin('debug board client connect', new Promise<WebSocket>((resolve, reject) => {
      const candidate = new WebSocket(`ws://127.0.0.1:${readiness.port}/debug-board`)
      candidate.once('open', () => resolve(candidate))
      candidate.once('error', reject)
    }))
    const response = nextFrames(debug, 1, 'large debug board response')
    await sendClient(debug, JSON.stringify({type: 'hello', token: TOKEN}), 'debug hello')
    await sendClient(debug, JSON.stringify({
      type: 'debug.board.request',
      request_id: 'debug-1',
      board: 'memory',
      detail: 'compact',
    }), 'debug board request')
    const payload = text((await response)[0]!)
    assert.ok(Buffer.byteLength(payload, 'utf8') > 16 * 1024)
    assert.deepEqual(JSON.parse(payload), {
      type: 'memory.board',
      request_id: 'debug-1',
      detail: 'compact',
      diagnostics: {version: 1, records: []},
      channels: [{items: [{content: 'x'.repeat(20 * 1024)}]}],
    })

    const rendererState = nextFrames(renderer, 1, 'renderer survives debug board response')
    realtime.bridge.onExecutorState('idle')
    assert.equal(text((await rendererState)[0]!), '{"type":"executor.state","executor":"codex","display_name":"Codex","state":"idle"}')
    assert.equal(stop.signal.aborted, false)
  } finally {
    if (debug) await closeDesktop(debug)
    await closeDesktop(renderer)
    await settleWithin('debug board server close', realtime.server.close())
  }
})

test('bridge uplink errors retain the server stable protocol rejection', async () => {
  const {service, calls} = serviceHarness()
  const realtime = new DesktopRealtime({token: TOKEN, service, stop: new AbortController(), executor: CODEX})
  const readiness = await settleWithin('protocol rejection server start', realtime.server.start())
  const socket = await connectDesktop(readiness.port)
  try {
    const initial = nextFrames(socket, 2, 'protocol rejection authentication state')
    await sendClient(socket, JSON.stringify({type: 'hello', token: TOKEN}), 'protocol rejection hello')
    await initial
    const closed = nextClose(socket, 'protocol rejection close')
    await sendClient(socket, new Uint8Array([1]), 'misaligned PCM send')
    assert.deepEqual(await closed, {code: 4003, reason: 'desktop protocol rejected'})
    assert.deepEqual(
      calls.filter(call => call.startsWith('audio:')),
      [],
      'invalid PCM never reaches the service',
    )
  } finally {
    await settleWithin('protocol rejection server close', realtime.server.close())
  }
})

class ControlledServer implements DesktopServerTransport {
  readonly sent: (string | Uint8Array)[] = []
  concurrent = 0
  maxConcurrent = 0
  #next: ((value: string | Uint8Array) => void) | undefined
  #fail = false
  #failValidation = false
  #hold: (() => void) | undefined
  #connected = false
  #clientGeneration = 0
  #disconnectGate: Promise<void> | undefined
  #releaseDisconnect: (() => void) | undefined
  #observeDisconnectStart: (() => void) | undefined
  #observeDisconnected: (() => void) | undefined

  constructor(readonly options: DesktopServerOptions) {}
  start(): Promise<never> { return Promise.reject(new Error('controlled server does not listen')) }
  close(): Promise<void> { return Promise.resolve() }
  nextSend(label: string): Promise<string | Uint8Array> {
    return settleWithin(label, new Promise(resolve => { this.#next = resolve }))
  }
  failNext(): void { this.#fail = true }
  failNextValidation(): void { this.#failValidation = true }
  async connectClient(): Promise<void> {
    if (this.#connected) throw new Error('controlled desktop client already connected')
    this.#connected = true
    this.#clientGeneration += 1
    try {
      await this.options.onClientAuthenticated?.()
    } catch (error) {
      this.#connected = false
      throw error
    }
  }
  holdDisconnect(): void {
    this.#disconnectGate = new Promise(resolve => { this.#releaseDisconnect = resolve })
  }
  releaseDisconnect(): void {
    this.#releaseDisconnect?.()
    this.#releaseDisconnect = undefined
  }
  nextDisconnectStart(label: string): Promise<void> {
    return settleWithin(label, new Promise(resolve => { this.#observeDisconnectStart = resolve }))
  }
  nextDisconnected(label: string): Promise<void> {
    return settleWithin(label, new Promise(resolve => { this.#observeDisconnected = resolve }))
  }
  async disconnectClient(): Promise<void> {
    if (!this.#connected) return
    const generation = this.#clientGeneration
    this.#observeDisconnectStart?.()
    this.#observeDisconnectStart = undefined
    await this.#disconnectGate
    if (!this.#connected || generation !== this.#clientGeneration) return
    this.#connected = false
    this.options.onClientDisconnect?.()
    this.#observeDisconnected?.()
    this.#observeDisconnected = undefined
  }
  holdNext(): Promise<void> { return new Promise(resolve => { this.#hold = resolve }) }
  releaseHeld(): void { this.#hold?.(); this.#hold = undefined }
  sendText(raw: string): Promise<void> {
    // These pump fixtures exercise playback queues; task replay has its own integration test.
    if ((JSON.parse(raw) as {type?: string}).type === 'executor.tasks') return Promise.resolve()
    return this.#send(raw)
  }
  sendBinary(raw: Uint8Array): Promise<void> { return this.#send(raw) }
  async #send(raw: string | Uint8Array): Promise<void> {
    this.concurrent += 1
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent)
    this.sent.push(raw)
    this.#next?.(raw)
    this.#next = undefined
    try {
      if (this.#failValidation) {
        this.#failValidation = false
        throw new DesktopOutboundValidationError('controlled outbound validation failure')
      }
      if (this.#fail) { this.#fail = false; throw new Error('sensitive controlled failure') }
      if (this.#hold !== undefined) await new Promise<void>(resolve => {
        const release = this.#hold
        this.#hold = () => { release?.(); resolve() }
      })
    } finally {
      this.concurrent -= 1
    }
  }
}

function controlledRealtime(stop: AbortController): {
  readonly realtime: DesktopRealtime
  readonly server: ControlledServer
} {
  const {service} = serviceHarness()
  let server: ControlledServer | undefined
  const realtime = new DesktopRealtime({
    executor: CODEX,
    token: TOKEN,
    service,
    stop,
    createServer: options => {
      server = new ControlledServer(options)
      return server
    },
  })
  assert.ok(server !== undefined)
  return {realtime, server}
}

test('one serialized drain retains a wake that arrives while a socket send is held', async () => {
  const stop = new AbortController()
  const {realtime, server} = controlledRealtime(stop)
  const initial = server.nextSend('controlled initial state send')
  await server.connectClient()
  assert.equal(await initial, '{"type":"executor.state","executor":"codex","display_name":"Codex","state":"running"}')

  const held = server.holdNext()
  const audioSend = server.nextSend('controlled held audio send')
  realtime.bridge.onAudioFrame({
    utterance_id: 'held', generation_epoch: 1, sequence: 0, pcm: new Uint8Array([0, 1]),
  })
  assert.ok(await audioSend instanceof Uint8Array)
  realtime.bridge.onCaption({role: 'user', text: 'wake-during-send', final: true})
  assert.equal(server.concurrent, 1)
  const captionSend = server.nextSend('controlled retained wake send')
  server.releaseHeld()
  await settleWithin('controlled held send release', held)
  assert.match(String(await captionSend), /wake-during-send/u)
  assert.equal(server.maxConcurrent, 1)
  assert.equal(stop.signal.aborted, false)
})

test('connection ownership refuses a second claim and fences an old held generation', async () => {
  const stop = new AbortController()
  const {realtime, server} = controlledRealtime(stop)
  const initial = server.nextSend('owned connection initial state')
  await server.connectClient()
  await initial
  await assert.rejects(
    server.connectClient(),
    /controlled desktop client already connected/u,
  )

  const oldHeld = server.holdNext()
  const oldSend = server.nextSend('old generation held caption')
  realtime.bridge.onCaption({role: 'user', text: 'old-generation', final: true})
  await oldSend
  await server.disconnectClient()

  const freshState = server.nextSend('fresh generation current state')
  await server.connectClient()
  server.releaseHeld()
  await settleWithin('old generation held send release', oldHeld)
  assert.equal(await freshState, '{"type":"executor.state","executor":"codex","display_name":"Codex","state":"running"}')
  assert.equal(server.maxConcurrent, 1, 'the fresh generation never shares the old writer')
  assert.equal(stop.signal.aborted, false)
})

test('required send failure and bridge overflow abort, while droppable/latest failures survive', async () => {
  const requiredStop = new AbortController()
  const required = controlledRealtime(requiredStop)
  const requiredInitial = required.server.nextSend('required failure initial state')
  await required.server.connectClient()
  await requiredInitial
  required.server.failNext()
  const requiredAttempt = required.server.nextSend('required failing send attempt')
  required.realtime.bridge.onAudioFrame({
    utterance_id: 'required', generation_epoch: 1, sequence: 0, pcm: new Uint8Array([0, 1]),
  })
  await requiredAttempt
  await settleWithin('required failure application abort', new Promise<void>(resolve => {
    if (requiredStop.signal.aborted) resolve()
    else requiredStop.signal.addEventListener('abort', () => resolve(), {once: true})
  }))

  const softStop = new AbortController()
  const soft = controlledRealtime(softStop)
  const softInitial = soft.server.nextSend('soft failure initial state')
  await soft.server.connectClient()
  await softInitial
  soft.server.holdDisconnect()
  const disconnectStarted = soft.server.nextDisconnectStart('soft failure transport disconnect start')
  soft.server.failNext()
  const captionAttempt = soft.server.nextSend('droppable failing send attempt')
  soft.realtime.bridge.onCaption({role: 'user', text: 'droppable', final: true})
  await captionAttempt
  assert.equal(softStop.signal.aborted, false)
  await disconnectStarted
  await assert.rejects(
    soft.server.connectClient(),
    /controlled desktop client already connected/u,
  )
  const disconnected = soft.server.nextDisconnected('soft failure transport disconnected')
  soft.server.releaseDisconnect()
  await disconnected

  const reconnectState = soft.server.nextSend('soft failure reconnect state')
  await soft.server.connectClient()
  assert.equal(await reconnectState, '{"type":"executor.state","executor":"codex","display_name":"Codex","state":"running"}')
  soft.server.failNext()
  const latestAttempt = soft.server.nextSend('latest failing send attempt')
  soft.server.holdDisconnect()
  const latestDisconnected = soft.server.nextDisconnected('latest failure transport disconnected')
  soft.realtime.bridge.onExecutorState('idle')
  await latestAttempt
  assert.equal(softStop.signal.aborted, false)
  soft.server.releaseDisconnect()
  await latestDisconnected
  const currentState = soft.server.nextSend('latest failure current state retry')
  await soft.server.connectClient()
  assert.equal(await currentState, '{"type":"executor.state","executor":"codex","display_name":"Codex","state":"idle"}')

  const overflowStop = new AbortController()
  const overflowService = serviceHarness().service
  const overflow = new DesktopRealtime({
    executor: CODEX,
    token: TOKEN, service: overflowService, stop: overflowStop, maxOutboundFrames: 1,
    createServer: options => new ControlledServer(options),
  })
  overflow.bridge.onAudioFrame({
    utterance_id: 'overflow', generation_epoch: 1, sequence: 0, pcm: new Uint8Array([0, 1]),
  })
  overflow.bridge.onAudioFrame({
    utterance_id: 'overflow', generation_epoch: 1, sequence: 1, pcm: new Uint8Array([2, 3]),
  })
  assert.equal(overflowStop.signal.aborted, true)
})

test('droppable local validation failure is diagnosed without disconnecting a healthy client', async () => {
  const stop = new AbortController()
  const telemetry = new RecordingTelemetry()
  const clock = new VirtualClock(5)
  const {service} = serviceHarness()
  let server: ControlledServer | undefined
  const realtime = new DesktopRealtime({
    executor: CODEX,
    token: TOKEN,
    service,
    stop,
    clock,
    telemetry,
    createServer: options => {
      server = new ControlledServer(options)
      return server
    },
  })
  const controlled = server!
  const initial = controlled.nextSend('validation failure initial state')
  await controlled.connectClient()
  await initial

  controlled.failNextValidation()
  const rejectedCaption = controlled.nextSend('locally rejected caption attempt')
  realtime.bridge.onCaption({role: 'user', text: 'droppable', final: true})
  await rejectedCaption

  const currentState = controlled.nextSend('state after local validation failure')
  realtime.bridge.onExecutorState('idle')
  assert.equal(await currentState, '{"type":"executor.state","executor":"codex","display_name":"Codex","state":"idle"}')
  assert.equal(stop.signal.aborted, false)
  assert.deepEqual(telemetry.records.at(-1), {
    kind: 'desktop.outbound_validation_dropped',
    payload: {policy: 'droppable', frame_kind: 'text'},
  })
})

test('task actions bind exact host work and reject unauthenticated or stale opens', async () => {
  const {service} = serviceHarness()
  const opened: string[] = []
  const cancelled: string[] = []
  let resolvePath!: (value: string) => void
  const desktop = new DesktopRealtime({token: TOKEN, service, executor: CODEX, stop: {abort() { /* unused by host action fixture */ }},
    taskPort: {cancelTask: id => {cancelled.push(id); return 'cancelling'}, taskDirectory: () => new Promise(resolve => {resolvePath = resolve})},
    openTaskDirectory: path => {opened.push(path); return Promise.resolve()},
    createServer: () => ({sendText: () => Promise.resolve(), sendBinary: () => Promise.resolve(), disconnectClient: () => Promise.resolve(), start: () => Promise.resolve({} as never), close: () => Promise.resolve()}),
  })
  const request = {type: 'executor.task_action' as const, request_id: 'r', work_id: 'a', executor: 'codex', action: 'cancel' as const}
  await assert.rejects(async () => desktop.serverOptions.onControl?.(request), /unauthenticated/)
  await desktop.serverOptions.onClientAuthenticated?.()
  const progress = {type: 'executor.progress' as const, executor: 'codex', delegate_id: 'a', phase: 'working' as const, summary: '进展', level: 'detail' as const, ts: 1}
  desktop.bridge.onExecutorProgress(progress)
  await desktop.serverOptions.onControl?.(request)
  desktop.bridge.onExecutorProgress({...progress, phase: 'completed', ts: 2})
  desktop.bridge.onExecutorProgress({...progress, delegate_id: 'b', ts: 3})
  await desktop.serverOptions.onControl?.(request)
  assert.deepEqual(cancelled, ['a'])
  const opening = desktop.serverOptions.onControl?.({...request, action: 'open'})
  desktop.serverOptions.onClientDisconnect?.()
  resolvePath('/tmp')
  await opening
  assert.deepEqual(opened, [])
})

test('task actions return bounded unavailable and failed receipts without renderer targets', async () => {
  const {service} = serviceHarness()
  const sent: string[] = []
  const desktop = new DesktopRealtime({token: TOKEN, service, executor: CODEX, stop: new AbortController(),
    taskPort: {cancelTask: () => 'not_running', taskDirectory: () => Promise.reject(new Error('private path failure'))},
    createServer: () => ({sendText: raw => {sent.push(raw); return Promise.resolve()}, sendBinary: () => Promise.resolve(), disconnectClient: () => Promise.resolve(), start: () => Promise.resolve({} as never), close: () => Promise.resolve()}),
  })
  await desktop.serverOptions.onClientAuthenticated?.()
  desktop.bridge.onExecutorProgress({type: 'executor.progress', executor: 'codex', delegate_id: 'a', phase: 'working', summary: '进展', level: 'detail', ts: 1})
  for (const executor of ['foreign', 'codex']) await desktop.serverOptions.onControl?.({type: 'executor.task_action', request_id: executor, work_id: 'a', executor, action: 'open'})
  await new Promise<void>(resolve => setImmediate(resolve))
  const results = sent.map(raw => JSON.parse(raw) as {type: string; status: string}).filter(frame => frame.type === 'executor.task_action_result')
  assert.deepEqual(results.map(frame => frame.status), ['unavailable', 'failed'])
  assert.ok(sent.every(raw => !raw.includes('private path failure')))
})

test('a pending folder launch does not block subsequent inbound audio', async () => {
  const {service, calls} = serviceHarness()
  let release!: () => void
  const desktop = new DesktopRealtime({token: TOKEN, service, executor: CODEX, stop: new AbortController(),
    taskPort: {cancelTask: () => 'not_running', taskDirectory: () => Promise.resolve('/tmp')},
    openTaskDirectory: () => new Promise<void>(resolve => {release = resolve}),
    createServer: () => ({sendText: () => Promise.resolve(), sendBinary: () => Promise.resolve(), disconnectClient: () => Promise.resolve(), start: () => Promise.resolve({} as never), close: () => Promise.resolve()}),
  })
  await desktop.serverOptions.onClientAuthenticated?.()
  desktop.bridge.onExecutorProgress({type: 'executor.progress', executor: 'codex', delegate_id: 'a', phase: 'working', summary: '进展', level: 'detail', ts: 1})
  try {
    // This is the ordering used by NodeDesktopServer's serialized inbound queue.
    await settleWithin('folder control dispatch', Promise.resolve(desktop.serverOptions.onControl?.({type: 'executor.task_action', request_id: 'open', work_id: 'a', executor: 'codex', action: 'open'})))
    await desktop.serverOptions.onAudio?.(new Uint8Array([0, 0]))
    assert.ok(calls.includes('audio:0,0'))
  } finally { release?.() }
})
test('personal commands use stable host desktop identity across reconnect and never default remote to local',async()=>{
 const {service}=serviceHarness(),identities:unknown[]=[]
 for(const transportFailure of ['abort','disconnect'] as const){
  const desktop=new DesktopRealtime({token:TOKEN,service,stop:new AbortController(),transportFailure,
   personalCommand:(_command,context)=>{identities.push(context);return Promise.resolve({ok:true})},
   createServer:()=>({sendText:()=>Promise.resolve(),sendBinary:()=>Promise.resolve(),disconnectClient:()=>Promise.resolve(),start:()=>Promise.resolve({} as never),close:()=>Promise.resolve()})})
  for(let i=0;i<2;i++){
   await desktop.serverOptions.onClientAuthenticated?.()
   await desktop.serverOptions.onControl?.({type:'personal.command',request_id:'identity',method:'tasks.list',params:{}})
   desktop.serverOptions.onClientDisconnect?.()
  }
 }
 assert.deepEqual(identities,[{client_id:'desktop:local'},{client_id:'desktop:local'},undefined,undefined])
})

}
