import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, test } from 'node:test'
import type { EventRecord } from '../src/events.js'
import { canonicalJson, replayTrace, TraceWriter } from '../src/trace.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async path => rm(path, {
    recursive: true,
    force: true,
  })))
})

test('trace round trip preserves exact records and truncates a reused file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-trace-'))
  temporaryDirectories.push(directory)
  const path = join(directory, 'trace.jsonl')
  const user: EventRecord = {
    seq: 1,
    ts: 0,
    kind: 'user_input',
    payload: {text: 'hello'},
  }
  const deadline: EventRecord = {
    seq: 1,
    ts: 5,
    kind: 'deadline',
    payload: {delegate_id: 'd-1'},
  }

  using first = new TraceWriter(path)
  first.write(user)
  first.close()
  using second = new TraceWriter(path)
  second.write(deadline)
  second.close()

  assert.deepEqual(replayTrace(path), [deadline])
  assert.equal((await readFile(path, 'utf8')).trim(), canonicalJson(deadline))
})

test('canonical JSON sorts nested keys without rewriting array order', () => {
  assert.equal(
    canonicalJson({z: 1, nested: {b: true, a: false}, values: [2, 1]}),
    '{"nested":{"a":false,"b":true},"values":[2,1],"z":1}',
  )
})

test('canonical JSON uses Python code-point ordering even for integer-like keys', () => {
  assert.equal(
    canonicalJson({'10': 10, '2': 2, A: 1, _: 2, a: 3, '\u{10000}': 4, '\uE000': 5}),
    '{"10":10,"2":2,"A":1,"_":2,"a":3,"":5,"𐀀":4}',
  )
})

test('canonical JSON pins cross-language number bytes by JSON numeric value', () => {
  assert.equal(
    canonicalJson({large: 1e20, negative_zero: -0, small: 1e-7}),
    '{"large":100000000000000000000,"negative_zero":0,"small":1e-7}',
  )
})

test('canonical JSON matches the shared cross-language vectors', () => {
  const path = resolve(
    import.meta.dirname,
    '../../../fixtures/runtime/canonical-json-vectors.json',
  )
  const vectors = JSON.parse(readFileSync(path, 'utf8')) as {
    readonly id: string
    readonly value: unknown
    readonly canonical: string
  }[]
  for (const vector of vectors) {
    assert.equal(canonicalJson(vector.value), vector.canonical, vector.id)
  }
})

test('canonical JSON and trace writes reject non-finite values', async () => {
  assert.throws(() => canonicalJson({bad: Number.NaN}))

  const directory = await mkdtemp(join(tmpdir(), 'nova-trace-'))
  temporaryDirectories.push(directory)
  const path = join(directory, 'trace.jsonl')
  using writer = new TraceWriter(path)
  const event: EventRecord = {
    seq: 1,
    ts: 0,
    kind: 'handoff',
    payload: {
      channel: 'slow_sim',
      delegate_id: 'd-1',
      origin_ref: 'conversation:1',
      outcome: 'ok',
      trust: 'trusted_system',
      content: {probability: Number.POSITIVE_INFINITY},
      refs: [],
    },
  }
  assert.throws(() => writer.write(event))
})

test('trace rejects raw prompt fields before writing any payload bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-trace-'))
  temporaryDirectories.push(directory)
  const path = join(directory, 'trace.jsonl')
  using writer = new TraceWriter(path)
  const event = {
    seq: 1,
    ts: 0,
    kind: 'model_done',
    payload: {
      slot: 'fast',
      job_id: 'job-1',
      raw_prompt: 'fixture-private-raw-prompt-sentinel',
    },
  } as unknown as EventRecord

  assert.throws(() => writer.write(event))
  assert.doesNotMatch(await readFile(path, 'utf8'), /fixture-private-raw-prompt-sentinel/u)
})
