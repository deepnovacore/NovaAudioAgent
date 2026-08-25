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

test('compiled tool schemas match the Python oracle byte for byte', () => {
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

    assert.equal(
      canonicalJson(compiled.schemas),
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
  assert.ok(one.schemas.length >= 7, 'three updates plus four ops')
  // origin_ref must be injected into every delegate op and appended to required.
  const rendered = JSON.stringify(one.schemas)
  assert.match(rendered, /origin_ref/u)
  assert.match(rendered, /当前 ContextView 中、这次动作所回答内容的 ref/u)
  assert.match(rendered, /slow_sim__set_light/u)
})

test('origin_ref is injected into every discriminated object branch', () => {
  const policy = handoffPolicySchema.parse({
    channel: 'demo', priority: 10, wake: 'fast', typical_latency: 1, compress_watermark: 20,
  })
  const manifest = executorManifestSchema.parse({
    name: 'demo',
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

  const parameters = record(record(compileToolSchema([manifest]).schemas[3]).function).parameters
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
    policy,
    ops: [{name: 'write', description: 'writes', params: {type: 'object', properties: {}}}],
  })]), ToolSchemaError)

  // A dot in a name would break the provider wire format.
  assert.throws(() => compileToolSchema([executorManifestSchema.parse({
    name: 'bad.name', policy: handoffPolicySchema.parse({...policy, channel: 'bad.name'}),
    ops: [readonlyOp],
  })]), ToolSchemaError)

  // origin_ref is host-owned and cannot be declared by a manifest.
  assert.throws(() => compileToolSchema([executorManifestSchema.parse({
    name: 'sim',
    policy,
    ops: [{
      ...readonlyOp,
      params: {type: 'object', properties: {origin_ref: {type: 'string'}}},
    }],
  })]), ToolSchemaError)

  // A duplicate manifest name is rejected rather than silently shadowing.
  const manifest = executorManifestSchema.parse({name: 'sim', policy, ops: [readonlyOp]})
  assert.throws(() => compileToolSchema([manifest, manifest]), ToolSchemaError)

  // A wire name over 64 characters cannot reach the provider.
  const longName = 'a'.repeat(60)
  assert.throws(() => compileToolSchema([executorManifestSchema.parse({
    name: longName,
    policy: handoffPolicySchema.parse({...policy, channel: longName}),
    ops: [{...readonlyOp, name: 'peekpeek'}],
  })]), ToolSchemaError)
})
