import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  net,
  protocol,
  safeStorage,
  screen,
  systemPreferences,
  Tray,
  utilityProcess,
} from 'electron'
import { randomBytes } from 'node:crypto'
import { rename, unlink, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  backendLaunchSpec,
  createReadinessListener,
  fallbackPython,
  nodeRuntimeEntry,
  selectedBackend,
  shutdownBackend,
  venvPython,
  watchBackendExit,
} from './backend.mjs'
import { installAppProtocol, loadAppWindow } from './app-protocol.mjs'
import { startWithSelectedCamera } from './camera-source.mjs'
import { createDragController } from './drag-controller.mjs'
import { createNativeAudioManager } from './native-audio.mjs'
import { createReleaseSmokeChannel } from './release-smoke-channel.mjs'
import {
  createSafeStorageCodec,
  createSettingsWriter,
  hasPlaintextSecret,
  loadSettings,
  publicSettings,
  readSecret,
  saveSettings,
  SECRET_KEYS,
  secretsPresent,
  secretValueIsSafe,
} from './settings-store.mjs'
import {
  clampWindowPosition,
  loadWindowPosition,
  saveWindowPosition,
  validDragDelta,
} from './window-position.mjs'
import {
  allowRendererNavigation,
  boardWindowOptions,
  browserWindowOptions,
  configureWindowSecurity,
  createBootstrapAccess,
  requestLocalCameraPermission,
  settingsWindowOptions,
  validateBootstrap,
} from './security.mjs'
import { validReleaseCameraResult } from '../renderer/release-camera-contract.mjs'

protocol.registerSchemesAsPrivileged([{
  scheme: 'nova',
  privileges: { standard: true, secure: true, supportFetchAPI: true },
}])

// Windows groups taskbar/notification identity by AppUserModelID; a no-op
// everywhere else, so it is set unconditionally rather than gated by platform.
app.setAppUserModelId('ai.deepnovacore.nova-audio-agent.orb')

// Wayland has no global window positioning, so the orb is pinned to X11
// (XWayland handles Wayland sessions transparently). These switches must be
// appended before the app is ready; Chromium reads them once at startup.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform', 'x11')
  app.commandLine.appendSwitch('enable-transparent-visuals')
}

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '../..')
const rendererRoot = resolve(packageRoot, 'src/renderer')
const preload = resolve(packageRoot, 'src/preload/preload.cjs')
const WINDOW_SIZE = Object.freeze({ width: 184, height: 184 })
// Long-standing Chromium/X11 quirk: the ARGB visual backing a transparent,
// frameless window isn't reliably available the instant 'ready' fires, so
// window creation is delayed a beat on linux only.
const LINUX_WINDOW_DELAY_MS = 300
const RELEASE_CAMERA_SMOKE_MODE = 'installed-file-v1'
const opaque = process.env.NOVA_ORB_OPAQUE === '1'

let backend = null
let mainWindow = null
let boardWindow = null
let settingsWindow = null
let tray = null
let bootstrap = null
let nativeAudio = null
let nativeBinary = null
let quitDrain = null
let releaseSmokeChannel = null
// Settings are main-owned: the panel asks main directly, so unlike the memory
// board there is no relay through the orb renderer and no requestId to match.
let currentSettings = null
const secretCodec = createSafeStorageCodec(safeStorage)
// Sticky: the backend can die in the window between its handshake and the orb's
// first paint, when there is no renderer to tell. The flag is what the bootstrap
// reply reports and what the post-load push replays, so that death is delivered
// rather than lost.
let backendExited = false
const pendingBoardRequests = new Map()

function pythonExecutable() {
  if (process.env.NOVA_AUDIO_AGENT_PYTHON) return process.env.NOVA_AUDIO_AGENT_PYTHON
  if (process.env.VIRTUAL_ENV) return venvPython(process.env.VIRTUAL_ENV)
  return fallbackPython()
}

// Every push to the orb goes through here. `mainWindow` is never nulled — the orb has no
// 'closed' handler because it is not meant to close before the app quits — so a send after
// the window is gone would throw "Object has been destroyed" out of whatever callback made
// it, uncaught, in the main process. One guard, one place.
function sendToOrb(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args)
}

function windowPositionFile() {
  return resolve(app.getPath('userData'), 'ambient-orb-window-position.json')
}

function settingsFile() {
  return resolve(app.getPath('userData'), 'ambient-orb-settings.json')
}

// The single shape the settings panel is ever told. Key material is reduced to
// four booleans here and nowhere else, so no handler can widen it by accident;
// `keyringAvailable` is what turns the plaintext warning line on. It answers
// for the file as it stands, not merely for today's keyring: an entry written
// while no keyring existed is still readable by anyone, so the warning stays up
// until the next save re-seals it.
function settingsView() {
  return {
    ...publicSettings(currentSettings),
    secretsPresent: secretsPresent(currentSettings),
    keyringAvailable: secretCodec.available() && !hasPlaintextSecret(currentSettings),
  }
}

// One writer for the whole process, so overlapping panel changes queue instead
// of racing: each patch is merged against the state the previous write
// committed, not against the snapshot its handler happened to start from.
const settingsWriter = createSettingsWriter({
  getCurrent: () => currentSettings,
  commit: next => {
    currentSettings = next
  },
  save: next => saveSettings(settingsFile(), next),
  codec: secretCodec,
})

// The orb is a single fixed size, so "which display's work area applies"
// depends only on where the candidate position would put its center.
function clampToNearestWorkArea(candidate) {
  const center = {
    x: candidate.x + Math.floor(WINDOW_SIZE.width / 2),
    y: candidate.y + Math.floor(WINDOW_SIZE.height / 2),
  }
  const workArea = screen.getDisplayNearestPoint(center).workArea
  return clampWindowPosition(candidate, WINDOW_SIZE, workArea)
}

// The scheduler is injectable so a future test can drive this without a real
// 300 ms sleep; production always calls it with the default setTimeout.
function wait(ms, schedule = setTimeout) {
  return new Promise(resolve => schedule(resolve, ms))
}

async function createWindow(launchId) {
  const window = new BrowserWindow(browserWindowOptions(preload, launchId, { opaque }))
  const positionFile = windowPositionFile()
  const primary = screen.getPrimaryDisplay().workArea
  const fallback = { x: primary.x + primary.width - 208, y: primary.y + 24 }
  const saved = await loadWindowPosition(positionFile)
  const candidate = saved || fallback
  const position = clampToNearestWorkArea(candidate)
  window.setPosition(position.x, position.y)
  window.setAlwaysOnTop(true, 'floating')
  configureWindowSecurity(window)
  window.once('ready-to-show', () => window.showInactive())
  return window
}

function openMemoryBoard(launchId) {
  if (boardWindow) {
    boardWindow.show()
    boardWindow.focus()
    return
  }
  const window = new BrowserWindow(boardWindowOptions(preload, launchId))
  // webContents-level walls only: the shared session's permission handlers stay
  // bound to the orb window, so the microphone grant is not rebound to the board.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!allowRendererNavigation(url)) event.preventDefault()
  })
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    boardWindow = null
  })
  boardWindow = window
  void window.loadURL('nova://orb/memory-board.html')
}

function openSettingsWindow(launchId) {
  if (settingsWindow) {
    settingsWindow.show()
    settingsWindow.focus()
    return
  }
  const window = new BrowserWindow(settingsWindowOptions(preload, launchId))
  // Same rule as the board: webContents-level walls only. Re-binding the
  // session's permission handlers here would move the orb's microphone grant
  // onto a panel that has no business holding it.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!allowRendererNavigation(url)) event.preventDefault()
  })
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    settingsWindow = null
  })
  settingsWindow = window
  void window.loadURL('nova://orb/settings.html')
}

function showOrbMenu(launchId) {
  Menu.buildFromTemplate([
    { label: 'Memory Board', click: () => openMemoryBoard(launchId) },
    { label: '设置…', click: () => openSettingsWindow(launchId) },
    { type: 'separator' },
    { label: '退出 Nova Audio Agent', click: () => app.quit() },
  ]).popup({ window: mainWindow })
}

// One rendering per status-area convention: macOS asks for 16pt, the GTK and
// Ayatana status areas for 22, and the Windows notification area for 32. Feeding
// a 16px image to Windows is how a tray icon ends up a blurry smudge.
const TRAY_ICON_FILES = Object.freeze({
  darwin: 'tray-16.png',
  linux: 'tray-22.png',
  win32: 'tray-32.png',
})

// Same two-sided resolution as `nativeBinary`: packaged, the tray PNGs ride in
// as extraResources next to the native helper rather than inside the asar;
// unpacked, they are read straight out of the repo's resources/ tree.
function trayIconFile() {
  // Anything that is neither macOS nor Windows (a BSD Electron build) gets the
  // linux rendering: those desktops run the same GTK/Ayatana status area, so 22
  // is the right guess where win32's 32 would simply be wrong.
  const file = TRAY_ICON_FILES[process.platform] || TRAY_ICON_FILES.linux
  return app.isPackaged
    ? resolve(process.resourcesPath, 'tray', file)
    : resolve(packageRoot, 'resources/tray', file)
}

// `createFromPath` reports failure by returning an empty image rather than by
// throwing, so a missing or unreadable file has to be caught on isEmpty() — an
// existsSync check alone would hand Electron a blank Tray and no explanation.
// The 1x1 transparent pixel is what keeps the menu reachable in that case: an
// invisible tray entry is still better than a crash on startup.
function trayImage() {
  const file = trayIconFile()
  if (existsSync(file)) {
    const image = nativeImage.createFromPath(file)
    if (!image.isEmpty()) return image
  }
  console.warn(`[ambient-orb] tray icon unreadable, falling back to a blank pixel: ${file}`)
  return nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL6WQAAAABJRU5ErkJggg==',
  )
}

function createTray() {
  const next = new Tray(trayImage())
  next.setToolTip('Nova Audio Agent Ambient Orb')
  next.setContextMenu(Menu.buildFromTemplate([
    { label: '显示', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]))
  next.on('click', () => mainWindow?.isVisible() ? mainWindow.hide() : mainWindow?.show())
  return next
}

// Decrypts only the secrets the panel actually has stored, only for the
// instant the backend is spawned: the result is a local, passed once into
// `backendLaunchSpec` below and held nowhere else — never on `this` or any
// module-level object, so there is nothing left to leak once this call
// returns. A key present in the store but unreadable (keychain unavailable,
// entry sealed by another OS user/machine, corrupt ciphertext) is logged by
// name only — never its value, never even attempted — and simply omitted
// from the result, which `backendLaunchSpec` treats exactly like "absent". A
// value that decrypts to something Node would refuse in a child environment (a
// NUL or other control character, from a store written before that was
// validated) is dropped the same way rather than allowed to fail the spawn and
// quit the app before the panel can clear it.
function decryptSecretsForSpawn(settings, codec) {
  const present = secretsPresent(settings)
  const decrypted = {}
  for (const key of SECRET_KEYS) {
    if (!present[key]) continue
    const plaintext = readSecret(settings, key, codec)
    if (typeof plaintext !== 'string' || !plaintext) {
      console.error(`[desktop-diagnostic] settings_secret_unreadable key=${key}`)
    } else if (!secretValueIsSafe(plaintext)) {
      console.error(`[desktop-diagnostic] settings_secret_invalid key=${key}`)
    } else {
      decrypted[key] = plaintext
    }
  }
  return decrypted
}

async function launchBackend(cameraSource, backendKind, smokeChannel) {
  const token = randomBytes(16).toString('hex')
  const workspace = process.env.NOVA_AUDIO_AGENT_CODEX_WORKSPACE || process.cwd()
  // The listener owns the handshake, so it must be bound before the backend can
  // dial it; the readiness timeout still kills a backend that never arrives.
  const listener = createReadinessListener({
    token,
    onTimeout: () => {
      if (backend) void shutdownBackend(backend)
    },
  })
  let ready
  try {
    const decryptedSecrets = decryptSecretsForSpawn(currentSettings, secretCodec)
    const spec = backendLaunchSpec({
      backend: backendKind,
      python: backendKind === 'python' ? pythonExecutable() : undefined,
      nodeEntry: nodeRuntimeEntry({
        isPackaged: app.isPackaged,
        appPath: app.getAppPath(),
        packageRoot,
      }),
      nodeResourcesPath: app.isPackaged
        ? process.resourcesPath
        : resolve(packageRoot, 'build'),
      workspace,
      token,
      readyEndpoint: await listener.endpoint,
      parentEnv: process.env,
      settings: currentSettings,
      decryptedSecrets,
    })
    if (spec.kind === 'node') {
      backend = utilityProcess.fork(spec.entry, spec.argv, {
        cwd: workspace,
        env: spec.env,
        stdio: spec.stdio,
        serviceName: 'Nova Audio Agent Runtime',
      })
    } else {
      backend = spawn(spec.command, spec.argv, {
        cwd: workspace,
        env: spec.env,
        stdio: spec.stdio,
      })
    }
    backend.stderr?.on('data', chunk => {
      console.error(`[backend-diagnostic] ${chunk.toString('utf8').trim()}`)
    })
    backend.stdout?.on('data', chunk => {
      console.error(`[backend-diagnostic] ${chunk.toString('utf8').trim()}`)
    })
    // Covers both deaths: the child that exits, and the child that never started
    // at all (a missing interpreter emits 'error' and no 'exit' — unlistened, it
    // would be thrown into this process). Either way the handshake is failed now
    // instead of waiting out the timeout, and `launchBackend` rejects, which the
    // whenReady().catch() below turns into a quit exactly as a timeout does.
    watchBackendExit(backend, {
      closeReadiness: listener.close,
      onExit: reason => {
        backendExited = true
        console.error(`[backend-diagnostic] ${reason}`)
        if (!app.isQuitting) sendToOrb('nova:backend-exit')
      },
    })
    ready = await listener.readiness
  } finally {
    listener.close()
  }
  const validated = validateBootstrap({ endpoint: ready.endpoint, token })
  smokeChannel?.ready({endpoint: validated.endpoint, token: validated.token})
  nativeBinary = app.isPackaged
    ? resolve(process.resourcesPath, 'native/macos_voice_io')
    : resolve(packageRoot, 'build/macos_voice_io')
  const nativeAvailable = process.platform === 'darwin' && existsSync(nativeBinary)
  nativeAudio = nativeAvailable ? createNativeAudioManager({
    binary: nativeBinary,
    onEvent: event => sendToOrb('nova:native-audio:event', event),
  }) : null
  bootstrap = Object.freeze({
    ...validated,
    audioMode: 'inactive',
    nativeAvailable,
    platform: process.platform,
    opaque,
    cameraSource,
    settings: publicSettings(currentSettings),
  })
}

async function startSelectedCamera(camera, backendKind, smokeChannel) {
  currentSettings = await loadSettings(settingsFile())
  await launchBackend(camera.source, backendKind, smokeChannel)
  const launchId = randomBytes(8).toString('hex')
  if (process.platform === 'linux') await wait(LINUX_WINDOW_DELAY_MS)
  mainWindow = await createWindow(launchId)
  const dragController = createDragController({
    getCursor: () => screen.getCursorScreenPoint(),
    getWindowPosition: () => {
      const [x, y] = mainWindow.getPosition()
      return { x, y }
    },
    setWindowPosition: position => mainWindow.setPosition(position.x, position.y),
    clamp: clampToNearestWorkArea,
  })
  const readBootstrap = createBootstrapAccess(bootstrap, mainWindow.webContents)
  ipcMain.on('nova:orb-menu:show', event => {
    if (mainWindow && event.sender === mainWindow.webContents) showOrbMenu(launchId)
  })
  ipcMain.handle('nova:memory-board:request', event => {
    if (!boardWindow || event.sender !== boardWindow.webContents) {
      throw new Error('memory board request rejected')
    }
    if (!mainWindow) return { error: 'unavailable' }
    const requestId = `board-${randomBytes(8).toString('hex')}`
    return new Promise(resolveRequest => {
      const timer = setTimeout(() => {
        pendingBoardRequests.delete(requestId)
        resolveRequest({ error: 'timeout' })
      }, 5000)
      pendingBoardRequests.set(requestId, { resolve: resolveRequest, timer })
      sendToOrb('nova:memory-board:fetch', requestId)
    })
  })
  ipcMain.on('nova:memory-board:data', (event, payload) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || !payload) return
    const pending = pendingBoardRequests.get(payload.request_id)
    if (!pending) return
    pendingBoardRequests.delete(payload.request_id)
    clearTimeout(pending.timer)
    pending.resolve(payload)
  })
  ipcMain.handle('nova:memory-board:export', async (event, payload) => {
    if (!boardWindow || event.sender !== boardWindow.webContents) {
      throw new Error('memory board export rejected')
    }
    if (!payload || !Array.isArray(payload.channels)) return { error: 'invalid_payload' }
    const body = JSON.stringify(
      { exported_at: new Date().toISOString(), channels: payload.channels },
      null,
      2,
    )
    // Sender validation authorizes; this bounds. Board frames are <=256 KiB,
    // so anything past 1 MiB is not board data.
    if (Buffer.byteLength(body, 'utf8') > 1024 * 1024) return { error: 'too_large' }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const { canceled, filePath } = await dialog.showSaveDialog(boardWindow, {
      defaultPath: `memory-board-${stamp}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (canceled || !filePath) return { canceled: true }
    const temporary = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    try {
      await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, filePath)
    } finally {
      await unlink(temporary).catch(() => {})
    }
    return { saved: filePath }
  })
  ipcMain.handle('nova:settings:get', event => {
    if (!settingsWindow || event.sender !== settingsWindow.webContents) {
      throw new Error('settings request rejected')
    }
    return settingsView()
  })
  ipcMain.handle('nova:settings:set', async (event, patch) => {
    if (!settingsWindow || event.sender !== settingsWindow.webContents) {
      throw new Error('settings update rejected')
    }
    // Plaintext key values ride in on `patch`, are sealed inside the store, and
    // are never held, echoed, or logged here. Disk is the commit point: until
    // the write lands, the in-memory settings stay as they were. The writer
    // serializes, so a second change arriving mid-save merges onto the first
    // rather than overwriting it from a stale snapshot.
    let rejectedSecrets = []
    try {
      const written = await settingsWriter(patch)
      // Key names only, never values — this call's per-field rejects, so the
      // panel can say which paste failed instead of the save looking like a
      // silent, total success while that one field kept its old value.
      rejectedSecrets = written.rejectedSecrets ?? []
    } catch (error) {
      console.error(`[desktop-diagnostic] settings_save_failure type=${error.name}`)
      return { ...settingsView(), saved: false, rejectedSecrets: [] }
    }
    // Only the palette is live; voice, proactivity, and keys are read at launch.
    sendToOrb('nova:settings:changed', publicSettings(currentSettings))
    return { ...settingsView(), saved: true, rejectedSecrets }
  })
  ipcMain.handle('nova:bootstrap', event => {
    // The renderer binds its backend-exit listener only after this reply lands, so a push
    // sent before then has nobody to reach. Riding the verdict on the very payload the
    // renderer is already awaiting removes the ordering question entirely. Read here, at
    // invoke time — the frozen startup payload predates every death it would have to report.
    return { ...readBootstrap(event.sender), backendExited }
  })
  ipcMain.handle('nova:native-audio:capture', async (event, enabled) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      throw new Error('native capture request rejected')
    }
    if (enabled !== true) {
      return nativeAudio?.deactivate() || Object.freeze({ audioMode: 'inactive' })
    }
    return nativeAudio?.activate() || Object.freeze({ audioMode: 'browser_aec' })
  })
  ipcMain.on('nova:native-audio:play', (event, payload) => {
    if (mainWindow && event.sender === mainWindow.webContents && payload) {
      nativeAudio?.play(payload.pcm, payload.utteranceId, payload.generationEpoch)
    }
  })
  ipcMain.on('nova:native-audio:terminal', (event, payload) => {
    if (mainWindow && event.sender === mainWindow.webContents && payload) {
      nativeAudio?.terminal(payload.utteranceId, payload.generationEpoch)
    }
  })
  ipcMain.handle('nova:native-audio:clear', async (event, payload) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      throw new Error('native clear request rejected')
    }
    if (payload === null) return nativeAudio?.clear() || false
    if (
      !payload
      || typeof payload.utteranceId !== 'string'
      || !payload.utteranceId
      || payload.utteranceId.length > 256
      || !Number.isInteger(payload.generationEpoch)
      || payload.generationEpoch < 1
    ) {
      throw new Error('native clear identity rejected')
    }
    return nativeAudio?.clear(payload.utteranceId, payload.generationEpoch)
      || Object.freeze({ playedMs: 0 })
  })
  ipcMain.on('nova:window-drag:start', event => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return
    dragController.start()
  })
  ipcMain.on('nova:window-drag:move', (event, payload) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return
    // The renderer's pointermove ticks carry a dx/dy shape purely so this
    // stays a bounded, well-formed IPC message; actual movement is derived
    // only from the main process's own cursor poll (dragController.tick),
    // never from renderer-reported coordinates, which drift under mixed-DPI
    // scaling and don't exist at all on Wayland.
    if (!validDragDelta(payload?.dx, payload?.dy)) return
    dragController.tick()
  })
  ipcMain.on('nova:window-drag:end', event => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return
    const { moved, position } = dragController.end()
    if (!moved || !position) return
    void saveWindowPosition(windowPositionFile(), position).catch(error => {
      console.error(`[desktop-diagnostic] window_position_save_failure type=${error.name}`)
    })
  })
  void loadAppWindow(mainWindow, {
    rendererRoot,
    fetchFile: file => net.fetch(pathToFileURL(file).href),
    cameraFile: camera.source === 'file' ? camera.file : undefined,
    fetchCameraFile: (url, init) => net.fetch(url, init),
  }).then(() => {
    // Belt-and-braces only. The renderer binds its listener from boot(), after its own
    // bootstrap round-trip, so this push may still arrive before anything is listening —
    // which is why the bootstrap reply above carries `backendExited` as the real fix.
    // This covers the ordinary case where boot() finished long before the load settled.
    if (backendExited) sendToOrb('nova:backend-exit')
  }).catch(() => {
    console.error('Ambient Orb renderer failed to load')
    app.quit()
  })
  tray = createTray()
  const shortcutRegistered = globalShortcut.register('CommandOrControl+Shift+Space', () => {
    mainWindow?.isVisible() ? mainWindow.hide() : mainWindow?.show()
  })
  // Wayland/XWayland sessions may silently refuse global shortcuts; surface
  // that instead of leaving the user to wonder why the hotkey never fires.
  if (!shortcutRegistered) {
    console.warn('[ambient-orb] global shortcut unavailable on this session')
  }
}

async function start() {
  const backendKind = selectedBackend(process.env, { isPackaged: app.isPackaged })
  releaseSmokeChannel = createReleaseSmokeChannel({
    environment: process.env,
    isPackaged: app.isPackaged,
    onQuit: () => app.quit(),
  })
  return startWithSelectedCamera({
    environment: process.env,
    requestPermission: source => requestLocalCameraPermission(source, {
      platform: process.platform,
      systemPreferences,
    }),
    start: camera => startSelectedCamera(camera, backendKind, releaseSmokeChannel),
  })
}

async function runInstalledFileCameraSmoke() {
  return startWithSelectedCamera({
    environment: process.env,
    requestPermission: async () => true,
    start: async camera => {
      if (camera.source !== 'file') throw new Error('release camera smoke rejected')
      const window = new BrowserWindow(browserWindowOptions(
        preload,
        `release-camera-${randomBytes(4).toString('hex')}`,
        {opaque: true},
      ))
      configureWindowSecurity(window)
      let handler
      let timer
      const result = new Promise((resolveResult, rejectResult) => {
        timer = setTimeout(() => rejectResult(new Error('release camera smoke rejected')), 10_000)
        handler = (event, value) => {
          if (event.sender !== window.webContents || !validReleaseCameraResult(value)) return
          clearTimeout(timer)
          resolveResult(value)
        }
        ipcMain.on('nova:release-camera:result', handler)
      })
      try {
        installAppProtocol(window.webContents.session.protocol, {
          rendererRoot,
          rendererFiles: [
            '/release-camera.html',
            '/release-camera.mjs',
            '/release-camera-contract.mjs',
            '/camera.mjs',
          ],
          fetchFile: file => net.fetch(pathToFileURL(file).href),
          cameraFile: camera.file,
          fetchCameraFile: (url, init) => net.fetch(url, init),
        })
        await window.loadURL('nova://orb/release-camera.html')
        return await result
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        if (handler !== undefined) ipcMain.removeListener('nova:release-camera:result', handler)
        if (!window.isDestroyed()) window.destroy()
      }
    },
  })
}

function finishInstalledFileCameraSmoke(result) {
  if (result === 'passed') {
    process.stdout.write('{"ok":true}\n', () => app.exit(0))
  } else if (result === 'chromium_codec_unavailable') {
    process.stdout.write(
      'camera-file-integration: chromium_codec_unavailable\n',
      () => app.exit(75),
    )
  } else {
    process.stderr.write('installed camera smoke rejected\n', () => app.exit(1))
  }
}

const installedFileCameraSmoke = app.isPackaged
  && process.env.NOVA_AUDIO_AGENT_RELEASE_CAMERA_SMOKE === RELEASE_CAMERA_SMOKE_MODE

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else if (installedFileCameraSmoke) {
  app.whenReady().then(runInstalledFileCameraSmoke).then(
    finishInstalledFileCameraSmoke,
    () => finishInstalledFileCameraSmoke('capture_failed'),
  )
} else {
  app.on('second-instance', () => mainWindow?.show())
  app.whenReady().then(start).catch(error => {
    if (error?.code === 'source_rollback_unavailable') {
      console.error('[desktop-diagnostic] source_rollback_unavailable')
    }
    app.quit()
  })
}

app.on('before-quit', event => {
  app.isQuitting = true
  releaseSmokeChannel?.close()
  globalShortcut.unregisterAll()
  void nativeAudio?.deactivate()
  if (!backend) return
  // Hold the quit while the backend drains on the stdin-EOF sentinel: a bare
  // kill would cut the session off mid-teardown, and on Windows there is no
  // graceful signal at all. Later passes keep holding; the first pass exits.
  event.preventDefault()
  if (quitDrain) return
  quitDrain = shutdownBackend(backend).then(() => app.exit(0), () => app.exit(0))
})

app.on('window-all-closed', event => event.preventDefault?.())
