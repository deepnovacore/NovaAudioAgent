import assert from 'node:assert/strict'
import {test} from 'node:test'

import {OPEN_SETTINGS_ARGUMENT, shouldOpenSettings} from '../src/main/launch-command.mjs'

test('settings launch command is exact and works for cold and second-instance argv', () => {
  assert.equal(OPEN_SETTINGS_ARGUMENT, '--open-settings')
  assert.equal(shouldOpenSettings(['/Applications/Nova', '--open-settings']), true)
  assert.equal(shouldOpenSettings(['Nova.exe', '--open-settings']), true)
  assert.equal(shouldOpenSettings(['Nova', '--open-setting']), false)
  assert.equal(shouldOpenSettings(undefined), false)
})
