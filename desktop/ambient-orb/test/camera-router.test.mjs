import assert from 'node:assert/strict'
import test from 'node:test'

import {RendererSocketRouter} from '../src/renderer/camera.mjs'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return {promise, resolve, reject}
}

async function settleWithin(promise, name, timeoutMs = 500) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} did not settle`)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

class FakeSocket {
  constructor(name) {
    this.name = name
    this.readyState = 1
    this.sent = []
  }

  send(value) { this.sent.push(value) }
}

function cameraRequest(id) {
  return JSON.stringify({type: 'camera.capture', request_id: id, source: 'local'})
}

function permissionRequest(id) {
  return JSON.stringify({type: 'camera.permission', request_id: id})
}

test('an open camera permission prompt cannot block playback and control traffic', async () => {
  const permission = deferred()
  const genericDone = deferred()
  const seen = []
  const router = new RendererSocketRouter({
    cameraController: {enqueue() {}, closeGeneration() {}},
    handleGeneric: async event => {
      if (typeof event.data === 'string' && JSON.parse(event.data).type === 'camera.permission') {
        seen.push('permission-start')
        await permission.promise
        seen.push('permission-done')
        return
      }
      seen.push(typeof event.data === 'string' ? JSON.parse(event.data).type : 'pcm')
      if (seen.includes('playback.clear') && seen.includes('pcm')) genericDone.resolve()
    },
  })
  const connection = router.connect(new FakeSocket('permission'))
  try {
    connection.onMessage({data: permissionRequest('camera-permission')})
    connection.onMessage({data: JSON.stringify({
      type: 'playback.clear', utterance_id: 'u', generation_epoch: 1,
    })})
    connection.onMessage({data: new Uint8Array([0, 1]).buffer})

    await settleWithin(genericDone.promise, 'generic traffic behind permission prompt')
    assert.deepEqual(seen, ['permission-start', 'playback.clear', 'pcm'])
  } finally {
    permission.resolve()
    router.dispose()
  }
})

test('held camera enqueue never blocks generic traffic or the next camera request', async () => {
  const held = deferred()
  const secondCamera = deferred()
  const cameraCalls = []
  const generic = {clears: 0, pcm: 0, captions: [], alerts: 0}
  const controller = {
    enqueue(raw, delivery) {
      cameraCalls.push({raw, delivery})
      if (cameraCalls.length === 1) return held.promise
      secondCamera.resolve()
      return undefined
    },
    closeGeneration() {},
  }
  const genericDone = deferred()
  const router = new RendererSocketRouter({
    cameraController: controller,
    handleGeneric: async event => {
      if (typeof event.data !== 'string') generic.pcm += 1
      else {
        const message = JSON.parse(event.data)
        if (message.type === 'playback.clear') generic.clears += 1
        else if (message.type === 'caption') generic.captions.push(message.text)
        else if (message.type === 'playback.alert') generic.alerts += 1
      }
      if (generic.clears && generic.pcm && generic.captions.length && generic.alerts) {
        genericDone.resolve()
      }
    },
  })
  const connection = router.connect(new FakeSocket('A'))
  try {
    connection.onMessage({data: cameraRequest('camera-held')})
    connection.onMessage({data: cameraRequest('camera-second')})
    connection.onMessage({data: JSON.stringify({
      type: 'playback.clear', utterance_id: 'u', generation_epoch: 1,
    })})
    connection.onMessage({data: new Uint8Array([0, 1]).buffer})
    connection.onMessage({data: JSON.stringify({type: 'caption', role: 'assistant', text: 'still live'})})
    connection.onMessage({data: JSON.stringify({type: 'playback.alert'})})

    await settleWithin(secondCamera.promise, 'second camera enqueue')
    await settleWithin(genericDone.promise, 'generic renderer traffic')
    assert.equal(cameraCalls.length, 2)
    assert.deepEqual(generic, {clears: 1, pcm: 1, captions: ['still live'], alerts: 1})
  } finally {
    held.resolve()
    router.dispose()
  }
})

test('malformed camera intent is contained while ordinary playback remains generic', async () => {
  const cameraCalls = []
  const genericCalls = []
  let genericErrors = 0
  const controller = {
    enqueue(raw) { cameraCalls.push(raw) },
    closeGeneration() {},
  }
  const router = new RendererSocketRouter({
    cameraController: controller,
    handleGeneric: event => { genericCalls.push(event.data) },
    onGenericError: () => { genericErrors += 1 },
  })
  const connection = router.connect(new FakeSocket('camera-intent'))
  const attacks = [
    '{"type":"camera.capture","type":"playback.clear","request_id":"camera-a","source":"local"}',
    '{"type":"playback.clear","type":"camera.capture","request_id":"camera-b","source":"local"}',
    '{"type":"camera.capture","request_id":"camera-extra","source":"local","extra":true}',
    '{"type":"camera.capture","request_id":"camera-missing"}',
    '{"type":"camera.capture","request_id":"camera-float","source":"file","position_ms":1.0}',
    '{"type":"camera.capture","request_id":"camera-truncated"',
  ]
  for (const raw of attacks) connection.onMessage({data: raw})
  const playback = '{"type":"playback.clear","utterance_id":"u","generation_epoch":1}'
  connection.onMessage({data: playback})
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(cameraCalls, attacks)
  assert.deepEqual(genericCalls, [playback])
  assert.equal(genericErrors, 0)
  router.dispose()
})

test('a camera throw neither poisons camera scheduling nor marks generic playback failed', async () => {
  const secondCamera = deferred()
  let cameraCalls = 0
  let genericCalls = 0
  let genericErrors = 0
  const router = new RendererSocketRouter({
    cameraController: {
      enqueue() {
        cameraCalls += 1
        if (cameraCalls === 1) throw new Error('camera failure sentinel')
        secondCamera.resolve()
      },
      closeGeneration() {},
    },
    handleGeneric: () => { genericCalls += 1 },
    onGenericError: () => { genericErrors += 1 },
  })
  const connection = router.connect(new FakeSocket('failure'))
  connection.onMessage({data: cameraRequest('camera-throws')})
  connection.onMessage({data: '{"type":"caption","role":"assistant","text":"ok"}'})
  connection.onMessage({data: cameraRequest('camera-after-throw')})
  await settleWithin(secondCamera.promise, 'camera tail recovery')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cameraCalls, 2)
  assert.equal(genericCalls, 1)
  assert.equal(genericErrors, 0)
  router.dispose()
})

test('generic traffic stays FIFO while async playback handling is held', async () => {
  const alertClear = deferred()
  const pcmHandled = deferred()
  const order = []
  const router = new RendererSocketRouter({
    cameraController: {enqueue() {}, closeGeneration() {}},
    handleGeneric: async event => {
      if (typeof event.data === 'string') {
        order.push('alert-start')
        await alertClear.promise
        order.push('alert-done')
      } else {
        order.push('pcm')
        pcmHandled.resolve()
      }
    },
  })
  const connection = router.connect(new FakeSocket('ordered-generic'))
  try {
    connection.onMessage({data: '{"type":"playback.alert"}'})
    connection.onMessage({data: new Uint8Array([0, 1]).buffer})
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(order, ['alert-start'])
    alertClear.resolve()
    await settleWithin(pcmHandled.promise, 'replacement PCM after alert clear')
    assert.deepEqual(order, ['alert-start', 'alert-done', 'pcm'])
  } finally {
    alertClear.resolve()
    router.dispose()
  }
})

test('late close from A releases A camera but cannot mutate current B UI or playback', async () => {
  const closedGenerations = []
  const cameraCalls = []
  const axes = {connected: true, error: '', caption: 'B caption'}
  let playbackStops = 0
  let currentCloseCalls = 0
  let genericCalls = 0
  const router = new RendererSocketRouter({
    cameraController: {
      enqueue(raw, delivery) { cameraCalls.push({raw, delivery}) },
      closeGeneration(generation) { closedGenerations.push(generation) },
    },
    handleGeneric: () => { genericCalls += 1 },
    onCurrentClose: () => {
      currentCloseCalls += 1
      axes.connected = false
      axes.caption = ''
      playbackStops += 1
    },
  })
  const socketA = new FakeSocket('A')
  const connectionA = router.connect(socketA)
  connectionA.onMessage({data: cameraRequest('camera-A')})
  await new Promise(resolve => setImmediate(resolve))

  const socketB = new FakeSocket('B')
  const connectionB = router.connect(socketB)
  assert.equal(connectionA.isCurrent(), false)
  assert.equal(connectionB.isCurrent(), true)
  socketA.readyState = 3
  assert.equal(connectionA.close(), false)
  assert.deepEqual(axes, {connected: true, error: '', caption: 'B caption'})
  assert.equal(playbackStops, 0)
  assert.equal(currentCloseCalls, 0)

  connectionB.onMessage({data: '{"type":"caption","role":"assistant","text":"B still works"}'})
  connectionB.onMessage({data: cameraRequest('camera-B')})
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(genericCalls, 1)
  assert.equal(cameraCalls.length, 2)
  assert.equal(cameraCalls[0].delivery.isCurrent(), false)
  assert.equal(cameraCalls[1].delivery.isCurrent(), true)
  assert.ok(closedGenerations.includes(connectionA.generation))

  socketB.readyState = 3
  assert.equal(connectionB.close(), true)
  assert.deepEqual(axes, {connected: false, error: '', caption: ''})
  assert.equal(playbackStops, 1)
  assert.equal(currentCloseCalls, 1)
  router.dispose()
})
