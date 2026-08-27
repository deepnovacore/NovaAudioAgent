/**
 * Two simulators: one fast, one slow.
 *
 * Ports `src/nova_audio_agent/executors/sims.py`. They are the only thing that makes
 * "async does not block" and "speak on timeout" reproducible: a real executor's delay is
 * uncontrollable, so those two core behaviors could never otherwise reach CI.
 *
 * Three contracts hold here and are asserted by tests:
 *
 * 1. dispatch never throws. A transport error, a timeout, invalid params, or a
 *    nonexistent op all become a handoff. A bad output is an observation, not an
 *    exception.
 * 2. Every manifest has at least one readonly op, which is the recheck entry point for
 *    an `unknown` outcome.
 * 3. One delegate produces exactly one handoff; the failure, timeout, and success paths
 *    are mutually exclusive.
 *
 * `unknown` and `failed` are kept strictly apart. A timeout or transport interruption is
 * `unknown` -- we do not know whether the light was actually set -- while invalid params
 * or a nonexistent op are `failed`, because it simply never happened. Calling an unknown
 * outcome a failure is the specific mistake this split exists to prevent.
 */

import type { Clock } from './clock.js'
import type { ExecutorAdapter, ExecutorDispatchContext } from './causal-runtime.js'
import type { JsonValue } from './events.js'
import { handoffPolicySchema } from './memory.js'
import { executorManifestSchema, opSpecSchema, type ExecutorManifest, type OpSpec } from './ports.js'

/** Which bad case to inject. Absent means it returns normally. */
export type Injection = 'timeout' | 'transport' | 'hang'

export const SET_LIGHT: OpSpec = opSpecSchema.parse({
  name: 'set_light',
  description: '设置指定房间的灯光亮度',
  params: {
    type: 'object',
    properties: {room: {type: 'string'}, brightness: {type: 'integer'}},
    required: ['room', 'brightness'],
  },
  readonly: false,
  deadline_budget: 10,
})

export const GET_STATE: OpSpec = opSpecSchema.parse({
  name: 'get_state',
  description: '读取指定房间当前的灯光状态',
  params: {type: 'object', properties: {room: {type: 'string'}}, required: ['room']},
  readonly: true,
  deadline_budget: 5,
  // The light's actual brightness IS the result of that set_light call, so reading it
  // back can settle an unknown conclusively.
  verifies: ['set_light'],
})

export const fastSimManifest: ExecutorManifest = executorManifestSchema.parse({
  name: 'fast_sim',
  ops: [SET_LIGHT, GET_STATE],
  policy: handoffPolicySchema.parse({
    channel: 'fast_sim', priority: 50, wake: 'fast', typical_latency: 0.05,
    compress_watermark: 20,
  }),
})

export const slowSimManifest: ExecutorManifest = executorManifestSchema.parse({
  name: 'slow_sim',
  ops: [SET_LIGHT, GET_STATE],
  policy: handoffPolicySchema.parse({
    channel: 'slow_sim', priority: 50, wake: 'fast', typical_latency: 5,
    compress_watermark: 20,
  }),
})

const JSON_TYPE_CHECKS: Readonly<Record<string, (value: JsonValue) => boolean>> = {
  string: value => typeof value === 'string',
  integer: value => typeof value === 'number' && Number.isInteger(value),
  number: value => typeof value === 'number' && Number.isFinite(value),
  boolean: value => typeof value === 'boolean',
  object: value => typeof value === 'object' && value !== null && !Array.isArray(value),
  array: value => Array.isArray(value),
}

/**
 * Validate a request against an op's params schema; an empty list means it passes.
 *
 * Only `required` and the top-level type are checked. This layer exists so that
 * `brightness: "very dim"` cannot sail through as `outcome=ok`, which would swap the
 * "outcome unknown" failure mode for a false success report -- worse than not validating
 * at all. Validation lives in the adapter, so each executor pays for its own.
 */
export function checkParams(
  schema: Readonly<Record<string, JsonValue>>,
  request: Readonly<Record<string, JsonValue>>,
): string[] {
  const problems: string[] = []
  const required = schema.required
  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key === 'string' && !(key in request)) problems.push(`缺少必填参数 ${key}`)
    }
  }
  const properties = schema.properties
  if (typeof properties === 'object' && properties !== null && !Array.isArray(properties)) {
    for (const [key, spec] of Object.entries(properties)) {
      if (!(key in request)) continue
      if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) continue
      const declared = spec.type
      if (typeof declared !== 'string') continue
      const check = JSON_TYPE_CHECKS[declared]
      if (check === undefined) continue
      const value = request[key]!
      // Python guards bool against integer because bool subclasses int there. The same
      // rejection is kept so both runtimes refuse `brightness: true` identically.
      const isBooleanForNumber = typeof value === 'boolean'
        && (declared === 'integer' || declared === 'number')
      if (isBooleanForNumber || !check(value)) problems.push(`${key} 应为 ${declared}`)
    }
  }
  return problems
}

export interface SimHandoff {
  readonly outcome: 'ok' | 'refused' | 'unknown' | 'failed'
  readonly trust: 'trusted_system'
  readonly content: Readonly<Record<string, JsonValue>>
}

/**
 * Only the three result fields are filled in here. Identity -- delegate id, channel,
 * origin_ref -- is bound by the core, so a simulator never gets the chance to get it
 * wrong and does not need to read its context for that.
 */
function handoff(
  outcome: SimHandoff['outcome'],
  content: Readonly<Record<string, JsonValue>>,
): SimHandoff {
  return {outcome, trust: 'trusted_system', content}
}

/** Shared implementation. The simulators differ only in latency and injection. */
abstract class Sim implements ExecutorAdapter {
  readonly manifest: ExecutorManifest
  protected readonly latency: number

  protected constructor(manifest: ExecutorManifest, latency: number) {
    this.manifest = manifest
    this.latency = latency
  }

  async dispatch(
    op: string,
    request: Readonly<Record<string, JsonValue>>,
    context: ExecutorDispatchContext,
  ): Promise<SimHandoff> {
    const spec = this.manifest.ops.find(candidate => candidate.name === op)
    if (spec === undefined) {
      // A hallucinated op is a failed observation, not an exception.
      return handoff('failed', {error: 'unknown_op', op})
    }
    const problems = checkParams(spec.params, request)
    if (problems.length > 0) {
      return handoff('failed', {error: 'invalid_params', problems})
    }
    return this.run(spec, request, context)
  }

  protected async run(
    spec: OpSpec,
    request: Readonly<Record<string, JsonValue>>,
    context: ExecutorDispatchContext,
  ): Promise<SimHandoff> {
    await context.clock.sleep(this.latency, context.signal)
    return handoff('ok', {op: spec.name, ...request})
  }
}

/** Returns in milliseconds, so FastBrain should dispatch silently when eta is short. */
export class FastSim extends Sim {
  constructor(options: {readonly latency?: number} = {}) {
    super(fastSimManifest, options.latency ?? 0.05)
  }
}

/** Controllable delay, and can inject a timeout, a transport error, or a hang. */
export class SlowSim extends Sim {
  readonly #inject: Injection | undefined

  constructor(options: {readonly latency?: number, readonly inject?: Injection} = {}) {
    super(slowSimManifest, options.latency ?? 5)
    this.#inject = options.inject
  }

  protected override async run(
    spec: OpSpec,
    request: Readonly<Record<string, JsonValue>>,
    context: ExecutorDispatchContext,
  ): Promise<SimHandoff> {
    if (this.#inject === 'hang') {
      // Does not even return its own timeout. Only the core's deadline timer can stop it.
      await context.clock.sleep(Number.POSITIVE_INFINITY, context.signal)
    }
    await context.clock.sleep(this.latency, context.signal)
    if (this.#inject === 'timeout') {
      // A timeout is not evidence that this did not happen: whether the light was set is
      // genuinely unknown.
      return handoff('unknown', {error: 'adapter_timeout', op: spec.name})
    }
    if (this.#inject === 'transport') {
      return handoff('unknown', {error: 'transport_error', op: spec.name})
    }
    return handoff('ok', {op: spec.name, ...request})
  }
}

export const simManifestRegistry = [fastSimManifest, slowSimManifest] as const

/** Build the simulator named by configuration, or nothing if it is not a simulator. */
export function buildSimulator(
  name: string,
  options: {readonly clock?: Clock} = {},
): ExecutorAdapter | undefined {
  void options
  if (name === 'fast_sim') return new FastSim()
  if (name === 'slow_sim') return new SlowSim()
  return undefined
}
