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
    [['--version'], 0, '0.1.0'],
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
