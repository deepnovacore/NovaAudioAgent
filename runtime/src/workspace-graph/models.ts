import { z } from 'zod'
import {
  workspaceContextDeliveryRecordSchema,
} from '../realtime/protocol.js'

const nonemptyStableIdSchema = z.string().min(1).regex(/\S/u, 'stable id must be non-empty')
const timestampSchema = z.number().finite().nonnegative()
const revisionSchema = z.number().int().nonnegative()
const confidenceSchema = z.number().finite().min(0).max(1)
const reasonSchema = z.string().min(1).max(239).regex(/\S/u, 'reason must be non-empty')
const labelSchema = z.string().min(1).max(239).regex(/\S/u, 'label must be non-empty')

export const EvidenceRefSchema = z.object({
  source: z.enum(['runtime', 'filesystem', 'git', 'executor', 'user', 'provider']),
  ref: nonemptyStableIdSchema,
  observed_at: timestampSchema,
}).strict()

export const ObservationSchema = z.object({
  observation_id: nonemptyStableIdSchema,
  observation_type: z.enum([
    'workspace_opened',
    'instance_observed',
    'task_artifact_reference',
    'task_completed',
    'work_order_summary',
    'user_relation_statement',
    'provider_relation_evidence',
    'relation_suppressed',
  ]),
  occurred_at: timestampSchema,
  source: z.enum(['runtime', 'filesystem', 'git', 'executor', 'user', 'provider']),
  trust: z.enum(['trusted_user', 'trusted_system', 'untrusted_external', 'user_confirmed']),
  logical_workspace_id: nonemptyStableIdSchema.nullable(),
  workspace_instance_id: nonemptyStableIdSchema.nullable(),
  related_logical_workspace_id: nonemptyStableIdSchema.nullable(),
  summary: labelSchema.nullable(),
  outcome: z.enum(['ok', 'unknown', 'failed']).nullable(),
  evidence_refs: z.array(EvidenceRefSchema),
}).strict()

export const LogicalWorkspaceSchema = z.object({
  logical_workspace_id: nonemptyStableIdSchema,
  display_name: labelSchema,
  aliases: z.array(labelSchema).superRefine((aliases, context) => {
    if (new Set(aliases).size !== aliases.length) {
      context.addIssue({code: 'custom', message: 'aliases must be unique'})
    }
  }),
  canonical_remote: labelSchema.nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  revision: revisionSchema,
}).strict().superRefine((workspace, context) => {
  if (workspace.updated_at < workspace.created_at) {
    context.addIssue({
      code: 'custom',
      path: ['updated_at'],
      message: 'updated_at cannot precede created_at',
    })
  }
})

export const WorkspaceInstanceSchema = z.object({
  instance_id: nonemptyStableIdSchema,
  logical_workspace_id: nonemptyStableIdSchema,
  display_name: labelSchema,
  path_label: labelSchema,
  branch: labelSchema.nullable(),
  repository_fingerprint: nonemptyStableIdSchema.nullable(),
  status: z.enum(['active', 'inactive']),
  first_seen_at: timestampSchema,
  last_seen_at: timestampSchema,
  revision: revisionSchema,
}).strict().superRefine((instance, context) => {
  if (instance.last_seen_at < instance.first_seen_at) {
    context.addIssue({
      code: 'custom',
      path: ['last_seen_at'],
      message: 'last_seen_at cannot precede first_seen_at',
    })
  }
})

export const relationTypeSchema = z.enum([
  'depends_on',
  'sibling_of',
  'replaces',
  'shares_runtime',
  'discussed_with',
])
export const relationStatusSchema = z.enum(['active', 'weak', 'stale', 'suppressed'])

export const RelationCardSchema = z.object({
  source_logical_id: nonemptyStableIdSchema,
  target_logical_id: nonemptyStableIdSchema,
  relation_type: relationTypeSchema,
  confidence: confidenceSchema,
  reason: reasonSchema,
  evidence_refs: z.array(EvidenceRefSchema),
  first_seen_at: timestampSchema,
  last_seen_at: timestampSchema,
  status: relationStatusSchema,
  revision: revisionSchema,
}).strict().superRefine((relation, context) => {
  if (relation.last_seen_at < relation.first_seen_at) {
    context.addIssue({
      code: 'custom',
      path: ['last_seen_at'],
      message: 'last_seen_at cannot precede first_seen_at',
    })
  }
  if (
    (relation.status === 'active' || relation.status === 'weak' || relation.status === 'stale')
    && relation.evidence_refs.length === 0
  ) {
    context.addIssue({
      code: 'custom',
      path: ['evidence_refs'],
      message: 'evidence is required for active, weak, and stale relations',
    })
  }
  const keys = relation.evidence_refs.map(ref => `${ref.source}\u0000${ref.ref}`)
  if (new Set(keys).size !== keys.length) {
    context.addIssue({
      code: 'custom',
      path: ['evidence_refs'],
      message: 'duplicate evidence references are not allowed',
    })
  }
})

export const GraphHintSchema = z.object({
  hint_id: nonemptyStableIdSchema,
  logical_workspace_id: nonemptyStableIdSchema,
  relation_type: relationTypeSchema,
  relation_status: z.enum(['active', 'weak', 'stale']),
  confidence: confidenceSchema,
  reason: reasonSchema,
  evidence_refs: z.array(EvidenceRefSchema).min(1),
  revision: revisionSchema,
}).strict()

export const ContextHeaderSchema = z.object({
  session_epoch: z.number().int().positive(),
  workspace_instance_id: nonemptyStableIdSchema,
  logical_workspace_id: nonemptyStableIdSchema,
  revision: revisionSchema,
  content: labelSchema,
  token_estimate: z.number().int().min(150).max(300),
}).strict()

export const RecallPackSchema = z.object({
  session_epoch: z.number().int().positive(),
  workspace_instance_id: nonemptyStableIdSchema,
  revision: revisionSchema,
  content: labelSchema,
  token_estimate: z.number().int().min(300).max(800),
  hints: z.array(GraphHintSchema).max(2),
  omitted_hints: z.number().int().nonnegative(),
  degraded: z.boolean(),
}).strict()

const fixtureCaseSchema = <Value extends z.ZodType>(value: Value) => z.object({
  id: nonemptyStableIdSchema,
  value,
}).strict()

export const observationFixtureSchema = z.object({
  cases: z.array(fixtureCaseSchema(ObservationSchema)).min(1),
}).strict()

export const cardFixtureSchema = z.object({
  logical_workspace_cases: z.array(fixtureCaseSchema(LogicalWorkspaceSchema)).min(1),
  workspace_instance_cases: z.array(fixtureCaseSchema(WorkspaceInstanceSchema)).min(1),
}).strict()

export const relationFixtureSchema = z.object({
  cases: z.array(fixtureCaseSchema(RelationCardSchema)).min(1),
}).strict()

export const recallPackFixtureSchema = z.object({
  context_header_cases: z.array(fixtureCaseSchema(ContextHeaderSchema)).min(1),
  graph_hint_cases: z.array(fixtureCaseSchema(GraphHintSchema)).min(1),
  recall_pack_cases: z.array(fixtureCaseSchema(RecallPackSchema)).min(1),
}).strict()

export const hostItemFixtureSchema = z.object({
  workspace_context_delivery_cases: z.array(
    fixtureCaseSchema(workspaceContextDeliveryRecordSchema),
  ).min(1),
}).strict()

export const workspaceGraphFixtureFamilySchema = z.object({
  observations: observationFixtureSchema,
  cards: cardFixtureSchema,
  relations: relationFixtureSchema,
  recall_packs: recallPackFixtureSchema,
  host_items: hostItemFixtureSchema,
}).strict()

export type EvidenceRef = Readonly<z.infer<typeof EvidenceRefSchema>>
export type Observation = Readonly<z.infer<typeof ObservationSchema>>
export type LogicalWorkspace = Readonly<z.infer<typeof LogicalWorkspaceSchema>>
export type WorkspaceInstance = Readonly<z.infer<typeof WorkspaceInstanceSchema>>
export type RelationCard = Readonly<z.infer<typeof RelationCardSchema>>
export type GraphHint = Readonly<z.infer<typeof GraphHintSchema>>
export type ContextHeader = Readonly<z.infer<typeof ContextHeaderSchema>>
export type RecallPack = Readonly<z.infer<typeof RecallPackSchema>>

export function workspaceGraphFixtureJsonSchema(): z.core.JSONSchema.JSONSchema {
  const schema = z.toJSONSchema(workspaceGraphFixtureFamilySchema) as JsonSchemaObject
  const relation = schemaAt(schema, 'properties', 'relations', 'properties', 'cases', 'items', 'properties', 'value')
  relation.allOf = [{
    if: {
      properties: {status: {enum: ['active', 'weak', 'stale']}},
      required: ['status'],
    },
    then: {
      properties: {evidence_refs: {minItems: 1}},
      required: ['evidence_refs'],
    },
  }]
  relation['x-nova-cross-field'] = {
    last_seen_at: {gte: 'first_seen_at'},
    evidence_refs: {unique_by: ['source', 'ref']},
  }

  const injection = schemaAt(
    schema,
    'properties', 'host_items', 'properties', 'workspace_context_delivery_cases',
    'items', 'properties', 'value',
  )
  const item = schemaAt(injection, 'properties', 'item')
  item.allOf = [{
    if: {
      properties: {kind: {const: 'workspace_context'}},
      required: ['kind'],
    },
    then: {required: ['session_epoch', 'workspace_instance_id', 'revision']},
    else: {
      not: {
        anyOf: [
          {required: ['session_epoch']},
          {required: ['workspace_instance_id']},
          {required: ['revision']},
        ],
      },
    },
  }]
  injection.allOf = [{
    properties: {
      item: {
        properties: {kind: {const: 'workspace_context'}},
        required: ['kind'],
      },
    },
    required: ['item'],
  }]
  injection['x-nova-cross-field'] = {
    equals: [
      ['item.session_epoch', 'delivery.session_epoch'],
      ['item.workspace_instance_id', 'delivery.workspace_instance_id'],
      ['item.revision', 'delivery.revision'],
    ],
  }
  const delivery = schemaAt(injection, 'properties', 'delivery')
  delivery['x-nova-cross-field'] = {
    superseded_provider_item_id: {
      equals: 'prior_provider_item_id',
      when: {capability: 'replace_provider_item'},
    },
  }
  return schema
}

type JsonSchemaObject = Record<string, unknown>

function schemaAt(schema: JsonSchemaObject, ...path: readonly string[]): JsonSchemaObject {
  let current: unknown = schema
  for (const key of path) current = (current as JsonSchemaObject)[key]
  return current as JsonSchemaObject
}
