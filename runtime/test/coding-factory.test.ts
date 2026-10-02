import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test, type TestContext} from 'node:test'
import {loadSettings} from '../src/config/config.js'
import {VirtualClock} from '../src/core/clock.js'
import {parseCapabilityRegistry} from '../src/config/capability-registry.js'
import {parseCodingProfiles, runtimeCodingProfiles} from '../src/config/coding-profiles.js'
import {createAcpBackendRouting, createAcpProjectTransport, PreparedAcpTransport, type AcpProjectBinding} from '../src/executors/acp/transport.js'
import {createCodexAssemblyResource} from '../src/executors/codex/factory.js'
import {resolveCodexHostConfig} from '../src/executors/codex/host-config.js'
import {CodexTransportError, type CodexAppServerTransport} from '../src/executors/codex/app-server-transport.js'
import {hostWorkspaceForTest} from '../src/executors/codex/process-owner.js'
import type {ProjectCodexAdapter} from '../src/executors/codex/adapter-project.js'
import {ProjectStore} from '../src/projects/project-store.js'
import {context, fixture, run, runRequest, ProjectTransport} from './fixtures/codex/project-adapter-fixture.js'
import {DescriptorLockAuthority, DescriptorRelativeRootFileAuthority} from './project-store-fixture.js'
import {rm} from 'node:fs/promises'

const ACP_REPORT = {protocol: 'acp' as const, version: '1', backend: 'opencode', connected: true as const}

function stubTransport(close: () => Promise<void> = () => Promise.resolve()): CodexAppServerTransport {
  return {
    preflight: () => Promise.resolve(ACP_REPORT), prewarm: () => Promise.resolve(null),
    run: () => Promise.reject(new Error('not used')),
    steer: () => Promise.resolve({code: 'unsupported' as const, written: false}), close,
  }
}

test('MCP access closes even when backend process cleanup must be retried', async () => {
  let mcpCloses = 0
  let processCloses = 0
  const transport = new PreparedAcpTransport(() => Promise.resolve({
    mcp: {servers: [], close: () => { mcpCloses++; return Promise.resolve() }},
    transport: stubTransport(() => ++processCloses === 1 ? Promise.reject(new Error('tree remains')) : Promise.resolve()),
  }))
  await transport.preflight({expiresAtMs: Date.now() + 1000})
  await assert.rejects(transport.close(), /tree remains/u)
  assert.equal(mcpCloses, 1)
  await transport.close()
  assert.equal(processCloses, 2)
})

test('MCP preparation obeys numeric deadlines and observes cancellation', async () => {
  let cancelled = false
  const transport = new PreparedAcpTransport(signal => new Promise((_, reject) => {
    signal.addEventListener('abort', () => { cancelled = true; reject(new Error('aborted')) }, {once: true})
  }))
  await assert.rejects(transport.preflight({expiresAtMs: Date.now() + 20}), /adapter_timeout/u)
  assert.equal(cancelled, true)
  await transport.close()
})

test('MCP preparation failure is a pre-effect refusal, never an uncertain run', async () => {
  const transport = new PreparedAcpTransport(() => Promise.reject(new CodexTransportError('mcp_tools_not_isolated')))
  const outcome = await transport.run({workOrder: 'x'}, {}, {expiresAtMs: Date.now() + 1000})
  assert.deepEqual(outcome, {classification: 'refused', code: 'mcp_tools_not_isolated', turnStartWritten: false, completion: null})
  await transport.close()
})

test('completed preflight signal does not own the MCP lifetime', async () => {
  let lifetime: AbortSignal | undefined
  const transport = new PreparedAcpTransport(signal => {
    lifetime = signal
    return Promise.resolve({mcp: {servers: [], close: () => Promise.resolve()}, transport: stubTransport()})
  })
  const preflight = new AbortController()
  await transport.preflight({expiresAtMs: Date.now() + 1000, signal: preflight.signal})
  preflight.abort()
  assert.equal(lifetime?.aborted, false)
  await transport.close()
  assert.equal(lifetime?.aborted, true)
})

const profileId = (profile: {backendId: string; binaryPath: string; configPath: string}): string =>
  `${profile.backendId}:${createHash('sha256').update(JSON.stringify(profile)).digest('hex')}`

test('profile source identities retain previous configs and reject mismatches', () => {
  const previous = {backendId: 'opencode', binaryPath: '/usr/local/bin/opencode', configPath: '/tmp/old.json'}
  const current = {...previous, configPath: '/tmp/new.json'}
  const document = {...parseCodingProfiles(), profiles: {[profileId(previous)]: previous, [profileId(current)]: current}}
  document.defaults = {...document.defaults, opencode: profileId(current)}
  const parsed = parseCodingProfiles(JSON.stringify(document))
  assert.equal(parsed.profiles[profileId(previous)]?.configPath, '/tmp/old.json')
  assert.equal(parsed.profiles[parsed.defaults.opencode]?.configPath, '/tmp/new.json')
  assert.throws(() => parseCodingProfiles(JSON.stringify({...document, profiles: {[profileId(previous)]: current}})), /invalid_coding_profiles/u)
  assert.throws(() => parseCodingProfiles(JSON.stringify({...document, defaults: {...document.defaults, pi: profileId(current)}})), /invalid_coding_profiles/u)
  // Codex is not an ACP profile backend: its sessions keep the fixed legacy profile.
  const codex = {backendId: 'codex', binaryPath: '/bin/codex-acp', configPath: ''}
  assert.throws(() => parseCodingProfiles(JSON.stringify({...document, profiles: {[profileId(codex)]: codex}})), /invalid_coding_profiles/u)
  assert.throws(() => parseCodingProfiles(JSON.stringify({...document, defaults: {...document.defaults, codex: 'codex:legacy'}})), /invalid_coding_profiles/u)
})

test('restart cannot resume inherited or binary-only profiles after config-source drift', () => {
  const profile = {backendId: 'opencode', binaryPath: '/bin/opencode', configPath: ''}
  const document = {...parseCodingProfiles(), profiles: {[profileId(profile)]: profile}}
  document.defaults = {...document.defaults, opencode: profileId(profile)}
  for (const registry of [parseCodingProfiles(), parseCodingProfiles(JSON.stringify(document))]) {
    const environment = {HOME: '/home/user1', OPENCODE_CONFIG: '/config/old.json'}
    const before = runtimeCodingProfiles(registry, environment)
    const saved = before.defaults.opencode
    for (const changed of [{HOME: '/home/user2'}, {OPENCODE_CONFIG: '/config/new.json'}, {OPENCODE_CONFIG_DIR: '/config/new'}, {XDG_CONFIG_HOME: '/xdg/new'}]) {
      const restarted = runtimeCodingProfiles(registry, {...environment, ...changed})
      assert.notEqual(restarted.defaults.opencode, saved)
      assert.equal(restarted.profiles[saved], undefined)
    }
    assert.equal(before.profiles[registry.defaults.opencode], undefined)
  }
  for (const [backend, key] of [['pi', 'PI_CODING_AGENT_DIR'], ['deepseek', 'DSH_HOME'], ['codebuddy', 'APPDATA']] as const) {
    const before = runtimeCodingProfiles(parseCodingProfiles(), {HOME: '/home/user1', [key]: '/old'})
    const restarted = runtimeCodingProfiles(parseCodingProfiles(), {HOME: '/home/user1', [key]: '/new'})
    assert.equal(restarted.profiles[before.defaults[backend]], undefined)
  }
})

test('per-backend ACP binary overrides change identity; token refresh does not rebind', () => {
  const base = runtimeCodingProfiles(parseCodingProfiles(), {HOME: '/home/user1'})
  const overridden = runtimeCodingProfiles(parseCodingProfiles(), {HOME: '/home/user1', PI_ACP_BIN: '/opt/pi-acp'})
  assert.notEqual(overridden.defaults.pi, base.defaults.pi)
  assert.equal(overridden.profiles[overridden.defaults.pi]?.binaryPath, '/opt/pi-acp')
  assert.equal(overridden.defaults.opencode, base.defaults.opencode)
  const fresh = runtimeCodingProfiles(parseCodingProfiles(), {HOME: '/home/user1', DEEPSEEK_API_KEY: 'new'})
  assert.equal(fresh.defaults.deepseek, runtimeCodingProfiles(parseCodingProfiles(), {HOME: '/home/user1', DEEPSEEK_API_KEY: 'old'}).defaults.deepseek)
})

test('a drifted or foreign profile refuses resume before any process or MCP is prepared', () => {
  const profiles = runtimeCodingProfiles(parseCodingProfiles(), {HOME: '/home/user1'}).profiles
  const binding: AcpProjectBinding = {backendId: 'opencode', profileId: `opencode:${'a'.repeat(64)}`,
    workspace: hostWorkspaceForTest(realpathSync(tmpdir())), resumeSessionId: 'native', approvalController: null}
  const options = {profiles, capabilities: parseCapabilityRegistry({version: 1}), permissionMode: 'ask' as const}
  assert.throws(() => createAcpProjectTransport(options, binding), (error: unknown) => error instanceof CodexTransportError && error.code === 'resume_unavailable')
  const deepseek = Object.keys(profiles).find(id => id.startsWith('deepseek:'))!
  assert.throws(() => createAcpProjectTransport(options, {...binding, profileId: deepseek}), /resume_unavailable/u)
})

test('an ACP resume refusal (-32002) keeps the session ready for an explicit retry', async () => {
  const value = await fixture({defaultBackend: () => ({backend_id: 'opencode', backend_profile_id: 'opencode:default'})})
  try {
    await run(value, 'first', {title: 'Task', session: 'new'})
    const workspace = await value.store.resolveWorkspace('alpha')
    value.factory.reportThread = false
    value.factory.nextOutcome = {classification: 'refused', code: 'resume_unavailable', turnStartWritten: false, completion: null}
    const refused = await run(value, 'continue', {session: 'latest'})
    assert.equal(refused.content.code, 'resume_unavailable')
    const session = await value.store.resolveSession(workspace.workspace_id, 'Task')
    assert.equal(session.state, 'ready')
    assert.equal(session.backend_id, 'opencode')
    value.factory.reportThread = true
    value.factory.nextOutcome = {classification: 'completed', code: 'completed', turnStartWritten: true,
      completion: {status: 'completed', final_text: 'done', internal_activity: 1}}
    assert.equal((await run(value, 'retry', {session: 'latest'})).outcome, 'ok')
    assert.equal(value.factory.bindings.at(-1)?.resumeThreadId, session.backend_session_id)
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

function projectHost(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nova-coding-routing-')))
  const binary = join(root, 'codex-host')
  const workspace = join(root, 'workspace')
  const managedRoot = join(root, 'managed')
  const stateRoot = join(root, 'state')
  writeFileSync(binary, '#!/fixture\n', {mode: 0o700})
  chmodSync(binary, 0o700)
  for (const path of [workspace, managedRoot, stateRoot]) { mkdirSync(path, {mode: 0o700}); chmodSync(path, 0o700) }
  t.after(() => { rmSync(root, {recursive: true, force: true}) })
  const config = resolveCodexHostConfig(loadSettings({EXECUTOR: 'codex', CODEX_WORKSPACE: workspace,
    CODEX_MANAGED_ROOT: managedRoot, CODEX_PROJECT_STATE_ROOT: stateRoot, CODEX_PREWARM: 'false'}), {
    canonicalBinaries: [binary], canonicalWorkspaces: [workspace], defaultBinary: binary, homeDirectory: root,
  })
  assert.ok(config !== null)
  return {config, stateRoot, managedRoot, workspace}
}

test('one coding executor routes Codex sessions to app-server and others to ACP by bound backend', async t => {
  const {config, stateRoot, managedRoot} = projectHost(t)
  const codexBindings: unknown[] = []
  const acpBindings: AcpProjectBinding[] = []
  const resource = await createCodexAssemblyResource({
    config, composition: 'realtime', clock: new VirtualClock(), idFactory: () => 'routing-id',
    projectHost: {nativeLocks: new DescriptorLockAuthority(), rootFiles: new DescriptorRelativeRootFileAuthority([stateRoot, managedRoot])},
    transportFactory: {available: true, create: binding => { codexBindings.push(binding); return new ProjectTransport(`codex-${codexBindings.length}`) }},
    backends: {
      initialBackend: 'opencode',
      defaultProfile: backend => `${backend}:source-v1:${'b'.repeat(64)}`,
      displayName: () => 'OpenCode',
      create: binding => { acpBindings.push(binding); return new ProjectTransport(binding.resumeSessionId ?? `acp-${acpBindings.length}`) },
    },
  })
  try {
    assert.deepEqual(resource.adapter.manifest.roles, ['coding'])
    const adapter = resource.adapter as ProjectCodexAdapter
    const dispatch = async (workOrder: string, session: 'new' | 'latest') => {
      const request = {...runRequest(workOrder, {project: 'workspace'}), session}
      return await adapter.dispatch('run', request, context('run', request, new VirtualClock(), {delegateId: `delegate-${workOrder}`}))
    }
    const startupCalls = codexBindings.length
    const first = await dispatch('first', 'new')
    assert.equal(first.outcome, 'ok', JSON.stringify(first.content))
    assert.equal(acpBindings.length, 1)
    assert.equal(acpBindings[0]?.backendId, 'opencode')
    assert.equal(acpBindings[0]?.resumeSessionId, null)
    assert.equal(codexBindings.length, startupCalls)
    resource.updateDefaultBackend?.('codex')
    const again = await dispatch('again', 'latest')
    assert.equal(again.outcome, 'ok', JSON.stringify(again.content))
    assert.equal(acpBindings.length, 2, 'the resumed session keeps its ACP binding after the default changed')
    assert.equal(acpBindings[1]?.resumeSessionId, 'acp-1')
    const fresh = await dispatch('fresh', 'new')
    assert.equal(fresh.outcome, 'ok', JSON.stringify(fresh.content))
    assert.equal(codexBindings.length, startupCalls + 1)
    assert.throws(() => resource.updateDefaultBackend?.('unknown' as never), /invalid_coding_backend/u)
    const reader = await ProjectStore.open(await storeOptions(stateRoot, managedRoot))
    try { assert.deepEqual((await reader.snapshot()).sessions.map(row => row.backend_id).sort(), ['codex', 'opencode']) }
    finally { await reader.close() }
  } finally { await resource.close() }
})

async function storeOptions(stateRoot: string, managedRoot: string) {
  const {hostManagedProjectRootForTest, hostProjectRootForTest} = await import('../src/projects/project-store.js')
  return {stateRoot: hostProjectRootForTest(stateRoot), managedRoot: hostManagedProjectRootForTest(managedRoot),
    nativeLocks: new DescriptorLockAuthority(), rootFiles: new DescriptorRelativeRootFileAuthority([stateRoot, managedRoot])}
}

test('host routing exposes catalog names and default source profiles without launching anything', () => {
  const routing = createAcpBackendRouting({initialBackend: 'pi', environment: {HOME: '/home/user1'},
    capabilities: parseCapabilityRegistry({version: 1}), approvalMode: 'ask'})
  assert.equal(routing.initialBackend, 'pi')
  assert.equal(routing.displayName('deepseek'), 'DeepSeek Harness')
  assert.match(routing.defaultProfile('opencode'), /^opencode:source-v1:[a-f0-9]{64}$/u)
})
