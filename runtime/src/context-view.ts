import type { JsonValue } from './events.js'
import { canonicalJson } from './canonical-json.js'
import type { FloorState } from './floor.js'
import {
  CONVERSATION_CHANNEL,
  type Memory,
  type MemoryItem,
  type MemoryRef,
  type StructuredState,
} from './memory.js'
import type { Delegate, ExecutorManifest } from './ports.js'
import { isSuggestionAvailable, type Suggestion } from './suggestions.js'
import {
  cloneGraphContext,
  type GraphContext,
} from './workspace-graph/context.js'

export const RECENT_LIMIT = 5
export const FRESH_WINDOW = 30

export interface InFlightView {
  readonly delegate_id: string
  readonly what: string
  readonly origin_ref: MemoryRef
  readonly dispatched_at: number
  readonly eta: number
  readonly deadline: number
  readonly routing_class: string
}

export interface Affordance {
  readonly source: 'suggestion' | 'unresolved_question' | 'channel_update' | 'probe'
  readonly ref: string
  readonly content: Readonly<Record<string, JsonValue>>
  readonly conclusive: boolean | null
}

export interface ChannelView {
  readonly name: string
  readonly summary: string | null
  readonly recent: readonly MemoryItem[]
  readonly omitted: number
}

export interface ContextView {
  readonly structured: StructuredState
  readonly channels: readonly ChannelView[]
  readonly in_flight: readonly InFlightView[]
  readonly affordances: readonly Affordance[]
  readonly floor: FloorState
  readonly now: number
  readonly trigger_kind: string | null
  readonly graph_context?: GraphContext | null
}

export function compileContextView(
  memory: Memory,
  floor: FloorState,
  now: number,
  options: {
    readonly inFlight?: readonly Delegate[]
    readonly suggestions?: readonly Suggestion[]
    readonly manifests?: readonly ExecutorManifest[]
    readonly selectedSuggestion?: string | null
    readonly triggerKind?: string | null
    readonly freshWindow?: number
    readonly graphContext?: GraphContext | null
  } = {},
): ContextView {
  const channels = [...memory.channels.values()].map(channel => ({
    name: channel.name,
    summary: channel.summary,
    recent: channel.items.slice(-RECENT_LIMIT),
    omitted: Math.max(channel.items.length - RECENT_LIMIT, 0),
  }))
  const inFlight = [...(options.inFlight ?? [])]
    .sort(compareDelegates)
    .map(delegate => compileInFlight(delegate, memory))
  const affordances = [
    ...compileProbes(channels, options.manifests ?? []),
    ...compileSuggestions(
      options.suggestions ?? [],
      now,
      options.selectedSuggestion ?? null,
    ),
    ...compileUnresolved(memory.structured),
    ...compileUpdates(channels, now, options.freshWindow ?? FRESH_WINDOW),
  ]

  const graphContext = options.graphContext
  return {
    structured: structuredClone(memory.structured),
    channels: structuredClone(channels),
    in_flight: structuredClone(inFlight),
    affordances: structuredClone(affordances),
    floor,
    now,
    trigger_kind: options.triggerKind ?? null,
    ...(graphContext === undefined || graphContext === null
      ? {}
      : {graph_context: cloneGraphContext(graphContext)}),
  }
}

function compileProbes(
  channels: readonly ChannelView[],
  manifests: readonly ExecutorManifest[],
): Affordance[] {
  const manifestsByName = new Map(manifests.map(manifest => [manifest.name, manifest]))
  const output: Affordance[] = []
  for (const channel of channels) {
    const manifest = manifestsByName.get(channel.name)
    if (manifest === undefined) continue
    for (const item of channel.recent) {
      if (item.outcome !== 'unknown') continue
      for (const operation of manifest.ops) {
        if (!operation.readonly) continue
        output.push({
          source: 'probe',
          ref: makeItemReference(item),
          content: {
            executor: manifest.name,
            op: operation.name,
            unknown: structuredClone(item.content),
          },
          conclusive: operation.verifies.includes(
            typeof item.content.op === 'string' ? item.content.op : '',
          ),
        })
      }
    }
  }
  return output
}

function compileSuggestions(
  suggestions: readonly Suggestion[],
  now: number,
  selected: string | null,
): Affordance[] {
  return suggestions.flatMap(suggestion => {
    if (!isSuggestionAvailable(suggestion, now)) return []
    if (selected !== null && suggestion.id !== selected) return []
    const content: Record<string, JsonValue> = {
      kind: suggestion.kind,
      salience: suggestion.salience,
      evidence_refs: [...suggestion.evidence_refs],
      suggestion: structuredClone(suggestion.content),
    }
    if (suggestion.id === selected) content.selected = true
    return [{
      source: 'suggestion' as const,
      ref: suggestion.id,
      content,
      conclusive: null,
    }]
  })
}

function compileUnresolved(structured: StructuredState): Affordance[] {
  return structured.intent.unresolved_questions.map((question, index) => ({
    source: 'unresolved_question',
    ref: `intent.q${index}`,
    content: {question},
    conclusive: null,
  }))
}

function compileUpdates(
  channels: readonly ChannelView[],
  now: number,
  freshWindow: number,
): Affordance[] {
  const output: Affordance[] = []
  for (const channel of channels) {
    if (channel.name === CONVERSATION_CHANNEL || channel.recent.length === 0) continue
    const item = channel.recent.at(-1)!
    if (now - item.ts > freshWindow) continue
    output.push({
      source: 'channel_update',
      ref: makeItemReference(item),
      content: {
        channel: channel.name,
        ts: item.ts,
        outcome: item.outcome,
        observation: structuredClone(item.content),
      },
      conclusive: null,
    })
  }
  return output
}

function compileInFlight(delegate: Delegate, memory: Memory): InFlightView {
  const policy = memory.policies.get(delegate.executor)
  if (policy === undefined) throw new Error(`missing policy for delegate executor: ${delegate.executor}`)
  return {
    delegate_id: delegate.delegate_id,
    what: describeDelegate(delegate),
    origin_ref: delegate.origin_ref,
    dispatched_at: delegate.dispatched_at,
    eta: delegate.dispatched_at + policy.typical_latency,
    deadline: delegate.deadline,
    routing_class: delegate.routing_class,
  }
}

function describeDelegate(delegate: Delegate): string {
  return `${delegate.executor}.${delegate.op}(${canonicalJson(delegate.request)})`
}

function makeItemReference(item: MemoryItem): MemoryRef {
  return `${item.channel}:${item.seq}`
}

function compareDelegates(left: Delegate, right: Delegate): number {
  return left.dispatched_at - right.dispatched_at
    || compareStrings(left.delegate_id, right.delegate_id)
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
