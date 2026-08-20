import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const CAMERA_SOURCE_PATH = '/camera-source'
export const CAMERA_SOURCE_URL = 'nova://orb/camera-source'

const allowedRendererPaths = new Set([
  '/index.html',
  '/index.css',
  '/index.mjs',
  '/audio.mjs',
  '/drag-gesture.mjs',
  '/capture-worklet.mjs',
  '/state.mjs',
  '/memory-board.html',
  '/memory-board.css',
  '/memory-board.mjs',
  '/settings.html',
  '/settings.css',
  '/settings.mjs',
])

export function installAppProtocol(targetProtocol, {
  rendererRoot,
  fetchFile,
  cameraFile,
  fetchCameraFile,
}) {
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
  installAppProtocol(window.webContents.session.protocol, options)
  await window.loadURL('nova://orb/index.html')
}
