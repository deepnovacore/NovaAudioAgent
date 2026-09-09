import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {PassThrough} from 'node:stream'
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createLocalHost} from '../host.mjs'

async function fixture(t, fail = () => false) {
  const stateDir = await mkdtemp(join(tmpdir(), 'nova-web-host-'))
  const launches = []
  const host = await createLocalHost({stateDir, environment: {DASHSCOPE_API_KEY: 'inherited-must-not-return'}, launcher: (_command, _args, options) => {
    const child = new EventEmitter()
    child.stderr = new PassThrough()
    child.exitCode = null
    child.signalCode = null
    child.kill = signal => { child.signalCode = signal; child.emit('exit', null, signal) }
    launches.push({child, options})
    queueMicrotask(() => {
      if (fail()) { child.exitCode = 2; child.emit('exit', 2); return }
      child.stderr.write(`[server-ready] ws://127.0.0.1:${options.env.NOVA_AUDIO_AGENT_SERVER_PORT}/client/v1\n`)
    })
    return child
  }})
  t.after(async () => { await host.close(); await rm(stateDir, {recursive: true, force: true}) })
  return {host, launches, stateDir}
}

test('isolated settings preserve blanks, clear nulls, validate atomically and hide secrets', async t => {
  const {host, stateDir} = await fixture(t)
  assert.match(host.token, /^[a-f0-9]{32}$/)
  assert.equal(host.view().storageProtection, 'file-permissions')
  await host.update({secrets: {dashscopeApiKey: ' dummy-key '}, integratedVoice: ' voice '})
  assert.equal(host.view().integratedVoice, 'voice')
  assert.equal(host.view().secretsPresent.dashscopeApiKey, true)
  assert.ok(!JSON.stringify(host.view()).includes('dummy-key'))
  const file = join(stateDir, 'settings.json')
  const before = await readFile(file, 'utf8')
  for (const patch of [{pipelineMode: 'broken'}, {secrets: {bogus: 'x'}}, {secrets: {dashscopeApiKey: 4}}, {cascadedLlmModels: {qwen: ''}}, {modelBaseUrl: 'http://public.example'}, {plannerModel: 4}, {bogus: 'x'}]) {
    await assert.rejects(host.update(patch), {code: 'invalid_settings_commit'})
    assert.equal(await readFile(file, 'utf8'), before)
  }
  await host.update({secrets: {dashscopeApiKey: ''}})
  assert.equal(host.view().secretsPresent.dashscopeApiKey, true)
  await host.update({secrets: {dashscopeApiKey: null}})
  assert.equal(host.view().secretsPresent.dashscopeApiKey, false)
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.equal((await stat(stateDir)).mode & 0o777, 0o700)
})

test('lazy runtime startup waits for readiness, restarts with changed environment and stops', async t => {
  const {host, launches, stateDir} = await fixture(t)
  assert.equal(launches.length, 0)
  await host.update({secrets: {dashscopeApiKey: 'first'}})
  const endpoint = await host.start()
  assert.match(endpoint, /^ws:\/\/127\.0\.0\.1:\d+\/client\/v1$/)
  assert.equal(await host.start(), endpoint)
  assert.equal(launches.length, 1)
  assert.equal(launches[0].options.env.DASHSCOPE_API_KEY, 'first')
  assert.equal(launches[0].options.cwd, stateDir)
  const saved = await host.update({secrets: {dashscopeApiKey: null, arkApiKey: 'ark', doubaoBigmodelApiKey: 'speech'}, pipelineMode: 'cascaded', cascadedLlmProvider: 'ark'})
  assert.equal(saved.restarted, true)
  assert.equal(launches[0].child.signalCode, 'SIGTERM')
  assert.equal(launches[1].options.env.DASHSCOPE_API_KEY, undefined)
  assert.equal(launches[1].options.env.ARK_API_KEY, 'ark')
  assert.equal(launches[1].options.env.DOUBAO_BIGMODEL_API_KEY, 'speech')
  assert.equal(launches[1].options.env.NOVA_AUDIO_AGENT_SERVER_MEDIA_MODE, 'relay')
  await host.close()
  assert.equal(host.endpoint, null)
  assert.equal(host.view().runtimeStatus, 'stopped')
})

test('failed restart reports persisted settings without claiming runtime applied them', async t => {
  let failure = false
  const {host} = await fixture(t, () => failure)
  await host.start()
  failure = true
  await assert.rejects(host.update({integratedVoice: 'changed'}), error => error.code === 'runtime_unavailable' && error.saved === true && error.restarted === false)
  assert.equal(host.view().runtimeStatus, 'failed')
  assert.equal(host.view().integratedVoice, 'changed')
  assert.equal(host.endpoint, null)
})
