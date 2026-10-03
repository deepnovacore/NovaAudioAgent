import assert from 'node:assert/strict'
import {test} from 'node:test'

import {HELP_TEXT, main} from '../src/command.mjs'

function output() {
  let value = ''
  return {stream: {write: chunk => { value += chunk }}, read: () => value}
}

test('help, version, and invalid commands do not install the desktop', async () => {
  for (const [argv, code, expected] of [
    [['--help'], 0, HELP_TEXT],
    [['--version'], 0, '0.3.0-preview.1'],
    [['unknown'], 2, HELP_TEXT],
    [['start', 'extra'], 2, HELP_TEXT],
  ]) {
    const sink = output()
    const result = await main(argv, {
      stdout: sink.stream,
      ensure: () => assert.fail('unexpected install'),
    })
    assert.equal(result, code)
    assert.match(sink.read(), new RegExp(expected.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  }
})

test('start and config share installation but config passes the settings argument', async () => {
  for (const [argv, openSettings] of [[[], false], [['start'], false], [['config'], true]]) {
    const launches = []
    const code = await main(argv, {
      ensure: async () => ({executable: '/tmp/Nova'}),
      launch: (executable, options) => launches.push({executable, options}),
    })
    assert.equal(code, 0)
    assert.deepEqual(launches, [{executable: '/tmp/Nova', options: {openSettings}}])
  }
})

test('doctor reports key names but never values', async () => {
  const sink = output()
  const code = await main(['doctor'], {
    stdout: sink.stream,
    doctor: async () => ({
      supported: true,
      platform: 'linux-x64',
      desktopReady: true,
      settingsPresent: true,
      configuredSecretKeys: ['OPENAI_API_KEY'],
      codexPresent: true,
    }),
  })
  assert.equal(code, 0)
  assert.match(sink.read(), /Configured keys: OPENAI_API_KEY/u)
  assert.doesNotMatch(sink.read(), /secret-value/u)
})

test('doctor lists voice keys, guides a first run, and fails while one is missing', async () => {
  const doctorReport = voice => async () => ({supported: true, platform: 'darwin-arm64', desktopReady: true, settingsPresent: false, configuredSecretKeys: [], codexPresent: false, voice})
  const sink = output()
  const code = await main(['doctor'], {stdout: sink.stream, doctor: doctorReport({pipeline: 'integrated', keys: [{name: 'DASHSCOPE_API_KEY', source: null}]})})
  assert.equal(code, 1)
  assert.match(sink.read(), /Voice pipeline: integrated\n {2}DASHSCOPE_API_KEY: missing\n/u)
  assert.match(sink.read(), /First run: start `novaaudio` and paste a DashScope API Key/u)

  const ready = output()
  assert.equal(await main(['doctor'], {stdout: ready.stream, doctor: doctorReport({pipeline: 'integrated', keys: [{name: 'DASHSCOPE_API_KEY', source: 'settings'}]})}), 0)
  assert.match(ready.read(), /DASHSCOPE_API_KEY: saved in settings\n/u)
  assert.doesNotMatch(ready.read(), /First run/u)
})

test('doctor --online forwards the flag and fails on a rejected key', async () => {
  const seen = []
  const sink = output()
  const code = await main(['doctor', '--online'], {stdout: sink.stream, doctor: async options => {
    seen.push(options)
    return {supported: true, platform: 'linux-x64', desktopReady: true, settingsPresent: true, configuredSecretKeys: [], codexPresent: true,
      voice: {pipeline: 'cascaded', keys: [{name: 'DEEPSEEK_API_KEY', source: 'environment', probe: 'rejected'}, {name: 'DOUBAO_BIGMODEL_API_KEY', source: 'environment', probe: 'deferred'}]}}
  }})
  assert.equal(code, 1)
  assert.deepEqual(seen, [{online: true}])
  assert.match(sink.read(), /DEEPSEEK_API_KEY: set in environment \(rejected by provider\)/u)
  assert.match(sink.read(), /DOUBAO_BIGMODEL_API_KEY: set in environment \(checked on first connection\)/u)
  assert.equal(await main(['doctor', '--offline'], {stdout: output().stream, doctor: () => assert.fail('unexpected doctor')}), 2)
})
