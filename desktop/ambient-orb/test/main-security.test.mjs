import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('main owns single-instance lifecycle and denies renderer escape', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  assert.match(source, /requestSingleInstanceLock/)
  assert.match(source, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/)
  assert.match(source, /configureWindowSecurity\(window\)/)
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
    'nova:settings:changed',
    'nova:settings:get',
    'nova:settings:set',
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

test('the orb menu opens the settings panel above the quit separator', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const menu = source.slice(source.indexOf('function showOrbMenu('))
  const body = menu.slice(0, menu.indexOf('.popup('))

  assert.match(body, /label: '设置…', click: \(\) => openSettingsWindow\(launchId\)/)
  assert.ok(
    body.indexOf("label: '设置…'") < body.indexOf("{ type: 'separator' }"),
    'the settings entry sits above the separator',
  )
  assert.ok(
    body.indexOf("{ type: 'separator' }") < body.indexOf('退出 Nova Audio Agent'),
    'quit still sits below the separator',
  )
})

test('the settings window is a singleton that never rebinds the shared permission handlers', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const open = source.slice(source.indexOf('function openSettingsWindow('))
  const body = open.slice(0, open.indexOf('\n}\n'))

  assert.match(source, /let settingsWindow = null/)
  assert.match(body, /if \(settingsWindow\) \{\n\s*settingsWindow\.show\(\)\n\s*settingsWindow\.focus\(\)\n\s*return\n\s*\}/)
  assert.match(body, /settingsWindowOptions\(preload, launchId\)/)
  assert.match(body, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/)
  assert.match(body, /allowRendererNavigation\(url\)/)
  assert.match(body, /settingsWindow = null/)
  assert.match(body, /loadURL\('nova:\/\/orb\/settings\.html'\)/)
  // The microphone grant belongs to the orb: the settings panel shares the
  // session partition but must never re-bind its permission handlers.
  assert.doesNotMatch(body, /setPermission|configureWindowSecurity/)
})

test('settings IPC is sender-validated and answers from main without an orb relay', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  assert.match(source, /ipcMain\.handle\('nova:settings:get', event => \{\n\s*if \(!settingsWindow \|\| event\.sender !== settingsWindow\.webContents\)/)
  assert.match(source, /ipcMain\.handle\('nova:settings:set', async \(event, patch\) => \{\n\s*if \(!settingsWindow \|\| event\.sender !== settingsWindow\.webContents\)/)
  assert.match(source, /sendToOrb\('nova:settings:changed', publicSettings\(currentSettings\)\)/)
  // No requestId machinery: settings live in main, so nothing round-trips
  // through the orb renderer the way the memory board has to.
  const set = source.slice(source.indexOf("ipcMain.handle('nova:settings:set'"))
  assert.doesNotMatch(set.slice(0, set.indexOf('\n  })')), /requestId|pendingBoardRequests/)
})

test('no decrypted secret can reach the renderer or a log line', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  // Only the presence map and the non-secret fields are ever returned to the panel.
  assert.match(source, /function settingsView\(\) \{/)
  assert.match(source, /\.\.\.publicSettings\(currentSettings\)/)
  assert.match(source, /secretsPresent: secretsPresent\(currentSettings\)/)
  // The warning flag is about the *file*, not only about today's keyring: an
  // entry written while no keyring existed keeps it on until it is re-sealed.
  assert.match(
    source,
    /keyringAvailable: secretCodec\.available\(\) && !hasPlaintextSecret\(currentSettings\)/,
  )
  // The failure log for a settings save names the error type only, never the payload.
  assert.match(source, /settings_save_failure type=\$\{error\.name\}/)
  // Every console.* line is scanned: a line mentioning "secret" or "apiKey" is
  // allowed only if it is one of the two key-name-only secret diagnostics;
  // anything else naming a secret, or naming the raw settings patch, or
  // interpolating the decrypted `plaintext` local, fails the test.
  const logs = source.match(/console\.(?:log|warn|error)\([^\n]*/g) || []
  for (const line of logs) {
    assert.doesNotMatch(line, /patch/i, `log line leaks the settings patch: ${line}`)
    assert.doesNotMatch(line, /plaintext/, `log line leaks a decrypted secret value: ${line}`)
    if (/secret|apiKey/i.test(line)) {
      assert.match(
        line,
        /settings_secret_(?:unreadable|invalid) key=\$\{key\}/,
        `log line mentioning secrets must be the key-name-only diagnostic: ${line}`,
      )
    }
  }
})

test('every settings write goes through one queue so overlapping patches merge', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  // Two panel changes can be in flight at once, and each handler used to
  // snapshot `currentSettings` for itself: last writer won and the other
  // field's change vanished. One writer, one queue, latest committed state.
  assert.match(source, /const settingsWriter = createSettingsWriter\(\{/)
  const writer = source.slice(source.indexOf('const settingsWriter = createSettingsWriter({'))
  const body = writer.slice(0, writer.indexOf('\n})'))
  assert.match(body, /getCurrent: \(\) => currentSettings/)
  assert.match(body, /commit: next => \{\n\s*currentSettings = next\n\s*\}/)
  assert.match(body, /save: next => saveSettings\(settingsFile\(\), next\)/)
  assert.match(body, /codec: secretCodec/)

  const set = source.slice(source.indexOf("ipcMain.handle('nova:settings:set'"))
  const handler = set.slice(0, set.indexOf('\n  })'))
  assert.match(handler, /await settingsWriter\(patch\)/)
  assert.doesNotMatch(
    handler,
    /applySettingsUpdate|currentSettings = /,
    'the handler no longer computes or commits state on its own',
  )
})

test('a stored secret that would poison the child environment is omitted at spawn', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const decrypt = source.slice(source.indexOf('function decryptSecretsForSpawn('))
  const body = decrypt.slice(0, decrypt.indexOf('\n}\n'))

  // A NUL in an env value makes Node refuse the spawn, which would quit the app
  // before the panel could clear the offending key. The value is dropped here
  // and the key named — never its content.
  assert.match(body, /secretValueIsSafe\(plaintext\)/)
  assert.match(body, /settings_secret_invalid key=\$\{key\}/)
})

test('readSecret is wired at the spawn site, decrypting only what backendLaunchSpec receives', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  // Now consciously wired: the pin from before Task 20 (`doesNotMatch(/readSecret/)`)
  // is gone, because secrets must reach the spawned backend somehow.
  const readSecretSite = source.indexOf('readSecret(')
  const spawnSite = source.indexOf('backend = spawn(')
  assert.ok(readSecretSite >= 0, 'readSecret must be wired now that spawn needs decrypted secrets')
  assert.ok(spawnSite >= 0, 'the backend is still spawned here')
  assert.ok(readSecretSite < spawnSite, 'secrets are decrypted before the backend is spawned')

  // The decrypted secrets reach backendLaunchSpec, not any wider scope.
  const specCall = source.slice(source.indexOf('const spec = backendLaunchSpec({'))
  const specBody = specCall.slice(0, specCall.indexOf('\n    })'))
  assert.match(specBody, /settings: currentSettings/)
  assert.match(specBody, /decryptedSecrets,?/)

  // The decrypted value never survives past the call that builds `spec`: no
  // module-level `let`/`var decryptedSecrets` binding exists anywhere.
  assert.doesNotMatch(source, /\b(?:let|var)\s+decryptedSecrets\b/)
})

test('the bootstrap payload carries the non-secret settings for the orb', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  const assignment = source.slice(source.indexOf('bootstrap = Object.freeze({'))
  assert.match(assignment.slice(0, assignment.indexOf('})')), /settings: publicSettings\(currentSettings\)/)
  assert.match(source, /currentSettings = await loadSettings\(settingsFile\(\)\)/)
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

test('a backend that fails to spawn is handled rather than thrown at the main process', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  const spawnSite = source.indexOf('backend = spawn(')
  const watchSite = source.indexOf('watchBackendExit(backend')
  assert.ok(spawnSite >= 0, 'the backend is still spawned here')
  assert.ok(watchSite > spawnSite, "the death hooks must be registered right after spawn")
  // ENOENT emits 'error' *instead of* 'exit', so an exit-only hook is the bug:
  // both paths go through the one helper.
  assert.doesNotMatch(source, /backend\.once\('exit'/)
  assert.doesNotMatch(source, /backend\.on\('error'/)
})

test('a backend that died before the window exists replays its exit to the new renderer', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  assert.match(source, /let backendExited = false/)
  assert.match(source, /backendExited = true/)
  // Belt: the push replay still fires once the renderer has loaded.
  const load = source.slice(source.indexOf('loadAppWindow(mainWindow'))
  assert.match(load.slice(0, 900), /if \(backendExited\) sendToOrb\('nova:backend-exit'\)/)
})

test('the bootstrap answer carries the backend-exit verdict read at invoke time', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  // Braces: the renderer already awaits this reply, so a verdict carried on it cannot
  // lose the race against its own listener bind the way a push can.
  const handler = source.slice(source.indexOf("ipcMain.handle('nova:bootstrap'"))
  assert.match(handler.slice(0, handler.indexOf('})')), /backendExited/)
  // Read per invoke, never baked into the payload frozen before any backend could die.
  const frozen = source.slice(source.indexOf('bootstrap = Object.freeze({'))
  assert.doesNotMatch(frozen.slice(0, frozen.indexOf('})')), /backendExited/)
})

test('renderer applies a backend that died before its exit listener was bound', async () => {
  const source = await readFile(new URL('../src/renderer/index.mjs', import.meta.url), 'utf8')

  // One handler, two doors into it: the pushed event and the bootstrap verdict.
  assert.match(source, /function handleBackendExit\(\)/)
  assert.match(source, /onBackendExit\(handleBackendExit\)/)
  assert.match(source, /if \(bootstrap\.backendExited === true\) handleBackendExit\(\)/)
})

test('every renderer push is guarded against a destroyed orb window', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  // `mainWindow` is never nulled on close, so an unguarded send throws
  // "Object has been destroyed" into the main process. One guard, one place.
  assert.match(source, /function sendToOrb\(channel, \.\.\.args\) \{/)
  assert.match(source, /if \(mainWindow && !mainWindow\.isDestroyed\(\)\)/)
  const sends = source.match(/webContents\.send\(/g) || []
  assert.equal(sends.length, 1, 'the only raw send is the guarded one inside sendToOrb')
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

  const start = source.slice(source.indexOf('async function start()'))
  const select = start.indexOf('selectMainCameraSource(process.env)')
  const permission = start.indexOf('await requestLocalCameraPermission(')
  const settings = start.indexOf('await loadSettings(')
  const launch = start.indexOf('await launchBackend(')
  assert.ok(select >= 0 && permission > select, 'validated selection precedes permission')
  assert.ok(settings > permission, 'permission decision precedes settings startup work')
  assert.ok(launch > settings, 'validated selection precedes backend launch')
})

test('camera bootstrap and protocol wiring catch canonical path disclosure or renderer URL choice', async () => {
  const main = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const renderer = await readFile(new URL('../src/renderer/index.mjs', import.meta.url), 'utf8')

  assert.match(main, /import \{ selectMainCameraSource \} from '.\/camera-source\.mjs'/)
  const bootstrapAssignment = main.slice(main.indexOf('bootstrap = Object.freeze({'))
  const bootstrapBody = bootstrapAssignment.slice(0, bootstrapAssignment.indexOf('})'))
  assert.match(bootstrapBody, /cameraSource/)
  assert.doesNotMatch(
    bootstrapBody,
    /camera\.file|cameraPath|NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE|file:|nova:\/\/orb\/camera-source/u,
  )

  const load = main.slice(main.indexOf('loadAppWindow(mainWindow'))
  const loadOptions = load.slice(0, load.indexOf('}).then('))
  assert.match(loadOptions, /cameraFile: camera\.source === 'file' \? camera\.file : undefined/)
  assert.match(loadOptions, /fetchCameraFile: \(url, init\) => net\.fetch\(url, init\)/)
  assert.doesNotMatch(loadOptions, /request\.url|pathname|query|decodeURI/u)

  const boot = renderer.slice(renderer.indexOf('async function boot()'))
  const mode = boot.indexOf('cameraController.setSourceMode(bootstrap.cameraSource)')
  const socket = boot.indexOf('new WebSocket(bootstrap.endpoint)')
  assert.ok(mode >= 0 && socket > mode, 'immutable mode is installed before any host request can arrive')
  assert.doesNotMatch(boot.slice(0, socket), /cameraPath|camera\.file|NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE/u)
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
