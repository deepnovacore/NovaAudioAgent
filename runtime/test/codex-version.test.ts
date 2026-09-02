import assert from 'node:assert/strict'
import {test} from 'node:test'

import {admitCodexCliVersion, admitCodexVersion} from '../src/codex-version.js'

test('Codex version admission accepts stable and product SemVer forms', () => {
  assert.equal(admitCodexCliVersion('codex-cli 0.151.0')?.version, '0.151.0')
  assert.equal(admitCodexCliVersion('codex-cli 0.151.0-alpha.7.2')?.version,
    '0.151.0-alpha.7.2')
  assert.equal(admitCodexCliVersion('codex-cli 0.151.0-alpha.7+desktop.2')?.version,
    '0.151.0-alpha.7+desktop.2')
  assert.equal(admitCodexVersion('0.151.0')?.display, '0.151.0')
  assert.equal(admitCodexVersion('0.145.0+desktop.2')?.display, '0.145.0+desktop.2')
})

test('Codex version admission rejects ambiguous, unsafe, and overlong forms', () => {
  for (const value of [
    '0.145.0-alpha.1',
    '0.151.0-alpha.01',
    '00.151.0',
    '9007199254740992.0.0',
    '0.151.0-alpha..7',
    'codex-cli 0.151.0',
  ]) assert.equal(admitCodexVersion(value), null, value)

  assert.equal(admitCodexCliVersion(`codex-cli 0.151.0-${'a'.repeat(118)}`), null)
})
