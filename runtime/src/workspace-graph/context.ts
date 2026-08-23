import {canonicalJson, compareCodePoints} from '../canonical-json.js'
import {z} from 'zod'
import {
  codePointLengthLikePython,
  collapsePythonWhitespace,
  isWellFormed,
  stripLikePython,
} from '../python-text.js'
import {normalizeNfkcPinned} from '../unicode-normalize.js'
import {isOtherCategory} from '../unicode-tables.js'
import {
  ContextHeaderSchema,
  GraphHintSchema,
  LogicalWorkspaceSchema,
  RecallPackSchema,
  WorkspaceInstanceSchema,
  type EvidenceRef,
  type GraphHint,
  type LogicalWorkspace,
  type WorkspaceInstance,
} from './models.js'
import type {GraphRecallResult} from './recall.js'
import {SensitiveContentPolicy, SensitivePathPolicy} from './sensitivity.js'

export const GRAPH_CONTEXT_OMITTED_DIAGNOSTIC = 'graph_context_omitted_budget'

export const GRAPH_CONTEXT_HEADER_MAX_TOKENS = 300
export const GRAPH_CONTEXT_RECALL_MAX_TOKENS = 800
export const GRAPH_CONTEXT_HEADER_MAX_CODE_POINTS = 900
export const GRAPH_CONTEXT_RECALL_MAX_CODE_POINTS = 2400
export const GRAPH_CONTEXT_HEADER_MAX_UTF8_BYTES = 3600
export const GRAPH_CONTEXT_RECALL_MAX_UTF8_BYTES = 9600

const CONTEXT_HEADER_RESERVED_TOKENS = 150
const RECALL_PACK_RESERVED_TOKENS = 300
const MAX_PREFERENCES = 3
const MAX_RECALL_INPUT_HINTS = 16
const MAX_HINT_EVIDENCE_REFS = 64
const MAX_TASK0_LABEL_CODE_UNITS = 239
const MAX_HEADER_PROJECTABLE_CODE_UNITS = GRAPH_CONTEXT_HEADER_MAX_CODE_POINTS * 2
const MAX_RECALL_PROJECTABLE_CODE_UNITS = GRAPH_CONTEXT_RECALL_MAX_CODE_POINTS * 2

const WORKSPACE_CONTEXT_OPEN = '<workspace_context kind="data">'
const WORKSPACE_CONTEXT_CLOSE = '</workspace_context>'
const WORKSPACE_HINTS_OPEN = '<workspace_hints authority="suggestion_only" '
  + 'scope="current_workspace_next_step" cross_workspace="forbidden" action="forbidden">'
const WORKSPACE_HINTS_CLOSE = '</workspace_hints>'

const pathPolicy = new SensitivePathPolicy()
const contentPolicy = new SensitiveContentPolicy()

export interface CurrentWorkspaceContext {
  readonly session_epoch: number
  readonly revision: number
  readonly logical_workspace: LogicalWorkspace
  readonly workspace_instance: WorkspaceInstance
}

export interface ContextBudgeterOptions {
  readonly maxHeaderTokens?: number
  readonly maxRecallTokens?: number
  readonly maxHeaderChars?: number
  readonly maxRecallChars?: number
  readonly maxHeaderBytes?: number
  readonly maxRecallBytes?: number
}

export interface GraphContext {
  readonly header: string | null
  readonly recall_pack: string | null
  readonly omitted_preferences: number
  readonly omitted_hints: number
  readonly degraded: boolean
  readonly diagnostic: typeof GRAPH_CONTEXT_OMITTED_DIAGNOSTIC | null
}

interface BlockBudget {
  readonly maxTokens: number
  readonly maxCodePoints: number
  readonly maxBytes: number
}

interface ValidatedRecall {
  readonly hints: readonly GraphHint[]
  readonly omitted_hints: number
  readonly degraded: boolean
  readonly had_hints: boolean
}

const currentLogicalWorkspaceSchema = z.object({
  logical_workspace_id: LogicalWorkspaceSchema.shape.logical_workspace_id,
  display_name: LogicalWorkspaceSchema.shape.display_name,
}).strict()

const currentWorkspaceInstanceSchema = z.object({
  instance_id: WorkspaceInstanceSchema.shape.instance_id,
  logical_workspace_id: WorkspaceInstanceSchema.shape.logical_workspace_id,
  display_name: WorkspaceInstanceSchema.shape.display_name,
  branch: WorkspaceInstanceSchema.shape.branch,
  status: WorkspaceInstanceSchema.shape.status,
}).strict()

interface ValidatedCurrentWorkspaceContext {
  readonly session_epoch: number
  readonly revision: number
  readonly logical_workspace: Readonly<z.infer<typeof currentLogicalWorkspaceSchema>>
  readonly workspace_instance: Readonly<z.infer<typeof currentWorkspaceInstanceSchema>>
}

const contextHeaderContentSchema = z.object({
  branch: z.string().optional(),
  current_instance_name: z.string(),
  current_logical_name: z.string(),
  degraded: z.boolean(),
  preferences: z.array(z.string()).max(MAX_PREFERENCES),
}).strict()

const recallPackContentSchema = z.object({
  current_logical_name: z.string(),
  logical_workspace_id: z.string(),
}).strict()

export class ContextBudgeter {
  readonly #headerBudget: BlockBudget
  readonly #recallBudget: BlockBudget

  constructor(options: ContextBudgeterOptions = {}) {
    this.#headerBudget = Object.freeze({
      maxTokens: configuredCap(
        options.maxHeaderTokens,
        GRAPH_CONTEXT_HEADER_MAX_TOKENS,
        'maxHeaderTokens',
      ),
      maxCodePoints: configuredCap(
        options.maxHeaderChars,
        GRAPH_CONTEXT_HEADER_MAX_CODE_POINTS,
        'maxHeaderChars',
      ),
      maxBytes: configuredCap(
        options.maxHeaderBytes,
        GRAPH_CONTEXT_HEADER_MAX_UTF8_BYTES,
        'maxHeaderBytes',
      ),
    })
    this.#recallBudget = Object.freeze({
      maxTokens: configuredCap(
        options.maxRecallTokens,
        GRAPH_CONTEXT_RECALL_MAX_TOKENS,
        'maxRecallTokens',
      ),
      maxCodePoints: configuredCap(
        options.maxRecallChars,
        GRAPH_CONTEXT_RECALL_MAX_CODE_POINTS,
        'maxRecallChars',
      ),
      maxBytes: configuredCap(
        options.maxRecallBytes,
        GRAPH_CONTEXT_RECALL_MAX_UTF8_BYTES,
        'maxRecallBytes',
      ),
    })
  }

  compose(
    currentInput: CurrentWorkspaceContext,
    recallInput: GraphRecallResult,
    preferenceInput: readonly string[],
  ): GraphContext {
    const current = validateCurrent(currentInput)
    const recall = validateRecall(recallInput)
    const preferences = validatePreferences(preferenceInput)
    let omittedPreferences = preferences.omitted
    const selectedPreferences = [...preferences.values]

    const uniqueHints = uniqueHintsById(recall.hints)
    let omittedHints = recall.omitted_hints + recall.hints.length - uniqueHints.length
    const selectedHints = uniqueHints.slice(0, 2)
    omittedHints += uniqueHints.length - selectedHints.length

    if (current === null) {
      return freezeGraphContext({
        header: null,
        recall_pack: null,
        omitted_preferences: omittedPreferences + selectedPreferences.length,
        omitted_hints: omittedHints + selectedHints.length,
        degraded: true,
        diagnostic: GRAPH_CONTEXT_OMITTED_DIAGNOSTIC,
      })
    }

    let header: string | null = null
    let includeBranch = true
    for (;;) {
      header = serializeHeader(
        current,
        selectedPreferences,
        recall.degraded,
        this.#headerBudget,
        includeBranch,
      )
      if (header !== null || selectedPreferences.length === 0) break
      selectedPreferences.pop()
      omittedPreferences += 1
    }
    if (header === null) {
      includeBranch = false
      header = serializeHeader(
        current,
        selectedPreferences,
        recall.degraded,
        this.#headerBudget,
        includeBranch,
      )
    }

    if (header === null) {
      return freezeGraphContext({
        header: null,
        recall_pack: null,
        omitted_preferences: omittedPreferences + selectedPreferences.length,
        omitted_hints: omittedHints + selectedHints.length,
        degraded: true,
        diagnostic: GRAPH_CONTEXT_OMITTED_DIAGNOSTIC,
      })
    }

    let recallPack: string | null = null
    while (selectedHints.length > 0) {
      recallPack = serializeRecallPack(
        current,
        selectedHints,
        omittedHints,
        recall.degraded,
        this.#recallBudget,
      )
      if (recallPack !== null) break
      selectedHints.pop()
      omittedHints += 1
    }
    const omittedAllRecall = recall.had_hints && recallPack === null
    if (omittedAllRecall && !recall.degraded) {
      header = serializeHeader(
        current,
        selectedPreferences,
        true,
        this.#headerBudget,
        includeBranch,
      )
      if (header === null) {
        return freezeGraphContext({
          header: null,
          recall_pack: null,
          omitted_preferences: omittedPreferences + selectedPreferences.length,
          omitted_hints: omittedHints,
          degraded: true,
          diagnostic: GRAPH_CONTEXT_OMITTED_DIAGNOSTIC,
        })
      }
    }
    return freezeGraphContext({
      header,
      recall_pack: recallPack,
      omitted_preferences: omittedPreferences,
      omitted_hints: omittedHints,
      degraded: recall.degraded || omittedAllRecall,
      diagnostic: omittedAllRecall ? GRAPH_CONTEXT_OMITTED_DIAGNOSTIC : null,
    })
  }
}

export function cloneGraphContext(input: GraphContext): GraphContext {
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new TypeError()
    const header = input.header
    const recallPack = input.recall_pack
    const omittedPreferences = input.omitted_preferences
    const omittedHints = input.omitted_hints
    const degraded = input.degraded
    const diagnostic = input.diagnostic
    const parsedHeader = parseContextHeaderBlock(header)
    const parsedRecall = parseRecallPackBlock(recallPack)
    if (header !== null && parsedHeader === null) throw new TypeError()
    if (recallPack !== null && parsedRecall === null) throw new TypeError()
    if (header === null && recallPack !== null) throw new TypeError()
    if (!Number.isSafeInteger(omittedPreferences) || omittedPreferences < 0) throw new TypeError()
    if (!Number.isSafeInteger(omittedHints) || omittedHints < 0) throw new TypeError()
    if (typeof degraded !== 'boolean') throw new TypeError()
    if (diagnostic !== null && diagnostic !== GRAPH_CONTEXT_OMITTED_DIAGNOSTIC) throw new TypeError()
    if (header === null && (!degraded || diagnostic === null)) throw new TypeError()
    if (diagnostic !== null && (!degraded || recallPack !== null)) throw new TypeError()
    if (parsedHeader !== null && parsedHeader.content.degraded !== degraded) throw new TypeError()
    if (parsedRecall !== null) {
      if (parsedHeader === null) throw new TypeError()
      if (
        parsedRecall.pack.session_epoch !== parsedHeader.header.session_epoch
        || parsedRecall.pack.workspace_instance_id !== parsedHeader.header.workspace_instance_id
        || parsedRecall.pack.revision !== parsedHeader.header.revision
        || parsedRecall.content.logical_workspace_id !== parsedHeader.header.logical_workspace_id
        || parsedRecall.content.current_logical_name !== parsedHeader.content.current_logical_name
        || parsedRecall.pack.degraded !== degraded
        || parsedRecall.pack.omitted_hints !== omittedHints
      ) throw new TypeError()
    }
    return freezeGraphContext({
      header,
      recall_pack: recallPack,
      omitted_preferences: omittedPreferences,
      omitted_hints: omittedHints,
      degraded,
      diagnostic,
    })
  } catch {
    throw new TypeError('invalid graph context')
  }
}

/** A deterministic local estimate used in addition to code-point and byte bounds. */
export function estimateGraphContextTokens(text: string): number {
  let tokens = 0
  let runKind: 'word' | 'punctuation' | null = null
  let runSize = 0
  let inWhitespace = false
  const flush = (): void => {
    if (runKind === 'word') tokens += Math.ceil(runSize / 4)
    else if (runKind === 'punctuation') tokens += Math.ceil(runSize / 3)
    runKind = null
    runSize = 0
  }
  for (const character of text) {
    const codePoint = character.codePointAt(0)!
    if (
      (codePoint >= 0x30 && codePoint <= 0x39)
      || (codePoint >= 0x41 && codePoint <= 0x5a)
      || (codePoint >= 0x61 && codePoint <= 0x7a)
      || character === '_'
    ) {
      if (runKind !== 'word') {
        flush()
        runKind = 'word'
      }
      runSize += 1
      inWhitespace = false
    } else if (codePoint <= 0x7f && /\s/u.test(character)) {
      flush()
      if (!inWhitespace) tokens += 1
      inWhitespace = true
    } else if (codePoint <= 0x7f) {
      if (runKind !== 'punctuation') {
        flush()
        runKind = 'punctuation'
      }
      runSize += 1
      inWhitespace = false
    } else {
      flush()
      tokens += 1
      inWhitespace = false
    }
  }
  flush()
  return Math.max(tokens, 1)
}

function configuredCap(value: number | undefined, hardCap: number, name: string): number {
  if (value === undefined) return hardCap
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be non-negative`)
  return Math.min(value, hardCap)
}

function validateCurrent(input: CurrentWorkspaceContext): ValidatedCurrentWorkspaceContext | null {
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new TypeError()
    const sessionEpoch = input.session_epoch
    const revision = input.revision
    const logicalInput = input.logical_workspace
    const instanceInput = input.workspace_instance
    if (!Number.isSafeInteger(sessionEpoch) || sessionEpoch <= 0) throw new TypeError()
    if (!Number.isSafeInteger(revision) || revision < 0) throw new TypeError()
    if (
      typeof logicalInput !== 'object'
      || logicalInput === null
      || Array.isArray(logicalInput)
      || typeof instanceInput !== 'object'
      || instanceInput === null
      || Array.isArray(instanceInput)
    ) throw new TypeError()
    const logicalRecord = logicalInput as unknown as Record<string, unknown>
    const instanceRecord = instanceInput as unknown as Record<string, unknown>
    const logicalWorkspaceId = logicalRecord.logical_workspace_id
    const logicalDisplayName = logicalRecord.display_name
    const instanceId = instanceRecord.instance_id
    const instanceLogicalWorkspaceId = instanceRecord.logical_workspace_id
    const instanceDisplayName = instanceRecord.display_name
    const branch = instanceRecord.branch
    const status = instanceRecord.status
    if (
      exceedsHeaderProjection(logicalWorkspaceId)
      || exceedsHeaderProjection(instanceId)
      || exceedsHeaderProjection(instanceLogicalWorkspaceId)
    ) return null
    const logicalWorkspace = currentLogicalWorkspaceSchema.parse({
      logical_workspace_id: logicalWorkspaceId,
      display_name: logicalDisplayName,
    })
    const workspaceInstance = currentWorkspaceInstanceSchema.parse({
      instance_id: instanceId,
      logical_workspace_id: instanceLogicalWorkspaceId,
      display_name: instanceDisplayName,
      branch,
      status,
    })
    if (
      workspaceInstance.logical_workspace_id !== logicalWorkspace.logical_workspace_id
      || workspaceInstance.status !== 'active'
    ) throw new TypeError()
    return deepFreeze({
      session_epoch: sessionEpoch,
      revision,
      logical_workspace: logicalWorkspace,
      workspace_instance: workspaceInstance,
    })
  } catch {
    throw new TypeError('invalid current workspace context')
  }
}

function validateRecall(input: GraphRecallResult): ValidatedRecall {
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new TypeError()
    const hintInput = input.hints
    const inputOmittedHints = input.omitted_hints
    const degraded = input.degraded
    if (!Array.isArray(hintInput)) throw new TypeError()
    const hintCount = hintInput.length
    if (!Number.isSafeInteger(hintCount) || hintCount < 0) throw new TypeError()
    if (!Number.isSafeInteger(inputOmittedHints) || inputOmittedHints < 0) throw new TypeError()
    if (typeof degraded !== 'boolean') throw new TypeError()
    if (inputOmittedHints > Number.MAX_SAFE_INTEGER - hintCount) throw new TypeError()
    const inspectCount = Math.min(hintCount, MAX_RECALL_INPUT_HINTS)
    const inspected: GraphHint[] = []
    let omittedHints = inputOmittedHints + hintCount - inspectCount
    for (let index = 0; index < inspectCount; index += 1) {
      const sanitized = projectHintInput(hintInput[index])
      if (sanitized === null) omittedHints += 1
      else inspected.push(sanitized)
    }
    return deepFreeze({
      hints: inspected,
      omitted_hints: omittedHints,
      degraded,
      had_hints: hintCount > 0,
    })
  } catch {
    throw new TypeError('invalid graph recall result')
  }
}

function validatePreferences(input: readonly string[]): {
  readonly values: readonly string[]
  readonly omitted: number
} {
  try {
    if (!Array.isArray(input)) throw new TypeError()
    const inputLength = input.length
    if (!Number.isSafeInteger(inputLength) || inputLength < 0) throw new TypeError()
    const inspectCount = Math.min(inputLength, MAX_PREFERENCES)
    const values: string[] = []
    let omitted = inputLength - inspectCount
    for (let index = 0; index < inspectCount; index += 1) {
      const value = input[index] as unknown
      if (typeof value !== 'string') throw new TypeError()
      if (!boundedString(value, MAX_TASK0_LABEL_CODE_UNITS)) {
        omitted += 1
        continue
      }
      const sanitized = neutralizeDataString('preference', value)
      if (!boundedString(sanitized, MAX_TASK0_LABEL_CODE_UNITS)) {
        omitted += 1
        continue
      }
      values.push(sanitized)
    }
    return {
      values,
      omitted,
    }
  } catch {
    throw new TypeError('invalid graph context preferences')
  }
}

function serializeHeader(
  current: ValidatedCurrentWorkspaceContext,
  preferences: readonly string[],
  degraded: boolean,
  budget: BlockBudget,
  includeBranch: boolean,
): string | null {
  const logicalId = neutralizeDataString(
    'logical_workspace_id',
    current.logical_workspace.logical_workspace_id,
  )
  const instanceId = neutralizeDataString(
    'workspace_instance_id',
    current.workspace_instance.instance_id,
  )
  const branch = includeBranch ? safeBranch(current.workspace_instance.branch) : null
  const content = canonicalJson({
    ...(branch === null ? {} : {branch}),
    current_instance_name: neutralizeDataString(
      'current_instance_name',
      current.workspace_instance.display_name,
    ),
    current_logical_name: neutralizeDataString(
      'current_logical_name',
      current.logical_workspace.display_name,
    ),
    degraded,
    preferences,
  })
  return serializeValidatedBlock({
    minimumTokens: CONTEXT_HEADER_RESERVED_TOKENS,
    maximumSchemaTokens: GRAPH_CONTEXT_HEADER_MAX_TOKENS,
    budget,
    opening: WORKSPACE_CONTEXT_OPEN,
    closing: WORKSPACE_CONTEXT_CLOSE,
    build: tokenEstimate => ContextHeaderSchema.safeParse({
      session_epoch: current.session_epoch,
      workspace_instance_id: instanceId,
      logical_workspace_id: logicalId,
      revision: current.revision,
      content,
      token_estimate: tokenEstimate,
    }),
  })
}

function serializeRecallPack(
  current: ValidatedCurrentWorkspaceContext,
  hints: readonly GraphHint[],
  omittedHints: number,
  degraded: boolean,
  budget: BlockBudget,
): string | null {
  const content = canonicalJson({
    current_logical_name: neutralizeDataString(
      'current_logical_name',
      current.logical_workspace.display_name,
    ),
    logical_workspace_id: neutralizeDataString(
      'logical_workspace_id',
      current.logical_workspace.logical_workspace_id,
    ),
  })
  return serializeValidatedBlock({
    minimumTokens: RECALL_PACK_RESERVED_TOKENS,
    maximumSchemaTokens: GRAPH_CONTEXT_RECALL_MAX_TOKENS,
    budget,
    opening: WORKSPACE_HINTS_OPEN,
    closing: WORKSPACE_HINTS_CLOSE,
    build: tokenEstimate => RecallPackSchema.safeParse({
      session_epoch: current.session_epoch,
      workspace_instance_id: neutralizeDataString(
        'workspace_instance_id',
        current.workspace_instance.instance_id,
      ),
      revision: current.revision,
      content,
      token_estimate: tokenEstimate,
      hints,
      omitted_hints: omittedHints,
      degraded,
    }),
  })
}

function serializeValidatedBlock(options: {
  readonly minimumTokens: number
  readonly maximumSchemaTokens: number
  readonly budget: BlockBudget
  readonly opening: string
  readonly closing: string
  readonly build: (tokenEstimate: number) => {
    readonly success: boolean
    readonly data?: unknown
  }
}): string | null {
  let tokenEstimate = options.minimumTokens
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (tokenEstimate > options.maximumSchemaTokens || tokenEstimate > options.budget.maxTokens) {
      return null
    }
    const parsed = options.build(tokenEstimate)
    if (!parsed.success || parsed.data === undefined) return null
    const block = `${options.opening}${canonicalJson(parsed.data)}${options.closing}`
    const measured = estimateGraphContextTokens(block)
    const nextEstimate = Math.max(options.minimumTokens, measured)
    if (nextEstimate !== tokenEstimate) {
      tokenEstimate = nextEstimate
      continue
    }
    return fitsBlock(block, options.budget) ? block : null
  }
  return null
}

function fitsBlock(block: string, budget: BlockBudget): boolean {
  return estimateGraphContextTokens(block) <= budget.maxTokens
    && codePointLengthLikePython(block) <= budget.maxCodePoints
    && Buffer.byteLength(block, 'utf8') <= budget.maxBytes
}

function sanitizeHint(input: GraphHint): GraphHint | null {
  if (input.relation_status !== 'active' && input.relation_status !== 'weak') return null
  const evidence = [...input.evidence_refs].sort(compareEvidence)[0]
  if (evidence === undefined) throw new TypeError()
  const parsed = GraphHintSchema.safeParse({
    hint_id: neutralizeDataString('hint_id', input.hint_id),
    logical_workspace_id: neutralizeDataString(
      'hint_logical_workspace_id',
      input.logical_workspace_id,
    ),
    relation_type: neutralizeDataString('relation_type', input.relation_type),
    relation_status: neutralizeDataString('relation_status', input.relation_status),
    confidence: input.confidence,
    reason: neutralizeDataString('reason', input.reason),
    evidence_refs: [{
      source: neutralizeDataString('evidence_source', evidence.source),
      ref: neutralizeDataString('evidence_ref', evidence.ref),
      observed_at: evidence.observed_at,
    }],
    revision: input.revision,
  })
  return parsed.success ? deepFreeze(parsed.data) : null
}

function compareEvidence(left: EvidenceRef, right: EvidenceRef): number {
  return right.observed_at - left.observed_at
    || compareCodePoints(left.source, right.source)
    || compareCodePoints(left.ref, right.ref)
}

function uniqueHintsById(hints: readonly GraphHint[]): GraphHint[] {
  const seen = new Set<string>()
  const unique: GraphHint[] = []
  for (const hint of hints) {
    if (seen.has(hint.hint_id)) continue
    seen.add(hint.hint_id)
    unique.push(hint)
  }
  return unique
}

function safeBranch(value: string | null): string | null {
  if (value === null || !isWellFormed(value)) return null
  const normalized = normalizeNfkcPinned(value)
  const pathResult = pathPolicy.scrubText('branch', normalized)
  if (pathResult.kind !== 'clean') return null
  const contentResult = contentPolicy.scrub('branch', normalized)
  if (contentResult.kind !== 'clean') return null
  return neutralizeStructure(normalized)
}

function neutralizeDataString(field: string, value: string): string {
  if (!isWellFormed(value)) return '［redacted］'
  let safe = normalizeNfkcPinned(value)
  if (field === 'evidence_ref' && /[\\/]/u.test(safe)) {
    safe = '[redacted]'
  } else if (field.endsWith('_ref') && /^(?:[A-Za-z]:[\\/]|\/)/u.test(safe)) {
    safe = '[redacted]'
  } else {
    const pathResult = pathPolicy.scrubText(field, safe)
    safe = pathResult.kind === 'clean'
      ? safe
      : pathResult.kind === 'redacted'
        ? pathResult.value
        : '[redacted]'
    const contentResult = contentPolicy.scrub(field, safe)
    safe = contentResult.kind === 'clean'
      ? safe
      : contentResult.kind === 'redacted'
        ? contentResult.value
        : '[redacted]'
  }
  return neutralizeStructure(safe)
}

function neutralizeStructure(value: string): string {
  const collapsed = stripLikePython(collapsePythonWhitespace(value))
  let output = ''
  for (const character of collapsed) {
    const codePoint = character.codePointAt(0)!
    if (isOtherCategory(codePoint)) {
      output += '�'
      continue
    }
    output += STRUCTURAL_REPLACEMENTS[character] ?? character
  }
  return output === '' ? '［empty］' : output
}

const STRUCTURAL_REPLACEMENTS: Readonly<Record<string, string>> = Object.freeze({
  '<': '‹',
  '>': '›',
  '`': 'ˋ',
  '#': '＃',
  '*': '＊',
  '[': '［',
  ']': '］',
  '{': '｛',
  '}': '｝',
  '|': '│',
})

function projectHintInput(input: unknown): GraphHint | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new TypeError()
  const candidate = input as Record<string, unknown>
  const hintId = candidate.hint_id
  const logicalWorkspaceId = candidate.logical_workspace_id
  const relationType = candidate.relation_type
  const relationStatus = candidate.relation_status
  const confidence = candidate.confidence
  const reason = candidate.reason
  const evidenceInput = candidate.evidence_refs
  const revision = candidate.revision
  if (!Array.isArray(evidenceInput)) throw new TypeError()
  const evidenceCount = evidenceInput.length
  if (!Number.isSafeInteger(evidenceCount) || evidenceCount < 0) throw new TypeError()
  if (
    evidenceCount > MAX_HINT_EVIDENCE_REFS
    || exceedsRecallProjection(hintId)
    || exceedsRecallProjection(logicalWorkspaceId)
    || exceedsRecallProjection(relationType)
    || exceedsRecallProjection(relationStatus)
    || exceedsRecallProjection(reason)
  ) return null
  const evidence: unknown[] = []
  for (let index = 0; index < evidenceCount; index += 1) {
    const item = evidenceInput[index] as unknown
    if (
      typeof item !== 'object'
      || item === null
      || Array.isArray(item)
    ) throw new TypeError()
    const record = item as Record<string, unknown>
    const source = record.source
    const ref = record.ref
    const observedAt = record.observed_at
    if (exceedsRecallProjection(source) || exceedsRecallProjection(ref)) return null
    evidence.push({source, ref, observed_at: observedAt})
  }
  const parsed = GraphHintSchema.parse({
    hint_id: hintId,
    logical_workspace_id: logicalWorkspaceId,
    relation_type: relationType,
    relation_status: relationStatus,
    confidence,
    reason,
    evidence_refs: evidence,
    revision,
  })
  return sanitizeHint(parsed)
}

function boundedString(value: unknown, maxCodeUnits: number): value is string {
  return typeof value === 'string' && value.length <= maxCodeUnits
}

function exceedsHeaderProjection(value: unknown): boolean {
  return typeof value === 'string' && value.length > MAX_HEADER_PROJECTABLE_CODE_UNITS
}

function exceedsRecallProjection(value: unknown): boolean {
  return typeof value === 'string' && value.length > MAX_RECALL_PROJECTABLE_CODE_UNITS
}

interface ParsedContextHeaderBlock {
  readonly header: z.infer<typeof ContextHeaderSchema>
  readonly content: z.infer<typeof contextHeaderContentSchema>
}

interface ParsedRecallPackBlock {
  readonly pack: z.infer<typeof RecallPackSchema>
  readonly content: z.infer<typeof recallPackContentSchema>
}

function parseContextHeaderBlock(value: unknown): ParsedContextHeaderBlock | null {
  if (value === null) return null
  if (typeof value !== 'string') return null
  const body = exactBlockBody(
    value,
    WORKSPACE_CONTEXT_OPEN,
    WORKSPACE_CONTEXT_CLOSE,
    GRAPH_CONTEXT_HEADER_MAX_TOKENS,
    GRAPH_CONTEXT_HEADER_MAX_CODE_POINTS,
    GRAPH_CONTEXT_HEADER_MAX_UTF8_BYTES,
  )
  if (body === null) return null
  const parsed = parseCanonicalSchema(body, ContextHeaderSchema)
  if (parsed === null) return null
  if (parsed.token_estimate !== Math.max(
    CONTEXT_HEADER_RESERVED_TOKENS,
    estimateGraphContextTokens(value),
  )) return null
  if (
    neutralizeDataString('workspace_instance_id', parsed.workspace_instance_id)
      !== parsed.workspace_instance_id
    || neutralizeDataString('logical_workspace_id', parsed.logical_workspace_id)
      !== parsed.logical_workspace_id
  ) return null
  const content = parseCanonicalSchema(parsed.content, contextHeaderContentSchema)
  if (content === null) return null
  if (
    neutralizeDataString('current_instance_name', content.current_instance_name)
      !== content.current_instance_name
    || neutralizeDataString('current_logical_name', content.current_logical_name)
      !== content.current_logical_name
    || content.preferences.some(preference => (
      neutralizeDataString('preference', preference) !== preference
    ))
    || (content.branch !== undefined && safeBranch(content.branch) !== content.branch)
  ) return null
  return {header: parsed, content}
}

function parseRecallPackBlock(value: unknown): ParsedRecallPackBlock | null {
  if (value === null) return null
  if (typeof value !== 'string') return null
  const body = exactBlockBody(
    value,
    WORKSPACE_HINTS_OPEN,
    WORKSPACE_HINTS_CLOSE,
    GRAPH_CONTEXT_RECALL_MAX_TOKENS,
    GRAPH_CONTEXT_RECALL_MAX_CODE_POINTS,
    GRAPH_CONTEXT_RECALL_MAX_UTF8_BYTES,
  )
  if (body === null) return null
  const parsed = parseCanonicalSchema(body, RecallPackSchema)
  if (parsed === null || parsed.hints.length === 0) return null
  if (parsed.token_estimate !== Math.max(
    RECALL_PACK_RESERVED_TOKENS,
    estimateGraphContextTokens(value),
  )) return null
  if (
    neutralizeDataString('workspace_instance_id', parsed.workspace_instance_id)
      !== parsed.workspace_instance_id
    || new Set(parsed.hints.map(hint => hint.hint_id)).size !== parsed.hints.length
    || parsed.hints.some(hint => {
      const sanitized = sanitizeHint(hint)
      return sanitized === null || canonicalJson(sanitized) !== canonicalJson(hint)
    })
  ) return null
  const content = parseCanonicalSchema(parsed.content, recallPackContentSchema)
  if (content === null) return null
  if (
    neutralizeDataString('current_logical_name', content.current_logical_name)
      !== content.current_logical_name
    || neutralizeDataString('logical_workspace_id', content.logical_workspace_id)
      !== content.logical_workspace_id
  ) return null
  return {pack: parsed, content}
}

function exactBlockBody(
  value: unknown,
  opening: string,
  closing: string,
  maxTokens: number,
  maxCodePoints: number,
  maxBytes: number,
): string | null {
  if (
    typeof value !== 'string'
    || value.length > Math.min(maxBytes, maxCodePoints * 2)
    || !isWellFormed(value)
    || !value.startsWith(opening)
    || !value.endsWith(closing)
    || estimateGraphContextTokens(value) > maxTokens
    || codePointLengthLikePython(value) > maxCodePoints
    || Buffer.byteLength(value, 'utf8') > maxBytes
  ) return null
  const body = value.slice(opening.length, -closing.length)
  return body.includes('<') || body.includes('>') ? null : body
}

function parseCanonicalSchema<Schema extends z.ZodType>(
  value: string,
  schema: Schema,
): z.infer<Schema> | null {
  let decoded: unknown
  try {
    decoded = JSON.parse(value) as unknown
  } catch {
    return null
  }
  const parsed = schema.safeParse(decoded)
  if (!parsed.success || canonicalJson(parsed.data) !== value) return null
  return parsed.data
}

function freezeGraphContext(value: GraphContext): GraphContext {
  return Object.freeze({...value})
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}
