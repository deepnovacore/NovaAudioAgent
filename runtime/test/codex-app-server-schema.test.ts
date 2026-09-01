import assert from 'node:assert/strict'
import {test} from 'node:test'
import {
  APP_SERVER_INBOUND_SCHEMAS,
  APP_SERVER_METHOD_SCHEMAS,
  validateCodexSchemaBundle,
  validateEffectiveCodexConfig,
} from '../src/codex-app-server-schema.js'
import {CodexProtocolError} from '../src/codex-protocol.js'

type Bundle = Record<string, unknown>

const METHOD_SPECS = {
  initialize: {
    file: 'v1/InitializeParams.json', fields: {clientInfo: 'object'}, required: ['clientInfo'],
  },
  'config/read': {
    file: 'v2/ConfigReadParams.json',
    fields: {includeLayers: 'boolean', cwd: 'string'},
    required: [],
    nullable: ['cwd'],
  },
  'thread/start': {
    file: 'v2/ThreadStartParams.json',
    fields: {
      ephemeral: 'boolean', approvalPolicy: 'string', developerInstructions: 'string',
      cwd: 'string',
    },
    required: [],
    nullable: ['ephemeral', 'approvalPolicy', 'developerInstructions', 'cwd'],
    allowedTypes: {approvalPolicy: ['string', 'object', 'null']},
  },
  'thread/resume': {
    file: 'v2/ThreadResumeParams.json',
    fields: {
      threadId: 'string', approvalPolicy: 'string', developerInstructions: 'string', cwd: 'string',
    },
    required: ['threadId'],
    nullable: ['approvalPolicy', 'developerInstructions', 'cwd'],
    allowedTypes: {approvalPolicy: ['string', 'object', 'null']},
  },
  'turn/start': {
    file: 'v2/TurnStartParams.json',
    fields: {threadId: 'string', input: 'array'},
    required: ['threadId', 'input'],
  },
  'turn/steer': {
    file: 'v2/TurnSteerParams.json',
    fields: {threadId: 'string', expectedTurnId: 'string', input: 'array'},
    required: ['threadId', 'expectedTurnId', 'input'],
  },
  'turn/interrupt': {
    file: 'v2/TurnInterruptParams.json',
    fields: {threadId: 'string', turnId: 'string'},
    required: ['threadId', 'turnId'],
  },
} as const

const THREAD_NESTED = {
  field: 'thread',
  fields: {id: 'string', cwd: 'string', ephemeral: 'boolean', path: 'string'},
  required: ['id', 'cwd', 'ephemeral'],
} as const
const TURN_NESTED = {
  field: 'turn',
  fields: {id: 'string', items: 'array', status: 'string'},
  required: ['id', 'items', 'status'],
} as const
const INBOUND_SPECS = [
  {
    file: 'v2/ConfigReadResponse.json', fields: {config: 'object', origins: 'object'},
    required: ['config', 'origins'],
  },
  {
    file: 'v2/ThreadStartResponse.json',
    fields: {approvalPolicy: 'string', cwd: 'string', sandbox: 'object', thread: 'object'},
    required: ['approvalPolicy', 'cwd', 'sandbox', 'thread'], nested: THREAD_NESTED,
    allowedTypes: {approvalPolicy: ['string', 'object']},
  },
  {
    file: 'v2/ThreadResumeResponse.json',
    fields: {
      approvalPolicy: 'string', cwd: 'string', sandbox: 'object', thread: 'object',
    },
    required: ['approvalPolicy', 'cwd', 'sandbox', 'thread'],
    nested: THREAD_NESTED,
    allowedTypes: {approvalPolicy: ['string', 'object']},
  },
  {
    file: 'v2/TurnStartResponse.json', fields: {turn: 'object'}, required: ['turn'],
    nested: TURN_NESTED,
  },
  {
    file: 'v2/TurnSteerResponse.json', fields: {turnId: 'string'}, required: ['turnId'],
  },
  {
    file: 'v2/TurnStartedNotification.json',
    fields: {threadId: 'string', turn: 'object'}, required: ['threadId', 'turn'],
    nested: TURN_NESTED,
  },
  {
    file: 'v2/ItemStartedNotification.json',
    fields: {threadId: 'string', turnId: 'string', startedAtMs: 'integer', item: 'object'},
    required: ['threadId', 'turnId', 'startedAtMs', 'item'],
  },
  {
    file: 'v2/ItemCompletedNotification.json',
    fields: {threadId: 'string', turnId: 'string', item: 'object'},
    required: ['threadId', 'turnId', 'item'],
  },
  {
    file: 'v2/TurnCompletedNotification.json',
    fields: {threadId: 'string', turn: 'object'}, required: ['threadId', 'turn'],
    nested: TURN_NESTED,
  },
] as const

function objectSchema(
  fields: Readonly<Record<string, unknown>>,
  required: readonly string[],
  definitions: Readonly<Record<string, unknown>> = {},
): unknown {
  return {type: 'object', properties: fields, required, definitions}
}

function schemaForFields(
  fields: Readonly<Record<string, string>>,
  required: readonly string[],
  nullable: readonly string[] = [],
  allowedTypes: Readonly<Record<string, readonly string[]>> = {},
): unknown {
  const nullableFields = new Set(nullable)
  return objectSchema(Object.fromEntries(Object.entries(fields).map(([name, type]) => [
    name,
    {type: allowedTypes[name] ?? (nullableFields.has(name) ? [type, 'null'] : type)},
  ])), required)
}

function supportedBundle(): Bundle {
  const bundle: Bundle = {}
  bundle['ClientRequest.json'] = {
    oneOf: Object.entries(METHOD_SPECS).map(([method, spec]) => ({
      type: 'object',
      properties: {
        id: {type: 'integer'},
        method: {enum: [method]},
        params: {$ref: `#/definitions/${spec.file.split('/').at(-1)!.replace('.json', '')}`},
      },
      required: ['id', 'method', 'params'],
    })),
  }
  for (const spec of Object.values(METHOD_SPECS)) {
    bundle[spec.file] = schemaForFields(
      spec.fields,
      spec.required,
      'nullable' in spec ? spec.nullable : [],
      'allowedTypes' in spec ? spec.allowedTypes : {},
    )
  }
  for (const spec of INBOUND_SPECS) {
    const allowedTypes: Readonly<Record<string, readonly string[]>> = 'allowedTypes' in spec
      ? spec.allowedTypes
      : {}
    const fields: Record<string, unknown> = Object.fromEntries(
      Object.entries(spec.fields).map(([name, type]) => [
        name,
        {type: allowedTypes[name] ?? type},
      ]),
    )
    const definitions: Record<string, unknown> = {}
    if ('nested' in spec) {
      const definitionName = `${spec.nested.field}Definition`
      fields[spec.nested.field] = {$ref: `#/definitions/${definitionName}`}
      definitions[definitionName] = schemaForFields(spec.nested.fields, spec.nested.required)
    }
    bundle[spec.file] = objectSchema(fields, spec.required, definitions)
  }
  return bundle
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function record(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, 'object')
  assert.notEqual(value, null)
  assert.equal(Array.isArray(value), false)
  return value as Record<string, unknown>
}

function nested(value: Record<string, unknown>, ...keys: readonly string[]): Record<string, unknown> {
  let current = value
  for (const key of keys) current = record(current[key])
  return current
}

function expectCode(code: string): (error: unknown) => boolean {
  return error => error instanceof CodexProtocolError && error.code === code
}

function expectUnsupported(bundle: Bundle): void {
  assert.throws(() => validateCodexSchemaBundle(bundle), expectCode('unsupported_protocol'))
}

function requestVariant(bundle: Bundle, method: string): Record<string, unknown> {
  const variantsValue: unknown = record(bundle['ClientRequest.json']).oneOf
  assert.ok(Array.isArray(variantsValue))
  const variants = variantsValue as readonly unknown[]
  const found = variants.find(candidate => {
    const methodSchema = nested(record(candidate), 'properties', 'method')
    return Array.isArray(methodSchema.enum) && methodSchema.enum[0] === method
  })
  assert.notEqual(found, undefined)
  return record(found)
}

test('the exact supported request and inbound schema bundle validates', () => {
  assert.deepEqual(APP_SERVER_METHOD_SCHEMAS, METHOD_SPECS)
  assert.deepEqual(APP_SERVER_INBOUND_SCHEMAS, INBOUND_SPECS)
  assert.deepEqual(validateCodexSchemaBundle(supportedBundle()), {
    initialize: true,
    'config/read': true,
    'thread/start': true,
    'thread/resume': true,
    'turn/start': true,
    'turn/steer': true,
    'turn/interrupt': true,
  })
})

test('missing, widened, malformed, and recursive schemas fail closed', () => {
  const mutations: ((bundle: Bundle) => void)[] = [
    bundle => { delete bundle['v2/TurnSteerParams.json'] },
    bundle => {
      const client = bundle['ClientRequest.json'] as {oneOf: unknown[]}
      client.oneOf = client.oneOf.filter(variant => (
        (variant as {properties: {method: {enum: string[]}}}).properties.method.enum[0] !== 'turn/start'
      ))
    },
    bundle => {
      const client = bundle['ClientRequest.json'] as {oneOf: {required: string[]}[]}
      client.oneOf[0]!.required = ['id', 'method']
    },
    bundle => {
      const schema = bundle['v2/TurnStartParams.json'] as {properties: {input: {type: unknown}}}
      schema.properties.input.type = ['array', 'string']
    },
    bundle => {
      const schema = bundle['v2/TurnCompletedNotification.json'] as {
        definitions: Record<string, {properties: Record<string, unknown>}>
      }
      const definition = Object.values(schema.definitions)[0]!
      delete definition.properties.status
    },
    bundle => {
      const schema = bundle['v2/TurnCompletedNotification.json'] as {
        properties: {turn: Record<string, unknown>}
      }
      schema.properties.turn = {$ref: '#/definitions/loop'}
      ;(schema as unknown as {definitions: Record<string, unknown>}).definitions.loop = {
        $ref: '#/definitions/loop',
      }
    },
    bundle => { bundle['v2/ConfigReadResponse.json'] = new Date() },
  ]
  for (const mutate of mutations) {
    const bundle = supportedBundle()
    mutate(bundle)
    assert.throws(() => validateCodexSchemaBundle(bundle), expectCode('unsupported_protocol'))
  }
})

test('every required method, reference, field, required marker, and type is fail-closed', () => {
  for (const [method, spec] of Object.entries(METHOD_SPECS)) {
    const missingMethod = supportedBundle()
    const client = record(missingMethod['ClientRequest.json'])
    assert.ok(Array.isArray(client.oneOf))
    client.oneOf = client.oneOf.filter(candidate => candidate !== requestVariant(missingMethod, method))
    expectUnsupported(missingMethod)

    const badReference = supportedBundle()
    nested(requestVariant(badReference, method), 'properties', 'params').$ref = '#/definitions/Wrong'
    expectUnsupported(badReference)

    for (const [field, expectedType] of Object.entries(spec.fields)) {
      const missingField = supportedBundle()
      delete nested(missingField, spec.file, 'properties')[field]
      expectUnsupported(missingField)

      const widenedType = supportedBundle()
      nested(widenedType, spec.file, 'properties', field).type = [
        expectedType, expectedType === 'string' ? 'integer' : 'string',
      ]
      expectUnsupported(widenedType)
    }
    for (const field of spec.required) {
      const missingRequired = supportedBundle()
      const schema = nested(missingRequired, spec.file)
      assert.ok(Array.isArray(schema.required))
      schema.required = schema.required.filter(value => value !== field)
      expectUnsupported(missingRequired)
    }
  }

  for (const spec of INBOUND_SPECS) {
    for (const [field, expectedType] of Object.entries(spec.fields)) {
      const missingField = supportedBundle()
      delete nested(missingField, spec.file, 'properties')[field]
      expectUnsupported(missingField)

      const widenedType = supportedBundle()
      const fieldSchema = nested(widenedType, spec.file, 'properties', field)
      if (Object.hasOwn(fieldSchema, '$ref')) fieldSchema.type = 'string'
      else fieldSchema.type = [expectedType, 'null']
      expectUnsupported(widenedType)
    }
    for (const field of spec.required) {
      const missingRequired = supportedBundle()
      const schema = nested(missingRequired, spec.file)
      assert.ok(Array.isArray(schema.required))
      schema.required = schema.required.filter(value => value !== field)
      expectUnsupported(missingRequired)
    }
    if ('nested' in spec) {
      for (const [field, expectedType] of Object.entries(spec.nested.fields)) {
        const missingNested = supportedBundle()
        const definitions = nested(missingNested, spec.file, 'definitions')
        const definition = record(Object.values(definitions)[0])
        delete nested(definition, 'properties')[field]
        expectUnsupported(missingNested)

        const widenedNested = supportedBundle()
        const widenedDefinitions = nested(widenedNested, spec.file, 'definitions')
        const widenedDefinition = record(Object.values(widenedDefinitions)[0])
        nested(widenedDefinition, 'properties', field).type = [expectedType, 'integer']
        expectUnsupported(widenedNested)
      }
      for (const field of spec.nested.required) {
        const missingNestedRequired = supportedBundle()
        const definitions = nested(missingNestedRequired, spec.file, 'definitions')
        const definition = record(Object.values(definitions)[0])
        assert.ok(Array.isArray(definition.required))
        definition.required = definition.required.filter(value => value !== field)
        expectUnsupported(missingNestedRequired)
      }
    }
  }
})

function effectiveConfig(): Record<string, unknown> {
  return {
    config: {
      default_permissions: 'nova_audio_agent',
      web_search: 'disabled',
      permissions: {
        nova_audio_agent: {
          filesystem: {
            ':root': 'read',
            ':workspace_roots': {
              '.': 'write', '.git': 'read', '.agents': 'read', '.codex': 'read',
            },
          },
          network: {enabled: false},
        },
      },
      shell_environment_policy: {
        inherit: 'core', include_only: ['PATH', 'LANG', 'LC_ALL', 'TERM'],
      },
      features: {
        hooks: false,
        apps: false,
        multi_agent: false,
        plugins: false,
        remote_plugin: false,
        plugin_sharing: false,
        tool_suggest: false,
        remote_control: false,
      },
      mcp_servers: {},
      model_instructions_file: null,
    },
    origins: {'/PRIVATE/PATH': {token: 'DO-NOT-LEAK'}},
    layers: [{credential: 'DO-NOT-LEAK'}],
  }
}

function effectiveConfig147(): Record<string, unknown> {
  const value = effectiveConfig()
  const config = nested(value, 'config')
  const profile = nested(config, 'permissions', 'nova_audio_agent')
  Object.assign(profile, {description: null, extends: null, workspace_roots: null})
  Object.assign(nested(profile, 'filesystem'), {glob_scan_max_depth: null})
  Object.assign(nested(profile, 'network'), {
    proxy_url: null,
    enable_socks5: null,
    socks_url: null,
    enable_socks5_udp: null,
    allow_upstream_proxy: null,
    dangerously_allow_non_loopback_proxy: null,
    dangerously_allow_all_unix_sockets: null,
    mode: null,
    domains: null,
    unix_sockets: null,
    allow_local_binding: null,
    mitm: null,
  })
  Object.assign(nested(config, 'shell_environment_policy'), {
    ignore_default_excludes: null,
    exclude: null,
    set: null,
    filters: null,
    experimental_use_profile: null,
  })
  Object.assign(nested(config, 'features'), {
    auth_elicitation: true,
    mcp_2026_07_28: false,
    memories: false,
    mentions_v2: true,
    network_proxy: null,
  })
  return value
}

test('effective config returns only the fixed credential-free isolation report', () => {
  const report = validateEffectiveCodexConfig(effectiveConfig(), '/workspace', {
    allowReplacementInstructions: false,
  })
  assert.deepEqual(report, {
    default_permissions: 'nova_audio_agent',
    filesystem: 'workspace_only',
    network: 'blocked',
    web_search: 'disabled',
    shell_environment: 'core_include_only',
    extensions: 'disabled',
    mcp: 'empty',
    instructions: 'builtin',
  })
  assert.equal(JSON.stringify(report).includes('PRIVATE'), false)
  assert.equal(JSON.stringify(report).includes('DO-NOT-LEAK'), false)
})

test('Codex 0.147 inert config expansion preserves the isolation report', () => {
  const expected = {
    default_permissions: 'nova_audio_agent',
    filesystem: 'workspace_only',
    network: 'blocked',
    web_search: 'disabled',
    shell_environment: 'core_include_only',
    extensions: 'disabled',
    mcp: 'empty',
    instructions: 'builtin',
  }
  assert.deepEqual(validateEffectiveCodexConfig(effectiveConfig147(), '/workspace', {
    allowReplacementInstructions: false,
  }), expected)

  const saferFeatureDefaults = effectiveConfig147()
  nested(saferFeatureDefaults, 'config', 'features').auth_elicitation = false
  nested(saferFeatureDefaults, 'config', 'features').mentions_v2 = false
  assert.deepEqual(validateEffectiveCodexConfig(saferFeatureDefaults, '/workspace', {
    allowReplacementInstructions: false,
  }), expected)
})

test('expanded config fields still fail closed when they activate host capabilities', () => {
  const mutations: ((value: Record<string, unknown>) => void)[] = [
    value => { nested(value, 'config', 'permissions', 'nova_audio_agent').workspace_roots = {} },
    value => {
      nested(value, 'config', 'permissions', 'nova_audio_agent', 'filesystem')
        .glob_scan_max_depth = 8
    },
    value => {
      nested(value, 'config', 'permissions', 'nova_audio_agent', 'network').proxy_url = 'private'
    },
    value => { nested(value, 'config', 'shell_environment_policy').set = {TOKEN: 'private'} },
    value => { nested(value, 'config', 'features').future_capability = true },
  ]
  for (const mutate of mutations) {
    const value = effectiveConfig147()
    mutate(value)
    assert.throws(() => validateEffectiveCodexConfig(value, '/workspace', {
      allowReplacementInstructions: false,
    }), expectCode('config_not_isolated'))
  }
})

test('every capability widening, warning, requirement, and replacement fails privately', () => {
  const mutations: ((value: Record<string, unknown>) => void)[] = [
    value => { (value.config as Record<string, unknown>).web_search = 'live' },
    value => { (value.config as Record<string, unknown>).default_permissions = 'danger' },
    value => {
      nested(value, 'config', 'permissions', 'nova_audio_agent', 'filesystem')[':root'] = 'write'
    },
    value => {
      nested(
        value, 'config', 'permissions', 'nova_audio_agent', 'filesystem', ':workspace_roots',
      ).tmp = 'write'
    },
    value => {
      nested(value, 'config', 'permissions', 'nova_audio_agent', 'network').enabled = true
    },
    value => {
      const shell = nested(value, 'config', 'shell_environment_policy')
      const includeOnly = shell.include_only
      assert.ok(Array.isArray(includeOnly))
      includeOnly.push('TOKEN')
    },
    value => { nested(value, 'config', 'features').plugins = true },
    value => { nested(value, 'config', 'features').remote_control = true },
    value => { nested(value, 'config', 'features').future_capability = true },
    value => { nested(value, 'config', 'permissions').danger = {} },
    value => { nested(value, 'config', 'permissions', 'nova_audio_agent').device = 'write' },
    value => { nested(value, 'config', 'shell_environment_policy').extra = false },
    value => { nested(value, 'config').mcp_servers = {private: {}} },
    value => { nested(value, 'config').model_instructions_file = '/PRIVATE/PATH' },
    value => { value.warnings = [{detail: 'DO-NOT-LEAK'}] },
    value => { value.requirements = [{detail: 'DO-NOT-LEAK'}] },
  ]
  for (const mutate of mutations) {
    const value = clone(effectiveConfig())
    mutate(value)
    assert.throws(() => validateEffectiveCodexConfig(value, '/workspace', {
      allowReplacementInstructions: false,
    }), error => {
      assert.ok(error instanceof CodexProtocolError)
      assert.equal(error.code, 'config_not_isolated')
      assert.equal(String(error).includes('PRIVATE'), false)
      assert.equal(String(error).includes('DO-NOT-LEAK'), false)
      return true
    })
  }
})

test('workspace roots require the exact expected key set even when an extra value is undefined', () => {
  const value = effectiveConfig()
  const roots = nested(
    value, 'config', 'permissions', 'nova_audio_agent', 'filesystem', ':workspace_roots',
  )
  delete roots['.codex']
  roots.evil = undefined
  assert.throws(() => validateEffectiveCodexConfig(value, '/workspace', {
    allowReplacementInstructions: false,
  }), expectCode('config_not_isolated'))
})

test('workspace roots require own keys even when Object prototype supplies the missing key', () => {
  Object.defineProperty(Object.prototype, '.codex', {
    value: 'read', enumerable: false, configurable: true, writable: true,
  })
  try {
    const value = effectiveConfig()
    const roots = nested(
      value, 'config', 'permissions', 'nova_audio_agent', 'filesystem', ':workspace_roots',
    )
    delete roots['.codex']
    roots.evil = 'read'
    assert.throws(() => validateEffectiveCodexConfig(value, '/workspace', {
      allowReplacementInstructions: false,
    }), expectCode('config_not_isolated'))
  } finally {
    delete (Object.prototype as Record<string, unknown>)['.codex']
  }
})

test('replacement instructions require the explicit opt-in and change only the report verdict', () => {
  const value = effectiveConfig()
  nested(value, 'config').model_instructions_file = '/host/selected/instructions.md'
  assert.equal(validateEffectiveCodexConfig(value, '/workspace', {
    allowReplacementInstructions: true,
  }).instructions, 'replacement')
  assert.equal(validateEffectiveCodexConfig(effectiveConfig(), '/workspace', {
    allowReplacementInstructions: true,
  }).instructions, 'replacement')
})
