import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import {
  CAMERA_SOURCE_PATH,
  CAMERA_SOURCE_URL,
  installAppProtocol,
  loadAppWindow,
} from '../src/main/app-protocol.mjs'

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
    fetchFile: async file => {
      fetched.push(file)
      return new Response('ok')
    },
  })

  assert.equal(scheme, 'nova')
  const allowed = await handler({ url: 'nova://orb/index.html' })
  assert.equal(await allowed.text(), 'ok')
  const board = await handler({ url: 'nova://orb/memory-board.html' })
  assert.equal(await board.text(), 'ok')
  assert.deepEqual(fetched, [
    resolve(rendererRoot, 'index.html'),
    resolve(rendererRoot, 'memory-board.html'),
  ])

  const dragGesture = await handler({ url: 'nova://orb/drag-gesture.mjs' })
  assert.equal(await dragGesture.text(), 'ok')
  assert.deepEqual(fetched, [
    resolve(rendererRoot, 'index.html'),
    resolve(rendererRoot, 'memory-board.html'),
    resolve(rendererRoot, 'drag-gesture.mjs'),
  ])

  const rejected = await handler({ url: 'nova://orb/unknown-module.mjs' })
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
    fetchFile: async file => {
      fetched.push(file)
      return new Response('ok')
    },
  })

  for (const path of ['settings.html', 'settings.css', 'settings.mjs']) {
    const response = await handler({ url: `nova://orb/${path}` })
    assert.equal(await response.text(), 'ok')
  }
  assert.deepEqual(fetched, [
    resolve('/tmp/orb-renderer', 'settings.html'),
    resolve('/tmp/orb-renderer', 'settings.css'),
    resolve('/tmp/orb-renderer', 'settings.mjs'),
  ])

  const rejected = await handler({ url: 'nova://orb/settings.json' })
  assert.equal(rejected.status, 404)
  const wrongHost = await handler({ url: 'nova://elsewhere/settings.html' })
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
  const response = await handler({ method: 'GET', url: CAMERA_SOURCE_URL, headers })

  assert.equal(response, expected, 'the exact net.fetch Response is returned')
  assert.equal(response.status, 206)
  assert.equal(response.headers.get('content-range'), 'bytes 4-7/10')
  assert.equal(response.headers.get('accept-ranges'), 'bytes')
  assert.equal(await response.text(), 'range bytes')
  assert.deepEqual(assetCalls, [])
  assert.equal(cameraCalls.length, 1)
  assert.equal(cameraCalls[0].url, pathToFileURL('/canonical/cat-sofa.mp4').href)
  assert.equal(cameraCalls[0].init.headers, headers, 'incoming immutable headers are forwarded')
})

test('camera route catches alternate paths, authority, metadata, methods, and missing config', async () => {
  const scenarios = [
    ['wrong host', 'GET', 'nova://elsewhere/camera-source', true, 404],
    ['lookalike host', 'GET', 'nova://orb.evil/camera-source', true, 404],
    ['trailing slash', 'GET', 'nova://orb/camera-source/', true, 404],
    ['encoded slash', 'GET', 'nova://orb/camera-source%2f', true, 404],
    ['encoded dot', 'GET', 'nova://orb/camera-source%2e', true, 404],
    ['encoded traversal', 'GET', 'nova://orb/camera-source/%2e%2e/index.html', true, 404],
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

    const response = await handler({ method, url, headers: new Headers() })
    assert.equal(response.status, status, name)
    assert.deepEqual(assetCalls, [], `${name}: renderer fetch remains untouched`)
    assert.deepEqual(cameraCalls, [], `${name}: camera fetch remains untouched`)
    assert.doesNotMatch(await response.text(), /canonical|cat-sofa|secret/u, name)
  }
})

test('camera route remains disjoint from the renderer asset allowlist', async () => {
  let handler
  const fetched = []
  installAppProtocol({ handle: (_scheme, next) => { handler = next } }, {
    rendererRoot: '/tmp/orb-renderer',
    fetchFile: file => {
      fetched.push(file)
      return new Response('asset')
    },
  })

  for (const url of [
    'nova://orb/camera-source',
    'nova://orb/../camera-source',
    'nova://orb/%2e%2e/camera-source',
    'nova://orb/%2f/camera-source',
  ]) {
    const response = await handler({ method: 'GET', url, headers: new Headers() })
    assert.equal(response.status, 404, url)
  }
  assert.deepEqual(fetched, [])
})
