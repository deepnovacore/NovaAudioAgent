import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('main owns single-instance lifecycle and denies renderer escape', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  assert.match(source, /requestSingleInstanceLock/)
  assert.match(source, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/)
  assert.match(source, /setPermissionRequestHandler/)
  assert.match(source, /loadAppWindow\(mainWindow/)
  assert.doesNotMatch(source, /shell\.openExternal/)
})

test('preload exposes only bounded bootstrap native-audio menu and board channels', async () => {
  const source = await readFile(new URL('../src/preload/preload.cjs', import.meta.url), 'utf8')

  assert.match(source, /bootstrap: \(\) => ipcRenderer\.invoke\('nova:bootstrap'\)/)
  const channels = [...source.matchAll(/['"](nova:[^'"]+)['"]/g)].map(match => match[1])
  assert.deepEqual([...new Set(channels)].sort(), [
    'nova:backend-exit',
    'nova:bootstrap',
    'nova:memory-board:data',
    'nova:memory-board:export',
    'nova:memory-board:fetch',
    'nova:memory-board:request',
    'nova:native-audio:capture',
    'nova:native-audio:clear',
    'nova:native-audio:event',
    'nova:native-audio:play',
    'nova:native-audio:terminal',
    'nova:orb-menu:show',
    'nova:window-drag:end',
    'nova:window-drag:move',
    'nova:window-drag:start',
  ])
  assert.doesNotMatch(source, /sendSync/)
})

test('main owns the fixed orb menu and validates every menu and board sender', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  assert.match(source, /ipcMain\.on\('nova:orb-menu:show', event => \{\n\s*if \(mainWindow && event\.sender === mainWindow\.webContents\)/)
  assert.match(source, /Memory Board/)
  assert.match(source, /退出 Nova Audio Agent/)
  assert.match(source, /click: \(\) => app\.quit\(\)/)
  assert.match(source, /event\.sender !== boardWindow\.webContents/)
  assert.match(source, /event\.sender === mainWindow\.webContents/)

  const renderer = await readFile(new URL('../src/renderer/index.mjs', import.meta.url), 'utf8')
  assert.match(renderer, /contextmenu/)
  assert.match(renderer, /event\.preventDefault\(\)/)
  assert.match(renderer, /orbMenu\.show\(\)/)
})

test('registers the orb context-menu channel exactly once', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  const registrations = source.match(/ipcMain\.on\(\s*'nova:orb-menu:show'/g) || []
  assert.equal(registrations.length, 1)
})

test('quitting drains the backend on the stdin sentinel instead of killing it', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const beforeQuit = source.slice(source.indexOf("app.on('before-quit'"))

  assert.match(beforeQuit, /event\.preventDefault\(\)/)
  assert.match(beforeQuit, /shutdownBackend\(backend\)/)
  assert.match(beforeQuit, /app\.exit\(0\)/)
  // Every teardown path goes through the helper, so no bare signal survives.
  assert.doesNotMatch(source, /backend\??\.kill\(/)
})

test('native VoiceProcessingIO starts only after explicit capture activation', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  assert.match(source, /ipcMain\.handle\('nova:native-audio:capture'/)
  assert.match(source, /nativeAudio\?\.activate\(\)/)
  assert.match(source, /nativeAudio\?\.deactivate\(\)/)
})

test('desktop bootstrap payload identifies the host platform for the renderer', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  const bootstrapAssignment = source.slice(source.indexOf('bootstrap = Object.freeze({'))
  assert.match(bootstrapAssignment.slice(0, bootstrapAssignment.indexOf('})')), /platform: process\.platform/)
})

test('macOS camera permission is requested on the main thread before backend startup', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  assert.match(source, /systemPreferences/)
  assert.match(source, /getMediaAccessStatus\('camera'\) === 'not-determined'/)
  assert.match(source, /await systemPreferences\.askForMediaAccess\('camera'\)/)
  assert.ok(source.indexOf('await requestCameraPermission()') < source.indexOf('await launchBackend()'))
})

test('drag and orb menu paths stay sender validated and bounded', async () => {
  const mainSource = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const rendererSource = await readFile(new URL('../src/renderer/index.mjs', import.meta.url), 'utf8')

  assert.match(mainSource, /event\.sender === mainWindow\.webContents/)
  assert.match(mainSource, /validDragDelta/)
  assert.match(mainSource, /label: '退出 Nova Audio Agent'/)
  assert.match(mainSource, /click: \(\) => app\.quit\(\)/)
  assert.match(rendererSource, /dragGesture\.consumeClick\(\)/)
  assert.match(rendererSource, /event\.preventDefault\(\)/)
  assert.match(rendererSource, /window\.novaAudioAgentDesktop\.orbMenu\.show\(\)/)
})
