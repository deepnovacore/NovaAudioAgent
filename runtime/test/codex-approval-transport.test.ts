import assert from 'node:assert/strict'
import {mkdtempSync, realpathSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {test, type TestContext} from 'node:test'

import {VirtualClock} from '../src/clock.js'
import {
  CodexApprovalController,
  routeCodexApprovalServerRequest,
} from '../src/realtime/codex-approval.js'

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

  const mutations: ((params: Record<string, unknown>) => void)[] = [
    params => { params.command = null },
    params => { params.command = 'x'.repeat(4097) },
    params => { params.cwd = resolve(workspace, '..') },
    params => { params.cwd = resolve(workspace, 'subdirectory') },
    params => { params.threadId = 'thread-stale' },
    params => { params.networkApprovalContext = {host: 'private.example'} },
    params => { params.additionalPermissions = {filesystem: 'write'} },
    params => { params.proposedExecpolicyAmendment = [] },
    params => { params.proposedNetworkPolicyAmendments = [] },
    params => { params.environmentId = 'additional-environment' },
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
  assert.deepEqual(await concurrent, {result: {decision: 'decline'}})
  signal.abort()
  assert.deepEqual(await first, {result: {decision: 'decline'}})
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
