type Bundle = Record<string, unknown>

const METHODS = {
  initialize: ['v1/InitializeParams.json', {clientInfo: 'object'}, ['clientInfo'], [], {}],
  'config/read': [
    'v2/ConfigReadParams.json', {includeLayers: 'boolean', cwd: 'string'}, [], ['cwd'], {},
  ],
  'thread/start': ['v2/ThreadStartParams.json', {
    ephemeral: 'boolean', approvalPolicy: 'string', developerInstructions: 'string',
    cwd: 'string',
  }, [], ['ephemeral', 'approvalPolicy', 'developerInstructions', 'cwd'], {
    approvalPolicy: ['string', 'object', 'null'],
  }],
  'thread/resume': ['v2/ThreadResumeParams.json', {
    threadId: 'string', approvalPolicy: 'string', developerInstructions: 'string', cwd: 'string',
  }, ['threadId'], ['approvalPolicy', 'developerInstructions', 'cwd'], {
    approvalPolicy: ['string', 'object', 'null'],
  }],
  'turn/start': [
    'v2/TurnStartParams.json', {threadId: 'string', input: 'array'}, ['threadId', 'input'], [], {},
  ],
  'turn/steer': ['v2/TurnSteerParams.json', {
    threadId: 'string', expectedTurnId: 'string', input: 'array',
  }, ['threadId', 'expectedTurnId', 'input'], [], {}],
  'turn/interrupt': ['v2/TurnInterruptParams.json', {
    threadId: 'string', turnId: 'string',
  }, ['threadId', 'turnId'], [], {}],
} as const

const INBOUND = [
  ['v2/ConfigReadResponse.json', {config: 'object', origins: 'object'}, ['config', 'origins'], null],
  ['v2/ThreadStartResponse.json', {
    approvalPolicy: 'string', cwd: 'string', sandbox: 'object', thread: 'object',
  }, ['approvalPolicy', 'cwd', 'sandbox', 'thread'], ['thread', {
    id: 'string', cwd: 'string', ephemeral: 'boolean', path: 'string',
  }, ['id', 'cwd', 'ephemeral']]],
  ['v2/ThreadResumeResponse.json', {
    approvalPolicy: 'string', cwd: 'string', sandbox: 'object', thread: 'object',
  }, ['approvalPolicy', 'cwd', 'sandbox', 'thread'], ['thread', {
    id: 'string', cwd: 'string', ephemeral: 'boolean', path: 'string',
  }, ['id', 'cwd', 'ephemeral']]],
  ['v2/TurnStartResponse.json', {turn: 'object'}, ['turn'], ['turn', {
    id: 'string', items: 'array', status: 'string',
  }, ['id', 'items', 'status']]],
  ['v2/TurnSteerResponse.json', {turnId: 'string'}, ['turnId'], null],
  ['v2/TurnStartedNotification.json', {
    threadId: 'string', turn: 'object',
  }, ['threadId', 'turn'], ['turn', {
    id: 'string', items: 'array', status: 'string',
  }, ['id', 'items', 'status']]],
  ['v2/ItemStartedNotification.json', {
    threadId: 'string', turnId: 'string', startedAtMs: 'integer', item: 'object',
  }, ['threadId', 'turnId', 'startedAtMs', 'item'], null],
  ['v2/ItemCompletedNotification.json', {
    threadId: 'string', turnId: 'string', item: 'object',
  }, ['threadId', 'turnId', 'item'], null],
  ['v2/TurnCompletedNotification.json', {
    threadId: 'string', turn: 'object',
  }, ['threadId', 'turn'], ['turn', {
    id: 'string', items: 'array', status: 'string',
  }, ['id', 'items', 'status']]],
] as const

const INBOUND_ALLOWED_TYPES: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  'v2/ThreadStartResponse.json': {approvalPolicy: ['string', 'object']},
  'v2/ThreadResumeResponse.json': {approvalPolicy: ['string', 'object']},
}

export function supportedSchemaBundle(): Bundle {
  const bundle: Bundle = {}
  bundle['ClientRequest.json'] = {
    oneOf: Object.entries(METHODS).map(([method, [file]]) => ({
      type: 'object',
      properties: {
        id: {type: 'integer'},
        method: {enum: [method]},
        params: {$ref: `#/definitions/${file.slice(file.lastIndexOf('/') + 1, -5)}`},
      },
      required: ['id', 'method', 'params'],
    })),
  }
  for (const [file, fields, required, nullable, allowedTypes] of Object.values(METHODS)) {
    bundle[file] = schema(fields, required, nullable, allowedTypes)
  }
  for (const [file, fields, required, nested] of INBOUND) {
    const properties = fieldSchemas(fields, [], INBOUND_ALLOWED_TYPES[file] ?? {})
    const definitions: Record<string, unknown> = {}
    if (nested !== null) {
      const [field, nestedFields, nestedRequired] = nested
      const name = `${field}Definition`
      properties[field] = {$ref: `#/definitions/${name}`}
      definitions[name] = schema(nestedFields, nestedRequired)
    }
    bundle[file] = {type: 'object', properties, required: [...required], definitions}
  }
  return bundle
}

function schema(
  fields: Readonly<Record<string, string>>,
  required: readonly string[],
  nullable: readonly string[] = [],
  allowedTypes: Readonly<Record<string, readonly string[]>> = {},
): unknown {
  return {
    type: 'object', properties: fieldSchemas(fields, nullable, allowedTypes),
    required: [...required], definitions: {},
  }
}

function fieldSchemas(
  fields: Readonly<Record<string, string>>,
  nullable: readonly string[] = [],
  allowedTypes: Readonly<Record<string, readonly string[]>> = {},
): Record<string, unknown> {
  const nullableFields = new Set(nullable)
  return Object.fromEntries(Object.entries(fields).map(([name, type]) => [
    name,
    {type: allowedTypes[name] ?? (nullableFields.has(name) ? [type, 'null'] : type)},
  ]))
}
