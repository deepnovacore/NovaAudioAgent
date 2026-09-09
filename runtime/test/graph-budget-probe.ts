import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {chmodSync, mkdtempSync, realpathSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

/** A failed implementation can leak a Worker; isolate it so the red test cannot strand the test runner. */
export function assertBudgetRejectsBeforeGraphWorker(pipeline: 'qwen' | 'cascaded'): void {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'nova-budget-graph-')))
  chmodSync(directory, 0o700)
  try {
    const configUrl = new URL('../src/config.js', import.meta.url).href
    const registryUrl = new URL('../src/capability-registry.js', import.meta.url).href
    const assemblyUrl = new URL(`../src/${pipeline}-realtime-assembly.js`, import.meta.url).href
    const builder = pipeline === 'qwen' ? 'buildQwenRealtimeAssembly' : 'buildCascadedRealtimeAssembly'
    const script = `
      import {loadSettings} from ${JSON.stringify(configUrl)};
      import {parseCapabilityRegistry} from ${JSON.stringify(registryUrl)};
      import {${builder}} from ${JSON.stringify(assemblyUrl)};
      const settings = loadSettings({
        NOVA_AUDIO_AGENT_PIPELINE_MODE: ${JSON.stringify(pipeline === 'qwen' ? 'integrated' : 'cascaded')},
        DASHSCOPE_API_KEY: 'fixture-only', DOUBAO_BIGMODEL_API_KEY: 'fixture-only',
        NOVA_AUDIO_AGENT_WORKSPACE_GRAPH_ENABLED: 'true',
        NOVA_AUDIO_AGENT_WORKSPACE_GRAPH_PATH: ${JSON.stringify(join(directory, 'graph.sqlite'))}
      });
      const capabilities = parseCapabilityRegistry({version: 1, frontbrainToolBudget: 1, modules: {search: {enabled: false}}});
      const ports = () => process.getActiveResourcesInfo().filter(value => value === 'MessagePort').length;
      const before = ports();
      let failure;
      let views = 0;
      try { ${builder}({settings, capabilities, providerToolView: tools => { views++; return tools; }}); }
      catch (error) { failure = {code: error.code, count: error.toolCount, budget: error.toolBudget}; }
      process.stdout.write(JSON.stringify({before, after: ports(), failure, views}));
      process.exit(0);
    `
    // This cap includes cold ESM loading on a busy host; graph ownership is asserted below.
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {encoding: 'utf8', timeout: 15_000})
    assert.equal(child.status, 0, `graph probe failed: ${child.error?.message ?? child.signal ?? 'nonzero exit'}\n${child.stderr}`)
    const result = JSON.parse(child.stdout) as {before: number; after: number; failure: unknown; views: number}
    assert.deepEqual(result.failure, {code: 'frontbrain_tool_budget_exceeded', count: 5, budget: 1})
    assert.equal(result.views, 1)
    assert.equal(result.after, result.before, `${pipeline} budget rejection leaked a graph Worker MessagePort`)
  } finally { rmSync(directory, {recursive: true, force: true}) }
}
