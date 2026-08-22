import assert from 'node:assert/strict'
import test from 'node:test'

import {
  boardTabForKey,
  createGraphTabController,
  parseWorkspaceGraphBoardPayload,
  renderWorkspaceGraphBoard,
} from '../src/renderer/workspace-graph-board.mjs'

function payload(overrides = {}) {
  return {
    type: 'workspace_graph.board',
    request_id: 'graph-1',
    availability: 'ready',
    publication_revision: 8,
    omitted: {logical_workspaces: 0, workspace_instances: 0, relations: 0},
    logical_workspaces: [
      {logical_workspace_id: 'logical-a', display_name: 'Nova'},
      {logical_workspace_id: 'logical-b', display_name: 'Runtime'},
    ],
    workspace_instances: [{
      instance_id: 'instance-a', logical_workspace_id: 'logical-a',
      display_name: 'Nova 主实例', active: true, last_seen_at: 100,
    }, {
      instance_id: 'instance-b', logical_workspace_id: 'logical-b',
      display_name: 'Runtime 归档实例', active: false, last_seen_at: 80,
    }],
    relations: [{
      source_logical_id: 'logical-a', target_logical_id: 'logical-b',
      relation_type: 'depends_on', confidence: 0.75, status: 'weak',
      last_seen_at: 90, evidence_count: 3,
    }],
    ...overrides,
  }
}

class FakeElement {
  className = ''
  hidden = false
  textContent = ''
  children = []
  attributes = new Map()

  constructor(tagName) { this.tagName = tagName }

  append(...children) { this.children.push(...children) }
  replaceChildren(...children) { this.children = [...children] }
  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  set innerHTML(_value) { throw new Error('renderer attempted HTML injection') }

  text() {
    return [this.textContent, ...this.children.map(child => child.text())].join('')
  }
}

class FakeDocument {
  created = []
  createElement(tagName) {
    const element = new FakeElement(tagName)
    this.created.push(element)
    return element
  }
}

test('graph payload validator clones the exact bounded view and rejects hidden or malformed data', () => {
  const input = payload()
  const parsed = parseWorkspaceGraphBoardPayload(input)
  assert.notEqual(parsed, input)
  assert.ok(Object.isFrozen(parsed))
  assert.ok(Object.isFrozen(parsed.relations))
  assert.deepEqual(parsed, input)

  assert.equal(parseWorkspaceGraphBoardPayload({...input, aliases: ['secret']}), null)
  assert.equal(parseWorkspaceGraphBoardPayload({...input, availability: 'unknown'}), null)
  assert.equal(parseWorkspaceGraphBoardPayload({
    ...input,
    relations: [{...input.relations[0], target_logical_id: 'missing'}],
  }), null)
  assert.equal(parseWorkspaceGraphBoardPayload({
    ...input,
    workspace_instances: [{...input.workspace_instances[0], active: 'yes'}],
  }), null)
})

test('graph payload validator enforces the aggregate 16 KiB frame boundary', () => {
  const oversized = payload({
    logical_workspaces: Array.from({length: 64}, (_, index) => ({
      logical_workspace_id: `logical-${index}`,
      display_name: `${'图🚀'.repeat(90)}-${index}`,
    })),
    workspace_instances: [],
    relations: [],
  })
  assert.ok(new TextEncoder().encode(JSON.stringify(oversized)).length > 16 * 1024)
  assert.equal(parseWorkspaceGraphBoardPayload(oversized), null)
})

test('tab keyboard mapping keeps both tabs reachable with the standard roving pattern', () => {
  assert.equal(boardTabForKey('memory', 'ArrowRight'), 'graph')
  assert.equal(boardTabForKey('memory', 'End'), 'graph')
  assert.equal(boardTabForKey('graph', 'ArrowLeft'), 'memory')
  assert.equal(boardTabForKey('graph', 'Home'), 'memory')
  assert.equal(boardTabForKey('memory', 'Enter'), null)
})

test('graph renderer uses owned text nodes for active weak degraded stale and omission states', () => {
  const document = new FakeDocument()
  const root = new FakeElement('main')
  const status = new FakeElement('p')
  const parsed = parseWorkspaceGraphBoardPayload(payload({
    availability: 'degraded',
    omitted: {logical_workspaces: 2, workspace_instances: 1, relations: 4},
  }))
  assert.ok(parsed)
  renderWorkspaceGraphBoard(parsed, {document, root, status})
  const text = `${status.text()}${root.text()}`
  assert.match(text, /已降级/u)
  assert.match(text, /数据可能已过期/u)
  assert.match(text, /活跃/u)
  assert.match(text, /非活跃/u)
  assert.doesNotMatch(text, /当前|非当前/u)
  assert.match(text, /弱关联/u)
  assert.match(text, /3 条证据/u)
  assert.match(text, /省略/u)
  assert.equal(document.created.some(node => node.className.includes('badge-active')), true)
  assert.equal(document.created.some(node => node.className.includes('badge-weak')), true)
  assert.equal(document.created.some(node => node.className.includes('badge-stale')), true)
})

test('graph renderer shows disabled and empty states without creating action controls', () => {
  for (const availability of ['disabled', 'ready']) {
    const document = new FakeDocument()
    const root = new FakeElement('main')
    const status = new FakeElement('p')
    const parsed = parseWorkspaceGraphBoardPayload(payload({
      availability,
      logical_workspaces: [], workspace_instances: [], relations: [],
    }))
    assert.ok(parsed)
    renderWorkspaceGraphBoard(parsed, {document, root, status})
    assert.match(`${status.text()}${root.text()}`, availability === 'disabled' ? /未启用/u : /暂无关联/u)
    assert.equal(document.created.some(node => node.tagName === 'button'), false)
    assert.equal(document.created.some(node => node.tagName === 'a'), false)
    assert.equal(document.created.some(node => node.tagName === 'form'), false)
  }
})

test('graph tab requests on selection and refreshes only while active and visible', async () => {
  let visible = true
  let requests = 0
  const rendered = []
  const controller = createGraphTabController({
    request: async () => { requests += 1; return payload({request_id: `graph-${requests}`}) },
    visible: () => visible,
    render: value => rendered.push(value.request_id),
    failure: () => { throw new Error('unexpected graph load failure') },
  })

  await controller.tick()
  assert.equal(requests, 0, 'hidden tab does not poll')
  await controller.activate()
  assert.equal(requests, 1, 'selection requests the graph')
  visible = false
  await controller.tick()
  assert.equal(requests, 1, 'hidden window does not poll')
  visible = true
  controller.deactivate()
  await controller.refresh()
  assert.equal(requests, 1, 'inactive tab does not refresh')
  await controller.activate()
  await controller.tick()
  assert.deepEqual(rendered, ['graph-1', 'graph-2', 'graph-3'])
})

test('graph tab rejects malformed payloads and coalesces overlapping refreshes', async () => {
  let resolveRequest
  let requests = 0
  const failures = []
  const controller = createGraphTabController({
    request: () => {
      requests += 1
      return new Promise(resolve => { resolveRequest = resolve })
    },
    visible: () => true,
    render: () => { throw new Error('malformed payload must not render') },
    failure: reason => failures.push(reason),
  })
  const first = controller.activate()
  const overlapping = controller.tick()
  await Promise.resolve()
  assert.equal(requests, 1)
  resolveRequest({...payload(), aliases: ['hidden']})
  await Promise.all([first, overlapping])
  assert.deepEqual(failures, ['invalid'])
})
