import {cp, mkdir, rm, writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'

const packageRoot = resolve(import.meta.dirname, '..')
const repositoryRoot = resolve(packageRoot, '../..')
const output = resolve(packageRoot, 'build/release-smoke-kit')
await rm(output, {recursive: true, force: true})
await mkdir(resolve(output, 'scripts'), {recursive: true, mode: 0o700})
await Promise.all([
  cp(resolve(packageRoot, 'scripts/installed-candidate-smoke.mjs'),
    resolve(output, 'scripts/installed-candidate-smoke.mjs')),
  cp(resolve(packageRoot, 'scripts/release-smoke-cert.pem'),
    resolve(output, 'scripts/release-smoke-cert.pem')),
  cp(resolve(packageRoot, 'scripts/release-smoke-key.pem'),
    resolve(output, 'scripts/release-smoke-key.pem')),
  cp(resolve(repositoryRoot, 'node_modules/ws'), resolve(output, 'node_modules/ws'), {recursive: true}),
  cp(resolve(repositoryRoot, 'assets/demos/cat-sofa-guard/cat-sofa-guard.mp4'),
    resolve(output, 'cat-sofa-guard.mp4')),
])
await writeFile(resolve(output, 'package.json'), '{"private":true,"type":"module"}\n', {
  encoding: 'utf8', mode: 0o600,
})
process.stdout.write('release smoke kit prepared\n')
