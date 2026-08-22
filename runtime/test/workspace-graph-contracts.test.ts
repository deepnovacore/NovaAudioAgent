import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import {
  ContextHeaderSchema,
  GraphHintSchema,
  LogicalWorkspaceSchema,
  ObservationSchema,
  RecallPackSchema,
  RelationCardSchema,
  WorkspaceInstanceSchema,
  workspaceGraphFixtureFamilySchema,
} from '../src/workspace-graph/models.js'
import {
  hostContextItemSchema,
  workspaceContextDeliverySchema,
} from '../src/realtime/protocol.js'

const fixtureRoot = resolve(import.meta.dirname, '../../../fixtures/workspace-graph')

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(fixtureRoot, name), 'utf8')) as unknown
}

test('workspace graph fixtures parse and re-serialize canonically', () => {
  const observations = loadFixture('observations.json')
  const cards = loadFixture('cards.json')
  const relations = loadFixture('relations.json')
  const recallPacks = loadFixture('recall-packs.json')
  const hostItems = loadFixture('host-items.json')
  const fixtureFamily = workspaceGraphFixtureFamilySchema.parse({
    observations,
    cards,
    relations,
    recall_packs: recallPacks,
    host_items: hostItems,
  })

  for (const entry of fixtureFamily.observations.cases) {
    const parsed = ObservationSchema.parse(entry.value)
    assert.deepEqual(JSON.parse(JSON.stringify(parsed)), entry.value)
  }
  for (const entry of fixtureFamily.cards.logical_workspace_cases) {
    const parsed = LogicalWorkspaceSchema.parse(entry.value)
    assert.deepEqual(JSON.parse(JSON.stringify(parsed)), entry.value)
  }
  for (const entry of fixtureFamily.cards.workspace_instance_cases) {
    const parsed = WorkspaceInstanceSchema.parse(entry.value)
    assert.deepEqual(JSON.parse(JSON.stringify(parsed)), entry.value)
  }
  for (const entry of fixtureFamily.relations.cases) {
    const parsed = RelationCardSchema.parse(entry.value)
    assert.deepEqual(JSON.parse(JSON.stringify(parsed)), entry.value)
  }
  for (const entry of fixtureFamily.recall_packs.context_header_cases) {
    const parsed = ContextHeaderSchema.parse(entry.value)
    assert.deepEqual(JSON.parse(JSON.stringify(parsed)), entry.value)
  }
  for (const entry of fixtureFamily.recall_packs.graph_hint_cases) {
    const parsed = GraphHintSchema.parse(entry.value)
    assert.deepEqual(JSON.parse(JSON.stringify(parsed)), entry.value)
  }
  for (const entry of fixtureFamily.recall_packs.recall_pack_cases) {
    const parsed = RecallPackSchema.parse(entry.value)
    assert.deepEqual(JSON.parse(JSON.stringify(parsed)), entry.value)
  }
  for (const entry of fixtureFamily.host_items.host_item_cases) {
    const parsed = hostContextItemSchema.parse(entry.value)
    assert.deepEqual(JSON.parse(JSON.stringify(parsed)), entry.value)
  }
  for (const entry of fixtureFamily.host_items.delivery_cases) {
    const parsed = workspaceContextDeliverySchema.parse(entry.value)
    assert.deepEqual(JSON.parse(JSON.stringify(parsed)), entry.value)
  }
})

test('relation requires unique evidence and bounded confidence', () => {
  const relation = {
    source_logical_id: 'lw-a',
    target_logical_id: 'lw-b',
    relation_type: 'depends_on',
    confidence: 0.9,
    reason: 'shared runtime',
    evidence_refs: [],
    first_seen_at: 1,
    last_seen_at: 1,
    status: 'active',
    revision: 1,
  }
  assert.throws(() => RelationCardSchema.parse(relation), /evidence/u)
  assert.throws(() => RelationCardSchema.parse({...relation, confidence: 1.01}), /confidence/u)
  assert.throws(() => RelationCardSchema.parse({
    ...relation,
    evidence_refs: [
      {source: 'runtime', ref: 'event-1', observed_at: 1},
      {source: 'runtime', ref: 'event-1', observed_at: 1},
    ],
  }), /duplicate/u)
})

test('fixtures cover every observation type, relation status, confidence boundary, and delivery capability', () => {
  const fixtureFamily = workspaceGraphFixtureFamilySchema.parse({
    observations: loadFixture('observations.json'),
    cards: loadFixture('cards.json'),
    relations: loadFixture('relations.json'),
    recall_packs: loadFixture('recall-packs.json'),
    host_items: loadFixture('host-items.json'),
  })
  assert.deepEqual(
    new Set(fixtureFamily.observations.cases.map(entry => entry.value.observation_type)),
    new Set([
      'workspace_opened',
      'instance_observed',
      'task_artifact_reference',
      'task_completed',
      'work_order_summary',
      'user_relation_statement',
      'provider_relation_evidence',
      'relation_suppressed',
    ]),
  )
  assert.deepEqual(
    new Set(fixtureFamily.relations.cases.map(entry => entry.value.status)),
    new Set(['active', 'weak', 'stale', 'suppressed']),
  )
  assert.ok(fixtureFamily.relations.cases.some(entry => entry.value.confidence === 0))
  assert.ok(fixtureFamily.relations.cases.some(entry => entry.value.confidence === 1))
  assert.deepEqual(
    new Set(fixtureFamily.host_items.delivery_cases.map(entry => entry.value.capability)),
    new Set(['replace_provider_item', 'refresh_session', 'unavailable']),
  )
})
