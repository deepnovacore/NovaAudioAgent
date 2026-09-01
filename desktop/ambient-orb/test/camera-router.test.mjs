import assert from 'node:assert/strict'
import test from 'node:test'

import {RendererSocketRouter} from '../src/renderer/camera.mjs'
import {
  CodexApprovalDecisionController,
  parseCodexApprovalMessage,
} from '../src/renderer/confirmation-controls.mjs'

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

test('held browser PCM cannot block playback controls on the generic tail', async () => {
  const pcmResume = deferred()
  const controlsHandled = deferred()
  const order = []
  const router = new RendererSocketRouter({
    cameraController: {enqueue() {}, closeGeneration() {}},
    handleGeneric: async event => {
      if (typeof event.data !== 'string') {
        order.push('pcm-start')
        await pcmResume.promise
        order.push('pcm-done')
        return
      }
      order.push(JSON.parse(event.data).type)
      if (order.includes('playback.clear') && order.includes('playback.terminal')) {
        controlsHandled.resolve()
      }
    },
  })
  const connection = router.connect(new FakeSocket('split-playback'))
  try {
    connection.onMessage({data: new Uint8Array([0, 1]).buffer})
    connection.onMessage({data: '{"type":"playback.clear"}'})
    connection.onMessage({data: '{"type":"playback.terminal"}'})

    await settleWithin(controlsHandled.promise, 'controls behind held browser PCM')
    assert.deepEqual(order, ['pcm-start', 'playback.clear', 'playback.terminal'])
  } finally {
    pcmResume.resolve()
    router.dispose()
  }
})

test('suspended browser PCM cannot block a Codex approval render and exact decision', async () => {
  const pcmResume = deferred()
  const decisionSent = deferred()
  const order = []
  const socket = new FakeSocket('codex-approval-cross-path')
  const decision = new CodexApprovalDecisionController({
    send: frame => {
      socket.send(JSON.stringify(frame))
      order.push('decision-sent')
      decisionSent.resolve()
      return true
    },
  })
  const router = new RendererSocketRouter({
    cameraController: {enqueue() {}, closeGeneration() {}},
    handleGeneric: async event => {
      if (typeof event.data !== 'string') {
        order.push('pcm-start')
        await pcmResume.promise
        order.push('pcm-done')
        return
      }
      const approval = parseCodexApprovalMessage(JSON.parse(event.data))
      assert.notEqual(approval, null)
      order.push('approval-rendered')
      decision.sync({
        pending: approval.pending_approval,
        approvalId: approval.pending_approval_id,
        busy: approval.pending_approval_busy,
      })
      assert.equal(decision.decide(true), true)
    },
  })
  const connection = router.connect(socket)
  try {
    connection.onMessage({data: new Uint8Array([0, 1]).buffer})
    connection.onMessage({data: JSON.stringify({
      type: 'codex.approval',
      pending_approval: true,
      pending_approval_busy: false,
      pending_approval_id: 'approval-cross-path',
      kind: 'file_change',
      local_detail: {
        kind: 'file_change',
        changes: [{change: 'update', path: 'src/a.ts', move_path: null}],
      },
      operation_summary: 'Codex 请求修改 1 个工作区文件。',
      expires_in_seconds: 60,
    })})

    await settleWithin(decisionSent.promise, 'Codex control behind suspended PCM')
    assert.deepEqual(order, ['pcm-start', 'approval-rendered', 'decision-sent'])
    assert.deepEqual(socket.sent, [JSON.stringify({
      type: 'codex.approval_decision',
      approval_id: 'approval-cross-path',
      approved: true,
    })])
  } finally {
    pcmResume.resolve()
    router.dispose()
  }
})

test('browser PCM frames stay FIFO on their independent playback tail', async () => {
  const firstResume = deferred()
  const secondHandled = deferred()
  const order = []
  let frame = 0
  const router = new RendererSocketRouter({
    cameraController: {enqueue() {}, closeGeneration() {}},
    handleGeneric: async event => {
      assert.notEqual(typeof event.data, 'string')
      frame += 1
      order.push(`pcm-${frame}-start`)
      if (frame === 1) {
        await firstResume.promise
        order.push('pcm-1-done')
      } else {
        order.push('pcm-2-done')
        secondHandled.resolve()
      }
    },
  })
  const connection = router.connect(new FakeSocket('ordered-playback'))
  try {
    connection.onMessage({data: new Uint8Array([0, 1]).buffer})
    connection.onMessage({data: new Uint8Array([2, 3]).buffer})
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(order, ['pcm-1-start'])
    firstResume.resolve()
    await settleWithin(secondHandled.promise, 'second ordered PCM frame')
    assert.deepEqual(order, ['pcm-1-start', 'pcm-1-done', 'pcm-2-start', 'pcm-2-done'])
  } finally {
    firstResume.resolve()
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
