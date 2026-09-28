import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {runInNewContext} from 'node:vm'

import {
  activeMcpMenuDescriptor,
  activeMcpMenuRows,
  mcpServerLabel,
  mcpServerStatusLabel,
  toolCountLabel,
} from '../src/main/orb-menu.mjs'

test('orb restart applies saved settings through the shared transaction and reports failure', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  assert.match(source, /let currentSettings = null/)
  const start = source.indexOf('function showOrbMenu(launchId) {')
  const menuSource = source.slice(start, source.indexOf('\n}', start) + 2)
  for (const status of ['applied', 'busy', 'restart_failed', 'throw']) {
    let rows, called = 0
    const errors = []
    const coordinator = {busy: false}
    const context = {
      t: value => value,
      Menu: {buildFromTemplate: value => { rows = value; return {popup() {}} }},
      mainWindow: {}, currentSettings: {}, lifecycleCoordinator: coordinator,
      activeMcpSubmenu: () => [],
      toggleVisor: () => {},
      applyDesktopSettings: async (patch, restart) => {
        called++
        assert.equal(JSON.stringify(patch), '{"settingsPatch":{}}')
        assert.equal(restart, true)
        if (status === 'throw') throw new Error('unavailable')
        return {operationStatus: status}
      },
      dialog: {showErrorBox: (...args) => errors.push(args)},
    }
    runInNewContext(`${menuSource}\nshowOrbMenu('test')`, context)
    const restart = rows.find(row => row.label === '重启后台')
    assert.equal(restart.enabled, true)
    await restart.click()
    assert.equal(called, 1)
    assert.equal(errors.length, status === 'applied' ? 0 : 1)
    coordinator.busy = true
    runInNewContext(`${menuSource}\nshowOrbMenu('test')`, context)
    assert.equal(rows.find(row => row.label === '重启后台').enabled, false)
  }
})

// The shape backend-supervisor.mjs sanitizes into, with main's own state overlay.
function runtime(overrides = {}) {
  return {
    toolCount: 12,
    toolBudget: 24,
    state: 'running',
    servers: [{name: 'search', status: 'ok'}],
    overrides: [],
    ...overrides,
  }
}

test('a dynamic server sheds the prefix it only carries inside the runtime', () => {
  assert.equal(mcpServerLabel('mcp__acme_tools'), 'acme_tools')
  assert.equal(mcpServerLabel('search'), 'search')
  assert.equal(mcpServerLabel(undefined), '')
})

test('an unrecognized server status reports as failure rather than vanishing', () => {
  assert.equal(mcpServerStatusLabel('ok'), '正常')
  assert.equal(mcpServerStatusLabel('configured'), '已配置')
  assert.equal(mcpServerStatusLabel('disabled'), '已停用')
  assert.equal(mcpServerStatusLabel('failed'), '失败')
  assert.equal(mcpServerStatusLabel('something-new'), '失败')
  assert.equal(mcpServerStatusLabel(undefined), '失败')
})

test('the tool summary waits for a compiled tool count', () => {
  assert.equal(toolCountLabel(runtime()), '前台可用工具：12 个（上限 24 个）')
  assert.equal(toolCountLabel(runtime({toolCount: null})), null, 'a pending compile shows no count')
  assert.equal(toolCountLabel(runtime({toolBudget: undefined})), null)
  assert.equal(toolCountLabel(null), null)
})

test('every degraded backend state names its own cause', () => {
  for (const [value, expected] of [
    [null, '能力状态尚未获取'],
    [runtime({state: 'startup_failed'}), '能力模块未能启动'],
    [runtime({state: 'stopped'}), '后端已停止，MCP 状态不可用'],
    [runtime({servers: []}), '暂无已配置的 MCP 服务器'],
    [runtime({servers: undefined}), '暂无已配置的 MCP 服务器'],
  ]) {
    const descriptor = activeMcpMenuDescriptor(value)
    assert.equal(descriptor.unavailable, expected)
    assert.deepEqual(descriptor.entries, [])
  }
})

test('a reachable backend lists one entry per configured server', () => {
  const descriptor = activeMcpMenuDescriptor(runtime({servers: [
    {name: 'search', status: 'ok'},
    {name: 'mcp__acme_tools', status: 'failed', reason: 'auth'},
    {name: 'nova_camera', status: 'disabled'},
  ]}))

  assert.equal(descriptor.unavailable, null)
  assert.deepEqual(descriptor.entries.map(entry => entry.label), ['search', 'acme_tools', 'nova_camera'])
  assert.deepEqual(descriptor.entries.map(entry => entry.detail), ['正常', '失败', '已停用'])
  assert.deepEqual(descriptor.entries.map(entry => entry.name), ['search', 'mcp__acme_tools', 'nova_camera'])
})

test('a Codex sub-status shows only where it disagrees with FrontBrain', () => {
  const descriptor = activeMcpMenuDescriptor(runtime({servers: [
    {name: 'agree', status: 'ok', codex: {status: 'ok'}},
    {name: 'differ', status: 'ok', codex: {status: 'failed'}},
  ]}))

  assert.equal(descriptor.entries[0].detail, '正常', 'a duplicated label carries nothing')
  assert.equal(descriptor.entries[1].detail, '正常 · Codex 失败')
})

test('rows lead with the tool summary and only servers are actionable', () => {
  const rows = activeMcpMenuRows(runtime({servers: [
    {name: 'search', status: 'ok'},
    {name: 'mcp__acme_tools', status: 'failed'},
  ]}))

  assert.deepEqual(rows, [
    {label: '前台可用工具：12 个（上限 24 个）', enabled: false},
    {label: 'search · 正常', name: 'search', enabled: true},
    {label: 'acme_tools · 失败', name: 'mcp__acme_tools', enabled: true},
  ])
})

test('a degraded backend yields one inert reason row', () => {
  assert.deepEqual(activeMcpMenuRows(null), [{label: '能力状态尚未获取', enabled: false}])
  assert.deepEqual(
    activeMcpMenuRows(runtime({toolCount: null, servers: []})),
    [{label: '暂无已配置的 MCP 服务器', enabled: false}],
    'no tool summary until the tool set compiles',
  )
  for (const rows of [activeMcpMenuRows(null), activeMcpMenuRows(runtime({state: 'stopped'}))]) {
    assert.ok(rows.every(row => row.enabled === false), 'a reason row is never clickable')
  }
})

test('the orb menu hangs MCP status off a submenu without its own separator', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const menu = source.slice(source.indexOf('function showOrbMenu('))
  const body = menu.slice(0, menu.indexOf('.popup('))

  assert.match(body, /\{ label: t\("MCP 服务"\), submenu: activeMcpSubmenu\(launchId\) \}/)
  // The template's single separator is what the menu-order contract keys on.
  assert.equal((body.match(/type: 'separator'/g) || []).length, 1)
  assert.ok(
    body.indexOf('label: t("MCP 服务")') < body.indexOf("{ type: 'separator' }"),
    'MCP status sits above the quit separator',
  )

  const builder = source.slice(source.indexOf('function activeMcpSubmenu('))
  const builderBody = builder.slice(0, builder.indexOf('\n}\n'))
  assert.doesNotMatch(builderBody, /type: 'separator'/, 'a nested separator would break menu ordering')
  assert.match(builderBody, /activeMcpMenuRows\(runtimeCapabilities\)/, 'built from the live snapshot')
  assert.match(builderBody, /openSettingsWindow\(launchId, \{ category: 'capabilities' \}\)/)
})

test('a focus request rides the existing push and adds no IPC channel', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const preloadSource = await readFile(new URL('../src/preload/preload.cjs', import.meta.url), 'utf8')

  assert.match(source, /function openSettingsWindow\(launchId, \{ category \} = \{\}\)/)
  assert.match(source, /return category \? \{ \.\.\.settingsView\(\), focusCategory: category \} : settingsView\(\)/)
  // Every pre-existing caller omits the category and must keep today's payload.
  assert.doesNotMatch(preloadSource, /focusCategory/)
  assert.doesNotMatch(source, /'nova:settings:focus'/)
})
