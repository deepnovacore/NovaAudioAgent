import assert from 'node:assert/strict'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename, dirname, join, resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {verifyRelease} from '../clients/desktop/scripts/verify-release.mjs'

// Install from the real public release through the published CLI, then reuse application acceptance.
const packageRoot = resolve(process.argv[2])
const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
assert.equal(manifest.version, process.env.RELEASE_VERSION)
const {ensureDesktop} = await import(pathToFileURL(join(packageRoot, 'src/runtime.mjs')))
// Before publication, substitute only the transport with checksummed candidate files.
const fetchImpl = process.argv[3]
  ? async url => new Response(await readFile(resolve(process.argv[3], basename(new URL(url).pathname))))
  : fetch
const home = await mkdtemp(join(tmpdir(), 'nova-npm-acceptance-'))
try {
  const {executable} = await ensureDesktop({home, fetchImpl})
  await verifyRelease({unsigned: true, ...(process.platform === 'linux'
    ? {artifact: executable}
    : {app: process.platform === 'darwin' ? resolve(dirname(executable), '../..') : dirname(executable)})})
} finally {await rm(home, {recursive: true, force: true, maxRetries: 10, retryDelay: 100})}
