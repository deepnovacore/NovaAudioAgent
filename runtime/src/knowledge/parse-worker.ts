import {Buffer} from 'node:buffer'
import {parentPort} from 'node:worker_threads'

const MAX_TEXT_BYTES = 10 * 1_024 * 1_024
const MAX_DOCX_ENTRY_BYTES = 16 * 1_024 * 1_024
const MAX_DOCX_EXPANDED_BYTES = 32 * 1_024 * 1_024
const MAX_DOCX_ENTRIES = 4_096

interface ParseRequest {
  readonly kind: 'pdf' | 'docx'
  readonly bytes: Uint8Array
}

interface ParseReply {
  readonly ok: boolean
  readonly text?: string
}

function appendBounded(parts: string[], value: string, total: {bytes: number}): void {
  total.bytes += Buffer.byteLength(value, 'utf8')
  if (total.bytes > MAX_TEXT_BYTES) throw new Error('too_large')
  parts.push(value)
}

async function parsePdf(bytes: Uint8Array): Promise<string> {
  const moduleName = 'pdfjs-dist/legacy/build/pdf.mjs'
  const pdfjs = await import(moduleName) as {
    getDocument(options: Record<string, unknown>): {
      readonly promise: Promise<{
        readonly numPages: number
        getPage(page: number): Promise<{getTextContent(): Promise<{items: unknown[]}>}>
      }>
      destroy(): Promise<void>
    }
  }
  const task = pdfjs.getDocument({
    data: bytes,
    disableAutoFetch: true,
    disableFontFace: true,
    disableStream: true,
    isEvalSupported: false,
    useSystemFonts: false,
    useWorkerFetch: false,
    verbosity: 0,
  })
  const document = await task.promise
  const parts: string[] = []
  const total = {bytes: 0}
  try {
    if (!Number.isSafeInteger(document.numPages) || document.numPages < 1 || document.numPages > 10_000) {
      throw new Error('too_large')
    }
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      const pageText = content.items
        .map(item => typeof item === 'object' && item !== null && 'str' in item
          && typeof (item as {str?: unknown}).str === 'string' ? (item as {str: string}).str : '')
        .filter(value => value !== '')
        .join(' ')
      appendBounded(parts, pageText, total)
      if (pageNumber < document.numPages) appendBounded(parts, '\n\n', total)
    }
    return parts.join('')
  } finally {
    await task.destroy()
  }
}

async function parseDocx(bytes: Uint8Array): Promise<string> {
  await verifyDocxArchive(bytes)
  const moduleName = 'mammoth'
  const mammoth = await import(moduleName) as {
    extractRawText(input: {readonly buffer: Buffer}): Promise<{readonly value: string}>
  }
  const result = await mammoth.extractRawText({buffer: Buffer.from(bytes)})
  if (Buffer.byteLength(result.value, 'utf8') > MAX_TEXT_BYTES) throw new Error('too_large')
  return result.value
}

interface ZipEntry {
  readonly dir: boolean
  readonly _data?: {readonly uncompressedSize?: number}
  nodeStream(type: 'nodebuffer'): ZipStream
}

interface ZipStream {
  destroy(): void
  on(event: 'data', listener: (value: unknown) => void): ZipStream
  once(event: 'end', listener: () => void): ZipStream
  once(event: 'error', listener: (error: unknown) => void): ZipStream
}

async function verifyDocxArchive(bytes: Uint8Array): Promise<void> {
  const moduleName = 'jszip'
  const imported = await import(moduleName) as {
    default: {
      loadAsync(data: Buffer): Promise<{readonly files: Readonly<Record<string, ZipEntry>>}>
    }
  }
  const archive = await imported.default.loadAsync(Buffer.from(bytes))
  const entries = Object.values(archive.files)
  if (entries.length > MAX_DOCX_ENTRIES) throw new Error('too_large')
  let declaredTotal = 0
  for (const entry of entries) {
    if (entry.dir) continue
    const declared = entry._data?.uncompressedSize
    if (!Number.isSafeInteger(declared) || declared === undefined || declared < 0
      || declared > MAX_DOCX_ENTRY_BYTES) throw new Error('too_large')
    declaredTotal += declared
    if (declaredTotal > MAX_DOCX_EXPANDED_BYTES) throw new Error('too_large')
  }

  let actualTotal = 0
  for (const entry of entries) {
    if (entry.dir) continue
    actualTotal = await verifyZipEntry(entry, actualTotal)
  }
}

function verifyZipEntry(entry: ZipEntry, previousTotal: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const stream = entry.nodeStream('nodebuffer')
    let entryBytes = 0
    let total = previousTotal
    let settled = false
    const fail = (): void => {
      if (settled) return
      settled = true
      stream.destroy()
      reject(new Error('too_large'))
    }
    stream.on('data', value => {
      if (!(value instanceof Uint8Array)) { fail(); return }
      entryBytes += value.byteLength
      total += value.byteLength
      if (entryBytes > MAX_DOCX_ENTRY_BYTES || total > MAX_DOCX_EXPANDED_BYTES) fail()
    })
    stream.once('error', () => fail())
    stream.once('end', () => {
      if (settled) return
      settled = true
      resolve(total)
    })
  })
}

parentPort?.once('message', (request: ParseRequest) => {
  const parsed = request.kind === 'pdf' ? parsePdf(request.bytes) : parseDocx(request.bytes)
  void parsed.then(
    text => { parentPort?.postMessage({ok: true, text} satisfies ParseReply) },
    () => { parentPort?.postMessage({ok: false} satisfies ParseReply) },
  )
})
