import assert from 'node:assert/strict'
import test from 'node:test'

import {sourceStartupSmokeEnvironment} from '../scripts/source-startup-smoke.mjs'

test('source startup smoke removes ambient product controls without mutating the parent environment', () => {
  const parentEnvironment = {
    Path: 'C:\\Windows\\System32',
    SystemRoot: 'C:\\Windows',
    NOVA_AUDIO_AGENT_BACKEND: 'python',
    nova_audio_agent_desktop_video_file: 'C:\\private\\camera.mp4',
    NOVA_ORB_OPAQUE: '1',
    ELECTRON_RUN_AS_NODE: '1',
    home: 'C:\\private\\old-home',
    UserProfile: 'C:\\private\\old-profile',
  }

  const environment = sourceStartupSmokeEnvironment(parentEnvironment, {
    home: 'C:\\smoke\\home',
  })

  assert.deepEqual(environment, {
    Path: 'C:\\Windows\\System32',
    SystemRoot: 'C:\\Windows',
    HOME: 'C:\\smoke\\home',
    USERPROFILE: 'C:\\smoke\\home',
  })
  assert.equal(parentEnvironment.NOVA_AUDIO_AGENT_BACKEND, 'python')
  assert.equal(parentEnvironment.ELECTRON_RUN_AS_NODE, '1')
})
