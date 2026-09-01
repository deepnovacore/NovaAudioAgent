import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdtemp, mkdir, readFile, readdir, realpath, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import test from 'node:test'

import {collectReleaseArtifacts} from '../scripts/collect-release-artifacts.mjs'
import {generatePendingLedger} from '../scripts/generate-pending-release-ledger.mjs'
import {generateReleaseManifest} from '../scripts/generate-release-manifest.mjs'
import {releaseCandidateReport} from '../scripts/generate-release-candidate-report.mjs'
import {macContainerNotarizationPlan} from '../scripts/finalize-mac-notarization.mjs'
import {RELEASE_ARTIFACT_FILES} from '../scripts/verify-github-release-attestations.mjs'
import {signedCandidateVerificationPlan} from '../scripts/verify-signed-candidate.mjs'

test('release artifacts are normalized to the same closed filenames the attestation verifier owns', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nova-release-collect-'))
  t.after(() => import('node:fs/promises').then(({rm}) => rm(root, {recursive: true, force: true})))
  const dist = join(root, 'dist')
  const out = join(root, 'out')
  await mkdir(join(dist, 'mac-arm64', 'Nova Audio Agent Ambient Orb.app'), {recursive: true})
  await writeFile(join(dist, 'candidate.dmg'), 'dmg')
  const calls = []
  const records = await collectReleaseArtifacts({
    targetId: 'darwin-arm64',
    distRoot: dist,
    outputRoot: out,
  }, {
    run: input => {
      calls.push(input)
      return {status: 0, signal: null, error: undefined, stdout: '', stderr: ''}
    },
    archiveCreated: async destination => writeFile(destination, 'zip'),
  })
  assert.deepEqual(records.map(value => value.target), ['darwin-arm64:app', 'darwin-arm64:dmg'])
  assert.deepEqual(records.map(value => value.filename), [
    RELEASE_ARTIFACT_FILES['darwin-arm64:app'],
    RELEASE_ARTIFACT_FILES['darwin-arm64:dmg'],
  ])
  assert.deepEqual(calls[0].args.slice(0, 2), ['-c', '-k'])
  assert.equal(Object.isFrozen(records), true)
})

test('pending ledger generation binds the complete downloaded artifact matrix and no claimed evidence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nova-release-ledger-'))
  t.after(() => import('node:fs/promises').then(({rm}) => rm(root, {recursive: true, force: true})))
  for (const filename of Object.values(RELEASE_ARTIFACT_FILES)) {
    await writeFile(join(root, filename), `candidate:${filename}`)
  }
  const ledger = await generatePendingLedger({
    artifactRoot: root,
    releaseVersion: '0.1.0-rc.1',
    commit: 'a'.repeat(40),
    applicationVersion: '0.1.0',
  })
  assert.equal(ledger.artifacts.length, Object.keys(RELEASE_ARTIFACT_FILES).length)
  assert.deepEqual(ledger.evidence, [])
  assert.equal(ledger.release_version, '0.1.0-rc.1')
  assert.equal(Object.isFrozen(ledger), true)
  const report = releaseCandidateReport(ledger, {now: Date.parse('2026-08-22T00:00:00.000Z')})
  assert.match(report, /Status: `pending` \(`evidence_pending`\)/u)
  assert.match(report, /unpublished candidate report/u)

  await assert.rejects(generatePendingLedger({
    artifactRoot: root,
    releaseVersion: '9.9.9-rc.1',
    commit: 'a'.repeat(40),
    applicationVersion: '0.1.0',
  }), /pending_release_ledger_rejected/u)
})

test('artifact assembly ignores bundled smoke dependencies and copies only the closed matrix', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nova-release-downloads-')))
  t.after(() => import('node:fs/promises').then(({rm}) => rm(root, {recursive: true, force: true})))
  const downloaded = join(root, 'downloaded')
  const candidate = join(downloaded, 'candidate-darwin-arm64')
  const artifactDirectory = join(candidate, 'release-artifacts')
  const output = join(root, 'assembled')
  await mkdir(artifactDirectory, {recursive: true})
  await mkdir(join(candidate, 'release-smoke-kit', 'node_modules', 'ws', 'lib', 'internal'), {
    recursive: true,
  })
  await writeFile(
    join(candidate, 'release-smoke-kit', 'node_modules', 'ws', 'lib', 'internal', 'fixture.js'),
    'export {}\n',
  )
  for (const filename of Object.values(RELEASE_ARTIFACT_FILES)) {
    await writeFile(join(artifactDirectory, filename), `candidate:${filename}`)
  }
  const script = fileURLToPath(new URL('../scripts/assemble-release-artifact-root.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script, '--input', downloaded, '--output', output], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual((await readdir(output)).sort(), Object.values(RELEASE_ARTIFACT_FILES).sort())
})

test('release candidate explicitly builds unsigned bytes and keeps trust-bound smoke checks', async () => {
  const [workflow, builder, packageJson] = await Promise.all([
    readFile(new URL('../../../.github/workflows/release-candidate.yml', import.meta.url), 'utf8'),
    readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ])
  assert.match(builder, /notarize: true/u)
  assert.match(workflow, /Build unsigned candidate bytes/u)
  assert.doesNotMatch(workflow, /require-release-signing|verify-signed-candidate|finalize:mac-notarization/u)
  assert.match(workflow, /inspect:release-package/u)
  assert.match(workflow, /collect:release-artifacts/u)
  assert.doesNotMatch(workflow, /attest-build-provenance|id-token:|attestations:/u)
  assert.match(workflow, /generate:pending-release-ledger/u)
  assert.match(workflow, /node desktop\/ambient-orb\/node_modules\/electron\/install\.js/u)
  assert.match(
    workflow,
    /npm run test:runtime\n\s+[^\n]*\n\s+[^\n]*\n\s+[^\n]*\n\s+if: .*runner\.os != 'Windows'/u,
  )
  assert.match(workflow, /candidate_scope:\n[\s\S]*- windows/u)
  assert.match(workflow, /if: inputs\.candidate_scope == 'full' \|\| matrix\.platform == 'win32'/u)
  assert.match(workflow, /pending-candidate-ledger:\n\s+needs:[^\n]+\n\s+if: inputs\.candidate_scope == 'full'/u)
  assert.doesNotMatch(workflow, /continue-on-error|\|\| true/u)
  assert.doesNotMatch(workflow, /macos-13/u)
  for (const run of workflowRunBodies(workflow)) {
    assert.doesNotMatch(run, /\$\{\{\s*inputs\./u)
  }
  const scripts = JSON.parse(packageJson).scripts
  for (const name of [
    'smoke:installed-candidate', 'collect:release-artifacts',
    'verify:release-attestations', 'generate:pending-release-ledger',
    'generate:release-manifest',
  ]) assert.equal(typeof scripts[name], 'string')
  const packageScripts = [...workflow.matchAll(/package_script:\s*([^\s]+)/gu)]
    .map(match => match[1])
  assert.ok(packageScripts.length > 0)
  for (const name of packageScripts) assert.equal(typeof scripts[name], 'string')
  assert.match(
    workflow,
    /npm run \$\{\{ matrix\.package_script \}\} --workspace @nova-audio-agent\/ambient-orb/u,
  )
})

test('candidate ledger workflow commands resolve repository-root artifacts across npm workspace cwd', {
  skip: process.platform === 'win32' ? 'candidate ledger job runs on Ubuntu' : false,
}, async t => {
  const workflow = await readFile(
    new URL('../../../.github/workflows/release-candidate.yml', import.meta.url),
    'utf8',
  )
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'nova-candidate-ledger-workflow-')))
  t.after(() => import('node:fs/promises').then(({rm}) => rm(workspace, {recursive: true, force: true})))
  const artifactRoot = join(workspace, 'candidate-artifacts')
  await mkdir(artifactRoot)
  for (const filename of Object.values(RELEASE_ARTIFACT_FILES)) {
    await writeFile(join(artifactRoot, filename), `candidate:${filename}`)
  }
  const repository = fileURLToPath(new URL('../../..', import.meta.url))
  const environment = {...process.env, GITHUB_WORKSPACE: workspace, RELEASE_VERSION: '0.1.0'}
  const generate = workflowStepFoldedCommand(
    workflow,
    'Generate the honest pending external-evidence ledger',
  ).replaceAll('${{ github.sha }}', 'a'.repeat(40))
  const generated = spawnSync('/bin/sh', ['-c', generate], {
    cwd: repository,
    env: environment,
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.equal(generated.status, 0, generated.stderr)
  const render = workflowStepFoldedCommand(workflow, 'Render the unpublished pending candidate report')
  const rendered = spawnSync('/bin/sh', ['-c', render], {
    cwd: repository,
    env: environment,
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.equal(rendered.status, 0, rendered.stderr)
  assert.match(await readFile(join(workspace, 'candidate-report.md'), 'utf8'), /Status: `pending`/u)
})

test('promotion is manual, candidate-bound, main-bound, and publishes npm only after release replacement', async () => {
  const workflow = await readFile(
    new URL('../../../.github/workflows/release-promote.yml', import.meta.url),
    'utf8',
  )
  assert.match(workflow, /workflow_dispatch/u)
  assert.match(workflow, /mac_candidate_run_id/u)
  assert.match(workflow, /windows_candidate_run_id/u)
  assert.match(workflow, /jq -r \.conclusion/u)
  assert.match(workflow, /git rev-parse origin\/main/u)
  assert.match(workflow, /needs: mac-installed-smoke/u)
  assert.match(workflow, /run-id: \$\{\{ inputs\.mac_candidate_run_id \}\}/u)
  const macSmokeStart = workflow.indexOf('  mac-installed-smoke:')
  const macSmokeJob = workflow.slice(macSmokeStart, workflow.indexOf('\n  promote:', macSmokeStart))
  assert.match(macSmokeJob, /target: darwin-arm64:app/u)
  assert.doesNotMatch(macSmokeJob, /target: darwin-arm64:dmg/u)
  assert.match(
    workflow,
    /cp desktop\/ambient-orb\/scripts\/installed-candidate-smoke\.mjs candidate\/release-smoke-kit\/scripts\//u,
  )
  assert.match(workflow, /node candidate\/release-smoke-kit\/scripts\/run-unsigned-installed-smoke\.mjs/u)
  assert.match(workflow, /npm whoami/u)
  assert.match(workflow, /git push --force origin refs\/tags\/v0\.1\.0/u)
  assert.match(workflow, /gh release upload v0\.1\.0 release-artifacts\/\* --clobber/u)
  assert.match(workflow, /npm publish "\$tarball" --access public/u)
  assert.doesNotMatch(workflow, /gh api --method DELETE[^\n]*releases\/assets/u)
  assert.match(workflow, /npm view nova-audio-agent@0\.1\.0 version/u)
  const launch = workflow.indexOf('run-unsigned-installed-smoke.mjs')
  const publish = workflow.indexOf('npm publish "$tarball"')
  assert.ok(launch >= 0 && launch < publish)
  assert.ok(workflow.indexOf('gh release upload v0.1.0') < workflow.indexOf('npm publish "$tarball"'))
  assert.doesNotMatch(workflow, /xvfb-run|novaaudio config/u)
  assert.doesNotMatch(workflow, /push:\s*\n\s*tags:/u)
})

test('release manifest binds every portable and installer byte and emits checksum sidecars', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nova-release-manifest-')))
  t.after(() => import('node:fs/promises').then(({rm}) => rm(root, {recursive: true, force: true})))
  for (const filename of Object.values(RELEASE_ARTIFACT_FILES)) {
    await writeFile(join(root, filename), `candidate:${filename}`)
  }
  const output = join(root, 'release-manifest-v1.json')
  const manifest = await generateReleaseManifest({
    artifactRoot: root,
    commit: 'a'.repeat(40),
    output,
  })
  assert.equal(manifest.version, '0.1.0')
  assert.equal(manifest.signed, false)
  assert.equal(manifest.assets.length, Object.keys(RELEASE_ARTIFACT_FILES).length)
  for (const asset of manifest.assets) {
    assert.match(await readFile(join(root, `${asset.filename}.sha256`), 'utf8'), new RegExp(asset.sha256, 'u'))
  }
  assert.match(await readFile(`${output}.sha256`, 'utf8'), /release-manifest-v1\.json/u)
})

test('Windows release collection creates a portable zip beside the NSIS installer', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nova-release-win-'))
  t.after(() => import('node:fs/promises').then(({rm}) => rm(root, {recursive: true, force: true})))
  const dist = join(root, 'dist')
  const out = join(root, 'out')
  await mkdir(join(dist, 'win-unpacked'), {recursive: true})
  await writeFile(join(dist, 'win-unpacked', 'Nova Audio Agent Ambient Orb.exe'), 'portable')
  await writeFile(join(dist, 'installer.exe'), 'installer')
  const calls = []
  const records = await collectReleaseArtifacts({
    targetId: 'win32-x64', distRoot: dist, outputRoot: out,
  }, {
    run: input => {
      calls.push(input)
      return {status: 0, signal: null, error: undefined}
    },
    archiveCreated: async destination => writeFile(destination, 'zip'),
  })
  assert.deepEqual(records.map(record => record.target), ['win32-x64:portable', 'win32-x64:nsis'])
  assert.equal(calls[0].command, 'tar.exe')
  assert.deepEqual(calls[0].args.slice(0, 3), ['-a', '-c', '-f'])
})

function workflowRunBodies(workflow) {
  const lines = workflow.split('\n')
  const bodies = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)run:\s*(.*)$/u.exec(lines[index])
    if (match === null) continue
    const indent = match[1].length
    let body = match[2]
    while (index + 1 < lines.length) {
      const next = /^(\s*)(.*)$/u.exec(lines[index + 1])
      if (next[2] !== '' && next[1].length <= indent) break
      index += 1
      body += `\n${next[2]}`
    }
    bodies.push(body)
  }
  return bodies
}

function workflowStepFoldedCommand(workflow, name) {
  const lines = workflow.split('\n')
  const nameIndex = lines.findIndex(line => line.trim() === `- name: ${name}`)
  assert.ok(nameIndex >= 0, `workflow step not found: ${name}`)
  const runIndex = lines.findIndex((line, index) => index > nameIndex && /^\s+run:\s*>-/u.test(line))
  assert.ok(runIndex > nameIndex, `workflow run block not found: ${name}`)
  const indent = /^\s*/u.exec(lines[runIndex])[0].length
  const command = []
  for (let index = runIndex + 1; index < lines.length; index += 1) {
    const nextIndent = /^\s*/u.exec(lines[index])[0].length
    if (lines[index].trim() !== '' && nextIndent <= indent) break
    if (lines[index].trim() !== '') command.push(lines[index].trim())
  }
  return command.join(' ')
}

test('mac post-sign verification finds the builder app below its architecture directory', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nova-release-mac-signatures-')))
  t.after(() => import('node:fs/promises').then(({rm}) => rm(root, {recursive: true, force: true})))
  const app = join(root, 'mac-arm64', 'Nova Audio Agent Ambient Orb.app')
  const dmg = join(root, 'Nova Audio Agent Ambient Orb-0.1.0-arm64.dmg')
  await mkdir(app, {recursive: true})
  await writeFile(dmg, 'dmg')
  const plan = signedCandidateVerificationPlan({platform: 'darwin', distRoot: root})
  assert.deepEqual(plan.map(step => step.args.at(-1)), [app, app, app, dmg])
})

test('mac finalization submits and staples the exact built DMG with external credentials', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nova-release-mac-notary-')))
  t.after(() => import('node:fs/promises').then(({rm}) => rm(root, {recursive: true, force: true})))
  const dmg = join(root, 'Nova Audio Agent Ambient Orb-0.1.0-arm64.dmg')
  await writeFile(dmg, 'dmg')
  const plan = macContainerNotarizationPlan({
    distRoot: root,
    environment: {
      APPLE_ID: 'release@example.invalid',
      APPLE_APP_SPECIFIC_PASSWORD: 'external-password',
      APPLE_TEAM_ID: 'TEAMID1234',
    },
  })
  assert.deepEqual(plan.map(step => step.command), ['/usr/bin/xcrun', '/usr/bin/xcrun'])
  assert.deepEqual(plan[0].args.slice(0, 3), ['notarytool', 'submit', dmg])
  assert.deepEqual(plan[1].args, ['stapler', 'staple', dmg])
  assert.throws(() => macContainerNotarizationPlan({distRoot: root, environment: {}}),
    /mac_container_notarization_rejected/u)
})

test('Windows post-sign verification covers recursive executables and manifest-owned native binaries', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nova-release-signatures-')))
  t.after(() => import('node:fs/promises').then(({rm}) => rm(root, {recursive: true, force: true})))
  const distRoot = join(root, 'dist')
  const resources = join(distRoot, 'win-unpacked', 'resources')
  const nested = join(resources, 'app.asar.unpacked', 'node_modules', 'native')
  const programFiles = join(root, 'Program Files (x86)')
  const oldSignTool = join(programFiles, 'Windows Kits', '10', 'bin', '10.0.22621.0', 'x64', 'signtool.exe')
  const signTool = join(programFiles, 'Windows Kits', '10', 'bin', '10.0.26100.0', 'x64', 'signtool.exe')
  await mkdir(nested, {recursive: true})
  await mkdir(join(signTool, '..'), {recursive: true})
  await mkdir(join(oldSignTool, '..'), {recursive: true})
  await Promise.all([
    writeFile(join(distRoot, 'installer.exe'), 'installer'),
    writeFile(join(distRoot, 'win-unpacked', 'app.exe'), 'app'),
    writeFile(join(nested, 'helper.exe'), 'helper'),
    writeFile(join(nested, 'addon.node'), 'addon'),
    writeFile(oldSignTool, 'old-sign-tool'),
    writeFile(signTool, 'sign-tool'),
  ])
  await writeFile(join(resources, 'native-resources-v1.json'), JSON.stringify({
    schema_version: 1,
    target: 'win32-x64',
    resources: [
      {kind: 'executable', platform: 'win32', relative_path: 'app.asar.unpacked/node_modules/native/helper.exe'},
      {kind: 'node_addon', platform: 'win32', relative_path: 'app.asar.unpacked/node_modules/native/addon.node'},
    ],
  }))
  const plan = signedCandidateVerificationPlan({
    platform: 'win32',
    distRoot,
    environment: {'ProgramFiles(x86)': programFiles},
  })
  assert.ok(plan.every(step => step.command === signTool))
  assert.deepEqual(plan.map(step => step.args.at(-1)).sort(), [
    join(nested, 'addon.node'),
    join(nested, 'helper.exe'),
    join(distRoot, 'installer.exe'),
    join(distRoot, 'win-unpacked', 'app.exe'),
  ].sort())
  assert.throws(
    () => signedCandidateVerificationPlan({platform: 'win32', distRoot, environment: {}}),
    /signed_candidate_verification_rejected/u,
  )
})
