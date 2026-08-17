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

export function boardWindowOptions(preload, launchId) {
  if (typeof preload !== 'string' || !preload) throw new Error('preload is required')
  if (!/^[A-Za-z0-9_-]+$/.test(launchId)) throw new Error('launch id is invalid')
  return {
    width: 480,
    height: 620,
    minWidth: 360,
    minHeight: 400,
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
