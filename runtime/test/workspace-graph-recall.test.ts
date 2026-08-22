import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {test} from 'node:test'

import {PublishedGraphSnapshotSchema, type PublishedGraphSnapshot} from '../src/workspace-graph/store.js'
import {GraphRecall} from '../src/workspace-graph/recall.js'
import type {
  EvidenceRef,
  LogicalWorkspace,
  RelationCard,
  WorkspaceInstance,
} from '../src/workspace-graph/models.js'

const evidence = (
  ref: string,
  observedAt = 1,
  source: EvidenceRef['source'] = 'runtime',
): EvidenceRef => ({source, ref, observed_at: observedAt})

const workspace = (
  logicalWorkspaceId: string,
  displayName = logicalWorkspaceId,
  aliases: readonly string[] = [],
): LogicalWorkspace => ({
  logical_workspace_id: logicalWorkspaceId,
  display_name: displayName,
  aliases: [...aliases],
  canonical_remote: null,
  created_at: 1,
  updated_at: 2,
  revision: 1,
})

const instance = (
  instanceId: string,
  logicalWorkspaceId: string,
  status: WorkspaceInstance['status'] = 'active',
): WorkspaceInstance => ({
  instance_id: instanceId,
  logical_workspace_id: logicalWorkspaceId,
  display_name: `${logicalWorkspaceId} checkout`,
  path_label: `private-path-${logicalWorkspaceId}`,
  branch: 'main',
  repository_fingerprint: `private-fingerprint-${logicalWorkspaceId}`,
  status,
  first_seen_at: 1,
  last_seen_at: 2,
  revision: 1,
})

const relation = (options: {
  readonly source?: string
  readonly target?: string
  readonly type?: RelationCard['relation_type']
  readonly confidence?: number
  readonly reason?: string
  readonly status?: RelationCard['status']
  readonly lastSeen?: number
  readonly revision?: number
  readonly evidenceRefs?: readonly EvidenceRef[]
} = {}): RelationCard => ({
  source_logical_id: options.source ?? 'lw-a',
  target_logical_id: options.target ?? 'lw-b',
  relation_type: options.type ?? 'shares_runtime',
  confidence: options.confidence ?? 0.8,
  reason: options.reason ?? 'shared memory runtime',
  evidence_refs: [...(options.evidenceRefs ?? [evidence('event-1')])],
  first_seen_at: 1,
  last_seen_at: options.lastSeen ?? 2,
  status: options.status ?? 'active',
  revision: options.revision ?? 1,
})

function snapshot(options: {
  readonly degraded?: boolean
  readonly logicalWorkspaces?: readonly LogicalWorkspace[]
  readonly workspaceInstances?: readonly WorkspaceInstance[]
  readonly relations?: readonly RelationCard[]
  readonly aliases?: PublishedGraphSnapshot['aliases']
} = {}): PublishedGraphSnapshot {
  return deepFreeze(PublishedGraphSnapshotSchema.parse({
    schema_version: 2,
    publication_revision: 7,
    degraded: options.degraded ?? false,
    logical_workspaces: options.logicalWorkspaces ?? [
      workspace('lw-a', 'Current workspace'),
      workspace('lw-b', 'Memory Runtime'),
      workspace('lw-c', 'Graph Notes', ['记忆图谱']),
    ],
    workspace_instances: options.workspaceInstances ?? [instance('wi-a', 'lw-a')],
    relations: options.relations ?? [relation()],
    aliases: options.aliases ?? [{alias: '记忆图谱', logical_workspace_id: 'lw-c'}],
  }))
}

test('recall returns only intent-matched bidirectional neighbors of the active current workspace', () => {
  const recall = new GraphRecall(snapshot({
    logicalWorkspaces: [
      workspace('lw-a', 'Current workspace'),
      workspace('lw-b', 'Memory Runtime'),
      workspace('lw-c', 'Graph Notes', ['记忆图谱']),
      workspace('lw-self', 'Unused'),
    ],
    relations: [
      relation({target: 'lw-b', confidence: 0.9, reason: 'shared memory runtime'}),
      relation({source: 'lw-c', target: 'lw-a', confidence: 0.8, reason: 'related notes'}),
      relation({source: 'lw-a', target: 'lw-a', confidence: 1, reason: 'memory self edge'}),
      relation({target: 'lw-missing', confidence: 1, reason: 'memory missing card'}),
    ],
  }))

  const result = recall.suggest('wi-a', 'MEMORY 和记忆怎么设计？')

  assert.deepEqual(result.hints.map(item => item.logical_workspace_id), ['lw-b', 'lw-c'])
  assert.equal(result.omitted_hints, 0)
  assert.equal(result.degraded, false)
  assert.equal(result.hints.every(item => item.logical_workspace_id !== 'lw-a'), true)
})

test('recall has no graph-wide or recency fallback and never guesses a current instance', () => {
  const base = snapshot({
    workspaceInstances: [
      instance('wi-a', 'lw-a'),
      instance('wi-inactive', 'lw-a', 'inactive'),
    ],
  })
  const recall = new GraphRecall(base)

  assert.deepEqual(recall.suggest('wi-a', 'completely unrelated').hints, [])
  assert.deepEqual(recall.suggest('wi-missing', 'memory').hints, [])
  assert.deepEqual(recall.suggest('wi-inactive', 'memory').hints, [])

  const ambiguous = new GraphRecall(snapshot({
    workspaceInstances: [instance('wi-duplicate', 'lw-a'), instance('wi-duplicate', 'lw-a')],
  }))
  assert.deepEqual(ambiguous.suggest('wi-duplicate', 'memory').hints, [])
})

test('ranking uses overlap, confidence, active status, freshness, then code-point order', () => {
  const current = workspace('lw-a', 'Current')
  const pair = (relations: readonly RelationCard[], workspaces: readonly LogicalWorkspace[]) => (
    new GraphRecall(snapshot({logicalWorkspaces: [current, ...workspaces], relations}))
      .suggest('wi-a', 'memory runtime graph', 2)
      .hints.map(item => item.logical_workspace_id)
  )

  assert.deepEqual(pair([
    relation({target: 'lw-overlap', confidence: 0.1, reason: 'memory runtime graph'}),
    relation({target: 'lw-confidence', confidence: 1, reason: 'memory only'}),
  ], [workspace('lw-overlap'), workspace('lw-confidence')]), ['lw-overlap', 'lw-confidence'])

  assert.deepEqual(pair([
    relation({target: 'lw-confidence', confidence: 0.9, status: 'weak'}),
    relation({target: 'lw-active', confidence: 0.8, status: 'active'}),
  ], [workspace('lw-confidence'), workspace('lw-active')]), ['lw-confidence', 'lw-active'])

  assert.deepEqual(pair([
    relation({target: 'lw-active', confidence: 0.8, status: 'active', lastSeen: 1}),
    relation({target: 'lw-weak', confidence: 0.8, status: 'weak', lastSeen: 9}),
  ], [workspace('lw-active'), workspace('lw-weak')]), ['lw-active', 'lw-weak'])

  const bmp = `lw-${String.fromCodePoint(0xe000)}`
  const astral = `lw-${String.fromCodePoint(0x1_0000)}`
  assert.deepEqual(pair([
    relation({target: astral, confidence: 0.8, lastSeen: 9}),
    relation({target: bmp, confidence: 0.8, lastSeen: 9}),
  ], [workspace(astral), workspace(bmp)]), [bmp, astral])
})

test('recall caps unique whole hints, keeps one deterministic evidence ref, and reports omissions', () => {
  const sharedEvidence = [evidence('old', 1), evidence('newer-z', 9), evidence('newer-a', 9)]
  const firstRelation = relation({target: 'lw-b', evidenceRefs: sharedEvidence, revision: 4})
  const graph = snapshot({
    logicalWorkspaces: [
      workspace('lw-a'), workspace('lw-b'), workspace('lw-c'), workspace('lw-d'),
    ],
    relations: [
      firstRelation,
      {...firstRelation},
      relation({target: 'lw-c', confidence: 0.7}),
      relation({target: 'lw-d', confidence: 0.6}),
    ],
  })
  const recall = new GraphRecall(graph)
  const result = recall.suggest('wi-a', 'memory', 99)
  const repeated = new GraphRecall(graph).suggest('wi-a', 'memory', 99)

  assert.equal(result.hints.length, 2)
  assert.equal(result.omitted_hints, 1)
  assert.deepEqual(result.hints.map(item => item.hint_id), repeated.hints.map(item => item.hint_id))
  assert.deepEqual(result.hints[0]?.evidence_refs, [evidence('newer-a', 9)])
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.hints), true)
  assert.equal(Object.isFrozen(result.hints[0]), true)
  assert.equal(Object.isFrozen(result.hints[0]?.evidence_refs), true)
  assert.equal(Object.isFrozen(result.hints[0]?.evidence_refs[0]), true)
  assert.throws(() => {
    ;(result.hints as unknown[]).push({})
  }, TypeError)
})

test('recall owns a validated clone and is unaffected by later caller mutation', () => {
  const mutable = structuredClone(snapshot())
  const recall = new GraphRecall(mutable)
  ;(mutable.relations[0] as {reason: string}).reason = 'caller changed relation'
  ;(mutable.logical_workspaces[1] as {display_name: string}).display_name = 'caller changed card'

  const result = recall.suggest('wi-a', 'memory')
  assert.equal(result.hints.length, 1)
  assert.equal(result.hints[0]?.reason, 'shared memory runtime')
  assert.equal(result.hints[0]?.logical_workspace_id, 'lw-b')
})

test('missing snapshots are empty and degraded while degraded last-good snapshots stay usable', () => {
  assert.deepEqual(new GraphRecall(null).suggest('wi-a', 'memory'), {
    hints: [],
    omitted_hints: 0,
    degraded: true,
  })

  const result = new GraphRecall(snapshot({degraded: true})).suggest('wi-a', 'memory')
  assert.equal(result.hints.length, 1)
  assert.equal(result.degraded, true)
})

test('tokenization uses pinned NFKC/lower and CJK bigrams after bounding the utterance', () => {
  const graph = snapshot({
    logicalWorkspaces: [workspace('lw-a'), workspace('lw-b', 'Memory'), workspace('lw-c', '记忆图谱')],
    relations: [
      relation({target: 'lw-b', reason: 'unrelated'}),
      relation({target: 'lw-c', reason: 'unrelated'}),
    ],
  })
  const recall = new GraphRecall(graph)

  assert.deepEqual(recall.suggest('wi-a', 'ＭＥＭＯＲＹ').hints.map(item => item.logical_workspace_id), ['lw-b'])
  assert.deepEqual(recall.suggest('wi-a', '记忆').hints.map(item => item.logical_workspace_id), ['lw-c'])
  assert.deepEqual(recall.suggest('wi-a', `${'x'.repeat(512)}memory`).hints, [])
})

test('hostile snapshot accessors collapse to an empty degraded recall view', () => {
  const hostile = new Proxy({}, {
    get() {
      throw new Error('private-proxy-sentinel')
    },
  }) as PublishedGraphSnapshot

  assert.deepEqual(new GraphRecall(hostile).suggest('wi-a', 'memory'), {
    hints: [],
    omitted_hints: 0,
    degraded: true,
  })
})

test('schema-valid oversized snapshots build a bounded visibly degraded recall view', () => {
  const aliases = Array.from({length: 257}, (_unused, index) => ({
    alias: `confirmed-alias-${index}`,
    logical_workspace_id: 'lw-b',
  }))
  const graph = snapshot({aliases})

  assert.equal(PublishedGraphSnapshotSchema.safeParse(graph).success, true)
  let aliasIndexReads = 0
  const boundedAliases = new Proxy(structuredClone(graph.aliases), {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/u.test(property)) aliasIndexReads += 1
      return Reflect.get(target, property, receiver) as unknown
    },
  })
  let aliasesGetterReads = 0
  const hostileAfterCapture = structuredClone(graph)
  Object.defineProperty(hostileAfterCapture, 'aliases', {
    configurable: true,
    enumerable: true,
    get() {
      aliasesGetterReads += 1
      if (aliasesGetterReads > 1) throw new Error('alias-getter-read-twice')
      return boundedAliases
    },
  })

  const result = new GraphRecall(hostileAfterCapture).suggest('wi-a', 'memory')
  assert.equal(result.hints.length, 1)
  assert.equal(result.degraded, true)
  assert.equal(aliasesGetterReads, 1)
  assert.ok(aliasIndexReads <= 256)
})

test('alias work caps never create an unmarked no-match', () => {
  const aliases = Array.from({length: 17}, (_unused, index) => `alias-${index}`)
  aliases[16] = 'matching memory alias'
  const graph = snapshot({
    logicalWorkspaces: [
      workspace('lw-a'),
      workspace('lw-b', 'unrelated target', aliases),
    ],
    relations: [relation({target: 'lw-b', reason: 'unrelated relation'})],
    aliases: [],
  })

  const result = new GraphRecall(graph).suggest('wi-a', 'memory')
  assert.deepEqual(result.hints, [])
  assert.equal(result.degraded, true)
})

test('schema-valid unprojectable snapshot fields become bounded degraded recall data', () => {
  const unprojectableId = `${'i'.repeat(4_801)}\ud800`
  const graph = snapshot({
    logicalWorkspaces: [
      workspace('lw-a'),
      workspace('lw-b', 'Memory Runtime'),
      workspace(unprojectableId, 'Unused'),
    ],
    aliases: [{alias: 'a'.repeat(240), logical_workspace_id: 'lw-b'}],
  })
  assert.equal(PublishedGraphSnapshotSchema.safeParse(graph).success, true)

  assert.deepEqual(new GraphRecall(graph).suggest('wi-a', 'memory'), {
    hints: [],
    omitted_hints: 0,
    degraded: true,
  })
})

test('the graph turn path imports no I/O, store-client, executor, git, subprocess, or provider seam', () => {
  const source = readFileSync(
    resolve(import.meta.dirname, '../../src/workspace-graph/recall.ts'),
    'utf8',
  )
  assert.doesNotMatch(
    source,
    /from\s+['"](?:node:(?:fs|sqlite|child_process|net|http)|[^'"]*(?:store-client|executor|provider))/iu,
  )
  assert.doesNotMatch(source, /\b(?:readFile|fetch|spawn|execFile|DatabaseSync|WorkspaceGraphStore)\b/u)
})

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}
