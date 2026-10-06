import { z } from 'zod'

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

export type EvidenceRef = Readonly<z.infer<typeof EvidenceRefSchema>>
export type LogicalWorkspace = Readonly<z.infer<typeof LogicalWorkspaceSchema>>
export type WorkspaceInstance = Readonly<z.infer<typeof WorkspaceInstanceSchema>>
export type RelationCard = Readonly<z.infer<typeof RelationCardSchema>>
