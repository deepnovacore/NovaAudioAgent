import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import test from 'node:test'

import {
  packagedLayout,
  parsePackagedCodexFailure,
} from '../scripts/run-packaged-codex-smoke.mjs'
import {releaseCandidateWorkspace} from '../scripts/run-release-candidate-codex-smoke.mjs'

test('packaged Codex smoke selects one fixed executable/resource layout per release tuple', async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'nova-packaged-codex-layout-')))
  const cases = [
    ['darwin', 'arm64', 'mac-arm64/Nova Audio Agent Ambient Orb.app/Contents/MacOS/Nova Audio Agent Ambient Orb', 'mac-arm64/Nova Audio Agent Ambient Orb.app/Contents/Resources'],
    ['darwin', 'x64', 'mac/Nova Audio Agent Ambient Orb.app/Contents/MacOS/Nova Audio Agent Ambient Orb', 'mac/Nova Audio Agent Ambient Orb.app/Contents/Resources'],
    ['win32', 'x64', 'win-unpacked/Nova Audio Agent Ambient Orb.exe', 'win-unpacked/resources'],
    ['linux', 'x64', 'linux-unpacked/nova-ambient-orb', 'linux-unpacked/resources'],
  ]
  try {
    for (const [platform, arch, executable, resources] of cases) {
      await mkdir(resolve(root, resources), {recursive: true})
      await mkdir(resolve(root, executable, '..'), {recursive: true})
      await writeFile(resolve(root, executable), 'candidate')
      assert.deepEqual(packagedLayout({distRoot: root, platform, arch}), {
        executable: resolve(root, executable),
        resourcesRoot: resolve(root, resources),
      })
    }
    assert.throws(
      () => packagedLayout({distRoot: root, platform: 'linux', arch: 'arm64'}),
      /packaged_codex_smoke_invalid/u,
    )
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('packaged Codex failures expose only one closed stage code', () => {
  assert.equal(
    parsePackagedCodexFailure('packaged production Codex composition rejected stage=start_project\n'),
    'start_project',
  )
  assert.equal(
    parsePackagedCodexFailure('bounded platform diagnostic\npackaged production Codex composition rejected stage=host_project_native\n'),
    'host_project_native',
  )
  assert.equal(
    parsePackagedCodexFailure('packaged production Codex composition rejected stage=start_project_sandbox_failed\n'),
    'start_project_sandbox_failed',
  )
  for (const value of [
    'packaged production Codex composition rejected stage=private/path\n',
    'raw private detail\n',
    '',
  ]) assert.equal(parsePackagedCodexFailure(value), 'unknown')
})

test('local release Codex smoke uses the fixed repository root without caller paths', () => {
  const workspace = releaseCandidateWorkspace({})
  assert.equal(workspace, resolve(fileURLToPath(new URL('../../..', import.meta.url))))
  assert.equal(releaseCandidateWorkspace({GITHUB_WORKSPACE: workspace}), workspace)
})

test('release-candidate workflow makes packaged Codex composition a required target-native step', async () => {
  const workflow = await readFile(resolve(import.meta.dirname, '../../../.github/workflows/release-candidate.yml'), 'utf8')
  assert.match(workflow, /@openai\/codex@0\.147\.0/u)
  assert.match(workflow, /smoke:packaged-codex:ci/u)
  assert.doesNotMatch(workflow, /\/opt\/homebrew\/bin\/codex|\/usr\/local\/bin\/codex|C:\\nova-tools\\codex\.exe/u)
  assert.doesNotMatch(workflow, /continue-on-error|smoke:packaged-codex[^\n]*\|\|/u)
})
