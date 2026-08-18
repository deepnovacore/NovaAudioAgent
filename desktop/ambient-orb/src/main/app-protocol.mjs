import { resolve } from 'node:path'

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

export function installAppProtocol(targetProtocol, { rendererRoot, fetchFile }) {
  targetProtocol.handle('nova', request => {
    const url = new URL(request.url)
    if (url.hostname !== 'orb' || !allowedRendererPaths.has(url.pathname)) {
      return new Response('Not found', { status: 404 })
    }
    return fetchFile(resolve(rendererRoot, url.pathname.slice(1)))
  })
}

export async function loadAppWindow(window, options) {
  installAppProtocol(window.webContents.session.protocol, options)
  await window.loadURL('nova://orb/index.html')
}
