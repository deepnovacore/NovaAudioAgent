import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtempSync, readFileSync, statSync, chmodSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {EventEmitter, once} from 'node:events'
import {runDesktopEntry} from '../src/desktop-service.js'

// The same owner must run without an Electron readiness endpoint.
test('headless lifecycle starts and cleans up without a parent readiness endpoint', async () => {
  const stop = new AbortController()
  const calls: string[] = []
  const result = await runDesktopEntry({
    token: 'a'.repeat(32), stop,
    construct: () => ({
      realtime: {start: () => { calls.push('start'); return Promise.resolve() }, stop: () => { calls.push('stop'); return Promise.resolve() },
        service: {waitStopped: () => new Promise<void>(() => { /* Running until the external stop signal. */ })}},
      desktop: {server: {start: () => Promise.resolve({token: 'a'.repeat(32), host: '127.0.0.1', port: 19876}),
        close: () => { calls.push('close'); return Promise.resolve() }}},
    }),
    announce: () => { calls.push('ready'); stop.abort(); return Promise.resolve() },
    onDiagnostic: line => { calls.push(line) },
  })
  assert.equal(result, 0)
  assert.deepEqual(calls, ['start', 'ready', 'close', 'stop'])
})

test('token file is private, valid, never overwritten, and invalid config allocates nothing', async () => {
  const {initializeServerToken, loadServerConfig} = await import('../src/server-config.js')
  const {runServerEntry} = await import('../src/server-entry.js')
  const dir = mkdtempSync(join(tmpdir(), 'nova-server-'))
  const tokenFile = join(dir, 'token')
  try {
    initializeServerToken(tokenFile)
    const original = readFileSync(tokenFile, 'utf8')
    assert.match(original.trim(), /^[a-f0-9]{32}$/u)
    assert.equal(statSync(tokenFile).mode & 0o777, 0o600)
    assert.throws(() => initializeServerToken(tokenFile))
    assert.equal(readFileSync(tokenFile, 'utf8'), original)
    const env = {NOVA_AUDIO_AGENT_SERVER_TOKEN_FILE: tokenFile, NOVA_AUDIO_AGENT_SERVER_PORT: '19876'}
    assert.deepEqual(loadServerConfig(env), {port: 19876, token: original.trim(), mediaMode: 'relay'})
    assert.equal(loadServerConfig({...env, NOVA_AUDIO_AGENT_SERVER_MEDIA_MODE: 'aoq_chat'}).mediaMode, 'aoq_chat')
    assert.equal(loadServerConfig({...env, NOVA_AUDIO_AGENT_SERVER_MEDIA_MODE: 'aoq_runtime'}).mediaMode, 'aoq_runtime')
    assert.throws(() => loadServerConfig({...env, NOVA_AUDIO_AGENT_SERVER_MEDIA_MODE: 'unknown'}))
    for (const port of ['', '0', '-1', '65536', '1.5', '12x']) {
      let allocated = false
      const lines: string[] = []
      assert.equal(await runServerEntry({environment: {...env, NOVA_AUDIO_AGENT_SERVER_PORT: port},
        construct: () => { allocated = true; throw new Error('should not construct') },
        onDiagnostic: line => { lines.push(line) }, processEvents: new EventEmitter()}), 2)
      assert.equal(allocated, false)
      assert.equal(lines.join('').includes(original.trim()), false)
    }
    assert.throws(() => loadServerConfig({NOVA_AUDIO_AGENT_SERVER_PORT: '19876'}))
    assert.throws(() => loadServerConfig({...env, NOVA_AUDIO_AGENT_SERVER_TOKEN_FILE: 'relative'}))
    chmodSync(tokenFile, 0o644)
    assert.throws(() => loadServerConfig(env))
  } finally { rmSync(dir, {recursive: true, force: true}) }
})

test('server ignores IPC disconnect, stops on SIGTERM, and removes signal bindings', async () => {
  const {initializeServerToken} = await import('../src/server-config.js')
  const {runServerEntry} = await import('../src/server-entry.js')
  const dir = mkdtempSync(join(tmpdir(), 'nova-server-'))
  const tokenFile = join(dir, 'token')
  initializeServerToken(tokenFile)
  const events = new EventEmitter()
  const stop = new AbortController()
  const calls: string[] = []
  try {
    const result = await runServerEntry({
      environment: {NOVA_AUDIO_AGENT_SERVER_PORT: '19876', NOVA_AUDIO_AGENT_SERVER_TOKEN_FILE: tokenFile},
      processEvents: events, stop,
      onDiagnostic: line => {
        assert.equal(line.includes(readFileSync(tokenFile, 'utf8').trim()), false)
        if (line.startsWith('[server-ready]')) {
          assert.equal(line, '[server-ready] ws://127.0.0.1:19876/client/v1')
          events.emit('disconnect')
          assert.equal(stop.signal.aborted, false)
          events.emit('SIGTERM')
        }
      },
      construct: () => ({
        realtime: {service: {waitStopped: () => new Promise<void>(() => { /* Running until the external stop signal. */ })},
          start: () => { calls.push('start'); return Promise.resolve() }, stop: () => { calls.push('stop'); return Promise.resolve() }},
        desktop: {server: {start: () => Promise.resolve({token: 'a'.repeat(32), host: '127.0.0.1', port: 19876}),
          close: () => { calls.push('close'); return Promise.resolve() }}},
      }),
    })
    assert.equal(result, 0)
    assert.deepEqual(calls, ['start', 'close', 'stop'])
    assert.equal(events.listenerCount('SIGINT'), 0)
    assert.equal(events.listenerCount('SIGTERM'), 0)
  } finally { rmSync(dir, {recursive: true, force: true}) }
})

test('failed headless construction rolls resources back in reverse order', async () => {
  const calls: string[] = []
  assert.equal(await runDesktopEntry({token: 'a'.repeat(32), stop: new AbortController(),
    construct: ownership => {
      ownership.own(() => { calls.push('first') })
      ownership.own(() => { calls.push('second') })
      throw new Error('private failure')
    }, announce: () => Promise.reject(new Error('must not announce')),
    onDiagnostic: line => { assert.equal(line.includes('private failure'), false) },
  }), 2)
  assert.deepEqual(calls, ['second', 'first'])
})

test('remote ready audio contract rejects incompatible provider or sample rate before assembly', async () => {
  const {validateRemoteAudioSettings, remoteClientMedia} = await import('../src/server-config.js')
  const {settingsSchema} = await import('../src/config.js')
  assert.doesNotThrow(() => validateRemoteAudioSettings(settingsSchema.parse({executors: [], pipeline_mode: 'integrated'})))
  assert.doesNotThrow(() => validateRemoteAudioSettings(settingsSchema.parse({executors: [], pipeline_mode: 'cascaded'})))
  for (const pipeline_mode of ['integrated', 'cascaded']) {
    assert.equal(remoteClientMedia(settingsSchema.parse({executors: [], pipeline_mode})).pipeline, pipeline_mode)
  }
  assert.throws(() => validateRemoteAudioSettings(settingsSchema.parse({
    executors: [], pipeline_mode: 'cascaded', doubao_tts_output_sample_rate: 48_000,
  })))
})

for (const invalid of ['credential', 'endpoint', 'cascaded-credential'] as const) test(`invalid selected provider ${invalid} starts no external MCP resources`, async t => {
  const {McpConnection} = await import('../src/mcp-client.js')
  const {buildProductionComposition} = await import('../src/production-composition.js')
  const discover = t.mock.method(McpConnection.prototype, 'discover', () => Promise.reject(new Error('unexpected discovery')))
  const dir = mkdtempSync(join(tmpdir(), 'nova-server-config-'))
  const config = join(dir, 'capabilities.json')
  writeFileSync(config, JSON.stringify({version: 1, modules: {
    search: {enabled: false}, camera: {enabled: false}, coding: {enabled: false}, knowledge: {enabled: false},
  }, mcpServers: {probe: {transport: 'stdio', command: process.execPath,
    exposeTo: {frontbrain: true, codex: false}, tools: {}}}}))
  const previous = process.env
  const cleanups: (() => void | Promise<void>)[] = []
  process.env = {NOVA_AUDIO_AGENT_CAPABILITIES_CONFIG: config, NOVA_AUDIO_AGENT_REALTIME_TELEMETRY: '',
    NOVA_AUDIO_AGENT_PIPELINE_MODE: invalid === 'cascaded-credential' ? 'cascaded' : 'integrated',
    ...(invalid === 'endpoint' ? {DASHSCOPE_API_KEY: 'test-only', NOVA_AUDIO_AGENT_QWEN_REALTIME_URL: 'http://invalid.example'} : {}),
  }
  try {
    await assert.rejects(buildProductionComposition({token: 'a'.repeat(32), stop: new AbortController(), remote: true,
      ownership: {own: cleanup => { cleanups.push(cleanup); return () => { /* Failed construction is cleaned below. */ } }},
      onDiagnostic: () => { /* No raw diagnostic text is retained. */ },
    }), invalid === 'endpoint' ? /NOVA_AUDIO_AGENT_QWEN_REALTIME_URL/u : /DASHSCOPE_API_KEY/u)
    assert.equal(discover.mock.callCount(), 0, 'provider validation must precede MCP discovery')
    assert.equal(cleanups.length, 0, 'configuration failure must not allocate owned resources')
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup()
    process.env = previous
    rmSync(dir, {recursive: true, force: true})
  }
})

test('AOQ entry starts without loading the desktop/provider graph and closes on SIGTERM', {timeout: 5000}, async () => {
  const {execFile} = await import('node:child_process')
  const {promisify} = await import('node:util')
  const {createServer} = await import('node:net')
  const {initializeServerToken} = await import('../src/server-config.js')
  const dir = mkdtempSync(join(tmpdir(), 'nova-aoq-entry-'))
  const tokenFile = join(dir, 'token')
  initializeServerToken(tokenFile)
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const address = probe.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>(resolve => probe.close(() => resolve()))
  // A fresh module loader catches eager imports as well as accidental construction.
  const script = `
    import assert from 'node:assert/strict';
    import {registerHooks} from 'node:module';
    import {EventEmitter} from 'node:events';
    registerHooks({resolve(specifier, context, nextResolve) {
      if (/(desktop|production-composition|client-server|client-protocol|realtime-assembly|codex)/u.test(specifier)) throw new Error('forbidden graph import');
      return nextResolve(specifier, context);
    }});
    const {runServerEntry} = await import(${JSON.stringify(new URL('../src/server-entry.js', import.meta.url).href)});
    const events = new EventEmitter();
    let ready = false;
    const code = await runServerEntry({processEvents: events,
      construct: () => { throw new Error('must not construct runtime'); },
      onDiagnostic: line => {
        assert.ok(line.startsWith('[server-ready]'));
        ready = true;
        events.emit('SIGTERM');
      }});
    assert.equal(code, 0);
    assert.equal(ready, true);
    assert.equal(events.listenerCount('SIGTERM'), 0);
    assert.equal(events.listenerCount('SIGINT'), 0);
  `
  try {
    // In source-mode tests the same loader handles .js -> .ts; compiled tests need no loader.
    const sourceScript = import.meta.url.endsWith('.ts') ? script.replace('server-entry.js', 'server-entry.ts') : script
    await promisify(execFile)(process.execPath, [...process.execArgv, '--input-type=module', '-e', sourceScript], {
      env: {PATH: process.env.PATH, NOVA_AUDIO_AGENT_SERVER_TOKEN_FILE: tokenFile,
        NOVA_AUDIO_AGENT_SERVER_PORT: String(address.port), NOVA_AUDIO_AGENT_SERVER_MEDIA_MODE: 'aoq_chat', NOVA_AUDIO_AGENT_AOQ_API_HOST: 'llm-test.cn-beijing.maas.aliyuncs.com'},
    })
  } finally { rmSync(dir, {recursive: true, force: true}) }
})
