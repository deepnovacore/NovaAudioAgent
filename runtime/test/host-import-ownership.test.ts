import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {test} from 'node:test'

/** Exercise Node's actual ESM closure; fail even if a concrete resource factory is never called. */
for (const entry of ['index', 'desktop', 'cascaded-realtime-assembly']) {
  test(`generic ${entry} import does not load the concrete coding package`, () => {
    const target = new URL(`../src/${entry === 'cascaded-realtime-assembly' ? 'composition/' : ''}${entry}.js`, import.meta.url).href
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
    [new URL('../src/desktop/desktop-session.js', import.meta.url).href]: `export async function runDesktopEntryWithStopSources() {
      setInterval(() => {}, 1000);
      setTimeout(() => process.exit(99), 2000);
      return 2;
    }
      export function buildDesktopRealtimeComposition() { throw new Error('not reached'); }`,
  }
  const hook = `export async function resolve(specifier, context, next) {
    const replacements = ${JSON.stringify(replacements)};
    if (context.parentURL?.endsWith('/desktop-entry.js') && replacements[new URL(specifier, context.parentURL).href]) {
      return {url: 'data:text/javascript,' + encodeURIComponent(replacements[new URL(specifier, context.parentURL).href]), shortCircuit: true};
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
  const configUrl = new URL('../src/config/config.js', import.meta.url).href
  const config = `import {loadSettings as load} from ${JSON.stringify(configUrl)};
    export {renamedEnvironmentWarnings, requireBlockingCredentials, requireIntegratedRealtime, withoutUncredentialedModules} from ${JSON.stringify(configUrl)};
    export function loadSettings() { return {...load({DASHSCOPE_API_KEY: 'fixture'}, true), executors: ['codex']}; }`
  const registry = `export function loadCapabilityRegistry() { return {modules: {camera: {enabled: false}, coding: {enabled: false}, knowledge: {enabled: false}}, overrides: [], mcpServers: {}, serverStatuses: []}; }`
  const telemetry = `export function createRealtimeTelemetry() { return {record() {}, close() {}}; }`
  const replacements = {[new URL('../src/desktop/desktop-session.js', import.meta.url).href]: desktop, [new URL('../src/config/config.js', import.meta.url).href]: config, [new URL('../src/config/capability-registry.js', import.meta.url).href]: registry, [new URL('../src/realtime/telemetry.js', import.meta.url).href]: telemetry}
  const hook = `export async function resolve(specifier, context, next) {
    const replacements = ${JSON.stringify(replacements)};
    if (['/desktop-entry.js', '/production-composition.js'].some(path => context.parentURL?.endsWith(path)) && replacements[new URL(specifier, context.parentURL).href]) {
      return {url: 'data:text/javascript,' + encodeURIComponent(replacements[new URL(specifier, context.parentURL).href]), shortCircuit: true};
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
  const registryModule = new URL('../src/config/capability-registry.js', import.meta.url).href
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
  const configUrl = new URL('../src/config/config.js', import.meta.url).href
  const replacements = {[new URL('../src/knowledge/assembly.js', import.meta.url).href]: knowledge, [new URL('../src/desktop/desktop-session.js', import.meta.url).href]: desktop, [new URL('../src/config/config.js', import.meta.url).href]: `import {loadSettings as load} from ${JSON.stringify(configUrl)}; export {renamedEnvironmentWarnings, requireBlockingCredentials, requireIntegratedRealtime, withoutUncredentialedModules} from ${JSON.stringify(configUrl)}; export function loadSettings() { return {...load({DASHSCOPE_API_KEY: 'fixture'}, true), executors: ['codex']}; }`, [new URL('../src/config/capability-registry.js', import.meta.url).href]: registry, [new URL('../src/realtime/telemetry.js', import.meta.url).href]: `export function createRealtimeTelemetry() { return {record() {}, close() {}}; }`, [new URL('../src/executors/codex/host.js', import.meta.url).href]: host}
  const hook = `export async function resolve(specifier, context, next) {
    const replacements = ${JSON.stringify(replacements)};
    if (['/desktop-entry.js', '/production-composition.js'].some(path => context.parentURL?.endsWith(path)) && replacements[new URL(specifier, context.parentURL).href]) return {url: 'data:text/javascript,' + encodeURIComponent(replacements[new URL(specifier, context.parentURL).href]), shortCircuit: true};
    return next(specifier, context);
  }`
  const script = `import {register} from 'node:module'; register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(hook)}), import.meta.url); await import(${JSON.stringify(target)});`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {encoding: 'utf8'})
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'managed-resource-reached')
})

test('actual desktop entry preserves production provider usage through private IPC', () => {
  const target = new URL('../src/desktop-entry.js', import.meta.url).href
  const configUrl = new URL('../src/config/config.js', import.meta.url).href
  const registryUrl = new URL('../src/config/capability-registry.js', import.meta.url).href
  const report = {id: 'usage-production', provider: 'qwen', service: 'llm', model: 'qwen-plus', status: 'complete', inputTokens: 12, outputTokens: 9,
    inputTextTokens: 5, inputAudioTokens: 7, outputTextTokens: 3, outputAudioTokens: 6}
  const replacements = {
    [new URL('../src/desktop/desktop-session.js', import.meta.url).href]: `export async function runDesktopEntryWithStopSources({construct}) {
      try { await construct({own() {}}); throw new Error('missing provider boundary'); }
      catch (error) { if (error.message !== 'usage-provider-reached') throw error; }
      return 0;
    }
    export function buildDesktopRealtimeComposition({buildRealtime}) { return buildRealtime({}, {}); }`,
    [new URL('../src/config/config.js', import.meta.url).href]: `import {loadSettings as load} from ${JSON.stringify(configUrl)};
      export {renamedEnvironmentWarnings, requireBlockingCredentials, requireIntegratedRealtime, withoutUncredentialedModules} from ${JSON.stringify(configUrl)};
      export function loadSettings() { return load({DASHSCOPE_API_KEY: 'fixture', PIPELINE_MODE: 'integrated'}, true); }`,
    [new URL('../src/config/capability-registry.js', import.meta.url).href]: `import {parseCapabilityRegistry} from ${JSON.stringify(registryUrl)};
      export function loadCapabilityRegistry() { return parseCapabilityRegistry({version: 1, modules: {camera: {enabled: false}, coding: {enabled: false}, knowledge: {enabled: false}, search: {enabled: false}, camera: {enabled: false}}}); }`,
    [new URL('../src/realtime/telemetry.js', import.meta.url).href]: `export function createRealtimeTelemetry() { return {record() {}, close() {}}; }`,
  }
  const provider = `export function createQwenCascadedLlmFactory(options) { options.onUsage(${JSON.stringify(report)}); throw new Error('usage-provider-reached'); }`
  const hook = `export async function resolve(specifier, context, next) {
    const replacements = ${JSON.stringify(replacements)};
    if (['/desktop-entry.js', '/production-composition.js'].some(path => context.parentURL?.endsWith(path)) && replacements[new URL(specifier, context.parentURL).href]) {
      return {url: 'data:text/javascript,' + encodeURIComponent(replacements[new URL(specifier, context.parentURL).href]), shortCircuit: true};
    }
    if (context.parentURL?.endsWith('/cascaded-realtime-assembly.js') && specifier === '../realtime/cascaded/qwen-llm.js') {
      return {url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(provider)}), shortCircuit: true};
    }
    return next(specifier, context);
  }`
  const script = `import {register} from 'node:module'; import {EventEmitter} from 'node:events'; import {writeSync} from 'node:fs';
    const frames = []; process.parentPort = Object.assign(new EventEmitter(), {postMessage: frame => frames.push(frame)});
    register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(hook)}), import.meta.url);
    process.once('exit', () => writeSync(1, JSON.stringify(frames)));
    await import(${JSON.stringify(target)});`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {encoding: 'utf8', timeout: 20_000})
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), [{type: 'nova.usage', report: {...report, pricingRegion: 'cn-beijing'}}])
})
