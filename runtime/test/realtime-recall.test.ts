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

function oneTurnMemory(): {readonly memory: Memory; readonly beforeRef: string} {
  const memory = new Memory()
  memory.append('conversation', {
    ts: 1,
    trust: 'trusted_user',
    priority: 100,
    content: {text: 'a turn'},
  })
  return {memory, beforeRef: makeMemoryRef('conversation', 1)}
}

test('a query outside one to five hundred and twelve characters is refused', () => {
  const {memory, beforeRef} = oneTurnMemory()
  for (const query of ['', '   ', 'x'.repeat(513)]) {
    assert.throws(
      () => compileMemoryRecall(memory, {query, scope: 'recent', beforeRef}),
      RangeError,
      JSON.stringify(query.slice(0, 12)),
    )
  }
  assert.doesNotThrow(() => compileMemoryRecall(memory, {
    query: 'x'.repeat(512),
    scope: 'recent',
    beforeRef,
  }))
})

test('the query bound counts code points, as Python len does', () => {
  // An astral character is one code point and two UTF-16 units, so measuring `String.length` would
  // reject at 256 characters a query the oracle accepts at 512. The astral case is the only one that
  // separates the two measures, which is why the ASCII bound above cannot stand in for it.
  const {memory, beforeRef} = oneTurnMemory()
  const astral = '\u{1f600}'
  assert.equal(astral.repeat(512).length, 1024, 'the premise: UTF-16 units are double')

  assert.doesNotThrow(
    () => compileMemoryRecall(memory, {query: astral.repeat(512), scope: 'recent', beforeRef}),
    '512 astral code points are within the bound',
  )
  assert.throws(
    () => compileMemoryRecall(memory, {query: astral.repeat(513), scope: 'recent', beforeRef}),
    RangeError,
    '513 are not',
  )
})

test('stripping matches Python str.strip, which keeps a byte-order mark', () => {
  // `String.prototype.trim` strips U+FEFF and `str.strip()` does not, so a query of just a BOM is
  // non-empty to the oracle and empty to `trim` -- which decides whether recall runs at all.
  const {memory, beforeRef} = oneTurnMemory()
  assert.equal('\ufeff'.trim(), '', 'the premise: trim removes it')

  assert.doesNotThrow(
    () => compileMemoryRecall(memory, {query: '\ufeff', scope: 'recent', beforeRef}),
    'a BOM is a character to the oracle',
  )
  // The whitespace both agree on is still stripped, and still rejected when nothing survives.
  for (const query of [' \t\n\r ', '\u00a0', '\u2028']) {
    assert.throws(
      () => compileMemoryRecall(memory, {query, scope: 'recent', beforeRef}),
      RangeError,
      JSON.stringify(query),
    )
  }
  // And surrounding whitespace is stripped before the bound is measured.
  assert.doesNotThrow(() => compileMemoryRecall(memory, {
    query: `  ${'x'.repeat(512)}  `,
    scope: 'recent',
    beforeRef,
  }))
})

test('a lone surrogate in the envelope is refused rather than embedded raw', () => {
  // `json.dumps(ensure_ascii=False)` embeds a lone surrogate raw, producing a string that cannot be
  // encoded as UTF-8 at all -- so matching the oracle byte for byte here would mean producing bytes
  // that could never reach a provider. Refusing names the field instead.
  const view: RecallView = {
    state: 'ok',
    scope: 'recent',
    raw_scanned: 1,
    searched_count: 1,
    scan_truncated: false,
    omitted: 0,
    hits: [{
      ref: makeMemoryRef('conversation', 1),
      channel: 'conversation',
      ts: 1,
      trust: 'trusted_system',
      outcome: null,
      match: 'lexical',
      evidence: 'before \ud800 after',
    }],
  }
  assert.throws(() => encodeMemoryRecall(view), /lone surrogate/u)
  // A well-formed astral pair made of the same units is fine.
  assert.doesNotThrow(() => encodeMemoryRecall({
    ...view,
    hits: [{...view.hits[0]!, evidence: 'before \u{1f600} after'}],
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

test('a timestamp whose Python spelling is not reproducible is refused', () => {
  // `json.dumps` and JavaScript agree digit for digit below 1e16 and diverge above it: Python writes
  // `1e+16` where JavaScript writes `10000000000000000`, and their exponent forms differ anyway
  // (`1e-07` versus `1e-7`). Refusing the range is honest; guessing at `repr` would not be.
  const viewWith = (ts: number): RecallView => ({
    state: 'ok',
    scope: 'recent',
    raw_scanned: 1,
    searched_count: 1,
    scan_truncated: false,
    omitted: 0,
    hits: [{
      ref: makeMemoryRef('conversation', 1),
      channel: 'conversation',
      ts,
      trust: 'trusted_system',
      outcome: null,
      match: 'lexical',
      evidence: 'anything',
    }],
  })
  for (const ts of [1e16, 1e21, -1e16, Number.MAX_VALUE, 1e-7, -0]) {
    assert.throws(() => encodeMemoryRecall(viewWith(ts)), RangeError, `ts=${ts}`)
  }
  // The range a real timestamp lives in is fine, integral or not.
  for (const ts of [0, 1, 1.5, 1_700_000_000, 1_700_000_000.25, -1.5]) {
    assert.doesNotThrow(() => encodeMemoryRecall(viewWith(ts)), `ts=${ts}`)
  }
})

test('an integral timestamp keeps its Python float spelling, and a count does not', () => {
  // The int-versus-float distinction that made every envelope differ before it was fixed.
  const memory = new Memory()
  memory.append('conversation', {
    ts: 7,
    trust: 'trusted_system',
    priority: 50,
    content: {text: 'compile it'},
  })
  memory.append('conversation', {
    ts: 8,
    trust: 'trusted_user',
    priority: 100,
    content: {text: 'asking'},
  })
  const encoded = encodeMemoryRecall(compileMemoryRecall(memory, {
    query: 'compile',
    scope: 'recent',
    beforeRef: makeMemoryRef('conversation', 2),
  }))
  assert.ok(encoded.includes('"ts":7.0'), 'a float spells with its .0')
  assert.ok(encoded.includes('"raw_scanned":1'), 'an int does not')
  assert.ok(!encoded.includes('"raw_scanned":1.0'))
})

test('evidence needing JSON escaping is escaped as json.dumps escapes it', () => {
  // The envelope is hand-rolled to match `json.dumps(ensure_ascii=False)`, so every escape decision
  // is ours. Verified against Python across control characters, U+007F, U+00A0, U+2028, NUL,
  // quotes, backslashes, CJK and astral characters: identical on all of them.
  const memory = new Memory()
  const awkward = [
    'quote"',
    'back\\slash',
    `tab\u0009x`,
    `nul\u0000x`,
    `del\u007fx`,
    `nbsp\u00a0x`,
    `sep\u2028x`,
    '\u4e2d\u6587',
    '\u{1f600}',
  ].join(' ')
  memory.append('conversation', {
    ts: 1,
    trust: 'trusted_system',
    priority: 50,
    content: {text: `compile ${awkward}`},
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
  const encoded = encodeMemoryRecall(view)
  // Round-tripping proves the escaping is valid JSON; the committed golden proves it is Python's.
  const parsed = JSON.parse(encoded) as {hits: {evidence: string}[]}
  assert.equal(parsed.hits.length, 1)
  // Non-ASCII stays literal, as `ensure_ascii=False` leaves it.
  assert.ok(encoded.includes('\u4e2d\u6587'))
  assert.ok(!encoded.includes('\\u4e2d'))
})

test('the python-only whitespace list is exactly what the two predicates disagree about', () => {
  // Derived rather than trusted. Python strips a code point when `str.isspace()` is true; the only
  // way to reproduce that from JavaScript is `trim()` plus the code points it misses, minus the one
  // it adds. If a future engine changes `trim`, this fails instead of the strip silently drifting.
  const trimStrips = (codePoint: number): boolean => String.fromCodePoint(codePoint).trim() === ''
  // Python's `str.isspace()` set, measured against CPython 15.0.0.
  const pythonSpace = new Set([
    0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
    0x85, 0xa0, 0x1680,
    0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
    0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
  ])

  const pythonOnly: number[] = []
  const trimOnly: number[] = []
  for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue
    const inPython = pythonSpace.has(codePoint)
    const inTrim = trimStrips(codePoint)
    if (inPython && !inTrim) pythonOnly.push(codePoint)
    if (inTrim && !inPython) trimOnly.push(codePoint)
  }
  assert.deepEqual(pythonOnly, [0x1c, 0x1d, 0x1e, 0x1f, 0x85])
  assert.deepEqual(trimOnly, [0xfeff])
})

test('recall strips what Python strips, in both directions', () => {
  // The five Python-only code points would otherwise stay attached, changing the query length and
  // its first token; U+FEFF would otherwise be removed, making a BOM-only query empty here and
  // non-empty in the oracle.
  const memory = new Memory()
  memory.append('conversation', {
    ts: 1,
    trust: 'trusted_system',
    priority: 50,
    content: {text: 'compile the runtime'},
  })
  memory.append('conversation', {
    ts: 2,
    trust: 'trusted_user',
    priority: 100,
    content: {text: 'asking'},
  })
  const beforeRef = makeMemoryRef('conversation', 2)
  const baseline = compileMemoryRecall(memory, {query: 'compile', scope: 'recent', beforeRef})
  assert.equal(baseline.hits.length, 1, 'the premise: the bare query matches')

  for (const space of ['\u001c', '\u001d', '\u001e', '\u001f', '\u0085']) {
    const wrapped = compileMemoryRecall(memory, {
      query: `${space}compile${space}`,
      scope: 'recent',
      beforeRef,
    })
    assert.equal(
      wrapped.hits.length,
      1,
      `U+${space.codePointAt(0)!.toString(16)} must be stripped like Python does`,
    )
  }
  // And the bound counts the stripped query: 512 plus surrounding Python-whitespace is still fine.
  assert.doesNotThrow(() => compileMemoryRecall(memory, {
    query: `\u001c${'x'.repeat(512)}\u0085`,
    scope: 'recent',
    beforeRef,
  }))
})
