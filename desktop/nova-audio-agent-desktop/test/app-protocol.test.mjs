import assert from 'node:assert/strict'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import {
  CAMERA_SOURCE_PATH,
  CAMERA_SOURCE_URL,
  buildRendererAssetGraph,
  installAppProtocol,
  loadAppWindow,
  registerAppScheme,
} from '../src/main/app-protocol.mjs'

const ACTUAL_RENDERER_ROOT = resolve(import.meta.dirname, '../src/renderer')

test('app scheme enables media streaming for the file-backed camera', () => {
  const registrations = []
  registerAppScheme({
    registerSchemesAsPrivileged(value) { registrations.push(value) },
  })

  assert.deepEqual(registrations, [[{
    scheme: 'nova',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  }]])
})

test('renderer protocol serves the complete reachable static import graph and nothing arbitrary', async () => {
  const rendererFiles = await buildRendererAssetGraph(ACTUAL_RENDERER_ROOT)
  assert.ok(Object.isFrozen(rendererFiles))
  assert.ok(rendererFiles.includes('/camera.mjs'), 'index.mjs camera import is reachable')
  assert.ok(rendererFiles.includes('/orb-visual.mjs'), 'index.mjs orb visual import is reachable')

  let handler
  const fetched = []
  installAppProtocol({ handle: (_scheme, next) => { handler = next } }, {
    rendererRoot: ACTUAL_RENDERER_ROOT,
    rendererFiles,
    fetchFile: file => {
      fetched.push(file)
      return new Response(file)
    },
  })

  for (const path of rendererFiles) {
    const response = await handler(new Request(`nova://orb${path}`))
    assert.equal(response.status, 200, path)
    assert.equal(await response.text(), resolve(ACTUAL_RENDERER_ROOT, path.slice(1)), path)
  }
  assert.equal(fetched.length, rendererFiles.length)
  assert.equal((await handler(new Request('nova://orb/future-arbitrary.mjs'))).status, 404)
})

test('renderer graph follows future module re-exports and stylesheet imports without hand listing', async () => {
  const sources = new Map([
    ['/index.html', '<link href="./index.css"><script src="./index.mjs"></script>'],
    ['/capture-worklet.mjs', "export { capture } from './audio.mjs'"],
    ['/memory-board.html', '<link href="./memory-board.css">'],
    ['/settings.html', '<link href="./settings.css"><script src="./settings.mjs"></script>'],
    ['/index.css', '@import "./theme.css";'],
    ['/index.mjs', "import './camera.mjs'; export { visual } from './orb-visual.mjs'"],
    ['/audio.mjs', 'export const capture = true'],
    ['/memory-board.css', ''],
    ['/settings.css', ''],
    ['/settings.mjs', ''],
    ['/theme.css', ''],
    ['/camera.mjs', ''],
    ['/orb-visual.mjs', 'export const visual = true'],
  ])

  const graph = await buildRendererAssetGraph('/unused-renderer-root', file => {
    const route = `/${basename(file)}`
    assert.ok(sources.has(route), `unexpected graph read: ${route}`)
    return sources.get(route)
  })

  assert.deepEqual(graph, [...sources.keys()].sort())
})

test('session-local app protocol serves only allowlisted renderer files', async () => {
  let scheme
  let handler
  const fetched = []
  const targetProtocol = {
    handle(nextScheme, nextHandler) {
      scheme = nextScheme
      handler = nextHandler
    },
  }

  const rendererRoot = '/tmp/orb-renderer'
  installAppProtocol(targetProtocol, {
    rendererRoot,
    rendererFiles: ['/index.html', '/memory-board.html', '/drag-gesture.mjs'],
    fetchFile: async file => {
      fetched.push(file)
      return new Response('ok')
    },
  })

  assert.equal(scheme, 'nova')
  const allowed = await handler(new Request('nova://orb/index.html'))
  assert.equal(await allowed.text(), 'ok')
  const board = await handler(new Request('nova://orb/memory-board.html'))
  assert.equal(await board.text(), 'ok')
  assert.deepEqual(fetched, [
    resolve(rendererRoot, 'index.html'),
    resolve(rendererRoot, 'memory-board.html'),
  ])

  const dragGesture = await handler(new Request('nova://orb/drag-gesture.mjs'))
  assert.equal(await dragGesture.text(), 'ok')
  assert.deepEqual(fetched, [
    resolve(rendererRoot, 'index.html'),
    resolve(rendererRoot, 'memory-board.html'),
    resolve(rendererRoot, 'drag-gesture.mjs'),
  ])

  const rejected = await handler(new Request('nova://orb/unknown-module.mjs'))
  assert.equal(rejected.status, 404)
  assert.deepEqual(fetched, [
    resolve(rendererRoot, 'index.html'),
    resolve(rendererRoot, 'memory-board.html'),
    resolve(rendererRoot, 'drag-gesture.mjs'),
  ])
})

test('session-local app protocol serves the settings panel assets', async () => {
  let handler
  const fetched = []
  installAppProtocol({ handle: (_scheme, next) => { handler = next } }, {
    rendererRoot: '/tmp/orb-renderer',
    rendererFiles: ['/settings.html', '/settings.css', '/settings.mjs'],
    fetchFile: async file => {
      fetched.push(file)
      return new Response('ok')
    },
  })

  for (const path of ['settings.html', 'settings.css', 'settings.mjs']) {
    const response = await handler(new Request(`nova://orb/${path}`))
    assert.equal(await response.text(), 'ok')
  }
  assert.deepEqual(fetched, [
    resolve('/tmp/orb-renderer', 'settings.html'),
    resolve('/tmp/orb-renderer', 'settings.css'),
    resolve('/tmp/orb-renderer', 'settings.mjs'),
  ])

  const rejected = await handler(new Request('nova://orb/settings.json'))
  assert.equal(rejected.status, 404)
  const wrongHost = await handler(new Request('nova://elsewhere/settings.html'))
  assert.equal(wrongHost.status, 404)
  assert.equal(fetched.length, 3, 'a rejected path never reaches the filesystem')
})

test('session-local app protocol registers before window navigation', async () => {
  const events = []
  const targetProtocol = {
    handle(scheme) {
      events.push(`handle:${scheme}`)
    },
  }
  const window = {
    webContents: {
      session: { protocol: targetProtocol },
    },
    async loadURL(url) {
      events.push(`load:${url}`)
    },
  }

  await loadAppWindow(window, {
    rendererRoot: '/tmp/orb-renderer',
    rendererFiles: ['/index.html'],
    fetchFile: async () => new Response('ok'),
  })

  assert.deepEqual(events, [
    'handle:nova',
    'load:nova://orb/index.html',
  ])
})

test('camera route catches wrapping the range response or losing request headers', async () => {
  let handler
  const assetCalls = []
  const cameraCalls = []
  const expected = new Response('range bytes', {
    status: 206,
    headers: {
      'content-range': 'bytes 4-7/10',
      'accept-ranges': 'bytes',
      'content-type': 'video/mp4',
    },
  })
  installAppProtocol({ handle: (_scheme, next) => { handler = next } }, {
    rendererRoot: '/tmp/orb-renderer',
    rendererFiles: [],
    fetchFile: file => {
      assetCalls.push(file)
      return new Response('asset')
    },
    cameraFile: '/canonical/cat-sofa.mp4',
    fetchCameraFile: (url, init) => {
      cameraCalls.push({ url, init })
      return expected
    },
  })

  assert.equal(CAMERA_SOURCE_PATH, '/camera-source')
  assert.equal(CAMERA_SOURCE_URL, 'nova://orb/camera-source')
  const headers = new Headers({
    range: 'bytes=4-7',
    'if-range': 'tag',
    'x-request-sentinel': 'preserve-complete-collection',
  })
  const request = new Request(CAMERA_SOURCE_URL, { method: 'GET', headers })
  const response = await handler(request)

  assert.equal(response, expected, 'the exact net.fetch Response is returned')
  assert.equal(response.status, 206)
  assert.equal(response.headers.get('content-range'), 'bytes 4-7/10')
  assert.equal(response.headers.get('accept-ranges'), 'bytes')
  assert.equal(await response.text(), 'range bytes')
  assert.deepEqual(assetCalls, [])
  assert.equal(cameraCalls.length, 1)
  assert.equal(cameraCalls[0].url, pathToFileURL('/canonical/cat-sofa.mp4').href)
  assert.equal(cameraCalls[0].init.headers, request.headers, 'observable request headers are forwarded')
})

test('camera route catches alternate paths, authority, metadata, methods, and missing config', async () => {
  const scenarios = [
    ['wrong host', 'GET', 'nova://elsewhere/camera-source', true, 404],
    ['lookalike host', 'GET', 'nova://orb.evil/camera-source', true, 404],
    ['trailing slash', 'GET', 'nova://orb/camera-source/', true, 404],
    ['encoded slash', 'GET', 'nova://orb/camera-source%2f', true, 404],
    ['encoded dot', 'GET', 'nova://orb/camera-source%2e', true, 404],
    ['asset pretending to be media', 'GET', 'nova://orb/index.html/camera-source', true, 404],
    ['query', 'GET', 'nova://orb/camera-source?path=secret', true, 404],
    ['fragment', 'GET', 'nova://orb/camera-source#secret', true, 404],
    ['head', 'HEAD', 'nova://orb/camera-source', true, 405],
    ['post', 'POST', 'nova://orb/camera-source', true, 405],
    ['missing file config', 'GET', 'nova://orb/camera-source', false, 404],
  ]

  for (const [name, method, url, configured, status] of scenarios) {
    let handler
    const assetCalls = []
    const cameraCalls = []
    installAppProtocol({ handle: (_scheme, next) => { handler = next } }, {
      rendererRoot: '/tmp/orb-renderer',
      rendererFiles: [],
      fetchFile: file => {
        assetCalls.push(file)
        return new Response('asset')
      },
      ...(configured ? { cameraFile: '/canonical/cat-sofa.mp4' } : {}),
      fetchCameraFile: (...args) => {
        cameraCalls.push(args)
        return new Response('camera')
      },
    })

    const response = await handler(new Request(url, { method, headers: new Headers() }))
    assert.equal(response.status, status, name)
    assert.deepEqual(assetCalls, [], `${name}: renderer fetch remains untouched`)
    assert.deepEqual(cameraCalls, [], `${name}: camera fetch remains untouched`)
    assert.doesNotMatch(await response.text(), /canonical|cat-sofa|secret/u, name)
  }
})

test('WHATWG Request canonicalization makes dot aliases the canonical fixed camera route', async () => {
  let handler
  const cameraCalls = []
  installAppProtocol({ handle: (_scheme, next) => { handler = next } }, {
    rendererRoot: '/tmp/orb-renderer',
    rendererFiles: [],
    fetchFile: () => new Response('asset'),
    cameraFile: '/canonical/cat-sofa.mp4',
    fetchCameraFile: (...args) => {
      cameraCalls.push(args)
      return new Response('camera')
    },
  })

  for (const raw of [
    'nova://orb/../camera-source',
    'nova://orb/%2e%2e/camera-source',
    'nova://orb/camera-source/%2e%2e/camera-source',
  ]) {
    const request = new Request(raw)
    assert.equal(request.url, CAMERA_SOURCE_URL, raw)
    const response = await handler(request)
    assert.equal(response.status, 200, raw)
  }
  assert.equal(cameraCalls.length, 3)
})
