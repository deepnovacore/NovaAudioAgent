import {tmpdir} from 'node:os'
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp, readFile, rm, chmod, realpath} from 'node:fs/promises'
import {join} from 'node:path'
import {parseCapabilityRegistry} from '../src/capability-registry.js'
import {prepareManagedCodexMcp, managedMcpConfigToml} from '../src/executors/codex/managed-mcp.js'
import {CredentialSnapshotter} from '../src/executors/codex/credential-snapshot.js'
import {hostCodexHomeForTest, hostBinaryForTest, hostWorkspaceForTest, createApprovedCodexSpawnSpec, approvedCodexSpawnDetails} from '../src/executors/codex/process-owner.js'

const tool = {enabled: true, timeoutMs: 8001}
function registry(mcpServers: Record<string, unknown>, coding = true) {
  return parseCapabilityRegistry({version: 1, modules: {coding: {enabled: coding}}, mcpServers}, {TOKEN: 'dummy-secret'})
}
const http = {transport: 'streamable-http', url: 'https://example.test/mcp', headers: {Authorization: '${TOKEN}'}, tools: {'look-up.raw': tool}}

test('private MCP config serializes only references and exact original tools; no host MCP or ambient env', async () => {
  const managed = prepareManagedCodexMcp(registry({docs: http, hidden: {...http, exposeTo: {codex: false}}}))
  assert.deepEqual(Object.keys(managed.servers), ['docs'])
  assert.deepEqual(managed.servers.docs?.enabled_tools, ['look-up.raw'])
  assert.equal(managed.servers.docs?.tool_timeout_sec, 9)
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'nova-managed-mcp-')))
  await chmod(directory, 0o700)
  try {
    const home = hostCodexHomeForTest(directory, {ephemeral: true})
    const snapshotter = new CredentialSnapshotter({environment: {PATH: '/safe', HOME: '/safe-home', AMBIENT_SECRET: 'not-inherited'}})
    const snapshot = await snapshotter.prepare({codexHome: home, apiKey: 'dummy-codex', managedMcp: managed})
    const config = await readFile(join(directory, 'config.toml'), 'utf8')
    assert.match(config, /"enabled_tools" = \["look-up.raw"\]/u)
    assert.equal(config.includes('dummy-secret'), false)
    assert.equal(config.includes('hidden'), false)
    const env = snapshotter.environment(snapshot)
    assert.equal(env.AMBIENT_SECRET, undefined)
    assert.equal(Object.values(env).includes('dummy-secret'), true)
    const spawnSpec = createApprovedCodexSpawnSpec({binary: hostBinaryForTest(process.execPath), workspace: hostWorkspaceForTest(process.cwd()), codexHome: home, environment: env, managedMcp: managed})
    assert.equal(approvedCodexSpawnDetails(spawnSpec).argv.includes('mcp_servers={}'), false)
    for (const hostile of [Object.create(env) as Record<string, string>, Object.defineProperty({...env}, 'UNPREPARED_KEY', {get() { throw new Error('must not read') }, enumerable: true})]) {
      assert.throws(() => createApprovedCodexSpawnSpec({binary: hostBinaryForTest(process.execPath), workspace: hostWorkspaceForTest(process.cwd()), codexHome: home, environment: hostile, managedMcp: managed}))
    }
    assert.throws(() => createApprovedCodexSpawnSpec({binary: hostBinaryForTest(process.execPath), workspace: hostWorkspaceForTest(process.cwd()), codexHome: home, environment: {...env, UNPREPARED_KEY: 'x'}, managedMcp: managed}))
  } finally { await rm(directory, {recursive: true, force: true}) }
})

test('secret URLs and launcher env fail per server; disabled coding projects nothing', () => {
  const capabilities = registry({safe: {...http, url: 'https://example.test/mcp?version=2'}, url: {...http, url: 'https://example.test/${TOKEN}'}, literal: {...http, url: 'https://example.test/mcp?api_key=dummy-inline'}, node: {transport: 'stdio', command: 'node', env: {NODE_OPTIONS: '${TOKEN}'}, tools: {read: tool}}})
  const managed = prepareManagedCodexMcp(capabilities)
  assert.deepEqual(Object.keys(managed.servers), ['safe'])
  assert.equal(capabilities.serverStatuses.find(s => s.name === 'url')?.codex?.status, 'failed')
  assert.equal(capabilities.serverStatuses.find(s => s.name === 'node')?.codex?.status, 'failed')
  assert.deepEqual(Object.keys(prepareManagedCodexMcp(registry({safe: http}, false)).servers), [])
})

test('stdio env conflicts fail all affected servers independently of order and Windows case', () => {
  const stdio = (env: Record<string, string>) => ({transport: 'stdio', command: '/usr/bin/false', env, tools: {read: tool}})
  for (const keys of [['a', 'b', 'c'], ['c', 'b', 'a']]) {
    const capabilities = registry(Object.fromEntries(keys.map(name => [name, stdio({APP_TOKEN: name === 'b' ? 'different' : 'same'})])))
    assert.deepEqual(Object.keys(prepareManagedCodexMcp(capabilities).servers), [])
    assert.ok(capabilities.serverStatuses.every(s => s.codex?.reason === 'codex_env_conflict'))
  }
  const windows = registry({a: stdio({App_Token: 'a'}), b: stdio({APP_TOKEN: 'b'}), safe: stdio({SAFE_TOKEN: 'ok'})})
  assert.deepEqual(Object.keys(prepareManagedCodexMcp(windows, {}, 'win32').servers), ['safe'])
  const same = registry({a: stdio({App_Token: 'same', APP_TOKEN: 'same'})})
  assert.deepEqual(prepareManagedCodexMcp(same, {}, 'win32').servers.a?.env_vars, ['APP_TOKEN'])
})

test('unsupported timeouts and host-control env fail visibly without dropping tools or settings', () => {
  const capabilities = registry({timeout: {...http, tools: {a: tool, b: {enabled: true, timeoutMs: 20000}}},
    env: {transport: 'stdio', command: 'node', env: {CODEX_API_KEY: 'other'}, tools: {read: tool}}, safe: http})
  const managed = prepareManagedCodexMcp(capabilities)
  assert.deepEqual(Object.keys(managed.servers), ['safe'])
  assert.equal(capabilities.serverStatuses.find(s => s.name === 'timeout')?.codex?.reason, 'codex_timeout_unrepresentable')
  assert.equal(capabilities.serverStatuses.find(s => s.name === 'env')?.codex?.reason, 'codex_env_unrepresentable')
})

test('trusted host knowledge entry uses the same allowlist/reference path while external name stays reserved', () => {
  const capabilities = registry({nova_knowledge: http})
  assert.equal(capabilities.serverStatuses[0]?.reason, 'reserved_server_name')
  const managed = prepareManagedCodexMcp(capabilities, {nova_knowledge: {enabled: true, transport: 'streamable-http', url: 'http://127.0.0.1:12345/mcp', headers: {Authorization: 'Bearer dummy-local-token'}, tools: {recall: {enabled: true, timeoutMs: 8000, maxCallsPerTurn: 2, maxResultBytes: 32768}}, exposeTo: {frontbrain: false, codex: true}}})
  assert.deepEqual(Object.keys(managed.servers), ['nova_knowledge'])
  assert.deepEqual(managed.servers.nova_knowledge?.enabled_tools, ['recall'])
  assert.equal(managed.servers.nova_knowledge?.bearer_token_env_var, 'NOVA_MANAGED_MCP_NOVA_KNOWLEDGE_TOKEN')
  assert.equal(JSON.stringify(managed).includes('dummy-local-token'), false)
})


test('stdio inline credentials fail per server in joined, split and command text forms', () => {
  const ordinaryArgs = ['--transport', 'stdio', '--query', 'password safety', '--token-file', '/tmp/auth-file']
  for (const text of [
    {args: ['--api-key=dummy-sensitive-value']},
    {args: ['--api-key', 'dummy-sensitive-value']},
    {args: ['--token', 'dummy-sensitive-value']},
    {args: ['--password', 'dummy-sensitive-value']},
    {args: ['-H', 'Authorization: dummy-sensitive-value']},
    {command: '/usr/bin/env PASSWORD=dummy-sensitive-value node'},
    {command: 'node --api-key dummy-sensitive-value'},
    {args: ['--server', 'https://example.test/mcp?token=dummy-sensitive-value']},
  ]) {
    const stdio = {transport: 'stdio', command: '/usr/bin/false', tools: {read: tool}}
    const capabilities = registry({bad: {...stdio, ...text}, safe: {...stdio, args: ordinaryArgs}})
    const managed = prepareManagedCodexMcp(capabilities)
    assert.deepEqual(Object.keys(managed.servers), ['safe'])
    assert.equal(capabilities.serverStatuses.find(server => server.name === 'bad')?.codex?.reason, 'codex_secret_command_unrepresentable')
    assert.equal(managedMcpConfigToml(managed).includes('dummy-sensitive-value'), false)
    assert.deepEqual(managed.servers.safe?.args, ordinaryArgs)
  }
})

test('TOML control escaping preserves accepted argument, tool and header strings without breaking healthy servers', () => {
  const capabilities = registry({control: {transport: 'stdio', command: '/usr/bin/false', args: ['dummy\u007f', '\b\t\n\r\f', '中文😀'], tools: {'read\u007f': tool}}, safe: http})
  const managed = prepareManagedCodexMcp(capabilities, {headers: {...capabilities.mcpServers.safe!, headers: {'X-Test\u007f': 'dummy-header'}}})
  assert.deepEqual(Object.keys(managed.servers), ['control', 'safe', 'headers'])
  assert.equal(managed.servers.control?.args?.[0], 'dummy\u007f')
  // TOML forbids these raw controls in all basic strings, including quoted table keys.
  assert.doesNotMatch(managedMcpConfigToml(managed), /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u)
})
