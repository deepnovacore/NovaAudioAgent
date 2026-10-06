import {t} from '../renderer/locale.mjs'
import { DORMANT_ORB_WINDOW_SIZE } from './window-position.mjs'

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
    width: 160,
    height: 160,
    // The floor is the dormant bubble, not the natural orb: Electron clamps
    // programmatic setBounds to these constraints too, not just user-driven
    // resizes, so leaving them at the natural 160 would silently pin the
    // window open when window-position.mjs shrinks it to rest.
    minWidth: DORMANT_ORB_WINDOW_SIZE.width,
    minHeight: DORMANT_ORB_WINDOW_SIZE.height,
    frame: false,
    // Let an unfocused macOS orb receive both clicks of a double-click.
    acceptFirstMouse: true,
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
      // Hidden wake-word capture and its heartbeat must keep running.
      backgroundThrottling: false,
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
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    title: t("记忆面板"),
  })
}

export function settingsWindowOptions(preload, launchId) {
  return panelWindowOptions(preload, launchId, {
    width: 1140,
    height: 930,
    minWidth: 620,
    minHeight: 520,
    title: t("设置"),
  })
}

export function setupWindowOptions(preload, launchId) {
  return panelWindowOptions(preload, launchId, {
    width: 720,
    height: 640,
    minWidth: 520,
    minHeight: 520,
    title: t("开始使用 Nova"),
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

export function configureWindowSecurity(window, recordingRenderer = () => null) {
  const renderer = window.webContents
  renderer.setWindowOpenHandler(() => ({ action: 'deny' }))
  renderer.on('will-navigate', (event, url) => {
    if (!allowRendererNavigation(url)) event.preventDefault()
  })
  const recordingAudio = (contents, permission, origin, type) => Boolean(contents) && contents === recordingRenderer()
    && permission === 'media' && (origin === '' || isExactOrbOrigin(origin)) && type === 'audio'
  const electronSession = renderer.session
  electronSession.setPermissionCheckHandler((contents, permission, origin, details) => (
    allowsOrbMediaCheck({
      contents,
      renderer,
      permission,
      origin,
      mediaType: details?.mediaType,
    }) || recordingAudio(contents, permission, origin, details?.mediaType)
  ))
  electronSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(allowsOrbMediaRequest({
      contents,
      renderer,
      permission,
      origin: details?.securityOrigin,
      mediaTypes: details?.mediaTypes,
    }) || (details?.mediaTypes?.length === 1 && recordingAudio(contents, permission, details.securityOrigin, details.mediaTypes[0])))
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

const API_KEY_PAGES = new Set(['https://bailian.console.aliyun.com/?apiKey=1&tab=model',
  'https://platform.openai.com/api-keys',
  'https://platform.deepseek.com/api_keys',
  'https://platform.stepfun.com/interface-key',
  'https://console.volcengine.com/ark/apiKey',
  'https://console.volcengine.com/speech/new/setting/apikeys',
  'https://app.tavily.com/',
  'https://openrouter.ai/settings/keys'])

export function apiKeyWindowOpenHandler(openExternal) {
  return ({url}) => {
    if (API_KEY_PAGES.has(url)) void openExternal(url).catch(() => {})
    return {action: 'deny'}
  }
}

export function feishuVerificationUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('授权链接无效')
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !['feishu.cn', 'larksuite.com'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) throw new Error('授权链接无效')
  return url.href
}

export function connectorAuthorizationUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('authorization request rejected')
  const url = new URL(value)
  if (url.origin !== 'https://connect.composio.dev' || url.username || url.password || !url.pathname.startsWith('/link/')) throw new Error('authorization request rejected')
  return url.href
}

export function newsArticleUrl(value) {
 if(typeof value!=='string'||value.length>4096)throw new Error('资讯链接无效')
 const url=new URL(value)
 if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.hostname==='localhost'||url.hostname.endsWith('.local')||url.hostname.includes(':')||/^\d+(?:\.\d+){3}$/u.test(url.hostname))throw new Error('资讯链接无效')
 return url.href
}
