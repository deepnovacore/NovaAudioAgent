/**
 * Host-owned agent control surface.
 *
 * Runtime executors keep their channel identities. Controllers are the separate public agent
 * boundary: they decide how one user-authorized host tool becomes executor work, while their
 * descriptors provide the only public agent roster the model and desktop can see.
 */
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

/** Stable controller outcome codes are host facts; the service owns all user-facing wording. */
export type AgentActionCode =
  | 'accepted'
  | 'delegated'
  | 'intake_opened'
  | 'intake_in_progress'
  | 'cancelled'
  | 'not_running'
  | 'ambiguous_work'
  | 'unsupported_tool'
  | 'superseded'

export interface AgentActionResult {
  readonly code: AgentActionCode
  readonly accepted: boolean
  readonly delegate_id?: string
  /** Bounded, structured host facts only; never user-facing prose. */
  readonly detail: Readonly<Record<string, JsonValue>>
}

export interface AgentController {
  readonly descriptor: AgentDescriptor
  dispatch(request: AgentDispatchRequest): Promise<AgentActionResult>
  cancel(request: AgentCancelRequest): Promise<AgentActionResult>
}

export interface AgentControllerRegistry {
  readonly controllers: ReadonlyMap<string, AgentController>
  readonly descriptors: readonly AgentDescriptor[]
  agentNameForChannel(channel: string): string | null
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
  for (const controller of input.controllers) {
    const descriptor = controller.descriptor
    if (descriptor.name.trim() === '') throw new AgentControllerRegistryError('agent name must not be blank')
    if (descriptor.summary.trim() === '') throw new AgentControllerRegistryError(`agent summary must not be blank: ${descriptor.name}`)
    if (descriptor.ownedChannels.length === 0) {
      throw new AgentControllerRegistryError(`agent must own at least one channel: ${descriptor.name}`)
    }
    if (controllers.has(descriptor.name)) {
      throw new AgentControllerRegistryError(`duplicate agent name: ${descriptor.name}`)
    }
    controllers.set(descriptor.name, controller)
    descriptors.push(descriptor)
    for (const channel of descriptor.ownedChannels) {
      if (!manifestNames.has(channel)) {
        throw new AgentControllerRegistryError(`owned channel '${channel}' has no registered manifest`)
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
    controllers,
    descriptors: Object.freeze([...descriptors]),
    agentNameForChannel: (channel: string): string | null => channelOwners.get(channel) ?? null,
  })
}
