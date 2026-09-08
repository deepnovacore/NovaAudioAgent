import assert from 'node:assert/strict'
import test from 'node:test'

const module = await import('../src/renderer/task-banner.mjs').catch(() => ({}))
const task = (id, phase = 'working', ts = 1) => ({work_id: id, executor: 'codex', project: id === 'a' ? 'Nova' : 'Other', title: `任务 ${id}`, phase, summary: '正在验证任务结果', ts})
const frame = (tasks, revision = 1) => ({type: 'executor.tasks', revision, active_project: 'Nova', tasks})
function harness() {
  assert.equal(typeof module.createTaskBannerController, 'function', 'task banner controller must be implemented')
  let now = 0
  const timers = new Map(), sent = []
  let timerId = 0
  const banner = module.createTaskBannerController({
    send: value => { sent.push(value); return true },
    now: () => now,
    schedule: (fn, ms) => { const id = ++timerId; timers.set(id, {fn, at: now + ms}); return id },
    cancel: id => timers.delete(id),
  })
  banner.connect()
  return {banner, sent, advance(ms) {
    now += ms
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn() }
  }}
}
test('defaults to current project then preserves manual selection across new progress', () => {
  const {banner} = harness()
  banner.receive(frame([task('b'), task('a')]))
  assert.equal(banner.state().selected.work_id, 'a')
  banner.select('b')
  banner.receive(frame([task('a', 'working', 2), task('b')], 2))
  assert.equal(banner.state().selected.work_id, 'b')
  assert.equal(banner.receive(frame([task('a')], 1)), false)
})
test('hiding does not cancel; ordinary updates stay hidden and new work can show again', () => {
  const {banner, sent} = harness()
  banner.receive(frame([task('a')]))
  banner.dismiss()
  assert.equal(banner.state().visible, false)
  assert.equal(sent.length, 0)
  banner.receive(frame([task('a', 'working', 2)], 2))
  assert.equal(banner.state().visible, false)
  banner.receive(frame([task('a'), task('b')], 3))
  assert.equal(banner.state().visible, true)
})
test('cancel carries exact identity and stays cancelling until terminal, not merely the reply', () => {
  const {banner, sent} = harness()
  banner.receive(frame([task('a'), task('b')]))
  banner.action('cancel')
  banner.action('cancel')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].work_id, 'a')
  assert.equal(sent[0].executor, 'codex')
  banner.receiveActionResult({...sent[0], type: 'executor.task_action_result', status: 'cancelling'})
  assert.equal(banner.state().cancelling, true)
  banner.receive(frame([task('a', 'cancelled', 2), task('b')], 2))
  assert.equal(banner.state().cancelling, false)
  assert.equal(banner.state().selected.phase, 'cancelled')
})
test('terminal timer pauses while reading; failures do not auto-dismiss', () => {
  const {banner, advance} = harness()
  banner.receive(frame([task('a', 'completed')]))
  advance(3000); banner.pause(); advance(9000)
  assert.equal(banner.state().visible, true)
  banner.resume(); advance(4999)
  assert.equal(banner.state().visible, true)
  advance(1)
  assert.equal(banner.state().visible, false)
  banner.receive(frame([task('b', 'failed')], 2)); advance(100000)
  assert.equal(banner.state().visible, true)
})
test('each completed task gets its own dismissal timer when selected automatically', () => {
  const {banner, advance} = harness()
  banner.receive(frame([task('a', 'completed'), task('b', 'completed')]))
  advance(8000)
  assert.equal(banner.state().selected.work_id, 'b')
  advance(8000)
  assert.equal(banner.state().visible, false)
})
test('disconnect preserves last state, blocks actions, and reconnect accepts a fresh revision', () => {
  const {banner, sent} = harness()
  banner.receive(frame([task('a')], 20))
  banner.disconnect()
  banner.action('open')
  assert.equal(sent.length, 0)
  assert.equal(banner.state().selected.work_id, 'a')
  assert.equal(banner.state().connected, false)
  banner.connect()
  assert.equal(banner.state().connected, false, 'await authoritative snapshot before enabling controls')
  banner.receive(frame([task('b')], 1))
  assert.equal(banner.state().connected, true)
  assert.equal(banner.state().selected.work_id, 'b')
})
test('rejects malformed snapshots, cross-work replies, and reports action timeouts', () => {
  const {banner, sent, advance} = harness()
  assert.equal(banner.receive(frame([task('a'), task('a')])), false)
  assert.equal(banner.receive(frame([{...task('a'), title: '<script>\n'}])), false)
  banner.receive(frame([task('a')]))
  banner.action('open')
  assert.equal(banner.receiveActionResult({...sent[0], type: 'executor.task_action_result', work_id: 'b', status: 'opened'}), false)
  advance(10000)
  assert.match(banner.state().error, /超时/)
})
