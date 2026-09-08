import assert from 'node:assert/strict'
import test from 'node:test'

import {
  bubbleWindowLayout,
  createOrbWindowController,
} from '../src/main/window-position.mjs'
import {
  createProgressBubbleController,
  parseLastResultFrame,
  parseProgressFrame,
} from '../src/renderer/bubbles.mjs'

const workArea = {x: 0, y: 0, width: 1440, height: 900}
const normalBounds = {x: 600, y: 300, width: 160, height: 160}

test('reserves enough native area for a banner and three independent alerts', () => {
  const layout = bubbleWindowLayout({normalBounds, rows: 6, zoomFactor: 1, scaleFactor: 2, workArea})
  assert.equal(layout.suppressed, false)
  assert.equal(layout.bubbleHeight, 336)
  assert.throws(() => bubbleWindowLayout({normalBounds, rows: 7, zoomFactor: 1, scaleFactor: 2, workArea}))
})

test('reserves bubble bounds above the orb in Electron DIPs without Retina double scaling', () => {
  const oneX = bubbleWindowLayout({
    normalBounds, rows: 3, zoomFactor: 1, scaleFactor: 1, workArea,
  })
  const retina = bubbleWindowLayout({
    normalBounds, rows: 3, zoomFactor: 1, scaleFactor: 2, workArea,
  })

  assert.equal(oneX.bubblePlacement, 'above')
  assert.deepEqual(retina.bounds, oneX.bounds)
  assert.deepEqual(retina.renderedOrbScreenCenter, {x: 680, y: 380})
  assert.equal(retina.bounds.width, 360)
  assert.equal(retina.bounds.height, 328)
})

test('flips bubbles below near the top and keeps their wide surface on the selected display', () => {
  const layout = bubbleWindowLayout({
    normalBounds: {x: -1900, y: 24, width: 160, height: 160},
    rows: 1,
    zoomFactor: 1.5,
    scaleFactor: 2,
    workArea: {x: -1920, y: 24, width: 1920, height: 1056},
  })

  assert.equal(layout.bubblePlacement, 'below')
  assert.equal(layout.bubbleAlignment, 'left')
  assert.ok(layout.bounds.x >= -1920)
  assert.ok(layout.bounds.x + layout.bounds.width <= 0)
  assert.ok(layout.bounds.y >= 24)
  assert.ok(layout.bounds.y + layout.bounds.height <= 1080)
  assert.deepEqual(layout.renderedOrbScreenCenter, {x: -1820, y: 144})
})

test('suppresses bubbles when a confirmation banner leaves no opposite-side room', () => {
  const layout = bubbleWindowLayout({
    normalBounds: {x: 600, y: 0, width: 160, height: 160},
    rows: 3,
    zoomFactor: 1,
    scaleFactor: 1,
    workArea,
    confirmationActive: true,
  })

  assert.equal(layout.suppressed, true)
  assert.equal(layout.bubblePlacement, 'above')
})

test('one controller uses confirmation bounds first, reserves bubbles, and restores the natural orb', () => {
  let bounds = {...normalBounds}
  const browserWindow = {
    getBounds: () => bounds,
    setBounds: next => { bounds = next },
  }
  const controller = createOrbWindowController({
    getBounds: () => browserWindow.getBounds(),
    setBounds: next => browserWindow.setBounds(next),
    getZoomFactor: () => 1,
    getScaleFactor: () => 2,
    getWorkAreaForPoint: () => workArea,
    onConfirmationPlacement: () => {},
  })

  const combined = controller.reserveBubbleArea(6)
  assert.equal(combined.suppressed, false)
  assert.equal(bounds.height, 496)
  const bubble = controller.reserveBubbleArea(2)
  assert.equal(bubble.suppressed, false)
  assert.equal(bounds.height, 272)
  controller.setConfirmationMode(true)
  assert.equal(controller.bubblesSuppressed, false)
  controller.reserveBubbleArea(0)
  controller.setConfirmationMode(false)
  assert.deepEqual(bounds, normalBounds)
})

test('parses only bounded sanitized executor progress frames', () => {
  assert.deepEqual(parseProgressFrame({
    type: 'executor.progress', delegate_id: 'delegate-7', executor: 'codex',
    phase: 'working', summary: '正在安装依赖', level: 'detail', ts: 12,
  }), {
    delegateId: 'delegate-7', summary: '正在安装依赖', level: 'detail', ts: 12,
  })
  assert.equal(parseProgressFrame({
    type: 'executor.progress', delegate_id: 'delegate-7', executor: 'codex',
    phase: 'working', summary: '/private/token', level: 'detail', ts: 12,
  }), null)
  assert.equal(parseProgressFrame({
    type: 'executor.progress', delegate_id: 'delegate-7', executor: 'codex',
    phase: 'working', summary: 'still working', level: 'detail', ts: -1,
  }), null)
  assert.equal(parseProgressFrame({
    type: 'executor.progress', delegate_id: 'delegate-7', executor: 'codex',
    phase: 'working', summary: 'x'.repeat(241), level: 'detail', ts: 12,
  }), null)
  assert.equal(parseProgressFrame({
    type: 'executor.progress', delegate_id: 'delegate-7', executor: 'codex',
    phase: 'surprise', summary: 'still working', level: 'detail', ts: 12,
  }), null)
  assert.equal(parseProgressFrame({
    type: 'executor.progress', delegate_id: 'delegate-7', executor: 'codex',
    phase: 'working', summary: 'x'.repeat(181), level: 'detail', ts: 12,
  }), null)
})

test('parses terminal result frames and permits a null reset', () => {
  assert.deepEqual(parseLastResultFrame({
    type: 'executor.result', work_id: 'delegate-7',
    result: {
      delegate_id: 'delegate-7', executor: 'codex', outcome: 'ok', summary: '已完成',
      started_at: 1, ended_at: 2, changed_files: 3, ignored: 'unknown fields drop',
    },
  }), {
    delegateId: 'delegate-7', executor: 'codex', outcome: 'ok', summary: '已完成',
    startedAt: 1, endedAt: 2, changedFiles: 3,
  })
  assert.equal(parseLastResultFrame({type: 'executor.result', work_id: 'delegate-7', result: null}), null)
  assert.equal(parseLastResultFrame({
    type: 'executor.result', work_id: 'delegate-7',
    result: {...{delegate_id: 'delegate-7', executor: 'codex', outcome: 'ok', summary: 'ok', started_at: 2, ended_at: 1, changed_files: null}},
  }), undefined)
})

test('caps at three newest bubbles and pauses the milestone expiry while hovered', async () => {
  let nextTimer = 0
  const timers = new Map()
  const rendered = []
  const bubbles = createProgressBubbleController({
    reserveBubbleArea: async () => ({suppressed: false}),
    render: items => rendered.push(items.map(item => item.summary)),
    schedule: (callback, ms) => {
      const id = ++nextTimer
      timers.set(id, {callback, ms})
      return id
    },
    cancel: id => timers.delete(id),
    now: () => 0,
  })

  await bubbles.push({summary: 'one', level: 'detail', ts: 1})
  await bubbles.push({summary: 'two', level: 'detail', ts: 2})
  await bubbles.push({summary: 'three', level: 'milestone', ts: 3})
  await bubbles.push({summary: 'four', level: 'detail', ts: 4})
  assert.deepEqual(bubbles.items.map(item => item.summary), ['four', 'three', 'two'])
  assert.deepEqual(rendered.at(-1), ['four', 'three', 'two'])

  bubbles.pause('three')
  for (const timer of [...timers.values()]) {
    if (timer.ms === 12_000) timer.callback()
  }
  assert.deepEqual(bubbles.items.map(item => item.summary), ['four', 'three', 'two'])
  bubbles.resume('three')
  const milestone = [...timers.values()].find(timer => timer.ms === 12_000)
  milestone.callback()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(bubbles.items.map(item => item.summary), ['four', 'two'])
})

test('uses the delegate id to distinguish coincident progress while dropping an exact replay', async () => {
  const bubbles = createProgressBubbleController({
    reserveBubbleArea: async () => ({suppressed: false}),
    render: () => {},
    schedule: () => 0,
    cancel: () => {},
  })
  const first = {delegateId: 'delegate-a', summary: 'working', level: 'detail', ts: 7}

  assert.equal(await bubbles.push(first), true)
  assert.equal(await bubbles.push({...first, delegateId: 'delegate-b', key: 'ignored-collision'}), true)
  assert.equal(await bubbles.push(first), false)
  assert.deepEqual(bubbles.items.map(item => item.key), [
    'delegate-b:7:working', 'delegate-a:7:working',
  ])
})

test('drops visible bubbles when the native reservation becomes suppressed', async () => {
  let suppressed = false
  const bubbles = createProgressBubbleController({
    reserveBubbleArea: async () => ({suppressed}),
    render: () => {},
    schedule: () => 0,
    cancel: () => {},
  })

  await bubbles.push({summary: 'working', level: 'detail', ts: 1})
  assert.equal(bubbles.items.length, 1)
  suppressed = true
  assert.equal(await bubbles.push({summary: 'blocked by approval', level: 'milestone', ts: 2}), false)
  assert.equal(bubbles.items.length, 0)
})

test('serializes concurrent pushes before each native reservation commits', async () => {
  const pending = []
  const bubbles = createProgressBubbleController({
    reserveBubbleArea: () => new Promise(resolve => pending.push(resolve)),
    render: () => {},
    schedule: () => 0,
    cancel: () => {},
  })

  const pushes = [
    bubbles.push({summary: 'one', level: 'detail', ts: 1}),
    bubbles.push({summary: 'two', level: 'detail', ts: 2}),
    bubbles.push({summary: 'three', level: 'detail', ts: 3}),
  ]
  await Promise.resolve()
  assert.equal(pending.length, 1)
  pending.shift()({suppressed: false})
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(pending.length, 1)
  pending.shift()({suppressed: false})
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(pending.length, 1)
  pending.shift()({suppressed: false})
  await Promise.all(pushes)
  assert.deepEqual(bubbles.items.map(item => item.summary), ['three', 'two', 'one'])
})

test('a clear invalidates a pending reservation before it can render a stale bubble', async () => {
  const pending = []
  const rendered = []
  const bubbles = createProgressBubbleController({
    reserveBubbleArea: () => new Promise(resolve => pending.push(resolve)),
    render: items => rendered.push(items.map(item => item.summary)),
    schedule: () => 0,
    cancel: () => {},
  })

  const push = bubbles.push({summary: 'stale', level: 'detail', ts: 1})
  await Promise.resolve()
  const clear = bubbles.clear()
  assert.equal(pending.length, 1)
  pending.shift()({suppressed: false})
  await push
  assert.deepEqual(bubbles.items, [])
  assert.deepEqual(rendered, [[]])
  assert.equal(pending.length, 1)
  pending.shift()({suppressed: false})
  await clear
})

test('turns a rejected native reservation into a dropped bubble', async () => {
  const bubbles = createProgressBubbleController({
    reserveBubbleArea: async () => { throw new Error('IPC disconnected') },
    render: () => {},
  })

  assert.equal(await bubbles.push({summary: 'working', level: 'detail', ts: 1}), false)
  assert.deepEqual(bubbles.items, [])
})

test('resumes a hovered milestone for only its remaining lifetime', async () => {
  let now = 0
  const timers = []
  const bubbles = createProgressBubbleController({
    reserveBubbleArea: async () => ({suppressed: false}),
    render: () => {},
    now: () => now,
    schedule: (_callback, ms) => {
      timers.push(ms)
      return timers.length
    },
    cancel: () => {},
  })

  await bubbles.push({summary: 'milestone', level: 'milestone', ts: 1})
  now = 2_000
  bubbles.pause('milestone')
  now = 7_000
  bubbles.resume('milestone')
  assert.deepEqual(timers, [12_000, 10_000])
})

test('result wire requires a keyed reset and refuses cross-work identity, malformed metadata and oversize frames', () => {
  const result = {delegate_id: 'a', executor: 'codex', outcome: 'ok', summary: 'done', started_at: 1, ended_at: 2, changed_files: 0, project: '<alpha>', title: '<img src=x>'}
  const frame = {type: 'executor.result', work_id: 'a', result}
  assert.equal(parseLastResultFrame(frame).title, '<img src=x>')
  assert.equal(parseLastResultFrame({...frame, work_id: 'b'}), undefined)
  assert.equal(parseLastResultFrame({type: 'executor.result', result: null}), undefined)
  assert.equal(parseLastResultFrame({...frame, result: {...result, project: {html: 'x'}}}), undefined)
  assert.equal(parseLastResultFrame({...frame, extra: 'x'.repeat(16 * 1024)}), undefined)
})
