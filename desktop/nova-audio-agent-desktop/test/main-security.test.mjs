import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createContext, runInContext } from 'node:vm'

test('main owns single-instance lifecycle and denies renderer escape', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  assert.match(source, /requestSingleInstanceLock/)
  assert.match(source, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/)
  assert.match(source, /configureWindowSecurity\(window\)/)
  assert.match(source, /loadAppWindow\(mainWindow/)
  assert.match(source, /Number\.isInteger\(code\) \? code\.toString\(\) : 'none'/)
  assert.doesNotMatch(source, /shell\.openExternal/)
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
    'nova:native-audio:capture',
    'nova:native-audio:clear',
    'nova:native-audio:event',
    'nova:native-audio:play',
    'nova:native-audio:playback-muted',
    'nova:native-audio:terminal',
    'nova:orb-menu:show',
    'nova:projects:repair',
    'nova:release-camera:result',
    'nova:settings:changed',
    'nova:settings:get',
    'nova:settings:open',
    'nova:settings:set',
    'nova:wake-word:activity',
    'nova:wake-word:audio',
    'nova:wake-word:changed',
    'nova:wake-word:report',
    'nova:wake-word:retry',
    'nova:window-drag:end',
    'nova:window-drag:move',
    'nova:window-drag:start',
    'nova:workspace-graph-board:request',
    'nova:workspaces:clear-all',
    'nova:workspaces:clear-current',
    'nova:workspaces:open-current',
  ])
  assert.doesNotMatch(source, /sendSync/)
})

test('Memory Board copy stays in sender-validated main IPC instead of web clipboard permission', async () => {
  const main = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const renderer = await readFile(new URL('../src/renderer/memory-board.mjs', import.meta.url), 'utf8')

  assert.match(main, /ipcMain\.handle\('nova:memory-board:copy-json', async event => \{\n\s*if \(!boardWindow \|\| event\.sender !== boardWindow\.webContents\)/u)
  assert.match(main, /clipboard\.writeText\(formatted\.body\)/u)
  assert.doesNotMatch(renderer, /navigator\.clipboard/u)
})

test('Memory Board clear is zero-argument, sender-bound, single-flight, and rechecks its captured owner', async () => {
  const main = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const preload = await readFile(new URL('../src/preload/preload.cjs', import.meta.url), 'utf8')
  const renderer = await readFile(new URL('../src/renderer/memory-board.mjs', import.meta.url), 'utf8')
  const start = main.indexOf("ipcMain.handle('nova:memory-board:clear'")
  const handler = main.slice(start, main.indexOf("ipcMain.handle('nova:workspace-graph-board:request'", start))

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
  const source = main.slice(start, main.indexOf("ipcMain.handle('nova:workspace-graph-board:request'", start))
  let handler
  const sender = {}
  const context = createContext({
    ipcMain: {handle: (_channel, value) => { handler = value }},
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

test('workspace graph board is sender-bound on the independent debug channel', async () => {
  const main = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const preload = await readFile(new URL('../src/preload/preload.cjs', import.meta.url), 'utf8')
  const renderer = await readFile(new URL('../src/renderer/index.mjs', import.meta.url), 'utf8')

  assert.match(main, /ipcMain\.handle\('nova:workspace-graph-board:request', async event => \{\n\s*if \(!boardWindow \|\| event\.sender !== boardWindow\.webContents\)/)
  assert.match(main, /board: 'workspace_graph',\s*detail: 'compact'/u)
  assert.doesNotMatch(preload, /workspace-graph-board:(?:fetch|data)/u)
  assert.doesNotMatch(renderer, /workspace_graph\.board/u)
  for (const source of [main, preload, renderer]) {
    assert.doesNotMatch(source, /workspace-graph-board:(?:export|delete|edit|suppress|merge|switch|inspect)/u)
  }
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
    /ipcMain\.on\('nova:settings:open', event => \{\n    if \(mainWindow && event\.sender === mainWindow\.webContents\) openSettingsWindow\(launchId\)\n  \}\)/,
  )
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
  assert.match(body, /if \(settingsWindow\) \{\n\s*settingsWindow\.show\(\)\n\s*settingsWindow\.focus\(\)[\s\S]*refreshManagedWorkspaceCapabilities\(\)[\s\S]*return\n\s*\}/)
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

  assert.match(source, /ipcMain\.handle\('nova:settings:get', async event => \{\n\s*if \(!settingsWindow \|\| event\.sender !== settingsWindow\.webContents\)/)
  assert.match(source, /ipcMain\.handle\('nova:settings:set', async \(event, payload\) => \{\n\s*if \(!settingsWindow \|\| event\.sender !== settingsWindow\.webContents\)/)
  assert.match(source, /function publishCommittedSettings\(\) \{[\s\S]*sendToOrb\('nova:settings:changed', orbSettings\(currentSettings\)\)/)
  // No requestId machinery: settings live in main, so nothing round-trips
  // through the orb renderer the way the memory board has to.
  const set = source.slice(source.indexOf("ipcMain.handle('nova:settings:set'"))
  assert.doesNotMatch(set.slice(0, set.indexOf('\n  })')), /requestId|pendingBoardRequests/)
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
  const settings = source.slice(source.indexOf("ipcMain.handle('nova:settings:set'"))
  const settingsHandler = settings.slice(0, settings.indexOf('\n  })'))
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
  assert.match(handler, /applySettingsTransaction\(\{/)
  assert.match(handler, /write: async value => \{[\s\S]*await settingsWriter\(commit\.settingsPatch \?\? \{\}, next =>/)
  assert.match(handler, /coordinator: lifecycleCoordinator/)
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
  const spawnSite = source.indexOf('spawnedBackend = utilityProcess.fork(')
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

test('the bootstrap payload carries only orb-owned settings', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  const assignment = source.slice(source.indexOf('bootstrap = Object.freeze({'))
  assert.match(assignment.slice(0, assignment.indexOf('})')), /settings: orbSettings\(currentSettings\)/)
  assert.match(source, /currentSettings = recovered \?\? await loadSettings\(settingsFile\(\)\)/)
})

test('quitting drains the backend on the stdin sentinel instead of killing it', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const beforeQuit = source.slice(source.indexOf("app.on('before-quit'"))

  assert.match(beforeQuit, /event\.preventDefault\(\)/)
  assert.match(beforeQuit, /shutdownBackendBestEffort\(backend\)/)
  assert.match(beforeQuit, /app\.exit\(0\)/)
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
  assert.match(load.slice(0, 1100), /sendToOrb\('nova:backend-ready', backendStatus\.connection\)/)
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
  const set = source.slice(source.indexOf("ipcMain.handle('nova:settings:set'"))
  const handler = set.slice(0, set.indexOf('\n  })'))

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
    /start: camera => startSelectedCamera\(camera, backendKind, releaseSmokeChannel\)/u,
  )
  assert.match(source, /ipcMain\.handle\('nova:camera:permission', async event => \{\n\s*if \(!mainWindow \|\| event\.sender !== mainWindow\.webContents\)/u)
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
  assert.match(body, /start: camera => startSelectedCamera\(camera, backendKind, releaseSmokeChannel\)/u)
  assert.match(
    source,
    /process\.stderr\.write\(\s*'\[desktop-diagnostic\] source_rollback_unavailable\\n',\s*\(\) => app\.exit\(0\),?\s*\)/u,
  )
  assert.match(source, /releaseSmokeSourceRollbackExitCode\(\{/u)
  assert.match(source, /app\.exit\(sourceRollbackExitCode\)/u)
  const rollbackPreflight = source.indexOf("process.env.NOVA_AUDIO_AGENT_BACKEND === 'python'")
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
    /camera\.file|cameraPath|NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE|file:|nova:\/\/orb\/camera-source/u,
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
    registration.slice(0, 400),
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
  assert.match(mainSource, /label: '退出 Nova Audio Agent'/)
  assert.match(mainSource, /click: \(\) => app\.quit\(\)/)
  assert.doesNotMatch(rendererSource, /orb\.addEventListener\('click'/)
  assert.match(rendererSource, /event\.preventDefault\(\)/)
  assert.match(rendererSource, /window\.novaAudioAgentDesktop\.orbMenu\.show\(\)/)
})

test('renderer always activates after microphone preflight and never delegates activation to the orb', async () => {
  const renderer = await readFile(new URL('../src/renderer/index.mjs', import.meta.url), 'utf8')

  assert.match(renderer, /if \(microphone === 'granted'\) \{\s*await activateCapture\(\)\s*\}/)
  assert.match(renderer, /async function retryMicrophonePermission\(\)/)
  assert.match(renderer, /const microphone = await refreshMicrophonePermission\(\)/)
  assert.match(renderer, /if \(microphone === 'granted' && !axes\.activated\) await activateCapture\(\)/)
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
  assert.match(renderer, /return axes\.muted \|\| performance\.now\(\) < muteDrainUntil/)
  assert.match(renderer, /const UNMUTE_DRAIN_MS = 120/)
  assert.match(renderer, /muteDrainUntil = performance\.now\(\) \+ UNMUTE_DRAIN_MS/)
  // Deactivation discards the session's mute, and the rail buttons are wired.
  assert.match(renderer, /axes\.muted = false/)
  assert.match(renderer, /muteToggle\.addEventListener\('click', \(\) => toggleMute\(\)\)/)
  assert.match(renderer, /openSettingsButton\.addEventListener\('click', \(\) => window\.novaAudioAgentDesktop\.orbMenu\.openSettings\?\.\(\)\)/)
})

test('quit bounds a maintenance drain without bypassing backend shutdown', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const {default: vm} = await import('node:vm')
  let beforeQuit, releaseMaintenanceDeadline, releaseBackend, timeout
  const exits = []
  const context = vm.createContext({
    sourceSmokeStage() {},
    app: {on: (name, handler) => { if (name === 'before-quit') beforeQuit = handler }, exit: code => exits.push(code)},
    wakeWord: null, releaseSmokeChannel: null, globalShortcut: {unregisterAll() {}}, nativeAudio: null,
    backendSupervisor: {stop: () => new Promise(resolve => { releaseBackend = resolve })}, backend: null,
    managedWorkspaceMaintenance: {close: () => new Promise(() => {})}, quitDrain: null,
    wait: milliseconds => { timeout = milliseconds; return new Promise(resolve => { releaseMaintenanceDeadline = resolve }) },
  })
  vm.runInContext(source.slice(source.indexOf("app.on('before-quit'")), context)
  beforeQuit({preventDefault() {}})
  assert.equal(timeout, 3000)
  releaseMaintenanceDeadline()
  await Promise.resolve()
  assert.deepEqual(exits, [], 'backend still owns its shutdown deadline')
  releaseBackend()
  await context.quitDrain
  assert.deepEqual(exits, [0])
})

test('settings IPC restarts for capability commits while wake-only updates stay local', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const {default: vm} = await import('node:vm')
  const {backendSettings, DEFAULT_SETTINGS} = await import('../src/main/settings-store.mjs')
  const start = source.indexOf("  ipcMain.handle('nova:settings:set'")
  const handlerSource = source.slice(start, source.indexOf('\n  })', start) + 5)
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
      currentSettings: {...DEFAULT_SETTINGS}, backendSettings, lifecycleCoordinator: {},
      applySettingsTransaction: async options => { await options.write(payload); restart = options.needsBackendRestart(); return {} },
      parseSettingsCommit: value => value,
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
  assert.ok(startup.indexOf('loadStartupSettings()') < startup.indexOf('await refreshDesktopConfiguration()'))
  assert.match(startup, /if \(settingsReady\) await refreshDesktopConfiguration\(\)/u)
  assert.match(startup, /if \(settingsReady\) void managedWorkspaceBackendRecovery.start\(\)/u)
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
        settingsFile: () => file, loadSettings, restoreSettingsRecovery,
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
  const {createLifecycleCoordinator} = await import('../src/main/lifecycle-coordinator.mjs')
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
