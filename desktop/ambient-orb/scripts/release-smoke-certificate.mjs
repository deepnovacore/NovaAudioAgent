import {spawnSync} from 'node:child_process'
import {randomUUID, X509Certificate} from 'node:crypto'
import {chmod, mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import {createSecureContext} from 'node:tls'
import {dirname, isAbsolute, resolve, win32} from 'node:path'

const OPENSSL_TIMEOUT_MS = 30_000
const OPENSSL_OUTPUT_LIMIT = 64 * 1024
const CERTIFICATE_CONFIG = `[req]
prompt = no
distinguished_name = distinguished_name
x509_extensions = v3_req

[distinguished_name]
commonName = Nova Audio Agent release smoke

[v3_req]
basicConstraints = critical,CA:TRUE
keyUsage = critical,digitalSignature,keyEncipherment,keyCertSign
extendedKeyUsage = serverAuth
subjectAltName = IP:127.0.0.1
`

export function releaseSmokeOpenSslCommands({
  platform = process.platform,
  environment = process.env,
} = {}) {
  const commands = ['openssl']
  if (platform === 'win32') {
    const programFiles = environment.ProgramFiles ?? environment.ProgramW6432 ?? 'C:\\Program Files'
    commands.push(
      win32.join(programFiles, 'Git', 'usr', 'bin', 'openssl.exe'),
      win32.join(programFiles, 'Git', 'mingw64', 'bin', 'openssl.exe'),
    )
  }
  return Object.freeze([...new Set(commands)])
}

export async function generateReleaseSmokeCertificate({
  certificate,
  privateKey,
  commands = releaseSmokeOpenSslCommands(),
  run = spawnSync,
  validate = validateCertificate,
}) {
  if (!isAbsolute(certificate) || !isAbsolute(privateKey) || certificate === privateKey
    || !Array.isArray(commands) || commands.length === 0
    || commands.some(command => typeof command !== 'string' || command.length === 0)
    || typeof run !== 'function' || typeof validate !== 'function') {
    throw new Error('release_smoke_certificate_generation_failed')
  }
  const config = resolve(dirname(certificate), `.release-smoke-openssl-${randomUUID()}.cnf`)
  await Promise.all([
    mkdir(dirname(certificate), {recursive: true, mode: 0o700}),
    mkdir(dirname(privateKey), {recursive: true, mode: 0o700}),
  ])
  await Promise.all([
    rm(certificate, {force: true}),
    rm(privateKey, {force: true}),
  ])
  await writeFile(config, CERTIFICATE_CONFIG, {encoding: 'utf8', mode: 0o600})

  try {
    const args = [
      'req', '-batch', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256',
      '-days', '2', '-set_serial', '1', '-config', config, '-extensions', 'v3_req',
      '-keyout', privateKey, '-out', certificate,
    ]
    let generated = false
    for (const command of commands) {
      const result = run(command, args, {
        encoding: 'utf8',
        windowsHide: true,
        timeout: OPENSSL_TIMEOUT_MS,
        maxBuffer: OPENSSL_OUTPUT_LIMIT,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      if (result?.error?.code === 'ENOENT') continue
      if (result?.error !== undefined || result?.signal !== null || result?.status !== 0) {
        throw new Error('release_smoke_certificate_generation_failed')
      }
      generated = true
      break
    }
    if (!generated) throw new Error('release_smoke_certificate_generation_failed')

    const [certificateBytes, privateKeyBytes] = await Promise.all([
      readFile(certificate),
      readFile(privateKey),
    ])
    validate(certificateBytes, privateKeyBytes)
    await Promise.all([
      chmod(certificate, 0o600),
      chmod(privateKey, 0o600),
    ])
  } catch {
    await Promise.all([
      rm(certificate, {force: true}),
      rm(privateKey, {force: true}),
    ])
    throw new Error('release_smoke_certificate_generation_failed')
  } finally {
    await rm(config, {force: true})
  }
}

function validateCertificate(certificate, privateKey) {
  const parsed = new X509Certificate(certificate)
  if (parsed.checkIP('127.0.0.1') !== '127.0.0.1') {
    throw new Error('release_smoke_certificate_generation_failed')
  }
  createSecureContext({cert: certificate, key: privateKey})
}
