import {readFile, realpath} from 'node:fs/promises'
import {isAbsolute, relative, resolve} from 'node:path'
import {z} from 'zod'

import {canonicalJson} from './canonical-json.js'
import {loadRuntimeFixture} from './fixtures.js'
import {runRuntimeFixture} from './fixture-host.js'
import {fixtureManifestRegistry} from './sim.js'

export const DEMO_NAMES = ['async', 'dual-axis', 'timeout', 'proactive', 'all'] as const
export type DemoName = typeof DEMO_NAMES[number]
type ConcreteDemoName = Exclude<DemoName, 'all'>

export interface DemoResult {
  readonly name: ConcreteDemoName
  readonly passed: boolean
  readonly detail_code: string
}

const demoCaseSchema = z.object({
  name: z.enum(['async', 'dual-axis', 'timeout', 'proactive']),
  scenario: z.string().min(1),
  detail_code: z.string().min(1),
  expected: z.object({
    name: z.enum(['async', 'dual-axis', 'timeout', 'proactive']),
    passed: z.literal(true),
    detail_code: z.string().min(1),
  }).strict(),
}).strict()

const demoDocumentSchema = z.object({
  schema_version: z.literal(1),
  names: z.tuple([
    z.literal('async'),
    z.literal('dual-axis'),
    z.literal('timeout'),
    z.literal('proactive'),
    z.literal('all'),
  ]),
  cases: z.array(demoCaseSchema).length(4),
}).strict()

export async function runDemo(name: ConcreteDemoName, fixtureRoot: string): Promise<DemoResult> {
  const root = await realpath(fixtureRoot)
  const document = demoDocumentSchema.parse(JSON.parse(
    await readFile(resolve(root, 'demos.json'), 'utf8'),
  ))
  const configured = document.cases.find(item => item.name === name)
  if (configured === undefined) throw new Error('unknown demo')
  const scenarioRoot = resolve(root, 'demos/scenarios')
  const directory = await realpath(resolve(scenarioRoot, configured.scenario))
  const inside = relative(root, directory)
  if (inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error('demo scenario must stay inside the product fixture root')
  }
  const fixture = await loadRuntimeFixture(directory)
  const actual = runRuntimeFixture(fixture, fixtureManifestRegistry)
  if (canonicalJson(actual) !== canonicalJson(fixture.expected)) {
    throw new Error(`fixture parity mismatch: ${fixture.manifest.id}`)
  }
  const passed = verify(name, actual)
  return Object.freeze({
    name,
    passed,
    detail_code: passed ? configured.detail_code : 'demo_invariant_failed',
  })
}

export async function runDemos(
  names: readonly DemoName[],
  fixtureRoot: string,
): Promise<readonly DemoResult[]> {
  const expanded: ConcreteDemoName[] = []
  for (const name of names) {
    if (!DEMO_NAMES.includes(name)) throw new Error('unknown demo')
    const selected: readonly ConcreteDemoName[] = name === 'all'
      ? ['async', 'dual-axis', 'timeout', 'proactive']
      : [name]
    for (const item of selected) {
      if (!expanded.includes(item)) expanded.push(item)
    }
  }
  return Object.freeze(await Promise.all(expanded.map(name => runDemo(name, fixtureRoot))))
}

function verify(name: ConcreteDemoName, output: unknown): boolean {
  if (!isRecord(output)) return false
  if (name === 'async') return verifyAsync(output)
  if (name === 'dual-axis') return verifyDualAxis(output)
  if (name === 'timeout') return verifyTimeout(output)
  return verifyProactive(output)
}

function verifyAsync(output: Record<string, unknown>): boolean {
  const events = records(output.applied_events)
  const effects = records(output.executor_effects)
  const dispatch = effects.find(item => item.kind === 'dispatch')
  const delegate = isRecord(dispatch?.delegate) ? dispatch.delegate : null
  const dispatchedAt = numberValue(delegate?.dispatched_at)
  const handoff = events.find(item => item.kind === 'handoff')
  const handoffAt = numberValue(handoff?.ts)
  const laterUser = events.find(item => item.kind === 'user_input'
    && numberValue(item.ts) > dispatchedAt)
  const userAt = numberValue(laterUser?.ts)
  const laterCompletion = events.find(item => item.kind === 'model_done'
    && numberValue(item.ts) >= userAt && numberValue(item.ts) < handoffAt)
  const liveView = records(output.model_views).some(item => {
    const view = isRecord(item.view) ? item.view : null
    return numberValue(view?.now) === userAt && records(view?.in_flight).length > 0
  })
  return dispatch !== undefined && Number.isFinite(dispatchedAt)
    && laterUser !== undefined && laterCompletion !== undefined
    && handoff !== undefined && handoffAt > userAt && liveView
}

function verifyDualAxis(output: Record<string, unknown>): boolean {
  const dispatch = records(output.executor_effects).find(item => item.kind === 'dispatch')
  const delegate = isRecord(dispatch?.delegate) ? dispatch.delegate : null
  const dispatchedAt = numberValue(delegate?.dispatched_at)
  const memory = isRecord(output.memory) ? output.memory : null
  const channels = isRecord(memory?.channels) ? memory.channels : null
  const conversation = records(channels?.conversation)
  const speech = conversation.find(item => item.trust === 'trusted_system'
    && numberValue(item.ts) === dispatchedAt
    && isRecord(item.content)
    && typeof item.content.text === 'string'
    && item.content.text !== '')
  return dispatch !== undefined && speech !== undefined
}

function verifyTimeout(output: Record<string, unknown>): boolean {
  const memory = isRecord(output.memory) ? output.memory : null
  const channels = isRecord(memory?.channels) ? memory.channels : null
  const slow = records(channels?.slow_sim)
  const unknown = slow.find(item => item.outcome === 'unknown')
  const lateOk = slow.find(item => item.outcome === 'ok')
  const noFailed = !slow.some(item => item.outcome === 'failed')
  const events = records(output.applied_events)
  const deadline = events.find(item => item.kind === 'deadline')
  const handoff = events.find(item => item.kind === 'handoff')
  return unknown !== undefined && lateOk !== undefined && noFailed
    && numberValue(unknown.ts) < numberValue(lateOk.ts)
    && numberValue(deadline?.ts) < numberValue(handoff?.ts)
}

function verifyProactive(output: Record<string, unknown>): boolean {
  const fired = records(output.suggestions).some(item => item.id === 's-1' && item.status === 'fired')
  const views = records(output.model_views)
  const offered = views.some(item => item.slot === 'surrogate.watch'
    && records(isRecord(item.view) ? item.view.affordances : undefined)
      .some(affordance => affordance.source === 'suggestion' && affordance.ref === 's-1'))
  const selected = views.some(item => item.slot === 'fast'
    && records(isRecord(item.view) ? item.view.affordances : undefined)
      .some(affordance => affordance.source === 'suggestion'
        && affordance.ref === 's-1'
        && isRecord(affordance.content)
        && affordance.content.selected === true))
  const memory = isRecord(output.memory) ? output.memory : null
  const channels = isRecord(memory?.channels) ? memory.channels : null
  const spoke = records(channels?.conversation).some(item => item.trust === 'trusted_system'
    && isRecord(item.content) && typeof item.content.text === 'string' && item.content.text !== '')
  return offered && selected && fired && spoke
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberValue(value: unknown): number {
  return typeof value === 'number' ? value : Number.NaN
}
