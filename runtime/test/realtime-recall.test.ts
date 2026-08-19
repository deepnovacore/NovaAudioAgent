/**
 * The Node leg of the recall parity suite.
 *
 * Replays the committed scenarios through the real `compileMemoryRecall` and compares against the
 * bytes `scripts/recall_oracle.py` exported. Recall decides which memories a model is shown, so both
 * the selection and the encoded envelope have to match exactly -- the encoding is text a model reads,
 * not an internal representation.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { canonicalJson } from '../src/canonical-json.js'
import { Memory, makeMemoryRef, type HandoffPolicy } from '../src/memory.js'
import {
  RecallOriginError,
  compileMemoryRecall,
  encodeMemoryRecall,
  type RecallScope,
  type RecallView,
} from '../src/realtime/recall.js'

const fixtureRoot = resolve(import.meta.dirname, '../../../fixtures/realtime/recall/v1')

interface ScenarioItem {
  readonly channel: string
  readonly ts: number
  readonly trust: 'trusted_user' | 'trusted_system' | 'untrusted_external'
  readonly priority: number
  readonly content: Record<string, unknown>
  readonly outcome?: 'ok' | 'unknown' | 'failed'
}

interface Scenario {
  readonly name: string
  readonly covers: readonly string[]
  readonly query: string
  readonly scope: RecallScope
  readonly before_ref: string
  readonly channels: readonly {readonly name: string}[]
  readonly items: readonly ScenarioItem[]
  readonly encode_budgets?: readonly number[]
}

const scenarios = (
  JSON.parse(readFileSync(resolve(fixtureRoot, 'scenarios.json'), 'utf8')) as {
    readonly scenarios: readonly Scenario[]
  }
).scenarios

const golden = JSON.parse(
  readFileSync(resolve(fixtureRoot, 'scenarios-expected.json'), 'utf8'),
) as {readonly scenarios: readonly Record<string, unknown>[]}

function buildMemory(scenario: Scenario): Memory {
  // Recall reads items and never consults a policy, so the fields beyond the channel name are
  // placeholders chosen to be valid, matching the oracle's construction.
  const policies: HandoffPolicy[] = scenario.channels
    .filter(channel => channel.name !== 'conversation')
    .map(channel => ({
      channel: channel.name,
      priority: 50,
      wake: 'none',
      typical_latency: 1,
      compress_watermark: 100,
      suggest: false,
      progress_via_surrogate: false,
    }))
  const memory = new Memory({policies})
  for (const item of scenario.items) {
    memory.append(item.channel, {
      ts: item.ts,
      trust: item.trust,
      priority: item.priority,
      content: item.content as never,
      ...(item.outcome === undefined ? {} : {outcome: item.outcome}),
    })
  }
  return memory
}

function runScenario(scenario: Scenario): Record<string, unknown> {
  let view: RecallView
  try {
    view = compileMemoryRecall(buildMemory(scenario), {
      query: scenario.query,
      scope: scenario.scope,
      beforeRef: scenario.before_ref,
    })
  } catch (cause) {
    // The oracle distinguishes an origin rejection from a plain value error, because they mean
    // different things to a caller: one is a boundary violation, the other a malformed argument.
    const kind = cause instanceof RecallOriginError ? 'origin' : 'value'
    return {name: scenario.name, error: {kind, message: (cause as Error).message}}
  }

  const encodings = (scenario.encode_budgets ?? [3000]).map(maxChars => {
    try {
      return {max_chars: maxChars, encoded: encodeMemoryRecall(view, {maxChars})}
    } catch (cause) {
      return {max_chars: maxChars, error: (cause as Error).message}
    }
  })
  return {
    name: scenario.name,
    view: {
      state: view.state,
      scope: view.scope,
      raw_scanned: view.raw_scanned,
      searched_count: view.searched_count,
      scan_truncated: view.scan_truncated,
      omitted: view.omitted,
      hits: view.hits.map(hit => ({
        ref: hit.ref,
        channel: hit.channel,
        ts: hit.ts,
        trust: hit.trust,
        outcome: hit.outcome,
        match: hit.match,
        evidence: hit.evidence,
      })),
    },
    encodings,
  }
}

test('every committed scenario matches the Python-exported golden', () => {
  // Collected rather than failing on the first, because one divergence in scoring or tie-breaking
  // shows up in several scenarios and knowing which ones is most of the diagnosis.
  const mismatched: string[] = []
  for (const [index, scenario] of scenarios.entries()) {
    const actual = runScenario(scenario)
    const expected = golden.scenarios[index]
    if (canonicalJson(actual) !== canonicalJson(expected)) mismatched.push(scenario.name)
  }
  assert.deepEqual(mismatched, [], 'Node recall differs from the Python golden')
})

test('the golden records one result per scenario, in order', () => {
  assert.deepEqual(
    golden.scenarios.map(entry => entry.name),
    scenarios.map(scenario => scenario.name),
  )
})

test('a query outside one to five hundred and twelve characters is refused', () => {
  const memory = new Memory()
  memory.append('conversation', {
    ts: 1,
    trust: 'trusted_user',
    priority: 100,
    content: {text: 'a turn'},
  })
  const beforeRef = makeMemoryRef('conversation', 1)
  for (const query of ['', '   ', 'x'.repeat(513)]) {
    assert.throws(
      () => compileMemoryRecall(memory, {query, scope: 'recent', beforeRef}),
      RangeError,
      JSON.stringify(query.slice(0, 12)),
    )
  }
  // The bound is on the trimmed query, and 512 is inside it.
  assert.doesNotThrow(() => compileMemoryRecall(memory, {
    query: 'x'.repeat(512),
    scope: 'recent',
    beforeRef,
  }))
})

test('an unknown scope is refused rather than treated as one of the two', () => {
  const memory = new Memory()
  memory.append('conversation', {
    ts: 1,
    trust: 'trusted_user',
    priority: 100,
    content: {text: 'a turn'},
  })
  assert.throws(
    () => compileMemoryRecall(memory, {
      query: 'anything',
      scope: 'everything' as RecallScope,
      beforeRef: makeMemoryRef('conversation', 1),
    }),
    /scope must be/u,
  )
})

test('a non-positive encoding budget is refused', () => {
  const view: RecallView = {
    state: 'empty',
    scope: 'recent',
    raw_scanned: 0,
    searched_count: 0,
    scan_truncated: false,
    hits: [],
    omitted: 0,
  }
  for (const maxChars of [0, -1]) {
    // The message is spelled as the oracle spells it, because the golden records it.
    assert.throws(() => encodeMemoryRecall(view, {maxChars}), /max_chars must be positive/u)
  }
})

test('the encoded envelope is measured in code points, not UTF-16 units', () => {
  // An astral character costs two UTF-16 units and one code point. Python measures with `len`, so
  // budgeting by `String.length` would drop a hit the oracle keeps.
  const memory = new Memory()
  memory.append('conversation', {
    ts: 1,
    trust: 'trusted_system',
    priority: 50,
    content: {text: `${'\u{1f600}'.repeat(20)} compile`},
  })
  memory.append('conversation', {
    ts: 2,
    trust: 'trusted_user',
    priority: 100,
    content: {text: 'asking'},
  })
  const view = compileMemoryRecall(memory, {
    query: 'compile',
    scope: 'recent',
    beforeRef: makeMemoryRef('conversation', 2),
  })
  assert.equal(view.hits.length, 1)
  const encoded = encodeMemoryRecall(view)
  const codePoints = [...encoded].length
  assert.ok(encoded.length > codePoints, 'the envelope must contain astral characters')
  // A budget between the two measures has to be judged by code points, so the hit survives.
  assert.doesNotThrow(() => encodeMemoryRecall(view, {maxChars: codePoints}))
})
