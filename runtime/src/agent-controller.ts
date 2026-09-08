/**
 * Host-owned agent control surface.
 *
 * Runtime executors keep their channel identities. Controllers are the separate public agent
 * boundary: they decide how one user-authorized host tool becomes executor work, while their
 * descriptors provide the only public agent roster the model and desktop can see.
 */
import {z} from 'zod'
import {types as nodeTypes} from 'node:util'
import type {JsonValue} from './events.js'

export interface AgentDescriptor {
  readonly name: string
  readonly summary: string
  readonly ownedChannels: readonly string[]
}

export interface AgentDispatchRequest {
  readonly instruction: string
  readonly originalUserText: string
  readonly origin_ref: string
  readonly sessionEpoch: number
  readonly acceptedUserInputRevision: number
  readonly stillWanted: () => boolean
}

export interface AgentCancelRequest {
  readonly instruction?: string
  readonly originalUserText: string
  readonly origin_ref: string
  readonly sessionEpoch: number
  readonly acceptedUserInputRevision: number
  readonly stillWanted: () => boolean
}

/** The smallest runtime capability a controller may use to start owned executor work. */
export interface AgentRuntimeDispatchPort {
  dispatch(request: {
    readonly channel: string
    readonly op: string
    readonly request: Readonly<Record<string, JsonValue>>
    readonly origin_ref: string
    readonly stillWanted: () => boolean
  }): {readonly accepted: boolean; readonly delegate_id: string | null}
    | Promise<{readonly accepted: boolean; readonly delegate_id: string | null}>
}

/** Stable controller outcome codes are host facts; the service owns all user-facing wording. */
const agentIdentifierSchema = z.string().min(1).max(128)
const noDetailSchema = z.object({}).strict()
const agentWorkSchema = z.object({
  work_id: agentIdentifierSchema,
  project: z.string().min(1).max(80),
  title: z.string().min(1).max(120),
}).strict()
const intakeStateSchema = z.enum([
  'open', 'clarifying', 'ready_to_plan', 'planning', 'readback', 'committing', 'closed',
])
const visionChannelSchema = z.enum(['watch', 'guard'])

/**
 * Closed controller facts. Adding a future controller variant requires adding one exact arm here and
 * its service projection; no controller may smuggle prose or arbitrary JSON through `detail`.
 */
export const agentActionResultSchema = z.discriminatedUnion('code', [
  z.object({code: z.literal('accepted'), accepted: z.literal(true), detail: noDetailSchema}).strict(),
  z.object({
    code: z.literal('delegated'), accepted: z.literal(true), delegate_id: agentIdentifierSchema,
    detail: z.object({channel: agentIdentifierSchema, op: agentIdentifierSchema}).strict(),
  }).strict(),
  z.object({
    code: z.literal('intake_opened'), accepted: z.literal(true),
    detail: z.object({state: intakeStateSchema}).strict(),
  }).strict(),
  z.object({
    code: z.literal('intake_in_progress'), accepted: z.literal(true),
    detail: z.object({state: intakeStateSchema}).strict(),
  }).strict(),
  z.object({
    code: z.literal('cancelled'), accepted: z.literal(true),
    detail: z.object({work: agentWorkSchema}).strict(),
  }).strict(),
  z.object({code: z.literal('not_running'), accepted: z.literal(true), detail: noDetailSchema}).strict(),
  z.object({code: z.literal('busy'), accepted: z.literal(true), detail: noDetailSchema}).strict(),
  z.object({code: z.literal('clarification_required'), accepted: z.literal(true), detail: noDetailSchema}).strict(),
  z.object({code: z.literal('assessment_unavailable'), accepted: z.literal(false), detail: noDetailSchema}).strict(),
  z.object({
    code: z.literal('monitor_stop_requested'), accepted: z.literal(true),
    detail: z.object({channel: visionChannelSchema, op: z.literal('stop')}).strict(),
  }).strict(),
  z.object({
    code: z.literal('ambiguous_work'), accepted: z.literal(true),
    detail: z.object({running: z.array(agentWorkSchema).min(2).max(8)}).strict(),
  }).strict(),
  z.object({code: z.literal('unsupported_tool'), accepted: z.literal(false), detail: noDetailSchema}).strict(),
  z.object({code: z.literal('superseded'), accepted: z.literal(false), detail: noDetailSchema}).strict(),
  z.object({code: z.literal('runtime_rejected'), accepted: z.literal(false), detail: noDetailSchema}).strict(),
])

export type AgentActionResult = z.infer<typeof agentActionResultSchema>
export type AgentActionCode = AgentActionResult['code']

/** Parse controller output without invoking accessors or retaining caller-owned object graphs. */
export function parseAgentActionResult(value: unknown): AgentActionResult | null {
  try {
    if (!isSafeDataTree(value, new Set<object>(), 0)) return null
    const parsed = agentActionResultSchema.safeParse(value)
    if (!parsed.success) return null
    return freezeAgentActionResult(parsed.data)
  } catch {
    return null
  }
}

export interface AgentController {
  readonly descriptor: AgentDescriptor
  dispatch(request: AgentDispatchRequest): Promise<AgentActionResult>
  cancel(request: AgentCancelRequest): Promise<AgentActionResult>
}

export interface AgentControllerRegistry {
  readonly controllers: ReadonlyMap<string, AgentController>
  readonly descriptors: readonly AgentDescriptor[]
  readonly agentNameForChannel: (channel: string) => string | null
}

export class AgentControllerRegistryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentControllerRegistryError'
  }
}

interface ManifestIdentity {
  readonly name: string
  readonly model_visibility?: 'direct' | 'hidden' | undefined
}

class ClosedReadonlyMap<K, V> implements ReadonlyMap<K, V> {
  readonly #entries: Map<K, V>

  constructor(entries: Iterable<readonly [K, V]>) {
    this.#entries = new Map(entries)
    Object.freeze(this)
  }

  get size(): number { return this.#entries.size }
  get(key: K): V | undefined { return this.#entries.get(key) }
  has(key: K): boolean { return this.#entries.has(key) }
  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#entries) callbackfn.call(thisArg, value, key, this)
  }
  entries(): IterableIterator<[K, V]> { return this.#entries.entries() }
  keys(): IterableIterator<K> { return this.#entries.keys() }
  values(): IterableIterator<V> { return this.#entries.values() }
  [Symbol.iterator](): IterableIterator<[K, V]> { return this.#entries[Symbol.iterator]() }
}

/**
 * Construct the closed public agent registry. A hidden executor may retain runtime bindings, but it
 * cannot exist without exactly one controller claiming its channel.
 */
export function createAgentControllerRegistry(input: {
  readonly controllers: readonly AgentController[]
  readonly manifests: readonly ManifestIdentity[]
}): AgentControllerRegistry {
  const manifestNames = new Set<string>()
  const hidden = new Set<string>()
  for (const manifest of input.manifests) {
    if (manifestNames.has(manifest.name)) {
      throw new AgentControllerRegistryError(`duplicate registered manifest: ${manifest.name}`)
    }
    manifestNames.add(manifest.name)
    if (manifest.model_visibility === 'hidden') hidden.add(manifest.name)
  }

  const controllers = new Map<string, AgentController>()
  const channelOwners = new Map<string, string>()
  const descriptors: AgentDescriptor[] = []
  for (const source of input.controllers) {
    const descriptor = cloneDescriptor(source.descriptor)
    if (descriptor.name.trim() === '') throw new AgentControllerRegistryError('agent name must not be blank')
    if (descriptor.summary.trim() === '') throw new AgentControllerRegistryError(`agent summary must not be blank: ${descriptor.name}`)
    if (descriptor.ownedChannels.length === 0) {
      throw new AgentControllerRegistryError(`agent must own at least one channel: ${descriptor.name}`)
    }
    if (controllers.has(descriptor.name)) {
      throw new AgentControllerRegistryError(`duplicate agent name: ${descriptor.name}`)
    }
    if (typeof source.dispatch !== 'function' || typeof source.cancel !== 'function') {
      throw new AgentControllerRegistryError(`agent controller must implement dispatch and cancel: ${descriptor.name}`)
    }
    const dispatch = source.dispatch.bind(source)
    const cancel = source.cancel.bind(source)
    const controller: AgentController = Object.freeze({
      descriptor,
      dispatch: (request: AgentDispatchRequest) => dispatch.call(source, request),
      cancel: (request: AgentCancelRequest) => cancel.call(source, request),
    })
    controllers.set(descriptor.name, controller)
    descriptors.push(descriptor)
    for (const channel of descriptor.ownedChannels) {
      if (!manifestNames.has(channel)) {
        throw new AgentControllerRegistryError(`owned channel '${channel}' has no registered manifest`)
      }
      if (!hidden.has(channel)) {
        throw new AgentControllerRegistryError(`owned channel '${channel}' must be hidden`)
      }
      const owner = channelOwners.get(channel)
      if (owner !== undefined) {
        throw new AgentControllerRegistryError(`duplicate owned channel '${channel}': ${owner}, ${descriptor.name}`)
      }
      channelOwners.set(channel, descriptor.name)
    }
  }
  for (const channel of hidden) {
    if (!channelOwners.has(channel)) {
      throw new AgentControllerRegistryError(`hidden executor '${channel}' has no owning controller`)
    }
  }

  return Object.freeze({
    controllers: new ClosedReadonlyMap(controllers),
    descriptors: Object.freeze([...descriptors]),
    agentNameForChannel: (channel: string): string | null => channelOwners.get(channel) ?? null,
  })
}

function cloneDescriptor(value: AgentDescriptor): AgentDescriptor {
  return Object.freeze({
    name: value.name,
    summary: value.summary,
    ownedChannels: Object.freeze([...value.ownedChannels]),
  })
}

function freezeAgentActionResult(value: AgentActionResult): AgentActionResult {
  const noDetail = (): Readonly<Record<string, never>> => Object.freeze({})
  if (value.code === 'delegated') return Object.freeze({
    ...value,
    detail: Object.freeze({channel: value.detail.channel, op: value.detail.op}),
  })
  if (value.code === 'intake_opened' || value.code === 'intake_in_progress') return Object.freeze({
    ...value,
    detail: Object.freeze({state: value.detail.state}),
  })
  if (value.code === 'cancelled') return Object.freeze({
    ...value,
    detail: Object.freeze({work: Object.freeze({...value.detail.work})}),
  })
  if (value.code === 'ambiguous_work') return Object.freeze({
    ...value,
    detail: Object.freeze({running: Object.freeze(value.detail.running.map(work => Object.freeze({...work})))}),
  }) as AgentActionResult
  if (value.code === 'monitor_stop_requested') return Object.freeze({
    ...value,
    detail: Object.freeze({channel: value.detail.channel, op: value.detail.op}),
  })
  return Object.freeze({...value, detail: noDetail()})
}

function isSafeDataTree(value: unknown, seen: Set<object>, depth: number): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || depth > 4 || seen.has(value)) return false
  try {
    if (nodeTypes.isProxy(value)) return false
  } catch {
    return false
  }
  seen.add(value)
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (!Object.hasOwn(descriptors, 'length') || Reflect.ownKeys(descriptors).length !== value.length + 1) return false
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index)
      if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
        || !isSafeDataTree(descriptor.value, seen, depth + 1)) return false
    }
    return true
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') return false
    const descriptor = descriptors[key]
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
      || !isSafeDataTree(descriptor.value, seen, depth + 1)) return false
  }
  return true
}
