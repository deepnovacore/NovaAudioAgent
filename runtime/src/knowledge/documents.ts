import {createHash} from 'node:crypto'
import {lookup as dnsLookup} from 'node:dns/promises'
import {basename, extname, isAbsolute} from 'node:path'
import {BlockList, isIP, type LookupFunction} from 'node:net'
import {open, realpath} from 'node:fs/promises'
import {Worker} from 'node:worker_threads'
import {Agent, fetch as undiciFetch} from 'undici'
import {SensitiveContentPolicy, SensitivePathPolicy} from '../workspace-graph/sensitivity.js'

const MAX_FILE_BYTES = 10 * 1_024 * 1_024
const MAX_TEXT_BYTES = 10 * 1_024 * 1_024
const MAX_TEXT_CODE_POINTS = 2_621_440
const CHUNK_CODE_POINTS = 3_200
const CHUNK_OVERLAP = 480
const FETCH_TIMEOUT_MS = 10_000
const PARSE_TIMEOUT_MS = 15_000
const MAX_REDIRECTS = 3

const contentPolicy = new SensitiveContentPolicy()
const pathPolicy = new SensitivePathPolicy()

export class KnowledgeDocumentFailure extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'KnowledgeDocumentFailure'
  }
}

export interface KnowledgeChunk {
  readonly heading_path: string
  readonly text: string
  readonly token_estimate: number
}

export interface KnowledgeDocument {
  readonly title: string
  readonly mime: string
  readonly text: string
  readonly bytes: number
  readonly fingerprint: string
  readonly locator: string
}

/** Split screened text at Markdown headings, then bound long sections with 15% overlap. */
export function chunkKnowledgeText(text: string): KnowledgeChunk[] {
  if (typeof text !== 'string' || [...text].length > MAX_TEXT_CODE_POINTS) {
    throw new KnowledgeDocumentFailure('invalid_text')
  }
  screenText('document', text)
  const headings: string[] = []
  const sections: {heading: string; text: string}[] = []
  let lines: string[] = []
  let currentHeading = ''
  const flush = (): void => {
    const value = lines.join('\n').trim()
    if (value !== '') sections.push({heading: currentHeading, text: value})
    lines = []
  }

  for (const line of text.split(/\r?\n/u)) {
    const match = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/u.exec(line)
    if (match === null) {
      lines.push(line)
      continue
    }
    flush()
    const level = match[1]?.length ?? 1
    headings.length = level - 1
    headings[level - 1] = match[2]?.trim() ?? ''
    currentHeading = headings.filter(Boolean).join(' > ')
  }
  flush()

  const chunks: KnowledgeChunk[] = []
  for (const section of sections) {
    const codePoints = [...section.text]
    for (let start = 0; start < codePoints.length; start += CHUNK_CODE_POINTS - CHUNK_OVERLAP) {
      const chunkText = codePoints.slice(start, start + CHUNK_CODE_POINTS).join('')
      if (chunkText === '') break
      chunks.push({
        heading_path: section.heading,
        text: chunkText,
        token_estimate: Math.ceil(codePointsLength(chunkText) / 4),
      })
      if (start + CHUNK_CODE_POINTS >= codePoints.length) break
    }
  }
  return chunks
}

export async function readKnowledgeFile(path: string, signal?: AbortSignal): Promise<KnowledgeDocument> {
  signal?.throwIfAborted()
  if (!isAbsolute(path) || !pathPolicy.allows(path)) throw new KnowledgeDocumentFailure('path_denied')

  let canonical: string
  try {
    canonical = await realpath(path)
  } catch {
    throw new KnowledgeDocumentFailure('file_unavailable')
  }
  signal?.throwIfAborted()
  if (!pathPolicy.allows(canonical)) throw new KnowledgeDocumentFailure('path_denied')

  const format = fileFormat(canonical)
  if (format === null) throw new KnowledgeDocumentFailure('unsupported_mime')
  let handle: Awaited<ReturnType<typeof open>>
  try { handle = await open(canonical, 'r') } catch {
    signal?.throwIfAborted()
    throw new KnowledgeDocumentFailure('file_unavailable')
  }
  let bytes: Uint8Array
  try {
    const info = await handle.stat({bigint: true})
    if (!info.isFile() || info.size < 1n) throw new KnowledgeDocumentFailure('invalid_file')
    if (info.size > BigInt(MAX_FILE_BYTES)) throw new KnowledgeDocumentFailure('file_too_large')
    signal?.throwIfAborted()
    bytes = new Uint8Array(Number(info.size))
    let offset = 0
    while (offset < bytes.length) {
      signal?.throwIfAborted()
      const read = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (read.bytesRead === 0) throw new KnowledgeDocumentFailure('file_changed')
      offset += read.bytesRead
    }
    const after = await handle.stat({bigint: true})
    if (!after.isFile() || after.size !== info.size || after.mtimeNs !== info.mtimeNs) {
      throw new KnowledgeDocumentFailure('file_changed')
    }
  } catch (cause) {
    signal?.throwIfAborted()
    if (cause instanceof KnowledgeDocumentFailure) throw cause
    throw new KnowledgeDocumentFailure('file_unavailable')
  } finally {
    await handle.close().catch(() => undefined)
  }

  const text = await decodeDocument(bytes, format.kind, signal)
  const title = basename(canonical)
  screenText('title', title)
  screenText('locator', canonical)
  screenText('document', text)
  return {
    title,
    mime: format.mime,
    text,
    bytes: bytes.byteLength,
    fingerprint: createHash('sha256').update(bytes).digest('hex'),
    locator: canonical,
  }
}

export async function fetchKnowledgeUrl(url: string, signal?: AbortSignal): Promise<KnowledgeDocument> {
  signal?.throwIfAborted()
  let current = admittedUrl(url)
  const dispatcher = new Agent({connect: {lookup: publicLookup}})
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      let response: Response
      try {
        response = await undiciFetch(current, {redirect: 'manual', signal: combined, dispatcher})
      } catch {
        if (signal?.aborted === true) signal.throwIfAborted()
        if (timeout.aborted) throw new KnowledgeDocumentFailure('timeout')
        throw new KnowledgeDocumentFailure('network')
      }
      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel()
        if (redirects === MAX_REDIRECTS) throw new KnowledgeDocumentFailure('redirect_denied')
        const location = response.headers.get('location')
        if (location === null) throw new KnowledgeDocumentFailure('redirect_denied')
        let redirected: string
        try { redirected = new URL(location, current).href } catch {
          throw new KnowledgeDocumentFailure('redirect_denied')
        }
        current = admittedUrl(redirected)
        continue
      }
      if (!response.ok) {
        void response.body?.cancel()
        throw new KnowledgeDocumentFailure('http_error')
      }
      const bytes = await readResponseBounded(response, combined)
      const format = responseFormat(current, response.headers.get('content-type'))
      const decoded = format.kind === 'html' ? decodeUtf8(bytes) : null
      const htmlTitle = decoded === null ? null : extractHtmlTitle(decoded)
      const text = decoded === null ? await decodeDocument(bytes, format.kind, combined) : htmlToText(decoded)
      if (text.trim() === '') throw new KnowledgeDocumentFailure('empty_text')
      const title = htmlTitle ?? (basename(current.pathname) || current.hostname)
      screenText('title', title)
      screenText('locator', current.href)
      screenText('document', text)
      return {
        title,
        mime: format.mime,
        text,
        bytes: bytes.byteLength,
        fingerprint: createHash('sha256').update(bytes).digest('hex'),
        locator: current.href,
      }
    }
    throw new KnowledgeDocumentFailure('redirect_denied')
  } catch (cause) {
    if (signal?.aborted === true) signal.throwIfAborted()
    if (cause instanceof KnowledgeDocumentFailure) throw cause
    if (timeout.aborted) throw new KnowledgeDocumentFailure('timeout')
    throw new KnowledgeDocumentFailure('network')
  } finally {
    await dispatcher.close().catch(() => undefined)
  }
}

type DocumentKind = 'text' | 'html' | 'pdf' | 'docx'

interface DocumentFormat {
  readonly kind: DocumentKind
  readonly mime: string
}

const extensionFormats = new Map<string, DocumentFormat>([
  ['.txt', {kind: 'text', mime: 'text/plain'}],
  ['.md', {kind: 'text', mime: 'text/markdown'}],
  ['.markdown', {kind: 'text', mime: 'text/markdown'}],
  ['.json', {kind: 'text', mime: 'application/json'}],
  ['.yaml', {kind: 'text', mime: 'application/yaml'}],
  ['.yml', {kind: 'text', mime: 'application/yaml'}],
  ['.csv', {kind: 'text', mime: 'text/csv'}],
  ['.ts', {kind: 'text', mime: 'text/plain'}],
  ['.tsx', {kind: 'text', mime: 'text/plain'}],
  ['.js', {kind: 'text', mime: 'text/plain'}],
  ['.jsx', {kind: 'text', mime: 'text/plain'}],
  ['.py', {kind: 'text', mime: 'text/plain'}],
  ['.rs', {kind: 'text', mime: 'text/plain'}],
  ['.go', {kind: 'text', mime: 'text/plain'}],
  ['.java', {kind: 'text', mime: 'text/plain'}],
  ['.c', {kind: 'text', mime: 'text/plain'}],
  ['.h', {kind: 'text', mime: 'text/plain'}],
  ['.cpp', {kind: 'text', mime: 'text/plain'}],
  ['.pdf', {kind: 'pdf', mime: 'application/pdf'}],
  ['.docx', {kind: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}],
])

function fileFormat(path: string): DocumentFormat | null {
  return extensionFormats.get(extname(path).toLowerCase()) ?? null
}

function responseFormat(url: URL, header: string | null): DocumentFormat {
  const mime = header?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  const byMime: Readonly<Record<string, DocumentFormat>> = {
    'text/plain': {kind: 'text', mime: 'text/plain'},
    'text/markdown': {kind: 'text', mime: 'text/markdown'},
    'text/csv': {kind: 'text', mime: 'text/csv'},
    'text/html': {kind: 'html', mime: 'text/html'},
    'application/xhtml+xml': {kind: 'html', mime: 'text/html'},
    'application/json': {kind: 'text', mime: 'application/json'},
    'application/yaml': {kind: 'text', mime: 'application/yaml'},
    'application/x-yaml': {kind: 'text', mime: 'application/yaml'},
    'application/pdf': {kind: 'pdf', mime: 'application/pdf'},
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
      kind: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    },
  }
  const exact = byMime[mime]
  if (exact !== undefined) return exact
  if (mime === '' || mime === 'application/octet-stream') {
    const inferred = fileFormat(url.pathname)
    if (inferred !== null) return inferred
  }
  throw new KnowledgeDocumentFailure('unsupported_mime')
}

async function decodeDocument(bytes: Uint8Array, kind: DocumentKind, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  if (kind === 'pdf' || kind === 'docx') return await parseInWorker(kind, bytes, signal)
  let text = decodeUtf8(bytes)
  if (kind === 'html') text = htmlToText(text)
  if (text.trim() === '') throw new KnowledgeDocumentFailure('empty_text')
  return text
}

function parseInWorker(kind: 'pdf' | 'docx', bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(new URL('./parse-worker.js', import.meta.url), {
        resourceLimits: {maxOldGenerationSizeMb: 128, stackSizeMb: 4},
      })
    } catch {
      reject(new KnowledgeDocumentFailure('parse_failed'))
      return
    }
    let settled = false
    const finish = (outcome: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      void worker.terminate()
      outcome()
    }
    const abort = (): void => finish(() => {
      try { signal?.throwIfAborted() } catch (cause) {
        reject(cause instanceof Error ? cause : new DOMException('This operation was aborted', 'AbortError'))
        return
      }
      reject(new DOMException('This operation was aborted', 'AbortError'))
    })
    const timer = setTimeout(() => finish(() => reject(new KnowledgeDocumentFailure('parse_timeout'))), PARSE_TIMEOUT_MS)
    worker.once('message', (reply: unknown) => finish(() => {
      if (typeof reply !== 'object' || reply === null || !('ok' in reply) || reply.ok !== true
        || !('text' in reply) || typeof reply.text !== 'string') {
        reject(new KnowledgeDocumentFailure('parse_failed'))
        return
      }
      if (Buffer.byteLength(reply.text, 'utf8') > MAX_TEXT_BYTES || reply.text.trim() === ''
        || containsBinaryControls(reply.text)) {
        reject(new KnowledgeDocumentFailure('invalid_text'))
        return
      }
      resolve(reply.text)
    }))
    worker.once('error', () => finish(() => reject(new KnowledgeDocumentFailure('parse_failed'))))
    worker.once('exit', code => {
      if (code !== 0) finish(() => reject(new KnowledgeDocumentFailure('parse_failed')))
    })
    signal?.addEventListener('abort', abort, {once: true})
    worker.postMessage({kind, bytes})
  })
}

async function readResponseBounded(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_FILE_BYTES)) {
    void response.body?.cancel()
    throw new KnowledgeDocumentFailure('file_too_large')
  }
  if (response.body === null) throw new KnowledgeDocumentFailure('empty_text')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const chunk: {readonly done?: boolean; readonly value?: Uint8Array} = await reader.read()
      if (chunk.done) break
      if (chunk.value === undefined) continue
      total += chunk.value.byteLength
      if (total > MAX_FILE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new KnowledgeDocumentFailure('file_too_large')
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  if (total === 0) throw new KnowledgeDocumentFailure('empty_text')
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function admittedUrl(value: string): URL {
  if (typeof value !== 'string' || value.length > 2_048) throw new KnowledgeDocumentFailure('url_denied')
  const scrubbed = contentPolicy.scrub('url', value)
  if (scrubbed.kind !== 'clean') throw new KnowledgeDocumentFailure('url_denied')
  let url: URL
  try { url = new URL(value) } catch { throw new KnowledgeDocumentFailure('url_denied') }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== ''
    || url.hash !== '') throw new KnowledgeDocumentFailure('url_denied')
  const address = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname
  if (isIP(address) !== 0 && !isPublicAddress(address)) {
    throw new KnowledgeDocumentFailure('url_denied')
  }
  return url
}

const deniedAddresses = new BlockList()
for (const [network, prefix, family] of [
  ['0.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'], ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'], ['169.254.0.0', 16, 'ipv4'], ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'], ['192.0.2.0', 24, 'ipv4'], ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'], ['198.51.100.0', 24, 'ipv4'], ['203.0.113.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'], ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'], ['::1', 128, 'ipv6'], ['fc00::', 7, 'ipv6'], ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'], ['2001:db8::', 32, 'ipv6'],
  ['::ffff:0:0', 96, 'ipv6'], ['64:ff9b::', 96, 'ipv6'], ['64:ff9b:1::', 48, 'ipv6'],
  ['fec0::', 10, 'ipv6'], ['2001::', 23, 'ipv6'], ['2002::', 16, 'ipv6'],
] as const) deniedAddresses.addSubnet(network, prefix, family)

function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 0) return false
  if (family === 6) {
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(address)?.[1]
    if (mapped !== undefined) return isPublicAddress(mapped)
  }
  return !deniedAddresses.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

const publicLookup: LookupFunction = (hostname, options, callback) => {
  void dnsLookup(hostname, {...options, all: true, verbatim: true}).then(addresses => {
    if (addresses.length === 0 || addresses.some(address => !isPublicAddress(address.address))) {
      callback(Object.assign(new Error('address denied'), {code: 'ENOTFOUND'}), '')
      return
    }
    if (options.all === true) callback(null, addresses)
    else callback(null, addresses[0]?.address ?? '', addresses[0]?.family)
  }, () => callback(Object.assign(new Error('lookup failed'), {code: 'ENOTFOUND'}), ''))
}

function htmlToText(html: string): string {
  return decodeEntities(html
    .replace(/<(?:script|style|noscript)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript)>/giu, ' ')
    .replace(/<!--[^]*?-->/gu, ' ')
    .replace(/<[^>]+>/gu, ' '))
    .replace(/[ \t\f\v]+/gu, ' ')
    .replace(/\s*\n\s*/gu, '\n')
    .trim()
}

function decodeUtf8(bytes: Uint8Array): string {
  let text: string
  try { text = new TextDecoder('utf-8', {fatal: true}).decode(bytes) } catch {
    throw new KnowledgeDocumentFailure('invalid_text')
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES || containsBinaryControls(text)) {
    throw new KnowledgeDocumentFailure('invalid_text')
  }
  return text
}

function extractHtmlTitle(html: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/iu.exec(html)
  if (match?.[1] === undefined) return null
  const title = decodeEntities(match[1].replace(/<[^>]+>/gu, ' ')).replace(/\s+/gu, ' ').trim()
  return title === '' ? null : title.slice(0, 300)
}

function decodeEntities(value: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"',
  }
  return value.replace(/&(?:#(x[0-9a-f]+|\d+)|([a-z]+));/giu, (match, numeric: string | undefined, name: string | undefined) => {
    if (numeric !== undefined) {
      const codePoint = Number.parseInt(numeric.startsWith('x') || numeric.startsWith('X') ? numeric.slice(1) : numeric,
        numeric.startsWith('x') || numeric.startsWith('X') ? 16 : 10)
      return Number.isSafeInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        && (codePoint < 0xd800 || codePoint > 0xdfff) ? String.fromCodePoint(codePoint) : '\ufffd'
    }
    return named[name?.toLowerCase() ?? ''] ?? match
  })
}

function screenText(field: string, value: string): void {
  if (contentPolicy.scrub(field, value).kind !== 'clean' || pathPolicy.scrubText(field, value).kind !== 'clean') {
    throw new KnowledgeDocumentFailure('sensitive_content')
  }
}

function containsBinaryControls(value: string): boolean {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)
}

function codePointsLength(value: string): number {
  return [...value].length
}
