import assert from 'node:assert/strict'
import {copyFile, cp, mkdir, rm, writeFile} from 'node:fs/promises'
import {dirname, resolve} from 'node:path'

function safeRelativePath(value, prefix = '') {
  assert.equal(typeof value, 'string', 'release_stage_path_invalid')
  assert.ok(value !== '' && !value.startsWith('/') && !value.includes('\\'), 'release_stage_path_invalid')
  assert.equal(value.split('/').includes('..'), false, 'release_stage_path_invalid')
  if (prefix !== '') assert.ok(value.startsWith(prefix), 'release_stage_path_invalid')
  return value
}

async function copyOwnedFile(source, destination) {
  await mkdir(dirname(destination), {recursive: true})
  await copyFile(source, destination)
}

export async function stageReleaseApplication({packageRoot, repositoryRoot, dependencyReport}) {
  assert.equal(dependencyReport?.schema_version, 1, 'release_stage_report_invalid')
  assert.ok(Array.isArray(dependencyReport.packages), 'release_stage_report_invalid')
  const stageRoot = resolve(packageRoot, 'build/release-app')
  await rm(stageRoot, {recursive: true, force: true})
  await mkdir(stageRoot, {recursive: true, mode: 0o700})

  await Promise.all([
    cp(resolve(packageRoot, 'src'), resolve(stageRoot, 'src'), {recursive: true, errorOnExist: true}),
    cp(resolve(packageRoot, 'LICENSES'), resolve(stageRoot, 'LICENSES'), {recursive: true, errorOnExist: true}),
    copyOwnedFile(resolve(packageRoot, 'package.json'), resolve(stageRoot, 'package.json')),
    copyOwnedFile(resolve(packageRoot, 'THIRD_PARTY_NOTICES.md'), resolve(stageRoot, 'THIRD_PARTY_NOTICES.md')),
  ])

  const installKeys = new Set()
  for (const record of dependencyReport.packages) {
    const installKey = safeRelativePath(record?.install_key, 'node_modules/')
    assert.equal(installKeys.has(installKey), false, 'release_stage_report_invalid')
    installKeys.add(installKey)
    assert.ok(Array.isArray(record.files), 'release_stage_report_invalid')
    const fileNames = new Set()
    for (const file of record.files) {
      const fileName = safeRelativePath(file?.path)
      assert.equal(fileNames.has(fileName), false, 'release_stage_report_invalid')
      fileNames.add(fileName)
      await copyOwnedFile(
        resolve(repositoryRoot, installKey, fileName),
        resolve(stageRoot, installKey, fileName),
      )
    }
  }
  await mkdir(resolve(stageRoot, 'build/release'), {recursive: true})
  await writeFile(
    resolve(stageRoot, 'build/release/production-dependencies-v1.json'),
    `${JSON.stringify(dependencyReport)}\n`,
    {encoding: 'utf8', mode: 0o600},
  )
  return stageRoot
}
