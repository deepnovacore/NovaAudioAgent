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

test('desktop entry reaches coding-disabled composition without importing or constructing Codex', () => {
  const target = new URL('../src/desktop-entry.js', import.meta.url).href
  const desktop = `export async function runDesktopEntryWithStopSources({construct}) {
    try { await construct({own() {}}); throw new Error('missing composition'); }
    catch (error) { if (error.message !== 'disabled-composition-reached') throw error; }
    process.stdout.write('disabled-composition-reached'); return 0;
  }
  export function buildDesktopRealtimeComposition() { throw new Error('disabled-composition-reached'); }`
  const config = `export function loadSettings() { return {executors: ['codex']}; }`
  const registry = `export function loadCapabilityRegistry() { return {modules: {coding: {enabled: false}}, overrides: [], mcpServers: {}, serverStatuses: []}; }`
  const telemetry = `export function createRealtimeTelemetry() { return {close() {}}; }`
  const replacements = {'./desktop-service.js': desktop, './config.js': config, './capability-registry.js': registry, './realtime/telemetry.js': telemetry}
  const hook = `export async function resolve(specifier, context, next) {
    const replacements = ${JSON.stringify(replacements)};
    if (context.parentURL?.endsWith('/desktop-entry.js') && replacements[specifier]) {
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
