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
  shell,
  systemPreferences,
  Tray,
  utilityProcess,
} from 'electron'
import {
  inspectProjectNativeHostFromResources,
  ManagedWorkspaceMaintenanceService,
} from '@nova-audio-agent/runtime/desktop'
import { randomBytes } from 'node:crypto'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path, { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  backendLaunchSpec,
  createReadinessListener,
  nodeRuntimeEntry,
  searchProxyUrlFromRules,
  selectedBackend,
  shutdownBackend,
  shutdownBackendBestEffort,
  watchBackendExit,
} from './backend.mjs'
import {
  classifyBackendFailure,
  createBackendDiagnosticCollector,
} from './backend-diagnostics.mjs'
import { createBackendSupervisor } from './backend-supervisor.mjs'
import { createLifecycleCoordinator } from './lifecycle-coordinator.mjs'
import { configureDevelopmentDockIcon } from './app-icon.mjs'
import {createDebugBoardRequester} from './debug-board-client.mjs'
import { installAppProtocol, loadAppWindow, registerAppScheme } from './app-protocol.mjs'
import { startWithSelectedCamera } from './camera-source.mjs'
import { createDragController } from './drag-controller.mjs'
import {
  canonicalInstalledExecutable,
  canonicalInstalledInvocation,
  inspectCodexVersion,
  prepareDesktopStartup,
} from './desktop-startup.mjs'
import { createNativeAudioManager } from './native-audio.mjs'
import {
  ensurePrivateProjectDirectories,
  repairProjectDirectory,
} from './project-directories.mjs'
import {
  createReleaseSmokeChannel,
  releaseSmokeSourceRollbackExitCode,
} from './release-smoke-channel.mjs'
import { reportStartupFailure } from './startup-diagnostics.mjs'
import {
  createSafeStorageCodec,
  createSettingsWriter,
  hasPlaintextSecret,
  loadSettings,
  orbSettings,
  publicSettings,
  readSecret,
  saveSettings,
  SECRET_KEYS,
  secretsPresent,
  secretValueIsSafe,
} from './settings-store.mjs'
import {
  applySettingsTransaction,
  coordinateCodexRescan,
} from './settings-apply.mjs'
import {
  coordinateBackendRetry,
  createManagedWorkspaceBackendRecovery,
  createWorkspaceActions,
  publicManagedWorkspaceCapabilities,
} from './workspace-actions.mjs'
import {
  clampWindowPosition,
  createConfirmationWindowController,
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
  resolveCameraPermission,
  resolveMicrophonePermission,
  settingsWindowOptions,
  validateBootstrap,
} from './security.mjs'
import { validReleaseCameraResult } from '../renderer/release-camera-contract.mjs'

registerAppScheme(protocol)

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
const WINDOW_SIZE = Object.freeze({ width: 160, height: 160 })
// Long-standing Chromium/X11 quirk: the ARGB visual backing a transparent,
// frameless window isn't reliably available the instant 'ready' fires, so
// window creation is delayed a beat on linux only.
const LINUX_WINDOW_DELAY_MS = 300
const RELEASE_CAMERA_SMOKE_MODE = 'installed-file-v1'
const RELEASE_CAMERA_PASSED_EXIT_CODE = 76
const RELEASE_CAMERA_PENDING_EXIT_CODE = 75
const opaque = process.env.NOVA_ORB_OPAQUE === '1'

let backend = null
let backendSupervisor = null
let backendStatus = Object.freeze({
  state: 'stopped', connection: null, retryInMs: null, diagnostic: null,
})
let settingsApplyStatus = 'idle'
let mainWindow = null
let boardWindow = null
let settingsWindow = null
let tray = null
let bootstrap = null
let nativeAudio = null
let nativeBinary = null
let projectNativeHost
let projectNativeAuthorityPresent = false
let managedWorkspaceMaintenance = null
let managedWorkspaceCapabilities = publicManagedWorkspaceCapabilities()
let quitDrain = null
let releaseSmokeChannel = null
// Settings and debug boards are main-owned IPC surfaces. Neither relays through
// the orb renderer or shares the realtime voice socket.
let currentSettings = null
let desktopConfig = null
let codexStatus = Object.freeze({
  status: 'missing', invocation: null, path: null, prefixArgs: null,
  source: null, version: null,
})
const secretCodec = createSafeStorageCodec(safeStorage)
const requestBoardSnapshot = createDebugBoardRequester()
let microphoneStatus = 'checking'
let microphoneSystemStatus = 'unknown'
const MICROPHONE_STATUSES = new Set([
  'granted',
  'permission_denied',
  'restricted',
  'no_input_device',
  'device_busy',
  'capture_unavailable',
  'audio_pipeline_error',
])
const lifecycleCoordinator = createLifecycleCoordinator({
  onChange: () => sendToSettings('nova:settings:changed', settingsView()),
})

// Every push to the orb goes through here. `mainWindow` is never nulled — the orb has no
// 'closed' handler because it is not meant to close before the app quits — so a send after
// the window is gone would throw "Object has been destroyed" out of whatever callback made
// it, uncaught, in the main process. One guard, one place.
function sendToWindow(window, channel, ...args) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, ...args)
}

function sendToOrb(channel, ...args) {
  sendToWindow(mainWindow, channel, ...args)
}

function sendToSettings(channel, ...args) {
  sendToWindow(settingsWindow, channel, ...args)
}

function windowPositionFile() {
  return resolve(app.getPath('userData'), 'ambient-orb-window-position.json')
}

function settingsFile() {
  return resolve(app.getPath('userData'), 'ambient-orb-settings.json')
}

function managedWorkspacesView() {
  return Object.freeze({
    health: managedWorkspaceCapabilities.health,
    current: managedWorkspaceCapabilities.current,
    all: managedWorkspaceCapabilities.all,
    recoveryStatus: managedWorkspaceBackendRecovery.status(),
    lifecycleBusy: lifecycleCoordinator.busy,
  })
}

// The single shape the settings panel is ever told. Key material is reduced to
// seven booleans here and nowhere else, so no handler can widen it by accident;
// `keyringAvailable` is what turns the plaintext warning line on. It answers
// for the file as it stands, not merely for today's keyring: an entry written
// while no keyring existed is still readable by anyone, so the warning stays up
// until the next save re-seals it.
function settingsView() {
  return {
    ...publicSettings(currentSettings),
    codexStatus,
    backendStatus: backendStatus.state,
    backendDiagnostic: backendStatus.diagnostic,
    backendRetryInMs: backendStatus.retryInMs,
    settingsApplyStatus,
    managedWorkspaces: managedWorkspacesView(),
    microphoneStatus,
    effectivePaths: desktopConfig ? Object.freeze({
      stateRoot: desktopConfig.stateRoot,
      managedRoot: desktopConfig.managedRoot,
      workspace: desktopConfig.workspace,
    }) : null,
    secretsPresent: secretsPresent(currentSettings),
    keyringAvailable: secretCodec.available() && !hasPlaintextSecret(currentSettings),
  }
}

function publishSettingsApplyStatus(status) {
  settingsApplyStatus = status
  sendToSettings('nova:settings:changed', settingsView())
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
    void refreshManagedWorkspaceCapabilities().then(() => {
      sendToSettings('nova:settings:changed', settingsView())
    })
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
  void refreshManagedWorkspaceCapabilities().then(() => {
    sendToSettings('nova:settings:changed', settingsView())
  })
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

async function prepareDesktopConfiguration() {
  if (projectNativeHost === undefined) {
    const projectNativeLoad = inspectProjectNativeHostFromResources({
      resourcesPath: app.isPackaged ? process.resourcesPath : resolve(packageRoot, 'build'),
      platform: process.platform,
      arch: process.arch,
      electronAbi: process.versions.modules,
    })
    projectNativeHost = projectNativeLoad.host
    projectNativeAuthorityPresent = projectNativeLoad.status !== 'absent'
  }
  const prepared = await prepareDesktopStartup({
    settings: currentSettings,
    environment: process.env,
    home: homedir(),
    platform: process.platform,
    arch: process.arch,
    pathApi: path,
    canonicalizePath: value => resolve(value),
    canonicalizeExecutable: value => canonicalInstalledExecutable(value, {
      platform: process.platform,
      realpath: realpathSync,
      stat: statSync,
      access: executable => accessSync(executable, constants.X_OK),
    }),
    canonicalizeInvocation: candidate => canonicalInstalledInvocation(candidate, {
      platform: process.platform,
      pathApi: path,
      realpath: realpathSync,
      stat: statSync,
      access: executable => accessSync(executable, constants.X_OK),
      readFile: readFileSync,
    }),
    mkdir,
    inspectCodex: invocation => inspectCodexVersion(invocation, {
      environment: process.env,
      run: spawnSync,
    }),
    ensureDirectories: config => ensurePrivateProjectDirectories({
      config,
      home: homedir(),
      platform: process.platform,
      nativeHost: projectNativeHost,
      pathApi: path,
      mkdir,
    }),
  })
  const maintenance = projectNativeHost === null
    ? null
    : await ManagedWorkspaceMaintenanceService.openFromDesktop({
        stateRoot: prepared.config.stateRoot,
        managedRoot: prepared.config.managedRoot,
        nativeHost: projectNativeHost,
      })
  return Object.freeze({...prepared, maintenance})
}

async function commitDesktopConfiguration(prepared) {
  const previousMaintenance = managedWorkspaceMaintenance
  desktopConfig = prepared.config
  codexStatus = prepared.codexStatus
  managedWorkspaceMaintenance = prepared.maintenance
  if (previousMaintenance !== null) await previousMaintenance.close().catch(() => undefined)
  await refreshManagedWorkspaceCapabilities()
}

async function discardDesktopConfiguration(prepared) {
  const maintenance = prepared?.maintenance
  if (maintenance !== null && maintenance !== undefined
    && maintenance !== managedWorkspaceMaintenance) {
    await maintenance.close().catch(() => undefined)
  }
}

async function refreshDesktopConfiguration() {
  const prepared = await prepareDesktopConfiguration()
  await commitDesktopConfiguration(prepared)
  return prepared
}

async function refreshManagedWorkspaceCapabilities() {
  const maintenance = managedWorkspaceMaintenance
  if (maintenance === null) {
    managedWorkspaceCapabilities = publicManagedWorkspaceCapabilities()
    await managedWorkspaceBackendRecovery.observe(
      managedWorkspaceCapabilities,
      projectNativeAuthorityPresent,
    )
    return managedWorkspaceCapabilities
  }
  try {
    const capabilities = await maintenance.capabilities()
    if (maintenance !== managedWorkspaceMaintenance) return managedWorkspaceCapabilities
    managedWorkspaceCapabilities = publicManagedWorkspaceCapabilities(capabilities)
  } catch {
    if (maintenance === managedWorkspaceMaintenance) {
      managedWorkspaceCapabilities = publicManagedWorkspaceCapabilities()
    }
  }
  await managedWorkspaceBackendRecovery.observe(
    managedWorkspaceCapabilities,
    projectNativeAuthorityPresent,
  )
  return managedWorkspaceCapabilities
}

const managedWorkspaceBackendRecovery = createManagedWorkspaceBackendRecovery({
  getCapabilities: () => managedWorkspaceCapabilities,
  hasMaintenanceAuthority: () => projectNativeAuthorityPresent,
  refreshCapabilities: refreshManagedWorkspaceCapabilities,
  startBackend: async () => {
    if (!backendSupervisor) throw new Error('backend supervisor unavailable')
    await backendSupervisor.start()
  },
  restartBackend: async () => {
    if (!backendSupervisor) throw new Error('backend supervisor unavailable')
    await backendSupervisor.restart()
  },
  retryBackend: async () => {
    if (!backendSupervisor) throw new Error('backend supervisor unavailable')
    await backendSupervisor.retry()
    return backendSupervisor.status().state === 'connected'
  },
  stopBackend: async () => {
    if (!backendSupervisor) return true
    await backendSupervisor.stop()
    return backendSupervisor.status().state === 'stopped'
  },
})

const workspaceActions = createWorkspaceActions({
  coordinator: lifecycleCoordinator,
  getMaintenance: () => managedWorkspaceMaintenance,
  getWindow: () => settingsWindow,
  showMessageBox: (window, options) => window
    ? dialog.showMessageBox(window, options)
    : dialog.showMessageBox(options),
  openPath: value => shell.openPath(value),
  stopBackendCleanly: async () => {
    if (!backendSupervisor) return false
    await backendSupervisor.stop()
    return backendSupervisor.status().state === 'stopped'
  },
  restartBackendBounded: async () => {
    if (!backendSupervisor) return false
    await backendSupervisor.restart()
    return backendSupervisor.status().state === 'connected'
  },
})

async function launchBackend(backendKind, smokeChannel, onExit) {
  const configurationCode = desktopConfig?.codexConfigurationError
    ?? desktopConfig?.modelConfigurationError
  if (configurationCode) throw classifyBackendFailure(configurationCode)
  if (codexStatus.status !== 'ready') throw classifyBackendFailure('codex_unavailable')
  const token = randomBytes(16).toString('hex')
  const workspace = desktopConfig?.workspace || process.cwd()
  let spawnedBackend = null
  // The listener owns the handshake, so it must be bound before the backend can
  // dial it; the readiness timeout still kills a backend that never arrives.
  const listener = createReadinessListener({
    token,
    onTimeout: () => {
      if (spawnedBackend) void shutdownBackendBestEffort(spawnedBackend)
    },
  })
  let ready
  const diagnostic = createBackendDiagnosticCollector()
  try {
    const decryptedSecrets = decryptSecretsForSpawn(currentSettings, secretCodec)
    let searchProxyUrl = ''
    try {
      const proxyRules = await mainWindow?.webContents.session.resolveProxy(
        'https://api.tavily.com/search',
      )
      searchProxyUrl = searchProxyUrlFromRules(proxyRules)
    } catch {
      // Proxy discovery is best-effort. Explicit HTTP(S)_PROXY values still flow through parentEnv.
    }
    const spec = backendLaunchSpec({
      backend: backendKind,
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
      resolvedConfig: desktopConfig,
      searchProxyUrl,
    })
    spawnedBackend = utilityProcess.fork(spec.entry, spec.argv, {
      cwd: workspace,
      env: spec.env,
      stdio: spec.stdio,
      serviceName: 'Nova Audio Agent Runtime',
    })
    backend = spawnedBackend
    spawnedBackend.stderr?.on('data', chunk => {
      const code = diagnostic.push(chunk.toString('utf8'))
      if (code) console.error(`[backend-diagnostic] ${code}`)
    })
    spawnedBackend.stdout?.on('data', chunk => {
      const code = diagnostic.push(chunk.toString('utf8'))
      if (code) console.error(`[backend-diagnostic] ${code}`)
    })
    // Covers both deaths: the child that exits, and the utility process that never
    // starts. Either way the handshake is failed now
    // instead of waiting out the timeout, and `launchBackend` rejects, which the
    // whenReady().catch() below turns into a quit exactly as a timeout does.
    watchBackendExit(spawnedBackend, {
      closeReadiness: listener.close,
      onExit: reason => {
        if (backend === spawnedBackend) backend = null
        void reason
        onExit(diagnostic.failure())
      },
    })
    try {
      ready = await listener.readiness
    } catch {
      throw diagnostic.failure('backend_unavailable')
    }
  } finally {
    listener.close()
  }
  const validated = validateBootstrap({ endpoint: ready.endpoint, token })
  smokeChannel?.ready({endpoint: validated.endpoint, token: validated.token})
  return Object.freeze({backend: spawnedBackend, connection: validated})
}

function initializeDesktopBootstrap(cameraSource) {
  nativeBinary = app.isPackaged
    ? resolve(process.resourcesPath, 'native/macos_voice_io')
    : resolve(packageRoot, 'build/macos_voice_io')
  const nativeAvailable = process.platform === 'darwin' && existsSync(nativeBinary)
  nativeAudio = nativeAvailable ? createNativeAudioManager({
    binary: nativeBinary,
    onEvent: event => sendToOrb('nova:native-audio:event', event),
  }) : null
  bootstrap = Object.freeze({
    audioMode: 'inactive',
    nativeAvailable,
    platform: process.platform,
    opaque,
    cameraSource,
    settings: orbSettings(currentSettings),
  })
}

async function startSelectedCamera(camera, backendKind, smokeChannel) {
  currentSettings = await loadSettings(settingsFile())
  await refreshDesktopConfiguration()
  initializeDesktopBootstrap(camera.source)
  const launchId = randomBytes(8).toString('hex')
  if (process.platform === 'linux') await wait(LINUX_WINDOW_DELAY_MS)
  mainWindow = await createWindow(launchId)
  const windowShown = sourceStartupSmoke
    ? new Promise((resolveShown, rejectShown) => {
        if (mainWindow.isVisible()) {
          resolveShown()
          return
        }
        mainWindow.once('show', resolveShown)
        mainWindow.once('closed', () => rejectShown(new Error('source_startup_window_closed')))
      })
    : null
  const confirmationWindow = createConfirmationWindowController({
    getBounds: () => mainWindow.getBounds(),
    setBounds: bounds => mainWindow.setBounds(bounds),
    getZoomFactor: () => mainWindow.webContents.getZoomFactor(),
    getWorkAreaForPoint: point => screen.getDisplayNearestPoint(point).workArea,
    onPlacement: placement => sendToOrb('nova:confirmation-placement', placement),
  })

  const dragController = createDragController({
    getCursor: () => screen.getCursorScreenPoint(),
    getWindowPosition: () => {
      const [x, y] = mainWindow.getPosition()
      return { x, y }
    },
    setWindowPosition: position => mainWindow.setPosition(position.x, position.y),
    clamp: candidate => confirmationWindow.clampDragPosition(candidate),
  })
  mainWindow.webContents.on('zoom-changed', () => {
    if (confirmationWindow.active) setTimeout(() => confirmationWindow.sync(), 0)
  })
  const readBootstrap = createBootstrapAccess(bootstrap, mainWindow.webContents)
  ipcMain.handle('nova:camera:permission', async event => {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      throw new Error('camera permission request rejected')
    }
    return resolveCameraPermission(camera.source, {
      platform: process.platform,
      systemPreferences,
    })
  })
  ipcMain.handle('nova:microphone:permission', async event => {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      throw new Error('microphone permission request rejected')
    }
    if (['granted', 'denied', 'restricted'].includes(microphoneSystemStatus)) {
      return Object.freeze({ status: microphoneSystemStatus })
    }
    const result = await resolveMicrophonePermission({
      platform: process.platform,
      systemPreferences,
    })
    if (['granted', 'denied', 'restricted'].includes(result.status)) {
      microphoneSystemStatus = result.status
    }
    return result
  })
  ipcMain.on('nova:microphone:status', (event, status) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return
    if (!MICROPHONE_STATUSES.has(status)) return
    microphoneStatus = status
    sendToSettings('nova:settings:changed', settingsView())
  })
  ipcMain.on('nova:orb-menu:show', event => {
    if (mainWindow && event.sender === mainWindow.webContents) showOrbMenu(launchId)
  })
  ipcMain.on('nova:settings:open', event => {
    if (mainWindow && event.sender === mainWindow.webContents) openSettingsWindow(launchId)
  })
  ipcMain.handle('nova:memory-board:request', async event => {
    if (!boardWindow || event.sender !== boardWindow.webContents) {
      throw new Error('memory board request rejected')
    }
    if (backendStatus.state !== 'connected' || !backendStatus.connection) {
      return { error: 'unavailable' }
    }
    try {
      return await requestBoardSnapshot(backendStatus.connection, {
        board: 'memory',
        detail: 'compact',
      })
    } catch (error) {
      return {error: error?.code === 'timeout' ? 'timeout' : 'unavailable'}
    }
  })
  ipcMain.handle('nova:workspace-graph-board:request', async event => {
    if (!boardWindow || event.sender !== boardWindow.webContents) {
      throw new Error('workspace graph board request rejected')
    }
    if (backendStatus.state !== 'connected' || !backendStatus.connection) {
      return { error: 'unavailable' }
    }
    try {
      return await requestBoardSnapshot(backendStatus.connection, {
        board: 'workspace_graph',
        detail: 'compact',
      })
    } catch (error) {
      return {error: error?.code === 'timeout' ? 'timeout' : 'unavailable'}
    }
  })
  ipcMain.handle('nova:memory-board:export', async event => {
    if (!boardWindow || event.sender !== boardWindow.webContents) {
      throw new Error('memory board export rejected')
    }
    if (backendStatus.state !== 'connected' || !backendStatus.connection) {
      return {error: 'unavailable'}
    }
    let snapshot
    try {
      snapshot = await requestBoardSnapshot(backendStatus.connection, {
        board: 'memory',
        detail: 'full',
      })
    } catch (error) {
      return {error: error?.code === 'timeout' ? 'timeout' : 'unavailable'}
    }
    if (!snapshot || !Array.isArray(snapshot.channels)
      || snapshot.diagnostics?.version !== 1
      || !Array.isArray(snapshot.diagnostics.records)
      || snapshot.diagnostics.records.length > 128
      || !snapshot.diagnostics.records.every(record => (
        record !== null
        && typeof record === 'object'
        && Number.isFinite(record.ts)
        && typeof record.kind === 'string'
        && record.payload !== null
        && typeof record.payload === 'object'
        && !Array.isArray(record.payload)
      ))) return { error: 'invalid_payload' }
    const body = JSON.stringify(
      {
        exported_at: new Date().toISOString(),
        channels: snapshot.channels,
        diagnostics: snapshot.diagnostics,
      },
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
  ipcMain.handle('nova:settings:get', async event => {
    if (!settingsWindow || event.sender !== settingsWindow.webContents) {
      throw new Error('settings request rejected')
    }
    await refreshManagedWorkspaceCapabilities()
    return settingsView()
  })
  ipcMain.handle('nova:codex:rescan', async event => {
    if (!settingsWindow || event.sender !== settingsWindow.webContents) {
      throw new Error('Codex rescan rejected')
    }
    return coordinateCodexRescan({
      coordinator: lifecycleCoordinator,
      currentConfiguration: () => Object.freeze({config: desktopConfig, codexStatus}),
      prepareConfiguration: prepareDesktopConfiguration,
      commitConfiguration: commitDesktopConfiguration,
      discardConfiguration: discardDesktopConfiguration,
      restartBackend: async () => {
        if (backendSupervisor) await managedWorkspaceBackendRecovery.restart()
      },
      view: settingsView,
    })
  })
  ipcMain.handle('nova:backend:retry', async (event, ...args) => {
    if (!settingsWindow || event.sender !== settingsWindow.webContents || args.length !== 0) {
      throw new Error('backend retry rejected')
    }
    const recovery = await coordinateBackendRetry({
      coordinator: lifecycleCoordinator,
      retry: () => managedWorkspaceBackendRecovery.retry(),
    })
    return recovery.status === 'busy'
      ? {...settingsView(), operationStatus: 'busy'}
      : {...settingsView(), operationStatus: recovery.status}
  })
  ipcMain.handle('nova:microphone:retry', event => {
    if (!settingsWindow || event.sender !== settingsWindow.webContents) {
      throw new Error('microphone retry rejected')
    }
    microphoneStatus = 'checking'
    sendToOrb('nova:microphone:retry')
    return settingsView()
  })
  ipcMain.handle('nova:projects:repair', async (event, root) => {
    if (!settingsWindow || event.sender !== settingsWindow.webContents) {
      throw new Error('Projects repair rejected')
    }
    return repairProjectDirectory({
      root,
      config: desktopConfig,
      nativeHost: projectNativeHost,
      pathApi: path,
    })
  })
  const workspaceActionReply = async action => {
    const result = await action()
    await refreshManagedWorkspaceCapabilities()
    sendToSettings('nova:settings:changed', settingsView())
    return Object.freeze({status: result.status, managedWorkspaces: managedWorkspacesView()})
  }
  ipcMain.handle('nova:workspaces:open-current', async (event, ...args) => {
    if (!settingsWindow || event.sender !== settingsWindow.webContents || args.length !== 0) {
      throw new Error('workspace open rejected')
    }
    return workspaceActionReply(() => workspaceActions.openCurrent())
  })
  ipcMain.handle('nova:workspaces:clear-current', async (event, ...args) => {
    if (!settingsWindow || event.sender !== settingsWindow.webContents || args.length !== 0) {
      throw new Error('workspace clear rejected')
    }
    return workspaceActionReply(() => workspaceActions.clearCurrent())
  })
  ipcMain.handle('nova:workspaces:clear-all', async (event, ...args) => {
    if (!settingsWindow || event.sender !== settingsWindow.webContents || args.length !== 0) {
      throw new Error('workspace clear rejected')
    }
    return workspaceActionReply(() => workspaceActions.clearAll())
  })
  ipcMain.handle('nova:settings:set', async (event, patch) => {
    if (!settingsWindow || event.sender !== settingsWindow.webContents) {
      throw new Error('settings update rejected')
    }
    // Plaintext values exist only in the inbound patch and the queued writer.
    // Every later callback receives committed settings or prepared public
    // configuration, and every reply contains secret key names only.
    const applied = await applySettingsTransaction({
      coordinator: lifecycleCoordinator,
      patch,
      write: async value => {
        try {
          return await settingsWriter(value)
        } catch (error) {
          console.error(`[desktop-diagnostic] settings_save_failure type=${error.name}`)
          throw error
        }
      },
      publishCommitted: () => sendToOrb(
        'nova:settings:changed', orbSettings(currentSettings),
      ),
      prepareConfiguration: async () => {
        try {
          return await prepareDesktopConfiguration()
        } catch (error) {
          console.error(`[desktop-diagnostic] settings_apply_failure type=${error.name}`)
          throw error
        }
      },
      commitConfiguration: commitDesktopConfiguration,
      discardConfiguration: discardDesktopConfiguration,
      restartBackend: async () => {
        const recovery = await managedWorkspaceBackendRecovery.restart()
        if (recovery.status !== 'restarted'
          || backendSupervisor?.status().state !== 'connected') {
          throw new Error('backend restart unavailable')
        }
      },
      publishStatus: publishSettingsApplyStatus,
    })
    return {...settingsView(), ...applied}
  })
  ipcMain.handle('nova:bootstrap', event => {
    // The renderer binds its backend-exit listener only after this reply lands, so a push
    // sent before then has nobody to reach. Riding the verdict on the very payload the
    // renderer is already awaiting removes the ordering question entirely. Read here, at
    // invoke time — the frozen startup payload predates every death it would have to report.
    return {
      ...readBootstrap(event.sender),
      backend: backendStatus.connection,
      backendStatus: backendStatus.state,
    }
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
  ipcMain.handle('nova:native-audio:playback-muted', (event, muted) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      throw new Error('native playback mute request rejected')
    }
    return nativeAudio?.setPlaybackMuted(muted === true) ?? true
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
  ipcMain.on('nova:confirmation-mode', (event, active) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return
    if (typeof active !== 'boolean') return
    confirmationWindow.setMode(active)
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
    const naturalPosition = confirmationWindow.finishDrag(position)
    void saveWindowPosition(windowPositionFile(), naturalPosition).catch(error => {
      console.error(`[desktop-diagnostic] window_position_save_failure type=${error.name}`)
    })
  })
  const rendererLoaded = loadAppWindow(mainWindow, {
    rendererRoot,
    fetchFile: file => net.fetch(pathToFileURL(file).href),
    cameraFile: camera.source === 'file' ? camera.file : undefined,
    fetchCameraFile: (url, init) => net.fetch(url, init),
  })
  if (sourceStartupSmoke) {
    await Promise.all([rendererLoaded, windowShown])
    process.stdout.write('[desktop-smoke] source_window_ready\n', () => app.quit())
    return
  }
  void rendererLoaded.then(() => {
    if (backendStatus.state === 'connected' && backendStatus.connection) {
      sendToOrb('nova:backend-ready', backendStatus.connection)
    } else if (backendStatus.state !== 'starting') sendToOrb('nova:backend-exit')
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
  backendSupervisor = createBackendSupervisor({
    start: onExit => launchBackend(backendKind, smokeChannel, onExit),
    stopBackend: async child => {
      await shutdownBackend(child)
      if (backend === child) backend = null
    },
    onStatus: status => {
      backendStatus = status
      if (status.state === 'connected' && settingsApplyStatus === 'restarting') {
        settingsApplyStatus = 'applied'
      } else if (
        settingsApplyStatus === 'restarting'
        && ['configuration_required', 'authentication_failed', 'unavailable', 'stopped']
          .includes(status.state)
      ) {
        settingsApplyStatus = 'restart_failed'
      }
      sendToSettings('nova:settings:changed', settingsView())
      sendToOrb('nova:backend-status', status)
      if (status.state === 'connected' && status.connection) {
        sendToOrb('nova:backend-ready', status.connection)
      } else if (status.state !== 'starting' && status.state !== 'stopped') {
        sendToOrb('nova:backend-exit')
      }
    },
  })
  void managedWorkspaceBackendRecovery.start()
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
    start: camera => startSelectedCamera(camera, backendKind, releaseSmokeChannel),
  })
}

async function runInstalledFileCameraSmoke() {
  return startWithSelectedCamera({
    environment: process.env,
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
    app.exit(RELEASE_CAMERA_PASSED_EXIT_CODE)
  } else if (result === 'chromium_codec_unavailable') {
    app.exit(RELEASE_CAMERA_PENDING_EXIT_CODE)
  } else {
    app.exit(1)
  }
}

const installedFileCameraSmoke = app.isPackaged
  && process.env.NOVA_AUDIO_AGENT_RELEASE_CAMERA_SMOKE === RELEASE_CAMERA_SMOKE_MODE
const packagedSourceRollbackUnavailable = app.isPackaged
  && process.env.NOVA_AUDIO_AGENT_BACKEND === 'python'
const sourceStartupSmoke = !app.isPackaged
  && process.argv.includes('--nova-source-startup-smoke-v1')

if (packagedSourceRollbackUnavailable) {
  const sourceRollbackExitCode = releaseSmokeSourceRollbackExitCode({
    environment: process.env,
    isPackaged: app.isPackaged,
  })
  if (sourceRollbackExitCode === null) {
    process.stderr.write(
      '[desktop-diagnostic] source_rollback_unavailable\n',
      () => app.exit(0),
    )
  } else app.exit(sourceRollbackExitCode)
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else if (installedFileCameraSmoke) {
  app.whenReady().then(runInstalledFileCameraSmoke).then(
    finishInstalledFileCameraSmoke,
    () => finishInstalledFileCameraSmoke('capture_failed'),
  )
} else {
  app.on('second-instance', () => mainWindow?.show())
  app.whenReady().then(() => {
    configureDevelopmentDockIcon({
      app,
      platform: process.platform,
      iconFile: resolve(packageRoot, 'resources/icon-source/1024x1024.png'),
    })
    return start()
  }).catch(error => {
    reportStartupFailure(error)
    app.quit()
  })
}

app.on('before-quit', event => {
  app.isQuitting = true
  releaseSmokeChannel?.close()
  globalShortcut.unregisterAll()
  void nativeAudio?.deactivate()
  if (!backendSupervisor && !backend && !managedWorkspaceMaintenance) return
  // Hold the quit while the backend drains on the stdin-EOF sentinel: a bare
  // kill would cut the session off mid-teardown, and on Windows there is no
  // graceful signal at all. Later passes keep holding; the first pass exits.
  event.preventDefault()
  if (quitDrain) return
  const backendDrain = backendSupervisor
    ? backendSupervisor.stop()
    : backend ? shutdownBackendBestEffort(backend) : Promise.resolve()
  const maintenance = managedWorkspaceMaintenance
  managedWorkspaceMaintenance = null
  const maintenanceDrain = maintenance?.close() ?? Promise.resolve()
  const drain = Promise.all([backendDrain, maintenanceDrain])
  quitDrain = drain.then(() => app.exit(0), () => app.exit(0))
})

app.on('window-all-closed', event => event.preventDefault?.())
