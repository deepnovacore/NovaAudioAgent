import assert from 'node:assert/strict'
import {test} from 'node:test'
import {ACP_BACKENDS, resolveAcpLaunch, type AcpBackendId} from '../src/executors/acp/backends.js'
import {ACP_BACKEND_IDS, CODING_BACKEND_IDS} from '../src/config/coding-backends.js'

const base = {cwd: '/tmp/project with spaces', permissionMode: 'ask' as const, env: {}}

test('catalog cannot be mutated to change launch and permission policy', () => {
  assert.equal(Object.isFrozen(ACP_BACKENDS), true)
  for (const backend of ACP_BACKENDS) {
    assert.equal(Object.isFrozen(backend), true)
    assert.equal(Object.isFrozen(backend.limitations), true)
  }
})

test('Codex is a coding backend but never an ACP launch target', () => {
  assert.deepEqual(CODING_BACKEND_IDS, ['codex', 'opencode', 'codebuddy', 'pi', 'deepseek'])
  assert.deepEqual(ACP_BACKENDS.map(({id}) => id), [...ACP_BACKEND_IDS])
  assert.equal(ACP_BACKENDS.some(({id}) => (id as string) === 'codex'), false)
  assert.throws(() => resolveAcpLaunch({...base, backendId: 'codex' as never}), /Unknown ACP backend/u)
})

test('catalog and argv expose exactly the four approved ACP backends', () => {
  const expected: Record<AcpBackendId, [string, string[]]> = {
    opencode: ['opencode', ['acp']],
    codebuddy: ['codebuddy', ['--acp', '--permission-mode', 'default']],
    pi: ['pi-acp', []], deepseek: ['dsh', ['--profile', 'acp']],
  }
  for (const id of ACP_BACKEND_IDS) {
    const launch = resolveAcpLaunch({...base, backendId: id, permissionMode: id === 'pi' ? 'full' : 'ask'})
    assert.deepEqual([launch.command, launch.args], expected[id])
    assert.equal(launch.env.PWD, base.cwd)
  }
})

test('permission intent overrides inherited launch policy and Pi fails closed for ask', () => {
  assert.throws(() => resolveAcpLaunch({...base, backendId: 'pi'}), /Pi.*approval/u)
  assert.equal(resolveAcpLaunch({...base, backendId: 'opencode', env: {OPENCODE_PERMISSION: '{"*":"allow"}'}}).env.OPENCODE_PERMISSION, '{"*":"ask"}')
  assert.equal(resolveAcpLaunch({...base, backendId: 'opencode', permissionMode: 'full'}).env.OPENCODE_PERMISSION, '{"*":"allow"}')
  assert.deepEqual(resolveAcpLaunch({...base, backendId: 'codebuddy', permissionMode: 'full'}).args, ['--acp', '--dangerously-skip-permissions'])
})

test('host-approved overrides stay one argv token and parent binaries are adapter-specific', () => {
  const binaryPath = '/tmp/tools with spaces/acp'
  assert.equal(resolveAcpLaunch({...base, backendId: 'opencode', binaryPath}).command, binaryPath)
  assert.equal(resolveAcpLaunch({...base, backendId: 'pi', permissionMode: 'full', parentExecutable: '/opt/bin/pi'}).env.PI_ACP_PI_COMMAND, '/opt/bin/pi')
  assert.throws(() => resolveAcpLaunch({...base, backendId: 'opencode', parentExecutable: '/bin/sh'}), /parentExecutable/u)
})

test('invalid backend, modes, paths and NUL values never become process input', () => {
  for (const change of [
    {backendId: 'claude'}, {backendId: '__proto__'}, {permissionMode: 'auto'},
    {cwd: 'relative'}, {cwd: '/tmp/\0bad'}, {binaryPath: ''},
    {binaryPath: 'npx -y attacker'}, {binaryPath: '/bin/tool\n--evil'},
    {parentExecutable: 'pi'}, {env: {HOME: '/home/\0bad'}},
  ]) {
    assert.throws(() => resolveAcpLaunch({...base, backendId: 'opencode', ...change} as Parameters<typeof resolveAcpLaunch>[0]))
  }
})

test('environment projection preserves native homes but excludes other backend and host secrets', () => {
  const env = {
    HOME: '/home/user', PATH: '/opt/bin:/usr/bin', CODEX_HOME: '/home/user/codex-session',
    CODEX_API_KEY: 'codex-secret', OPENAI_API_KEY: 'openai-secret', CODEBUDDY_API_KEY: 'buddy-secret', DEEPSEEK_API_KEY: 'deepseek-secret',
    PI_CODING_AGENT_DIR: '/home/user/pi', OPENCODE_CONFIG: '/home/user/opencode.json',
    NOVA_TOKEN: 'private', NODE_OPTIONS: '--require /tmp/inject.js', npm_config_token: 'private',
    PI_ACP_PI_COMMAND: '/tmp/unapproved',
  }
  const original = {...env}
  for (const id of ACP_BACKEND_IDS) {
    const projected = resolveAcpLaunch({...base, backendId: id, permissionMode: 'full', env}).env
    assert.equal(projected.HOME, env.HOME)
    assert.equal(projected.PATH, env.PATH)
    for (const key of ['NOVA_TOKEN', 'NODE_OPTIONS', 'npm_config_token', 'PI_ACP_PI_COMMAND', 'CODEX_HOME', 'CODEX_API_KEY', 'OPENAI_API_KEY']) {
      assert.equal(projected[key], undefined, `${id}: ${key}`)
    }
    for (const [owner, key] of [['codebuddy', 'CODEBUDDY_API_KEY'], ['deepseek', 'DEEPSEEK_API_KEY'], ['pi', 'PI_CODING_AGENT_DIR'], ['opencode', 'OPENCODE_CONFIG']] as const) {
      assert.equal(projected[key], id === owner ? env[key] : undefined)
    }
  }
  assert.deepEqual(env, original)
})
