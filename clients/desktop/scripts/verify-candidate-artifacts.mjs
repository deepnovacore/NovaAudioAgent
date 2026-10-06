import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {readFile, readdir} from 'node:fs/promises'
import {join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {releaseChannel} from './release-channel.mjs'

export async function verifyCandidateArtifacts(root, version) {
  releaseChannel(version)
  const names = ['macos-arm64-app.zip', 'macos-arm64.dmg', 'windows-x64-portable.zip', 'windows-x64.exe', 'linux-x64.AppImage', 'linux-x64.deb']
    .map(suffix => `nova-audio-agent-${version}-${suffix}`)
  names.push(`nova-audio-agent-server-${version}.tgz`)
  assert.deepEqual((await readdir(root)).sort(), names.flatMap(name => [name, `${name}.sha256`]).sort(), 'candidate asset names mismatch')
  for (const name of names) {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(join(root, name))) hash.update(chunk)
    const checksum = (await readFile(join(root, `${name}.sha256`), 'utf8')).trim()
    const digest = hash.digest('hex')
    // sha256sum marks binary mode with '*', including its Windows default.
    assert.ok(checksum === `${digest}  ${name}` || checksum === `${digest} *${name}`, `${name} checksum mismatch`)
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await verifyCandidateArtifacts(process.argv[2], process.env.RELEASE_VERSION)
}
