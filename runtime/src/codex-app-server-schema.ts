import {resolve} from 'node:path'
import {CodexProtocolError} from './codex-protocol.js'

export interface MethodSchemaSpec {
  readonly file: string
  readonly fields: Readonly<Record<string, string>>
  readonly required: readonly string[]
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
): MethodSchemaSpec {
  return deepFreeze({file, fields: {...fields}, required: [...required]})
}

export const APP_SERVER_METHOD_SCHEMAS: Readonly<Record<string, MethodSchemaSpec>> = deepFreeze({
  initialize: method('v1/InitializeParams.json', {clientInfo: 'object'}, ['clientInfo']),
  'config/read': method(
    'v2/ConfigReadParams.json',
    {includeLayers: 'boolean', cwd: 'string'},
    [],
  ),
  'thread/start': method('v2/ThreadStartParams.json', {
    ephemeral: 'boolean',
    approvalPolicy: 'string',
    developerInstructions: 'string',
    cwd: 'string',
    permissions: 'string',
    runtimeWorkspaceRoots: 'array',
  }, []),
  'thread/resume': method('v2/ThreadResumeParams.json', {
    threadId: 'string',
    excludeTurns: 'boolean',
    approvalPolicy: 'string',
    developerInstructions: 'string',
    cwd: 'string',
    permissions: 'string',
    runtimeWorkspaceRoots: 'array',
  }, ['threadId']),
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
  }, ['approvalPolicy', 'cwd', 'sandbox', 'thread']), nested: THREAD_NESTED},
  {...method('v2/ThreadResumeResponse.json', {
    approvalPolicy: 'string',
    cwd: 'string',
    runtimeWorkspaceRoots: 'array',
    sandbox: 'object',
    thread: 'object',
  }, ['approvalPolicy', 'cwd', 'runtimeWorkspaceRoots', 'sandbox', 'thread']), nested: THREAD_NESTED},
  {...method('v2/TurnStartResponse.json', {turn: 'object'}, ['turn']), nested: TURN_NESTED},
  method('v2/TurnSteerResponse.json', {turnId: 'string'}, ['turnId']),
  {...method('v2/TurnStartedNotification.json', {
    threadId: 'string', turn: 'object',
  }, ['threadId', 'turn']), nested: TURN_NESTED},
  method('v2/ItemCompletedNotification.json', {
    threadId: 'string', turnId: 'string', item: 'object',
  }, ['threadId', 'turnId', 'item']),
  {...method('v2/TurnCompletedNotification.json', {
    threadId: 'string', turn: 'object',
  }, ['threadId', 'turn']), nested: TURN_NESTED},
])

export function validateCodexSchemaBundle(
  bundle: Readonly<Record<string, unknown>>,
): Readonly<Record<string, true>> {
  try {
    if (!isPlainObject(bundle)) throw new TypeError('bundle')
    const client = requireObject(bundle['ClientRequest.json'])
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
      validateObjectSchema(bundle[spec.file], spec.fields, spec.required)
      result[name] = true
    }
    for (const spec of APP_SERVER_INBOUND_SCHEMAS) {
      const root = requireObject(bundle[spec.file])
      validateObjectSchema(root, spec.fields, spec.required)
      if (spec.nested !== undefined) {
        const properties = requireObject(root.properties)
        const target = resolveLocalSchema(requireObject(properties[spec.nested.field]), root, new Set())
        validateObjectSchema(target, spec.nested.fields, spec.nested.required, root)
      }
    }
    return deepFreeze(result)
  } catch {
    throw new CodexProtocolError('unsupported_protocol')
  }
}

function validateObjectSchema(
  candidate: unknown,
  fields: Readonly<Record<string, string>>,
  required: readonly string[],
  typeRoot?: Record<string, unknown>,
): void {
  const schema = requireObject(candidate)
  if (schema.type !== 'object') throw new TypeError('object type')
  requireFields(schema, required)
  const properties = requireObject(schema.properties)
  const root = typeRoot ?? schema
  for (const [field, expected] of Object.entries(fields)) {
    const types = schemaTypes(requireObject(properties[field]), root, new Set())
    const permitsNullablePath = field === 'path'
      && types.size === 2
      && types.has('string')
      && types.has('null')
    if (!(types.size === 1 && types.has(expected)) && !permitsNullablePath) {
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

export function validateEffectiveCodexConfig(
  response: unknown,
  workspace: string,
  options: {readonly allowReplacementInstructions: boolean},
): EffectiveCodexConfigReport {
  try {
    const envelope = requireObject(response)
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
    if (!exactKeys(profile, ['filesystem', 'network'])) throw new TypeError('profile')
    const filesystem = requireObject(profile.filesystem)
    if (!exactKeys(filesystem, [':root', ':workspace_roots'])) throw new TypeError('filesystem')
    if (filesystem[':root'] !== 'read') throw new TypeError('root')
    const roots = requireObject(filesystem[':workspace_roots'])
    if (!exactStringRecord(roots, ROOTS)) throw new TypeError('roots')
    const network = requireObject(profile.network)
    if (!exactKeys(network, ['enabled']) || network.enabled !== false) throw new TypeError('network')
    const shell = requireObject(config.shell_environment_policy)
    if (!exactKeys(shell, ['inherit', 'include_only'])
      || shell.inherit !== 'core' || !exactStringArray(
      shell.include_only,
      ['PATH', 'LANG', 'LC_ALL', 'TERM'],
    )) throw new TypeError('shell')
    const features = requireObject(config.features)
    if (!exactKeys(features, DISABLED_FEATURES)) throw new TypeError('features')
    for (const name of DISABLED_FEATURES) {
      if (features[name] !== false) throw new TypeError('feature')
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
  return keys.length === Object.keys(expected).length
    && keys.every(key => value[key] === expected[key])
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key))
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
