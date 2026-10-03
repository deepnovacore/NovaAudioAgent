import assert from 'node:assert/strict'
import {mkdtemp, writeFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import test from 'node:test'
import {verifyCandidateArtifacts} from '../scripts/verify-candidate-artifacts.mjs'

for (const version of ['0.2.0', '0.3.0-preview.1']) test(`candidate ${version} assets require exact names and matching checksums`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-candidate-'))
  const name = `nova-audio-agent-${version}-macos-arm64-app.zip`
  try {
    for (const suffix of ['macos-arm64-app.zip', 'macos-arm64.dmg', 'windows-x64-portable.zip', 'windows-x64.exe', 'linux-x64.AppImage', 'linux-x64.deb']) {
      const file = `nova-audio-agent-${version}-${suffix}`
      await writeFile(join(root, file), 'candidate')
      const mode = suffix.startsWith('windows-') ? '*' : ' '
      await writeFile(join(root, `${file}.sha256`), `${createHash('sha256').update('candidate').digest('hex')} ${mode}${file}\n`)
    }
    const server = `nova-audio-agent-server-${version}.tgz`
    await writeFile(join(root, server), 'server')
    await writeFile(join(root, `${server}.sha256`), `${createHash('sha256').update('server').digest('hex')}  ${server}\n`)
    await verifyCandidateArtifacts(root, version)
    await writeFile(join(root, name), 'corrupted')
    await assert.rejects(verifyCandidateArtifacts(root, version), /checksum/)
    await writeFile(join(root, name), 'candidate')
    const digest = createHash('sha256').update('candidate').digest('hex')
    await writeFile(join(root, `${name}.sha256`), `${digest} *wrong-file.zip\n`)
    await assert.rejects(verifyCandidateArtifacts(root, version), /checksum/)
    await writeFile(join(root, `${name}.sha256`), `${digest}  ${name}\n`)
    await writeFile(join(root, 'unexpected.exe'), 'extra')
    await assert.rejects(verifyCandidateArtifacts(root, version), /names/)
    await assert.rejects(verifyCandidateArtifacts(root, '0.1.1'), /names/)
  } finally { await rm(root, {recursive: true, force: true}) }
})
