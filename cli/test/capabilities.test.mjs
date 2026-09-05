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
