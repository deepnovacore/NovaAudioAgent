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

test('sleep suspension preserves task visibility, user dismissal and completion reading time', () => {
  const {banner, sent, advance} = harness()
  banner.receive(frame([task('a')]))
  banner.setSuspended(true)
  assert.equal(banner.state().visible, false)
  banner.receive(frame([task('a', 'completed')], 2))
  advance(9000)
  banner.setSuspended(false)
  assert.equal(banner.state().visible, true)
  assert.equal(banner.state().selected.phase, 'completed')
  banner.dismiss()
  banner.setSuspended(true)
  banner.setSuspended(false)
  assert.equal(banner.state().visible, false)
  assert.equal(sent.length, 0)
})


class NodeStub {
  constructor(ownerDocument = null) {
    this.ownerDocument = ownerDocument ?? this
    this.children = []
    this.hidden = false
    this.textContent = ''
    this.title = ''
    this.disabled = false
    this.dataset = {}
    this.style = {setProperty() {}}
    this.listeners = new Map()
    this.parent = null
    this.className = ''
  }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node) } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this) }
  addEventListener(type, listener) { this.listeners.set(type, listener) }
  click() { this.listeners.get('click')?.({currentTarget: this}) }
  setAttribute(name, value) { this[name] = String(value) }
  getAttribute(name) { return this[name] }
  set innerHTML(value) {
    this._innerHTML = value
    for (const selector of ['[data-title]', '[data-status]', '[data-summary]', '[data-project]', '[data-open]', '[data-stop]', '[data-error]']) {
      const node = new NodeStub(this.ownerDocument)
      node.selector = selector
      if (selector === '[data-open]' || selector === '[data-stop]') node.type = 'button'
      this.append(node)
    }
  }
  querySelector(selector) {
    return this.children.find(node => node.selector === selector) ?? null
  }
}

class DocumentStub extends NodeStub {
  createElement() { return new NodeStub(this) }
}

function taskContainer() {
  const document = new DocumentStub()
  const container = new NodeStub(document)
  const list = new NodeStub(document); list.selector = '[data-task-list]'
  const expand = new NodeStub(document); expand.selector = '[data-task-expand]'
  const hide = new NodeStub(document); hide.selector = '[data-task-hide]'
  const count = new NodeStub(document); count.selector = '[data-task-count]'
  container.append(list, expand, hide, count)
  return {container, list}
}

test('refused task cards say not executed instead of rejected', async () => {
  assert.equal(typeof module.mountTaskBanner, 'function', 'task banner renderer must be implemented')
  const {container, list} = taskContainer()
  const banner = module.mountTaskBanner({
    container,
    send: () => true,
    reserveArea: async () => ({taskHeightCss: 80, suppressed: false}),
  })
  banner.applyLayout({taskHeightCss: 80, suppressed: false})
  banner.receive(frame([task('a', 'refused')]))
  await Promise.resolve()
  const card = list.children[0]
  assert.equal(card.dataset.phase, 'refused')
  assert.equal(card.querySelector('[data-status]').textContent, '未执行')
})

test('compact task cards keep host identity and only connected active work animates', async () => {
  const {container, list} = taskContainer()
  const reservations = []
  const banner = module.mountTaskBanner({container, send: () => true,
    reserveArea: async rows => { reservations.push(rows); return {taskHeightCss: rows * 72 + 30} }})
  const longTitle = '会话标题'.repeat(20)
  banner.receive(frame([{...task('a', 'started'), project: '后台项目', title: longTitle}]))
  await Promise.resolve()
  assert.equal(list.children[0].querySelector('[data-project]').textContent, '后台项目')
  assert.equal(list.children[0].querySelector('[data-title]').textContent, longTitle)
  assert.equal(list.children[0].title, `后台项目 · ${longTitle}`)
  assert.equal(container.dataset.working, 'true')
  banner.disconnect()
  assert.equal(container.dataset.working, 'false')
  banner.receive(frame([{...task('a', 'failed'), project: '后台项目', title: longTitle}], 2))
  assert.equal(container.dataset.working, 'false')
  assert.deepEqual(reservations, [1])
  banner.dispose()
})


test('workbench can retain expired terminal rows until the authoritative snapshot evicts them',()=>{
 const {banner,advance,sent}=harness()
 banner.receive(frame([task('a','completed'),task('b','cancelled')]))
 advance(8000);advance(8000)
 assert.deepEqual(banner.state().tasks,[])
 assert.deepEqual(banner.state({includeExpired:true}).tasks.map(t=>t.work_id),['a','b'])
 banner.disconnect();banner.action('open');assert.deepEqual(sent,[])
 assert.equal(banner.state({includeExpired:true}).connected,false)
 assert.equal(banner.state({includeExpired:true}).tasks.length,2)
 banner.connect();banner.receive(frame([task('c')],1))
 assert.deepEqual(banner.state({includeExpired:true}).tasks.map(t=>t.work_id),['c'])
 banner.dispose()
})


test('workbench actions address retained work without reviving expired orb rows or selecting it',()=>{
 const {banner,advance,sent}=harness()
 banner.receive(frame([task('a','completed')]))
 advance(8000)
 assert.equal(banner.action('open','a'),true)
 assert.equal(sent[0].work_id,'a');assert.equal(sent[0].action,'open')
 assert.deepEqual(banner.state().tasks,[]);assert.equal(banner.state().visible,false);assert.equal(banner.state().selected,null)
 assert.equal(banner.state({includeExpired:true}).tasks[0].opening,true)
 banner.receiveActionResult({...sent[0],type:'executor.task_action_result',status:'failed'})
 assert.deepEqual(banner.state().tasks,[]);assert.match(banner.state({includeExpired:true}).tasks[0].error,/未成功/u)
 banner.receive(frame([task('a','completed'),task('b'),task('c')],2))
 assert.equal(banner.state().selected.work_id,'b')
 assert.equal(banner.action('cancel','c'),true);assert.equal(sent[1].work_id,'c')
 assert.equal(banner.state().selected.work_id,'b');assert.equal(banner.action('open','missing'),false)
 banner.dispose()
})

test('task backend label names only a bound non-Codex backend and leaves cancellation unchanged', () => {
  const {banner, sent} = harness()
  const resumed = {...task('a'), executor: 'codex', backend_id: 'opencode'}
  assert.equal(banner.receive(frame([resumed])), true)
  assert.equal(module.taskBackendLabel(banner.state().selected), 'OpenCode')
  assert.equal(module.taskBackendLabel(task('legacy')), null)
  banner.action('cancel')
  assert.equal(sent[0].executor, 'codex')
  assert.equal(sent[0].work_id, 'a')
  assert.equal(banner.receive(frame([{...resumed, backend_id: '/private/config'}], 2)), false)
})

