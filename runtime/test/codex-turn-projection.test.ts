import assert from 'node:assert/strict'
import {test} from 'node:test'
import type {ExecutorProgress,ExecutorActivity} from '../src/core/causal-runtime.js'
import {VirtualClock, type Clock} from '../src/core/clock.js'
import {CodexProtocolError, MAX_FINAL_TEXT_INPUT, MAX_INTERNAL_ACTIVITY} from '../src/executors/codex/protocol.js'
import {AppServerTurnProjection} from '../src/executors/codex/turn-projection.js'
import {resolveCodexLaunchProfile} from '../src/executors/codex/launch-profile.js'

function ephemeralThread(
  id = 'PRIVATE-THREAD',
  approvalPolicy: 'never' | 'on-request' = 'never',
): Record<string, unknown> {
  return {
    thread: {id, ephemeral: true, path: null, cwd: '/workspace'},
    cwd: '/workspace',
    approvalPolicy,
    approvalsReviewer: 'user',
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
    approvalsReviewer: 'user',
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

test('every launch profile requires the user reviewer and yolo requires dangerFullAccess', () => {
  for (const launchProfile of [
    resolveCodexLaunchProfile({approvalMode: 'ask', project: true, foregroundBroker: true}),
    resolveCodexLaunchProfile({approvalMode: 'ask', project: true, foregroundBroker: false}),
    resolveCodexLaunchProfile({approvalMode: 'yolo', project: true, foregroundBroker: true}),
  ]) {
    const response = ephemeralThread('PRIVATE-THREAD', launchProfile.thread.approvalPolicy)
    if (launchProfile.id === 'yolo') {
      response.activePermissionProfile = null
      response.sandbox = {type: 'dangerFullAccess'}
    }
    const options = {workspace: '/workspace', launchProfile}
    const create = (): AppServerTurnProjection => new AppServerTurnProjection({clock: new VirtualClock()})
    assert.doesNotThrow(() => create().bindThread(response, options))
    for (const approvalsReviewer of ['auto_review', 'guardian_subagent', null, undefined]) {
      const projection = create()
      assert.throws(() => projection.bindThread({...response, approvalsReviewer}, options),
        error => code(error) === 'unsupported_protocol')
      assert.equal(projection.threadId, null)
    }
    if (launchProfile.id === 'yolo') {
      for (const sandbox of [{type: 'readOnly'}, {type: 'workspaceWrite'}, {}, null, undefined]) {
        const projection = create()
        assert.throws(() => projection.bindThread({...response, sandbox}, options),
          error => code(error) === 'unsupported_protocol')
        assert.equal(projection.threadId, null)
      }
    }
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
    summary: '正在实现 核心',
  })
  assert.equal(JSON.stringify(progress).includes('PRIVATE'), false)
})

test('new prose emits once while later activity never repackages old prose or counters', () => {
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
  assert.deepEqual(progress.map(value => value.summary).filter(value => value !== null), ['旧计划', '最新说明'])
  assert.equal(progress.at(-1)?.summary, null)
  item(projection, {type: 'agentMessage', text: '最新说明'})
  assert.equal(progress.filter(value => value.summary === '最新说明').length, 1)
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
  assert.deepEqual(completion, {status: 'failed', final_text: 'safe final', internal_activity: 1, error_code: null})
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

for (const eager of [false, true]) {
  test(`tool progress is factual, bounded and eager-only: ${eager}`, () => {
    const clock = new VirtualClock()
    const events: ExecutorProgress[] = []
    const projection = new AppServerTurnProjection({clock, eagerProgress: eager, workingInterval: 30,
      onProgress: value => events.push(value)})
    projection.bindThread(ephemeralThread(), {workspace: '/workspace'})
    projection.notification('turn/started', {threadId: 'PRIVATE-THREAD', turn: {id: 'PRIVATE-TURN'}})
    const completed = {type: 'commandExecution', status: 'completed', command: 'SECRET-COMMAND', aggregatedOutput: 'SECRET-OUTPUT'}
    clock.advanceTo(30)
    item(projection, completed)
    assert.equal(events.at(-1)?.summary, null)
    clock.advanceTo(60)
    item(projection, completed)
    assert.equal(events.at(-1)?.summary, eager ? '一条工作区命令已执行结束，尚未确认任务最终结果。' : null)
    clock.advanceTo(120)
    item(projection, completed)
    assert.equal(events.at(-1)?.summary, null, 'same operational status is not repeated')
    item(projection, {type: 'fileChange', status: 'completed', changes: [{path: 'SECRET-PATH'}]})
    if (eager) assert.equal(events.at(-1)?.summary, '已应用一批文件修改，尚未确认验证结果。')
    clock.advanceTo(180)
    item(projection, {...completed, status: 'failed'})
    assert.equal(events.at(-1)?.summary, eager ? '一条工作区命令执行失败，尚未确认恢复结果。' : null)
    clock.advanceTo(240)
    item(projection, {type: 'reasoning', text: 'SECRET-REASONING'})
    assert.equal(events.at(-1)?.summary, null)
    item(projection, {type: 'agentMessage', text: 'Actual explanation'})
    assert.equal(events.at(-1)?.summary, 'Actual explanation')
    clock.advanceTo(270)
    item(projection, {...completed, status: 'failed'})
    assert.equal(events.at(-1)?.summary, null, 'fresh commentary suppresses fallback for a minute')
    clock.advanceTo(300)
    const countBeforeForeign = events.length
    projection.notification('item/completed', {threadId: 'OTHER', turnId: 'PRIVATE-TURN', item: completed})
    assert.equal(events.length, countBeforeForeign, 'foreign events do not create progress')
    item(projection, {...completed, status: 'inProgress'})
    assert.equal(events.at(-1)?.summary, null, 'unknown or nonterminal status cannot invent completion')
    assert.ok(!JSON.stringify(events).includes('SECRET'))
  })
}

test('public projection rejects wrong pairs, hides reasoning, and preserves item stages',()=>{
 const events: ExecutorActivity[]=[]
 const projection=new AppServerTurnProjection({clock:new VirtualClock(),onActivity:event=>events.push(event)})
 projection.bindThread(ephemeralThread(),{workspace:'/workspace'})
 projection.bindTurnResponse({turn:{id:'PRIVATE-TURN'}})
 const event={threadId:'PRIVATE-THREAD',turnId:'PRIVATE-TURN',item:{id:'m',type:'agentMessage',text:'Checking'}}
 projection.notification('item/completed',event)
 projection.notification('turn/started',{threadId:'PRIVATE-THREAD',turn:{id:'PRIVATE-TURN'}})
 projection.notification('item/completed',{...event,turnId:'wrong'})
 item(projection,{id:'reason',type:'reasoning',text:'Never display'})
 projection.notification('item/started',event)
 projection.notification('item/started',event)
 projection.notification('item/completed',event)
 assert.equal(events.length,2)
 assert.deepEqual(events.map(event=>event.stage),['started','completed'])
 assert.ok(events.every(event=>event.sender==='executor'&&event.text==='Checking'))
 item(projection,{id:'long',type:'agentMessage',text:'x'.repeat(17000)})
 assert.equal(events.at(-1)?.text.length,16000);assert.equal(events.at(-1)?.text_truncated,true)
})

test('public file changes retain workspace artifact refs and ignore late started stage',()=>{
 const events:ExecutorActivity[]=[]
 const projection=new AppServerTurnProjection({clock:new VirtualClock(),onActivity:event=>events.push(event)})
 projection.bindThread(ephemeralThread(),{workspace:'/workspace'})
 projection.bindTurnResponse({turn:{id:'PRIVATE-TURN'}})
 projection.notification('turn/started',{threadId:'PRIVATE-THREAD',turn:{id:'PRIVATE-TURN'}})
 const change={id:'file',type:'fileChange',status:'completed',changes:[
  {path:'/workspace/src/login.ts',kind:{type:'update'}},
  {path:'/workspace/.env.local',kind:{type:'update'}},
  {path:'/workspace/config/api_key.txt',kind:{type:'update'}},
  {path:'/workspace/certs/server.pem',kind:{type:'update'}},
  {path:'/workspace/notes/token=private-value.txt',kind:{type:'update'}},
  {path:'/private/secrets',kind:{type:'update'}},
 ]}
 item(projection,change)
 projection.notification('item/started',{threadId:'PRIVATE-THREAD',turnId:'PRIVATE-TURN',item:change})
 assert.equal(events.length,1);assert.deepEqual(events[0]?.refs,['workspace-file:src/login.ts'])
})

test('turn completion replays public items omitted from item notifications exactly once',()=>{
 const events:ExecutorActivity[]=[]
 const projection=new AppServerTurnProjection({clock:new VirtualClock(),onActivity:event=>events.push(event)})
 projection.bindThread(ephemeralThread(),{workspace:'/workspace'})
 projection.bindTurnResponse({turn:{id:'PRIVATE-TURN'}})
 projection.notification('turn/started',{threadId:'PRIVATE-THREAD',turn:{id:'PRIVATE-TURN'}})
 item(projection,{id:'a',type:'agentMessage',text:'Already seen'})
 projection.notification('turn/completed',{threadId:'PRIVATE-THREAD',turn:{id:'PRIVATE-TURN',status:'completed',items:[{id:'a',type:'agentMessage',text:'Already seen'},{id:'b',type:'agentMessage',text:'Completion only'}]}})
 assert.deepEqual(events.map(event=>event.text),['Already seen','Completion only'])
})

test('public activity waits for turn response identity and mismatched responses never release it',()=>{
 for(const responseId of ['PRIVATE-TURN','wrong']){
  const events:ExecutorActivity[]=[]
  const projection=new AppServerTurnProjection({clock:new VirtualClock(),onActivity:event=>events.push(event)})
  projection.bindThread(ephemeralThread(),{workspace:'/workspace'})
  projection.notification('turn/started',{threadId:'PRIVATE-THREAD',turn:{id:'PRIVATE-TURN'}})
  item(projection,{id:'early',type:'agentMessage',text:'Not yet confirmed'})
  assert.equal(events.length,0)
  if(responseId==='wrong'){assert.throws(()=>projection.bindTurnResponse({turn:{id:responseId}}),/turn_identity_mismatch/);assert.equal(events.length,0)}
  else{projection.bindTurnResponse({turn:{id:responseId}});assert.equal(events.length,1);projection.bindTurnResponse({turn:{id:responseId}});assert.equal(events.length,1)}
 }
})

test('public check observations preserve command output and managed MCP readback without reasoning or image payloads',()=>{
 const events:ExecutorActivity[]=[],projection=new AppServerTurnProjection({clock:new VirtualClock(),onActivity:event=>events.push(event),sanitizePublicText:text=>({text:text.replaceAll('SECRET','[REDACTED]'),truncated:false})})
 projection.bindThread(ephemeralThread(),{workspace:'/workspace'});projection.notification('turn/started',{threadId:'PRIVATE-THREAD',turn:{id:'PRIVATE-TURN'}});projection.bindTurnResponse({turn:{id:'PRIVATE-TURN'}})
 item(projection,{id:'cmd',type:'commandExecution',command:'npm test',aggregatedOutput:'2 passed SECRET',exitCode:0,status:'completed',reasoning:'PRIVATE_REASONING'})
 item(projection,{id:'readback',type:'mcpToolCall',server:'nova_computer',tool:'browser_snapshot',status:'completed',result:{content:[{type:'text',text:'button is blue'},{type:'image',data:'PRIVATE_IMAGE',mimeType:'image/png'}]},arguments:{secret:'SECRET'}})
 const observed=JSON.stringify(events);assert.match(observed,/npm test/u);assert.match(observed,/2 passed/u);assert.match(observed,/exit_code/u);assert.match(observed,/button is blue/u);assert.doesNotMatch(observed,/PRIVATE_REASONING|PRIVATE_IMAGE|SECRET/u)
})

test('truncated check observations advertise missing output and redact secrets before clipping',()=>{
 const events:ExecutorActivity[]=[],secret='SECRET-TOKEN',projection=new AppServerTurnProjection({clock:new VirtualClock(),onActivity:event=>events.push(event),sanitizePublicText:text=>({text:text.replaceAll(secret,'[REDACTED]'),truncated:false})})
 projection.bindThread(ephemeralThread(),{workspace:'/workspace'});projection.notification('turn/started',{threadId:'PRIVATE-THREAD',turn:{id:'PRIVATE-TURN'}});projection.bindTurnResponse({turn:{id:'PRIVATE-TURN'}})
 item(projection,{id:'cmd',type:'commandExecution',command:'npm test',aggregatedOutput:'x'.repeat(9996)+secret+'y'.repeat(10000),exitCode:0,status:'completed'})
 assert.equal(events[0]?.text_truncated,true);assert.ok(events[0].text.length<=16000);assert.doesNotMatch(events[0].text,/SECR/u)
})


test('public check observations redact unknown credentials in command output and MCP URLs',()=>{
 const events:ExecutorActivity[]=[],projection=new AppServerTurnProjection({clock:new VirtualClock(),onActivity:event=>events.push(event)})
 projection.bindThread(ephemeralThread(),{workspace:'/workspace'});projection.notification('turn/started',{threadId:'PRIVATE-THREAD',turn:{id:'PRIVATE-TURN'}});projection.bindTurnResponse({turn:{id:'PRIVATE-TURN'}})
 item(projection,{id:'cmd',type:'commandExecution',command:'node --test',aggregatedOutput:'1 passed; password=unknown-password-value',exitCode:0,status:'completed'})
 item(projection,{id:'mcp',type:'mcpToolCall',server:'cua_live',tool:'js',status:'completed',result:{isError:false,content:[{type:'text',text:'Counter value: 1; https://example.invalid/?token=unknown-query-value'}]}})
 assert.match(events[0]!.text,/1 passed/);assert.match(events[1]!.text,/Counter value: 1/)
 assert.doesNotMatch(JSON.stringify(events),/unknown-password-value|unknown-query-value/)
})
