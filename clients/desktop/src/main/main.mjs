import {createVisor} from './visor.mjs'
import {setLanguage, currentLanguage, t} from '../renderer/locale.mjs'
import {createBackendControl, classifyBackendFailure, createBackendDiagnosticCollector, createBackendSupervisor} from './backend-supervisor.mjs'
import {createLifecycleCoordinator, canonicalInstalledExecutable, canonicalInstalledInvocation, inspectCodexVersion, prepareDesktopStartup, reportStartupFailure} from './desktop-startup.mjs'
import {VISION_MODELS} from '@nova-audio-agent/runtime/desktop'
import {configureDesktopIdentity} from './desktop-identity.mjs'
import {createFrontendUsage} from './frontend-usage.mjs'
import {createKnowledgeActions} from './knowledge-actions.mjs'
import {createManagedPhoneService, phoneNetwork, requestPhonePairing, renderPhoneQr} from './phone-connection.mjs'
import {activeMcpMenuRows} from './orb-menu.mjs'
import {parseSettingsCommit, validatePreparedSettings, prepareCapabilityCommit, readCapabilityDocument, readCapabilityEditor, publicCapabilityProbe, capabilityEnvironment, assertEditorSafe, referencedCapabilitySecrets, capabilityPath, capabilityDocumentRevision, invalidCommit} from './capabilities-settings.mjs'
import {parseCapabilityRegistry} from '@nova-audio-agent/runtime/desktop'
import { WakeWordRuntime } from './wake-word/runtime.mjs'
import {
  app,
  BrowserWindow,
  clipboard,
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
  describeMissingBlockingEnvironment,
  inspectProjectNativeHostFromResources,
  ManagedWorkspaceMaintenanceService,
} from '@nova-audio-agent/runtime/desktop'
import { randomBytes } from 'node:crypto'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import path, { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseEnv } from 'node:util'

import {
  backendLaunchSpec,
  resolveSecretConfiguration,
  SECRET_ENV_MAP,
  createReadinessListener,
  nodeRuntimeEntry,
  searchProxyUrlFromRules,
  selectedBackend,
  shutdownBackend,
  shutdownBackendBestEffort,
  watchBackendExit,
  waitForBackendReadiness,
} from './backend.mjs'
import { configureDevelopmentDockIcon } from './app-icon.mjs'
import {
  createDebugBoardRequester,
  formatMemoryBoardExport,
} from './debug-board-client.mjs'
import { installAppProtocol, loadAppWindow, registerAppScheme } from './app-protocol.mjs'
import { startWithSelectedCamera } from './camera-source.mjs'
import { createDragController } from './drag-controller.mjs'
import { executorResultDialogOptions, executorResultMenuTemplate } from './executor-result.mjs'
import { shouldOpenSettings } from './launch-command.mjs'
import { createNativeAudioManager } from './native-audio.mjs'
import {
  ensurePrivateProjectDirectories,
  repairProjectDirectory,
} from './project-directories.mjs'
import {
  createReleaseSmokeChannel,
  releaseSmokeSourceRollbackExitCode,
} from './release-smoke-channel.mjs'
import {
  createSafeStorageCodec,
  backendSettings,
  createSettingsWriter,
  saveSettingsRecovery, restoreSettingsRecovery, clearSettingsRecovery,
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
  createOrbWindowController,
  loadWindowPosition,
  saveWindowPosition,
  validDragDelta,
} from './window-position.mjs'
import {
  allowRendererNavigation,
  apiKeyWindowOpenHandler,
  boardWindowOptions,
  browserWindowOptions,
  configureWindowSecurity,
  createBootstrapAccess,
  resolveCameraPermission,
  resolveMicrophonePermission,
  settingsWindowOptions,
  setupWindowOptions,
  validateBootstrap,
} from './security.mjs'
import {probeApiKey} from './key-probe.mjs'
import {SETUP_KEYS, setupCommit} from './setup-choice.mjs'
import { validReleaseCameraResult } from '../renderer/release-camera-contract.mjs'

configureDesktopIdentity(app)
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
const developmentEnvFile = resolve(packageRoot, '../../.env')
const developmentEnv = !app.isPackaged && existsSync(developmentEnvFile)
  ? parseEnv(readFileSync(developmentEnvFile, 'utf8')) : {}
// Preserve paths and launch flags already normalized by the source launcher.
for (const name of Object.values(SECRET_ENV_MAP)) {
  if (developmentEnv[name] !== undefined) process.env[name] = developmentEnv[name]
}
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
let backendGeneration = 0
let settingsGeneration = 0
let launchGeneration = 0
let runtimeCapabilities = null
let capabilityEditorCache = null
let backendControl = null
let settingsApplyStatus = 'idle'
let settingsRestartPending = false
let settingsRecoveryAvailable = false
let visor = null
let visorAI = {state:'idle',muted:false,activated:false}
let mainWindow = null
let boardWindow = null
let clearingConversation = null
let settingsWindow = null
let setupWindow = null
let pendingSettingsCategory = null
let wakeWord = null
let tray = null
let bootstrap = null
let activeLaunchId = null
let openSettingsRequested = shouldOpenSettings(process.argv)
let nativeAudio = null
let nativeBinary = null
let projectNativeHost
let projectNativeAuthorityPresent = false
let managedWorkspaceMaintenance = null
let managedWorkspaceCapabilities = publicManagedWorkspaceCapabilities()
let quitDrain = null
let quitDrained = false
let releaseSmokeChannel = null
// Settings and debug boards are main-owned IPC surfaces. Neither relays through
// the orb renderer or shares the realtime voice socket.
const frontendUsage = createFrontendUsage({file: resolve(app.getPath('userData'), 'frontend-usage.json')})
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
  if (channel === 'nova:settings:changed') sendToWindow(setupWindow, 'nova:setup:changed', setupView())
}

// First-run projection: which pipeline is chosen, which of its keys exist, and what the last launch lacked.
function setupView() {
  const {secretsPresent: present} = settingsView()
  return Object.freeze({
    pipelineMode: currentSettings.pipelineMode,
    cascadedLlmProvider: currentSettings.cascadedLlmProvider,
    secretsPresent: Object.fromEntries(SETUP_KEYS.map(key => [key, present[key] === true])),
    missing: runtimeCapabilities?.reason === 'configuration_required' ? runtimeCapabilities.missing ?? [] : [],
    backendStatus: backendStatus.state,
  })
}

function openSetupWindow() {
  if (!activeLaunchId) return
  if (setupWindow) {
    setupWindow.show()
    setupWindow.focus()
    return
  }
  const window = new BrowserWindow(localizedWindowOptions(setupWindowOptions(preload, activeLaunchId)))
  window.webContents.setWindowOpenHandler(apiKeyWindowOpenHandler(url => shell.openExternal(url)))
  window.webContents.on('will-navigate', (event, url) => {
    if (!allowRendererNavigation(url)) event.preventDefault()
  })
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => { setupWindow = null })
  setupWindow = window
  return window.loadURL('nova://orb/setup.html')
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
// presence booleans and source labels here, never plaintext;
// `keyringAvailable` is what turns the plaintext warning line on. It answers
// for the file as it stands, not merely for today's keyring: an entry written
// while no keyring existed is still readable by anyone, so the warning stays up
// until the next save re-seals it.
function settingsView() {
  let capabilities = capabilityEditorCache?.view ?? {document: null, problems: []}
  let capabilityDiskVersion = null
  if (settingsWindow) {
    try { capabilityDiskVersion = capabilityDocumentRevision(currentSettings, process.env) }
    catch { capabilityDiskVersion = 'unreadable' }
  }
  if (settingsWindow && (capabilityEditorCache?.generation !== settingsGeneration
    || capabilityEditorCache?.diskVersion !== capabilityDiskVersion)) {
    try {
      const document = readCapabilityDocument(currentSettings, process.env)
      const secrets = decryptSecretsForSpawn(currentSettings, secretCodec)
      capabilities = readCapabilityEditor(currentSettings, capabilityEnvironment(currentSettings, secrets, process.env, document), Object.values(secrets))
    } catch { capabilities = {document: null, problems: ['file_unreadable_or_invalid_json']} }
    // Cache only this examined public projection, never decrypted values or a resolved registry.
    capabilityEditorCache = {generation: settingsGeneration, diskVersion: capabilityDiskVersion, view: capabilities}
  }
  const {secretsPresent: effectivePresence, secretSources} = resolveSecretConfiguration(
    {}, process.env, developmentEnv)
  for (const [key, present] of Object.entries(secretsPresent(currentSettings))) {
    if (present && secretSources[key] !== 'dotenv') {
      effectivePresence[key] = true
      secretSources[key] = 'settings'
    }
  }
  return {
    capabilitiesDocument: capabilities.document,
    capabilitiesRevision: capabilities.revision ?? null,
    capabilities: {...capabilities, document: undefined, revision: undefined, diskGeneration: settingsGeneration, runtime: runtimeCapabilities},
    ...publicSettings(currentSettings),
    codexStatus,
    frontendUsage: frontendUsage.snapshot(),
    visionModels: VISION_MODELS,
    backendStatus: backendStatus.state,
    backendDiagnostic: backendStatus.diagnostic,
    backendRetryInMs: backendStatus.retryInMs,
    settingsApplyStatus,
    settingsRecoveryAvailable,
    managedWorkspaces: managedWorkspacesView(),
    microphoneStatus,
    wakeWord: wakeWord?.snapshot(),
    effectivePaths: desktopConfig ? Object.freeze({
      stateRoot: desktopConfig.stateRoot,
      managedRoot: desktopConfig.managedRoot,
      workspace: desktopConfig.workspace,
    }) : null,
    secretsPresent: effectivePresence,
    secretSources,
    keyringAvailable: secretCodec.available() && !hasPlaintextSecret(currentSettings),
  }
}

async function loadMemoryBoardExport() {
  if (backendStatus.state !== 'connected' || !backendStatus.connection) {
    return {error: 'unavailable'}
  }
  const connection = backendStatus.connection
  const generation = backendGeneration
  let snapshot
  try {
    snapshot = await requestBoardSnapshot(connection, {
      board: 'memory',
      detail: 'full',
    })
  } catch (error) {
    return {error: error?.code === 'timeout' ? 'timeout' : 'unavailable'}
  }
  if (backendStatus.connection !== connection || backendGeneration !== generation) {
    return {error: 'unavailable'}
  }
  return formatMemoryBoardExport(snapshot)
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

function publishCommittedSettings() {
  if (!currentSettings.phoneConnectionEnabled) void managedPhone.stop()
  capabilityEditorCache = null
  wakeWord?.configure(currentSettings)
  settingsGeneration += 1
  sendToOrb('nova:settings:changed', orbSettings(currentSettings))
  sendToSettings('nova:settings:changed', settingsView())
}

async function rollbackSettings(refresh = true) {
  // Restore only after the child using these files is confirmed stopped. This
  // also guards retries after a previous stop failed or journal cleanup failed.
  if (settingsRecoveryAvailable && backendSupervisor) {
    await backendSupervisor.stop()
    if (backendSupervisor.status().state !== 'stopped') throw new Error('backend termination unconfirmed')
  }
  const restored = await restoreSettingsRecovery(settingsFile())
  if (restored === null) return
  currentSettings = restored
  settingsRecoveryAvailable = true
  if (refresh) await refreshDesktopConfiguration()
}

async function completeSettings() {
  await clearSettingsRecovery(settingsFile())
  settingsRecoveryAvailable = false
}

async function restartSettingsBackend(committedConfiguration) {
  const externalWorkspaceReset = committedConfiguration?.externalWorkspaceReset === true
  const recovery = externalWorkspaceReset
    ? await managedWorkspaceBackendRecovery.retry()
    : await managedWorkspaceBackendRecovery.restart()
  if (recovery.status !== (externalWorkspaceReset ? 'retried' : 'restarted')
    || backendSupervisor?.status().state !== 'connected') {
    throw new Error('backend activation unavailable')
  }
}

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

function localizedWindowOptions(options) {
  return {...options, ...(options.title ? {title: t(options.title)} : {}), webPreferences: {...options.webPreferences, additionalArguments: [`--nova-language=${currentLanguage()}`]}}
}

async function createWindow(launchId) {
  const window = new BrowserWindow(localizedWindowOptions(browserWindowOptions(preload, launchId, { opaque })))
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
  const window = new BrowserWindow(localizedWindowOptions(boardWindowOptions(preload, launchId)))
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

function openSettingsWindow(launchId, { category } = {}) {
  capabilityEditorCache = null
  if (settingsWindow) {
    settingsWindow.show()
    settingsWindow.focus()
    void refreshManagedWorkspaceCapabilities().then(() => {
      sendToSettings('nova:settings:changed', settingsFocusView(category))
    })
    return
  }
  // Held for the cold-open path, where no push can reach the panel yet.
  pendingSettingsCategory = category ?? null
  const window = new BrowserWindow(localizedWindowOptions(settingsWindowOptions(preload, launchId)))
  // Same rule as the board: webContents-level walls only. Re-binding the
  // session's permission handlers here would move the orb's microphone grant
  // onto a panel that has no business holding it.
  window.webContents.setWindowOpenHandler(apiKeyWindowOpenHandler(url => shell.openExternal(url)))
  window.webContents.on('will-navigate', (event, url) => {
    if (!allowRendererNavigation(url)) event.preventDefault()
  })
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    void cancelPhonePairing()
    settingsWindow = null
    pendingSettingsCategory = null
  })
  settingsWindow = window
  void refreshManagedWorkspaceCapabilities().then(() => {
    sendToSettings('nova:settings:changed', settingsFocusView(category))
  })
  return window.loadURL('nova://orb/settings.html')
}

async function verifySettingsRenderer() {
  const ready = await settingsWindow.webContents.executeJavaScript(`(async () => {
    if (location.href !== 'nova://orb/settings.html'
      || typeof window.novaAudioAgentDesktop?.settings?.get !== 'function'
      || document.querySelectorAll('#language option').length !== 2) return false
    const view = await window.novaAudioAgentDesktop.settings.get()
    if (!['en', 'zh-CN'].includes(view.language)) return false
    const general = document.querySelector('#category-general')
    const usage = document.querySelector('#category-usage')
    if (!general || !usage) return false
    usage.click()
    const switched = usage.getAttribute('aria-current') === 'true'
      && document.querySelector('#language-section').hidden
    general.click()
    return switched && general.getAttribute('aria-current') === 'true'
      && !document.querySelector('#language-section').hidden
  })()`)
  if (!ready) throw new Error('settings_renderer_unavailable')
  process.stdout.write('[desktop-smoke] settings_ready\n')
}

// The orb's MCP submenu asks for a category; every other caller omits it and
// gets the panel's own default. Rides the existing push rather than a new
// channel, so the preload surface stays exactly as wide as it was.
function settingsFocusView(category) {
  return category ? { ...settingsView(), focusCategory: category } : settingsView()
}

// A native menu snapshots its template at popup time and cannot show a hover
// tooltip on every platform, so the live MCP status hangs off a submenu built
// from whatever the last backend status reported. Carries no separator of its
// own: the orb template's single separator is a structural contract.
function activeMcpSubmenu(launchId) {
  return activeMcpMenuRows(runtimeCapabilities).map(row => (row.enabled
    ? { label: row.label, click: () => openSettingsWindow(launchId, { category: 'capabilities' }) }
    : { label: row.label, enabled: false }))
}

const phoneRoot = () => resolve(app.getPath('userData'), 'phone')
let phoneConfig, phonePayload, phoneImage, phoneEpoch = 0
let phoneIssuedDevices = new Set()
let phoneQueue = Promise.resolve()
const managedPhone = createManagedPhoneService({
  shutdown: child => shutdownBackend(child),
  launch: async () => {
    const entry = nodeRuntimeEntry({isPackaged: app.isPackaged, appPath: app.getAppPath(), packageRoot})
    const {initializeServerToken, loadServerConfig} = await import(pathToFileURL(resolve(dirname(entry), 'server/server-config.js')).href)
    await mkdir(phoneRoot(), {recursive: true, mode: 0o700})
    const tokenFile = resolve(phoneRoot(), 'host.token')
    try { initializeServerToken(tokenFile) } catch (error) { if (error.code !== 'EEXIST') throw error }
    const environment = {SERVER_PORT: '19876', SERVER_TOKEN_FILE: tokenFile}
    phoneConfig = loadServerConfig(environment)
    const spec = backendLaunchSpec({backend: 'node', nodeEntry: entry,
      nodeResourcesPath: app.isPackaged ? process.resourcesPath : resolve(packageRoot, 'build'),
      workspace: desktopConfig?.workspace || process.cwd(), token: phoneConfig.token,
      readyEndpoint: '127.0.0.1:1', parentEnv: process.env, settings: currentSettings,
      decryptedSecrets: decryptSecretsForSpawn(currentSettings, secretCodec), resolvedConfig: desktopConfig,
      capabilitiesDocument: readCapabilityDocument(currentSettings, process.env)})
    if (app.isQuitting || !currentSettings.phoneConnectionEnabled) throw new Error('service_unavailable')
    return utilityProcess.fork(resolve(dirname(entry), 'desktop/phone-desktop-entry.js'), [], {
      cwd: desktopConfig?.workspace || process.cwd(), stdio: 'pipe', serviceName: 'Nova iPhone Service',
      env: {...spec.env, ...environment, SERVER_MEDIA_MODE: 'relay',
        BLACKBOARD_PATH: resolve(phoneRoot(), 'blackboard.sqlite'),
        BLACKBOARD_OWNER_ID: 'phone',
        CODEX_PROJECT_STATE_ROOT: resolve(phoneRoot(), 'projects')},
    })
  },
})

async function cancelPhonePairing(invalidate = true) {
  if (invalidate) phoneEpoch++
  const config = phoneConfig, code = phonePayload?.code
  phonePayload = undefined; phoneImage = undefined
  if (config && code) await requestPhonePairing(config, {type: 'pair.cancel', code}).catch(() => {})
}

async function phoneAction(action, deviceId, epoch = phoneEpoch) {
  if (action === 'cancel') { await cancelPhonePairing(); return {state: 'idle'} }
  if (app.isQuitting) return {state: 'idle'}
  if (action === 'install') { await shell.openExternal('https://tailscale.com/download'); return {state: 'not_installed'} }
  if (action === 'login') { await shell.openPath('/Applications/Tailscale.app'); return {state: 'needs_login', service: true} }
  if (action === 'help') { await shell.openExternal('https://tailscale.com/docs/features/tailscale-serve'); return {state: 'needs_serve'} }
  if (action === 'disable') {
    await settingsWriter({phoneConnectionEnabled: false})
    await cancelPhonePairing(); await managedPhone.stop()
    return {state: 'idle'}
  }
  if (action === 'enable') await settingsWriter({phoneConnectionEnabled: true})
  if (!currentSettings.phoneConnectionEnabled) return {state: 'idle'}
  try {
    if (process.platform !== 'darwin') return {state: 'unsupported'}
    if (currentSettings.phoneServerPort && currentSettings.phoneServerTokenFile) {
      await managedPhone.stop()
      const entry = nodeRuntimeEntry({isPackaged: app.isPackaged, appPath: app.getAppPath(), packageRoot})
      const {loadServerConfig} = await import(pathToFileURL(resolve(dirname(entry), 'server/server-config.js')).href)
      const external = loadServerConfig({SERVER_PORT: String(currentSettings.phoneServerPort),
        SERVER_TOKEN_FILE: currentSettings.phoneServerTokenFile})
      if (phoneConfig?.port !== external.port || phoneConfig?.token !== external.token) await cancelPhonePairing(false)
      phoneConfig = external
    } else {
      if (!managedPhone.running && phonePayload) await cancelPhonePairing(false)
      await managedPhone.start()
    }
    const config = phoneConfig
    const network = currentSettings.phoneServerUrl ? {state: 'ready', url: currentSettings.phoneServerUrl}
      : await phoneNetwork(config.port, action === 'network')
    if (epoch !== phoneEpoch) return {state: 'idle'}
    if (network.state !== 'ready') return {...network, service: true}
    if (action === 'revoke') await requestPhonePairing(config, {type: 'pair.revoke', device_id: deviceId})
    if (phonePayload && phonePayload.server !== new URL('/client/v1', network.url).href) await cancelPhonePairing(false)
    if (epoch !== phoneEpoch) return {state: 'idle'}
    const activeEpoch = epoch
    if (action === 'refresh' || !phonePayload) {
      const before = await requestPhonePairing(config, {type: 'pair.list'})
      if (epoch !== phoneEpoch) return {state: 'idle'}
      phoneIssuedDevices = new Set(before.devices.map(device => device.id))
      const payload = await requestPhonePairing(config, {type: 'pair.create', server: network.url})
      if (activeEpoch !== phoneEpoch) {
        await requestPhonePairing(config, {type: 'pair.cancel', code: payload.code}).catch(() => {})
        return {state: 'idle'}
      }
      phonePayload = payload; phoneImage = undefined
      const script = app.isPackaged ? resolve(process.resourcesPath, 'pair-device.swift') : resolve(packageRoot, '../../runtime/scripts/pair-device.swift')
      phoneImage = await renderPhoneQr(script, payload)
      if (activeEpoch !== phoneEpoch) { phoneImage = undefined; return {state: 'idle'} }
    }
    const result = await requestPhonePairing(config, {type: 'pair.list', code: phonePayload.code})
    return {state: result.pairing_active ? 'ready' : result.devices.some(device => !phoneIssuedDevices.has(device.id)) ? 'paired' : 'invalidated', image: result.pairing_active ? phoneImage : undefined,
      host: new URL(network.url).hostname, devices: result.devices, service: true}
  } catch (error) {
    await cancelPhonePairing()
    return {state: error.message === 'qr_unavailable' ? 'qr_unavailable' : 'service_unavailable'}
  }
}

function openPairingWindow(launchId = activeLaunchId) {
  openSettingsWindow(launchId, {category: 'phone'})
}

function sleepOrb() {
  wakeWord?.sleep('bubble')
}

async function applyDesktopSettings(payload, restart = false) {
  // Plaintext keys travel from the panel into the writer, and are decrypted
  // only in main for validation or backend spawn. Public settings replies
  // contain presence flags and rejected key names, never secret values.
  if (typeof restart !== 'boolean') throw new Error('invalid restart mode')
  const pendingRestart = settingsRestartPending
  const previousSettings = currentSettings
  const recoveryPending = settingsRecoveryAvailable
  let capabilitiesChanged = false
  const applied = await applySettingsTransaction({
    deferRestart: !restart,
    needsBackendRestart: () => restart || pendingRestart || recoveryPending || capabilitiesChanged || JSON.stringify(backendSettings(previousSettings))
      !== JSON.stringify(backendSettings(currentSettings)),
    coordinator: lifecycleCoordinator,
    patch: payload,
    write: async value => {
      try {
        if (settingsRecoveryAvailable) await rollbackSettings(false)
        const commit = parseSettingsCommit(value)
        capabilitiesChanged = commit.capabilitiesDocument !== undefined
        return await settingsWriter(commit.settingsPatch ?? {}, next => {
          validatePreparedSettings(commit.settingsPatch, publicSettings(next))
          if ([resolve(settingsFile()), resolve(`${settingsFile()}.recovery`)].includes(capabilityPath(next, process.env))) throw invalidCommit('capability_settings_path_conflict')
          const document = commit.capabilitiesDocument ?? readCapabilityDocument(next, process.env)
          const secrets = decryptSecretsForSpawn(next, secretCodec)
          return prepareCapabilityCommit({settings: next, sourceSettings: currentSettings, document: commit.capabilitiesDocument, expectedRevision: commit.capabilitiesBaseRevision,
            environment: capabilityEnvironment(next, secrets, process.env, document), knownSecrets: Object.values(secrets),
            beforeWrite: async capability => {
              await saveSettingsRecovery(settingsFile(), currentSettings, capability)
              settingsRecoveryAvailable = true
            }})
        })
      } catch (error) {
        console.error(`[desktop-diagnostic] settings_save_failure type=${error.name}`)
        throw error
      }
    },
    publishCommitted: publishCommittedSettings,
    rollback: rollbackSettings,
    complete: completeSettings,
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
    restartBackend: restartSettingsBackend,
    publishStatus: publishSettingsApplyStatus,
  })
  if (applied.operationStatus === 'pending_restart') settingsRestartPending = true
  else if (applied.operationStatus === 'applied') settingsRestartPending = false
  return {...settingsView(), ...applied}
}

function visorUsage() {
  const usage = frontendUsage.snapshot()
  return {requests:usage.requests,costCny:usage.costCny,pricedReports:usage.pricedReports,
    unpricedReports:usage.unpricedReports,missingReports:usage.missingReports,
    rows:usage.rows.map(row=>({inputTokens:row.inputTokens,outputTokens:row.outputTokens}))}
}

function initializeVisor(launchId) {
  visor = createVisor({file:resolve(app.getPath('userData'),'nova-visor.json'),
    partition:`nova-orb-${launchId}`,preload:resolve(packageRoot,'src/preload/visor.cjs'),
    readAI:()=>({...visorAI,backend:backendStatus.state,model:currentSettings?.pipelineMode==='cascaded' ? currentSettings?.cascadedLlmModels?.[currentSettings?.cascadedLlmProvider] : currentSettings?.integratedModel,
      usage:visorUsage()}),
    onOrb:()=>{mainWindow?.showInactive()},
    onError:message=>console.error(`[nova-visor] ${message}`),
  })
  const settingsSender = event => settingsWindow && event.sender===settingsWindow.webContents && event.senderFrame===event.sender.mainFrame
  const visorSender = event => visor?.owns(event.sender) && event.senderFrame===event.sender.mainFrame
  ipcMain.handle('nova:visor:get',event=>{
    if (!settingsSender(event) && !visorSender(event)) throw new Error('Visor access denied')
    return visor.snapshot()
  })
  ipcMain.handle('nova:visor:configure',(event,patch)=>{
    if (!settingsSender(event) && !(visor?.controlsOwns(event.sender) && event.senderFrame===event.sender.mainFrame)) throw new Error('Visor controls denied')
    return visor.configure(patch)
  })
  ipcMain.handle('nova:visor:orb',event=>{
    if (!visor?.controlsOwns(event.sender) || event.senderFrame!==event.sender.mainFrame) throw new Error('Visor controls denied')
    visor.showOrb()
  })
  ipcMain.on('nova:visor:state',(event,value)=>{
    if (event.sender!==mainWindow?.webContents || event.senderFrame!==event.sender.mainFrame || !value || typeof value.state!=='string' || value.state.length>40) return
    visorAI={state:value.state,muted:value.muted===true,activated:value.activated===true}
  })
  sendToOrb('nova:visor:refresh')
  if (!sourceStartupSmoke) {
    visor.start()
    if (!globalShortcut.register('CommandOrControl+Shift+J',toggleVisor)) console.warn('[nova-visor] Shortcut unavailable; use Themes or tray menu')
  }
}

function toggleVisor() {
  try { visor?.toggle() } catch { dialog.showErrorBox('Nova Visor', '无法保存主题设置，请检查本地文件权限。') }
}

function showOrbMenu(launchId) {
  Menu.buildFromTemplate([
    { label: 'Nova Visor · 展开 / 收起', click: toggleVisor },
    { label: t("连接 iPhone…"), click: () => { void openPairingWindow() } },
    { label: t("记忆面板"), click: () => openMemoryBoard(launchId) },
    { label: t("设置…"), click: () => openSettingsWindow(launchId) },
    { label: t("MCP 服务"), submenu: activeMcpSubmenu(launchId) },
    { label: t("重启后台"), enabled: currentSettings !== null && !lifecycleCoordinator.busy, click: async () => {
      try {
        const result = await applyDesktopSettings({settingsPatch: {}}, true)
        if (result.operationStatus === 'applied') return
        dialog.showErrorBox(t("后台未重启"), result.operationStatus === 'busy'
          ? t("另一项操作正在进行，请稍后重试。") : t("重启失败，请打开设置检查配置。"))
      } catch {
        dialog.showErrorBox(t("后台未重启"), t("重启失败，请打开设置检查配置。"))
      }
    } },
    { type: 'separator' },
    { label: t("退出 Nova Audio Agent"), click: () => app.quit() },
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
  console.warn(`[nova-audio-agent-desktop] tray icon unreadable, falling back to a blank pixel: ${file}`)
  return nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL6WQAAAABJRU5ErkJggg==',
  )
}

function hideOrb() {
  if (wakeWord?.state === 'blocked') wakeWord.wake()
  else if (!wakeWord?.enabled || !wakeWord.sleep('manual')) mainWindow?.hide()
}

function createTray() {
  const next = new Tray(trayImage())
  next.setToolTip('Nova Audio Agent Desktop')
  next.setContextMenu(Menu.buildFromTemplate([
    { label: 'Nova Visor · 展开 / 收起', click: toggleVisor },
    { label: t("显示"), click: () => wakeWord?.wake() },
    { type: 'separator' },
    { label: t("退出"), click: () => app.quit() },
  ]))
  next.on('click', () => mainWindow?.isVisible() ? hideOrb() : wakeWord?.wake())
  return next
}

// Main-only decryption for launch, prepared-save validation, explicit probes,
// and a settings panel's public projection. Plaintext stays local to those calls;
// the panel projection caches only examined public data for its settings generation.
// Unreadable or invalid entries are diagnosed by key name and omitted.
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
  return resolveSecretConfiguration(decrypted, process.env, developmentEnv).secrets
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
      arch: process.arch,
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
  const reconciliation = prepared.maintenance === null
    ? null
    : await prepared.maintenance.reconcileExternalCleanup()
  const previousMaintenance = managedWorkspaceMaintenance
  desktopConfig = prepared.config
  codexStatus = prepared.codexStatus
  managedWorkspaceMaintenance = prepared.maintenance
  if (previousMaintenance !== null) await previousMaintenance.close().catch(() => undefined)
  await refreshManagedWorkspaceCapabilities()
  return Object.freeze({
    externalWorkspaceReset: reconciliation?.status === 'reconciled'
      && reconciliation.active_workspace_reset === true,
  })
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
    if (settingsRecoveryAvailable || !backendSupervisor) return false
    await backendSupervisor.restart()
    return backendSupervisor.status().state === 'connected'
  },
})

async function launchBackend(backendKind, smokeChannel, onExit) {
  capabilityEditorCache = null
  let launchDocument
  try { launchDocument = readCapabilityDocument(currentSettings, process.env) }
  catch { throw classifyBackendFailure('configuration_required') }
  const codingEnabled = launchDocument?.modules?.coding?.enabled !== false
  if (desktopConfig?.modelConfigurationError) throw classifyBackendFailure(desktopConfig.modelConfigurationError)
  // Coding is optional: without a usable Codex CLI, including an unfinished manual path,
  // the runtime starts with the coding module off.
  const codingUnavailable = codingEnabled
    && (Boolean(desktopConfig?.codexConfigurationError) || codexStatus.status !== 'ready')
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
    const capabilitiesDocument = launchDocument
    const diskGeneration = settingsGeneration
    const generation = ++launchGeneration
    runtimeCapabilities = null
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
      capabilitiesDocument,
      resolvedConfig: desktopConfig,
      searchProxyUrl,
    })
    if (codingUnavailable) spec.env.CODING_MODULE_ENABLED = 'false'
    const blocking = describeMissingBlockingEnvironment(spec.env)
    if (blocking && blocking.missing.length > 0) {
      runtimeCapabilities = Object.freeze({state: 'startup_failed', toolCount: null, toolBudget: 24,
        reason: 'configuration_required', pipeline: blocking.pipeline, missing: blocking.missing, generation, diskGeneration})
      if (smokeChannel === null) void openSetupWindow()
      throw classifyBackendFailure('configuration_required')
    }
    spawnedBackend = utilityProcess.fork(spec.entry, spec.argv, {
      cwd: workspace,
      env: spec.env,
      stdio: spec.stdio,
      serviceName: 'Nova Audio Agent Runtime',
    })
    backend = spawnedBackend
    backendControl?.close()
    backendControl = createBackendControl(spawnedBackend, {onUsage: report => {
      if (backend !== spawnedBackend || launchGeneration !== generation) return
      if (frontendUsage.add(generation, report) && settingsWindow) sendToSettings('nova:settings:changed', settingsView())
    }, onStatus: status => {
      if (backend !== spawnedBackend || launchGeneration !== generation) return
      diagnostic.pushCapabilityStatus(status)
      runtimeCapabilities = {...status, generation, diskGeneration, state: backendStatus.state === 'connected' ? 'running' : status.state}
      sendToSettings('nova:settings:changed', settingsView())
    }})
    spawnedBackend.stderr?.on('data', chunk => {
      const code = diagnostic.push(chunk.toString('utf8'))
      if (code) console.error(`[backend-diagnostic] ${code}`)
    })
    spawnedBackend.stdout?.on('data', chunk => {
      const code = diagnostic.push(chunk.toString('utf8'))
      if (code) console.error(`[backend-diagnostic] ${code}`)
    })
    spawnedBackend.once('exit', code => {
      const safeCode = Number.isInteger(code) ? code.toString() : 'none'
      console.error(`[backend-process-exit] code=${safeCode}`)
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
    ready = await waitForBackendReadiness(spawnedBackend, listener.readiness, diagnostic)
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
  nativeAudio?.setCaptureEpoch(wakeWord?.epoch ?? 0)
  bootstrap = Object.freeze({
    audioMode: 'inactive',
    startMuted: !app.isPackaged && process.env.DEV_START_MUTED === '1',
    nativeAvailable,
    platform: process.platform,
    opaque,
    cameraSource,
    settings: orbSettings(currentSettings),
  })
}

async function loadStartupSettings() {
  try {
    const recovered = await restoreSettingsRecovery(settingsFile())
    settingsRecoveryAvailable = recovered !== null
    currentSettings = recovered ?? await loadSettings(settingsFile(), app.getPreferredSystemLanguages())
    if (recovered) publishSettingsApplyStatus('recovery_pending')
    return true
  } catch (error) {
    if (error?.code === 'embedding_provider_invalid') throw error
    // Recovery failed and the user may still restore the previous file; do not rewrite it here.
    currentSettings = await loadSettings(settingsFile(), app.getPreferredSystemLanguages(), {initialize: false})
    settingsRecoveryAvailable = true
    publishSettingsApplyStatus('recovery_failed')
    openSettingsRequested = true
    return false
  }
}

async function startSelectedCamera(camera, backendKind, smokeChannel) {
  const settingsReady = await loadStartupSettings()
  setLanguage(currentSettings.language)
  if (settingsReady) await refreshDesktopConfiguration()
  initializeDesktopBootstrap(camera.source)
  const launchId = randomBytes(8).toString('hex')
  if (process.platform === 'linux') await wait(LINUX_WINDOW_DELAY_MS)
  mainWindow = await createWindow(launchId)
  wakeWord = new WakeWordRuntime({
    modelRoot: resolve(app.getPath('userData'), 'models/wake-word'),
    show: () => { mainWindow?.show(); mainWindow?.focus() },
    // An idle timeout no longer clears the screen: the renderer sees the same
    // 'sleeping' state arrive on nova:wake-word:changed and shrinks the window
    // to a bubble through nova:orb:dormant, so the window must stay visible for
    // there to be anything to shrink. Only an explicit hide still hides.
    hide: reason => { if (reason === 'manual') mainWindow?.hide() },
    changed: value => {
      nativeAudio?.setCaptureEpoch(value.epoch)
      sendToOrb('nova:wake-word:changed', value)
      sendToSettings('nova:settings:changed', settingsView())
    },
  })
  wakeWord.configure(currentSettings)

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
  const orbWindow = createOrbWindowController({
    getBounds: () => mainWindow.getBounds(),
    setBounds: bounds => mainWindow.setBounds(bounds),
    getZoomFactor: () => mainWindow.webContents.getZoomFactor(),
    getScaleFactor: () => screen.getDisplayNearestPoint(
      screen.getCursorScreenPoint(),
    ).scaleFactor,
    getWorkAreaForPoint: point => screen.getDisplayNearestPoint(point).workArea,
    onConfirmationPlacement: placement => sendToOrb('nova:confirmation-placement', placement),
    onBubbleLayout: layout => sendToOrb('nova:bubble-layout', layout),
  })

  // Whatever the renderer believed while the window was hidden was ignored
  // above, so the window comes back at its natural size and the renderer's next
  // render reconciles it. Registered here rather than in the wake-word `show`
  // callback because that one can fire from configure() before `orbWindow` is
  // assigned, which would throw on a const in its temporal dead zone.
  mainWindow.on('show', () => { orbWindow.setDormant(false) })

  const dragController = createDragController({
    getCursor: () => screen.getCursorScreenPoint(),
    getWindowPosition: () => {
      const [x, y] = mainWindow.getPosition()
      return { x, y }
    },
    setWindowPosition: position => mainWindow.setPosition(position.x, position.y),
    clamp: candidate => orbWindow.clampDragPosition(candidate),
  })
  mainWindow.webContents.on('zoom-changed', () => {
    setTimeout(() => orbWindow.sync(), 0)
  })
  const readBootstrap = createBootstrapAccess(bootstrap, mainWindow.webContents)
  ipcMain.handle('nova:camera:devices', async event => {
    if (!settingsWindow || event.sender !== settingsWindow.webContents || !mainWindow) throw new Error('camera devices rejected')
    const id = randomBytes(12).toString('hex')
    const renderer = mainWindow.webContents
    return new Promise(resolve => {
      const done = rows => { clearTimeout(timer); ipcMain.removeListener('nova:camera:devices-result', receive); resolve(rows) }
      const receive = (reply, value) => {
        if (reply.sender !== renderer || value?.id !== id) return
        done((Array.isArray(value.devices) ? value.devices : []).slice(0, 32).filter(item => typeof item.deviceId === 'string' && item.deviceId.length <= 256 && !/[\x00-\x1f]/u.test(item.deviceId)).map((item, index) => ({deviceId: item.deviceId, label: typeof item.label === 'string' ? item.label.slice(0, 128) : t("摄像头 {0}", index + 1)})))
      }
      const timer = setTimeout(() => done([]), 5000)
      ipcMain.on('nova:camera:devices-result', receive)
      renderer.send('nova:camera:enumerate', id)
    })
  })
  ipcMain.handle('nova:camera:permission', async event => {
    if ((!mainWindow || event.sender !== mainWindow.webContents) && (!settingsWindow || event.sender !== settingsWindow.webContents)) {
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
  ipcMain.handle('nova:phone:action', (event, action, deviceId) => {
    if (!settingsWindow || event.sender !== settingsWindow.webContents
      || !['status', 'enable', 'disable', 'network', 'refresh', 'cancel', 'install', 'help', 'login', 'revoke'].includes(action)
      || (action === 'revoke' ? typeof deviceId !== 'string' || !/^[a-f0-9-]{36}$/.test(deviceId) : deviceId !== undefined)) return {state: 'unavailable'}
    if (action === 'cancel') return phoneAction(action)
    const epoch = phoneEpoch
    const result = phoneQueue.then(() => phoneAction(action, deviceId, epoch))
    phoneQueue = result.catch(() => {})
    return result
  })
  ipcMain.on('nova:pairing:open', (event, ...args) => {
    if (settingsWindow && event.sender === settingsWindow.webContents && args.length === 0) void openPairingWindow(launchId)
  })
  ipcMain.on('nova:setup:open', event => {
    if (mainWindow && event.sender === mainWindow.webContents) void openSetupWindow()
  })
  ipcMain.handle('nova:setup:status', event => {
    if (!setupWindow || event.sender !== setupWindow.webContents) throw new Error('setup request rejected')
    return setupView()
  })
  ipcMain.handle('nova:setup:test-key', (event, key, value) => {
    if (!setupWindow || event.sender !== setupWindow.webContents) throw new Error('setup request rejected')
    if (!SETUP_KEYS.includes(key)) throw new Error('setup request rejected')
    return probeApiKey(key, value)
  })
  ipcMain.handle('nova:setup:save', async (event, choice) => {
    if (!setupWindow || event.sender !== setupWindow.webContents) throw new Error('setup request rejected')
    const result = await applyDesktopSettings(setupCommit(choice), true)
    return Object.freeze({
      saved: result?.saved !== false,
      rejectedSecrets: Array.isArray(result?.rejectedSecrets) ? result.rejectedSecrets.filter(key => SETUP_KEYS.includes(key)) : [],
    })
  })
  ipcMain.on('nova:settings:open', event => {
    if (mainWindow && event.sender === mainWindow.webContents) openSettingsWindow(launchId)
  })
  ipcMain.handle('nova:memory-board:request', async (event, detail) => {
    if (!boardWindow || event.sender !== boardWindow.webContents) {
      throw new Error('memory board request rejected')
    }
    if (backendStatus.state !== 'connected' || !backendStatus.connection) {
      return { error: 'unavailable' }
    }
    const connection = backendStatus.connection
    const generation = backendGeneration
    try {
      const snapshot = await requestBoardSnapshot(connection, {
        board: 'memory',
        detail: detail === 'full' ? 'full' : 'compact',
        ...(detail && typeof detail === 'object' ? {channel: detail.channel, before_seq: detail.before_seq, ...(detail.query === undefined ? {} : {query: detail.query})} : {}),
      })
      if (backendStatus.connection !== connection || backendGeneration !== generation) {
        return { error: 'unavailable' }
      }
      return { ...snapshot, backend_generation: generation }
    } catch (error) {
      return {error: error?.code === 'timeout' ? 'timeout' : 'unavailable'}
    }
  })
  ipcMain.handle('nova:memory-board:clear', async (event, ...args) => {
    if (!boardWindow || event.sender !== boardWindow.webContents || args.length !== 0) {
      throw new Error('memory board clear rejected')
    }
    if (clearingConversation) return clearingConversation
    const owner = backendControl, generation = backendGeneration, window = boardWindow
    if (!owner || backendStatus.state !== 'connected') return {error: 'unavailable'}
    clearingConversation = (async () => {
      try {
        const choice = await dialog.showMessageBox(window, {
          type: 'question', title: t("清除近期会话记录"),
          message: t("清除近期对话、摘要和会话中的任务记录？"),
          detail: t("后台任务会继续运行，旧任务结果不会重新写入本次会话。长期个人记忆不受影响。"),
          buttons: [t("取消"), t("清除记录")], defaultId: 0, cancelId: 0, noLink: true,
        })
        if (choice.response !== 1) return {canceled: true}
        if (owner !== backendControl || generation !== backendGeneration || window !== boardWindow || window.isDestroyed()) return {error: 'unavailable'}
        const result = await owner.request('conversation.clear', {}, {timeoutMs: 60000})
        if (owner !== backendControl || generation !== backendGeneration) return {error: 'unavailable'}
        return result?.cleared === true ? {cleared: true} : {error: 'clear_failed'}
      } catch { return {error: 'unavailable'} }
    })().finally(() => { clearingConversation = null })
    return clearingConversation
  })
  ipcMain.handle('nova:memory-board:copy-json', async event => {
    if (!boardWindow || event.sender !== boardWindow.webContents) {
      throw new Error('memory board copy rejected')
    }
    const formatted = await loadMemoryBoardExport()
    if (formatted.error) return formatted
    try {
      clipboard.writeText(formatted.body)
    } catch {
      return {error: 'unavailable'}
    }
    return {copied: true}
  })
  ipcMain.handle('nova:memory-board:export', async event => {
    if (!boardWindow || event.sender !== boardWindow.webContents) {
      throw new Error('memory board export rejected')
    }
    const formatted = await loadMemoryBoardExport()
    if (formatted.error) return formatted
    const { canceled, filePath } = await dialog.showSaveDialog(boardWindow, {
      defaultPath: `memory-board-${formatted.stamp}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (canceled || !filePath) return { canceled: true }
    const temporary = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    try {
      await writeFile(temporary, formatted.body, { encoding: 'utf8', mode: 0o600 })
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
    capabilityEditorCache = null
    // A cold open cannot be told which category to show by a push: the panel
    // subscribes only after its module evaluates, and this reply is the first
    // thing it is guaranteed to receive. Consumed once so a later plain open
    // does not inherit it.
    const category = pendingSettingsCategory
    pendingSettingsCategory = null
    return settingsFocusView(category)
  })
  ipcMain.handle('nova:codex:rescan', async event => {
    if (!settingsWindow || event.sender !== settingsWindow.webContents) {
      throw new Error('Codex rescan rejected')
    }
    if (settingsRecoveryAvailable) return {...settingsView(), operationStatus: 'recovery_pending'}
    return coordinateCodexRescan({
      coordinator: lifecycleCoordinator,
      currentConfiguration: () => Object.freeze({config: desktopConfig, codexStatus}),
      prepareConfiguration: prepareDesktopConfiguration,
      commitConfiguration: commitDesktopConfiguration,
      discardConfiguration: discardDesktopConfiguration,
      restartBackend: async () => {
        if (!backendSupervisor) return
        const recovery = await managedWorkspaceBackendRecovery.restart()
        if (recovery.status !== 'restarted'
          || backendSupervisor.status().state !== 'connected') {
          throw new Error('backend restart unavailable')
        }
      },
      recoverBackend: async () => {
        if (!backendSupervisor) return
        const recovery = await managedWorkspaceBackendRecovery.retry()
        if (recovery.status !== 'retried'
          || backendSupervisor.status().state !== 'connected') {
          throw new Error('backend recovery unavailable')
        }
      },
      view: settingsView,
    })
  })
  ipcMain.handle('nova:backend:retry', async (event, ...args) => {
    if (!settingsWindow || event.sender !== settingsWindow.webContents || args.length !== 0) {
      throw new Error('backend retry rejected')
    }
    if (settingsRecoveryAvailable) {
      const applied = await applySettingsTransaction({
        coordinator: lifecycleCoordinator, patch: null,
        write: async () => { await rollbackSettings(); return currentSettings },
        publishCommitted: publishCommittedSettings,
        prepareConfiguration: prepareDesktopConfiguration,
        commitConfiguration: commitDesktopConfiguration,
        discardConfiguration: discardDesktopConfiguration,
        restartBackend: restartSettingsBackend,
        rollback: rollbackSettings, complete: completeSettings,
        publishStatus: publishSettingsApplyStatus,
      })
      return {...settingsView(), ...applied}
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
  ipcMain.handle('nova:knowledge:action', async (event, payload) => {
    if (!settingsWindow || event.sender !== settingsWindow.webContents) throw new Error('knowledge action rejected')
    const owner = backendControl, generation = settingsGeneration
    const knowledgeActions = createKnowledgeActions({
      pick: properties => dialog.showOpenDialog(settingsWindow, {title: t("导入知识库"), properties}),
      request: (method, params) => {
        if (!owner || owner !== backendControl || generation !== settingsGeneration
          || runtimeCapabilities?.modules?.knowledge?.enabled !== true) throw new Error('knowledge unavailable')
        return owner.request(method, params, {timeoutMs: 180000})
      },
    })
    try { return await knowledgeActions.run(payload) }
    catch { return {error: 'knowledge_unavailable_or_invalid_request'} }
  })
  ipcMain.handle('nova:capabilities:probe', async (event, payload) => {
    if (!settingsWindow || event.sender !== settingsWindow.webContents) throw new Error('capability probe rejected')
    try {
      if (!payload || typeof payload !== 'object' || Object.keys(payload).sort().join(',') !== 'document,server' || typeof payload.server !== 'string') throw new Error('invalid')
      const secrets = decryptSecretsForSpawn(currentSettings, secretCodec)
      assertEditorSafe(payload.document, Object.values(secrets))
      const environment = capabilityEnvironment(currentSettings, secrets, process.env, payload.document)
      const registry = parseCapabilityRegistry(payload.document, environment)
      const config = payload.server === '$search' ? {...registry.modules.search.mcp, enabled: true, transport: 'streamable-http', tools: {}, exposeTo: {frontbrain: false, codex: false}} : registry.mcpServers[payload.server]
      if (!config || config.enabled === false) return {status: 'disabled', tools: []}
      const coordinated = await lifecycleCoordinator.run('capabilities_probe', () => publicCapabilityProbe(config, undefined, [...Object.values(secrets), ...referencedCapabilitySecrets(payload.document, environment)]))
      return coordinated.status === 'busy' ? {status: 'busy', tools: []} : coordinated.value
    } catch { return {status: 'failed', reason: 'invalid_capabilities_configuration', tools: []} }
  })
  ipcMain.on('nova:wake-word:report', (event, value) => {
    if (event.sender === mainWindow?.webContents) wakeWord?.report(value)
  })
  ipcMain.on('nova:wake-word:audio', (event, value) => {
    if (event.sender === mainWindow?.webContents) wakeWord?.accept(value)
  })
  ipcMain.on('nova:wake-word:sleep', (event, ...args) => {
    if (mainWindow && event.sender === mainWindow.webContents && args.length === 0) sleepOrb()
  })
  ipcMain.on('nova:wake-word:wake', (event, ...args) => {
    if (mainWindow && event.sender === mainWindow.webContents && args.length === 0) wakeWord?.wake()
  })
  ipcMain.on('nova:wake-word:activity', event => {
    if (event.sender === mainWindow?.webContents || event.sender === settingsWindow?.webContents) wakeWord?.activity()
  })
  ipcMain.handle('nova:wake-word:retry', event => {
    if (event.sender !== settingsWindow?.webContents) throw new Error('wake word retry rejected')
    wakeWord?.start()
    return settingsView()
  })
  ipcMain.handle('nova:settings:set', async (event, payload, restart = false) => {
    if (!settingsWindow || event.sender !== settingsWindow.webContents) {
      throw new Error('settings update rejected')
    }
    return applyDesktopSettings(payload, restart)
  })
  ipcMain.handle('nova:bootstrap', event => {
    // The renderer binds its backend-exit listener only after this reply lands, so a push
    // sent before then has nobody to reach. Riding the verdict on the very payload the
    // renderer is already awaiting removes the ordering question entirely. Read here, at
    // invoke time — the frozen startup payload predates every death it would have to report.
    return {
      ...readBootstrap(event.sender),
      wakeWord: wakeWord?.snapshot(),
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
    orbWindow.setConfirmationMode(active)
  })
  // The renderer owns the dormancy decision because it is the only side that
  // sees all three inputs at once — the derived orb state, the wake-word state,
  // and the pointer. Main owns only the resulting bounds.
  ipcMain.on('nova:orb:dormant', (event, active) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return
    if (typeof active !== 'boolean') return
    // A hidden window is gone, not resting. The renderer cannot tell the two
    // apart — it receives the same 'sleeping' wake state whether the idle timer
    // fired or the user hit the tray, and Electron keeps reporting the document
    // as visible while the window is hidden — so the side that actually called
    // hide() has to make the call. Shrinking a hidden window would only surface
    // later as a bubble that pops to full size on the next show.
    if (!mainWindow.isVisible()) return
    orbWindow.setDormant(active)
  })
  ipcMain.handle('nova:bubbles:reserve', async (event, rows, taskRows = 0) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      throw new Error('bubble bounds request rejected')
    }
    if (!Number.isInteger(rows) || rows < 0 || rows > 6 || !Number.isInteger(taskRows) || taskRows < 0 || taskRows > 5) {
      throw new Error('bubble rows rejected')
    }
    return orbWindow.reserveBubbleArea(rows, taskRows)
  })
  ipcMain.handle('nova:executor-result:open', async (event, value) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      throw new Error('executor result request rejected')
    }
    const template = executorResultMenuTemplate(value, async result => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      const response = await dialog.showMessageBox(mainWindow, executorResultDialogOptions(result))
      if (response.response === 0) openMemoryBoard(launchId)
    })
    if (template === null || template.length === 0) throw new Error('executor result rejected')
    Menu.buildFromTemplate(template).popup({window: mainWindow})
    return true
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
    const naturalPosition = orbWindow.finishDrag(position)
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
  // Secondary windows share this session's protocol. Do not expose their
  // launch id or open them until the asynchronous asset graph is registered.
  await rendererLoaded
  activeLaunchId = launchId
  initializeVisor(launchId)
  if (sourceStartupSmoke) {
    await openSettingsWindow(launchId)
    await verifySettingsRenderer()
    await Promise.all([rendererLoaded, windowShown])
    sourceSmokeStage('window_ready')
    process.stdout.write('[desktop-smoke] source_window_ready\n', () => {
      sourceSmokeStage('quit_requested')
      app.quit()
    })
    return
  }
  void rendererLoaded.then(() => {
    if (smokeChannel === null
      && backendStatus.state === 'connected' && backendStatus.connection) {
      sendToOrb('nova:backend-ready', backendStatus.connection)
    } else if (backendStatus.state !== 'starting') sendToOrb('nova:backend-exit')
  }).catch(() => {
    console.error('Nova Audio Agent Desktop renderer failed to load')
    app.quit()
  })
  tray = createTray()
  const shortcutRegistered = globalShortcut.register('CommandOrControl+Shift+Space', () => {
    mainWindow?.isVisible() ? hideOrb() : wakeWord?.wake()
  })
  // Wayland/XWayland sessions may silently refuse global shortcuts; surface
  // that instead of leaving the user to wonder why the hotkey never fires.
  if (!shortcutRegistered) {
    console.warn('[nova-audio-agent-desktop] global shortcut unavailable on this session')
  }
  if (currentSettings.phoneConnectionEnabled && !currentSettings.phoneServerTokenFile) void managedPhone.start().catch(() => {})
  for (const [key, action] of [
    ['Control+M', () => sendToOrb('nova:microphone:toggle')],
    ['Control+L', sleepOrb],
  ]) {
    if (!globalShortcut.register(key, action)) console.warn(`[nova-audio-agent-desktop] shortcut unavailable: ${key}`)
  }
  backendSupervisor = createBackendSupervisor({
    start: onExit => launchBackend(backendKind, smokeChannel, onExit),
    stopBackend: async child => {
      backendControl?.close()
      await shutdownBackend(child)
      if (backend === child) backend = null
    },
    onStatus: status => {
      const previousConnection = backendStatus.connection
      backendStatus = status
      if (status.state === 'connected' && status.connection !== previousConnection) {
        backendGeneration += 1
        if (runtimeCapabilities) runtimeCapabilities = {...runtimeCapabilities, state: 'running'}
      }
      if (runtimeCapabilities?.state === 'running' && status.state !== 'connected') runtimeCapabilities = {...runtimeCapabilities, state: 'stopped'}
      sendToSettings('nova:settings:changed', settingsView())
      sendToOrb('nova:backend-status', status)
      if (smokeChannel === null && status.state === 'connected' && status.connection) {
        sendToOrb('nova:backend-ready', status.connection)
      } else if (status.state !== 'starting' && status.state !== 'stopped') {
        sendToOrb('nova:backend-exit')
      }
    },
  })
  if (settingsReady) void managedWorkspaceBackendRecovery.start()
  if (openSettingsRequested) {
    openSettingsRequested = false
    await openSettingsWindow(launchId)
    if (smokeChannel !== null) await verifySettingsRenderer()
  }
  if (!settingsReady) {
    void dialog.showMessageBox(mainWindow, {
      type: 'error', message: t("设置恢复未完成，后端尚未启动"),
      detail: t("恢复记录已保留：{0}.recovery\n请修复该文件或配置冲突，再在设置中点击“恢复上次可用设置”。", settingsFile()),
      buttons: [t("打开配置目录"), t("稍后处理")], cancelId: 1,
    }).then(result => {
      if (result.response === 0) return shell.openPath(dirname(settingsFile()))
    }).catch(() => console.error('[desktop-diagnostic] settings_recovery_help_unavailable'))
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
  && process.env.RELEASE_CAMERA_SMOKE === RELEASE_CAMERA_SMOKE_MODE
const packagedSourceRollbackUnavailable = app.isPackaged
  && process.env.BACKEND === 'python'
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
  app.on('second-instance', (_event, argv) => {
    wakeWord?.wake()
    if (!shouldOpenSettings(argv)) return
    if (activeLaunchId === null) {
      openSettingsRequested = true
      return
    }
    openSettingsWindow(activeLaunchId)
  })
  app.whenReady().then(() => {
    configureDevelopmentDockIcon({
      app,
      platform: process.platform,
      iconFile: resolve(packageRoot, 'resources/icon-source/1024x1024.png'),
    })
    return start()
  }).catch(async error => {
    // start() can fail before the language is applied; resolve the saved preference first so the
    // one message that matters most is not stuck in the default language. Never write here.
    try { setLanguage((await loadSettings(settingsFile(), app.getPreferredSystemLanguages(), {initialize: false})).language) } catch { /* keep the default */ }
    reportStartupFailure(error, {
      showError: message => dialog.showErrorBox(t("向量服务配置不受支持"), t("{0}\n设置文件：{1}（如有 .recovery 文件也需检查）", message, settingsFile())),
    })
    app.quit()
  })
}

function sourceSmokeStage(stage) {
  if (sourceStartupSmoke) writeSync(2, `[desktop-smoke] ${stage} elapsed_ms=${Math.round(process.uptime() * 1000)}\n`)
}

app.on('will-quit', () => sourceSmokeStage('will_quit'))
app.on('quit', () => sourceSmokeStage('quit'))

app.on('before-quit', event => {
  sourceSmokeStage('before_quit')
  if (quitDrained) return
  app.isQuitting = true
  visor?.dispose()
  releaseSmokeChannel?.close()
  globalShortcut.unregisterAll()
  wakeWord?.stop()
  void nativeAudio?.deactivate()
  if (quitDrain) { event.preventDefault(); return }
  // Hold the quit while the backend drains on the stdin-EOF sentinel: a bare
  // kill would cut the session off mid-teardown, and on Windows there is no
  // graceful signal at all. Resume normal window shutdown after the drain;
  // app.exit bypasses that ordering and can hang in Windows native teardown.
  event.preventDefault()
  const backendDrain = backendSupervisor
    ? backendSupervisor.stop()
    : backend ? shutdownBackendBestEffort(backend) : Promise.resolve()
  const maintenance = managedWorkspaceMaintenance
  managedWorkspaceMaintenance = null
  const maintenanceDrain = Promise.race([Promise.resolve().then(async () => {
    sourceSmokeStage('maintenance_closing')
    await maintenance?.close()
    sourceSmokeStage('maintenance_closed')
  }), wait(3000).then(() => sourceSmokeStage('maintenance_deadline'))])
  const drain = Promise.all([backendDrain, maintenanceDrain, cancelPhonePairing().then(() => managedPhone.stop())])
  const resumeQuit = () => { quitDrained = true; sourceSmokeStage('quit_resumed'); app.quit() }
  quitDrain = drain.then(resumeQuit, resumeQuit)
})

app.on('window-all-closed', event => event.preventDefault?.())
