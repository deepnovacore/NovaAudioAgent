import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'

import {
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
