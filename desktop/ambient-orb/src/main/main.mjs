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
  screen,
  systemPreferences,
  Tray,
} from 'electron'
import { randomBytes } from 'node:crypto'
import { rename, unlink, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { backendLaunchSpec, createReadinessListener } from './backend.mjs'
import { loadAppWindow } from './app-protocol.mjs'
import { createNativeAudioManager } from './native-audio.mjs'
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
  createBootstrapAccess,
  validateBootstrap,
} from './security.mjs'

protocol.registerSchemesAsPrivileged([{
  scheme: 'nova',
  privileges: { standard: true, secure: true, supportFetchAPI: true },
}])

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '../..')
const rendererRoot = resolve(packageRoot, 'src/renderer')
const preload = resolve(packageRoot, 'src/preload/preload.cjs')
const WINDOW_SIZE = Object.freeze({ width: 184, height: 184 })

let backend = null
let mainWindow = null
let boardWindow = null
let tray = null
let bootstrap = null
let nativeAudio = null
let nativeBinary = null
const pendingBoardRequests = new Map()

function pythonExecutable() {
  if (process.env.NOVA_AUDIO_AGENT_PYTHON) return process.env.NOVA_AUDIO_AGENT_PYTHON
  if (process.env.VIRTUAL_ENV) return resolve(process.env.VIRTUAL_ENV, 'bin/python')
  return 'python3'
}

function configureWindowSecurity(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!allowRendererNavigation(url)) event.preventDefault()
  })
  const electronSession = window.webContents.session
  electronSession.setPermissionCheckHandler((_contents, permission, origin) => (
    permission === 'media' && origin.startsWith('nova://orb')
  ))
  electronSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const types = details.mediaTypes || []
    const audioOnly = types.length > 0 && types.every(type => type === 'audio')
    callback(
      contents === window.webContents
      && permission === 'media'
      && audioOnly
      && contents.getURL().startsWith('nova://orb'),
    )
  })
}

function windowPositionFile() {
  return resolve(app.getPath('userData'), 'ambient-orb-window-position.json')
}

async function createWindow(launchId) {
  const window = new BrowserWindow(browserWindowOptions(preload, launchId))
  const positionFile = windowPositionFile()
  const primary = screen.getPrimaryDisplay().workArea
  const fallback = { x: primary.x + primary.width - 208, y: primary.y + 24 }
  const saved = await loadWindowPosition(positionFile)
  const candidate = saved || fallback
  const center = {
    x: candidate.x + Math.floor(WINDOW_SIZE.width / 2),
    y: candidate.y + Math.floor(WINDOW_SIZE.height / 2),
  }
  const workArea = screen.getDisplayNearestPoint(center).workArea
  const position = clampWindowPosition(candidate, WINDOW_SIZE, workArea)
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

function showOrbMenu(launchId) {
  Menu.buildFromTemplate([
    { label: 'Memory Board', click: () => openMemoryBoard(launchId) },
    { type: 'separator' },
    { label: '退出 Nova Audio Agent', click: () => app.quit() },
  ]).popup({ window: mainWindow })
}

function createTray() {
  const pixel = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL6WQAAAABJRU5ErkJggg==',
  )
  const next = new Tray(pixel)
  next.setToolTip('Nova Audio Agent Ambient Orb')
  next.setContextMenu(Menu.buildFromTemplate([
    { label: '显示', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]))
  next.on('click', () => mainWindow?.isVisible() ? mainWindow.hide() : mainWindow?.show())
  return next
}

async function launchBackend() {
  const token = randomBytes(16).toString('hex')
  const workspace = process.env.NOVA_AUDIO_AGENT_CODEX_WORKSPACE || process.cwd()
  // The listener owns the handshake, so it must be bound before the backend can
  // dial it; the readiness timeout still kills a backend that never arrives.
  const listener = createReadinessListener({
    token,
    onTimeout: () => backend?.kill('SIGTERM'),
  })
  let ready
  try {
    const spec = backendLaunchSpec({
      python: pythonExecutable(),
      workspace,
      token,
      readyEndpoint: await listener.endpoint,
      parentEnv: process.env,
    })
    backend = spawn(spec.command, spec.argv, {
      cwd: workspace,
      env: spec.env,
      stdio: spec.stdio,
    })
    backend.stderr.on('data', chunk => {
      console.error(`[backend-diagnostic] ${chunk.toString('utf8').trim()}`)
    })
    backend.stdout.on('data', chunk => {
      console.error(`[backend-diagnostic] ${chunk.toString('utf8').trim()}`)
    })
    backend.once('exit', () => {
      // A backend that died before dialing back never will, so fail the
      // handshake now instead of waiting out the timeout. No-op once ready.
      listener.close(new Error('desktop backend exited before readiness'))
      if (!app.isQuitting) mainWindow?.webContents.send('nova:backend-exit')
    })
    ready = await listener.readiness
  } finally {
    listener.close()
  }
  const validated = validateBootstrap({ endpoint: ready.endpoint, token })
  nativeBinary = app.isPackaged
    ? resolve(process.resourcesPath, 'native/macos_voice_io')
    : resolve(packageRoot, 'build/macos_voice_io')
  const nativeAvailable = process.platform === 'darwin' && existsSync(nativeBinary)
  nativeAudio = nativeAvailable ? createNativeAudioManager({
    binary: nativeBinary,
    onEvent: event => mainWindow?.webContents.send('nova:native-audio:event', event),
  }) : null
  bootstrap = Object.freeze({
    ...validated,
    audioMode: 'inactive',
    nativeAvailable,
  })
}

async function requestCameraPermission() {
  if (
    process.platform === 'darwin'
    && systemPreferences.getMediaAccessStatus('camera') === 'not-determined'
  ) {
    await systemPreferences.askForMediaAccess('camera')
  }
}

async function start() {
  await requestCameraPermission()
  await launchBackend()
  const launchId = randomBytes(8).toString('hex')
  mainWindow = await createWindow(launchId)
  let dragActive = false
  let dragMoved = false
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
      mainWindow.webContents.send('nova:memory-board:fetch', requestId)
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
  ipcMain.handle('nova:bootstrap', event => {
    return readBootstrap(event.sender)
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
    dragActive = true
    dragMoved = false
  })
  ipcMain.on('nova:window-drag:move', (event, payload) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return
    if (!dragActive || !validDragDelta(payload?.dx, payload?.dy)) return
    const [x, y] = mainWindow.getPosition()
    const candidate = { x: x + payload.dx, y: y + payload.dy }
    const center = {
      x: candidate.x + Math.floor(WINDOW_SIZE.width / 2),
      y: candidate.y + Math.floor(WINDOW_SIZE.height / 2),
    }
    const workArea = screen.getDisplayNearestPoint(center).workArea
    const position = clampWindowPosition(candidate, WINDOW_SIZE, workArea)
    mainWindow.setPosition(position.x, position.y)
    dragMoved = true
  })
  ipcMain.on('nova:window-drag:end', event => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return
    const shouldSave = dragActive && dragMoved
    dragActive = false
    dragMoved = false
    if (!shouldSave) return
    const [x, y] = mainWindow.getPosition()
    void saveWindowPosition(windowPositionFile(), { x, y }).catch(error => {
      console.error(`[desktop-diagnostic] window_position_save_failure type=${error.name}`)
    })
  })
  ipcMain.on('nova:orb-menu:show', event => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return
    Menu.buildFromTemplate([
      { label: '退出 Nova Audio Agent', click: () => app.quit() },
    ]).popup({ window: mainWindow })
  })
  void loadAppWindow(mainWindow, {
    rendererRoot,
    fetchFile: file => net.fetch(pathToFileURL(file).href),
  }).catch(() => {
    console.error('Ambient Orb renderer failed to load')
    app.quit()
  })
  tray = createTray()
  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    mainWindow?.isVisible() ? mainWindow.hide() : mainWindow?.show()
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => mainWindow?.show())
  app.whenReady().then(start).catch(() => app.quit())
}

app.on('before-quit', () => {
  app.isQuitting = true
  globalShortcut.unregisterAll()
  if (backend && !backend.killed) backend.kill('SIGTERM')
  void nativeAudio?.deactivate()
})

app.on('window-all-closed', event => event.preventDefault?.())
