import {resolve} from 'node:path'
import {CodexProtocolError} from './codex-protocol.js'
import {snapshotJsonRecord} from './codex-safe-json.js'

export interface MethodSchemaSpec {
  readonly file: string
  readonly fields: Readonly<Record<string, string>>
  readonly required: readonly string[]
  readonly nullable?: readonly string[]
  readonly allowedTypes?: Readonly<Record<string, readonly string[]>>
}

export interface InboundSchemaSpec extends MethodSchemaSpec {
  readonly nested?: {
    readonly field: string
    readonly fields: Readonly<Record<string, string>>
    readonly required: readonly string[]
  }
}

function method(
  file: string,
  fields: Readonly<Record<string, string>>,
  required: readonly string[],
  nullable: readonly string[] = [],
  allowedTypes: Readonly<Record<string, readonly string[]>> = {},
): MethodSchemaSpec {
  return deepFreeze({
    file,
    fields: {...fields},
    required: [...required],
    ...(nullable.length === 0 ? {} : {nullable: [...nullable]}),
    ...(Object.keys(allowedTypes).length === 0 ? {} : {allowedTypes}),
  })
}

export const APP_SERVER_METHOD_SCHEMAS: Readonly<Record<string, MethodSchemaSpec>> = deepFreeze({
  initialize: method('v1/InitializeParams.json', {clientInfo: 'object'}, ['clientInfo']),
  'config/read': method(
    'v2/ConfigReadParams.json',
    {includeLayers: 'boolean', cwd: 'string'},
    [],
    ['cwd'],
  ),
  'thread/start': method('v2/ThreadStartParams.json', {
    ephemeral: 'boolean',
    approvalPolicy: 'string',
    developerInstructions: 'string',
    cwd: 'string',
  }, [], ['ephemeral', 'approvalPolicy', 'developerInstructions', 'cwd'], {
    approvalPolicy: ['string', 'object', 'null'],
  }),
  'thread/resume': method('v2/ThreadResumeParams.json', {
    threadId: 'string',
    approvalPolicy: 'string',
    developerInstructions: 'string',
    cwd: 'string',
  }, ['threadId'], ['approvalPolicy', 'developerInstructions', 'cwd'], {
    approvalPolicy: ['string', 'object', 'null'],
  }),
  'turn/start': method('v2/TurnStartParams.json', {threadId: 'string', input: 'array'}, [
    'threadId', 'input',
  ]),
  'turn/steer': method('v2/TurnSteerParams.json', {
    threadId: 'string', expectedTurnId: 'string', input: 'array',
  }, ['threadId', 'expectedTurnId', 'input']),
  'turn/interrupt': method('v2/TurnInterruptParams.json', {
    threadId: 'string', turnId: 'string',
  }, ['threadId', 'turnId']),
})

const THREAD_NESTED = deepFreeze({
  field: 'thread',
  fields: {id: 'string', cwd: 'string', ephemeral: 'boolean', path: 'string'},
  required: ['id', 'cwd', 'ephemeral'],
})
const TURN_NESTED = deepFreeze({
  field: 'turn',
  fields: {id: 'string', items: 'array', status: 'string'},
  required: ['id', 'items', 'status'],
})

export const APP_SERVER_INBOUND_SCHEMAS: readonly InboundSchemaSpec[] = deepFreeze([
  method('v2/ConfigReadResponse.json', {config: 'object', origins: 'object'}, ['config', 'origins']),
  {...method('v2/ThreadStartResponse.json', {
    approvalPolicy: 'string', cwd: 'string', sandbox: 'object', thread: 'object',
  }, ['approvalPolicy', 'cwd', 'sandbox', 'thread'], [], {
    approvalPolicy: ['string', 'object'],
  }), nested: THREAD_NESTED},
  {...method('v2/ThreadResumeResponse.json', {
    approvalPolicy: 'string',
    cwd: 'string',
    sandbox: 'object',
    thread: 'object',
  }, ['approvalPolicy', 'cwd', 'sandbox', 'thread'], [], {
    approvalPolicy: ['string', 'object'],
  }), nested: THREAD_NESTED},
  {...method('v2/TurnStartResponse.json', {turn: 'object'}, ['turn']), nested: TURN_NESTED},
  method('v2/TurnSteerResponse.json', {turnId: 'string'}, ['turnId']),
  {...method('v2/TurnStartedNotification.json', {
    threadId: 'string', turn: 'object',
  }, ['threadId', 'turn']), nested: TURN_NESTED},
  method('v2/ItemStartedNotification.json', {
    threadId: 'string', turnId: 'string', startedAtMs: 'integer', item: 'object',
  }, ['threadId', 'turnId', 'startedAtMs', 'item']),
  method('v2/ItemCompletedNotification.json', {
    threadId: 'string', turnId: 'string', item: 'object',
  }, ['threadId', 'turnId', 'item']),
  {...method('v2/TurnCompletedNotification.json', {
    threadId: 'string', turn: 'object',
  }, ['threadId', 'turn']), nested: TURN_NESTED},
])

export const APP_SERVER_APPROVAL_SCHEMA_FILES: readonly string[] = deepFreeze([
  'ServerRequest.json',
  'FileChangeRequestApprovalParams.json',
  'CommandExecutionRequestApprovalParams.json',
  'FileChangeRequestApprovalResponse.json',
  'CommandExecutionRequestApprovalResponse.json',
])

const FILE_APPROVAL_PARAM_FIELDS = deepFreeze({
  grantRoot: 'string',
  itemId: 'string',
  reason: 'string',
  startedAtMs: 'integer',
  threadId: 'string',
  turnId: 'string',
})
const FILE_APPROVAL_PARAM_TYPES = deepFreeze({
  grantRoot: ['string', 'null'],
  reason: ['string', 'null'],
})
const COMMAND_APPROVAL_PARAM_FIELDS = deepFreeze({
  approvalId: 'string',
  command: 'string',
  commandActions: 'array',
  cwd: 'string',
  environmentId: 'string',
  itemId: 'string',
  networkApprovalContext: 'object',
  proposedExecpolicyAmendment: 'array',
  proposedNetworkPolicyAmendments: 'array',
  reason: 'string',
  startedAtMs: 'integer',
  threadId: 'string',
  turnId: 'string',
})
const COMMAND_APPROVAL_PARAM_TYPES = deepFreeze({
  approvalId: ['string', 'null'],
  command: ['string', 'null'],
  commandActions: ['array', 'null'],
  cwd: ['string', 'null'],
  environmentId: ['string', 'null'],
  networkApprovalContext: ['object', 'null'],
  proposedExecpolicyAmendment: ['array', 'null'],
  proposedNetworkPolicyAmendments: ['array', 'null'],
  reason: ['string', 'null'],
})
const APPROVAL_REQUIRED = deepFreeze(['itemId', 'startedAtMs', 'threadId', 'turnId'])

export function validateCodexSchemaBundle(
  bundle: Readonly<Record<string, unknown>>,
): Readonly<Record<string, true>> {
  try {
    const bundleSnapshot = snapshotJsonRecord(bundle)
    const client = requireObject(bundleSnapshot['ClientRequest.json'])
    const variants = client.oneOf
    if (!Array.isArray(variants)) throw new TypeError('variants')
    const requests = new Map<string, Record<string, unknown>>()
    for (const candidate of variants) {
      if (!isPlainObject(candidate)) continue
      const properties = candidate.properties
      if (!isPlainObject(properties)) continue
      const methodSchema = properties.method
      if (!isPlainObject(methodSchema) || !Array.isArray(methodSchema.enum)) continue
      if (methodSchema.enum.length !== 1 || typeof methodSchema.enum[0] !== 'string') continue
      requests.set(methodSchema.enum[0], candidate)
    }
    const result: Record<string, true> = {}
    for (const [name, spec] of Object.entries(APP_SERVER_METHOD_SCHEMAS)) {
      const variant = requests.get(name)
      if (variant === undefined) throw new TypeError('missing method')
      requireFields(variant, ['id', 'method', 'params'])
      const properties = requireObject(variant.properties)
      const params = requireObject(properties.params)
      const stem = spec.file.slice(spec.file.lastIndexOf('/') + 1, -'.json'.length)
      if (params.$ref !== `#/definitions/${stem}`) throw new TypeError('request reference')
      validateObjectSchema(
        bundleSnapshot[spec.file], spec.fields, spec.required, undefined, spec.nullable,
        spec.allowedTypes,
      )
      result[name] = true
    }
    for (const spec of APP_SERVER_INBOUND_SCHEMAS) {
      const root = requireObject(bundleSnapshot[spec.file])
      validateObjectSchema(
        root, spec.fields, spec.required, undefined, spec.nullable, spec.allowedTypes,
      )
      if (spec.nested !== undefined) {
        const properties = requireObject(root.properties)
        const target = resolveLocalSchema(requireObject(properties[spec.nested.field]), root, new Set())
        validateObjectSchema(target, spec.nested.fields, spec.nested.required, root)
      }
    }
    validateApprovalSchemaSurface(bundleSnapshot)
    return deepFreeze(result)
  } catch {
    throw new CodexProtocolError('unsupported_protocol')
  }
}

function validateApprovalSchemaSurface(bundle: Readonly<Record<string, unknown>>): void {
  const serverRequest = requireObject(bundle['ServerRequest.json'])
  validateApprovalServerRequest(serverRequest)
  validateFileApprovalParams(
    requireObject(bundle['FileChangeRequestApprovalParams.json']),
  )
  validateCommandApprovalParams(
    requireObject(bundle['CommandExecutionRequestApprovalParams.json']),
  )
  validateFileChangeItem(requireObject(bundle['v2/ItemStartedNotification.json']))
  validateDecisionResponse(
    requireObject(bundle['FileChangeRequestApprovalResponse.json']),
    'FileChangeApprovalDecision',
    ['accept', 'acceptForSession', 'decline', 'cancel'],
    [],
  )
  validateDecisionResponse(
    requireObject(bundle['CommandExecutionRequestApprovalResponse.json']),
    'CommandExecutionApprovalDecision',
    ['accept', 'acceptForSession', 'decline', 'cancel'],
    ['acceptWithExecpolicyAmendment', 'applyNetworkPolicyAmendment'],
  )
}

function validateApprovalServerRequest(root: Record<string, unknown>): void {
  const variants = root.oneOf
  if (!Array.isArray(variants)) throw new TypeError('server request variants')
  for (const [methodName, paramsName] of [
    ['item/fileChange/requestApproval', 'FileChangeRequestApprovalParams'],
    ['item/commandExecution/requestApproval', 'CommandExecutionRequestApprovalParams'],
  ] as const) {
    const matches = variants.filter(candidate => approvalMethod(candidate) === methodName)
    if (matches.length !== 1) throw new TypeError('approval method')
    const variant = requireObject(matches[0])
    validateExactObjectSchema(
      variant,
      {id: 'integer', method: 'string', params: 'object'},
      ['id', 'method', 'params'],
      root,
      {id: ['string', 'integer']},
    )
    const properties = requireObject(variant.properties)
    requireReference(requireObject(properties.id), '#/definitions/RequestId')
    requireSingleEnum(requireObject(properties.method), methodName)
    requireReference(requireObject(properties.params), `#/definitions/${paramsName}`)
  }
  const definitions = requireObject(root.definitions)
  const requestId = requireObject(definitions.RequestId)
  requireTypes(requestId, root, ['string', 'integer'])
  validateFileApprovalParams(requireObject(definitions.FileChangeRequestApprovalParams), root)
  validateCommandApprovalParams(
    requireObject(definitions.CommandExecutionRequestApprovalParams), root,
  )
}

function validateFileApprovalParams(
  schema: Record<string, unknown>,
  root: Record<string, unknown> = schema,
): void {
  validateExactObjectSchema(
    schema,
    FILE_APPROVAL_PARAM_FIELDS,
    APPROVAL_REQUIRED,
    root,
    FILE_APPROVAL_PARAM_TYPES,
  )
}

function validateCommandApprovalParams(
  schema: Record<string, unknown>,
  root: Record<string, unknown> = schema,
): void {
  validateExactObjectSchema(
    schema,
    COMMAND_APPROVAL_PARAM_FIELDS,
    APPROVAL_REQUIRED,
    root,
    COMMAND_APPROVAL_PARAM_TYPES,
  )
  const properties = requireObject(schema.properties)
  requireArrayItemReference(properties.commandActions, '#/definitions/CommandAction')
  requireNullableReference(properties.cwd, '#/definitions/LegacyAppPathString')
  requireNullableReference(
    properties.networkApprovalContext,
    '#/definitions/NetworkApprovalContext',
  )
  requireArrayItemType(properties.proposedExecpolicyAmendment, 'string')
  requireArrayItemReference(
    properties.proposedNetworkPolicyAmendments,
    '#/definitions/NetworkPolicyAmendment',
  )
}

function validateFileChangeItem(root: Record<string, unknown>): void {
  const properties = requireObject(root.properties)
  requireReference(requireObject(properties.item), '#/definitions/ThreadItem')
  const definitions = requireObject(root.definitions)
  const threadItem = requireObject(definitions.ThreadItem)
  const choices = threadItem.oneOf
  if (!Array.isArray(choices)) throw new TypeError('thread item choices')
  const matches = choices.filter(candidate => {
    if (!isPlainObject(candidate) || !isPlainObject(candidate.properties)) return false
    return enumValue(candidate.properties.type) === 'fileChange'
  })
  if (matches.length !== 1) throw new TypeError('file change item')
  const fileChange = requireObject(matches[0])
  validateExactObjectSchema(
    fileChange,
    {changes: 'array', id: 'string', status: 'string', type: 'string'},
    ['changes', 'id', 'status', 'type'],
    root,
  )
  const itemProperties = requireObject(fileChange.properties)
  requireArrayItemReference(itemProperties.changes, '#/definitions/FileUpdateChange')
  requireReference(requireObject(itemProperties.status), '#/definitions/PatchApplyStatus')
  requireSingleEnum(requireObject(itemProperties.type), 'fileChange')

  const update = requireObject(definitions.FileUpdateChange)
  validateExactObjectSchema(
    update,
    {diff: 'string', kind: 'object', path: 'string'},
    ['diff', 'kind', 'path'],
    root,
  )
  requireReference(
    requireObject(requireObject(update.properties).kind),
    '#/definitions/PatchChangeKind',
  )
  const status = requireObject(definitions.PatchApplyStatus)
  requireTypes(status, root, ['string'])
  requireExactEnum(status.enum, ['inProgress', 'completed', 'failed', 'declined'])
  validatePatchChangeKind(requireObject(definitions.PatchChangeKind), root)
}

function validatePatchChangeKind(
  schema: Record<string, unknown>,
  root: Record<string, unknown>,
): void {
  const choices = schema.oneOf
  if (!Array.isArray(choices) || choices.length !== 3) throw new TypeError('patch choices')
  for (const kind of ['add', 'delete', 'update'] as const) {
    const matches = choices.filter(candidate => {
      if (!isPlainObject(candidate) || !isPlainObject(candidate.properties)) return false
      return enumValue(candidate.properties.type) === kind
    })
    if (matches.length !== 1) throw new TypeError('patch kind')
    const choice = requireObject(matches[0])
    validateExactObjectSchema(
      choice,
      kind === 'update' ? {move_path: 'string', type: 'string'} : {type: 'string'},
      ['type'],
      root,
      kind === 'update' ? {move_path: ['string', 'null']} : {},
    )
    requireSingleEnum(requireObject(requireObject(choice.properties).type), kind)
  }
}

function validateDecisionResponse(
  root: Record<string, unknown>,
  definitionName: string,
  stringDecisions: readonly string[],
  objectDecisions: readonly string[],
): void {
  validateExactObjectSchema(
    root,
    {decision: 'string'},
    ['decision'],
    root,
    objectDecisions.length === 0 ? {} : {decision: ['string', 'object']},
  )
  const decisionField = requireObject(requireObject(root.properties).decision)
  requireReference(decisionField, `#/definitions/${definitionName}`)
  const definition = requireObject(requireObject(root.definitions)[definitionName])
  const choices = definition.oneOf
  if (!Array.isArray(choices)
    || choices.length !== stringDecisions.length + objectDecisions.length) {
    throw new TypeError('decision choices')
  }
  const foundStrings: string[] = []
  const foundObjects: string[] = []
  for (const candidate of choices) {
    const choice = requireObject(candidate)
    if (choice.type === 'string') {
      const value = enumValue(choice)
      if (value === null) throw new TypeError('decision enum')
      foundStrings.push(value)
      continue
    }
    if (choice.type !== 'object') throw new TypeError('decision type')
    const properties = requireObject(choice.properties)
    const keys = Object.keys(properties)
    if (keys.length !== 1 || choice.additionalProperties !== false) {
      throw new TypeError('object decision')
    }
    validateExactObjectSchema(choice, {[keys[0]!]: 'object'}, [keys[0]!], root)
    foundObjects.push(keys[0]!)
  }
  requireExactEnum(foundStrings, stringDecisions)
  requireExactEnum(foundObjects, objectDecisions)
}

function approvalMethod(candidate: unknown): string | null {
  if (!isPlainObject(candidate) || !isPlainObject(candidate.properties)) return null
  return enumValue(candidate.properties.method)
}

function enumValue(candidate: unknown): string | null {
  if (!isPlainObject(candidate) || candidate.type !== 'string') return null
  return Array.isArray(candidate.enum)
    && candidate.enum.length === 1
    && typeof candidate.enum[0] === 'string'
    ? candidate.enum[0]
    : null
}

function validateExactObjectSchema(
  candidate: unknown,
  fields: Readonly<Record<string, string>>,
  required: readonly string[],
  typeRoot?: Record<string, unknown>,
  allowedTypes: Readonly<Record<string, readonly string[]>> = {},
): void {
  validateObjectSchema(candidate, fields, required, typeRoot, [], allowedTypes)
  const schema = requireObject(candidate)
  if (!exactKeys(requireObject(schema.properties), Object.keys(fields))) {
    throw new TypeError('exact properties')
  }
  requireExactEnum(schema.required, required)
}

function requireTypes(
  node: Record<string, unknown>,
  root: Record<string, unknown>,
  expected: readonly string[],
): void {
  const found = schemaTypes(node, root, new Set())
  if (found.size !== expected.length || expected.some(type => !found.has(type))) {
    throw new TypeError('exact types')
  }
}

function requireReference(node: Record<string, unknown>, expected: string): void {
  if (node.$ref !== expected) throw new TypeError('exact reference')
}

function requireNullableReference(candidate: unknown, reference: string): void {
  const choices = requireObject(candidate).anyOf
  if (!Array.isArray(choices) || choices.length !== 2) throw new TypeError('nullable reference')
  const references = choices.filter(choice => isPlainObject(choice) && choice.$ref === reference)
  const nulls = choices.filter(choice => isPlainObject(choice) && choice.type === 'null')
  if (references.length !== 1 || nulls.length !== 1) throw new TypeError('nullable reference')
}

function requireArrayItemReference(candidate: unknown, reference: string): void {
  const items = requireObject(requireObject(candidate).items)
  requireReference(items, reference)
}

function requireArrayItemType(candidate: unknown, type: string): void {
  const items = requireObject(requireObject(candidate).items)
  if (items.type !== type) throw new TypeError('array item type')
}

function requireSingleEnum(node: Record<string, unknown>, expected: string): void {
  if (node.type !== 'string') throw new TypeError('enum type')
  requireExactEnum(node.enum, [expected])
}

function requireExactEnum(candidate: unknown, expected: readonly string[]): void {
  if (!Array.isArray(candidate)
    || candidate.length !== expected.length
    || candidate.some(value => typeof value !== 'string')) throw new TypeError('exact enum')
  const found = new Set(candidate)
  if (found.size !== expected.length || expected.some(value => !found.has(value))) {
    throw new TypeError('exact enum')
  }
}

function validateObjectSchema(
  candidate: unknown,
  fields: Readonly<Record<string, string>>,
  required: readonly string[],
  typeRoot?: Record<string, unknown>,
  nullable: readonly string[] = [],
  allowedTypes: Readonly<Record<string, readonly string[]>> = {},
): void {
  const schema = requireObject(candidate)
  if (schema.type !== 'object') throw new TypeError('object type')
  requireFields(schema, required)
  const properties = requireObject(schema.properties)
  const root = typeRoot ?? schema
  const nullableFields = new Set(nullable)
  if (nullable.some(field => !Object.hasOwn(fields, field))) throw new TypeError('nullable field')
  if (Object.keys(allowedTypes).some(field => !Object.hasOwn(fields, field))) {
    throw new TypeError('allowed type field')
  }
  for (const [field, expected] of Object.entries(fields)) {
    const types = schemaTypes(requireObject(properties[field]), root, new Set())
    const explicitlyAllowed = allowedTypes[field]
    if (explicitlyAllowed !== undefined) {
      const wanted = new Set(explicitlyAllowed)
      if (wanted.size !== explicitlyAllowed.length
        || types.size !== wanted.size
        || [...wanted].some(type => !types.has(type))) throw new TypeError('field type')
      continue
    }
    const permitsNullable = (field === 'path' || nullableFields.has(field))
      && types.size === 2
      && types.has(expected)
      && types.has('null')
    if (!(types.size === 1 && types.has(expected)) && !permitsNullable) {
      throw new TypeError('field type')
    }
  }
}

function requireFields(schema: Record<string, unknown>, wanted: readonly string[]): void {
  const required = schema.required ?? []
  if (!Array.isArray(required) || required.some(value => typeof value !== 'string')) {
    throw new TypeError('required')
  }
  const found = new Set(required)
  if (wanted.some(field => !found.has(field))) throw new TypeError('missing required')
}

function schemaTypes(
  node: Record<string, unknown>,
  root: Record<string, unknown>,
  stack: Set<string>,
): Set<string> {
  const found = new Set<string>()
  if (typeof node.type === 'string') found.add(node.type)
  else if (Array.isArray(node.type)) {
    for (const item of node.type) {
      if (typeof item !== 'string') throw new TypeError('type')
      found.add(item)
    }
  }
  if (node.$ref !== undefined) {
    const reference = requireLocalReference(node.$ref)
    if (stack.has(reference)) throw new TypeError('recursive')
    const next = new Set(stack)
    next.add(reference)
    const target = localReferenceTarget(reference, root)
    for (const type of schemaTypes(target, root, next)) found.add(type)
  }
  for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
    const choices = node[keyword]
    if (choices === undefined) continue
    if (!Array.isArray(choices) || choices.length === 0) throw new TypeError('choice')
    for (const choice of choices) {
      for (const type of schemaTypes(requireObject(choice), root, new Set(stack))) found.add(type)
    }
  }
  if (found.size === 0) throw new TypeError('missing type')
  return found
}

function resolveLocalSchema(
  node: Record<string, unknown>,
  root: Record<string, unknown>,
  stack: Set<string>,
): Record<string, unknown> {
  const reference = requireLocalReference(node.$ref)
  if (stack.has(reference)) throw new TypeError('recursive')
  stack.add(reference)
  const target = localReferenceTarget(reference, root)
  return target.$ref === undefined ? target : resolveLocalSchema(target, root, stack)
}

function requireLocalReference(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('#/definitions/')) {
    throw new TypeError('reference')
  }
  const name = value.slice('#/definitions/'.length)
  if (name === '' || name.includes('/')) throw new TypeError('reference')
  return value
}

function localReferenceTarget(reference: string, root: Record<string, unknown>): Record<string, unknown> {
  const definitions = requireObject(root.definitions)
  const name = reference.slice('#/definitions/'.length)
  return requireObject(definitions[name])
}

export interface EffectiveCodexConfigReport {
  readonly default_permissions: 'nova_audio_agent'
  readonly filesystem: 'workspace_only'
  readonly network: 'blocked'
  readonly web_search: 'disabled'
  readonly shell_environment: 'core_include_only'
  readonly extensions: 'disabled'
  readonly mcp: 'empty'
  readonly instructions: 'builtin' | 'replacement'
}

const ROOTS = deepFreeze({
  '.': 'write', '.git': 'read', '.agents': 'read', '.codex': 'read',
})
const DISABLED_FEATURES = deepFreeze([
  'hooks',
  'apps',
  'multi_agent',
  'plugins',
  'remote_plugin',
  'plugin_sharing',
  'tool_suggest',
  'remote_control',
])
const SAFE_OPTIONAL_FEATURES: ReadonlySet<string> = new Set([
  'auth_elicitation',
  'mentions_v2',
])

export function validateEffectiveCodexConfig(
  response: unknown,
  workspace: string,
  options: {readonly allowReplacementInstructions: boolean},
): EffectiveCodexConfigReport {
  try {
    const envelope = snapshotJsonRecord(response)
    if (truthy(envelope.warnings) || truthy(envelope.requirements)) throw new TypeError('diagnostic')
    const config = requireObject(envelope.config)
    if (config.default_permissions !== 'nova_audio_agent') throw new TypeError('permissions')
    if (config.web_search !== 'disabled') throw new TypeError('web')
    if (config.cwd !== undefined && (
      typeof config.cwd !== 'string' || resolve(config.cwd) !== resolve(workspace)
    )) throw new TypeError('cwd')
    const permissions = requireObject(config.permissions)
    if (!exactKeys(permissions, ['nova_audio_agent'])) throw new TypeError('permission profiles')
    const profile = requireObject(permissions.nova_audio_agent)
    if (!requiredKeysWithNullExtras(profile, ['filesystem', 'network'])) throw new TypeError('profile')
    const filesystem = requireObject(profile.filesystem)
    if (!requiredKeysWithNullExtras(filesystem, [':root', ':workspace_roots'])) {
      throw new TypeError('filesystem')
    }
    if (filesystem[':root'] !== 'read') throw new TypeError('root')
    const roots = requireObject(filesystem[':workspace_roots'])
    if (!exactStringRecord(roots, ROOTS)) throw new TypeError('roots')
    const network = requireObject(profile.network)
    if (!requiredKeysWithNullExtras(network, ['enabled']) || network.enabled !== false) {
      throw new TypeError('network')
    }
    const shell = requireObject(config.shell_environment_policy)
    if (!requiredKeysWithNullExtras(shell, ['inherit', 'include_only'])
      || shell.inherit !== 'core' || !exactStringArray(
      shell.include_only,
      ['PATH', 'LANG', 'LC_ALL', 'TERM'],
    )) throw new TypeError('shell')
    const features = requireObject(config.features)
    for (const name of DISABLED_FEATURES) {
      if (!Object.hasOwn(features, name) || features[name] !== false) throw new TypeError('feature')
    }
    for (const [name, enabled] of Object.entries(features)) {
      if (DISABLED_FEATURES.includes(name)) continue
      if (SAFE_OPTIONAL_FEATURES.has(name)) {
        if (enabled !== true && enabled !== false && enabled !== null) throw new TypeError('feature')
      } else if (enabled !== false && enabled !== null) {
        throw new TypeError('feature')
      }
    }
    if (!isPlainObject(config.mcp_servers) || Object.keys(config.mcp_servers).length !== 0) {
      throw new TypeError('mcp')
    }
    const replacement = config.model_instructions_file
    if (!options.allowReplacementInstructions && replacement !== null && replacement !== undefined) {
      throw new TypeError('instructions')
    }
    if (options.allowReplacementInstructions
      && replacement !== null
      && replacement !== undefined
      && (typeof replacement !== 'string' || replacement === '')) throw new TypeError('instructions')
    return deepFreeze({
      default_permissions: 'nova_audio_agent',
      filesystem: 'workspace_only',
      network: 'blocked',
      web_search: 'disabled',
      shell_environment: 'core_include_only',
      extensions: 'disabled',
      mcp: 'empty',
      instructions: options.allowReplacementInstructions ? 'replacement' : 'builtin',
    })
  } catch {
    throw new CodexProtocolError('config_not_isolated')
  }
}

function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return false
  if (Array.isArray(value)) return value.length > 0
  if (isPlainObject(value)) return Object.keys(value).length > 0
  return true
}

function exactStringArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((item, index) => item === expected[index])
}

function exactStringRecord(
  value: Record<string, unknown>,
  expected: Readonly<Record<string, string>>,
): boolean {
  const keys = Object.keys(value)
  const expectedKeys = Object.keys(expected)
  return keys.length === expectedKeys.length
    && expectedKeys.every(key => Object.hasOwn(value, key) && value[key] === expected[key])
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key))
}

function requiredKeysWithNullExtras(
  value: Record<string, unknown>,
  required: readonly string[],
): boolean {
  const requiredSet = new Set(required)
  return required.every(key => Object.hasOwn(value, key))
    && Object.entries(value).every(([key, field]) => requiredSet.has(key) || field === null)
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) throw new TypeError('object')
  return value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === Object.prototype || prototype === null
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return Object.freeze(value)
}
