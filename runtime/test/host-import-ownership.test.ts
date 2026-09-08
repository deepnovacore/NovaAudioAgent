import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {test} from 'node:test'

/** Exercise Node's actual ESM closure; fail even if a concrete resource factory is never called. */
for (const entry of ['index', 'desktop', 'production-realtime-assembly']) {
  test(`generic ${entry} import does not load the concrete coding package`, () => {
    const target = new URL(`../src/${entry}.js`, import.meta.url).href
    const hook = `export async function resolve(specifier, context, next) {
      const result = await next(specifier, context);
      if (result.url.includes('/executors/codex/')) throw new Error('eager concrete coding import: ' + result.url);
      return result;
    }`
    const script = `import {register} from 'node:module';
      register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(hook)}), import.meta.url);
      await import(${JSON.stringify(target)});`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {encoding: 'utf8'})
    assert.equal(result.status, 0, result.stderr)
  })
}

test('desktop entry exits with its startup failure code after bounded cleanup', () => {
  const target = new URL('../src/desktop-entry.js', import.meta.url).href
  const replacements = {
    // Measure the exit boundary after module loading, not Windows cold-start I/O.
    './desktop-service.js': `export async function runDesktopEntryWithStopSources() {
      setInterval(() => {}, 1000);
      setTimeout(() => process.exit(99), 2000);
      return 2;
    }
      export function buildDesktopRealtimeComposition() { throw new Error('not reached'); }`,
  }
  const hook = `export async function resolve(specifier, context, next) {
    const replacements = ${JSON.stringify(replacements)};
    if (context.parentURL?.endsWith('/desktop-entry.js') && replacements[specifier]) {
      return {url: 'data:text/javascript,' + encodeURIComponent(replacements[specifier]), shortCircuit: true};
    }
    return next(specifier, context);
  }`
  const script = `import {register} from 'node:module';
    register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(hook)}), import.meta.url);
    await import(${JSON.stringify(target)});`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {encoding: 'utf8', timeout: 20_000})
  assert.equal(result.status, 2, result.stderr)
})

test('desktop entry reaches coding-disabled composition without importing or constructing Codex', () => {
  const target = new URL('../src/desktop-entry.js', import.meta.url).href
  const desktop = `export async function runDesktopEntryWithStopSources({construct}) {
    try { await construct({own() {}}); throw new Error('missing composition'); }
    catch (error) { if (error.message !== 'disabled-composition-reached') throw error; }
    process.stdout.write('disabled-composition-reached'); return 0;
  }
  export function buildDesktopRealtimeComposition() { throw new Error('disabled-composition-reached'); }`
  const configUrl = new URL('../src/config.js', import.meta.url).href
  const config = `import {loadSettings as load} from ${JSON.stringify(configUrl)};
    export {requireIntegratedRealtime} from ${JSON.stringify(configUrl)};
    export function loadSettings() { return {...load({DASHSCOPE_API_KEY: 'fixture'}), executors: ['codex']}; }`
  const registry = `export function loadCapabilityRegistry() { return {modules: {coding: {enabled: false}, knowledge: {enabled: false}}, overrides: [], mcpServers: {}, serverStatuses: []}; }`
  const telemetry = `export function createRealtimeTelemetry() { return {close() {}}; }`
  const replacements = {'./desktop-service.js': desktop, './config.js': config, './capability-registry.js': registry, './realtime/telemetry.js': telemetry}
  const hook = `export async function resolve(specifier, context, next) {
    const replacements = ${JSON.stringify(replacements)};
    if (['/desktop-entry.js', '/production-composition.js'].some(path => context.parentURL?.endsWith(path)) && replacements[specifier]) {
      return {url: 'data:text/javascript,' + encodeURIComponent(replacements[specifier]), shortCircuit: true};
    }
    const result = await next(specifier, context);
    if (result.url.includes('/executors/codex/')) throw new Error('eager concrete coding import: ' + result.url);
    return result;
  }`
  const script = `import {register} from 'node:module';
    register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(hook)}), import.meta.url);
    await import(${JSON.stringify(target)});`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {encoding: 'utf8'})
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'disabled-composition-reached')
})

test('actual desktop entry passes prepared external and knowledge MCP into the concrete resource', () => {
  const target = new URL('../src/desktop-entry.js', import.meta.url).href
  const managedModule = new URL('../src/executors/codex/managed-mcp.js', import.meta.url).href
  const registryModule = new URL('../src/capability-registry.js', import.meta.url).href
  const desktop = `export async function runDesktopEntryWithStopSources({construct}) {
    try { await construct({own() {}}); throw new Error('missing boundary'); }
    catch (error) { if (error.message !== 'managed-resource-reached') throw error; }
    process.stdout.write('managed-resource-reached'); return 0;
  }
  export function buildDesktopRealtimeComposition() { throw new Error('unexpected composition'); }`
  const host = `export {prepareManagedCodexMcp} from ${JSON.stringify(managedModule)};
    export function createProductionCodexHost() { return {catalog: {}, transportFactory: {}, projectHost: null}; }
    export function resolveCodexHostConfig() { return {}; }
    export function createCodexAssemblyResource({managedMcp}) {
      if (JSON.stringify(managedMcp.servers.docs.enabled_tools) !== '["look-up.raw"]') throw new Error('missing managed allowlist');
      if (Object.keys(managedMcp.servers).sort().join() !== 'docs,nova_knowledge') throw new Error('missing knowledge or host server leak');
      if (JSON.stringify(managedMcp.servers.nova_knowledge.enabled_tools) !== '["recall"]') throw new Error('missing knowledge allowlist');
      throw new Error('managed-resource-reached');
    }`
  const registry = `import {parseCapabilityRegistry} from ${JSON.stringify(registryModule)};
    export function loadCapabilityRegistry() { return parseCapabilityRegistry({version: 1, mcpServers: {docs: {transport: 'stdio', command: '/usr/bin/false', tools: {'look-up.raw': {enabled: true}}}}}); }`
  const knowledge = `export async function prepareKnowledge() { return {close() {}, service: {handle() {}},
      codexEntries: {nova_knowledge: {enabled: true, exposeTo: {frontbrain: false, codex: true},
        transport: 'streamable-http', url: 'http://127.0.0.1:19888/mcp', headers: {},
        tools: {recall: {enabled: true, timeoutMs: 8000, maxResultBytes: 32768, maxCallsPerTurn: 2}}}}}; }`
  const configUrl = new URL('../src/config.js', import.meta.url).href
  const replacements = {'./knowledge/assembly.js': knowledge, './desktop-service.js': desktop, './config.js': `import {loadSettings as load} from ${JSON.stringify(configUrl)}; export {requireIntegratedRealtime} from ${JSON.stringify(configUrl)}; export function loadSettings() { return {...load({DASHSCOPE_API_KEY: 'fixture'}), executors: ['codex']}; }`, './capability-registry.js': registry, './realtime/telemetry.js': `export function createRealtimeTelemetry() { return {close() {}}; }`, './executors/codex/host.js': host}
  const hook = `export async function resolve(specifier, context, next) {
    const replacements = ${JSON.stringify(replacements)};
    if (['/desktop-entry.js', '/production-composition.js'].some(path => context.parentURL?.endsWith(path)) && replacements[specifier]) return {url: 'data:text/javascript,' + encodeURIComponent(replacements[specifier]), shortCircuit: true};
    return next(specifier, context);
  }`
  const script = `import {register} from 'node:module'; register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(hook)}), import.meta.url); await import(${JSON.stringify(target)});`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {encoding: 'utf8'})
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'managed-resource-reached')
})

test('actual desktop entry preserves production provider usage through private IPC', () => {
  const target = new URL('../src/desktop-entry.js', import.meta.url).href
  const configUrl = new URL('../src/config.js', import.meta.url).href
  const registryUrl = new URL('../src/capability-registry.js', import.meta.url).href
  const report = {id: 'usage-production', provider: 'qwen', service: 'realtime', model: 'qwen-audio-3.0-realtime-plus', status: 'complete', inputTokens: 12, outputTokens: 9,
    inputTextTokens: 5, inputAudioTokens: 7, outputTextTokens: 3, outputAudioTokens: 6}
  const replacements = {
    './desktop-service.js': `export async function runDesktopEntryWithStopSources({construct}) {
      try { await construct({own() {}}); throw new Error('missing provider boundary'); }
      catch (error) { if (error.message !== 'usage-provider-reached') throw error; }
      return 0;
    }
    export function buildDesktopRealtimeComposition({buildRealtime}) { return buildRealtime({}, {}); }`,
    './config.js': `import {loadSettings as load} from ${JSON.stringify(configUrl)};
      export {requireIntegratedRealtime} from ${JSON.stringify(configUrl)};
      export function loadSettings() { return load({DASHSCOPE_API_KEY: 'fixture', NOVA_AUDIO_AGENT_PIPELINE_MODE: 'integrated'}); }`,
    './capability-registry.js': `import {parseCapabilityRegistry} from ${JSON.stringify(registryUrl)};
      export function loadCapabilityRegistry() { return parseCapabilityRegistry({version: 1, modules: {coding: {enabled: false}, knowledge: {enabled: false}, search: {enabled: false}, camera: {enabled: false}}}); }`,
    './realtime/telemetry.js': `export function createRealtimeTelemetry() { return {close() {}}; }`,
  }
  const provider = `export class QwenAudioRealtimeAdapter {
    constructor(options) { options.onUsage(${JSON.stringify(report)}); throw new Error('usage-provider-reached'); }
  }`
  const hook = `export async function resolve(specifier, context, next) {
    const replacements = ${JSON.stringify(replacements)};
    if (['/desktop-entry.js', '/production-composition.js'].some(path => context.parentURL?.endsWith(path)) && replacements[specifier]) {
      return {url: 'data:text/javascript,' + encodeURIComponent(replacements[specifier]), shortCircuit: true};
    }
    if (context.parentURL?.endsWith('/qwen-realtime-assembly.js') && specifier === './realtime/qwen.js') {
      return {url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(provider)}), shortCircuit: true};
    }
    return next(specifier, context);
  }`
  const script = `import {register} from 'node:module'; import {EventEmitter} from 'node:events';
    const frames = []; process.parentPort = Object.assign(new EventEmitter(), {postMessage: frame => frames.push(frame)});
    register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(hook)}), import.meta.url);
    await import(${JSON.stringify(target)});
    process.stdout.write(JSON.stringify(frames));`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {encoding: 'utf8', timeout: 20_000})
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), [{type: 'nova.usage', report: {...report, pricingRegion: 'cn-beijing'}}])
})
