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

test('sets the Windows AppUserModelID unconditionally before startup', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  assert.match(
    source,
    /app\.setAppUserModelId\('ai\.deepnovacore\.nova-audio-agent\.orb'\)/,
  )
  const call = source.indexOf("app.setAppUserModelId('ai.deepnovacore.nova-audio-agent.orb')")
  const whenReady = source.indexOf('app.whenReady()')
  assert.ok(call >= 0 && whenReady > call)
  // Unconditional: never gated behind a platform check.
  const line = source.slice(source.lastIndexOf('\n', call) + 1, source.indexOf('\n', call))
  assert.doesNotMatch(line, /if\s*\(/)
})

test('renderer threads the bootstrap platform into the orb state axes', async () => {
  const source = await readFile(new URL('../src/renderer/index.mjs', import.meta.url), 'utf8')

  assert.match(source, /axes\.platform = bootstrap\.platform/)
})

test('macOS camera permission is requested on the main thread before backend startup', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  assert.match(source, /systemPreferences/)
  assert.match(source, /getMediaAccessStatus\('camera'\) === 'not-determined'/)
  assert.match(source, /await systemPreferences\.askForMediaAccess\('camera'\)/)
  assert.ok(source.indexOf('await requestCameraPermission()') < source.indexOf('await launchBackend()'))
})

test('pins X11/XWayland and transparent visuals on linux before the app is ready', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  assert.match(source, /process\.platform === 'linux'/)
  assert.match(source, /appendSwitch\('ozone-platform', 'x11'\)/)
  assert.match(source, /appendSwitch\('enable-transparent-visuals'\)/)

  const switchSite = source.indexOf("appendSwitch('ozone-platform'")
  const whenReady = source.indexOf('app.whenReady()')
  assert.ok(switchSite >= 0 && whenReady > switchSite)
})

test('delays window creation on linux only, via an injectable wait rather than a bare sleep', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  assert.match(source, /LINUX_WINDOW_DELAY_MS\s*=\s*300/)
  const startBody = source.slice(source.indexOf('async function start()'))
  const platformCheck = startBody.indexOf("process.platform === 'linux'")
  const createWindowCall = startBody.indexOf('createWindow(launchId')
  assert.ok(platformCheck >= 0 && createWindowCall > platformCheck)
  assert.match(startBody.slice(platformCheck, createWindowCall), /LINUX_WINDOW_DELAY_MS/)
})

test('warns instead of silently failing when the global shortcut cannot register', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  const registration = source.slice(source.indexOf('globalShortcut.register('))
  assert.match(
    registration.slice(0, 400),
    /console\.warn\('\[ambient-orb\] global shortcut unavailable on this session'\)/,
  )
})

test('reads the opaque fallback from env and threads it through window creation and bootstrap', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  assert.match(source, /process\.env\.NOVA_ORB_OPAQUE === '1'/)
  assert.match(source, /browserWindowOptions\(preload, launchId, \{ opaque \}\)/)
  const bootstrapAssignment = source.slice(source.indexOf('bootstrap = Object.freeze({'))
  assert.match(bootstrapAssignment.slice(0, bootstrapAssignment.indexOf('})')), /opaque/)
})

test('renderer flags an opaque bootstrap on the document body', async () => {
  const source = await readFile(new URL('../src/renderer/index.mjs', import.meta.url), 'utf8')

  assert.match(source, /document\.body\.dataset\.opaque = '1'/)
})

test('opaque mode renders a rounded dark plate behind the orb', async () => {
  const source = await readFile(new URL('../src/renderer/index.css', import.meta.url), 'utf8')

  assert.match(source, /body\[data-opaque="1"\]/)
  assert.match(source, /rgba\(20,\s*14,\s*8,\s*\.92\)/)
  assert.match(source, /border-radius:\s*24px/)
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
