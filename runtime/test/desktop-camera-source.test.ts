import assert from 'node:assert/strict'
import {test} from 'node:test'
import {
  DESKTOP_VIDEO_FILE_ENV,
  DesktopCameraConfigurationError,
  selectDesktopCameraSource,
  type CameraFileSystem,
} from '../src/desktop-camera-source.js'

class RecordingFileSystem implements CameraFileSystem {
  readonly calls: string[] = []
  canonical = '/canonical-sentinel/video.mp4'
  regular = true
  realpathFailure: Error | undefined
  statFailure: Error | undefined

  realpath(path: string): string {
    this.calls.push(`realpath:${path}`)
    if (this.realpathFailure !== undefined) throw this.realpathFailure
    return this.canonical
  }

  stat(path: string): {isFile(): boolean} {
    this.calls.push(`stat:${path}`)
    if (this.statFailure !== undefined) throw this.statFailure
    return {isFile: () => this.regular}
  }
}

test('desktop camera selection treats missing, empty, and Python whitespace as local', () => {
  for (const value of [undefined, '', '\u001c\u0085']) {
    const fileSystem = new RecordingFileSystem()
    const environment = value === undefined ? {} : {[DESKTOP_VIDEO_FILE_ENV]: value}
    assert.deepEqual(selectDesktopCameraSource(environment, fileSystem), {source: 'local'})
    assert.deepEqual(fileSystem.calls, [])
  }
})

test('desktop camera selection canonicalizes an absolute regular file', () => {
  const fileSystem = new RecordingFileSystem()
  assert.deepEqual(selectDesktopCameraSource({
    [DESKTOP_VIDEO_FILE_ENV]: '\u001c/path-sentinel/video.mp4\u0085',
  }, fileSystem), {
    source: 'file',
    file: '/canonical-sentinel/video.mp4',
  })
  assert.deepEqual(fileSystem.calls, [
    'realpath:/path-sentinel/video.mp4',
    'stat:/canonical-sentinel/video.mp4',
  ])
})

test('desktop camera selection rejects every invalid file without leaking details', () => {
  const cases: readonly {
    readonly name: string
    readonly value: string
    readonly arrange?: (fileSystem: RecordingFileSystem) => void
    readonly expectedCalls?: readonly string[]
  }[] = [
    {name: 'relative', value: 'path-sentinel.mp4', expectedCalls: []},
    {name: 'directory or special file', value: '/path-sentinel/directory', arrange: fs => {
      fs.regular = false
    }},
    {name: 'realpath failure', value: '/path-sentinel/missing', arrange: fs => {
      fs.realpathFailure = new Error('secret-sentinel realpath os detail')
    }},
    {name: 'stat failure', value: '/path-sentinel/inaccessible', arrange: fs => {
      fs.statFailure = new Error('secret-sentinel stat os detail')
    }},
  ]
  for (const scenario of cases) {
    const fileSystem = new RecordingFileSystem()
    scenario.arrange?.(fileSystem)
    assert.throws(
      () => selectDesktopCameraSource({[DESKTOP_VIDEO_FILE_ENV]: scenario.value}, fileSystem),
      (error: unknown) => {
        assert.ok(error instanceof DesktopCameraConfigurationError, scenario.name)
        const visible = String(error)
        assert.match(visible, new RegExp(DESKTOP_VIDEO_FILE_ENV, 'u'), scenario.name)
        assert.doesNotMatch(
          visible,
          /path-sentinel|canonical-sentinel|secret-sentinel|os detail/u,
          scenario.name,
        )
        return true
      },
    )
    if (scenario.expectedCalls !== undefined) {
      assert.deepEqual(fileSystem.calls, scenario.expectedCalls, scenario.name)
    }
  }
})
