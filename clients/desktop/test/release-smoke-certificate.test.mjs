import assert from 'node:assert/strict'
import {readFileSync, writeFileSync} from 'node:fs'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {resolve} from 'node:path'
import test from 'node:test'

import {
  generateReleaseSmokeCertificate,
  releaseSmokeOpenSslCommands,
} from '../scripts/release-smoke-certificate.mjs'

test('release smoke TLS identity is generated per kit with an IP SAN', async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), 'nova-release-smoke-cert-'))
  context.after(() => rm(root, {recursive: true, force: true}))
  const certificate = resolve(root, 'release-smoke-cert.pem')
  const privateKey = resolve(root, 'release-smoke-key.pem')
  const attempts = []

  await generateReleaseSmokeCertificate({
    certificate,
    privateKey,
    commands: ['missing-openssl', 'working-openssl'],
    validate(certificateBytes, privateKeyBytes) {
      assert.match(certificateBytes.toString('utf8'), /BEGIN CERTIFICATE/u)
      assert.match(privateKeyBytes.toString('utf8'), /BEGIN PRIVATE KEY/u)
    },
    run(command, args) {
      attempts.push(command)
      if (command === 'missing-openssl') {
        return {status: null, signal: null, error: Object.assign(new Error('missing'), {code: 'ENOENT'})}
      }
      const config = args[args.indexOf('-config') + 1]
      const configText = readFileSync(config, 'utf8')
      assert.match(configText, /subjectAltName\s*=\s*IP:127\.0\.0\.1/u)
      writeFileSync(args[args.indexOf('-out') + 1], '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n')
      writeFileSync(args[args.indexOf('-keyout') + 1], '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n')
      return {status: 0, signal: null, error: undefined}
    },
  })

  assert.deepEqual(attempts, ['missing-openssl', 'working-openssl'])
  assert.match(await readFile(certificate, 'utf8'), /BEGIN CERTIFICATE/u)
  assert.match(await readFile(privateKey, 'utf8'), /BEGIN PRIVATE KEY/u)
})

test('release smoke TLS generation fails closed and removes partial identity files', async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), 'nova-release-smoke-cert-failure-'))
  context.after(() => rm(root, {recursive: true, force: true}))
  const certificate = resolve(root, 'release-smoke-cert.pem')
  const privateKey = resolve(root, 'release-smoke-key.pem')

  await assert.rejects(generateReleaseSmokeCertificate({
    certificate,
    privateKey,
    commands: ['broken-openssl'],
    run(_command, args) {
      writeFileSync(args[args.indexOf('-keyout') + 1], 'partial private key')
      return {status: 2, signal: null, error: undefined, stderr: 'sensitive tool output'}
    },
  }), error => error?.message === 'release_smoke_certificate_generation_failed')

  await assert.rejects(readFile(certificate), error => error?.code === 'ENOENT')
  await assert.rejects(readFile(privateKey), error => error?.code === 'ENOENT')
})

test('Windows release smoke TLS generation tries Git for Windows after PATH', () => {
  assert.deepEqual(releaseSmokeOpenSslCommands({
    platform: 'win32',
    environment: {ProgramFiles: 'D:\\Applications'},
  }), [
    'openssl',
    'D:\\Applications\\Git\\usr\\bin\\openssl.exe',
    'D:\\Applications\\Git\\mingw64\\bin\\openssl.exe',
  ])
})

test('release smoke kit generates its TLS identity instead of copying ignored fixtures', async () => {
  const source = await readFile(
    resolve(import.meta.dirname, '../scripts/prepare-release-smoke-kit.mjs'),
    'utf8',
  )
  assert.match(source, /generateReleaseSmokeCertificate\(\{/u)
  assert.match(source, /scripts\/run-unsigned-installed-smoke\.mjs/u)
  assert.match(source, /scripts\/windows-smoke-home\.mjs/u)
  assert.doesNotMatch(source, /resolve\(packageRoot, 'scripts\/release-smoke-(?:cert|key)\.pem'\)/u)
})
