type Bundle = Record<string, unknown>

const METHODS = {
  initialize: ['v1/InitializeParams.json', {clientInfo: 'object'}, ['clientInfo']],
  'config/read': ['v2/ConfigReadParams.json', {includeLayers: 'boolean', cwd: 'string'}, []],
  'thread/start': ['v2/ThreadStartParams.json', {
    ephemeral: 'boolean', approvalPolicy: 'string', developerInstructions: 'string',
    cwd: 'string', permissions: 'string', runtimeWorkspaceRoots: 'array',
  }, []],
  'thread/resume': ['v2/ThreadResumeParams.json', {
    threadId: 'string', excludeTurns: 'boolean', approvalPolicy: 'string',
    developerInstructions: 'string', cwd: 'string', permissions: 'string',
    runtimeWorkspaceRoots: 'array',
  }, ['threadId']],
  'turn/start': ['v2/TurnStartParams.json', {threadId: 'string', input: 'array'}, ['threadId', 'input']],
  'turn/steer': ['v2/TurnSteerParams.json', {
    threadId: 'string', expectedTurnId: 'string', input: 'array',
  }, ['threadId', 'expectedTurnId', 'input']],
  'turn/interrupt': ['v2/TurnInterruptParams.json', {
    threadId: 'string', turnId: 'string',
  }, ['threadId', 'turnId']],
} as const

const INBOUND = [
  ['v2/ConfigReadResponse.json', {config: 'object', origins: 'object'}, ['config', 'origins'], null],
  ['v2/ThreadStartResponse.json', {
    approvalPolicy: 'string', cwd: 'string', sandbox: 'object', thread: 'object',
  }, ['approvalPolicy', 'cwd', 'sandbox', 'thread'], ['thread', {
    id: 'string', cwd: 'string', ephemeral: 'boolean', path: 'string',
  }, ['id', 'cwd', 'ephemeral']]],
  ['v2/ThreadResumeResponse.json', {
    approvalPolicy: 'string', cwd: 'string', runtimeWorkspaceRoots: 'array',
    sandbox: 'object', thread: 'object',
  }, ['approvalPolicy', 'cwd', 'runtimeWorkspaceRoots', 'sandbox', 'thread'], ['thread', {
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
  ['v2/ItemCompletedNotification.json', {
    threadId: 'string', turnId: 'string', item: 'object',
  }, ['threadId', 'turnId', 'item'], null],
  ['v2/TurnCompletedNotification.json', {
    threadId: 'string', turn: 'object',
  }, ['threadId', 'turn'], ['turn', {
    id: 'string', items: 'array', status: 'string',
  }, ['id', 'items', 'status']]],
] as const

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
  for (const [file, fields, required] of Object.values(METHODS)) {
    bundle[file] = schema(fields, required)
  }
  for (const [file, fields, required, nested] of INBOUND) {
    const properties = fieldSchemas(fields)
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

function schema(fields: Readonly<Record<string, string>>, required: readonly string[]): unknown {
  return {type: 'object', properties: fieldSchemas(fields), required: [...required], definitions: {}}
}

function fieldSchemas(fields: Readonly<Record<string, string>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([name, type]) => [name, {type}]))
}
