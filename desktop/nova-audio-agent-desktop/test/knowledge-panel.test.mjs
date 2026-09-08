import test from 'node:test'
import assert from 'node:assert/strict'
import {createKnowledgePanel} from '../src/renderer/knowledge-panel.mjs'

function fixture(action) {
  class Element {
    constructor() {this.children = []; this.listeners = {}; this.checked = false; this.value = ''; this.textContent = ''}
    append(...children) {this.children.push(...children)}
    replaceChildren(...children) {this.children = children}
    addEventListener(name, fn) {this.listeners[name] = fn}
  }
  const nodes = new Map()
  const doc = {createElement: () => new Element(), querySelector: name => {if (!nodes.has(name)) nodes.set(name, new Element()); return nodes.get(name)}}
  const panel = createKnowledgePanel({document: doc, action})
  return {panel, node: name => doc.querySelector(`#knowledge-${name}`)}
}
test('panel requires consent and renders source labels as text, not HTML', async () => {
  const sent = []
  const {panel, node} = fixture(async input => {sent.push(input); return {sources: [{id: 'one', title: '<img onerror=bad>', status: 'ready'}], jobs: []}})
  panel.render({capabilities: {runtime: {modules: {knowledge: {enabled: true}}}}})
  await node('files').listeners.click()
  assert.equal(sent.length, 0)
  node('consent').checked = true
  await node('files').listeners.click()
  assert.deepEqual(sent[0], {action: 'files', consent: true})
  assert.equal(node('sources').children[0].children[0].textContent, '<img onerror=bad> · ready')
})
test('disabled module discards late source list and clears consent', async () => {
  let finish
  const {panel, node} = fixture(() => new Promise(resolve => {finish = resolve}))
  panel.render({capabilities: {runtime: {modules: {knowledge: {enabled: true}}}}})
  const pending = node('refresh').listeners.click()
  panel.render({capabilities: {runtime: {modules: {knowledge: {enabled: false}}}}})
  finish({sources: [{id: 'one', title: 'late', status: 'ready'}]})
  await pending
  assert.equal(node('panel').hidden, true)
  assert.equal(node('sources').children.length, 0)
  assert.equal(node('consent').checked, false)
})

test('panel displays FTS availability and its lexical fallback limitation', async () => {
  let fts = false
  const {panel, node} = fixture(async () => ({sources: [], jobs: [], fts}))
  panel.render({capabilities: {runtime: {modules: {knowledge: {enabled: true}}}}})
  await node('refresh').listeners.click()
  assert.match(node('status').textContent, /FTS5 不可用.*基础词法匹配.*无相关性排序/u)
  fts = true
  await node('refresh').listeners.click()
  assert.match(node('status').textContent, /FTS5 已启用/u)
  assert.doesNotMatch(node('status').textContent, /不可用/u)
})
