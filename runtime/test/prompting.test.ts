import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import type { ContextView } from '../src/context-view.js'
import {
  COMPRESSOR_SYSTEM,
  FASTBRAIN_LIVE_SYSTEM,
  FASTBRAIN_SYSTEM,
  SURROGATE_SYSTEM,
  pythonFixedOne,
  pythonFloat,
  renderContextSnapshot,
} from '../src/prompting.js'

const fixtureRoot = resolve(import.meta.dirname, '../../../fixtures/prompting/v1')
const graphFixtureRoot = resolve(import.meta.dirname, '../../../fixtures/workspace-graph')

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(fixtureRoot, name), 'utf8')) as T
}

interface Fixture {
  readonly schema_version: number
  readonly scenarios: readonly {
    readonly id: string
    readonly covers: string
    readonly view: ContextView
  }[]
}

interface Golden {
  readonly schema_version: number
  readonly float_renderings: Readonly<Record<string, string>>
  readonly fixed_one_renderings: Readonly<Record<string, string>>
  readonly systems: Readonly<Record<string, string>>
  readonly rendered: Readonly<Record<string, {readonly plain: string, readonly with_trigger: string}>>
}

interface GraphGolden {
  readonly schema_version: number
  readonly cases: readonly {
    readonly id: string
    readonly expected: {
      readonly header: string | null
      readonly recall_pack: string | null
      readonly omitted_preferences: number
      readonly omitted_hints: number
      readonly degraded: boolean
      readonly diagnostic: 'graph_context_omitted_budget' | null
      readonly rendered_plain: string
      readonly rendered_with_trigger: string
    }
  }[]
}

test('every system prompt is character-identical to the Python oracle', () => {
  const golden = loadJson<Golden>('context-views-expected.json')
  assert.equal(FASTBRAIN_SYSTEM, golden.systems.fastbrain)
  assert.equal(FASTBRAIN_LIVE_SYSTEM, golden.systems.fastbrain_live)
  assert.equal(SURROGATE_SYSTEM, golden.systems.surrogate)
  assert.equal(COMPRESSOR_SYSTEM, golden.systems.compressor)
  // Guard the premise: an empty golden would compare equal to an empty constant.
  assert.ok(FASTBRAIN_SYSTEM.split('\n').length >= 15)
  assert.ok(FASTBRAIN_LIVE_SYSTEM.split('\n').length >= 30)
})

test('the explicit Codex live profile uses the same adaptive clarification threshold', () => {
  // Break caught: the live profile bypasses the frontend policy by requiring every apparently
  // executable coding request to call codex.run in the same turn.
  assert.match(
    FASTBRAIN_LIVE_SYSTEM,
    /新的编码任务.*可执行目标.*实质范围.*成功标准或验证方式/su,
  )
  assert.match(FASTBRAIN_LIVE_SYSTEM, /只有动作词和宽泛对象.*先追问.*不得调用 codex.run/su)
  assert.match(FASTBRAIN_LIVE_SYSTEM, /具体故障或目标行为.*范围.*验证方式.*调用 codex.run/su)
  assert.doesNotMatch(FASTBRAIN_LIVE_SYSTEM, /明确且可直接执行.*同一轮.*codex\.run/su)
})

test('rendered ContextViews match the Python oracle byte for byte', () => {
  const fixture = loadJson<Fixture>('context-views.json')
  const golden = loadJson<Golden>('context-views-expected.json')
  assert.equal(fixture.schema_version, golden.schema_version)
  assert.ok(fixture.scenarios.length > 0)
  assert.deepEqual(
    fixture.scenarios.map(scenario => scenario.id).sort(),
    Object.keys(golden.rendered).sort(),
  )

  for (const scenario of fixture.scenarios) {
    const expected = golden.rendered[scenario.id]
    assert.ok(expected !== undefined, scenario.id)
    assert.equal(
      renderContextSnapshot(scenario.view, false),
      expected.plain,
      `${scenario.id} (plain): ${scenario.covers}`,
    )
    assert.equal(
      renderContextSnapshot(scenario.view, true),
      expected.with_trigger,
      `${scenario.id} (with_trigger): ${scenario.covers}`,
    )
  }
})


test('Python str(float) is reproduced for every prompt timestamp boundary', () => {
  // Python switches to exponential at 1e16 and below 1e-4 and pads the exponent to two
  // digits; JavaScript switches at 1e21 and 1e-7 and does not pad. Every rendered
  // timestamp goes through this, so the boundaries are pinned by the oracle.
  const golden = loadJson<Golden>('context-views-expected.json')
  const vectors = loadJson<{readonly float_vectors: readonly number[]}>('context-views.json')
  assert.ok(vectors.float_vectors.length >= 15)

  for (const value of vectors.float_vectors) {
    // The golden is keyed by Python repr(); look the rendering up by its value.
    const rendered = pythonFloat(value)
    const matches = Object.entries(golden.float_renderings)
      .filter(([key]) => Number(key) === value && (key.startsWith('-') === (Object.is(value, -0)
        || value < 0)))
      .map(([, expected]) => expected)
    assert.ok(matches.length > 0, `no golden rendering for ${String(value)}`)
    assert.equal(rendered, matches[0], `pythonFloat(${String(value)})`)
  }
})


test('Python .1f half-even rounding is reproduced for the media age', () => {
  // toFixed rounds half away from zero, so an exactly representable midpoint diverges:
  // 2.25 is 2.2 in Python and 2.3 with toFixed. The golden decides.
  const golden = loadJson<Golden>('context-views-expected.json')
  const vectors = loadJson<{readonly fixed_one_vectors: readonly number[]}>(
    'context-views.json',
  )
  assert.ok(vectors.fixed_one_vectors.length >= 10)

  let sawMidpoint = false
  for (const value of vectors.fixed_one_vectors) {
    const matches = Object.entries(golden.fixed_one_renderings)
      .filter(([key]) => Number(key) === value)
      .map(([, expected]) => expected)
    assert.ok(matches.length > 0, `no golden .1f for ${String(value)}`)
    assert.equal(pythonFixedOne(value), matches[0], `.1f(${String(value)})`)
    if (value === 2.25) {
      sawMidpoint = true
      // Guard the premise: this vector must actually distinguish the two rules.
      assert.equal(matches[0], '2.2')
      assert.equal(value.toFixed(1), '2.3')
    }
  }
  assert.ok(sawMidpoint, 'the exact-midpoint vector must be present')
})

test('Node-owned graph-present goldens render after materials and before intent', () => {
  const fixture = loadJson<Fixture>('context-views.json')
  const empty = fixture.scenarios.find(scenario => scenario.id === 'empty-view')
  assert.ok(empty !== undefined)
  const graphGolden = JSON.parse(readFileSync(
    resolve(graphFixtureRoot, 'context-blocks.json'),
    'utf8',
  )) as GraphGolden
  assert.equal(graphGolden.schema_version, 1)
  assert.ok(graphGolden.cases.length > 0)

  for (const scenario of graphGolden.cases) {
    const graph = {
      header: scenario.expected.header,
      recall_pack: scenario.expected.recall_pack,
      omitted_preferences: scenario.expected.omitted_preferences,
      omitted_hints: scenario.expected.omitted_hints,
      degraded: scenario.expected.degraded,
      diagnostic: scenario.expected.diagnostic,
    } as const
    const view: ContextView = {...empty.view, graph_context: graph}
    const plain = renderContextSnapshot(view, false)
    const withTrigger = renderContextSnapshot(view, true)
    assert.equal(plain, scenario.expected.rendered_plain, `${scenario.id} plain`)
    assert.equal(withTrigger, scenario.expected.rendered_with_trigger, `${scenario.id} trigger`)
    assert.ok(plain.indexOf('## 现在手边的素材') < plain.indexOf('<workspace_context'))
    assert.ok(plain.indexOf('</workspace_hints>') < plain.indexOf('## 意图'))
  }
})

test('an explicit null graph context leaves prompt bytes identical to the absent fixture', () => {
  const fixture = loadJson<Fixture>('context-views.json')
  const empty = fixture.scenarios.find(scenario => scenario.id === 'empty-view')
  assert.ok(empty !== undefined)
  assert.equal(
    renderContextSnapshot({...empty.view, graph_context: null}),
    renderContextSnapshot(empty.view),
  )
})
