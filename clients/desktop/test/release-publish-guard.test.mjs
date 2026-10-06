import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'

test('release commands publish previews without moving stable npm or GitHub latest', {skip:process.platform==='win32'}, async () => {
  const root=await mkdtemp(join(tmpdir(),'nova-publish-channel-'))
  try {
    const workflow=await readFile(new URL('../../../.github/workflows/release-publish.yml',import.meta.url),'utf8')
    const script=workflow.split('      - name: Create GitHub release, publish npm package, and verify propagation')[1].split('        run: |\n')[1].split("          published=''")[0].replace(/^          /gm,'')
    for(const tool of ['gh','npm'])await writeFile(join(root,tool),`#!/usr/bin/env node\nrequire('node:fs').appendFileSync(process.env.CALLS,JSON.stringify([${JSON.stringify(tool)},...process.argv.slice(2)])+'\\n')\n`,{mode:0o755})
    for(const [version,tag] of [['0.3.0-preview.1','preview'],['0.3.0','latest']]) {
      const calls=join(root,`${tag}.jsonl`)
      const result=spawnSync('bash',['-c',`find() { echo /tmp/nova-test.tgz; }; realpath() { echo "$1"; };\n${script}`],{
        cwd:fileURLToPath(new URL('../../../',import.meta.url)),encoding:'utf8',
        env:{...process.env,PATH:`${root}:${process.env.PATH}`,CALLS:calls,RELEASE_VERSION:version,EXPECTED_COMMIT:'a'.repeat(40)},
      })
      assert.equal(result.status,0,result.stderr)
      const commands=(await readFile(calls,'utf8')).trim().split('\n').map(JSON.parse)
      const release=commands.find(args=>args[0]==='gh')
      assert.equal(release.includes('--prerelease'),tag==='preview')
      assert.ok(release.includes(tag==='preview'?'--latest=false':'--latest'))
      const publishes=commands.filter(args=>args[0]==='npm'&&args[1]==='publish')
      assert.equal(publishes.length,2)
      for(const args of publishes)assert.equal(args[args.indexOf('--tag')+1],tag)
    }
  } finally {await rm(root,{recursive:true,force:true})}
})

test('publishing requires a candidate that is already an ancestor of main, verified before npm publish', async () => {
  const publish = await readFile(new URL('../../../.github/workflows/release-publish.yml', import.meta.url), 'utf8')
  assert.ok(publish.includes('git merge-base --is-ancestor "$EXPECTED_COMMIT" origin/main'))
  assert.ok(publish.includes('test "$EXPECTED_COMMIT" = "$(git rev-parse HEAD)"'))
  assert.ok(publish.indexOf('git merge-base --is-ancestor') < publish.indexOf('npm publish'))
  assert.ok(publish.indexOf('npm whoami') < publish.indexOf('npm publish'))
})

test('candidate packaging stays gated on the full test matrix', async () => {
  const workflow = await readFile(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8')
  assert.match(workflow, /needs: \[electron\]/u)
})
