import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {test, type TestContext} from 'node:test'

import {VirtualClock} from '../src/clock.js'
import {
  CodexApprovalController,
  routeCodexApprovalServerRequest,
} from '../src/executors/codex/approval.js'
import {MAX_CONCURRENT_WORK} from '../src/work-tools.js'

function fixture(t: TestContext) {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'nova-codex-approval-route-')))
  t.after(() => { rmSync(workspace, {recursive: true, force: true}) })
  let nextId = 0
  const controller = new CodexApprovalController({
    clock: new VirtualClock(100),
    idFactory: () => `public-${++nextId}`,
  })
  const fileItem = {
    id: 'item-file',
    type: 'fileChange',
    status: 'inProgress',
    changes: [{
      path: resolve(workspace, 'src', 'a.ts'),
      diff: '@@ -0,0 +1 @@\n+safe\n',
      kind: {type: 'update', move_path: resolve(workspace, 'src', 'b.ts')},
    }],
  }
  const base = {
    controller,
    workspace,
    activePair: ['thread-active', 'turn-active'] as const,
    fileChangeItem: (itemId: string) => itemId === fileItem.id ? fileItem : null,
  }
  return {workspace, controller, fileItem, base}
}

const fileParams = {
  itemId: 'item-file',
  startedAtMs: 1000,
  threadId: 'thread-active',
  turnId: 'turn-active',
  grantRoot: null,
  reason: null,
}

function commandParams(workspace: string): Record<string, unknown> {
  return {
    approvalId: null,
    command: 'npm test --workspace runtime',
    commandActions: null,
    cwd: workspace,
    environmentId: null,
    itemId: 'item-command',
    kind: 'command',
    networkApprovalContext: null,
    proposedExecpolicyAmendment: null,
    proposedNetworkPolicyAmendments: null,
    reason: null,
    startedAtMs: 1000,
    threadId: 'thread-active',
    turnId: 'turn-active',
  }
}

test('correlated file approval projects only canonical workspace display facts', async t => {
  const {base, controller, workspace} = fixture(t)
  const routed = routeCodexApprovalServerRequest({
    ...base,
    method: 'item/fileChange/requestApproval',
    params: {...fileParams, grantRoot: workspace},
    signal: new AbortController().signal,
  })
  assert.notEqual(routed, undefined)
  assert.deepEqual(controller.view.local_detail, {
    kind: 'file_change',
    changes: [{change: 'update', path: join('src', 'a.ts'), move_path: join('src', 'b.ts')}],
  })
  assert.equal(JSON.stringify(controller.view).includes('@@'), false)
  assert.equal(controller.acceptDecision({approvalId: 'public-1', decision: 'accept'}), true)
  assert.deepEqual(await routed, {result: {decision: 'accept'}})
})

test('file approval request time is valid independently from its preceding item lifecycle', async t => {
  const {base, controller} = fixture(t)
  const routed = routeCodexApprovalServerRequest({
    ...base,
    method: 'item/fileChange/requestApproval',
    params: {...fileParams, startedAtMs: 1001},
    signal: new AbortController().signal,
  })
  assert.notEqual(routed, undefined)
  assert.equal(controller.pending, true)
  assert.equal(controller.acceptDecision({approvalId: 'public-1', decision: 'accept'}), true)
  assert.deepEqual(await routed, {result: {decision: 'accept'}})
})

test('malformed, mismatched, missing, escaped, oversized, and widened file requests decline silently', async t => {
  const {base, controller, fileItem, workspace} = fixture(t)
  const outside = resolve(workspace, '..', 'outside.ts')
  const mutations: ((input: {params: Record<string, unknown>; item: Record<string, unknown> | null}) => void)[] = [
    input => { delete input.params.itemId },
    input => { input.params.threadId = 'thread-stale' },
    input => { input.item = null },
    input => { input.item!.changes = [{path: outside, diff: 'x', kind: {type: 'add'}}] },
    input => { input.item!.changes = [{
      path: resolve(workspace, 'a.ts'), diff: 'x', kind: {type: 'update', move_path: outside},
    }] },
    input => { input.item!.changes = Array.from({length: 65}, (_, index) => ({
      path: resolve(workspace, `${index}.ts`), diff: 'x', kind: {type: 'add'},
    })) },
    input => { input.item!.changes = [{path: resolve(workspace, 'a.ts'), kind: {type: 'add'}}] },
    input => { input.params.grantRoot = resolve(workspace, '..') },
    input => { input.params.extraAuthority = true },
  ]
  for (const mutate of mutations) {
    const input = {params: structuredClone(fileParams), item: structuredClone(fileItem) as Record<string, unknown> | null}
    mutate(input)
    const routed = routeCodexApprovalServerRequest({
      ...base,
      fileChangeItem: () => input.item,
      method: 'item/fileChange/requestApproval',
      params: input.params,
      signal: new AbortController().signal,
    })
    assert.notEqual(routed, undefined)
    assert.deepEqual(await routed, {result: {decision: 'decline'}})
    assert.equal(controller.pending, false)
  }
})

test('Windows external and dangling junction paths decline fail-closed', {
  skip: process.platform === 'win32' ? false : 'Windows junction semantics only',
}, async t => {
  const {base, controller, fileItem, workspace} = fixture(t)
  const outside = mkdtempSync(join(tmpdir(), 'nova-codex-approval-outside-'))
  t.after(() => { rmSync(outside, {recursive: true, force: true}) })

  for (const [name, target] of [
    ['external-junction', outside],
    ['dangling-junction', resolve(outside, 'missing-target')],
  ] as const) {
    const junction = resolve(workspace, name)
    try {
      symlinkSync(target, junction, 'junction')
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown'
      t.skip(`junction creation unsupported: ${code}`)
      return
    }
    try {
      const item = structuredClone(fileItem) as Record<string, unknown>
      item.changes = [{path: resolve(junction, 'new.txt'), diff: 'x', kind: {type: 'add'}}]
      const routed = routeCodexApprovalServerRequest({
        ...base,
        fileChangeItem: () => item,
        method: 'item/fileChange/requestApproval',
        params: fileParams,
        signal: new AbortController().signal,
      })
      assert.notEqual(routed, undefined)
      const unexpectedlyPending = controller.pending
      if (unexpectedlyPending) controller.invalidate('test_cleanup')
      assert.equal(unexpectedlyPending, false, `${name} must not be offered`)
      assert.deepEqual(await routed, {result: {decision: 'decline'}})
    } finally {
      unlinkSync(junction)
    }
  }
})

test('nonexistent file and move leaves beneath ordinary directories remain approvable', async t => {
  const {base, controller, fileItem, workspace} = fixture(t)
  const sourceDirectory = resolve(workspace, 'ordinary-source')
  const targetDirectory = resolve(workspace, 'ordinary-target')
  mkdirSync(sourceDirectory)
  mkdirSync(targetDirectory)
  const item = structuredClone(fileItem)
  item.changes = [{
    path: resolve(sourceDirectory, 'new.txt'),
    diff: 'x',
    kind: {type: 'update', move_path: resolve(targetDirectory, 'moved.txt')},
  }]
  const routed = routeCodexApprovalServerRequest({
    ...base,
    fileChangeItem: () => item,
    method: 'item/fileChange/requestApproval',
    params: fileParams,
    signal: new AbortController().signal,
  })
  assert.notEqual(routed, undefined)
  assert.equal(controller.pending, true)
  assert.equal(controller.acceptDecision({approvalId: 'public-1', decision: 'accept'}), true)
  assert.deepEqual(await routed, {result: {decision: 'accept'}})
})

test('commands require one bounded complete command at the exact canonical workspace cwd', async t => {
  const {base, controller, workspace} = fixture(t)
  const valid = commandParams(workspace)
  const routed = routeCodexApprovalServerRequest({
    ...base,
    method: 'item/commandExecution/requestApproval',
    params: valid,
    signal: new AbortController().signal,
  })
  assert.notEqual(routed, undefined)
  assert.deepEqual(controller.view.local_detail, {
    kind: 'command_execution', command: valid.command, cwd: workspace,
  })
  assert.equal(controller.acceptDecision({approvalId: 'public-1', decision: 'decline'}), true)
  assert.deepEqual(await routed, {result: {decision: 'decline'}})

  const legacy = commandParams(workspace)
  delete legacy.kind
  const legacyRouted = routeCodexApprovalServerRequest({
    ...base,
    method: 'item/commandExecution/requestApproval',
    params: legacy,
    signal: new AbortController().signal,
  })
  assert.notEqual(legacyRouted, undefined)
  assert.equal(controller.acceptDecision({approvalId: 'public-2', decision: 'decline'}), true)
  assert.deepEqual(await legacyRouted, {result: {decision: 'decline'}})

  const mutations: ((params: Record<string, unknown>) => void)[] = [
    params => { params.command = null },
    params => { params.command = 'x'.repeat(4097) },
    params => { params.cwd = resolve(workspace, '..') },
    params => { params.cwd = resolve(workspace, 'subdirectory') },
    params => { params.threadId = 'thread-stale' },
    params => { params.networkApprovalContext = {host: 'private.example'} },
    params => { params.additionalPermissions = {filesystem: 'write'} },
    params => { params.proposedExecpolicyAmendment = [1] },
    params => { params.proposedNetworkPolicyAmendments = [{host: 'example.com'}] },
    params => { params.environmentId = 'additional-environment' },
    params => { params.kind = 'writeStdin' },
    params => { params.kind = 'futureAuthority' },
  ]
  for (const mutate of mutations) {
    const params = commandParams(workspace)
    mutate(params)
    const declined = routeCodexApprovalServerRequest({
      ...base,
      method: 'item/commandExecution/requestApproval',
      params,
      signal: new AbortController().signal,
    })
    assert.notEqual(declined, undefined)
    assert.deepEqual(await declined, {result: {decision: 'decline'}})
    assert.equal(controller.pending, false)
  }
})

test('approval command and file displays redact common credential forms', async t => {
  const {base, controller, fileItem, workspace} = fixture(t)
  const command = [
    'env AWS_SECRET_ACCESS_KEY=aws-secret-marker AWS_ACCESS_KEY_ID=aws-id-secret-marker',
    '--api-key="cli-secret-marker"',
    "--password 'quoted-secret-marker'",
    '-H "Authorization: Basic basic-secret-marker"',
    'https://alice:url-secret-marker@example.test/?token=url-token-marker',
  ].join(' ')
  const commandRequest = routeCodexApprovalServerRequest({
    ...base,
    method: 'item/commandExecution/requestApproval',
    params: {
      ...commandParams(workspace), command, availableDecisions: ['accept', 'decline'], additionalPermissions: null,
    },
    signal: new AbortController().signal,
  })
  assert.notEqual(commandRequest, undefined)
  const commandDisplay = JSON.stringify(controller.view.local_detail)
  for (const marker of [
    'aws-secret-marker', 'aws-id-secret-marker', 'cli-secret-marker', 'quoted-secret-marker', 'basic-secret-marker', 'url-secret-marker', 'url-token-marker',
  ]) assert.equal(commandDisplay.includes(marker), false, marker)
  assert.match(commandDisplay, /AWS_SECRET_ACCESS_KEY=\[REDACTED\]/u)
  assert.match(commandDisplay, /Authorization: Basic \[REDACTED\]/u)
  assert.match(commandDisplay, /alice:\[REDACTED\]@example\.test/u)
  assert.equal(controller.acceptDecision({approvalId: 'public-1', decision: 'decline'}), true)
  assert.deepEqual(await commandRequest, {result: {decision: 'decline'}})

  const item = structuredClone(fileItem) as Record<string, unknown>
  item.changes = [{
    path: 'src/token=relative-file-path-secret.txt',
    diff: 'x',
    kind: {type: 'update', move_path: 'src/password=move-path-secret-secret.txt'},
  }]
  const fileRequest = routeCodexApprovalServerRequest({
    ...base,
    fileChangeItem: () => item,
    method: 'item/fileChange/requestApproval',
    params: fileParams,
    signal: new AbortController().signal,
  })
  assert.notEqual(fileRequest, undefined)
  const fileDisplay = JSON.stringify(controller.view.local_detail).replaceAll('\\\\', '/')
  assert.equal(fileDisplay.includes('relative-file-path-secret'), false)
  assert.equal(fileDisplay.includes('move-path-secret-secret'), false)
  assert.match(fileDisplay, /src\/token=\[REDACTED\]/u)
  assert.match(fileDisplay, /src\/password=\[REDACTED\]/u)
  assert.equal(controller.acceptDecision({approvalId: 'public-2', decision: 'decline'}), true)
  assert.deepEqual(await fileRequest, {result: {decision: 'decline'}})
})

test('permission summaries identify broad scopes and keep the exact grant snapshot', async t => {
  const {base, controller, workspace} = fixture(t)
  const requested = {
    fileSystem: {
      entries: [
        {access: 'write', path: {type: 'special', value: {kind: 'root'}}},
        {access: 'read', path: {type: 'special', value: {kind: 'project_roots', subpath: 'token=project-secret-marker'}}},
        {access: 'read', path: {type: 'special', value: {kind: 'tmpdir'}}},
        {access: 'deny', path: {type: 'glob_pattern', pattern: resolve(workspace, 'src', '**', '*.env') }},
        {access: 'deny', path: {type: 'glob_pattern', pattern: resolve(workspace, '..', 'external', '**', '*.env') }},
        {access: 'write', path: {type: 'path', path: resolve(workspace, 'password=workspace-secret-marker.txt')}},
        {access: 'read', path: {type: 'path', path: resolve(workspace, '..', 'external-secret-marker.txt')}},
      ],
    },
    network: {enabled: true},
  }
  const request = routeCodexApprovalServerRequest({
    ...base,
    method: 'item/permissions/requestApproval',
    params: {
      itemId: 'item-permissions', startedAtMs: 1000, threadId: 'thread-active', turnId: 'turn-active',
      cwd: workspace, permissions: requested,
    },
    signal: new AbortController().signal,
  })
  assert.notEqual(request, undefined)
  const display = JSON.stringify(controller.view.local_detail).replaceAll('\\\\', '/')
  assert.match(display, /全文件系统（根目录）/u)
  assert.match(display, /项目根目录\/token=\[REDACTED\]/u)
  assert.match(display, /临时目录/u)
  assert.match(display, /glob：src\/\*\*\/\*\.env/u)
  assert.match(display, /glob：工作区外（路径已脱敏）/u)
  assert.match(display, /工作区外（路径已脱敏）/u)
  for (const marker of ['project-secret-marker', 'glob-secret-marker', 'workspace-secret-marker', 'external-secret-marker']) {
    assert.equal(display.includes(marker), false, marker)
  }
  assert.equal(controller.acceptDecision({approvalId: 'public-1', decision: 'acceptForSession'}), true)
  assert.deepEqual(await request, {result: {permissions: requested, scope: 'session'}})
})

test('network and permission approvals return exact turn/session grants with no persistent rule', async t => {
  const {base, controller, workspace} = fixture(t)
  const permissions = {network: {enabled: true}, fileSystem: {write: [resolve(workspace, '..', 'private')]}}
  for (const kind of ['file_change', 'command_execution', 'network', 'permissions']) {
    for (const decision of ['accept', 'acceptForSession', 'decline'] as const) {
      const params = kind === 'file_change' ? fileParams : kind === 'permissions'
        ? {...fileParams, grantRoot: undefined, cwd: workspace, permissions}
        : {...commandParams(workspace), availableDecisions: ['accept', 'acceptForSession', 'decline'],
            proposedExecpolicyAmendment: ['npm'], ...(kind === 'network' ? {
              networkApprovalContext: {host: 'registry.npmjs.org', protocol: 'https'},
              proposedNetworkPolicyAmendments: [{host: 'registry.npmjs.org', action: 'allow'}],
            } : {})}
      if (kind === 'permissions') delete (params as Record<string, unknown>).grantRoot
      const routed = routeCodexApprovalServerRequest({
        ...base, method: kind === 'file_change' ? 'item/fileChange/requestApproval'
          : kind === 'permissions' ? 'item/permissions/requestApproval' : 'item/commandExecution/requestApproval',
        params, signal: new AbortController().signal,
      })
      assert.equal(controller.pending, true, kind)
      assert.equal(controller.view.kind, kind)
      if (kind === 'permissions') {
        assert.match(JSON.stringify(controller.view.local_detail), /工作区外/u)
        assert.equal(JSON.stringify(controller.view.local_detail).includes(workspace), false)
      }
      assert.equal(controller.acceptDecision({approvalId: controller.view.pending_approval_id!, decision}), true)
      assert.deepEqual(await routed, {result: kind === 'permissions'
        ? {permissions: decision === 'decline' ? {} : permissions, scope: decision === 'acceptForSession' ? 'session' : 'turn'}
        : {decision}})
    }
  }
})

test('available decisions constrain session approval and permission expiry grants nothing', async t => {
  const {base, controller, workspace} = fixture(t)
  const waiting = routeCodexApprovalServerRequest({
    ...base, method: 'item/commandExecution/requestApproval',
    params: {...commandParams(workspace), availableDecisions: ['accept', 'decline']},
    signal: new AbortController().signal,
  })
  assert.equal(controller.acceptDecision({approvalId: 'public-1', decision: 'acceptForSession'}), false)
  controller.invalidate('lost')
  await waiting
  for (const end of ['ttl', 'lost']) {
    const clock = new VirtualClock()
    const approval = new CodexApprovalController({clock, idFactory: () => 'permissions'})
    const signal = new AbortController()
    const result = routeCodexApprovalServerRequest({
      ...base, controller: approval, method: 'item/permissions/requestApproval',
      params: {itemId: 'p', startedAtMs: 1, threadId: 'thread-active', turnId: 'turn-active',
        cwd: workspace, permissions: {network: {enabled: true}}}, signal: signal.signal,
    })
    assert.equal(approval.pending, true)
    if (end === 'ttl') clock.advanceTo(60)
    else signal.abort()
    assert.deepEqual(await result, {result: {permissions: {}, scope: 'turn'}})
  }
})

test('concurrent, terminal-turn, transport-loss, and unknown requests preserve fail-closed ownership', async t => {
  const {base, controller, workspace} = fixture(t)
  const signal = new AbortController()
  const first = routeCodexApprovalServerRequest({
    ...base,
    method: 'item/commandExecution/requestApproval',
    params: commandParams(workspace),
    signal: signal.signal,
  })
  assert.notEqual(first, undefined)
  const concurrent = routeCodexApprovalServerRequest({
    ...base,
    method: 'item/commandExecution/requestApproval',
    params: {...commandParams(workspace), itemId: 'item-concurrent'},
    signal: new AbortController().signal,
  })
  assert.notEqual(concurrent, undefined)
  assert.equal(controller.view.queued, 1, 'a concurrent request queues behind the head (spec 08 FIFO)')
  signal.abort()
  assert.deepEqual(await first, {result: {decision: 'decline'}})
  assert.equal(controller.pending, true, 'the queued request is promoted once the head settles')
  assert.equal(controller.view.queued, 0)
  controller.invalidate('lost')
  assert.deepEqual(await concurrent, {result: {decision: 'decline'}})
  assert.equal(controller.pending, false)

  const terminal = routeCodexApprovalServerRequest({
    ...base,
    activePair: null,
    method: 'item/commandExecution/requestApproval',
    params: commandParams(workspace),
    signal: new AbortController().signal,
  })
  assert.notEqual(terminal, undefined)
  assert.deepEqual(await terminal, {result: {decision: 'decline'}})
  assert.equal(routeCodexApprovalServerRequest({
    ...base,
    method: 'account/private',
    params: {},
    signal: new AbortController().signal,
  }), undefined)
})

test('approval FIFO: the head is the only voice-visible entry, queued TTLs start at promotion, work scoping', async () => {
  const clock = new VirtualClock(100)
  let nextId = 0
  const controller = new CodexApprovalController({clock, idFactory: () => `public-${++nextId}`})
  const offer = (command: string) => ({
    kind: 'command_execution' as const,
    local_detail: {kind: 'command_execution' as const, command, cwd: '/w'},
    operation_summary: `Codex 请求执行 ${command}`,
  })
  const alpha = controller.forWork({work_id: 'work-a', project: 'alpha', title: '修复登录'})
  const beta = controller.forWork({work_id: 'work-b', project: 'beta', title: '写文档'})
  const gamma = controller.forWork({work_id: 'work-g', project: 'gamma', title: '加测试'})
  const views: {readonly id: string | undefined; readonly queued: number}[] = []
  controller.observe(view => { views.push({id: view.pending_approval_id, queued: view.queued}) })

  const first = alpha.offer(offer('a1'), new AbortController().signal)
  const second = beta.offer(offer('b1'), new AbortController().signal)
  const third = gamma.offer(offer('g1'), new AbortController().signal)
  assert.equal(controller.view.pending_approval_id, 'public-1')
  assert.deepEqual(controller.view.work, {work_id: 'work-a', project: 'alpha', title: '修复登录'})
  assert.equal(controller.view.queued, 2)
  assert.equal(controller.view.expires_at, 100 + 60)

  // Bounds (P2-5): one pending entry per work, and MAX_CONCURRENT_WORK entries in all. Either excess offer
  // is declined at once without touching the FIFO or publishing a view.
  assert.equal(MAX_CONCURRENT_WORK, 3)
  const published = views.length
  assert.deepEqual(await alpha.offer(offer('a2'), new AbortController().signal), {decision: 'decline'}, 'a second request from a blocked work')
  const delta = controller.forWork({work_id: 'work-d', project: 'delta', title: '重构'})
  assert.deepEqual(await delta.offer(offer('d1'), new AbortController().signal), {decision: 'decline'}, 'over the cap')
  assert.equal(views.length, published)
  assert.equal(controller.view.queued, 2)
  assert.equal(nextId, 3, 'declined offers consume no public id')

  // Decisions bind to the head id only; queued ids are not voice-visible.
  assert.equal(controller.acceptDecision({approvalId: 'public-2', decision: 'accept'}), false)
  assert.equal(controller.acceptDecision({approvalId: 'public-3', decision: 'accept'}), false)

  // Invalidating beta's work drops its queued entry and leaves the head untouched.
  clock.advanceTo(130)
  assert.equal(beta.invalidate('turn_completed'), true)
  assert.deepEqual(await second, {decision: 'decline'})
  assert.equal(controller.view.pending_approval_id, 'public-1')
  assert.equal(controller.view.queued, 1)
  assert.equal(beta.invalidate('again'), false, 'nothing of beta remains')

  // Accept the head; the next entry becomes head with a full TTL measured from now, not from its offer.
  assert.equal(controller.acceptDecision({approvalId: 'public-1', decision: 'accept'}), true)
  const resolution = await first
  assert.equal(alpha.consume(resolution!), 'accept')
  assert.equal(controller.view.pending_approval_id, 'public-3')
  assert.equal(controller.view.queued, 0)
  assert.equal(controller.view.expires_at, 130 + 60)
  assert.equal(controller.pending, true)
  clock.advanceTo(189)
  assert.equal(controller.pending, true, 'the promoted entry did not age while queued')

  // A work-scoped invalidation of the head promotes nothing further and declines it.
  assert.equal(gamma.invalidate('closed'), true)
  assert.deepEqual(await third, {decision: 'decline'})
  assert.equal(controller.view.pending_approval, false)
  assert.equal(controller.view.queued, 0)
  assert.deepEqual(views.map(view => view.id), [
    'public-1', 'public-1', 'public-1', 'public-1', 'public-1', 'public-3', undefined,
  ])
  assert.deepEqual(views.map(view => view.queued), [0, 1, 2, 1, 1, 0, 0])
})
