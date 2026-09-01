import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import {
  desktopSettingsPath,
  PRODUCT_VERSION,
  releaseBaseUrl,
  releaseRoot,
  resolveTarget,
} from './target.mjs'

const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024
const MAX_CHECKSUM_BYTES = 4096
const MAX_REDIRECTS = 5
const LOCK_STALE_MS = 15 * 60 * 1000
const LOCK_WAIT_MS = 2 * 60 * 1000
const REDIRECT_DELAY_MS = 100
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/u
const INSTALL_RECEIPT_BYTES = 4096
const LOCK_HEARTBEAT_MS = 30 * 1000
const LAUNCH_GRACE_MS = 1000

function allowedDownloadUrl(value) {
  const url = new URL(value)
  return url.protocol === 'https:'
    && (url.hostname === 'github.com' || url.hostname.endsWith('.githubusercontent.com'))
    && url.username === ''
    && url.password === ''
}

async function request(url, {fetchImpl = fetch} = {}) {
  let current = new URL(url)
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (!allowedDownloadUrl(current)) throw new Error('release download URL rejected')
    const response = await fetchImpl(current, {redirect: 'manual'})
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get('location')
    if (location === null || redirects === MAX_REDIRECTS) {
      throw new Error('release download redirect rejected')
    }
    current = new URL(location, current)
  }
  throw new Error('release download redirect rejected')
}

async function responseBytes(response, maxBytes) {
  if (!response.ok || response.body === null) {
    throw new Error(`release download failed: HTTP ${response.status}`)
  }
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error('release download exceeded size limit')
  }
  const chunks = []
  let total = 0
  for await (const value of response.body) {
    const chunk = Buffer.from(value)
    total += chunk.length
    if (total > maxBytes) throw new Error('release download exceeded size limit')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export function parseChecksum(text, artifact) {
  const expectedName = basename(artifact)
  for (const line of text.split(/\r?\n/u)) {
    const match = /^([a-fA-F0-9]{64})(?:\s+[*]?(.+))?$/u.exec(line.trim())
    if (match === null) continue
    if (match[2] !== undefined && basename(match[2]) !== expectedName) continue
    const digest = match[1].toLowerCase()
    if (CHECKSUM_PATTERN.test(digest)) return digest
  }
  throw new Error('release checksum rejected')
}

async function expectedChecksum(url, artifact, options) {
  const response = await request(`${url}.sha256`, options)
  const body = await responseBytes(response, MAX_CHECKSUM_BYTES)
  return parseChecksum(body.toString('utf8'), artifact)
}

async function downloadArtifact(url, destination, options) {
  const response = await request(url, options)
  if (!response.ok || response.body === null) {
    throw new Error(`release download failed: HTTP ${response.status}`)
  }
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_ARTIFACT_BYTES) {
    throw new Error('release download exceeded size limit')
  }
  const handle = await open(destination, 'wx', 0o600)
  const hash = createHash('sha256')
  let total = 0
  try {
    for await (const value of response.body) {
      const chunk = Buffer.from(value)
      total += chunk.length
      if (total > MAX_ARTIFACT_BYTES) throw new Error('release download exceeded size limit')
      hash.update(chunk)
      await handle.write(chunk)
    }
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => {})
    await rm(destination, {force: true})
    throw error
  }
  await handle.close()
  return hash.digest('hex')
}

function sameDigest(left, right) {
  if (!CHECKSUM_PATTERN.test(left) || !CHECKSUM_PATTERN.test(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true})
    let stderr = ''
    child.stderr.on('data', chunk => {
      if (stderr.length < 8192) stderr += String(chunk).slice(0, 8192 - stderr.length)
    })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (signal !== null || code !== 0) {
        rejectRun(new Error(`release extraction failed${stderr ? `: ${stderr.trim()}` : ''}`))
      } else resolveRun()
    })
  })
}

async function extractArtifact({artifact, payload, target, platform}) {
  await mkdir(payload, {recursive: true, mode: 0o700})
  if (target.archive === 'file') {
    const executable = resolve(payload, target.executable)
    await copyFile(artifact, executable)
    await chmod(executable, 0o700)
    return executable
  }
  if (platform === 'darwin') {
    await run('/usr/bin/ditto', ['-x', '-k', artifact, payload])
  } else {
    await run(platform === 'win32' ? 'tar.exe' : 'tar', ['-xf', artifact, '-C', payload])
  }
  const executable = resolve(payload, target.executable)
  const executableRelative = relative(resolve(payload), executable)
  if (executableRelative === ''
    || executableRelative === '..'
    || executableRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    || isAbsolute(executableRelative)) {
    throw new Error('release executable path rejected')
  }
  const info = await lstat(executable)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('release executable rejected')
  if (platform !== 'win32') await chmod(executable, 0o700)
  return executable
}

async function executableReady(path, platform) {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) return false
    await access(path, platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

async function cachedInstallation({root, executable, target, platform, expected}) {
  if (!await executableReady(executable, platform)) return null
  try {
    const receiptPath = join(root, 'novaaudio-install.json')
    const details = await lstat(receiptPath)
    if (!details.isFile() || details.isSymbolicLink() || details.size > INSTALL_RECEIPT_BYTES) {
      return null
    }
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
    const keys = Object.keys(receipt).sort()
    if (keys.join('\0') !== ['artifact', 'schema_version', 'sha256', 'target', 'version'].join('\0')
      || receipt.schema_version !== 1
      || receipt.version !== PRODUCT_VERSION
      || receipt.target !== target.id
      || receipt.artifact !== target.artifact
      || !CHECKSUM_PATTERN.test(receipt.sha256)
      || expected !== undefined && !sameDigest(receipt.sha256, expected)) return null
    return Object.freeze({sha256: receipt.sha256})
  } catch {
    return null
  }
}

function lockOwnerAlive(owner, kill = process.kill) {
  if (owner === null || typeof owner !== 'object' || !Number.isSafeInteger(owner.pid)
    || owner.pid < 1 || typeof owner.token !== 'string' || owner.token.length !== 36) return false
  try {
    kill(owner.pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

async function installPayloadAtomically(payload, root) {
  const previous = `${root}.previous-${randomUUID()}`
  let hadPrevious = false
  try {
    await rename(root, previous)
    hadPrevious = true
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  try {
    await rename(payload, root)
  } catch (error) {
    if (hadPrevious) {
      await rename(previous, root).catch(() => {})
    }
    throw error
  }
  if (hadPrevious) await rm(previous, {recursive: true, force: true})
}

async function readLockOwner(path) {
  try {
    const ownerPath = join(path, 'owner.json')
    const details = await lstat(ownerPath)
    if (!details.isFile() || details.isSymbolicLink() || details.size > 1024) return null
    return JSON.parse(await readFile(ownerPath, 'utf8'))
  } catch {
    return null
  }
}

async function acquireLock(path, {now = () => Date.now(), delay = wait} = {}) {
  const deadline = now() + LOCK_WAIT_MS
  for (;;) {
    try {
      await mkdir(path, {mode: 0o700})
      const token = randomUUID()
      try {
        await writeFile(join(path, 'owner.json'), `${JSON.stringify({pid: process.pid, token})}\n`, {
          mode: 0o600,
        })
      } catch (error) {
        await rm(path, {recursive: true, force: true})
        throw error
      }
      const heartbeat = setInterval(async () => {
        const owner = await readLockOwner(path)
        if (owner?.token !== token) return
        const timestamp = new Date()
        await utimes(path, timestamp, timestamp).catch(() => {})
      }, LOCK_HEARTBEAT_MS)
      heartbeat.unref()
      return async () => {
        clearInterval(heartbeat)
        const owner = await readLockOwner(path)
        if (owner?.token === token) await rm(path, {recursive: true, force: true})
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const details = await stat(path).catch(() => null)
      const owner = await readLockOwner(path)
      if (details !== null && now() - details.mtimeMs > LOCK_STALE_MS
        && !lockOwnerAlive(owner)) {
        await rm(path, {recursive: true, force: true})
        continue
      }
      if (now() >= deadline) throw new Error('desktop install is locked by another process')
      await delay(REDIRECT_DELAY_MS)
    }
  }
}

function wait(milliseconds) {
  return new Promise(resolveWait => setTimeout(resolveWait, milliseconds))
}

export async function ensureDesktop({
  platform = process.platform,
  arch = process.arch,
  home,
  fetchImpl = fetch,
  baseUrl = releaseBaseUrl(),
} = {}) {
  const target = resolveTarget(platform, arch)
  const root = releaseRoot({home, target})
  const executable = resolve(root, target.executable)
  const cached = await cachedInstallation({root, executable, target, platform})
  let expected
  try {
    expected = await expectedChecksum(
      `${baseUrl}/${target.artifact}`,
      target.artifact,
      {fetchImpl},
    )
  } catch (error) {
    if (cached !== null) return Object.freeze({target, root, executable})
    throw error
  }
  if (cached !== null && sameDigest(cached.sha256, expected)) {
    return Object.freeze({target, root, executable})
  }

  await mkdir(dirname(root), {recursive: true, mode: 0o700})
  const releaseLock = await acquireLock(`${root}.lock`)
  try {
    if (await cachedInstallation({root, executable, target, platform, expected}) !== null) {
      return Object.freeze({target, root, executable})
    }
    const temporary = await mkdtemp(join(dirname(root), `.${target.id}-install-`))
    try {
      const artifact = join(temporary, target.artifact)
      const artifactUrl = `${baseUrl}/${target.artifact}`
      const actual = await downloadArtifact(artifactUrl, artifact, {fetchImpl})
      if (!sameDigest(expected, actual)) throw new Error('release checksum mismatch')
      const payload = join(temporary, 'payload')
      await extractArtifact({artifact, payload, target, platform})
      await writeFile(join(payload, 'novaaudio-install.json'), `${JSON.stringify({
        schema_version: 1,
        version: PRODUCT_VERSION,
        target: target.id,
        artifact: target.artifact,
        sha256: actual,
      })}\n`, {mode: 0o600})
      await installPayloadAtomically(payload, root)
    } finally {
      await rm(temporary, {recursive: true, force: true})
    }
  } finally {
    await releaseLock()
  }
  if (!await executableReady(executable, platform)) throw new Error('desktop install incomplete')
  return Object.freeze({target, root, executable})
}

export function launchDesktop(executable, {
  openSettings = false,
  platform = process.platform,
  environment = process.env,
  spawnImpl = spawn,
  launchGraceMs = LAUNCH_GRACE_MS,
} = {}) {
  return new Promise((resolveLaunch, rejectLaunch) => {
    let child
    try {
      child = spawnImpl(executable, openSettings ? ['--open-settings'] : [], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        env: platform === 'linux'
          ? {...environment, APPIMAGE_EXTRACT_AND_RUN: '1'}
          : environment,
      })
    } catch {
      rejectLaunch(new Error('desktop launch failed'))
      return
    }
    let settled = false
    let launchTimer
    const fail = () => {
      if (settled) return
      settled = true
      clearTimeout(launchTimer)
      rejectLaunch(new Error('desktop launch failed'))
    }
    child.once('error', fail)
    child.once('exit', (code, signal) => {
      if (settled) return
      if (code === 0 && signal === null) {
        settled = true
        clearTimeout(launchTimer)
        resolveLaunch()
      } else {
        fail()
      }
    })
    child.once('spawn', () => {
      if (settled) return
      launchTimer = setTimeout(() => {
        if (settled) return
        settled = true
        child.unref()
        resolveLaunch()
      }, launchGraceMs)
    })
  })
}

function findCodex(platform = process.platform) {
  const command = platform === 'win32' ? 'where.exe' : 'which'
  const result = spawnSync(command, ['codex'], {encoding: 'utf8', windowsHide: true})
  return result.status === 0 && String(result.stdout).trim() !== ''
}

export async function inspectDoctor({
  platform = process.platform,
  arch = process.arch,
  home,
  environment = process.env,
} = {}) {
  let target
  try {
    target = resolveTarget(platform, arch)
  } catch {
    return Object.freeze({supported: false, platform: `${platform}-${arch}`})
  }
  const root = releaseRoot({home, target})
  const executable = resolve(root, target.executable)
  const settings = desktopSettingsPath({platform, home, environment})
  let secretKeys = []
  try {
    const document = JSON.parse(await readFile(settings, 'utf8'))
    if (document?.secrets && typeof document.secrets === 'object' && !Array.isArray(document.secrets)) {
      secretKeys = Object.keys(document.secrets).sort()
    }
  } catch {}
  return Object.freeze({
    supported: true,
    platform: target.id,
    desktopReady: await cachedInstallation({root, executable, target, platform}) !== null,
    settingsPresent: await access(settings).then(() => true, () => false),
    configuredSecretKeys: Object.freeze(secretKeys),
    codexPresent: findCodex(platform),
  })
}
