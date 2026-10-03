import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {copyFile, mkdir, mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import test from 'node:test'

test('source launchers can discover Codex before dependencies and runtime are built', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-client-bootstrap-'))
  try {
    for (const file of ['scripts/start-client.mjs', 'scripts/start-client-demo.mjs',
      'clients/desktop/src/main/codex-discovery.mjs']) {
      const target = join(root, file)
      await mkdir(dirname(target), {recursive: true})
      await copyFile(new URL(`../../../${file}`, import.meta.url), target)
    }
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import {resolveClientCodexBinary, planClientLaunch} from './scripts/start-client.mjs';
      await import('./scripts/start-client-demo.mjs');
      assert.equal(resolveClientCodexBinary({platform: 'linux', home: '/home/nova',
        pathValue: '/tools', canonicalize: path => path}), '/tools/codex');
      const plan = planClientLaunch({argv: [], env: {}, platform: 'linux', rootDir: '/repo',
        nodeExecutable: '/bin/node', npmCli: '/npm/cli.js', dependenciesInstalled: false});
      assert.deepEqual(plan[0].args, ['/npm/cli.js', 'ci']);
      assert.deepEqual(plan[2].args, ['/npm/cli.js', 'run', 'build']);
    `], {cwd: root, encoding: 'utf8', timeout: 10_000})
    assert.equal(result.status, 0, result.stderr || String(result.error))
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})
