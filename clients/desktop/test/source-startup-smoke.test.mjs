import assert from 'node:assert/strict'
import test from 'node:test'

import {assertSourceStartupSmokeResult, sourceStartupSmokeEnvironment} from '../scripts/source-startup-smoke.mjs'

test('startup timeout preserves safe diagnostics and distinguishes startup from exit hangs', () => {
  const stderr = 'Error [ERR_MODULE_NOT_FOUND]: private module path\n[desktop-diagnostic] startup_failure code=startup_failed secret=private\n'
  for (const ready of [false, true]) {
    assert.throws(() => assertSourceStartupSmokeResult(
      {timedOut: true}, ready ? '[desktop-smoke] source_window_ready\n' : '', stderr,
    ), {message: `source_startup_smoke_timeout window_ready=${ready} diagnostic=[desktop-diagnostic] startup_failure code=startup_failed load_error=ERR_MODULE_NOT_FOUND`})
  }
  assert.throws(() => assertSourceStartupSmokeResult({code: 0}, '', ''), /source_startup_smoke_failed window_ready=false/u)
  assertSourceStartupSmokeResult({code: 0}, '[desktop-smoke] source_window_ready\n', '')
})

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

test('source smoke reports only bounded lifecycle markers on an exit timeout', () => {
  assert.throws(() => assertSourceStartupSmokeResult({timedOut: true}, '[desktop-smoke] source_window_ready\n',
    '[desktop-smoke] quit_requested\n[desktop-smoke] maintenance_closing private-path\n'),
  /shutdown_stage=maintenance_closing$/u)
})

test('source smoke lifecycle clock emits integer milliseconds without private state', async () => {
  const {readFile} = await import('node:fs/promises')
  const {default: vm} = await import('node:vm')
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const body = source.slice(source.indexOf('function sourceSmokeStage('), source.indexOf("app.on('will-quit'"))
  const lines = []
  const context = vm.createContext({sourceStartupSmoke: true, process: {uptime: () => 1.23456}, writeSync: (fd, line) => lines.push([fd, line])})
  vm.runInContext(body + "sourceSmokeStage('before_quit')", context)
  assert.deepEqual(lines, [[2, '[desktop-smoke] before_quit elapsed_ms=1235\n']])
})
