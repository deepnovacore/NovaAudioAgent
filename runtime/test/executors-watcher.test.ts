/**
 * The Node leg of the Watch/Guard parity suite.
 *
 * Two pinned surfaces. The **verdict parser** reads model output about a camera frame, which is
 * `untrusted_external` by definition — a hit must show something, a miss must say nothing, and neither
 * is repaired, because a repaired verdict is one whose meaning this code chose. The **state machine**
 * is the debounce: a hit moves to cooling and re-arming takes two consecutive misses, since a subject
 * that briefly leaves the frame has not stopped being there.
 *
 * The loop's timing is not in the golden — it is asyncio there and promises here, and a fixture over it
 * would compare two schedulers. What the golden pins is the sequence of states a run of verdicts
 * produces; the loop itself is exercised by Node tests below with a virtual clock.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { canonicalJson } from '../src/canonical-json.js'
import { VirtualClock } from '../src/clock.js'
import { MediaStore } from '../src/media-store.js'
import {
  WatchAdapter,
  parseWatchVerdict,
  normalizeStartForTest,
  printableForTest,
  printableTextForTest,
  type Frame,
  type FrameSource,
  type ModelGatewayLike,
} from '../src/executors/watcher.js'

const fixtureRoot = resolve(import.meta.dirname, '../../../fixtures/executors/watcher/v1')

interface Case {
  readonly name: string
  readonly kind: string
  readonly text?: string
  readonly request?: Record<string, unknown>
  readonly value?: string
  readonly allow_empty?: boolean
  readonly verdicts?: readonly boolean[]
}

const document = JSON.parse(readFileSync(resolve(fixtureRoot, 'cases.json'), 'utf8')) as {
  readonly cases: readonly Case[]
}
const golden = JSON.parse(readFileSync(resolve(fixtureRoot, 'cases-expected.json'), 'utf8')) as {
  readonly cases: readonly Record<string, unknown>[]
}

/**
 * Drive a run of verdicts through the *real* transition code.
 *
 * An earlier version of this replayed the four rules here, which meant the golden compared the test
 * file against itself -- three state-machine mutations were invisible to it. The adapter exposes the
 * transition directly instead, so the loop's scheduler stays out of the fixture without the behaviour
 * following it out.
 */
function replayStateMachine(verdicts: readonly boolean[]): readonly Record<string, unknown>[] {
  const {adapter, ctx} = harness()
  return verdicts.map((hit, index) => {
    const {announced, status} = adapter.applyVerdictForTest(hit, ctx)
    return {
      step: index,
      hit,
      announced,
      state: status.state,
      hit_count: status.hit_count,
      reset_count: status.reset_count,
    }
  })
}

function runCase(spec: Case): Record<string, unknown> {
  switch (spec.kind) {
    case 'verdict':
      try {
        const verdict = parseWatchVerdict(spec.text!)
        return {hit: verdict.hit, observation: verdict.observation}
      } catch {
        return {error: 'invalid verdict'}
      }
    case 'normalize_start': {
      const normalized = normalizeStartForTest(spec.request!)
      return {
        normalized: normalized === null
          ? null
          : {
            condition: normalized.condition,
            interval_s: normalized.intervalS,
            duration_s: normalized.durationS,
          },
      }
    }
    case 'printable':
      return {
        printable: printableForTest(spec.value!),
        printable_text: printableTextForTest(spec.value!, {
          allowEmpty: spec.allow_empty ?? false,
        }),
      }
    case 'state_machine':
      return {steps: replayStateMachine(spec.verdicts ?? [])}
    default:
      throw new Error(`unsupported case kind: ${spec.kind}`)
  }
}

test('every watcher case matches the Python-exported golden', () => {
  const divergent: string[] = []
  for (const [index, spec] of document.cases.entries()) {
    const actual = {name: spec.name, ...runCase(spec)}
    const expected = golden.cases[index]
    if (canonicalJson(actual) !== canonicalJson(expected)) {
      divergent.push(
        `${spec.name}\n    python: ${canonicalJson(expected)}\n    node:   ${canonicalJson(actual)}`,
      )
    }
  }
  assert.deepEqual(divergent, [], 'watcher behaviour differs from the oracle')
})

test('the golden records one result per case, in order', () => {
  assert.deepEqual(
    golden.cases.map(entry => entry.name),
    document.cases.map(spec => spec.name),
  )
})

test('the verdict set refuses more than it accepts', () => {
  // The parser reads untrusted model output. A set that mostly accepted would pass with every shape
  // check deleted.
  const verdicts = golden.cases.filter(entry => 'hit' in entry || 'error' in entry)
  const refused = verdicts.filter(entry => 'error' in entry).length
  assert.ok(refused >= 15, `only ${refused} refusals`)
  assert.ok(verdicts.length - refused >= 5)
})

/** A frame source that hands out one canned frame, or fails a scripted number of times first. */
function frameSource(
  options: {readonly failures?: number; readonly pattern?: readonly boolean[]} = {},
): FrameSource {
  let remaining = options.failures ?? 0
  // An explicit pattern (true = this snapshot fails) is what distinguishes a consecutive counter from
  // a cumulative one. `failures: n` alone cannot: n consecutive and n cumulative are the same run.
  const pattern = options.pattern
  let step = 0
  return {
    snapshot: (): Promise<Frame> => {
      if (pattern !== undefined) {
        const fails = pattern[step] ?? false
        step += 1
        if (fails) return Promise.reject(new Error('camera unavailable'))
      } else if (remaining > 0) {
        remaining -= 1
        return Promise.reject(new Error('camera unavailable'))
      }
      return Promise.resolve({
        payload: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
        media_type: 'image/jpeg',
        width: 640,
        height: 480,
        captured_at: 1,
      })
    },
  }
}

/** A gateway that answers with a scripted sequence of verdicts, repeating the last one. */
function gateway(verdicts: readonly (boolean | 'error' | 'malformed')[]): ModelGatewayLike {
  let index = 0
  return {
    complete: (): Promise<{readonly text: string}> => {
      const verdict = verdicts[Math.min(index, verdicts.length - 1)]
      index += 1
      if (verdict === 'error') return Promise.reject(new Error('gateway down'))
      if (verdict === 'malformed') return Promise.resolve({text: 'not json'})
      return Promise.resolve({
        text: verdict
          ? '{"hit": true, "observation": "有人"}'
          : '{"hit": false, "observation": ""}',
      })
    },
  }
}

interface Harness {
  readonly adapter: WatchAdapter
  readonly observations: {readonly trust: string; readonly content: Record<string, unknown>}[]
  readonly progress: {readonly elapsed: number; readonly summary: string | null}[]
  readonly clock: VirtualClock
  readonly ctx: Parameters<WatchAdapter['dispatch']>[2]
}

let frameIdSequence = 0
function nextFrameId(): string {
  frameIdSequence += 1
  return `frame-${frameIdSequence}`
}

/**
 * Drive a running window until it settles, with a bound.
 *
 * A window that never terminates makes an `await run` hang, and a hung test is the worst failure mode
 * available: it starves the whole suite, and a mutation sweep cannot tell it apart from a crashed
 * runner. An off-by-one in the capture-failure threshold produced exactly that. So the pumping is
 * bounded and a window that outlives the bound fails by name.
 */
async function settle<T>(run: Promise<T>, clock: VirtualClock, rounds = 40): Promise<T> {
  // Wrap rather than race against a sentinel value: a window whose own result could equal the
  // sentinel would otherwise read as settled. The box is unforgeable.
  const settled: {value: T}[] = []
  void run.then(value => settled.push({value}))
  for (let round = 0; round <= rounds; round += 1) {
    await new Promise<void>(resolve => setTimeout(resolve, 1))
    const done = settled[0]
    if (done !== undefined) return done.value
    clock.advanceTo(clock.now() + 3)
  }
  assert.fail(`window did not settle within ${rounds} sampling rounds`)
}

function harness(options: {
  readonly verdicts?: readonly (boolean | 'error' | 'malformed')[]
  readonly captureFailures?: number
  readonly capturePattern?: readonly boolean[]
  readonly captureEnabled?: boolean
  readonly manifestName?: string
  readonly withoutObserve?: boolean
  readonly mediaStore?: MediaStore
} = {}): Harness {
  const clock = new VirtualClock()
  const observations: {readonly trust: string; readonly content: Record<string, unknown>}[] = []
  const progress: {readonly elapsed: number; readonly summary: string | null}[] = []
  const adapter = new WatchAdapter({
    manifestName: options.manifestName ?? 'watch',
    source: frameSource(
      options.capturePattern === undefined
        ? {failures: options.captureFailures ?? 0}
        : {pattern: options.capturePattern},
    ),
    gateway: gateway(options.verdicts ?? [false]),
    // Distinct ids: a constant factory makes the store's collision retry spin, which is a real
    // hazard the store now refuses rather than a licence for the harness to be lazy.
    mediaStore: options.mediaStore ?? new MediaStore(1_024 * 1_024, {idFactory: nextFrameId}),
    model: 'test-model',
    captureEnabled: options.captureEnabled ?? true,
  })
  const ctx = {
    clock,
    ...(options.withoutObserve === true
      ? {}
      : {observe: (payload: {trust: string; content: Record<string, unknown>}) => {
        observations.push(payload)
      }}),
    progress: (payload: {elapsed: number; summary: string | null}) => {
      progress.push(payload)
    },
  }
  return {adapter, observations, progress, clock, ctx}
}

test('status reports the window without needing it to be running', async () => {
  const {adapter, ctx} = harness()
  const handoff = await adapter.dispatch('status', {}, ctx)
  assert.equal(handoff.outcome, 'ok')
  assert.equal(handoff.trust, 'trusted_system')
  assert.equal(handoff.content.state, 'idle')
  assert.equal(handoff.content.condition, null)
})

test('stop distinguishes stopping something from stopping nothing', async () => {
  // The model needs to tell "I stopped it" from "there was nothing to stop", or it will report having
  // ended a window that was never running.
  const {adapter, ctx} = harness()
  const idle = await adapter.dispatch('stop', {}, ctx)
  assert.equal(idle.content.stopped, false)
})

test('an unknown op and a malformed request are refused as failures, not unknowns', async () => {
  // `failed` means do not retry: the request itself is wrong, and repeating it changes nothing.
  const {adapter, ctx} = harness()
  for (const [op, request] of [
    ['fetch', {}],
    ['status', {extra: 1}],
    ['stop', {extra: 1}],
    ['start', {condition: ''}],
    ['start', {condition: 'c', interval_s: 100}],
  ] as const) {
    const handoff = await adapter.dispatch(op, request, ctx)
    assert.equal(handoff.outcome, 'failed', `${op} ${JSON.stringify(request)}`)
    assert.equal(handoff.trust, 'trusted_system')
  }
})

test('a window with no capture or no observation channel reports unknown, not failed', async () => {
  // Neither is the caller's mistake, so neither is `failed` — the model may reasonably try again once
  // the camera or the channel is back.
  const noCapture = harness({captureEnabled: false})
  const a = await noCapture.adapter.dispatch('start', {condition: 'c'}, noCapture.ctx)
  assert.equal(a.outcome, 'unknown')
  assert.equal(a.content.error, 'capture_unavailable')

  const noObserve = harness({withoutObserve: true})
  const b = await noObserve.adapter.dispatch('start', {condition: 'c'}, noObserve.ctx)
  assert.equal(b.outcome, 'unknown')
  assert.equal(b.content.error, 'observation_unavailable')
})

test('a hit stores the frame and announces it with a citable ref', async () => {
  // The media ref is the evidence. A hit the user cannot look at is a claim with nothing behind it.
  const store = new MediaStore(1_024 * 1_024, {idFactory: () => 'frame-1'})
  const {adapter, observations, ctx, clock} = harness({verdicts: [true], mediaStore: store})
  const run = adapter.dispatch('start', {condition: '有人', duration_s: 30}, ctx)
  // Let the first sample land, then end the window.
  await new Promise<void>(resolve => setTimeout(resolve, 5))
  clock.advanceTo(100)
  adapter.interruptForTest()
  await settle(run, clock)

  const hit = observations.find(entry => entry.content.state === 'hit')
  assert.ok(hit, 'the hit was announced')
  assert.equal(hit.trust, 'untrusted_external', 'the model said it about a picture')
  assert.equal(hit.content.media_ref, 'media:frame-1')
  assert.equal(hit.content.observation, '有人')
  assert.equal(store.size, 1, 'and the frame is retrievable')
})

test('a lifecycle observation is trusted_system, because it is the host describing itself', async () => {
  const {adapter, observations, ctx, clock} = harness({verdicts: [false]})
  const run = adapter.dispatch('start', {condition: 'c', duration_s: 30}, ctx)
  await new Promise<void>(resolve => setTimeout(resolve, 5))
  clock.advanceTo(100)
  adapter.interruptForTest()
  await settle(run, clock)
  const armed = observations.find(entry => entry.content.state === 'armed')
  assert.ok(armed)
  assert.equal(armed.trust, 'trusted_system')
  // The first `armed` carries no reset count: nothing has been reset yet.
  assert.equal('reset_count' in armed.content, false)
})

test('the terminal never reports a hit, whatever the window saw', async () => {
  // It describes the window closing. A terminal that could carry a hit would let the end of a session
  // be mistaken for the event it was watching for.
  const {adapter, ctx, clock} = harness({verdicts: [true]})
  const run = adapter.dispatch('start', {condition: 'c', duration_s: 30}, ctx)
  await new Promise<void>(resolve => setTimeout(resolve, 5))
  clock.advanceTo(100)
  adapter.interruptForTest()
  const handoff = await settle(run, clock)
  assert.equal(handoff.outcome, 'ok')
  assert.equal(handoff.content.hit, false)
  assert.equal(handoff.content.hit_count, 1, 'though it reports how many there were')
})

test('three consecutive capture failures end the window, and a recovery resets the count', async () => {
  // Consecutive, not cumulative: an intermittent camera recovers, and counting cumulatively would end
  // most long sessions early.
  const {adapter, ctx, clock} = harness({captureFailures: 3})
  const handoff = await settle(
    adapter.dispatch('start', {condition: 'c', duration_s: 1800, interval_s: 2}, ctx),
    clock,
  )
  assert.equal(handoff.outcome, 'unknown')
  assert.equal(handoff.content.error, 'capture_unavailable')
})

test('capture failures must be consecutive: an intermittent camera does not end the window', async () => {
  // Two failures, a success, two more failures. Five failures in total but never three in a row, so a
  // cumulative counter would give up here and a consecutive one must not.
  const {adapter, ctx, clock} = harness({
    capturePattern: [true, true, false, true, true, false],
    verdicts: [false],
  })
  const run = adapter.dispatch('start', {condition: 'c', duration_s: 30, interval_s: 2}, ctx)
  await new Promise<void>(resolve => setTimeout(resolve, 5))
  const handoff = await settle(run, clock)
  // It ran to its own end rather than reporting the camera gone.
  assert.notEqual(handoff.content.error, 'capture_unavailable')
})

test('three consecutive verdict failures end the window as vlm_unavailable', async () => {
  // The classifier failing is a different budget from the camera failing, and its own threshold.
  const {adapter, ctx, clock} = harness({verdicts: ['error', 'error', 'error', false]})
  const handoff = await settle(
    adapter.dispatch('start', {condition: 'c', duration_s: 1800, interval_s: 2}, ctx),
    clock,
  )
  assert.equal(handoff.outcome, 'unknown')
  assert.equal(handoff.content.error, 'vlm_unavailable')
})

test('a running window refuses a second start rather than sharing the camera', async () => {
  const {adapter, ctx, clock} = harness({verdicts: [false]})
  const run = adapter.dispatch('start', {condition: 'c', duration_s: 30}, ctx)
  await new Promise<void>(resolve => setTimeout(resolve, 5))
  const second = await adapter.dispatch('start', {condition: 'other'}, ctx)
  assert.equal(second.outcome, 'failed')
  assert.equal(second.content.error, 'busy')
  clock.advanceTo(100)
  adapter.interruptForTest()
  await settle(run, clock)
})

test('ports may not be swapped under a running window', async () => {
  // A verdict about one scene attributed to a condition armed against another is worse than a refusal.
  const {adapter, ctx, clock} = harness({verdicts: [false]})
  const run = adapter.dispatch('start', {condition: 'c', duration_s: 30}, ctx)
  await new Promise<void>(resolve => setTimeout(resolve, 5))
  assert.throws(
    () => adapter.configureObservationPorts({source: frameSource(), gateway: gateway([false])}),
    /only change while idle/u,
  )
  clock.advanceTo(100)
  adapter.interruptForTest()
  await settle(run, clock)
  assert.doesNotThrow(
    () => adapter.configureObservationPorts({source: frameSource(), gateway: gateway([false])}),
    'and allowed once idle',
  )
})

test('watch and guard are the same logic behind different manifests', () => {
  // The urgency is a policy decision — guard wakes the fast brain, watch goes through the Surrogate —
  // and duplicating the monitoring logic to express that would be two things to keep in step.
  for (const name of ['watch', 'guard']) {
    assert.doesNotThrow(() => new WatchAdapter({
      manifestName: name,
      source: frameSource(),
      gateway: gateway([false]),
      mediaStore: new MediaStore(),
      model: 'm',
      captureEnabled: true,
    }))
  }
  assert.throws(() => new WatchAdapter({
    manifestName: 'other',
    source: frameSource(),
    gateway: gateway([false]),
    mediaStore: new MediaStore(),
    model: 'm',
    captureEnabled: true,
  }), /必须是 watch 或 guard/u)
})
