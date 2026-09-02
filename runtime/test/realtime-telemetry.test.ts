import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { VirtualClock } from '../src/clock.js'
import { jsonValueSchema } from '../src/events.js'
import {
  MAX_REALTIME_DIAGNOSTICS,
  JsonlTelemetry,
  NullTelemetry,
  createRealtimeTelemetry,
} from '../src/realtime/telemetry.js'

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

test('telemetry rejects non-finite JSON and keeps bounded body-free diagnostics without JSONL', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-telemetry-'))
  t.after(async () => rm(directory, {recursive: true, force: true}))
  using telemetry = new JsonlTelemetry(join(directory, 'telemetry.jsonl'), {
    clock: new VirtualClock(),
  })
  assert.throws(() => telemetry.record('bad', {value: Number.NaN}), /invalid_union/u)

  const clock = new VirtualClock()
  const nullTelemetry = new NullTelemetry({clock})
  for (let index = 0; index < MAX_REALTIME_DIAGNOSTICS + 5; index += 1) {
    clock.advanceTo(index)
    nullTelemetry.record('confirmation.binding', {
      item_id: `item-${index}`,
      transcript: `private transcript ${index}`,
      work_order: `private work ${index}`,
      nested: {content: 'private body', revision: index},
    })
  }
  const diagnostics = nullTelemetry.diagnostics()
  assert.equal(diagnostics.version, 1)
  assert.equal(diagnostics.records.length, MAX_REALTIME_DIAGNOSTICS)
  assert.equal(Reflect.get(diagnostics.records[0]!, 'seq'), 6)
  assert.equal(Reflect.get(diagnostics.records.at(-1)!, 'seq'), MAX_REALTIME_DIAGNOSTICS + 5)
  assert.equal(diagnostics.records[0]?.payload.item_id, 'item-5')
  assert.equal(JSON.stringify(diagnostics).includes('private'), false)
  assert.deepEqual(diagnostics.records.at(-1)?.payload.nested, {revision: 132})
  assert.ok(Object.isFrozen(diagnostics.records.at(-1)?.payload.nested))
  nullTelemetry.close()
})

test('Memory Board diagnostic identities are unique when the clock does not advance', () => {
  const telemetry = new NullTelemetry({clock: new VirtualClock(7)})
  telemetry.record('renderer.ack', {revision: 1})
  telemetry.record('renderer.ack', {revision: 2})

  assert.deepEqual(telemetry.diagnostics().records.map(record => Reflect.get(record, 'seq')), [1, 2])
})

test('JSONL keeps full opt-in telemetry while its Memory Board snapshot is redacted', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-telemetry-full-'))
  t.after(async () => rm(directory, {recursive: true, force: true}))
  const path = join(directory, 'telemetry.jsonl')
  const telemetry = new JsonlTelemetry(path, {clock: new VirtualClock(7)})
  telemetry.record('project_confirmation.commit_started', {
    proposal_id: 'proposal-1',
    origin_ref: 'conversation:10',
    transcript: '确认',
    work_order: '实现俄罗斯方块',
  })
  telemetry.close()

  const jsonl = await readFile(path, 'utf8')
  assert.match(jsonl, /实现俄罗斯方块/u)
  const diagnostics = telemetry.diagnostics()
  assert.equal(diagnostics.records[0]?.payload.origin_ref, 'conversation:10')
  assert.equal(JSON.stringify(diagnostics).includes('俄罗斯方块'), false)
  assert.equal(JSON.stringify(diagnostics).includes('确认'), false)
})

test('desktop telemetry defaults to a private app-state JSONL path', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-telemetry-env-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const clock = new VirtualClock()
  const telemetry = createRealtimeTelemetry({}, {clock, homeDirectory: directory})
  assert.ok(telemetry instanceof JsonlTelemetry)
  telemetry.record('always.available', {revision: 1})
  telemetry.close()

  const telemetryPath = join(directory, '.nova-audio-agent', 'realtime-telemetry.jsonl')
  assert.equal((await stat(telemetryPath)).mode & 0o777, 0o600)
  assert.deepEqual(
    (await readFile(telemetryPath, 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as unknown),
    [{ts: 0, kind: 'always.available', payload: {revision: 1}}],
  )
})

test('desktop telemetry creates the app-state directory for the explicit default path', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-telemetry-env-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const telemetry = createRealtimeTelemetry({
    NOVA_AUDIO_AGENT_REALTIME_TELEMETRY: '~/.nova-audio-agent/realtime-telemetry.jsonl',
  }, {clock: new VirtualClock(), homeDirectory: directory})
  telemetry.record('configured.default', {revision: 1})
  telemetry.close()

  const contents = await readFile(
    join(directory, '.nova-audio-agent', 'realtime-telemetry.jsonl'),
    'utf8',
  )
  assert.match(contents, /configured\.default/u)
})

test('desktop telemetry accepts an explicit empty opt-out and expands custom home paths', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-telemetry-env-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const clock = new VirtualClock()
  const disabled = createRealtimeTelemetry({
    NOVA_AUDIO_AGENT_REALTIME_TELEMETRY: '  ',
  }, {clock, homeDirectory: directory})
  assert.ok(disabled instanceof NullTelemetry)

  const enabled = createRealtimeTelemetry({
    NOVA_AUDIO_AGENT_REALTIME_TELEMETRY: '~/desktop-telemetry.jsonl',
  }, {clock, homeDirectory: directory})
  enabled.record('camera.admission', {
    executor: 'guard', status: 'denied', phase: 'pre_arm', admitted: false,
  })
  enabled.close()
  const telemetryPath = join(directory, 'desktop-telemetry.jsonl')
  assert.equal((await stat(telemetryPath)).mode & 0o777, 0o600)
  const records = (await readFile(telemetryPath, 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as unknown)
  assert.deepEqual(records, [{
    ts: 0,
    kind: 'camera.admission',
    payload: {executor: 'guard', status: 'denied', phase: 'pre_arm', admitted: false},
  }])
})
