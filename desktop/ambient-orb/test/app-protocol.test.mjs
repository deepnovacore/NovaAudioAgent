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
