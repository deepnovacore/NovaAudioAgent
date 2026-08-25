import assert from 'node:assert/strict'
import test from 'node:test'

import {
  reportStartupFailure,
  startupFailureCode,
} from '../src/main/startup-diagnostics.mjs'

test('startup failures publish only a stable allowlisted code', () => {
  assert.equal(
    startupFailureCode(new Error('project_directory_open_failed')),
    'project_directory_open_failed',
  )
  assert.equal(
    startupFailureCode(Object.assign(new Error('private camera path'), {
      name: 'MainCameraConfigurationError',
    })),
    'camera_configuration_invalid',
  )

  let written = ''
  const code = reportStartupFailure(new Error('secret path C:\\private\\token'), {
    write: chunk => { written += chunk },
  })
  assert.equal(code, 'startup_failed')
  assert.equal(written, '[desktop-diagnostic] startup_failure code=startup_failed\n')
  assert.doesNotMatch(written, /private|token/u)
})
