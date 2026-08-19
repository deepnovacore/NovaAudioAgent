import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { canonicalJson } from '../src/canonical-json.js'
import type { JsonValue } from '../src/events.js'
import {
  QwenAudioRealtimeAdapter,
  QwenSocketClosedError,
  type QwenSocket,
} from '../src/realtime/qwen.js'

const fixtureRoot = resolve(import.meta.dirname, '../../../fixtures/realtime/qwen/v1')

interface Scenario {
  readonly id: string
  readonly covers: string
  readonly frames: readonly Record<string, JsonValue>[]
}

interface NormalizationFixture {
  readonly schema_version: number
  readonly handshake: readonly Record<string, JsonValue>[]
  readonly scenarios: readonly Scenario[]
}

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(fixtureRoot, name), 'utf8')) as T
}

/** Serves scripted frames, then reports EOF the way a closed transport does. */
function scriptedSocket(frames: readonly Record<string, JsonValue>[]): QwenSocket {
  const pending = [...frames]
  return {
    // Explicit promises rather than async bodies: nothing here awaits, and the EOF
    // signal must reject the promise, not throw synchronously into the read loop.
    send: () => Promise.resolve(),
    receive: () => {
      const next = pending.shift()
      return next === undefined
        ? Promise.reject(new QwenSocketClosedError())
        : Promise.resolve(JSON.stringify(next))
    },
    close: () => Promise.resolve(),
  }
}

function identityFactory(): () => string {
  let sequence = 0
  return () => {
    sequence += 1
    return `id-${sequence}`
  }
}

async function replay(
  handshake: readonly Record<string, JsonValue>[],
  frames: readonly Record<string, JsonValue>[],
): Promise<JsonValue[]> {
  const socket = scriptedSocket([...handshake, ...frames])
  const adapter = new QwenAudioRealtimeAdapter({
    url: 'wss://example.invalid/realtime',
    apiKey: 'fixture-key',
    model: 'fixture-model',
    voice: 'fixture-voice',
    connector: () => Promise.resolve(socket),
    idFactory: identityFactory(),
  })
  const stop = new AbortController()
  await adapter.connect({tools: [], signal: stop.signal})
  const observed: JsonValue[] = []
  for await (const event of adapter.events(stop.signal)) {
    const record: Record<string, JsonValue> = {}
    for (const [key, value] of Object.entries(event)) {
      record[key] = key === 'pcm' ? [...(value as Uint8Array)] : (value as JsonValue)
    }
    observed.push(record)
  }
  await adapter.close()
  return observed
}

test('Qwen frame normalization matches the Python-exported golden byte for byte', async () => {
  const fixture = loadJson<NormalizationFixture>('normalization.json')
  const expected = loadJson<{
    readonly schema_version: number
    readonly scenarios: Readonly<Record<string, JsonValue>>
  }>('normalization-expected.json')

  assert.equal(fixture.schema_version, expected.schema_version)
  assert.ok(fixture.scenarios.length > 0)

  const produced: Record<string, JsonValue> = {}
  for (const scenario of fixture.scenarios) {
    produced[scenario.id] = await replay(fixture.handshake, scenario.frames)
  }

  // Compare whole documents by canonical bytes, so a missing or extra scenario is
  // a failure rather than a silently skipped row.
  assert.equal(
    canonicalJson({schema_version: fixture.schema_version, scenarios: produced}),
    canonicalJson({schema_version: expected.schema_version, scenarios: expected.scenarios}),
  )
})

test('every normalization scenario documents what it covers and is exercised', () => {
  const fixture = loadJson<NormalizationFixture>('normalization.json')
  const expected = loadJson<{readonly scenarios: Record<string, unknown[]>}>(
    'normalization-expected.json',
  )
  const ids = fixture.scenarios.map(scenario => scenario.id)
  assert.deepEqual([...ids].sort(), Object.keys(expected.scenarios).sort())
  for (const scenario of fixture.scenarios) {
    assert.ok(scenario.covers.length > 0, `${scenario.id} must say what it covers`)
    assert.ok(scenario.frames.length > 0, `${scenario.id} must script at least one frame`)
  }
})
