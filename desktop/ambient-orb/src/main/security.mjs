const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const TOKEN_PATTERN = /^[a-f0-9]{32}$/

export function validateBootstrap(value) {
  if (!value || typeof value !== 'object') {
    throw new Error('desktop bootstrap is invalid')
  }
  if (typeof value.token !== 'string' || !TOKEN_PATTERN.test(value.token)) {
    throw new Error('desktop bootstrap requires a 128-bit hexadecimal token')
  }
  let endpoint
  try {
    endpoint = new URL(value.endpoint)
  } catch {
    throw new Error('desktop endpoint is invalid')
  }
  if (endpoint.protocol !== 'ws:' || !LOOPBACK_HOSTS.has(endpoint.hostname)) {
    throw new Error('desktop endpoint must be a loopback websocket')
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('desktop endpoint must not contain credentials, query, or fragment')
  }
  if (!endpoint.port) throw new Error('desktop endpoint must include a port')
  return Object.freeze({ endpoint: endpoint.href, token: value.token })
}

export function browserWindowOptions(preload, launchId, { opaque = false } = {}) {
  if (typeof preload !== 'string' || !preload) throw new Error('preload is required')
  if (!/^[A-Za-z0-9_-]+$/.test(launchId)) throw new Error('launch id is invalid')
  return {
    width: 184,
    height: 184,
    minWidth: 184,
    minHeight: 184,
    maxWidth: 184,
    maxHeight: 184,
    frame: false,
    // Compositors without a working transparent-visuals path (opted into via
    // NOVA_ORB_OPAQUE) get a solid plate instead of a broken/black surface.
    transparent: !opaque,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: opaque ? '#141005' : '#00000000',
    show: false,
    skipTaskbar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      autoplayPolicy: 'no-user-gesture-required',
      partition: `nova-orb-${launchId}`,
      preload,
    },
  }
}

// Both secondary windows are ordinary framed panels that share the orb's
// session partition (and therefore its preload) while keeping every isolation
// wall the orb itself runs behind. Only their size and title differ.
function panelWindowOptions(preload, launchId, panel) {
  if (typeof preload !== 'string' || !preload) throw new Error('preload is required')
  if (!/^[A-Za-z0-9_-]+$/.test(launchId)) throw new Error('launch id is invalid')
  return {
    ...panel,
    frame: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      partition: `nova-orb-${launchId}`,
      preload,
    },
  }
}

export function boardWindowOptions(preload, launchId) {
  return panelWindowOptions(preload, launchId, {
    width: 480,
    height: 620,
    minWidth: 360,
    minHeight: 400,
  })
}

export function settingsWindowOptions(preload, launchId) {
  return panelWindowOptions(preload, launchId, {
    width: 420,
    height: 560,
    minWidth: 380,
    minHeight: 420,
    title: '设置',
  })
}

export function createBootstrapAccess(bootstrap, renderer) {
  if (!bootstrap || !renderer) throw new Error('desktop bootstrap unavailable')
  return requester => {
    if (requester !== renderer) throw new Error('desktop bootstrap unavailable')
    return bootstrap
  }
}

export function allowRendererNavigation(url) {
  try {
    return new URL(url).protocol === 'nova:'
  } catch {
    return false
  }
}

function isExactOrbOrigin(origin) {
  return origin === 'nova://orb' || origin === 'nova://orb/'
}

export function allowsOrbMediaCheck({ contents, renderer, permission, origin, mediaType }) {
  if (contents !== renderer || permission !== 'media') return false
  if (origin === '') return mediaType === 'audio' || mediaType === 'video'
  return isExactOrbOrigin(origin)
}

export function allowsOrbMediaRequest({
  contents,
  renderer,
  permission,
  origin,
  mediaTypes,
}) {
  if (!allowsOrbMediaCheck({ contents, renderer, permission, origin })) return false
  if (!Array.isArray(mediaTypes) || mediaTypes.length === 0) return false
  const unique = new Set(mediaTypes)
  return unique.size === mediaTypes.length
    && [...unique].every(type => type === 'audio' || type === 'video')
}

export function configureWindowSecurity(window) {
  const renderer = window.webContents
  renderer.setWindowOpenHandler(() => ({ action: 'deny' }))
  renderer.on('will-navigate', (event, url) => {
    if (!allowRendererNavigation(url)) event.preventDefault()
  })
  const electronSession = renderer.session
  electronSession.setPermissionCheckHandler((contents, permission, origin, details) => (
    allowsOrbMediaCheck({
      contents,
      renderer,
      permission,
      origin,
      mediaType: details?.mediaType,
    })
  ))
  electronSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(allowsOrbMediaRequest({
      contents,
      renderer,
      permission,
      origin: details?.securityOrigin,
      mediaTypes: details?.mediaTypes,
    }))
  })
}

export async function resolveCameraPermission(source, { platform, systemPreferences }) {
  if (source !== 'local' || platform !== 'darwin') {
    return Object.freeze({ status: 'unknown' })
  }
  let status = systemPreferences.getMediaAccessStatus('camera')
  if (status === 'not-determined') {
    await systemPreferences.askForMediaAccess('camera')
    status = systemPreferences.getMediaAccessStatus('camera')
  }
  return Object.freeze({
    status: status === 'granted' || status === 'denied' || status === 'restricted'
      ? status
      : 'unknown',
  })
}

export async function resolveMicrophonePermission({ platform, systemPreferences }) {
  // Chromium's getUserMedia owns the prompt on Windows and Linux. macOS also
  // requires the application-level TCC grant, which Electron exposes here.
  if (platform !== 'darwin') return Object.freeze({ status: 'unknown' })
  let status = systemPreferences.getMediaAccessStatus('microphone')
  if (status === 'not-determined') {
    await systemPreferences.askForMediaAccess('microphone')
    status = systemPreferences.getMediaAccessStatus('microphone')
  }
  return Object.freeze({
    status: status === 'granted' || status === 'denied' || status === 'restricted'
      ? status
      : 'unknown',
  })
}
