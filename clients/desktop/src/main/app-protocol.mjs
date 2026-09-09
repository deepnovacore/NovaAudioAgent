import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { dirname, join, normalize } from 'node:path/posix'
import { pathToFileURL } from 'node:url'

export const CAMERA_SOURCE_PATH = '/camera-source'
export const CAMERA_SOURCE_URL = 'nova://orb/camera-source'

export function registerAppScheme(targetProtocol) {
  targetProtocol.registerSchemesAsPrivileged([{
    scheme: 'nova',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  }])
}

const RENDERER_ENTRY_PATHS = Object.freeze([
  '/index.html',
  '/capture-worklet.mjs',
  '/memory-board.html',
  '/settings.html',
])

function relativeRendererRoute(from, specifier) {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    throw new Error('renderer asset graph contains a non-relative dependency')
  }
  if (specifier.includes('\\') || specifier.includes('?') || specifier.includes('#')) {
    throw new Error('renderer asset graph contains an unsupported dependency')
  }
  const route = normalize(join(dirname(from), specifier))
  if (!route.startsWith('/') || route.includes('/../')) {
    throw new Error('renderer asset graph escapes its root')
  }
  if (!/\.(?:css|html|mjs)$/u.test(route)) {
    throw new Error('renderer asset graph contains an unsupported file type')
  }
  return route
}

function staticDependencies(route, source) {
  const specifiers = []
  if (route.endsWith('.html')) {
    for (const match of source.matchAll(/\b(?:src|href)=["'](\.[^"']+)["']/gu)) {
      specifiers.push(match[1])
    }
  } else if (route.endsWith('.mjs')) {
    for (const pattern of [
      /\bimport\s+["']([^"']+)["']/gu,
      /\bimport\s+[^"'`;]*?\sfrom\s+["']([^"']+)["']/gu,
      /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/gu,
    ]) {
      for (const match of source.matchAll(pattern)) specifiers.push(match[1])
    }
  } else if (route.endsWith('.css')) {
    for (const match of source.matchAll(/@import\s+["']([^"']+)["']/gu)) {
      specifiers.push(match[1])
    }
  }
  return specifiers.map(specifier => relativeRendererRoute(route, specifier))
}

export async function buildRendererAssetGraph(
  rendererRoot,
  readText = file => readFile(file, 'utf8'),
) {
  const pending = [...RENDERER_ENTRY_PATHS]
  const visited = new Set()
  while (pending.length > 0) {
    const route = pending.shift()
    if (visited.has(route)) continue
    visited.add(route)
    const source = await readText(resolve(rendererRoot, route.slice(1)))
    for (const dependency of staticDependencies(route, source)) {
      if (!visited.has(dependency)) pending.push(dependency)
    }
  }
  return Object.freeze([...visited].sort())
}

export function installAppProtocol(targetProtocol, {
  rendererRoot,
  rendererFiles,
  fetchFile,
  cameraFile,
  fetchCameraFile,
}) {
  const allowedRendererPaths = new Set(rendererFiles)
  targetProtocol.handle('nova', request => {
    const url = new URL(request.url)
    if (request.url === CAMERA_SOURCE_URL) {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 })
      if (typeof cameraFile !== 'string' || typeof fetchCameraFile !== 'function') {
        return new Response('Not found', { status: 404 })
      }
      return fetchCameraFile(pathToFileURL(cameraFile).href, { headers: request.headers })
    }
    const exactRendererUrl = request.url === `nova://orb${url.pathname}`
    if (
      !exactRendererUrl
      || url.hostname !== 'orb'
      || url.pathname === CAMERA_SOURCE_PATH
      || !allowedRendererPaths.has(url.pathname)
    ) {
      return new Response('Not found', { status: 404 })
    }
    return fetchFile(resolve(rendererRoot, url.pathname.slice(1)))
  })
}

export async function loadAppWindow(window, options) {
  const rendererFiles = options.rendererFiles
    ?? await buildRendererAssetGraph(options.rendererRoot, options.readRendererText)
  installAppProtocol(window.webContents.session.protocol, { ...options, rendererFiles })
  await window.loadURL('nova://orb/index.html')
}
