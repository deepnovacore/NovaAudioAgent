import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { VirtualClock } from '../src/clock.js'
import { jsonValueSchema } from '../src/events.js'
import { JsonlTelemetry, NullTelemetry } from '../src/realtime/telemetry.js'

test('JSONL telemetry uses the injected clock and is readable before close', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-telemetry-'))
  t.after(async () => rm(directory, {recursive: true, force: true}))
  const path = join(directory, 'telemetry.jsonl')
  const clock = new VirtualClock(5)
  const telemetry = new JsonlTelemetry(path, {clock})

  telemetry.record('provider.response_started', {response_id: 'response-1'})
  assert.equal((await readFile(path, 'utf8')).split('\n').length, 2)
  clock.advanceTo(6.5)
  telemetry.record('renderer.ack', {kind: 'playback_started', t_render_ms: 120.5})
  telemetry.close()
  telemetry.close()

  const records = (await readFile(path, 'utf8')).trim().split('\n')
    .map(line => jsonValueSchema.parse(JSON.parse(line) as unknown))
  assert.deepEqual(records, [
    {ts: 5, kind: 'provider.response_started', payload: {response_id: 'response-1'}},
    {ts: 6.5, kind: 'renderer.ack', payload: {kind: 'playback_started', t_render_ms: 120.5}},
  ])
  assert.throws(() => telemetry.record('late', {}), /closed/u)
})

test('telemetry rejects non-finite JSON and null telemetry discards records', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-telemetry-'))
  t.after(async () => rm(directory, {recursive: true, force: true}))
  using telemetry = new JsonlTelemetry(join(directory, 'telemetry.jsonl'), {
    clock: new VirtualClock(),
  })
  assert.throws(() => telemetry.record('bad', {value: Number.NaN}), /invalid_union/u)

  const nullTelemetry = new NullTelemetry()
  nullTelemetry.record('anything', {value: 1})
  nullTelemetry.close()
})
