import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {inspectDoctor} from '../src/runtime.mjs'
import {main} from '../src/command.mjs'

test('standalone doctor uses the shared registry validator and renders redacted per-server failures', async () => {
  const home = await mkdtemp(join(tmpdir(), 'nova-doctor-capabilities-'))
  try {
    await mkdir(join(home, '.nova-audio-agent'))
    await writeFile(join(home, '.nova-audio-agent/capabilities.json'), JSON.stringify({version: 1, modules: {search: {enabled: false}}, mcpServers: {
      docs: {transport: 'streamable-http', url: 'https://example.test/mcp', headers: {authorization: '${MISSING_TOKEN}'}, tools: {search: {enabled: true}}},
    }}))
    const report = await inspectDoctor({platform: 'darwin', arch: 'arm64', home, environment: {}})
    assert.equal(report.capabilities.ok, false)
    assert.equal(report.capabilities.modules.search.enabled, false)
    assert.equal(report.capabilities.servers[0].reason, 'missing_environment:MISSING_TOKEN')
    let output = ''
    assert.equal(await main(['doctor'], {doctor: () => report, stdout: {write: text => { output += text }}}), 1)
    assert.match(output, /MCP docs: failed \(missing_environment:MISSING_TOKEN\)/u)
    assert.equal(output.includes('https://example.test'), false)
  } finally { await rm(home, {recursive: true, force: true}) }
})

test('doctor uses the normalized persisted registry path before environment and default fallbacks', async () => {
  const {desktopSettingsPath} = await import('../src/target.mjs')
  const home = await mkdtemp(join(tmpdir(), 'nova-doctor-selected-registry-'))
  const settings = desktopSettingsPath({platform: 'darwin', home, environment: {}})
  const saved = join(home, 'saved.json')
  const inherited = join(home, 'inherited.json')
  try {
    await mkdir(join(settings, '..'), {recursive: true})
    await mkdir(join(home, '.nova-audio-agent'))
    await writeFile(join(home, '.nova-audio-agent/capabilities.json'), JSON.stringify({version: 1, modules: {search: {enabled: false}, coding: {enabled: false}}}))
    await writeFile(saved, JSON.stringify({version: 1, modules: {search: {enabled: false}, camera: {enabled: false}}}))
    await writeFile(inherited, JSON.stringify({version: 1, modules: {search: {enabled: false}, knowledge: {enabled: true}}}))
    const inspect = environment => inspectDoctor({platform: 'darwin', arch: 'arm64', home, environment})
    await writeFile(settings, JSON.stringify({version: 4, capabilitiesConfigPath: ` ${saved} `}))
    const selected = await inspect({NOVA_AUDIO_AGENT_CAPABILITIES_CONFIG: inherited})
    assert.equal(selected.capabilities.ok, true)
    assert.equal(selected.capabilities.modules.camera.enabled, false)
    assert.equal(selected.capabilities.modules.knowledge.enabled, false)
    for (const capabilitiesConfigPath of ['', null, 12, 'bad\u0000path', 'x'.repeat(32769)]) {
      await writeFile(settings, JSON.stringify({version: 4, capabilitiesConfigPath}))
      assert.equal((await inspect({NOVA_AUDIO_AGENT_CAPABILITIES_CONFIG: inherited})).capabilities.modules.knowledge.enabled, true)
      assert.equal((await inspect({})).capabilities.modules.coding.enabled, false)
    }
    await writeFile(settings, JSON.stringify({version: 3, capabilitiesConfigPath: saved}))
    assert.equal((await inspect({})).capabilities.modules.coding.enabled, false)
    await writeFile(settings, JSON.stringify({version: 4, capabilitiesConfigPath: join(home, 'missing-sensitive.json')}))
    const missing = await inspect({NOVA_AUDIO_AGENT_CAPABILITIES_CONFIG: inherited})
    assert.equal(missing.capabilities.ok, false)
    assert.equal(missing.capabilities.reason, 'file_unreadable_or_invalid_json')
    assert.equal(JSON.stringify(missing).includes('missing-sensitive'), false)
  } finally { await rm(home, {recursive: true, force: true}) }
})

test('standalone generated validator rejects null module and server exposure fields', async () => {
  const {parseCapabilityRegistry} = await import('../src/capability-registry.mjs')
  assert.throws(() => parseCapabilityRegistry({version: 1, modules: null}), /invalid capabilities configuration/u)
  const parsed = parseCapabilityRegistry({version: 1, mcpServers: {bad: {transport: 'stdio', command: 'node', exposeTo: null}}})
  assert.equal(parsed.serverStatuses[0].status, 'failed')
})
