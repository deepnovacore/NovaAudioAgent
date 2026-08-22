import assert from 'node:assert/strict'
import {Buffer} from 'node:buffer'
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {compileContextView} from '../src/context-view.js'
import {Memory} from '../src/memory.js'
import {renderContextSnapshot} from '../src/prompting.js'
import {
  QwenAudioRealtimeAdapter,
  QwenSocketClosedError,
  type QwenSocket,
} from '../src/realtime/qwen.js'
import {
  MAX_WORKSPACE_GRAPH_BOARD_BYTES,
  workspaceGraphBoardMessage,
} from '../src/realtime/workspace-graph-board.js'
import {
  applyWorkspaceIdentityDeltas,
  WorkspaceIdentityResolver,
  type WorkspaceIdentityState,
} from '../src/workspace-graph/identity.js'
import type {WorkspaceInstance} from '../src/workspace-graph/models.js'
import {MyContextProvider} from '../src/workspace-graph/provider.js'
import {
  GRAPH_CONTEXT_HEADER_MAX_CODE_POINTS,
  GRAPH_CONTEXT_HEADER_MAX_TOKENS,
  GRAPH_CONTEXT_HEADER_MAX_UTF8_BYTES,
  GRAPH_CONTEXT_RECALL_MAX_CODE_POINTS,
  GRAPH_CONTEXT_RECALL_MAX_TOKENS,
  GRAPH_CONTEXT_RECALL_MAX_UTF8_BYTES,
  estimateGraphContextTokens,
} from '../src/workspace-graph/context.js'
import {WorkspaceGraphService} from '../src/workspace-graph/service.js'
import {WorkspaceGraphStoreClient} from '../src/workspace-graph/store-client.js'

const compatibleCapabilities = {
  protocol: 'nova_workspace_evidence',
  schema_version: 1,
  provider: 'mycontext',
  capabilities: {
    exact_workspace_scope: true,
    read_only: true,
    evidence_provenance: true,
    mutations: false,
    actions: false,
  },
} as const

const WORKSPACE_HINTS_POLICY_OPEN = '<workspace_hints authority="suggestion_only" '
  + 'scope="current_workspace_next_step" cross_workspace="forbidden" action="forbidden">'

/*
 * These scenarios own the durable cross-layer handoffs. Irreducible transport, timer, identity,
 * and renderer failure seams stay in their adversarial suites and are part of Task 9 acceptance:
 * realtime-assembly (authoritative lifecycle/Header and nonblocking failures),
 * workspace-graph-store (locked timer and last-good publication), workspace-graph-identity
 * (rename/remote continuity and live-instance ambiguity), workspace-graph-provider (fail-closed
 * capability handshake), desktop-service/desktop-bridge (snapshot-only latest board delivery), and
 * Ambient Orb workspace-graph-board (selection/visible refresh with no action controls).
 */

function sequence(prefix: string): () => string {
  let value = 0
  return () => `${prefix}-${++value}`
}

async function databaseBytes(directory: string): Promise<Readonly<Record<string, string>>> {
  const names = (await readdir(directory)).filter(name => name.startsWith('graph.sqlite')).sort()
  const entries = await Promise.all(names.map(async name => [
    name,
    (await readFile(join(directory, name))).toString('base64'),
  ] as const))
  return Object.freeze(Object.fromEntries(entries))
}

async function databaseText(directory: string): Promise<string> {
  const names = (await readdir(directory)).filter(name => name.startsWith('graph.sqlite')).sort()
  return (await Promise.all(names.map(name => readFile(join(directory, name)))))
    .map(value => value.toString('utf8'))
    .join('\n')
}

function codePoints(value: string): number {
  return [...value].length
}

async function establishRelatedWorkspaces(path: string, idPrefix: string) {
  const service = new WorkspaceGraphService({path, id_factory: sequence(idPrefix)})
  await service.open()
  const first = await service.openWorkspace({
    path: '/safe/nova-alpha', repository_fingerprint: 'host-alpha', now: 1,
  })
  const second = await service.openWorkspace({
    path: '/safe/nova-beta', repository_fingerprint: 'host-beta', now: 2,
  })
  const current = await service.openWorkspace({
    path: '/safe/nova-alpha', repository_fingerprint: 'host-alpha', now: 3,
  })
  assert.equal(first.kind, 'resolved')
  assert.equal(second.kind, 'resolved')
  assert.equal(current.kind, 'resolved')
  await service.recordTaskCompletion({
    workspace_instance_id: current.instance.instance_id,
    summary: 'typed current-workspace protocol follow-up',
    outcome: 'ok',
    now: 4,
    relation_cue: {
      target_logical_id: second.logical_workspace.logical_workspace_id,
      relation_type: 'shares_runtime',
      reason: 'shared protocol bridge',
    },
  })
  return {service, first, second, current}
}

test('durable relation restarts into bounded text-only suggestion context and read-only board', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-graph-e2e-text-'))
  const path = join(directory, 'graph.sqlite')
  t.after(() => rm(directory, {recursive: true, force: true}))
  const established = await establishRelatedWorkspaces(path, 'established')
  await established.service.close()

  const providerCalls: unknown[] = []
  const restarted = new WorkspaceGraphService({
    path,
    id_factory: sequence('restarted'),
    personal_context_provider: {
      lookupWorkspaceEvidence: input => {
        providerCalls.push(input)
        return Promise.resolve(Object.freeze({
          evidence: Object.freeze([]), omitted_evidence: 0, degraded: false, diagnostic: null,
        }))
      },
    },
  })
  t.after(() => restarted.close())
  await restarted.open()
  const current = await restarted.openWorkspace({
    path: '/safe/nova-alpha', repository_fingerprint: 'host-alpha', now: 5,
  })
  assert.equal(current.kind, 'resolved')

  const graphContext = restarted.contextForTurn({
    session_epoch: 7,
    workspace_instance_id: current.instance.instance_id,
    utterance: 'shared protocol bridge next step',
    preferences: ['keep the voice response light'],
  })
  assert.ok(graphContext !== null)
  assert.ok(graphContext.header !== null)
  assert.ok(graphContext.recall_pack !== null)
  assert.equal(providerCalls.length, 0, 'automatic recall is snapshot-only')
  assert.ok(graphContext.recall_pack.startsWith(WORKSPACE_HINTS_POLICY_OPEN))
  assert.match(graphContext.recall_pack, /shared protocol bridge/u)
  assert.doesNotMatch(graphContext.recall_pack, /\/safe\/nova-beta|host-beta/u)
  const serializedPack = graphContext.recall_pack.slice(
    WORKSPACE_HINTS_POLICY_OPEN.length,
    -'</workspace_hints>'.length,
  )
  const pack = JSON.parse(serializedPack) as {
    content: string
    hints: {logical_workspace_id: string}[]
  }
  const currentPolicy = JSON.parse(pack.content) as {
    current_logical_name: string
    logical_workspace_id: string
  }
  assert.deepEqual(currentPolicy, {
    current_logical_name: current.logical_workspace.display_name,
    logical_workspace_id: current.logical_workspace.logical_workspace_id,
  })
  assert.deepEqual(pack.hints.map(hint => hint.logical_workspace_id), [
    established.second.logical_workspace.logical_workspace_id,
  ])

  assert.ok(estimateGraphContextTokens(graphContext.header) <= GRAPH_CONTEXT_HEADER_MAX_TOKENS)
  assert.ok(codePoints(graphContext.header) <= GRAPH_CONTEXT_HEADER_MAX_CODE_POINTS)
  assert.ok(Buffer.byteLength(graphContext.header, 'utf8') <= GRAPH_CONTEXT_HEADER_MAX_UTF8_BYTES)
  assert.ok(estimateGraphContextTokens(graphContext.recall_pack) <= GRAPH_CONTEXT_RECALL_MAX_TOKENS)
  assert.ok(codePoints(graphContext.recall_pack) <= GRAPH_CONTEXT_RECALL_MAX_CODE_POINTS)
  assert.ok(Buffer.byteLength(graphContext.recall_pack, 'utf8') <= GRAPH_CONTEXT_RECALL_MAX_UTF8_BYTES)

  const view = compileContextView(new Memory(), 'idle', 6, {graphContext})
  const rendered = renderContextSnapshot(view)
  assert.match(rendered, /<workspace_context kind="data">/u)
  assert.ok(rendered.includes(WORKSPACE_HINTS_POLICY_OPEN))
  assert.ok(rendered.indexOf('<workspace_hints') < rendered.indexOf('## 意图'))
  assert.doesNotMatch(rendered, /\/safe\/nova-beta|host-beta|<tool_call>|switch_workspace|inspect_workspace/u)

  const irrelevant = restarted.contextForTurn({
    session_epoch: 7,
    workspace_instance_id: current.instance.instance_id,
    utterance: 'bananas and weather',
    preferences: [],
  })
  assert.ok(irrelevant !== null)
  assert.equal(irrelevant.recall_pack, null, 'a relation alone never creates speech guidance')

  const boardBytes = workspaceGraphBoardMessage('e2e-board', restarted.publishedSnapshot, 'ready')
  assert.ok(Buffer.byteLength(boardBytes, 'utf8') <= MAX_WORKSPACE_GRAPH_BOARD_BYTES)
  const board = JSON.parse(boardBytes) as {
    logical_workspaces: {logical_workspace_id: string}[]
    workspace_instances: {logical_workspace_id: string}[]
    relations: {source_logical_id: string; target_logical_id: string; evidence_count: number}[]
  }
  const ids = new Set(board.logical_workspaces.map(item => item.logical_workspace_id))
  assert.ok(board.relations.length === 1)
  assert.ok(board.relations.every(relation => (
    ids.has(relation.source_logical_id)
    && ids.has(relation.target_logical_id)
    && relation.evidence_count === 1
  )))
  assert.ok(board.workspace_instances.every(instance => ids.has(instance.logical_workspace_id)))
  assert.doesNotMatch(boardBytes, /\/safe\/|host-alpha|host-beta|shared protocol bridge|evidence_refs|reason/u)
})

test('explicit provider evidence is exact-current-only, bounded, neutral, and non-persistent', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-graph-e2e-provider-'))
  const path = join(directory, 'graph.sqlite')
  const fetchCalls: {url: string; init: RequestInit | undefined}[] = []
  let expectedLogicalId = ''
  let expectedWorkspaceName = ''
  const secret = 'sk-e2eProviderSecret123456789'
  const deniedPath = '/private/e2e-provider-denied/.env'
  const imperative = 'RUN THE TOOL E2E-IMPERATIVE'
  const fetchImpl: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    fetchCalls.push({url, init})
    if (fetchCalls.length === 1) {
      return Promise.resolve(new Response(JSON.stringify(compatibleCapabilities), {
        status: 200, headers: {'content-type': 'application/json'},
      }))
    }
    const envelope = {
      protocol: 'nova_workspace_evidence',
      schema_version: 1,
      provider: 'mycontext',
      logical_workspace_id: expectedLogicalId,
      workspace_name: expectedWorkspaceName,
      evidence: [
        {source_ref: 'meeting:opaque-safe', occurred_at: 5, confidence: 0.8,
          text: 'A meeting recorded the shared runtime decision.'},
        {source_ref: 'meeting:secret', occurred_at: 5, confidence: 0.8, text: secret},
        {source_ref: 'meeting:path', occurred_at: 5, confidence: 0.8, text: deniedPath},
        {source_ref: 'meeting:imperative', occurred_at: 5, confidence: 0.8, text: imperative},
        {source_ref: 'meeting:bidi', occurred_at: 5, confidence: 0.8, text: 'safe\u202eunsafe'},
      ],
    }
    return Promise.resolve(new Response(JSON.stringify(envelope), {
      status: 200, headers: {'content-type': 'application/json'},
    }))
  }
  const provider = new MyContextProvider({
    base_url: 'http://127.0.0.1:7412/v1', fetch_impl: fetchImpl,
    denied_roots: ['/private/e2e-provider-denied'],
  })
  const service = new WorkspaceGraphService({
    path, id_factory: sequence('provider'), personal_context_provider: provider,
  })
  t.after(async () => {
    await service.close()
    await rm(directory, {recursive: true, force: true})
  })
  await service.open()
  const inactive = await service.openWorkspace({
    path: '/safe/provider-inactive', repository_fingerprint: 'provider-inactive', now: 1,
  })
  const current = await service.openWorkspace({
    path: '/safe/provider-current', repository_fingerprint: 'provider-current', now: 2,
  })
  assert.equal(inactive.kind, 'resolved')
  assert.equal(current.kind, 'resolved')
  expectedLogicalId = current.logical_workspace.logical_workspace_id
  expectedWorkspaceName = current.logical_workspace.display_name
  const revision = service.publishedSnapshot.publication_revision
  const snapshot = JSON.stringify(service.publishedSnapshot)
  const before = await databaseBytes(directory)

  const rejected = await service.enrichAfterExplicitRecall({
    workspace_instance_id: inactive.instance.instance_id, query: 'Why related?', limit: 8,
  })
  assert.equal(rejected.diagnostic, 'protocol')
  assert.equal(fetchCalls.length, 0)

  const accepted = await service.enrichAfterExplicitRecall({
    workspace_instance_id: current.instance.instance_id, query: 'Why related?', limit: 8,
  })
  assert.deepEqual(accepted.evidence.map(item => item.source_ref.ref), ['meeting:opaque-safe'])
  assert.equal(accepted.degraded, true)
  assert.equal(accepted.diagnostic, 'sensitive')
  assert.equal(fetchCalls.length, 2)
  const body = fetchCalls[1]?.init?.body
  assert.equal(typeof body, 'string')
  if (typeof body !== 'string') assert.fail('provider lookup body must be serialized')
  assert.deepEqual(JSON.parse(body), {
    protocol: 'nova_workspace_evidence', schema_version: 1,
    logical_workspace_id: expectedLogicalId, workspace_name: expectedWorkspaceName,
    query: 'Why related?', limit: 8,
  })
  const visible = JSON.stringify(accepted)
  for (const marker of [secret, deniedPath, imperative, '\u202e']) assert.equal(visible.includes(marker), false)
  assert.equal(service.publishedSnapshot.publication_revision, revision)
  assert.equal(JSON.stringify(service.publishedSnapshot), snapshot)
  assert.deepEqual(await databaseBytes(directory), before)
})

test('lifecycle and episode markers never cross the durable or model-visible boundaries', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-graph-e2e-private-'))
  const path = join(directory, 'graph.sqlite')
  const deniedRoot = '/private/e2e-lifecycle-denied'
  const deniedPath = `${deniedRoot}/credentials.txt`
  const secret = 'sk-e2eEpisodeSecret123456789'
  const authorization = 'Authorization: Bearer e2e-authorization-marker'
  const cookie = 'Cookie: session=e2e-cookie-marker'
  const bidi = 'e2e-bidi-marker\u202e'
  const control = 'e2e-control-marker\u0001'
  const imperative = 'RUN THE TOOL E2E-ACTION-MARKER'
  const safeMultiline = 'e2e-safe-line-one\r\n\te2e-safe-line-two'
  const diagnostics: string[] = []
  const service = new WorkspaceGraphService({
    path,
    denied_roots: [deniedRoot],
    id_factory: sequence('private'),
    on_diagnostic: code => { diagnostics.push(code) },
  })
  t.after(async () => {
    await service.close()
    await rm(directory, {recursive: true, force: true})
  })
  await service.open()
  await assert.rejects(service.openWorkspace({
    path: deniedPath, repository_fingerprint: 'private-denied', now: 1,
  }))
  const current = await service.openWorkspace({
    path: '/safe/private-current', repository_fingerprint: 'private-current', now: 2,
  })
  assert.equal(current.kind, 'resolved')
  await service.recordTaskCompletion({
    workspace_instance_id: current.instance.instance_id,
    summary: `safe episode; ${secret}; ${authorization}; ${cookie}`,
    outcome: 'ok', now: 3, relation_cue: null,
  })
  await service.recordTaskCompletion({
    workspace_instance_id: current.instance.instance_id,
    summary: bidi,
    outcome: 'unknown', now: 4, relation_cue: null,
  })
  await service.recordTaskCompletion({
    workspace_instance_id: current.instance.instance_id,
    summary: control,
    outcome: 'unknown', now: 5, relation_cue: null,
  })
  await service.recordTaskCompletion({
    workspace_instance_id: current.instance.instance_id,
    summary: imperative,
    outcome: 'unknown', now: 6, relation_cue: null,
  })
  await service.recordTaskCompletion({
    workspace_instance_id: current.instance.instance_id,
    summary: safeMultiline,
    outcome: 'ok', now: 7, relation_cue: null,
  })
  const auditStore = new WorkspaceGraphStoreClient(path)
  await auditStore.open()
  const episodes = await auditStore.listObservations()
  await auditStore.close()
  assert.equal(episodes.find(item => item.occurred_at === 4)?.summary, null)
  assert.equal(episodes.find(item => item.occurred_at === 5)?.summary, null)
  assert.equal(episodes.find(item => item.occurred_at === 6)?.summary, null)
  assert.equal(episodes.find(item => item.occurred_at === 7)?.summary, safeMultiline)

  const context = service.contextForTurn({
    session_epoch: 1, workspace_instance_id: current.instance.instance_id,
    utterance: 'safe current task', preferences: [],
  })
  assert.ok(context !== null)
  const prompt = renderContextSnapshot(compileContextView(new Memory(), 'idle', 5, {
    graphContext: context,
  }))
  const board = workspaceGraphBoardMessage('private-board', service.publishedSnapshot, 'ready')
  const hostItem = JSON.stringify({
    kind: 'workspace_context', content: context.header,
    workspace_instance_id: current.instance.instance_id,
    revision: service.publishedSnapshot.publication_revision,
  })
  const durableText = await databaseText(directory)
  assert.equal(durableText.includes('e2e-safe-line-one'), true)
  assert.equal(durableText.includes('e2e-safe-line-two'), true)
  const surfaces = [
    durableText,
    JSON.stringify(service.publishedSnapshot),
    board,
    JSON.stringify(context),
    prompt,
    hostItem,
    diagnostics.join('\n'),
  ]
  for (const marker of [deniedPath, secret, authorization, cookie, bidi, control, imperative]) {
    for (const surface of surfaces) assert.equal(surface.includes(marker), false, marker)
  }
})

interface ScriptedSocket {
  readonly socket: QwenSocket
  readonly sent: Record<string, unknown>[]
  push(frame: Record<string, unknown>): void
}

function scriptedSocket(initial: Record<string, unknown>[]): ScriptedSocket {
  const inbound: (Record<string, unknown> | null)[] = [...initial]
  const sent: Record<string, unknown>[] = []
  let wake: (() => void) | undefined
  return {
    sent,
    socket: {
      send(payload) { sent.push(JSON.parse(payload) as Record<string, unknown>); return Promise.resolve() },
      async receive() {
        while (inbound.length === 0) await new Promise<void>(resolve => { wake = resolve })
        const next = inbound.shift()
        if (next === null || next === undefined) throw new QwenSocketClosedError()
        return JSON.stringify(next)
      },
      close() { return Promise.resolve() },
    },
    push(frame) { inbound.push(frame); wake?.(); wake = undefined },
  }
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise<void>(resolve => { setImmediate(resolve) })
  }
  assert.fail('expected protocol event did not occur')
}

function workspaceItem(revision: number, workspace: string) {
  return {
    kind: 'workspace_context' as const,
    host_item_id: `header-${revision}`,
    event_id: `event-${revision}`,
    content: `<workspace_context kind="data">current ${workspace}</workspace_context>`,
    call_id: null,
    session_epoch: 1,
    workspace_instance_id: workspace,
    revision,
  }
}

test('Qwen proves Header replacement and leaves accepted server-VAD transcripts without late recall', async t => {
  const scripted = scriptedSocket([
    {type: 'session.created', session: {id: 'session-e2e'}},
    {type: 'session.updated', session: {id: 'session-e2e'}},
  ])
  let nextId = 0
  const adapter = new QwenAudioRealtimeAdapter({
    url: 'wss://example.invalid/realtime', apiKey: 'test-key',
    model: 'qwen-audio-3.0-realtime-plus', voice: 'longanqian',
    connector: () => Promise.resolve(scripted.socket), idFactory: () => `wire-${++nextId}`,
    workspaceGraphPolicy: true,
  })
  t.after(() => adapter.close())
  await adapter.connect({tools: [], signal: new AbortController().signal})

  const first = adapter.injectWorkspaceContext(workspaceItem(1, 'wi-a'), {
    confirmationTimeout: 1, signal: new AbortController().signal,
  })
  await until(() => scripted.sent.filter(frame => frame.type === 'conversation.item.create').length === 1)
  const firstCreated = scripted.sent.find(frame => frame.type === 'conversation.item.create')
    ?.item as Record<string, unknown>
  scripted.push({type: 'conversation.item.created', item: {id: firstCreated.id}})
  const firstProof = await first
  assert.equal(firstProof.delivery.capability, 'replace_provider_item')
  assert.equal(firstProof.delivery.prior_provider_item_id, null)

  const second = adapter.injectWorkspaceContext(workspaceItem(2, 'wi-b'), {
    confirmationTimeout: 1, signal: new AbortController().signal,
  })
  await until(() => scripted.sent.some(frame => frame.type === 'conversation.item.delete'))
  assert.equal(scripted.sent.filter(frame => frame.type === 'conversation.item.create').length, 1)
  assert.equal(scripted.sent.find(frame => frame.type === 'conversation.item.delete')?.item_id,
    firstCreated.id)
  scripted.push({type: 'conversation.item.deleted', item_id: firstCreated.id})
  await until(() => scripted.sent.filter(frame => frame.type === 'conversation.item.create').length === 2)
  const secondCreated = scripted.sent.filter(frame => frame.type === 'conversation.item.create')
    .at(-1)?.item as Record<string, unknown>
  assert.notEqual(secondCreated.id, firstCreated.id)
  scripted.push({type: 'conversation.item.created', item: {id: secondCreated.id}})
  const secondProof = await second
  assert.deepEqual(secondProof.delivery, {
    capability: 'replace_provider_item', delivered: true, session_epoch: 1,
    workspace_instance_id: 'wi-b', revision: 2,
    prior_provider_item_id: firstCreated.id, superseded_provider_item_id: firstCreated.id,
    provider_item_id: secondCreated.id,
  })
  assert.equal(adapter.turnRecallContextCapability, 'unavailable')

  const events = adapter.events(new AbortController().signal)[Symbol.asyncIterator]()
  scripted.push({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'user-item-e2e', transcript: 'shared protocol bridge',
  })
  assert.deepEqual((await events.next()).value, {
    session_epoch: 1, kind: 'user_transcript_final',
    item_id: 'user-item-e2e', text: 'shared protocol bridge',
  })
  assert.equal(scripted.sent.filter(frame => frame.type === 'conversation.item.create').length, 2,
    'accepted transcript must not append a late workspace Recall Pack')
})

test('ASR aliases cannot route while explicit confirmation only changes identity matching', () => {
  const asrAliasMarker = 'e2e asr alias marker'
  const logical = {
    logical_workspace_id: 'lw-alias', display_name: 'Alias workspace', aliases: [],
    canonical_remote: null, created_at: 1, updated_at: 1, revision: 0,
  }
  let state: WorkspaceIdentityState = {
    logical_workspaces: [logical], workspace_instances: [], bindings: [], alias_observations: [],
  }
  const candidate = new WorkspaceIdentityResolver(state).observeAliasCandidate(
    logical.logical_workspace_id, asrAliasMarker,
    {kind: 'asr_transcript', ref: 'asr-e2e', observed_at: 2, confidence: 0.99},
  )
  state = applyWorkspaceIdentityDeltas(state, candidate.deltas)
  assert.equal(candidate.routing_allowed, false)
  assert.equal(state.alias_observations[0]?.spoken_alias, asrAliasMarker)
  assert.deepEqual(state.logical_workspaces[0]?.aliases, [])
  assert.deepEqual(new WorkspaceIdentityResolver(state).matchAlias(asrAliasMarker).map(match => ({
    kind: match.match_kind, routing: match.routing_allowed,
  })), [{kind: 'candidate', routing: false}])

  const confirmed = new WorkspaceIdentityResolver(state).learnAlias(
    logical.logical_workspace_id, asrAliasMarker,
    {kind: 'user_confirmed', ref: 'user-e2e', observed_at: 3},
  )
  state = applyWorkspaceIdentityDeltas(state, confirmed.deltas)
  assert.equal(confirmed.routing_allowed, false, 'learning itself has no action authority')
  assert.deepEqual(new WorkspaceIdentityResolver(state).matchAlias(asrAliasMarker).map(match => ({
    kind: match.match_kind, routing: match.routing_allowed,
  })), [{kind: 'confirmed', routing: true}])
})

test('suppression survives compaction, removes recall, and does not lock a later receipted write', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-graph-e2e-compaction-'))
  const path = join(directory, 'graph.sqlite')
  t.after(() => rm(directory, {recursive: true, force: true}))
  const established = await establishRelatedWorkspaces(path, 'compact-established')
  const sourceId = established.current.logical_workspace.logical_workspace_id
  const targetId = established.second.logical_workspace.logical_workspace_id
  const currentInstanceId = established.current.instance.instance_id
  const relationEvidenceRef = established.service.publishedSnapshot.relations[0]?.evidence_refs[0]?.ref
  assert.ok(relationEvidenceRef !== undefined)
  await established.service.close()

  const store = new WorkspaceGraphStoreClient(path)
  t.after(() => store.close())
  await store.open()
  const suppressionOperationId = '88888888-8888-4888-8888-888888888888'
  await store.suppressRelation(sourceId, targetId, 'shares_runtime', {
    source: 'user', ref: 'user-suppression-e2e', observed_at: 10,
  }, suppressionOperationId)
  const suppressionReceipt = await store.getOperationReceipt(suppressionOperationId)
  assert.ok(suppressionReceipt !== undefined)
  for (let index = 0; index < 140; index += 1) {
    const instance: WorkspaceInstance = {
      instance_id: `compact-instance-${index}`,
      logical_workspace_id: sourceId,
      display_name: `Compact instance ${index}`,
      path_label: `compact-${index}`,
      branch: null,
      repository_fingerprint: `compact-fingerprint-${index}`,
      status: 'inactive', first_seen_at: 20 + index, last_seen_at: 20 + index, revision: 0,
    }
    await store.replaceCard(instance)
  }
  const beforeCompactObservations = await store.listObservations()
  const compacted = await store.compact()
  assert.ok(compacted.derived_rows_after < compacted.derived_rows_before)
  assert.equal((await store.getRelation(sourceId, targetId, 'shares_runtime'))?.status, 'suppressed')
  assert.deepEqual((await store.listRelationEvidence(sourceId, targetId, 'shares_runtime'))
    .map(item => item.ref), [relationEvidenceRef, 'user-suppression-e2e'])
  assert.deepEqual(await store.listObservations(), beforeCompactObservations)
  assert.deepEqual(await store.getOperationReceipt(suppressionOperationId), suppressionReceipt)

  const operationId = '99999999-9999-4999-8999-999999999999'
  await store.appendObservation({
    observation_id: 'after-compaction-e2e', observation_type: 'workspace_opened',
    occurred_at: 999, source: 'runtime', trust: 'trusted_system',
    logical_workspace_id: sourceId, workspace_instance_id: currentInstanceId,
    related_logical_workspace_id: null, summary: 'later valid lifecycle',
    outcome: 'ok', evidence_refs: [],
  }, operationId)
  assert.equal((await store.getOperationReceipt(operationId))?.operation_type, 'append_observation')
  await store.close()

  const restarted = new WorkspaceGraphService({path, id_factory: sequence('compact-restarted')})
  t.after(() => restarted.close())
  await restarted.open()
  const current = await restarted.openWorkspace({
    path: '/safe/nova-alpha', repository_fingerprint: 'host-alpha', now: 1_000,
  })
  assert.equal(current.kind, 'resolved')
  assert.equal(restarted.contextForTurn({
    session_epoch: 1, workspace_instance_id: current.instance.instance_id,
    utterance: 'shared protocol bridge', preferences: [],
  })?.recall_pack, null)
})
