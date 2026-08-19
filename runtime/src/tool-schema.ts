/**
 * Compile executor manifests into provider-safe function schemas.
 *
 * Ported from `src/nova_audio_agent/tool_schema.py`. The logical tool name stays
 * `<executor>.<op>`; DashScope's OpenAI-compatible wire format forbids dots, so the
 * provider sees `<executor>__<op>` and the immutable binding table restores the
 * logical identity.
 *
 * Every description string here reaches the model, so the emitted schemas are pinned
 * byte for byte against a Python-exported golden rather than eyeballed.
 */

import { z } from 'zod'
import type { JsonValue } from './events.js'
import type { StructuredTarget } from './memory.js'
import type { ExecutorManifest, OpSpec } from './ports.js'

const WIRE_PART = /^[A-Za-z0-9_-]+$/u
const MAX_WIRE_NAME = 64

/**
 * The model-writable structured targets, in the order their tools are offered.
 *
 * `StructuredTarget` itself is owned by `memory.ts`; this pins the tool ordering,
 * which is contract because it is the order the provider sees.
 */
export const STRUCTURED_TARGETS: readonly StructuredTarget[] = ['intent', 'goal', 'authorization']

const ORIGIN_REF: Readonly<Record<string, JsonValue>> = {
  type: 'string',
  description: '当前 ContextView 中、这次动作所回答内容的 ref',
}

const UPDATE_PROPERTIES: Readonly<Record<StructuredTarget, Readonly<Record<string, JsonValue>>>> = {
  intent: {
    objective_hypothesis: {type: 'string'},
    constraints: {type: 'array', items: {type: 'string'}},
    unresolved_questions: {type: 'array', items: {type: 'string'}},
    uncertainty: {type: 'number'},
  },
  goal: {
    objective: {type: 'string'},
    acceptance_criteria: {type: 'array', items: {type: 'string'}},
    status: {type: 'string', enum: ['accepted', 'superseded']},
  },
  authorization: {
    allow: {type: 'array', items: {type: 'string'}},
    deny: {type: 'array', items: {type: 'string'}},
    evidence_refs: {type: 'array', items: {type: 'string'}},
  },
}

export const toolBindingSchema = z.object({
  kind: z.enum(['delegate', 'update', 'query']),
  logical_name: z.string().min(1),
  executor: z.string().min(1).nullable().default(null),
  op: z.string().min(1).nullable().default(null),
  target: z.enum(STRUCTURED_TARGETS).nullable().default(null),
  sync_result: z.boolean().default(false),
}).strict()

export type ToolBinding = z.infer<typeof toolBindingSchema>

export interface CompiledTools {
  readonly schemas: readonly Readonly<Record<string, JsonValue>>[]
  readonly bindings: ReadonlyMap<string, ToolBinding>
}

export class ToolSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolSchemaError'
  }
}

export function compileToolSchema(
  manifests: readonly ExecutorManifest[],
  options: {readonly includeMemoryRecall?: boolean} = {},
): CompiledTools {
  const schemas: Readonly<Record<string, JsonValue>>[] = []
  const bindings = new Map<string, ToolBinding>()

  for (const target of STRUCTURED_TARGETS) {
    const wireName = `update_${target}`
    schemas.push(functionSchema(
      wireName,
      `按字段更新 ${target}；只传本轮确实变化的字段`,
      {
        type: 'object',
        properties: structuredClone(UPDATE_PROPERTIES[target]) as JsonValue,
        additionalProperties: false,
        minProperties: 1,
      },
    ))
    bindings.set(wireName, toolBindingSchema.parse({
      kind: 'update',
      logical_name: `update.${target}`,
      target,
    }))
  }

  if (options.includeMemoryRecall === true) {
    const wireName = 'memory__recall'
    schemas.push(functionSchema(
      wireName,
      '从当前会话的历史记忆中查找与用户问题相关的证据',
      {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            minLength: 1,
            maxLength: 512,
            description: '用户当前问题中需要回想的事实或结果',
          },
          scope: {
            type: 'string',
            enum: ['recent', 'any'],
            description: 'recent 优先最近记录；any 在当前会话记忆内扩大查找',
          },
        },
        required: ['query', 'scope'],
        additionalProperties: false,
      },
    ))
    bindings.set(wireName, toolBindingSchema.parse({
      kind: 'query',
      logical_name: 'memory.recall',
    }))
  }

  const seen = new Set<string>()
  for (const manifest of manifests) {
    if (seen.has(manifest.name)) {
      throw new ToolSchemaError(`manifest 名称重复：${manifest.name}`)
    }
    seen.add(manifest.name)
    validatePart(manifest.name, 'executor')
    if (!manifest.ops.some(op => op.readonly)) {
      throw new ToolSchemaError(`manifest '${manifest.name}' 至少需要一个 readonly op`)
    }
    for (const op of manifest.ops) {
      const compiled = compileOp(manifest, op)
      if (bindings.has(compiled.wireName)) {
        throw new ToolSchemaError(`工具 wire name 重复：${compiled.wireName}`)
      }
      schemas.push(compiled.schema)
      bindings.set(compiled.wireName, compiled.binding)
    }
  }

  return {schemas, bindings}
}

function compileOp(manifest: ExecutorManifest, op: OpSpec): {
  readonly wireName: string
  readonly schema: Readonly<Record<string, JsonValue>>
  readonly binding: ToolBinding
} {
  validatePart(op.name, 'op')
  const wireName = `${manifest.name}__${op.name}`
  if ([...wireName].length > MAX_WIRE_NAME) {
    throw new ToolSchemaError(`工具 wire name 超过 ${MAX_WIRE_NAME} 个字符：${wireName}`)
  }
  if (op.description.trim().length === 0) {
    throw new ToolSchemaError(`${manifest.name}.${op.name} 缺 description`)
  }

  const parameters: Record<string, JsonValue> = structuredClone(op.params)
  const properties = parameters.properties
  if (parameters.type !== 'object' || !isJsonObject(properties)) {
    throw new ToolSchemaError(`${manifest.name}.${op.name} 的 params 必须是 object JSON Schema`)
  }
  if ('origin_ref' in properties) {
    throw new ToolSchemaError(`${manifest.name}.${op.name} 的 params 保留字冲突：origin_ref`)
  }
  const withOrigin: Record<string, JsonValue> = {...properties, origin_ref: {...ORIGIN_REF}}
  parameters.properties = withOrigin
  const declared = parameters.required
  const required = Array.isArray(declared) ? [...declared] : []
  if (!required.includes('origin_ref')) required.push('origin_ref')
  parameters.required = required
  // Python's setdefault: an explicit value in the manifest wins.
  if (!('additionalProperties' in parameters)) parameters.additionalProperties = false

  return {
    wireName,
    schema: functionSchema(wireName, op.description, parameters),
    binding: toolBindingSchema.parse({
      kind: 'delegate',
      logical_name: `${manifest.name}.${op.name}`,
      executor: manifest.name,
      op: op.name,
      sync_result: op.sync_result,
    }),
  }
}

function validatePart(value: string, label: string): void {
  if (value.length === 0 || !WIRE_PART.test(value)) {
    throw new ToolSchemaError(`${label} 名称只能包含字母、数字、下划线和短划线：'${value}'`)
  }
}

function functionSchema(
  name: string,
  description: string,
  parameters: JsonValue,
): Readonly<Record<string, JsonValue>> {
  return {type: 'function', function: {name, description, parameters}}
}

function isJsonObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
