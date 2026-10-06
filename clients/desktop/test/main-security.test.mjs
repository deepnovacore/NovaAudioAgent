import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { acceptanceWakeSettings } from '../src/main/workbench-native-acceptance.mjs'
import { createWorkbenchFrame } from '../src/main/workbench-frame.mjs'
import * as settingsCategories from '../src/renderer/settings-categories.mjs'
import { createContext, runInContext } from 'node:vm'

test('main owns single-instance lifecycle and denies renderer escape', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  assert.match(source, /requestSingleInstanceLock/)
  assert.match(source, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/)
  assert.match(source, /configureWindowSecurity\(window,/)
  assert.match(source, /loadAppWindow\(mainWindow/)
  assert.match(source, /Number\.isInteger\(code\) \? code\.toString\(\) : 'none'/)
  assert.match(source, /apiKeyWindowOpenHandler\(url => shell\.openExternal\(url\)\)/)
})

test('preload exposes only bounded bootstrap native-audio menu and board channels', async () => {
  const source = await readFile(new URL('../src/preload/preload.cjs', import.meta.url), 'utf8')

  assert.match(source, /bootstrap: \(\) => ipcRenderer\.invoke\('nova:bootstrap'\)/)
  const channels = [...source.matchAll(/['"](nova:[^'"]+)['"]/g)].map(match => match[1])
  assert.deepEqual([...new Set(channels)].sort(), [
    'nova:backend-exit',
    'nova:backend-ready',
    'nova:backend-status',
    'nova:backend:retry',
    'nova:bootstrap',
    'nova:bubble-layout',
    'nova:bubbles:reserve',
    'nova:camera:devices',
    'nova:camera:devices-result',
    'nova:camera:enumerate',
    'nova:camera:permission',
    'nova:capabilities:probe',
    'nova:codex:rescan',
    'nova:confirmation-mode',
    'nova:confirmation-placement',
    'nova:executor-result:open',
    'nova:knowledge:action',
    'nova:memory-board:clear',
    'nova:memory-board:copy-json',
    'nova:memory-board:export',
    'nova:memory-board:request',
    'nova:microphone:permission',
    'nova:microphone:retry',
    'nova:microphone:status',
    'nova:microphone:toggle',
    'nova:native-audio:capture',
    'nova:native-audio:clear',
    'nova:native-audio:event',
    'nova:native-audio:play',
    'nova:native-audio:playback-muted',
    'nova:native-audio:terminal',
    'nova:orb-menu:show',
    'nova:orb:dormant',
    'nova:personal:article',
    'nova:personal:collapsed',
    'nova:personal:connector-authorization',
    'nova:personal:directory',
    'nova:personal:feishu-verification',
    'nova:personal:presentation',
    'nova:personal:presentation-error',
    'nova:personal:presentation-request',
    'nova:personal:unread',
    'nova:personal:wake',
    'nova:phone:action',
    'nova:projects:repair',
    'nova:release-camera:result',
    'nova:settings:changed',
    'nova:settings:feishu',
    'nova:settings:get',
    'nova:settings:open',
    'nova:settings:personal',
    'nova:settings:set',
    'nova:settings:voiceprint',
    'nova:setup:changed',
    'nova:setup:open',
    'nova:setup:save',
    'nova:setup:status',
    'nova:setup:test-key',
    'nova:voiceprint:gate-ready',
    'nova:voiceprint:recording',
    'nova:wake-word:activity',
    'nova:wake-word:audio',
    'nova:wake-word:changed',
    'nova:wake-word:report',
    'nova:wake-word:retry',
    'nova:wake-word:sleep',
    'nova:wake-word:wake',
    'nova:window-drag:end',
    'nova:window-drag:move',
    'nova:window-drag:start',
    'nova:window:control',
    'nova:workspaces:clear-all',
    'nova:workspaces:clear-current',
    'nova:workspaces:open-current',
  ])
  assert.doesNotMatch(source, /sendSync/)
})

test('记忆面板 copy stays in sender-validated main IPC instead of web clipboard permission', async () => {
  const main = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const renderer = await readFile(new URL('../src/renderer/memory-board.mjs', import.meta.url), 'utf8')

  assert.match(main, /ipcMain\.handle\('nova:memory-board:copy-json', async event => \{\n\s*if \(!boardWindow \|\| event\.sender !== boardWindow\.webContents\)/u)
  assert.match(main, /clipboard\.writeText\(formatted\.body\)/u)
  assert.doesNotMatch(renderer, /navigator\.clipboard/u)
})

test('记忆面板 clear is zero-argument, sender-bound, single-flight, and rechecks its captured owner', async () => {
  const main = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const preload = await readFile(new URL('../src/preload/preload.cjs', import.meta.url), 'utf8')
  const renderer = await readFile(new URL('../src/renderer/memory-board.mjs', import.meta.url), 'utf8')
  const start = main.indexOf("ipcMain.handle('nova:memory-board:clear'")
  const handler = main.slice(start, main.indexOf("ipcMain.handle('nova:memory-board:copy-json'", start))

  assert.notEqual(start, -1)
  assert.match(handler, /async \(event, \.\.\.args\) =>/)
  assert.match(handler, /!boardWindow \|\| event\.sender !== boardWindow\.webContents \|\| args\.length !== 0/)
  assert.match(handler, /if \(clearingConversation\) return clearingConversation/)
  assert.match(handler, /const owner = backendControl, generation = backendGeneration, window = boardWindow/)
  assert.match(handler, /await dialog\.showMessageBox\(window,/)
  assert.match(handler, /owner !== backendControl \|\| generation !== backendGeneration \|\| window !== boardWindow \|\| window\.isDestroyed\(\)/)
  assert.match(handler, /owner\.request\('conversation\.clear', \{\}, \{timeoutMs: 60000\}\)/)
  assert.match(handler, /if \(owner !== backendControl \|\| generation !== backendGeneration\) return \{error: 'unavailable'\}/)
  assert.match(preload, /clear: \(\) => ipcRenderer\.invoke\('nova:memory-board:clear'\)/)
  assert.match(renderer, /if \(clearInFlight \|\| copyInFlight \|\| exportInFlight\) return/)
})

async function extractedMemoryBoardClear(dialog, owner) {
  const main = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const start = main.indexOf("ipcMain.handle('nova:memory-board:clear'")
  const source = main.slice(start, main.indexOf("ipcMain.handle('nova:memory-board:copy-json'", start))
  let handler
  const sender = {}
  const context = createContext({
    t: value => value,
    ipcMain: {handle: (_channel, value) => { handler = value }},
    t: value => value,
    dialog, backendControl: owner, backendGeneration: 1,
    backendStatus: {state: 'connected'}, clearingConversation: null,
    boardWindow: {webContents: sender, isDestroyed: () => false},
  })
  runInContext(source, context)
  return {context, handler, sender}
}

test('a synchronous clear confirmation failure releases the actual main-handler single-flight cache', async () => {
  let confirmations = 0, requests = 0
  const owner = {request: async () => { requests += 1; return {cleared: true} }}
  const {context, handler, sender} = await extractedMemoryBoardClear({showMessageBox: () => {
    confirmations += 1
    if (confirmations === 1) throw new Error('dialog unavailable')
    return Promise.resolve({response: 1})
  }}, owner)

  assert.equal((await handler({sender})).error, 'unavailable')
  assert.equal(context.clearingConversation, null)
  assert.equal((await handler({sender})).cleared, true)
  assert.equal(confirmations, 2)
  assert.equal(requests, 1)
  assert.equal(context.clearingConversation, null)
})

test('owner replacement during clear confirmation prevents the actual main handler from mutating', async () => {
  let resolveConfirmation, requests = 0
  const owner = {request: async () => { requests += 1; return {cleared: true} }}
  const {context, handler, sender} = await extractedMemoryBoardClear({showMessageBox: () => new Promise(resolve => { resolveConfirmation = resolve })}, owner)

  const pending = handler({sender})
  context.backendControl = {request: async () => ({cleared: true})}
  context.backendGeneration = 2
  resolveConfirmation({response: 1})
  assert.equal((await pending).error, 'unavailable')
  assert.equal(requests, 0)
  assert.equal(context.clearingConversation, null)
})

test('microphone permission starts from the ready orb and every IPC edge is sender-bound', async () => {
  const main = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const preload = await readFile(new URL('../src/preload/preload.cjs', import.meta.url), 'utf8')
  const renderer = await readFile(new URL('../src/renderer/index.mjs', import.meta.url), 'utf8')

  const start = main.slice(main.indexOf('async function start()'))
  assert.doesNotMatch(start.slice(0, start.indexOf('\n}')), /resolveMicrophonePermission/)
  assert.match(main, /ipcMain\.handle\('nova:microphone:permission', async event => \{\n\s*if \(!mainWindow \|\| event\.sender !== mainWindow\.webContents\)/)
  assert.match(main, /resolveMicrophonePermission\(\{\s*platform: process\.platform,\s*systemPreferences,?\s*\}\)/)
  assert.match(main, /ipcMain\.on\('nova:microphone:status', \(event, status\) => \{\n\s*if \(!mainWindow \|\| event\.sender !== mainWindow\.webContents\) return/)
  assert.match(main, /ipcMain\.handle\('nova:microphone:retry', event => \{\n\s*if \(!settingsWindow \|\| event\.sender !== settingsWindow\.webContents\)/)
  assert.match(preload, /requestPermission: \(\) => ipcRenderer\.invoke\('nova:microphone:permission'\)/)
  assert.match(preload, /report: status => ipcRenderer\.send\('nova:microphone:status', status\)/)
  assert.match(renderer, /await window\.novaAudioAgentDesktop\.microphone\.requestPermission\(\)/)
  assert.match(renderer, /preflightMicrophone\(\{[\s\S]*systemStatus:/)
})

test('main owns the fixed orb menu and validates every menu and board sender', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  assert.match(source, /ipcMain\.on\('nova:orb-menu:show', event => \{\n\s*if \(mainWindow && event\.sender === mainWindow\.webContents\)/)
  assert.match(source, /记忆面板/)
  assert.match(source, /退出 Nova Audio Agent/)
  assert.match(source, /click: \(\) => app\.quit\(\)/)
  assert.match(source, /event\.sender !== boardWindow\.webContents/)
  assert.match(source, /event\.sender === mainWindow\.webContents/)

  const renderer = await readFile(new URL('../src/renderer/index.mjs', import.meta.url), 'utf8')
  assert.match(renderer, /contextmenu/)
  assert.match(renderer, /event\.preventDefault\(\)/)
  assert.match(renderer, /orbMenu\.show\(\)/)
})


test('a hidden orb window is never shrunk, and comes back at natural size', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  // Executed rather than pattern-matched: the point is the behaviour, and a
  // regex would keep passing if the visibility check moved below setDormant.
  const body = source.match(
    /ipcMain\.on\('nova:orb:dormant', \(event, active\) => \{([\s\S]*?)\n  \}\)/,
  )[1]
  const run = (visible, active) => {
    const calls = []
    const webContents = {}
    const mainWindow = { webContents, isVisible: () => visible }
    const orbWindow = { setDormant: value => calls.push(value) }
    new Function('mainWindow', 'orbWindow', 'ipcMain', `
      const handler = (event, active) => {${body}}
      handler({sender: mainWindow.webContents}, ${JSON.stringify(active)})
    `)(mainWindow, orbWindow, {on: () => {}})
    return calls
  }

  // The renderer cannot tell an idle doze from a tray hide: it gets the same
  // 'sleeping' wake state either way, and Electron still reports the document
  // as visible while the window is hidden. So the side that called hide() has
  // to refuse, or the hidden window shrinks and pops back as a bubble.
  assert.deepEqual(run(false, true), [], 'a hidden window must not shrink')
  assert.deepEqual(run(true, true), [true], 'a visible window still rests')
  assert.match(source, /setBounds: bounds => \{ if \(personalCollapsed\) mainWindow\.setBounds\(bounds\) \}/, 'orb size updates do not resize the expanded workspace')

  // And whatever was ignored while hidden is undone on the way back.
  assert.match(
    source,
    /mainWindow\.on\('show', \(\) => \{ if \(personalCollapsed\) orbWindow\.setDormant\(false\) \}\)/,
  )
})

test('registers the orb context-menu channel exactly once', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  const registrations = source.match(/ipcMain\.on\(\s*'nova:orb-menu:show'/g) || []
  assert.equal(registrations.length, 1)
})

test('registers the settings-open channel exactly once and sender-bound', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  const registrations = source.match(/ipcMain\.on\(\s*'nova:settings:open'/g) || []
  assert.equal(registrations.length, 1)
  assert.match(
    source,
    /ipcMain\.on\('nova:settings:open', \(event, category\) => \{\n    if \(mainWindow && event\.sender === mainWindow\.webContents\) openSettingsWindow\(launchId, isValidCategory\(category\) \? \{category\} : \{\}\)\n  \}\)/,
  )
})

test('the settings-open channel forwards only known categories', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const block = source.slice(source.indexOf("  ipcMain.on('nova:settings:open'"), source.indexOf("  ipcMain.handle('nova:memory-board:request'"))
  const opened = []
  let receive
  new Function('ipcMain', 'mainWindow', 'openSettingsWindow', 'launchId', 'isValidCategory', block)(
    {on: (_, fn) => { receive = fn }}, {webContents: {}}, (...args) => opened.push(args), 'launch', settingsCategories.isValidCategory)
  const sender = {}
  receive({sender}, 'connections')
  receive({sender: {webContents: {}}}, 'connections')
  for (const bad of ['__proto__', 'x'.repeat(4096), 42, null, undefined, {id: 'im'}]) receive({sender}, bad)
  assert.equal(opened.length, 0, 'a foreign sender never opens settings')
  const main = {webContents: sender}
  new Function('ipcMain', 'mainWindow', 'openSettingsWindow', 'launchId', 'isValidCategory', block)(
    {on: (_, fn) => { receive = fn }}, main, (...args) => opened.push(args), 'launch', settingsCategories.isValidCategory)
  receive({sender}, 'connections')
  for (const bad of ['__proto__', 'x'.repeat(4096), 42, null, undefined, {id: 'im'}]) receive({sender}, bad)
  assert.deepEqual(opened, [['launch', {category: 'connections'}], ...Array(6).fill(['launch', {}])])
})

test('the orb menu opens the settings panel above the quit separator', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const menu = source.slice(source.indexOf('function showOrbMenu('))
  const body = menu.slice(0, menu.indexOf('.popup('))

  assert.match(body, /label: t\("设置…"\), click: \(\) => openSettingsWindow\(launchId\)/)
  assert.ok(
    body.indexOf('label: t("设置…")') < body.indexOf("{ type: 'separator' }"),
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
  assert.match(body, /if \(settingsWindow\) \{\n\s*settingsWindow\.show\(\)\n\s*settingsWindow\.focus\(\)[\s\S]*refreshManagedWorkspaceCapabilities\(\)[\s\S]*return\n\s*\}/)
  assert.match(body, /settingsWindowOptions\(preload, launchId\)/)
  assert.match(body, /setWindowOpenHandler\(apiKeyWindowOpenHandler\(url => shell\.openExternal\(url\)\)\)/)
  assert.match(body, /allowRendererNavigation\(url\)/)
  assert.match(body, /settingsWindow = null/)
  assert.match(body, /loadURL\('nova:\/\/orb\/settings\.html'\)/)
  // The microphone grant belongs to the orb: the settings panel shares the
  // session partition but must never re-bind its permission handlers.
  assert.doesNotMatch(body, /setPermission|configureWindowSecurity/)
})

test('settings IPC is sender-validated and answers from main without an orb relay', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  assert.match(source, /ipcMain\.handle\('nova:settings:get', async event => \{\n\s*if \(!settingsWindow \|\| event\.sender !== settingsWindow\.webContents\)/)
  assert.match(source, /ipcMain\.handle\('nova:settings:set', async \(event, payload, restart = false\) => \{\n\s*if \(!settingsWindow \|\| event\.sender !== settingsWindow\.webContents\)/)
  assert.match(source, /function publishCommittedSettings\(\) \{[\s\S]*sendToOrb\('nova:settings:changed', orbSettings\(currentSettings\)\)/)
  // No requestId machinery: settings live in main, so nothing round-trips
  // through the orb renderer the way the memory board has to.
  const set = source.slice(source.indexOf("async function applyDesktopSettings"))
  assert.doesNotMatch(set.slice(0, set.indexOf('\n}')), /requestId|pendingBoardRequests/)
})

test('Codex rescan is restricted to the settings window sender', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  assert.match(
    source,
    /ipcMain\.handle\('nova:codex:rescan', async event => \{\n\s*if \(!settingsWindow \|\| event\.sender !== settingsWindow\.webContents\)/,
  )
  const rescan = source.slice(source.indexOf("ipcMain.handle('nova:codex:rescan'"))
  const handler = rescan.slice(0, rescan.indexOf('\n  })'))
  assert.match(handler, /coordinateCodexRescan\(\{/)
  assert.match(handler, /coordinator: lifecycleCoordinator/)
  assert.match(handler, /currentConfiguration: \(\) => Object\.freeze\(\{config: desktopConfig, codexStatus\}\)/)
  assert.match(handler, /discardConfiguration: discardDesktopConfiguration/)
  assert.match(handler, /managedWorkspaceBackendRecovery\.restart\(\)/)
  assert.match(handler, /managedWorkspaceBackendRecovery\.retry\(\)/)
  assert.match(handler, /view: settingsView/)
})

test('managed workspace actions are zero-argument and bound to the live settings sender', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  for (const channel of [
    'nova:workspaces:open-current',
    'nova:workspaces:clear-current',
    'nova:workspaces:clear-all',
  ]) {
    const start = source.indexOf(`ipcMain.handle('${channel}'`)
    assert.notEqual(start, -1)
    const body = source.slice(start, source.indexOf('\n  })', start))
    assert.match(body, /async \(event, \.\.\.args\) =>/)
    assert.match(body, /!settingsWindow \|\| event\.sender !== settingsWindow\.webContents \|\| args\.length !== 0/)
  }
  const view = source.slice(source.indexOf('function settingsView()'))
  const viewBody = view.slice(0, view.indexOf('\n}'))
  assert.match(viewBody, /managedWorkspaces:/)
  const managedView = source.slice(source.indexOf('function managedWorkspacesView()'))
  const managedViewBody = managedView.slice(0, managedView.indexOf('\n}'))
  assert.match(managedViewBody, /health:/)
  assert.match(managedViewBody, /current:/)
  assert.match(managedViewBody, /all:/)
  assert.match(managedViewBody, /recoveryStatus: managedWorkspaceBackendRecovery\.status\(\)/)
  assert.match(managedViewBody, /lifecycleBusy: lifecycleCoordinator\.busy/)
  assert.doesNotMatch(viewBody, /canonical_path|workspace_id|identity|tombstone/u)
  const reply = source.slice(source.indexOf('const workspaceActionReply = async action =>'))
  const replyBody = reply.slice(0, reply.indexOf('\n  }'))
  assert.match(replyBody, /managedWorkspaces: managedWorkspacesView\(\)/)
  assert.doesNotMatch(replyBody, /settingsView\(\).*\}/u)
})

test('rollback recovery gates startup, save restart, rescan, and explicit backend retry', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  assert.match(source, /createManagedWorkspaceBackendRecovery/)
  assert.match(source, /void managedWorkspaceBackendRecovery\.start\(\)/)
  const commit = source.slice(source.indexOf('async function commitDesktopConfiguration'))
  assert.match(commit.slice(0, commit.indexOf('\n}')), /reconcileExternalCleanup\(\)/)
  const retry = source.slice(source.indexOf("ipcMain.handle('nova:backend:retry'"))
  const retryHandler = retry.slice(0, retry.indexOf('\n  })'))
  assert.match(retryHandler, /async \(event, \.\.\.args\) =>/)
  assert.match(retryHandler, /event\.sender !== settingsWindow\.webContents \|\| args\.length !== 0/)
  assert.match(retryHandler, /coordinateBackendRetry/)
  assert.match(retryHandler, /lifecycleCoordinator/)
  assert.match(retryHandler, /operationStatus: 'busy'/)
  const refresh = source.slice(source.indexOf('async function refreshManagedWorkspaceCapabilities()'))
  const refreshBody = refresh.slice(0, refresh.indexOf('\n}'))
  assert.match(
    refreshBody,
    /managedWorkspaceBackendRecovery\.observe\(\s*managedWorkspaceCapabilities,\s*projectNativeAuthorityPresent,?\s*\)/,
  )
  const recovery = source.slice(source.indexOf('const managedWorkspaceBackendRecovery ='))
  const recoveryBody = recovery.slice(0, recovery.indexOf('\n})') + 3)
  assert.match(recoveryBody, /stopBackend:/)
  assert.match(recoveryBody, /backendSupervisor\.stop\(\)/)
  assert.match(recoveryBody, /retryBackend:[\s\S]*backendSupervisor\.status\(\)\.state === 'connected'/)
  const settings = source.slice(source.indexOf("async function applyDesktopSettings"))
  const settingsHandler = settings.slice(0, settings.indexOf('\n}'))
  assert.match(settingsHandler, /restartBackend: restartSettingsBackend/)
  const activation = source.slice(source.indexOf('async function restartSettingsBackend'))
  assert.match(activation.slice(0, activation.indexOf('\n}')), /managedWorkspaceBackendRecovery\.restart\(\)/)
  assert.match(activation.slice(0, activation.indexOf('\n}')), /managedWorkspaceBackendRecovery\.retry\(\)/)
})

test('no decrypted secret can reach the renderer or a log line', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  // Only the presence map and the non-secret fields are ever returned to the panel.
  assert.match(source, /function settingsView\(\) \{/)
  assert.match(source, /\.\.\.publicSettings\(currentSettings\)/)
  assert.match(source, /secretsPresent: effectivePresence/)
  assert.match(source, /Object.entries\(secretsPresent\(currentSettings\)\)/)
  // The warning flag is about the *file*, not only about today's keyring: an
  // entry written while no keyring existed keeps it on until it is re-sealed.
  assert.match(
    source,
    /keyringAvailable: hasPlaintextSecret\(currentSettings\) \? false : keyringAvailable/,
  )
  // The failure log for a settings save names the error type only, never the payload.
  assert.match(source, /settings_save_failure/)
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

  const set = source.slice(source.indexOf("async function applyDesktopSettings"))
  const handler = set.slice(0, set.indexOf('\n}'))
  assert.match(handler, /applySettingsTransaction\(\{/)
  assert.match(handler, /write: async value => \{[\s\S]*await accessCredentials\(\(\) => settingsWriter\(commit\.settingsPatch \?\? \{\}, next =>/)
  assert.match(handler, /coordinator: lifecycleCoordinator/)
  assert.doesNotMatch(
    handler,
    /applySettingsUpdate|currentSettings = /,
    'the handler no longer computes or commits state on its own',
  )
})

test('a stored secret that would poison the child environment blocks spawn', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const decrypt = source.slice(source.indexOf('function decryptSecretsForSpawn('))
  const body = decrypt.slice(0, decrypt.indexOf('\n}\n'))

  // A NUL in an env value makes Node refuse the spawn, which would quit the app
  // before the panel could clear the offending key. Refuse the attempt and
  // name only the allowlisted key, never its content.
  assert.match(body, /secretValueIsSafe\(plaintext\)/)
  assert.match(body, /settings_secret_invalid key=\$\{key\}/)
  assert.match(body, /throw classifyBackendFailure\('credential_invalid'\)/)
})

test('readSecret is wired at the spawn site, decrypting only what backendLaunchSpec receives', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  // Now consciously wired: the pin from before Task 20 (`doesNotMatch(/readSecret/)`)
  // is gone, because secrets must reach the spawned backend somehow.
  const readSecretSite = source.indexOf('readSecret(')
  const spawnSite = source.indexOf('spawnedBackend = utilityProcess.fork(')
  assert.ok(readSecretSite >= 0, 'readSecret must be wired now that spawn needs decrypted secrets')
  assert.ok(spawnSite >= 0, 'the backend is still spawned here')
  assert.ok(readSecretSite < spawnSite, 'secrets are decrypted before the backend is spawned')

  // The decrypted secrets reach backendLaunchSpec, not any wider scope.
  const specCall = source.slice(source.indexOf('const spec = backendLaunchSpec({'))
  const specBody = specCall.slice(0, specCall.indexOf('\n    })'))
  assert.match(specBody, /settings: acceptanceBackendSettings\(currentSettings,\s*acceptance\)/)
  assert.match(specBody, /decryptedSecrets,?/)

  // The decrypted value never survives past the call that builds `spec`: no
  // module-level `let`/`var decryptedSecrets` binding exists anywhere.
  assert.doesNotMatch(source, /\b(?:let|var)\s+decryptedSecrets\b/)
})

test('the bootstrap payload carries only orb-owned settings', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  const assignment = source.slice(source.indexOf('bootstrap = Object.freeze({'))
  assert.match(assignment.slice(0, assignment.indexOf('})')), /settings: orbSettings\(currentSettings\)/)
  assert.match(source, /currentSettings = recovered \?\? await loadSettings\(settingsFile\(\), app\.getPreferredSystemLanguages\(\)\)/)
})

test('quitting drains the backend on the stdin sentinel instead of killing it', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const beforeQuit = source.slice(source.indexOf("app.on('before-quit'"), source.indexOf("app.on('window-all-closed'"))

  assert.match(beforeQuit, /event\.preventDefault\(\)/)
  assert.match(beforeQuit, /shutdownBackendBestEffort\(backend\)/)
  assert.match(beforeQuit, /app\.quit\(\)/)
  assert.doesNotMatch(beforeQuit, /app\.exit\(/)
  // Every teardown path goes through the helper, so no bare signal survives.
  assert.doesNotMatch(source, /backend\??\.kill\(/)
})

test('a backend that fails to spawn is handled rather than thrown at the main process', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  const spawnSite = source.indexOf('spawnedBackend = utilityProcess.fork(')
  const watchSite = source.indexOf('watchBackendExit(spawnedBackend')
  assert.ok(spawnSite >= 0, 'the backend is still spawned here')
  assert.ok(watchSite > spawnSite, "the death hooks must be registered right after spawn")
  // ENOENT emits 'error' *instead of* 'exit', so an exit-only hook is the bug:
  // both paths go through the one helper.
  assert.doesNotMatch(source, /backend\.once\('exit'/)
  assert.doesNotMatch(source, /backend\.on\('error'/)
})

test('backend status survives startup races and is replayed after renderer load', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  assert.match(source, /let backendStatus = Object\.freeze/)
  assert.match(source, /backendStatus = status/)
  const load = source.slice(source.indexOf('loadAppWindow(mainWindow'))
  assert.match(load.slice(0, load.indexOf('tray = createTray()')), /sendToOrb\('nova:backend-ready', backendStatus\.connection\)/)
})

test('the bootstrap answer carries the current supervised connection at invoke time', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  // Braces: the renderer already awaits this reply, so a verdict carried on it cannot
  // lose the race against its own listener bind the way a push can.
  const handler = source.slice(source.indexOf("ipcMain.handle('nova:bootstrap'"))
  assert.match(handler.slice(0, handler.indexOf('})')), /backendStatus\.connection/)
  const frozen = source.slice(source.indexOf('bootstrap = Object.freeze({'))
  assert.doesNotMatch(frozen.slice(0, frozen.indexOf('})')), /backendStatus/)
})

test('renderer accepts both supervised disconnect and reconnect events', async () => {
  const source = await readFile(new URL('../src/renderer/index.mjs', import.meta.url), 'utf8')

  assert.match(source, /new BackendReconnectController\(/)
  assert.match(source, /function handleBackendExit\(\)/)
  assert.match(source, /function connectBackend\(connection\)/)
  assert.match(source, /backendRecovery\.socketClosed\(event\)/)
  assert.match(source, /backendRecovery\.socketOpened\(\)/)
  assert.match(source, /backendRecovery\.backendExited\(\)/)
  assert.match(source, /playback\.backendExited\(\)/)
  assert.match(source, /onBackendExit\(handleBackendExit\)/)
  assert.match(source, /onBackendReady\(connectBackend\)/)
  assert.match(source, /if \(bootstrap\.backend\) connectBackend\(bootstrap\.backend\)/)
})

test('a cold start with no backend yet never fires the disconnect path', async () => {
  const source = await readFile(new URL('../src/renderer/index.mjs', import.meta.url), 'utf8')

  // 'stopped' is the initial, never-started state; 'starting' is on its way up.
  // Only a real exit (any other state) may call handleBackendExit here.
  assert.match(source, /else if \(axes\.backendState !== 'stopped' && axes\.backendState !== 'starting'\) handleBackendExit\(\)/)
})

test('main does not raise the backend-exit banner before the backend has ever started', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  const load = source.slice(source.indexOf('void rendererLoaded.then'))
  const body = load.slice(0, load.indexOf('}).catch('))
  assert.match(body, /else if \(backendStatus\.state !== 'starting' && backendStatus\.state !== 'stopped'\) sendToOrb\('nova:backend-exit'\)/)
})

test('every renderer push is guarded against a destroyed orb window', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  // `mainWindow` is never nulled on close, so an unguarded send throws
  // "Object has been destroyed" into the main process. One guard, one place.
  assert.match(source, /function sendToWindow\(window, channel, \.\.\.args\) \{/)
  assert.match(source, /if \(window && !window\.isDestroyed\(\)\)/)
  assert.match(source, /sendToWindow\(mainWindow, channel, \.\.\.args\)/)
  assert.match(source, /sendToWindow\(settingsWindow, channel, \.\.\.args\)/)
  const sends = source.match(/webContents\.send\(/g) || []
  assert.equal(sends.length, 1, 'the only raw send is the shared guarded helper')
})

test('supervisor publishes live connection state to an open settings panel', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const statusHandler = source.slice(source.indexOf('onStatus: status => {'))
  assert.match(statusHandler.slice(0, statusHandler.indexOf('\n    },')), /sendToSettings\('nova:settings:changed', settingsView\(\)\)/)
})

test('a saved configuration reports bounded transaction phases without falsifying backend status', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const apply = await readFile(new URL('../src/main/settings-apply.mjs', import.meta.url), 'utf8')
  const set = source.slice(source.indexOf("async function applyDesktopSettings"))
  const handler = set.slice(0, set.indexOf('\n}'))

  assert.match(source, /settingsApplyStatus/)
  assert.match(handler, /publishStatus: publishSettingsApplyStatus/)
  assert.match(handler, /restartBackend: restartSettingsBackend/)
  assert.match(source, /backendSupervisor\?\.status\(\)\.state !== 'connected'/)
  assert.match(handler, /discardConfiguration: discardDesktopConfiguration/)
  for (const phase of ['saving', 'refreshing', 'restarting', 'applied']) {
    assert.match(apply, new RegExp(`publishStatus\\('${phase}'\\)`))
  }
  assert.match(handler, /return \{\.\.\.settingsView\(\), \.\.\.applied\}/)
  assert.doesNotMatch(handler, /backendStatus\s*=/)
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

test('main starts without camera permission and exposes only an explicit sender-bound request', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const preload = await readFile(new URL('../src/preload/preload.cjs', import.meta.url), 'utf8')

  const start = source.slice(source.indexOf('async function start()'))
  assert.match(start, /return startWithSelectedCamera\(\{/u)
  assert.match(start, /environment: process\.env/u)
  assert.doesNotMatch(start.slice(0, start.indexOf('\n}')), /CameraPermission|camera:permission/u)
  assert.match(
    start,
    /start: camera => startSelectedCamera\(camera, releaseSmokeChannel\)/u,
  )
  assert.match(source, /ipcMain\.handle\('nova:camera:permission', async event => \{\n\s*if \(\(!mainWindow \|\| event\.sender !== mainWindow\.webContents\) && \(!settingsWindow \|\| event\.sender !== settingsWindow\.webContents\)\)/u)
  assert.match(source, /resolveCameraPermission\(camera\.source, \{/u)
  assert.match(preload, /requestPermission: \(\) => ipcRenderer\.invoke\('nova:camera:permission'\)/u)
})

test('backend mode is admitted before camera selection or permission work', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const start = source.slice(source.indexOf('async function start()'))
  const body = start.slice(0, start.indexOf('\n}\n'))
  const selection = body.indexOf('selectedBackend(process.env, { isPackaged: app.isPackaged })')
  const camera = body.indexOf('startWithSelectedCamera({')

  assert.ok(selection >= 0 && camera > selection)
  assert.match(body, /createReleaseSmokeChannel\(\{/u)
  assert.match(body, /start: camera => startSelectedCamera\(camera, releaseSmokeChannel\)/u)
  assert.match(
    source,
    /process\.stderr\.write\(\s*'\[desktop-diagnostic\] source_rollback_unavailable\\n',\s*\(\) => app\.exit\(0\),?\s*\)/u,
  )
  assert.match(source, /releaseSmokeSourceRollbackExitCode\(\{/u)
  assert.match(source, /app\.exit\(sourceRollbackExitCode\)/u)
  const rollbackPreflight = source.indexOf("process.env.BACKEND === 'python'")
  assert.ok(rollbackPreflight >= 0 && rollbackPreflight < source.indexOf('app.requestSingleInstanceLock()'))
})

test('packaged smoke readiness is private, post-backend, and closed by every quit', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  assert.match(source, /from '.\/release-smoke-channel\.mjs'/u)
  assert.match(source, /let releaseSmokeChannel = null/u)
  const launch = source.slice(source.indexOf('async function launchBackend('))
  const launchBody = launch.slice(0, launch.indexOf('\n}\n'))
  assert.ok(launchBody.indexOf('await listener.readiness') < launchBody.indexOf('smokeChannel?.ready({'))
  assert.match(launchBody, /endpoint: validated\.endpoint, token/u)
  const start = source.slice(source.indexOf('async function startSelectedCamera('))
  const startBody = start.slice(0, start.indexOf('\n}\n'))
  assert.match(
    startBody,
    /smokeChannel === null[\s\S]*sendToOrb\('nova:backend-ready', backendStatus\.connection\)/u,
  )
  assert.match(
    startBody,
    /smokeChannel === null && status\.state === 'connected'[\s\S]*sendToOrb\('nova:backend-ready', status\.connection\)/u,
  )
  const quit = source.slice(source.indexOf("app.on('before-quit'"))
  assert.match(quit, /releaseSmokeChannel\?\.close\(\)/u)
})

test('a supported native authority load failure remains present for backend recovery gating', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  assert.match(source, /inspectProjectNativeHostFromResources/u)
  assert.match(source, /projectNativeAuthorityPresent = projectNativeLoad\.status !== 'absent'/u)
  assert.match(
    source,
    /observe\(\s*managedWorkspaceCapabilities,\s*projectNativeAuthorityPresent,?\s*\)/u,
  )
  assert.match(source, /hasMaintenanceAuthority: \(\) => projectNativeAuthorityPresent/u)
})

test('camera bootstrap and protocol wiring catch canonical path disclosure or renderer URL choice', async () => {
  const main = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const renderer = await readFile(new URL('../src/renderer/index.mjs', import.meta.url), 'utf8')

  assert.match(main, /import \{ startWithSelectedCamera \} from '.\/camera-source\.mjs'/)
  const bootstrapAssignment = main.slice(main.indexOf('bootstrap = Object.freeze({'))
  const bootstrapBody = bootstrapAssignment.slice(0, bootstrapAssignment.indexOf('})'))
  assert.match(bootstrapBody, /cameraSource/)
  assert.doesNotMatch(
    bootstrapBody,
    /camera\.file|cameraPath|DESKTOP_VIDEO_FILE|file:|nova:\/\/orb\/camera-source/u,
  )

  const load = main.slice(main.indexOf('loadAppWindow(mainWindow'))
  const loadOptions = load.slice(0, load.indexOf('}).then('))
  assert.match(loadOptions, /cameraFile: camera\.source === 'file' \? camera\.file : undefined/)
  assert.match(loadOptions, /fetchCameraFile: \(url, init\) => net\.fetch\(url, init\)/)
  assert.doesNotMatch(loadOptions, /request\.url|pathname|query|decodeURI/u)

  const boot = renderer.slice(renderer.indexOf('async function boot()'))
  const mode = boot.indexOf('cameraController.setSourceMode(bootstrap.cameraSource)')
  const socket = boot.indexOf('connectBackend(bootstrap.backend)')
  assert.ok(mode >= 0 && socket > mode, 'immutable mode is installed before any host request can arrive')
  assert.doesNotMatch(boot.slice(0, socket), /cameraPath|camera\.file|DESKTOP_VIDEO_FILE/u)
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
  const startBody = source.slice(source.indexOf('async function startSelectedCamera('))
  const platformCheck = startBody.indexOf("process.platform === 'linux'")
  const createWindowCall = startBody.indexOf('createWindow(launchId')
  assert.ok(platformCheck >= 0 && createWindowCall > platformCheck)
  assert.match(startBody.slice(platformCheck, createWindowCall), /LINUX_WINDOW_DELAY_MS/)
})

test('warns instead of silently failing when the global shortcut cannot register', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  const registration = source.slice(source.indexOf('globalShortcut.register('))
  assert.match(
    registration.slice(0, 500),
    /console\.warn\('\[nova-audio-agent-desktop\] global shortcut unavailable on this session'\)/,
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
  // Cool near-black, tracking the plate's own abyss hue. This was a warm brown
  // (rgba(20, 14, 8, .92)) back when the orb's CSS ground was warm too; the
  // fallback plate has to stay the same material as the disc it stands in for.
  assert.match(source, /rgba\(9,\s*8,\s*13,\s*\.94\)/)
  assert.match(source, /border-radius:\s*24px/)
})

test('drag and orb menu paths stay sender validated and bounded', async () => {
  const mainSource = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const rendererSource = await readFile(new URL('../src/renderer/index.mjs', import.meta.url), 'utf8')

  assert.match(mainSource, /event\.sender === mainWindow\.webContents/)
  assert.match(mainSource, /validDragDelta/)
  assert.match(mainSource, /ipcMain\.on\('nova:confirmation-mode', \(event, active\) => \{\n\s*if \(!mainWindow \|\| event\.sender !== mainWindow\.webContents\) return\n\s*if \(typeof active !== 'boolean'\) return/u)
  assert.match(mainSource, /orbWindow\.finishDrag\(position\)/u)
  assert.match(mainSource, /label: t\("退出 Nova Audio Agent"\)/)
  assert.match(mainSource, /click: \(\) => app\.quit\(\)/)
  assert.doesNotMatch(rendererSource, /orb\.addEventListener\('click'/)
  assert.match(rendererSource, /event\.preventDefault\(\)/)
  assert.match(rendererSource, /window\.novaAudioAgentDesktop\.orbMenu\.show\(\)/)
})

test('renderer text startup avoids microphone and explicit voice entry requires preflight', async () => {
  const renderer = await readFile(new URL('../src/renderer/index.mjs', import.meta.url), 'utf8')

  const boot = renderer.slice(renderer.indexOf('async function boot()'), renderer.indexOf('personalView = mountPersonalView'))
  assert.doesNotMatch(boot, /refreshMicrophonePermission|activateCapture/)
  assert.match(boot, /axes\.microphone = 'not_requested'/)
  const voiceEntry = renderer.slice(renderer.indexOf('personalView = mountPersonalView'), renderer.indexOf("orb.addEventListener('pointerdown'"))
  assert.match(voiceEntry, /await refreshMicrophonePermission\(\) !== 'granted'/)
  assert.ok(voiceEntry.indexOf('refreshMicrophonePermission') < voiceEntry.indexOf('activateCapture'))
  assert.match(renderer, /async function retryMicrophonePermission\(\)/)
  const retry=renderer.slice(renderer.indexOf('async function retryMicrophonePermission()'),renderer.indexOf('async function boot()'))
  assert.match(retry,/await refreshMicrophonePermission\(\)/)
  assert.doesNotMatch(retry,/activateCapture\(/)
  assert.match(renderer, /microphone\.onRetry\(\(\) => \{\s*void retryMicrophonePermission\(\)\s*\}\)/)
  assert.doesNotMatch(renderer, /startListeningOnLaunch/)
  assert.doesNotMatch(renderer, /orb\.addEventListener\('click'/)
})

test('speaker output state serializes native mute and disables concurrent toggles', async () => {
  const renderer = await readFile(new URL('../src/renderer/index.mjs', import.meta.url), 'utf8')

  assert.match(renderer, /new OutputMuteController\(/)
  assert.match(renderer, /apply: muted => window\.novaAudioAgentDesktop\.nativeAudio\.setPlaybackMuted\(muted\)/)
  assert.match(renderer, /axes\.outputMutePending = pending/)
  assert.match(renderer, /speakerToggle\.disabled = axes\.outputMutePending/)
  assert.match(renderer, /speakerToggle\.addEventListener\('click', \(\) => \{ void toggleOutputMuted\(\) \}\)/)
})

test('the mute toggle drops microphone input at both ingress points', async () => {
  const renderer = await readFile(new URL('../src/renderer/index.mjs', import.meta.url), 'utf8')

  // Both PCM ingress gates consult the mute gate before anything is consumed.
  assert.match(renderer, /if \(microphoneGated\(\) \|\| event\.data\?\.epoch !== wakeAudio\.epoch\) return/)
  assert.match(renderer, /if \(!nativeReady \|\| microphoneGated\(\) \|\| event\.wakeEpoch !== wakeAudio\.epoch\) return/)
  // The gate covers mute itself plus a drain window after unmute, so capture
  // batches that straddle the unmute click (or arrive late from a stalled
  // queue) never leak audio that was recorded while muted.
  assert.match(renderer, /return voiceprintRecording \|\| !\['dictation', 'voice'\]\.includes\(personalView\.controller\.mode\) \|\| axes\.muted \|\| performance\.now\(\) < muteDrainUntil/)
  assert.match(renderer, /const UNMUTE_DRAIN_MS = 120/)
  assert.match(renderer, /muteDrainUntil = performance\.now\(\) \+ UNMUTE_DRAIN_MS/)
  // Deactivation discards the session's mute, and the rail buttons are wired.
  assert.match(renderer, /axes\.muted = false/)
  assert.match(renderer, /muteToggle\.addEventListener\('click', \(\) => toggleMute\(\)\)/)
  assert.doesNotMatch(renderer, /openSettingsButton/)
  // Opening the orb's voice conversation keeps a sleeping orb asleep; only an explicit start wakes it.
  assert.match(renderer, /start: async \(\{wake = true\} = \{\}\) => \{/)
  assert.match(renderer, /if \(wake\) await window\.novaAudioAgentDesktop\.personal\.wake\(\)/)
  // Sleep belongs to the orb: neither the idle timer nor Ctrl+L puts the workbench to sleep.
  assert.match(renderer, /idle: personalView\?\.controller\.presentationMode === 'orb' && canAutoSleep\(/)
  const main = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  assert.match(main, /function sleepOrb\(\) \{\n  if \(presentationMode === 'orb'\) wakeWord\?\.sleep\('bubble'\)/)
  // Double-click is the orb's way back to the workbench, and a drag that ends on the orb does not count.
  assert.match(renderer, /orb\.addEventListener\('dblclick'/)
  assert.match(renderer, /if \(lastPointerDragged \|\| personalView\?\.controller\.presentationMode !== 'orb'\) return/)
})

for (const hasBackend of [true, false]) test(`quit drains once before normal window shutdown (backend=${hasBackend})`, async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const {default: vm} = await import('node:vm')
  let beforeQuit, releaseMaintenanceDeadline, releaseBackend, timeout
  let prevented = 0, quits = 0, backendStops = 0
  const event = {preventDefault() { prevented++ }}
  const context = vm.createContext({
    sourceSmokeStage() {}, feishuSetupOwner: {release: async () => {}}, cancelPhonePairing: async () => {}, managedPhone: {stop: async () => {}},
    app: {
      on: (name, handler) => { if (name === 'before-quit') beforeQuit = handler },
      quit() { quits++; beforeQuit(event) },
      exit() { assert.fail('normal shutdown must close windows before quitting') },
    },
    wakeWord: null, releaseSmokeChannel: null, globalShortcut: {unregisterAll() {}}, nativeAudio: null,
    backendSupervisor: hasBackend ? {stop: () => { backendStops++; return new Promise(resolve => { releaseBackend = resolve }) }} : null, backend: null,
    managedWorkspaceMaintenance: {close: () => new Promise(() => {})}, quitDrain: null, quitDrained: false,
    wait: milliseconds => { timeout = milliseconds; return new Promise(resolve => { releaseMaintenanceDeadline = resolve }) },
  })
  vm.runInContext(source.slice(source.indexOf("app.on('before-quit'")), context)
  beforeQuit(event)
  beforeQuit(event)
  assert.equal(prevented, 2)
  assert.equal(backendStops, Number(hasBackend))
  assert.equal(timeout, 3000)
  releaseMaintenanceDeadline()
  await Promise.resolve()
  if (hasBackend) {
    assert.equal(quits, 0, 'backend still owns its shutdown deadline')
    releaseBackend()
  }
  await context.quitDrain
  assert.equal(quits, 1)
  assert.equal(prevented, 2, 'the resumed quit must reach normal window shutdown')
  assert.equal(backendStops, Number(hasBackend))
})

test('settings IPC restarts for capability commits while wake-only updates stay local', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const {default: vm} = await import('node:vm')
  const {backendSettings, DEFAULT_SETTINGS} = await import('../src/main/settings-store.mjs')
  const start = source.indexOf("  ipcMain.handle('nova:settings:set'")
  const sharedStart = source.indexOf('async function applyDesktopSettings')
  const sharedSource = source.slice(sharedStart, source.indexOf('\n}', sharedStart) + 2)
  const handlerSource = sharedSource + '\n' + source.slice(start, source.indexOf('\n  })', start) + 5)
  for (const [payload, expectedRestart, pendingRecovery = false] of [
    [{settingsPatch: {wakeWordEnabled: true}}, false],
    [{settingsPatch: {autoHideSeconds: 120}}, false],
    [{settingsPatch: {wakeWordEnabled: true}}, true, true],
    [{settingsPatch: {}, capabilitiesDocument: {}}, true],
    [{settingsPatch: {wakeWordEnabled: true}, capabilitiesDocument: {}}, true],
    [{settingsPatch: {startListeningOnLaunch: true}}, true],
  ]) {
    let handler, restart
    const sender = {}
    const context = vm.createContext({
      ipcMain: {handle: (_name, value) => { handler = value }}, settingsWindow: {webContents: sender},
      currentSettings: {...DEFAULT_SETTINGS}, settingsApplyStatus: 'applied', settingsRestartPending: false, backendSettings, lifecycleCoordinator: {},
      applySettingsTransaction: async options => { await options.write(payload); restart = options.needsBackendRestart(); return {} },
      parseSettingsCommit: value => value,
      accessCredentials: operation => operation(), refreshSettingsCapabilities: async () => {},
      settingsWriter: async (patch, prepare) => {
        const next = {...context.currentSettings, ...patch}
        await prepare(next); context.currentSettings = next; return next
      },
      validatePreparedSettings() {}, publicSettings: value => value,
      capabilityPath: () => '/capabilities.json', resolve: value => value, settingsFile: () => '/settings.json',
      readCapabilityDocument: () => ({}), decryptSecretsForSpawn: () => ({}), secretCodec: {},
      capabilityEnvironment: () => ({}), prepareCapabilityCommit() {}, process: {env: {}},
      commitDesktopConfiguration() {}, discardDesktopConfiguration() {}, publishSettingsApplyStatus() {},
      settingsView: () => ({}), console, settingsRecoveryAvailable: pendingRecovery,
      publishCommittedSettings() {}, rollbackSettings() {}, completeSettings() {}, restartSettingsBackend() {},
    })
    vm.runInContext(handlerSource, context)
    await handler({sender}, payload)
    assert.equal(restart, expectedRestart)
  }
})

test('settings recovery precedes startup configuration and has one transaction status publisher', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const startup = source.slice(source.indexOf('async function startSelectedCamera'))
  assert.ok(startup.indexOf('loadStartupSettings()') < startup.indexOf("lifecycleCoordinator.run('startup', async"))
  assert.match(startup, /if \(settingsReady\) \{[\s\S]*lifecycleCoordinator.run\('startup', async/u)
  assert.match(startup, /if \(settingsReady && configurationReady\) void managedWorkspaceBackendRecovery.start\(\)/u)
  assert.match(startup, /if \(!settingsReady\) \{[\s\S]*dialog.showMessageBox[\s\S]*shell.openPath\(dirname\(settingsFile\(\)\)\)/u)
  const writers = source.match(/settingsApplyStatus\s*=(?!=)/gu)
  assert.equal(writers.length, 2) // initial value and publishSettingsApplyStatus only
  const retry = source.slice(source.indexOf("ipcMain.handle('nova:backend:retry'"))
  const body = retry.slice(0, retry.indexOf('\n  })'))
  assert.match(body, /if \(settingsRecoveryAvailable\)/)
  assert.match(body, /coordinator: lifecycleCoordinator/)
  assert.match(body, /rollback: rollbackSettings, complete: completeSettings/)
})

test('corrupt recovery keeps the startup settings UI available without starting the candidate', async () => {
  const {mkdtemp, writeFile, rm} = await import('node:fs/promises')
  const {tmpdir} = await import('node:os')
  const {join} = await import('node:path')
  const {default: vm} = await import('node:vm')
  const {saveSettings, loadSettings, saveSettingsRecovery, restoreSettingsRecovery} = await import('../src/main/settings-store.mjs')
  const root = await mkdtemp(join(tmpdir(), 'nova-corrupt-settings-recovery-'))
  const file = join(root, 'settings.json')
  try {
    const previous = await saveSettings(file, {integratedModel: 'previous'})
    const candidate = await saveSettings(file, {...previous, integratedModel: 'candidate'})
    const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
    const helper = source.slice(source.indexOf('async function loadStartupSettings()'), source.indexOf('async function startSelectedCamera'))
    for (const corrupt of ['{truncated', JSON.stringify({version: 999, settings: previous})]) {
      await writeFile(`${file}.recovery`, corrupt, {mode: 0o600})
      const context = vm.createContext({
        app: {getPreferredSystemLanguages: () => ['zh-CN']},
        settingsFile: () => file, loadSettings, restoreSettingsRecovery,
        app: {getPreferredSystemLanguages: () => ['zh-CN']}, setLanguage: () => {},
        settingsRecoveryAvailable: false, openSettingsRequested: false,
        publishSettingsApplyStatus: value => { context.phase = value },
      })
      vm.runInContext(helper, context)
      assert.equal(await context.loadStartupSettings(), false)
      assert.equal(context.openSettingsRequested, true)
      assert.equal(context.settingsRecoveryAvailable, true)
      assert.equal(context.phase, 'recovery_failed')
      assert.deepEqual(context.currentSettings, candidate)
      assert.equal(await readFile(`${file}.recovery`, 'utf8'), corrupt)
      assert.deepEqual(await loadSettings(file), candidate)
      // Repairing the retained record allows the same recovery path to proceed.
      await saveSettingsRecovery(file, previous)
      assert.equal(await context.loadStartupSettings(), true)
      assert.deepEqual(context.currentSettings, previous)
      assert.equal(context.phase, 'recovery_pending')
      await saveSettings(file, candidate)
    }
  } finally { await rm(root, {recursive: true, force: true}) }
})

test('recovery cleanup failure stops the activated child before rollback and preserves candidate files when stop fails', async t => {
  const {mkdtemp, rm} = await import('node:fs/promises')
  const {tmpdir} = await import('node:os')
  const {join} = await import('node:path')
  const {default: vm} = await import('node:vm')
  const {applySettingsTransaction} = await import('../src/main/settings-apply.mjs')
  const {createLifecycleCoordinator} = await import('../src/main/desktop-startup.mjs')
  const {saveSettings, loadSettings, saveSettingsRecovery, restoreSettingsRecovery} = await import('../src/main/settings-store.mjs')
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const helper = name => {
    const start = source.indexOf(`async function ${name}(`)
    return source.slice(start, source.indexOf('\n}', start) + 2)
  }
  for (const stopFails of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), 'nova-settings-quiesce-'))
    t.after(() => rm(root, {recursive: true, force: true}))
    const file = join(root, 'settings.json')
    const previous = await saveSettings(file, {integratedModel: 'previous-model'})
    await saveSettingsRecovery(file, previous)
    const candidate = await saveSettings(file, {...previous, integratedModel: 'candidate-model'})
    let stops = 0, state = 'connected'
    const context = vm.createContext({
      currentSettings: candidate, settingsRecoveryAvailable: true, settingsFile: () => file,
      restoreSettingsRecovery,
      clearSettingsRecovery: async () => {throw Object.assign(Error('unlink denied'), {code: 'EPERM'})},
      refreshDesktopConfiguration: async () => {assert.equal(state, 'stopped')},
      backendSupervisor: {
        stop: async () => {stops++; if (stopFails) throw Error('child remains alive'); state = 'stopped'},
        status: () => ({state}),
      },
    })
    vm.runInContext(helper('rollbackSettings') + '\n' + helper('completeSettings'), context)
    const result = await applySettingsTransaction({
      coordinator: createLifecycleCoordinator(), patch: {}, write: async () => candidate,
      publishCommitted: () => {}, prepareConfiguration: async () => ({}), commitConfiguration: async () => ({}),
      restartBackend: async () => {state = 'connected'}, publishStatus: () => {},
      rollback: context.rollbackSettings, complete: context.completeSettings,
    })
    assert.equal(stops, 1)
    assert.equal(result.saved, false)
    assert.equal(result.operationStatus, stopFails ? 'recovery_failed' : 'failed')
    assert.deepEqual(await loadSettings(file), stopFails ? candidate : previous)
    assert.deepEqual(context.currentSettings, stopFails ? candidate : previous)
    assert.equal(context.settingsRecoveryAvailable, true)
    await readFile(`${file}.recovery`)
    // Every later save/retry goes through the same guard; it cannot restore under the surviving child.
    if (stopFails) {
      await assert.rejects(context.rollbackSettings(false))
      assert.deepEqual(await loadSettings(file), candidate)
      assert.deepEqual(context.currentSettings, candidate)
    }
  }
})

test('Codex rescan cannot prepare or restart a candidate while settings recovery is pending', async () => {
  const {default: vm} = await import('node:vm')
  const {coordinateCodexRescan} = await import('../src/main/settings-apply.mjs')
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const start = source.indexOf("  ipcMain.handle('nova:codex:rescan'")
  const handlerSource = source.slice(start, source.indexOf("  ipcMain.handle('nova:backend:retry'", start))
  const sender = {}
  for (const phase of ['recovery_failed', 'recovery_pending']) {
    let handler
    const calls = []
    const forbidden = name => () => { calls.push(name); assert.fail(`${name} must wait for settings recovery`) }
    vm.runInNewContext(handlerSource, {
      ipcMain: {handle: (_name, callback) => {handler = callback}},
      settingsWindow: {webContents: sender}, settingsRecoveryAvailable: true,
      settingsView: () => ({settingsRecoveryAvailable: true, settingsApplyStatus: phase}),
      coordinateCodexRescan, lifecycleCoordinator: {run: forbidden('coordinator')},
      desktopConfig: null, codexStatus: {status: 'missing'},
      prepareDesktopConfiguration: forbidden('prepare'), commitDesktopConfiguration: forbidden('commit'),
      discardDesktopConfiguration: forbidden('discard'),
      backendSupervisor: {status: forbidden('backend-status')},
      managedWorkspaceBackendRecovery: {restart: forbidden('restart'), retry: forbidden('retry')},
    })
    await assert.rejects(handler({sender: {}}), /Codex rescan rejected/)
    assert.deepEqual({...await handler({sender})}, {
      settingsRecoveryAvailable: true, settingsApplyStatus: phase, operationStatus: 'recovery_pending',
    })
    assert.deepEqual(calls, [])
  }
})

test('workspace cleanup cannot restart a backend while settings recovery is pending', async () => {
  const {default: vm} = await import('node:vm')
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('const workspaceActions = createWorkspaceActions(')
  const block = source.slice(start, source.indexOf('\nasync function launchBackend', start))
  let callbacks, restarts = 0
  const context = vm.createContext({
    createWorkspaceActions: options => {callbacks = options}, lifecycleCoordinator: {},
    managedWorkspaceMaintenance: {}, settingsWindow: null, dialog: {}, shell: {},
    settingsRecoveryAvailable: true,
    backendSupervisor: {restart: async () => {restarts++}, status: () => ({state: 'connected'})},
  })
  vm.runInContext(block, context)
  assert.equal(await callbacks.restartBackendBounded(), false)
  assert.equal(restarts, 0)
  context.settingsRecoveryAvailable = false
  assert.equal(await callbacks.restartBackendBounded(), true)
  assert.equal(restarts, 1)
})

test('personal directory and window controls are bound to main renderer',async()=>{
 const source=await readFile(new URL('../src/main/main.mjs',import.meta.url),'utf8')
 for(const channel of ['directory','wake']){
  const begin=source.indexOf(`ipcMain.handle('nova:personal:${channel}'`)
  assert.ok(begin>=0)
  const body=source.slice(begin,source.indexOf("\n  })",begin))
  assert.match(body,/event.sender !== mainWindow.webContents/)
 }
 assert.match(source,/setBounds: bounds => \{ if \(personalCollapsed\) mainWindow.setBounds\(bounds\) \}/)
})

test('sleep and wake IPC reject other windows and unexpected arguments', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const sender = {}
  for (const action of ['sleep', 'wake']) {
    const start = source.indexOf(`ipcMain.on('nova:wake-word:${action}',`)
    const body = source.slice(start, source.indexOf('\n  })', start) + 5)
    let handler, calls = 0
    new Function('ipcMain', 'mainWindow', 'sleepOrb', 'wakeWord', 'presentationMode', body)(
      {on: (_name, callback) => { handler = callback }}, {webContents: sender},
      () => calls++, {wake: () => calls++}, 'workbench')
    handler({sender: {}})
    handler({sender}, 'unexpected')
    assert.equal(calls, 0)
    handler({sender})
    assert.equal(calls, 1)
  }
})

test('phone actions require the settings sender and restrict actions and device identifiers', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const {default: vm} = await import('node:vm')
  const body = source.slice(source.indexOf("  ipcMain.handle('nova:phone:action'"), source.indexOf("  ipcMain.on('nova:setup:open'"))
  let handler
  const sender = {}, calls = []
  vm.runInNewContext(body, {ipcMain: {handle: (_channel, fn) => {handler = fn}}, settingsWindow: {webContents: sender},
    phoneEpoch: 0, phoneQueue: Promise.resolve(), phoneAction: async (...args) => {calls.push(args); return {state: 'ready'}}})
  assert.equal((await handler({sender: {}}, 'enable')).state, 'unavailable')
  assert.equal((await handler({sender}, 'exec')).state, 'unavailable')
  assert.equal((await handler({sender}, 'status', 'extra')).state, 'unavailable')
  assert.equal((await handler({sender}, 'revoke', '../token')).state, 'unavailable')
  assert.equal((await handler({sender}, 'enable')).state, 'ready')
  assert.equal(calls.length, 1)
})


test('unsupported embedding in recovery reaches startup diagnostics without mutating either file', async () => {
  const {mkdtemp, writeFile, rm} = await import('node:fs/promises')
  const {tmpdir} = await import('node:os')
  const {join} = await import('node:path')
  const {default: vm} = await import('node:vm')
  const {saveSettings, loadSettings, restoreSettingsRecovery} = await import('../src/main/settings-store.mjs')
  const root = await mkdtemp(join(tmpdir(), 'nova-local-embedding-recovery-'))
  const file = join(root, 'settings.json')
  try {
    const current = await saveSettings(file, {})
    const capabilityPath = join(root, 'capabilities.json')
    const capabilityText = '{"version":1}'
    await writeFile(capabilityPath, capabilityText)
    const journal = JSON.stringify({version: 1, settings: {...current, embeddingProvider: 'local'}, capability: {
      path: capabilityPath, written: Buffer.from(capabilityText).toString('base64'), previous: null,
    }})
    await writeFile(`${file}.recovery`, journal)
    const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
    const helper = source.slice(source.indexOf('async function loadStartupSettings()'), source.indexOf('async function startSelectedCamera'))
    const context = vm.createContext({settingsFile: () => file, loadSettings, restoreSettingsRecovery,
        app: {getPreferredSystemLanguages: () => ['zh-CN']}, setLanguage: () => {},
      publishSettingsApplyStatus() {}, settingsRecoveryAvailable: false, openSettingsRequested: false})
    vm.runInContext(helper, context)
    await assert.rejects(context.loadStartupSettings(), {code: 'embedding_provider_invalid'})
    assert.equal(context.currentSettings, undefined)
    assert.equal(await readFile(capabilityPath, 'utf8'), capabilityText)
    assert.deepEqual(await loadSettings(file), current)
    assert.equal(await readFile(`${file}.recovery`, 'utf8'), journal)
  } finally {await rm(root, {recursive: true, force: true})}
})

for (const acceptance of [null, {}]) test(`presentation IPC validates sender and modes and restores wake settings (acceptance=${!!acceptance})`,async()=>{
 const source=await readFile(new URL('../src/main/main.mjs',import.meta.url),'utf8')
 const start=source.indexOf("ipcMain.handle('nova:personal:presentation',")
 const body=source.slice(start,source.indexOf('\n  })',start)+5)
 const sender={},calls=[],wakeSettings=[],saved=[];let handler
 const currentSettings={wakeWordEnabled:true}
 const background=source.slice(source.indexOf('function enterBackground(){'),source.indexOf('const requestPresentation ='))
 const install=new Function('ipcMain','mainWindow','setPersonalCollapsed','wakeWord','nativeAudio','currentSettings','acceptance','acceptanceWakeSettings','settingsWriter',`const settingsReady=true;let presentationMode='workbench';${background};${body};return ()=>presentationMode`)
 const mode=install({handle:(_name,callback)=>{handler=callback}},{webContents:sender,isVisible:()=>true,hide:()=>calls.push('hide'),show:()=>calls.push('show'),focus:()=>calls.push('focus')},value=>calls.push(value),{stop(){},reset(){},configure:settings=>wakeSettings.push(settings)},null,currentSettings,acceptance,acceptanceWakeSettings,async patch=>{saved.push(patch.lastPresentation)})
 await assert.rejects(()=>handler({sender:{}},'background'),/rejected/);await assert.rejects(()=>handler({sender},'invalid'),/rejected/)
 await handler({sender},'background');assert.equal(mode(),'background');assert.deepEqual(calls,['hide'])
 calls.length=0;await handler({sender},'orb');assert.deepEqual(calls,[true,'show','focus'])
 assert.deepEqual(wakeSettings,[{wakeWordEnabled:!acceptance}]);assert.equal(currentSettings.wakeWordEnabled,true)
 calls.length=0;await handler({sender},'workbench',false);assert.deepEqual(calls,[false]);await assert.rejects(()=>handler({sender},'orb','yes'),/rejected/)
 assert.deepEqual(saved,['orb','workbench'])
})
test('background wake IPC cannot reactivate capture or show the window',async()=>{
 const source=await readFile(new URL('../src/main/main.mjs',import.meta.url),'utf8')
 const start=source.indexOf("ipcMain.on('nova:wake-word:wake',")
 const body=source.slice(start,source.indexOf('\n  })',start)+5)
 const sender={};let handler,calls=0
 new Function('ipcMain','mainWindow','wakeWord','presentationMode',body)({on:(_name,callback)=>{handler=callback}},{webContents:sender},{wake:()=>calls++},'background')
 handler({sender});assert.equal(calls,0)
})

for(const configureShows of [false,true])test(`presentation acknowledgement waits for native show before renderer reconciliation (configureShows=${configureShows})`,async()=>{
 const source=await readFile(new URL('../src/main/main.mjs',import.meta.url),'utf8')
 const start=source.indexOf("ipcMain.handle('nova:personal:presentation',"),body=source.slice(start,source.indexOf('\n  })',start)+5)
 let handler,onShow,visible=false,acknowledged=false
 const sender={},mainWindow={webContents:sender,isVisible:()=>visible,once:(name,callback)=>{assert.equal(name,'show');onShow=callback},show(){visible=true},focus(){}}
 new Function('ipcMain','mainWindow','setPersonalCollapsed','wakeWord',`let presentationMode='background';const settingsReady=true,settingsWriter=async()=>{},currentSettings={},acceptance=null,acceptanceWakeSettings=()=>({});${body}`)({handle:(_name,callback)=>{handler=callback}},mainWindow,()=>{},configureShows?{configure:()=>mainWindow.show()}:null)
 const pending=Promise.resolve(handler({sender},'orb')).then(()=>{acknowledged=true})
 await Promise.resolve();assert.equal(acknowledged,false,'renderer must not reconcile ahead of the native show reset')
 visible=true;onShow();await pending;assert.equal(acknowledged,true)
 onShow=null;await handler({sender},'workbench');assert.equal(onShow,null,'already-visible changes must not wait for an event that will not fire')
})

test('background entry stops detector and native mic before waiting for renderer or host',async()=>{
 const source=await readFile(new URL('../src/main/main.mjs',import.meta.url),'utf8')
 const body=source.slice(source.indexOf('function enterBackground(){'),source.indexOf('const requestPresentation ='))
 const calls=[]
 new Function('mainWindow','wakeWord','nativeAudio',`let presentationMode='orb';${body};enterBackground();return presentationMode`)({hide:()=>calls.push('hide')},{stop:()=>calls.push('detector-stop'),reset:()=>calls.push('fence')},{setPlaybackMuted:value=>calls.push(value),deactivate:async()=>calls.push('mic-stop')})
 assert.deepEqual(calls,['hide','detector-stop','fence',true,'mic-stop'])
})
test('foreground changes native presentation before unmuting playback',async()=>{
 const source=await readFile(new URL('../src/renderer/index.mjs',import.meta.url),'utf8')
 const body=source.slice(source.indexOf('applyPresentation: async ')+19,source.indexOf('\n  taskAction:',source.indexOf('applyPresentation: async '))).replace(/,\s*$/,'')
 const calls=[],window={novaAudioAgentDesktop:{personal:{setPresentation:async(mode,activate)=>calls.push(['presentation',mode,activate])},nativeAudio:{setPlaybackMuted:async muted=>calls.push(['muted',muted])}}}
 const apply=new Function('window','axes','requestAnimationFrame','render',`let lastReportedDormant=true;return ${body}`)(window,{outputMuted:false},()=>{},()=>{})
 await apply('workbench',{activate:false});assert.deepEqual(calls,[['presentation','workbench',false],['muted',false]])
})

test('background return reconciles unchanged renderer dormancy with native show reset',async()=>{
 const {createOrbWindowController}=await import('../src/main/window-position.mjs')
 const {orbDormant}=await import('../src/renderer/state.mjs')
 const source=await readFile(new URL('../src/renderer/index.mjs',import.meta.url),'utf8')
 const main=await readFile(new URL('../src/main/main.mjs',import.meta.url),'utf8')
 const applyBody=source.slice(source.indexOf('applyPresentation: async ')+19,source.indexOf('\n  taskAction:',source.indexOf('applyPresentation: async '))).replace(/,\s*$/,'')
 const reportBody=source.slice(source.indexOf('  const dormant = orbDormant('),source.indexOf('\n  const activeDecision',source.indexOf('  const dormant = orbDormant(')))
 const showBody=main.match(/mainWindow\.on\('show', (\(\) => \{[^\n]+\})\)/)[1]
 for(const surface of ['resting','bubble','task','confirmation']){
  let bounds={x:500,y:400,width:160,height:160},visible=true
  const controller=createOrbWindowController({getBounds:()=>bounds,setBounds:value=>{bounds=value},getZoomFactor:()=>1,getScaleFactor:()=>2,getWorkAreaForPoint:()=>({x:0,y:0,width:1440,height:900}),onConfirmationPlacement(){}})
  const show=new Function('personalCollapsed','orbWindow',`return ${showBody}`)(true,controller)
  const reports=[],frames=[],shell={dataset:{}},axes={wakeState:'sleeping',hovered:false,codex:'idle',outputMuted:false,playback:'idle'}
  const window={novaAudioAgentDesktop:{personal:{setPresentation:async mode=>{visible=mode!=='background';if(visible)show()}},nativeAudio:{clear:async()=>{},setPlaybackMuted:async()=>{}},windowLayout:{setDormant:value=>{reports.push(value);if(visible)controller.setDormant(value)}}}}
  const fixture=new Function('window','axes','requestAnimationFrame','shell','orbDormant','seenPresentations','alertTone','playback','nativeFrames','nativeLevel',`let lastReportedDormant=null;const state={name:'idle',confirmationVisible:false};const render=()=>{${reportBody}};return {render,apply:${applyBody}}`)(window,axes,callback=>frames.push(callback),shell,orbDormant,new Set(),{stop(){}},{disconnect(){}},{clear(){}},{clear(){}})
  fixture.render();assert.equal(bounds.width,64)
  await fixture.apply('background');frames.shift()();assert.equal(visible,false)
  if(surface==='bubble')controller.reserveBubbleArea(1)
  if(surface==='task')controller.reserveBubbleArea(0,1)
  if(surface==='confirmation')controller.setConfirmationMode(true)
  const before=reports.length
  await fixture.apply('orb');assert.ok(bounds.width>=160)
  frames.shift()()
  if(surface==='resting')assert.deepEqual([bounds.width,bounds.height],[64,64])
  else assert.ok(bounds.width>=160&&bounds.height>=160,`${surface} must retain its larger surface`)
  assert.equal(reports.length,before+1,`${surface}: unchanged dormancy must be resent after show`)
 }
})

test('the expanded workbench casts a native shadow and the resting orb does not',async()=>{
 const source=await readFile(new URL('../src/main/main.mjs',import.meta.url),'utf8')
 const start=source.indexOf('  let personalCollapsed = false')
 const body=source.slice(start,source.indexOf("  ipcMain.handle('nova:personal:presentation-error'",start))
 const shadow=[],bounds={x:0,y:0,width:100,height:100}
 const mainWindow={getBounds:()=>bounds,setResizable(){},setMinimumSize(){},setMaximumSize(){},setAlwaysOnTop(){},setBounds(){},setHasShadow:value=>shadow.push(value)}
 const screen={getCursorScreenPoint:()=>({x:0,y:0}),getDisplayNearestPoint:()=>({workArea:{x:0,y:0,width:1440,height:900}})}
 const set=new Function('mainWindow','screen','orbWindow','sendToOrb','createWorkbenchFrame',`${body};return setPersonalCollapsed`)(mainWindow,screen,{sync(){}},()=>{},createWorkbenchFrame)
 set(false);set(true);set(false)
 assert.deepEqual(shadow,[true,false,true])
})

test('keyboard activation wakes a sleeping orb and expands an awake one', async () => {
  const source = await readFile(new URL('../src/renderer/index.mjs', import.meta.url), 'utf8')
  const start = source.indexOf("orb.addEventListener('keydown',")
  const body = source.slice(start, source.indexOf('\n})', start) + 3)
  assert.match(source, /setAttribute\(orb, 'tabindex', '0'\)/)
  const calls = []
  let handler
  const orb = {addEventListener: (_name, callback) => { handler = callback }}
  const window = {novaAudioAgentDesktop: {wakeWord: {wake: () => calls.push('wake')}}}
  const axes = {wakeState: 'sleeping'}
  const personalView = {controller: {presentationMode: 'orb'}, expand: () => calls.push('expand')}
  new Function('orb', 'axes', 'window', 'personalView', body)(orb, axes, window, personalView)
  const press = (key, repeat = false) => { const event = {key, repeat, prevented: false, preventDefault() { this.prevented = true } }; handler(event); return event.prevented }
  assert.equal(press('Enter'), true); assert.deepEqual(calls, ['wake'])
  axes.wakeState = 'active'
  assert.equal(press(' '), true); assert.deepEqual(calls, ['wake', 'expand'])
  assert.equal(press('Enter', true), false, 'a held key must not expand repeatedly')
  assert.equal(press('a'), false)
  personalView.controller.presentationMode = 'workbench'; press('Enter')
  assert.deepEqual(calls, ['wake', 'expand'])
})

test('closing the workbench stays in background and macOS activation reopens it without waking a visible orb',async()=>{
 const source=await readFile(new URL('../src/main/main.mjs',import.meta.url),'utf8')
 let close,activate,control,prevented=0,visible=true,destroyed=false
 const app={isQuitting:false,on:(_name,handler)=>{activate=handler}},sender={},requests=[]
 const mainWindow={webContents:sender,on:(_name,handler)=>{close=handler},isVisible:()=>visible,isDestroyed:()=>destroyed}
 const requestPresentation=mode=>{requests.push(mode);if(mode==='background')visible=false}
 const closeStart=source.indexOf("  mainWindow.on('close', event => {")
 new Function('app','mainWindow','requestPresentation',source.slice(closeStart,source.indexOf('\n  })',closeStart)+5))(app,mainWindow,requestPresentation)
 const activateStart=source.indexOf("  app.on('activate', () => {")
 new Function('app','mainWindow','requestPresentation',source.slice(activateStart,source.indexOf('\n  })',activateStart)+5))(app,mainWindow,requestPresentation)
 const controlStart=source.indexOf("  ipcMain.on('nova:window:control',")
 new Function('ipcMain','mainWindow','requestPresentation',`const personalCollapsed=false;${source.slice(controlStart,source.indexOf('\n  })',controlStart)+5)}`)({on:(_name,handler)=>{control=handler}},mainWindow,requestPresentation)
 activate();assert.deepEqual(requests,[],'focusing a visible orb must not expand it')
 control({sender:{}},'close');assert.deepEqual(requests,[])
 control({sender},'close');assert.deepEqual(requests.splice(0),['background'])
 activate();assert.deepEqual(requests.splice(0),['workbench'])
 visible=true;close({preventDefault(){prevented++}});assert.equal(prevented,1);assert.deepEqual(requests.splice(0),['background'])
 activate();assert.deepEqual(requests.splice(0),['workbench'])
 destroyed=true;activate();assert.deepEqual(requests,[])
 destroyed=false;app.isQuitting=true;activate();assert.deepEqual(requests,[]);close({preventDefault(){prevented++}});assert.equal(prevented,1,'real Quit still closes the window')
})
