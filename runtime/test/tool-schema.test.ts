import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { canonicalJson } from '../src/canonical-json.js'
import type { JsonValue } from '../src/events.js'
import { handoffPolicySchema } from '../src/memory.js'
import { executorManifestSchema } from '../src/ports.js'
import { ToolSchemaError, compileToolSchema } from '../src/tool-schema.js'

const fixtureRoot = resolve(import.meta.dirname, '../../../fixtures/tools/v1')

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(fixtureRoot, name), 'utf8')) as T
}

interface Fixture {
  readonly schema_version: number
  readonly scenarios: readonly {
    readonly id: string
    readonly covers: string
    readonly include_memory_recall: boolean
    readonly manifests: readonly unknown[]
  }[]
}

interface Golden {
  readonly schema_version: number
  readonly scenarios: Readonly<Record<string, {
    readonly schemas: readonly JsonValue[]
    readonly bindings: Readonly<Record<string, JsonValue>>
    readonly binding_order: readonly string[]
  }>>
}

function manifestFrom(spec: unknown): ReturnType<typeof executorManifestSchema.parse> {
  const raw = spec as {policy: unknown, name: string, ops: unknown[]}
  return executorManifestSchema.parse({
    name: raw.name,
    display_name: raw.name,
    policy: handoffPolicySchema.parse(raw.policy),
    ops: raw.ops,
  })
}

function record(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, 'object')
  assert.notEqual(value, null)
  assert.equal(Array.isArray(value), false)
  return value as Record<string, unknown>
}

test('compiled tool schemas preserve the frozen contract with the native personal recall extension', () => {
  const fixture = loadJson<Fixture>('manifests.json')
  const golden = loadJson<Golden>('manifests-expected.json')
  assert.equal(fixture.schema_version, golden.schema_version)
  assert.deepEqual(
    fixture.scenarios.map(scenario => scenario.id).sort(),
    Object.keys(golden.scenarios).sort(),
  )

  for (const scenario of fixture.scenarios) {
    const compiled = compileToolSchema(
      scenario.manifests.map(manifestFrom),
      {includeMemoryRecall: scenario.include_memory_recall},
    )
    const expected = golden.scenarios[scenario.id]
    assert.ok(expected !== undefined, scenario.id)

    // The frozen fixtures remain historical evidence. Only the documented native recall
    // description/source extension is projected away; all other schema fields still compare.
    const legacySchemas = structuredClone(compiled.schemas)
    for (const schema of legacySchemas) {
      const fn = record(record(schema).function)
      if (fn.name !== 'memory__recall') continue
      fn.description = '从当前会话的历史记忆中查找与用户问题相关的证据'
      const properties = record(record(fn.parameters).properties)
      delete properties.source
      record(properties.scope).description = 'recent 优先最近记录；any 在当前会话记忆内扩大查找'
    }
    assert.equal(
      canonicalJson(legacySchemas),
      canonicalJson(expected.schemas),
      `${scenario.id} schemas: ${scenario.covers}`,
    )
    // Binding order is the provider tool order, so it is contract, not incidental.
    assert.deepEqual([...compiled.bindings.keys()], [...expected.binding_order], scenario.id)
    assert.equal(
      canonicalJson(Object.fromEntries(compiled.bindings)),
      canonicalJson(expected.bindings),
      `${scenario.id} bindings`,
    )
  }
})

test('the golden is not vacuous', () => {
  const golden = loadJson<Golden>('manifests-expected.json')
  const one = golden.scenarios['one-executor']
  assert.ok(one !== undefined)
  assert.ok(one.schemas.length >= 4, 'four executor ops')
  // origin_ref must be injected into every delegate op and appended to required.
  const rendered = JSON.stringify(one.schemas)
  assert.match(rendered, /origin_ref/u)
  assert.match(rendered, /当前 ContextView 中、这次动作所回答内容的 ref/u)
  assert.match(rendered, /slow_sim__set_light/u)
})

test('memory recall defaults to session and exposes only the bounded personal source choice', () => {
  const recall = record(record(compileToolSchema([], {includeMemoryRecall: true}).schemas[0]).function)
  const parameters = record(recall.parameters)
  const source = record(record(parameters.properties).source)
  assert.deepEqual(source.enum, ['session', 'personal'])
  assert.equal(source.default, 'session')
  assert.deepEqual(parameters.required, ['query', 'scope'])
  assert.equal(parameters.additionalProperties, false)
  assert.equal('user' in record(parameters.properties), false)
  assert.equal('path' in record(parameters.properties), false)
})

test('origin_ref is injected into every discriminated object branch', () => {
  const policy = handoffPolicySchema.parse({
    channel: 'demo', priority: 10, wake: 'fast', typical_latency: 1, compress_watermark: 20,
  })
  const manifest = executorManifestSchema.parse({
    name: 'demo',
    display_name: 'Demo',
    policy,
    ops: [{
      name: 'route',
      description: 'route',
      readonly: true,
      params: {
        type: 'object',
        properties: {
          action: {type: 'string', enum: ['read', 'write']},
          value: {type: 'string'},
        },
        required: ['action'],
        additionalProperties: false,
        oneOf: [
          {
            type: 'object',
            properties: {action: {type: 'string', enum: ['read']}},
            required: ['action'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {action: {type: 'string', enum: ['write']}, value: {type: 'string'}},
            required: ['action', 'value'],
            additionalProperties: false,
          },
        ],
      },
    }],
  })

  const parameters = record(record(compileToolSchema([manifest]).schemas[0]).function).parameters
  const params = record(parameters)
  assert.ok('origin_ref' in record(params.properties))
  assert.ok((params.required as unknown[]).includes('origin_ref'))
  for (const rawBranch of params.oneOf as unknown[]) {
    const branch = record(rawBranch)
    assert.deepEqual(record(branch.properties).origin_ref, {
      type: 'string', description: '当前 ContextView 中、这次动作所回答内容的 ref',
    })
    assert.ok((branch.required as unknown[]).includes('origin_ref'))
  }
})

test('wire names, reserved params, and readonly requirements are enforced', () => {
  const readonlyOp = {
    name: 'peek',
    description: 'readonly',
    params: {type: 'object', properties: {}},
    readonly: true,
  }
  const policy = handoffPolicySchema.parse({
    channel: 'sim', priority: 50, wake: 'fast', typical_latency: 5, compress_watermark: 8,
  })

  // A manifest with no readonly op cannot be compiled.
  assert.throws(() => compileToolSchema([executorManifestSchema.parse({
    name: 'sim',
    display_name: 'Sim',
    policy,
    ops: [{name: 'write', description: 'writes', params: {type: 'object', properties: {}}}],
  })]), ToolSchemaError)

  // A dot in a name would break the provider wire format.
  assert.throws(() => compileToolSchema([executorManifestSchema.parse({
    name: 'bad.name', display_name: 'Bad Name',
    policy: handoffPolicySchema.parse({...policy, channel: 'bad.name'}),
    ops: [readonlyOp],
  })]), ToolSchemaError)

  // origin_ref is host-owned and cannot be declared by a manifest.
  assert.throws(() => compileToolSchema([executorManifestSchema.parse({
    name: 'sim',
    display_name: 'Sim',
    policy,
    ops: [{
      ...readonlyOp,
      params: {type: 'object', properties: {origin_ref: {type: 'string'}}},
    }],
  })]), ToolSchemaError)

  // A duplicate manifest name is rejected rather than silently shadowing.
  const manifest = executorManifestSchema.parse({name: 'sim', display_name: 'Sim', policy, ops: [readonlyOp]})
  assert.throws(() => compileToolSchema([manifest, manifest]), ToolSchemaError)

  // A wire name over 64 characters cannot reach the provider.
  const longName = 'a'.repeat(60)
  assert.throws(() => compileToolSchema([executorManifestSchema.parse({
    name: longName,
    display_name: 'Long Name',
    policy: handoffPolicySchema.parse({...policy, channel: longName}),
    ops: [{...readonlyOp, name: 'peekpeek'}],
  })]), ToolSchemaError)
})

test('hidden executors fold into descriptor-driven host tools while keeping their delegate bindings', () => {
  const policy = handoffPolicySchema.parse({
    channel: 'codex', priority: 50, wake: 'fast', typical_latency: 5, compress_watermark: 8,
  })
  const statusOp = {name: 'status', description: 'status', params: {type: 'object', properties: {}}, readonly: true}
  const runOp = {name: 'run', description: 'run', params: {type: 'object', properties: {work_order: {type: 'string'}}, required: ['work_order']}}
  const agent = executorManifestSchema.parse({
    name: 'codex', display_name: 'Codex', model_visibility: 'hidden', policy, ops: [runOp, statusOp],
  })
  const plain = executorManifestSchema.parse({
    name: 'sim', display_name: 'Sim', policy: handoffPolicySchema.parse({...policy, channel: 'sim'}),
    ops: [{...statusOp, name: 'peek'}],
  })

  const compiled = compileToolSchema([agent, plain], {agentDescriptors: [{
    name: 'codex', summary: '写代码、改项目', ownedChannels: ['codex'],
  }]})
  const names = (schemas: readonly JsonValue[]): string[] =>
    schemas.map(schema => String(record(record(schema).function).name)).filter(name => !name.startsWith('update_'))
  assert.deepEqual(names(compiled.schemas), ['sim__peek', 'dispatch', 'cancel', 'confirm'], 'no codex__* schema reaches the model')
  for (const name of ['codex__run', 'codex__status']) {
    assert.equal(compiled.bindings.get(name)?.kind, 'delegate', `${name} binding survives for dispatch rewriting`)
  }
  // The surviving agent bindings are host-only: the provider must be refused when it names them directly.
  assert.deepEqual([...compiled.hidden].sort(), ['codex__run', 'codex__status'])
  assert.equal(compiled.hidden.has('sim__peek'), false)
  for (const name of ['dispatch', 'cancel', 'confirm']) {
    assert.deepEqual(compiled.bindings.get(name), {
      kind: 'host', logical_name: `host.${name}`, executor: null, op: null, sync_result: false,
    })
  }
  const dispatch = record(record(compiled.schemas.find(schema => record(record(schema).function).name === 'dispatch')).function)
  const executor = record(record(record(dispatch.parameters).properties).executor)
  assert.deepEqual(executor.enum, ['codex'])
  assert.match(String(dispatch.description), /codex: 写代码、改项目/u)
  assert.ok(Object.hasOwn(record(record(dispatch.parameters).properties), 'origin_ref'), 'dispatch carries the injected origin_ref')

  // Without a controller descriptor the host tools do not exist.
  const bare = compileToolSchema([plain])
  assert.deepEqual(names(bare.schemas), ['sim__peek'])
  assert.equal(bare.bindings.has('dispatch'), false)
  assert.equal(bare.hidden.size, 0)
})
