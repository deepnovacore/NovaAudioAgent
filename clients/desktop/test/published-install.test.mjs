import assert from 'node:assert/strict'
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, delimiter} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
import {test} from 'node:test'

test('published installation retries only the missing requested version, with a five-attempt limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-install-retry-'))
  try {
    await writeFile(join(root, 'npm'), `#!/bin/bash
count=0; test ! -f "$NOVA_TEST_COUNT" || count=$(cat "$NOVA_TEST_COUNT")
count=$((count+1)); echo "$count" > "$NOVA_TEST_COUNT"
case "$NOVA_TEST_MODE" in
  success) exit 0;;
  late) if test "$count" -eq 3; then exit 0; fi;;
  auth) echo 'npm error code E401'; exit 1;;
  other) echo 'npm error code E404'; echo 'missing unrelated-dependency@1'; exit 1;;
esac
echo 'npm error code ETARGET'; echo 'No matching version found for nova-audio-agent-server@0.3.1'; exit 1
`, {mode: 0o700})
    await writeFile(join(root, 'sleep'), '#!/bin/bash\nexit 0\n', {mode: 0o700})
    for (const [mode, attempts, status] of [['success',1,0],['late',3,0],['missing',5,1],['auth',1,1],['other',1,1]]) {
      const counter = join(root, `${mode}.count`)
      const result = spawnSync('bash', [fileURLToPath(new URL('../../../scripts/install-published-package.sh', import.meta.url)), 'nova-audio-agent-server@0.3.1', join(root, mode)], {
        env: {...process.env, PATH: `${root}${delimiter}${process.env.PATH}`, NOVA_TEST_MODE: mode, NOVA_TEST_COUNT: counter}, encoding: 'utf8',
      })
      assert.equal(result.status, status, `${mode}: ${result.stderr}`)
      assert.equal(Number(await readFile(counter, 'utf8')), attempts, mode)
    }
  } finally {await rm(root, {recursive: true, force: true})}
})
