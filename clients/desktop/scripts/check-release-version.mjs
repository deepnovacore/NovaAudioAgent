import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {releaseChannel} from './release-channel.mjs'

const version = process.env.RELEASE_VERSION
releaseChannel(version)
for (const path of ['cli/package.json', 'clients/desktop/package.json']) {
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, version, `${path} release version mismatch`)
}
