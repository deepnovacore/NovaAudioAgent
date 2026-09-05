import {Buffer} from 'node:buffer'
import {parentPort} from 'node:worker_threads'

const MAX_TEXT_BYTES = 10 * 1_024 * 1_024

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
  const moduleName = 'mammoth'
  const mammoth = await import(moduleName) as {
    extractRawText(input: {readonly buffer: Buffer}): Promise<{readonly value: string}>
  }
  const result = await mammoth.extractRawText({buffer: Buffer.from(bytes)})
  if (Buffer.byteLength(result.value, 'utf8') > MAX_TEXT_BYTES) throw new Error('too_large')
  return result.value
}

parentPort?.once('message', (request: ParseRequest) => {
  const parsed = request.kind === 'pdf' ? parsePdf(request.bytes) : parseDocx(request.bytes)
  void parsed.then(
    text => { parentPort?.postMessage({ok: true, text} satisfies ParseReply) },
    () => { parentPort?.postMessage({ok: false} satisfies ParseReply) },
  )
})
