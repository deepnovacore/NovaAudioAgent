import assert from 'node:assert/strict'
import {test} from 'node:test'
import type {ExecutorProgress} from '../src/causal-runtime.js'
import {VirtualClock, type Clock} from '../src/clock.js'
import {CodexProtocolError, MAX_FINAL_TEXT_INPUT, MAX_INTERNAL_ACTIVITY} from '../src/codex-protocol.js'
import {AppServerTurnProjection} from '../src/codex-turn-projection.js'

function ephemeralThread(
  id = 'PRIVATE-THREAD',
  approvalPolicy: 'never' | 'on-request' = 'never',
): Record<string, unknown> {
  return {
    thread: {id, ephemeral: true, path: null, cwd: '/workspace'},
    cwd: '/workspace',
    approvalPolicy,
    activePermissionProfile: {id: 'nova_audio_agent'},
  }
}

function persistentThread(): Record<string, unknown> {
  return {
    thread: {
      id: 'PRIVATE-THREAD',
      ephemeral: false,
      path: '/PRIVATE/PERSISTED/rollout.jsonl',
      cwd: '/workspace',
    },
    cwd: '/workspace',
    runtimeWorkspaceRoots: ['/workspace'],
    approvalPolicy: 'never',
    activePermissionProfile: {id: 'nova_audio_agent'},
  }
}

function startedProjection(
  clock: Clock = new VirtualClock(),
  onProgress: ((progress: ExecutorProgress) => void) | undefined = undefined,
): AppServerTurnProjection {
  const projection = new AppServerTurnProjection({
    clock,
    ...(onProgress === undefined ? {} : {onProgress}),
  })
  projection.bindThread(ephemeralThread(), {workspace: '/workspace'})
  projection.notification('turn/started', {
    threadId: 'PRIVATE-THREAD', turn: {id: 'PRIVATE-TURN'},
  })
  return projection
}

function item(projection: AppServerTurnProjection, value: Record<string, unknown>): void {
  projection.notification('item/completed', {
    threadId: 'PRIVATE-THREAD', turnId: 'PRIVATE-TURN', item: value,
  })
}

function code(error: unknown): string | undefined {
  return error instanceof CodexProtocolError ? error.code : undefined
}

test('thread binding accepts exact ephemeral and persistent workspace identities', () => {
  const ephemeral = new AppServerTurnProjection({clock: new VirtualClock()})
  ephemeral.bindThread(ephemeralThread(), {workspace: '/workspace'})
  assert.equal(ephemeral.threadId, 'PRIVATE-THREAD')

  const persistent = new AppServerTurnProjection({clock: new VirtualClock()})
  persistent.bindThread(persistentThread(), {
    workspace: '/workspace', ephemeral: false, expectedThreadId: 'PRIVATE-THREAD',
  })
  assert.equal(persistent.threadId, 'PRIVATE-THREAD')
})

test('thread binding requires the response policy to equal the requested policy', () => {
  for (const approvalPolicy of ['never', 'on-request'] as const) {
    const projection = new AppServerTurnProjection({clock: new VirtualClock()})
    projection.bindThread(ephemeralThread('PRIVATE-THREAD', approvalPolicy), {
      workspace: '/workspace',
      approvalPolicy,
    })
    assert.equal(projection.threadId, 'PRIVATE-THREAD')

    const mismatch = new AppServerTurnProjection({clock: new VirtualClock()})
    assert.throws(() => mismatch.bindThread(
      ephemeralThread('PRIVATE-THREAD', approvalPolicy === 'never' ? 'on-request' : 'never'),
      {workspace: '/workspace', approvalPolicy},
    ), error => code(error) === 'unsupported_protocol')
  }
})

test('thread identity, policy, mode, root, and active profile mismatches are private failures', () => {
  const mutations: ((value: Record<string, unknown>) => void)[] = [
    value => { (value.thread as Record<string, unknown>).id = 'OTHER' },
    value => { (value.thread as Record<string, unknown>).cwd = '/PRIVATE/OTHER' },
    value => { value.cwd = '/PRIVATE/OTHER' },
    value => { value.runtimeWorkspaceRoots = ['/workspace', '/PRIVATE/OTHER'] },
    value => { value.runtimeWorkspaceRoots = ['/PRIVATE/OTHER'] },
    value => { value.activePermissionProfile = {id: 'danger'} },
    value => { value.approvalPolicy = 'on-request' },
    value => { (value.thread as Record<string, unknown>).ephemeral = true },
    value => { (value.thread as Record<string, unknown>).path = '' },
  ]
  for (const mutate of mutations) {
    const response = structuredClone(persistentThread())
    mutate(response)
    const projection = new AppServerTurnProjection({clock: new VirtualClock()})
    assert.throws(() => projection.bindThread(response, {
      workspace: '/workspace', ephemeral: false, expectedThreadId: 'PRIVATE-THREAD',
    }), error => {
      assert.equal(code(error), 'unsupported_protocol')
      assert.equal(String(error).includes('PRIVATE'), false)
      return true
    })
  }
})

test('turn response and notification correlate in either order and emit one exact start', () => {
  for (const notificationFirst of [false, true]) {
    const progress: ExecutorProgress[] = []
    const projection = new AppServerTurnProjection({clock: new VirtualClock(), onProgress: value => {
      progress.push(value)
    }})
    projection.bindThread(ephemeralThread(), {workspace: '/workspace'})
    if (notificationFirst) {
      projection.notification('turn/started', {
        threadId: 'PRIVATE-THREAD', turn: {id: 'PRIVATE-TURN'},
      })
      assert.equal(projection.bindTurnResponse({turn: {id: 'PRIVATE-TURN'}}), 'PRIVATE-TURN')
    } else {
      assert.equal(projection.bindTurnResponse({turn: {id: 'PRIVATE-TURN'}}), 'PRIVATE-TURN')
      projection.notification('turn/started', {
        threadId: 'PRIVATE-THREAD', turn: {id: 'PRIVATE-TURN'},
      })
    }
    assert.deepEqual(progress, [{
      phase: 'started', internal_activity: 0, elapsed: 0, summary: null,
    }])
    assert.equal(projection.turnWasStarted, true)
    assert.equal(projection.activePair !== null, true)
  }
})

test('file approval correlates by current item identity, not its independent request timestamp', () => {
  const projection = startedProjection()
  const fileItem = {
    id: 'PRIVATE-FILE-ITEM', type: 'fileChange', status: 'inProgress',
    changes: [{path: '/workspace/src/a.ts', diff: 'private', kind: {type: 'add'}}],
  }
  projection.notification('item/started', {
    threadId: 'PRIVATE-THREAD', turnId: 'PRIVATE-TURN', startedAtMs: 10, item: fileItem,
  })
  assert.deepEqual(projection.fileChangeItemForApproval(
    'PRIVATE-THREAD', 'PRIVATE-TURN', 'PRIVATE-FILE-ITEM', 10,
  ), fileItem)
  assert.equal(projection.fileChangeItemForApproval(
    'PRIVATE-THREAD', 'PRIVATE-TURN', 'PRIVATE-FILE-ITEM', 11,
  )?.id, 'PRIVATE-FILE-ITEM')
  assert.equal(projection.fileChangeItemForApproval(
    'PRIVATE-THREAD', 'PRIVATE-TURN', 'PRIVATE-FILE-ITEM', -1,
  ), null)
  assert.equal(projection.fileChangeItemForApproval(
    'PRIVATE-THREAD', 'PRIVATE-TURN', 'MISSING', 10,
  ), null)

  projection.notification('item/completed', {
    threadId: 'PRIVATE-THREAD', turnId: 'PRIVATE-TURN', item: {
      ...fileItem, status: 'completed',
    },
  })
  assert.equal(projection.fileChangeItemForApproval(
    'PRIVATE-THREAD', 'PRIVATE-TURN', 'PRIVATE-FILE-ITEM', 10,
  ), null)

  projection.notification('turn/completed', {
    threadId: 'PRIVATE-THREAD',
    turn: {id: 'PRIVATE-TURN', status: 'completed', items: []},
  })
  assert.equal(projection.fileChangeItemForApproval(
    'PRIVATE-THREAD', 'PRIVATE-TURN', 'PRIVATE-FILE-ITEM', 10,
  ), null)
})

test('turn identity mismatch fails without exposing either private identity', () => {
  const projection = new AppServerTurnProjection({clock: new VirtualClock()})
  projection.bindThread(ephemeralThread(), {workspace: '/workspace'})
  projection.notification('turn/started', {
    threadId: 'PRIVATE-THREAD', turn: {id: 'PRIVATE-NOTIFICATION'},
  })
  assert.throws(() => projection.bindTurnResponse({turn: {id: 'PRIVATE-RESPONSE'}}), error => {
    assert.equal(code(error), 'turn_identity_mismatch')
    assert.equal(String(error).includes('PRIVATE'), false)
    return true
  })
})

test('count-only work waits for the 30 second keepalive while first prose emits immediately', () => {
  const clock = new VirtualClock()
  const progress: ExecutorProgress[] = []
  const projection = startedProjection(clock, value => { progress.push(value) })
  item(projection, {type: 'commandExecution', command: 'PRIVATE-COMMAND', exitCode: 0})
  assert.equal(progress.length, 1)
  clock.advanceTo(29)
  item(projection, {type: 'fileChange', changes: [{path: '/PRIVATE/PATH'}]})
  assert.equal(progress.length, 1)
  clock.advanceTo(30)
  item(projection, {type: 'agentMessage', text: ' 正在实现\n核心 '})
  assert.deepEqual(progress.at(-1), {
    phase: 'working',
    internal_activity: 3,
    elapsed: 30,
    summary: '已执行 1 条命令、已修改 1 处文件。正在实现 核心',
  })
  assert.equal(JSON.stringify(progress).includes('PRIVATE'), false)
})

test('typed summaries use exact Chinese counts and the latest allowed prose only', () => {
  const clock = new VirtualClock()
  const progress: ExecutorProgress[] = []
  const projection = startedProjection(clock, value => { progress.push(value) })
  item(projection, {type: 'commandExecution', command: 'PRIVATE', exitCode: 0})
  item(projection, {type: 'commandExecution', output: 'PRIVATE', exitCode: 7})
  item(projection, {type: 'fileChange', changes: [{path: 'PRIVATE'}, {path: 'PRIVATE'}]})
  item(projection, {type: 'mcpToolCall', tool: 'PRIVATE', arguments: {token: 'PRIVATE'}})
  item(projection, {type: 'webSearch', query: 'PRIVATE'})
  item(projection, {type: 'plan', text: '旧计划'})
  item(projection, {type: 'agentMessage', text: '最新说明'})
  clock.advanceTo(30)
  item(projection, {type: 'unknownFuture', text: 'PRIVATE-UNKNOWN'})
  assert.equal(
    progress.at(-1)?.summary,
    '已执行 2 条命令（1 条失败）、已修改 2 处文件、已调用 2 次工具。最新说明',
  )
  assert.equal(JSON.stringify(progress).includes('PRIVATE'), false)
})

test('reasoning, user, foreign, late, and duplicate events contribute nothing', () => {
  const clock = new VirtualClock()
  const progress: ExecutorProgress[] = []
  const projection = startedProjection(clock, value => { progress.push(value) })
  item(projection, {type: 'reasoning', text: 'PRIVATE-REASONING'})
  item(projection, {type: 'userMessage', text: 'PRIVATE-USER'})
  projection.notification('item/completed', {
    threadId: 'OTHER', turnId: 'PRIVATE-TURN',
    item: {type: 'agentMessage', text: 'PRIVATE-FOREIGN'},
  })
  projection.notification('turn/started', {
    threadId: 'PRIVATE-THREAD', turn: {id: 'DUPLICATE'},
  })
  clock.advanceTo(30)
  item(projection, {type: 'unknown', text: 'PRIVATE-UNKNOWN'})
  assert.deepEqual(progress.at(-1), {
    phase: 'working', internal_activity: 3, elapsed: 30, summary: null,
  })
  assert.equal(JSON.stringify(progress).includes('PRIVATE'), false)
})

test('summary prose collapses Python whitespace and clips by code point before final limit', () => {
  const progress: ExecutorProgress[] = []
  const projection = startedProjection(new VirtualClock(), value => { progress.push(value) })
  item(projection, {type: 'agentMessage', text: `\u001c  a\u0085b\n${'😀'.repeat(300)}`})
  assert.equal(progress.at(-1)?.summary, `a b ${'😀'.repeat(236)}`)
  assert.equal([...(progress.at(-1)?.summary ?? '')].length, 240)
})

test('matching terminal projects only final agent text and clears the active pair', () => {
  const projection = startedProjection()
  item(projection, {type: 'agentMessage', text: 'fallback'})
  const completion = projection.notification('turn/completed', {
    threadId: 'PRIVATE-THREAD',
    turn: {
      id: 'PRIVATE-TURN',
      status: 'interrupted',
      items: [
        {type: 'userMessage', text: 'PRIVATE-USER'},
        {type: 'agentMessage', text: 'first'},
        {type: 'commandExecution', command: 'PRIVATE-COMMAND'},
        {type: 'agentMessage', text: 'safe final'},
      ],
    },
  })
  assert.deepEqual(completion, {status: 'failed', final_text: 'safe final', internal_activity: 1})
  assert.equal(projection.activePair, null)
  assert.equal(JSON.stringify(completion).includes('PRIVATE'), false)
  item(projection, {type: 'agentMessage', text: 'PRIVATE-LATE'})
})

test('notLoaded fallback retains at most 65,536 code points and foreign terminal is ignored', () => {
  const projection = startedProjection()
  item(projection, {type: 'agentMessage', text: '😀'.repeat(MAX_FINAL_TEXT_INPUT + 10)})
  assert.equal(projection.notification('turn/completed', {
    threadId: 'OTHER', turn: {id: 'PRIVATE-TURN', status: 'completed', items: []},
  }), null)
  const completion = projection.notification('turn/completed', {
    threadId: 'PRIVATE-THREAD',
    turn: {id: 'PRIVATE-TURN', status: 'completed', items: [], itemsView: 'notLoaded'},
  })
  assert.equal([...(completion?.final_text ?? '')].length, MAX_FINAL_TEXT_INPUT)
})

test('malformed matching terminal fails while malformed foreign terminal is ignored', () => {
  const projection = startedProjection()
  assert.equal(projection.notification('turn/completed', {
    threadId: 'OTHER', turn: {secret: 'PRIVATE'},
  }), null)
  assert.throws(() => projection.notification('turn/completed', {
    threadId: 'PRIVATE-THREAD', turn: {id: 'PRIVATE-TURN', status: 'completed'},
  }), error => code(error) === 'unsupported_protocol')
})

test('callback failures and non-finite elapsed cannot break terminal projection', () => {
  let now = 0
  const clock: Clock = {now: () => now, sleep: () => Promise.resolve()}
  const projection = startedProjection(clock, () => { throw new Error('PRIVATE CALLBACK') })
  now = Number.NaN
  item(projection, {type: 'agentMessage', text: 'safe'})
  const completion = projection.notification('turn/completed', {
    threadId: 'PRIVATE-THREAD',
    turn: {id: 'PRIVATE-TURN', status: 'completed', items: [], itemsView: 'notLoaded'},
  })
  assert.equal(completion?.final_text, 'safe')
})

test('direct projection rejects item accessors without reading or surfacing their changing value', () => {
  const progress: ExecutorProgress[] = []
  const projection = startedProjection(new VirtualClock(), value => { progress.push(value) })
  let reads = 0
  const completedItem: Record<string, unknown> = {type: 'agentMessage'}
  Object.defineProperty(completedItem, 'text', {
    enumerable: true,
    get: () => {
      reads += 1
      return reads === 1 ? 'safe' : 'PRIVATE'
    },
  })
  assert.throws(() => projection.notification('item/completed', {
    threadId: 'PRIVATE-THREAD', turnId: 'PRIVATE-TURN', item: completedItem,
  }), error => code(error) === 'unsupported_protocol')
  assert.equal(reads, 0)
  assert.equal(JSON.stringify(progress).includes('PRIVATE'), false)
})

test('activity count saturates at the fixed bound', () => {
  const projection = startedProjection()
  for (let index = 0; index < MAX_INTERNAL_ACTIVITY + 1; index += 1) {
    item(projection, {type: 'unknown'})
  }
  const completion = projection.notification('turn/completed', {
    threadId: 'PRIVATE-THREAD',
    turn: {id: 'PRIVATE-TURN', status: 'completed', items: []},
  })
  assert.equal(completion?.internal_activity, MAX_INTERNAL_ACTIVITY)
})
