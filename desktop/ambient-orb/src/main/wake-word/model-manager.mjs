import { createHash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  promises as fs,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {threadId} from 'node:worker_threads'
import {setTimeout as delay} from 'node:timers/promises'
import tar from 'tar-stream'
import unbzip2 from 'unbzip2-stream'

export const WAKE_WORD_MODEL_NAME = 'sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20'
export const WAKE_WORD_MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/${WAKE_WORD_MODEL_NAME}.tar.bz2`
export const WAKE_WORD_MODEL_SHA256 = '68447f4fbc67e70eee3a93961f36e81e98f47aef73ce7e7ca00885c6cd3616a6'

export const WAKE_WORD_MODEL_FILES = Object.freeze({
  encoder: 'encoder-epoch-13-avg-2-chunk-8-left-64.int8.onnx',
  decoder: 'decoder-epoch-13-avg-2-chunk-8-left-64.onnx',
  joiner: 'joiner-epoch-13-avg-2-chunk-8-left-64.int8.onnx',
  tokens: 'tokens.txt',
  keywords: 'keywords.txt',
})

const ARCHIVE_FILES = new Set([
  WAKE_WORD_MODEL_FILES.encoder,
  WAKE_WORD_MODEL_FILES.decoder,
  WAKE_WORD_MODEL_FILES.joiner,
  WAKE_WORD_MODEL_FILES.tokens,
])
export const WAKE_WORD_KEYWORDS = 'n ǐ h ǎo x īng h é @你好星核\n'

export function validateKeywords(directory) {
  const tokens = new Set(readFileSync(resolve(directory, WAKE_WORD_MODEL_FILES.tokens), 'utf8').split(/\r?\n/).map(line => line.trim().split(/\s+/)[0]))
  for (const token of WAKE_WORD_KEYWORDS.trim().split(/\s+/).filter(token => !token.startsWith('@'))) {
    if (!tokens.has(token)) throw new Error('唤醒词包含模型不支持的 token')
  }
}

const REQUIRED_FILES = new Set(Object.values(WAKE_WORD_MODEL_FILES))
const preparations = new Map()

function complete(directory) {
  if (![...REQUIRED_FILES].every(file => existsSync(resolve(directory, file)))) return false
  return readFileSync(resolve(directory, WAKE_WORD_MODEL_FILES.keywords), 'utf8') === WAKE_WORD_KEYWORDS
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function download(url, path, fetchImpl) {
  const response = await fetchImpl(url, {signal: AbortSignal.timeout(120_000)})
  if (!response.ok || !response.body) {
    throw new Error(`唤醒词模型下载失败：HTTP ${response.status}`)
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(path, {
    flags: 'wx',
    mode: 0o600,
  }))
}

async function extractSelected(archivePath, targetDirectory) {
  const extract = tar.extract()
  const writes = []
  extract.on('entry', (header, stream, next) => {
    const file = basename(header.name)
    if (header.type !== 'file' || !ARCHIVE_FILES.has(file)) {
      stream.resume()
      stream.on('end', next)
      return
    }
    const destination = resolve(targetDirectory, file)
    const write = pipeline(stream, createWriteStream(destination, {
      mode: 0o600,
    })).then(next, error => extract.destroy(error))
    writes.push(write)
  })
  await pipeline(createReadStream(archivePath), unbzip2(), extract)
  await Promise.all(writes)
}

const REMOVE_OPTIONS = {recursive: true, force: true, maxRetries: 10, retryDelay: 100}

export function removeWakeWordDownload(root, ownerThreadId) {
  return fs.rm(resolve(root, `.wake-word-download-${process.pid}-${ownerThreadId}`), REMOVE_OPTIONS)
}

export async function cleanAbandonedWakeWordDownloads(root) {
  for (const name of await fs.readdir(root)) {
    const owner = /^\.wake-word-download-(\d+)-\d+$/.exec(name)
      ?? new RegExp(`^\\.?${WAKE_WORD_MODEL_NAME}-(\\d+)-\\d+(?:\\.tar\\.bz2)?$`).exec(name)
    if (!owner) continue
    try { process.kill(Number(owner[1]), 0) } catch (error) {
      // PID reuse is deliberately conservative: only proven-dead owners are removed.
      if (error.code === 'ESRCH') await fs.rm(resolve(root, name), REMOVE_OPTIONS)
    }
  }
}

export async function installWakeWordModel(stagingDirectory, directory) {
  await fs.rm(directory, REMOVE_OPTIONS)
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(stagingDirectory, directory); return } catch (error) {
      if (attempt === 10 || !['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(error.code)) throw error
      await delay(100)
    }
  }
}

async function prepare(directory, { fetchImpl }) {
  if (complete(directory)) return directory
  // Thread identity prevents an exiting worker from deleting its replacement's files.
  const workspace = resolve(dirname(directory), `.wake-word-download-${process.pid}-${threadId}`)
  mkdirSync(workspace, {recursive: false, mode: 0o700})
  const archivePath = resolve(workspace, 'model.tar.bz2')
  const stagingDirectory = resolve(workspace, 'model')
  mkdirSync(stagingDirectory, { recursive: false, mode: 0o700 })
  try {
    await download(WAKE_WORD_MODEL_URL, archivePath, fetchImpl)
    const digest = await sha256(archivePath)
    if (digest !== WAKE_WORD_MODEL_SHA256) {
      throw new Error('唤醒词模型校验失败')
    }
    await extractSelected(archivePath, stagingDirectory)
    validateKeywords(stagingDirectory)
    writeFileSync(
      resolve(stagingDirectory, WAKE_WORD_MODEL_FILES.keywords),
      WAKE_WORD_KEYWORDS,
      { encoding: 'utf8', mode: 0o600 },
    )
    if (!complete(stagingDirectory)) {
      throw new Error('唤醒词模型缺少必需文件')
    }
    await installWakeWordModel(stagingDirectory, directory)
    return directory
  } finally {
    await removeWakeWordDownload(dirname(directory), threadId)
  }
}

export async function ensureWakeWordModel(directory, {
  fetchImpl = fetch,
} = {}) {
  mkdirSync(directory, {recursive: true, mode: 0o700})
  await cleanAbandonedWakeWordDownloads(directory)
  const target = resolve(directory, WAKE_WORD_MODEL_NAME)
  if (complete(target)) return Promise.resolve(target)
  if (!preparations.has(target)) {
    const pending = prepare(target, { fetchImpl })
      .finally(() => preparations.delete(target))
    preparations.set(target, pending)
  }
  return preparations.get(target)
}
