import assert from 'node:assert/strict'
import {Buffer} from 'node:buffer'
import {test} from 'node:test'

import {
  MAX_WORKSPACE_GRAPH_BOARD_BYTES,
  workspaceGraphBoardMessage,
} from '../src/realtime/workspace-graph-board.js'
import type {PublishedGraphSnapshot} from '../src/workspace-graph/store.js'

function snapshot(
  overrides: Partial<PublishedGraphSnapshot> = {},
): PublishedGraphSnapshot {
  return {
    schema_version: 3,
    publication_revision: 9,
    degraded: false,
    logical_workspaces: [{
      logical_workspace_id: 'logical-a',
      display_name: 'Nova',
      aliases: ['private-alias'],
      canonical_remote: 'ssh://secret.example/nova.git',
      created_at: 1,
      updated_at: 20,
      revision: 1,
    }, {
      logical_workspace_id: 'logical-b',
      display_name: 'Runtime',
      aliases: ['hidden-runtime-name'],
      canonical_remote: null,
      created_at: 2,
      updated_at: 19,
      revision: 1,
    }],
    workspace_instances: [{
      instance_id: 'instance-a',
      logical_workspace_id: 'logical-a',
      display_name: 'Nova active',
      path_label: '/Users/private/.env',
      branch: 'secret-release',
      repository_fingerprint: 'credential-fingerprint',
      status: 'active',
      first_seen_at: 3,
      last_seen_at: 30,
      revision: 1,
    }],
    relations: [{
      source_logical_id: 'logical-a',
      target_logical_id: 'logical-b',
      relation_type: 'depends_on',
      confidence: 0.8,
      reason: 'inspect /Users/private/.env and token=top-secret',
      evidence_refs: [{
        source: 'filesystem',
        ref: 'raw evidence body with top-secret',
        observed_at: 11,
      }, {
        source: 'executor',
        ref: 'task summary secret text',
        observed_at: 12,
      }],
      first_seen_at: 10,
      last_seen_at: 24,
      status: 'active',
      revision: 2,
    }],
    aliases: [{alias: 'snapshot-secret-alias', logical_workspace_id: 'logical-a'}],
    ...overrides,
  }
}

test('disabled and unavailable graph boards have fixed empty envelopes', () => {
  assert.equal(workspaceGraphBoardMessage('graph-1', null, 'disabled'),
    '{"type":"workspace_graph.board","request_id":"graph-1","availability":"disabled","publication_revision":0,"omitted":{"logical_workspaces":0,"workspace_instances":0,"relations":0},"logical_workspaces":[],"workspace_instances":[],"relations":[]}')
  assert.equal(workspaceGraphBoardMessage('graph-2', null, 'degraded'),
    '{"type":"workspace_graph.board","request_id":"graph-2","availability":"degraded","publication_revision":0,"omitted":{"logical_workspaces":0,"workspace_instances":0,"relations":0},"logical_workspaces":[],"workspace_instances":[],"relations":[]}')
})

test('ready graph board exposes only the approved projection and evidence count', () => {
  const message = workspaceGraphBoardMessage('graph-ready', snapshot(), 'ready')
  const payload = JSON.parse(message) as Record<string, unknown>
  assert.deepEqual(payload, {
    type: 'workspace_graph.board',
    request_id: 'graph-ready',
    availability: 'ready',
    publication_revision: 9,
    omitted: {logical_workspaces: 0, workspace_instances: 0, relations: 0},
    logical_workspaces: [
      {logical_workspace_id: 'logical-a', display_name: 'Nova'},
      {logical_workspace_id: 'logical-b', display_name: 'Runtime'},
    ],
    workspace_instances: [{
      instance_id: 'instance-a',
      logical_workspace_id: 'logical-a',
      display_name: 'Nova active',
      active: true,
      last_seen_at: 30,
    }],
    relations: [{
      source_logical_id: 'logical-a',
      target_logical_id: 'logical-b',
      relation_type: 'depends_on',
      confidence: 0.8,
      status: 'active',
      last_seen_at: 24,
      evidence_count: 2,
    }],
  })
  for (const denied of [
    '/Users/private', '.env', 'ssh://', 'secret-release', 'credential-fingerprint',
    'private-alias', 'snapshot-secret-alias', 'inspect ', 'raw evidence', 'task summary',
    'top-secret', 'evidence_refs', 'reason', 'path_label', 'canonical_remote',
  ]) assert.doesNotMatch(message, new RegExp(denied.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'))
})

test('degraded last-good snapshot stays visible with a degraded availability marker', () => {
  const payload = JSON.parse(workspaceGraphBoardMessage(
    'graph-degraded',
    snapshot({degraded: true}),
    'ready',
  )) as {availability: string; publication_revision: number; logical_workspaces: unknown[]}
  assert.equal(payload.availability, 'degraded')
  assert.equal(payload.publication_revision, 9)
  assert.equal(payload.logical_workspaces.length, 2)
})

test('board validates the exact bounded request id', () => {
  for (const requestId of ['', '   ', 'x'.repeat(257), '\ud800']) {
    assert.throws(
      () => workspaceGraphBoardMessage(requestId, null, 'disabled'),
      /workspace graph board request is invalid/u,
    )
  }
  assert.doesNotThrow(() => workspaceGraphBoardMessage('请求-🚀', null, 'disabled'))
})

test('ordering is deterministic by code point with active and recent items first', () => {
  const graph = snapshot({
    logical_workspaces: [
      {...snapshot().logical_workspaces[0]!, logical_workspace_id: '\u{10000}', display_name: 'astral'},
      {...snapshot().logical_workspaces[1]!, logical_workspace_id: '\ue000', display_name: 'bmp'},
      {...snapshot().logical_workspaces[1]!, logical_workspace_id: 'active', display_name: 'active'},
    ],
    workspace_instances: [
      {...snapshot().workspace_instances[0]!, instance_id: 'inactive-new', logical_workspace_id: '\ue000', status: 'inactive', last_seen_at: 99},
      {...snapshot().workspace_instances[0]!, instance_id: 'active-old', logical_workspace_id: 'active', status: 'active', last_seen_at: 2},
      {...snapshot().workspace_instances[0]!, instance_id: 'inactive-astral', logical_workspace_id: '\u{10000}', status: 'inactive', last_seen_at: 99},
    ],
    relations: [],
  })
  const first = workspaceGraphBoardMessage('stable', graph, 'ready')
  const second = workspaceGraphBoardMessage('stable', graph, 'ready')
  assert.equal(first, second)
  const payload = JSON.parse(first) as {
    logical_workspaces: {logical_workspace_id: string}[]
    workspace_instances: {instance_id: string; active: boolean}[]
  }
  assert.deepEqual(payload.workspace_instances.map(item => [item.instance_id, item.active]), [
    ['active-old', true],
    ['inactive-astral', false],
    ['inactive-new', false],
  ])
  assert.deepEqual(payload.logical_workspaces.map(item => item.logical_workspace_id), [
    'active', '\ue000', '\u{10000}',
  ])
})

test('CJK and astral names stay whole while the UTF-8 budget drops whole items', () => {
  const logical = Array.from({length: 100}, (_, index) => ({
    ...snapshot().logical_workspaces[0]!,
    logical_workspace_id: `logical-${String(index).padStart(3, '0')}`,
    display_name: `${'图🚀'.repeat(90)}-${index}`,
    updated_at: 1_000 - index,
  }))
  const graph = snapshot({logical_workspaces: logical, workspace_instances: [], relations: []})
  const message = workspaceGraphBoardMessage('unicode-budget', graph, 'ready')
  assert.ok(Buffer.byteLength(message, 'utf8') <= MAX_WORKSPACE_GRAPH_BOARD_BYTES)
  const payload = JSON.parse(message) as {
    omitted: {logical_workspaces: number}
    logical_workspaces: {display_name: string}[]
  }
  assert.ok(payload.omitted.logical_workspaces > 0)
  for (const node of payload.logical_workspaces) {
    assert.match(node.display_name, /-\d+$/u, 'a display name is whole rather than clipped')
    assert.doesNotMatch(node.display_name, /\ud800$|\udc00$/u)
  }
})

test('every included relation keeps both logical endpoints under all bounds', () => {
  const logical = Array.from({length: 90}, (_, index) => ({
    ...snapshot().logical_workspaces[0]!,
    logical_workspace_id: `logical-${index}`,
    display_name: `Workspace ${index}`,
    updated_at: 90 - index,
  }))
  const relations = Array.from({length: 90}, (_, index) => ({
    ...snapshot().relations[0]!,
    source_logical_id: `logical-${index}`,
    target_logical_id: `logical-${(index + 1) % 90}`,
    confidence: 1 - index / 100,
  }))
  const payload = JSON.parse(workspaceGraphBoardMessage(
    'integrity', snapshot({logical_workspaces: logical, workspace_instances: [], relations}), 'ready',
  )) as {
    logical_workspaces: {logical_workspace_id: string}[]
    relations: {source_logical_id: string; target_logical_id: string}[]
    omitted: {relations: number}
  }
  const ids = new Set(payload.logical_workspaces.map(node => node.logical_workspace_id))
  assert.ok(payload.omitted.relations > 0)
  for (const relation of payload.relations) {
    assert.ok(ids.has(relation.source_logical_id))
    assert.ok(ids.has(relation.target_logical_id))
  }
})

test('hostile oversized inputs are prefix-bounded and fail closed without sensitive diagnostics', () => {
  let reads = 0
  const hostileLogical = new Proxy(Array.from({length: 10_000}, () => snapshot().logical_workspaces[0]!), {
    get(target, property, receiver) {
      reads += 1
      if (reads > 400) throw new Error('/private/secret should never be serialized')
      const value: unknown = Reflect.get(target, property, receiver)
      return value
    },
  })
  const bounded = workspaceGraphBoardMessage(
    'hostile-prefix',
    snapshot({logical_workspaces: hostileLogical}),
    'ready',
  )
  assert.ok(reads <= 400)
  assert.doesNotMatch(bounded, /private|secret/u)

  const throwing = new Proxy(snapshot(), {
    get(target, property, receiver) {
      if (property === 'logical_workspaces') throw new Error('token=raw-secret')
      const value: unknown = Reflect.get(target, property, receiver)
      return value
    },
  })
  assert.equal(workspaceGraphBoardMessage('hostile-throw', throwing, 'ready'),
    '{"type":"workspace_graph.board","request_id":"hostile-throw","availability":"degraded","publication_revision":0,"omitted":{"logical_workspaces":0,"workspace_instances":0,"relations":0},"logical_workspaces":[],"workspace_instances":[],"relations":[]}')
})

test('duplicate or dangling snapshot identities fail closed as a degraded empty board', () => {
  const duplicate = snapshot({
    logical_workspaces: [
      snapshot().logical_workspaces[0]!,
      {...snapshot().logical_workspaces[1]!, logical_workspace_id: 'logical-a'},
    ],
    workspace_instances: [],
    relations: [],
  })
  const dangling = snapshot({
    workspace_instances: [{
      ...snapshot().workspace_instances[0]!,
      logical_workspace_id: 'missing-logical',
    }],
    relations: [],
  })
  for (const [requestId, graph] of [['duplicate', duplicate], ['dangling', dangling]] as const) {
    const payload = JSON.parse(workspaceGraphBoardMessage(requestId, graph, 'ready')) as {
      availability: string
      publication_revision: number
      logical_workspaces: unknown[]
      workspace_instances: unknown[]
      relations: unknown[]
    }
    assert.equal(payload.availability, 'degraded')
    assert.equal(payload.publication_revision, 0)
    assert.deepEqual(payload.logical_workspaces, [])
    assert.deepEqual(payload.workspace_instances, [])
    assert.deepEqual(payload.relations, [])
  }
})
