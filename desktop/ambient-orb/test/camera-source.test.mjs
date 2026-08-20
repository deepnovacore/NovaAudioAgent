import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DESKTOP_VIDEO_FILE_ENV,
  MainCameraConfigurationError,
  selectMainCameraSource,
} from '../src/main/camera-source.mjs'

class RecordingFileSystem {
  calls = []
  canonical = '/canonical-path-sentinel/cat-sofa.mp4'
  regular = true
  realpathFailure = undefined
  statFailure = undefined

  realpath(path) {
    this.calls.push(`realpath:${path}`)
    if (this.realpathFailure) throw this.realpathFailure
    return this.canonical
  }

  stat(path) {
    this.calls.push(`stat:${path}`)
    if (this.statFailure) throw this.statFailure
    return { isFile: () => this.regular }
  }
}

test('main camera selector catches replacing Python strip with trim', () => {
  const cases = [
    ['missing', undefined],
    ['empty', ''],
    ['ASCII whitespace', ' \t\n\r\v\f'],
    ['Python information separators', '\u001c\u001d\u001e\u001f'],
    ['Python next-line', '\u0085'],
    ['mixed Python whitespace', '\t\u001c\u0085\n'],
  ]
  for (const [name, value] of cases) {
    const fileSystem = new RecordingFileSystem()
    const environment = value === undefined ? {} : { [DESKTOP_VIDEO_FILE_ENV]: value }
    const selected = selectMainCameraSource(environment, fileSystem)
    assert.deepEqual(selected, { source: 'local' }, name)
    assert.equal(Object.isFrozen(selected), true, name)
    assert.deepEqual(fileSystem.calls, [], name)
  }

  const fileSystem = new RecordingFileSystem()
  assert.throws(
    () => selectMainCameraSource({ [DESKTOP_VIDEO_FILE_ENV]: '\ufeff' }, fileSystem),
    MainCameraConfigurationError,
  )
  assert.deepEqual(fileSystem.calls, [], 'U+FEFF stays nonblank and fails before filesystem access')
})

test('main camera selector catches statting the raw path or returning a mutable result', () => {
  const fileSystem = new RecordingFileSystem()
  const selected = selectMainCameraSource({
    [DESKTOP_VIDEO_FILE_ENV]: '\u001c/input-path-sentinel/video.mp4\u0085',
  }, fileSystem)

  assert.deepEqual(selected, {
    source: 'file',
    file: '/canonical-path-sentinel/cat-sofa.mp4',
  })
  assert.deepEqual(fileSystem.calls, [
    'realpath:/input-path-sentinel/video.mp4',
    'stat:/canonical-path-sentinel/cat-sofa.mp4',
  ])
  assert.equal(Object.isFrozen(selected), true)
  assert.throws(() => { selected.file = '/replacement-sentinel.mp4' }, TypeError)
  assert.equal(selected.file, '/canonical-path-sentinel/cat-sofa.mp4')
})

test('main camera selector catches accepting invalid targets or leaking filesystem details', () => {
  const cases = [
    {
      name: 'relative',
      value: 'input-path-sentinel.mp4',
      calls: [],
    },
    {
      name: 'realpath failure',
      value: '/input-path-sentinel/missing.mp4',
      arrange(fileSystem) {
        fileSystem.realpathFailure = new Error('os-error-sentinel secret-sentinel')
      },
    },
    {
      name: 'stat failure',
      value: '/input-path-sentinel/inaccessible.mp4',
      arrange(fileSystem) {
        fileSystem.statFailure = new Error('device-sentinel secret-sentinel')
      },
    },
    {
      name: 'directory',
      value: '/input-path-sentinel/directory',
      arrange(fileSystem) { fileSystem.regular = false },
    },
    {
      name: 'special file',
      value: '/input-path-sentinel/device',
      arrange(fileSystem) { fileSystem.regular = false },
    },
  ]

  let expectedMessage
  for (const scenario of cases) {
    const fileSystem = new RecordingFileSystem()
    scenario.arrange?.(fileSystem)
    assert.throws(
      () => selectMainCameraSource({ [DESKTOP_VIDEO_FILE_ENV]: scenario.value }, fileSystem),
      error => {
        assert.ok(error instanceof MainCameraConfigurationError, scenario.name)
        assert.equal(error.name, 'MainCameraConfigurationError', scenario.name)
        assert.match(error.message, new RegExp(DESKTOP_VIDEO_FILE_ENV, 'u'), scenario.name)
        assert.doesNotMatch(
          `${error.name}: ${error.message}`,
          /input-path-sentinel|canonical-path-sentinel|os-error-sentinel|device-sentinel|secret-sentinel/u,
          scenario.name,
        )
        expectedMessage ??= error.message
        assert.equal(error.message, expectedMessage, scenario.name)
        return true
      },
    )
    if (scenario.calls) assert.deepEqual(fileSystem.calls, scenario.calls, scenario.name)
  }
})
