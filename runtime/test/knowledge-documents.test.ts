import assert from 'node:assert/strict'
import {mkdtemp, open, realpath, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {
  chunkKnowledgeText,
  fetchKnowledgeUrl,
  KnowledgeDocumentFailure,
  readKnowledgeFile,
} from '../src/knowledge/documents.js'

test('chunks by heading with a 480-code-point overlap and a 3200-code-point cap', () => {
  const body = `${'A'.repeat(2_600)}${'B'.repeat(1_400)}`
  const chunks = chunkKnowledgeText(`# Guide\n## Install\n${body}`)

  assert.equal(chunks.length, 2)
  assert.deepEqual(chunks.map(chunk => chunk.heading_path), ['Guide > Install', 'Guide > Install'])
  assert.ok(chunks.every(chunk => [...chunk.text].length <= 3_200 && chunk.text !== ''))
  assert.equal(chunks[0]?.text.slice(-480), chunks[1]?.text.slice(0, 480))
  assert.deepEqual(chunks.map(chunk => chunk.token_estimate), [800, 320])
})

test('never emits empty chunks and rejects credential-bearing source text', () => {
  assert.deepEqual(chunkKnowledgeText('\n# Empty\n\n## Still empty\n'), [])
  assert.throws(
    () => chunkKnowledgeText('safe context token=credential-value-123456789'),
    error => error instanceof KnowledgeDocumentFailure && error.code === 'sensitive_content',
  )
  assert.throws(
    () => chunkKnowledgeText('read /repo/.ssh/id_ed25519 for details'),
    error => error instanceof KnowledgeDocumentFailure && error.code === 'sensitive_content',
  )
})

test('reads an admitted regular UTF-8 file with stable metadata and fingerprint', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-knowledge-'))
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(directory, {recursive: true})) })
  const path = join(directory, 'guide.md')
  await writeFile(path, '# Hello\n\nPlain text.', 'utf8')

  const document = await readKnowledgeFile(path)

  assert.equal(document.title, 'guide.md')
  assert.equal(document.mime, 'text/markdown')
  assert.equal(document.text, '# Hello\n\nPlain text.')
  assert.equal(document.bytes, 20)
  assert.match(document.fingerprint, /^[a-f0-9]{64}$/u)
  assert.equal(document.locator, await realpath(path))
})

test('rejects relative, empty, binary, oversized, sensitive, and symlink-sensitive files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-knowledge-'))
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(directory, {recursive: true})) })
  const empty = join(directory, 'empty.txt')
  const binary = join(directory, 'binary.txt')
  const oversized = join(directory, 'oversized.txt')
  const secret = join(directory, '.env.production')
  const linked = join(directory, 'notes.txt')
  await writeFile(empty, '')
  await writeFile(binary, new Uint8Array([0, 1, 2]))
  const handle = await open(oversized, 'w')
  await handle.truncate(10 * 1_024 * 1_024 + 1)
  await handle.close()
  await writeFile(secret, 'ordinary words')
  await symlink(secret, linked)

  for (const path of ['relative.txt', empty, binary, oversized, secret, linked]) {
    await assert.rejects(readKnowledgeFile(path), error => error instanceof KnowledgeDocumentFailure)
  }
})

test('parses PDF and DOCX through the bounded worker', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-knowledge-'))
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(directory, {recursive: true})) })
  const pdfPath = join(directory, 'guide.pdf')
  const docxPath = join(directory, 'guide.docx')
  await writeFile(pdfPath, makePdf('Hello PDF'))
  await writeFile(docxPath, await makeDocx('Hello DOCX'))

  const pdf = await readKnowledgeFile(pdfPath)
  assert.match(pdf.text, /Hello PDF/u)
  assert.equal(pdf.mime, 'application/pdf')
  const docx = await readKnowledgeFile(docxPath)
  assert.match(docx.text, /Hello DOCX/u)
  assert.equal(docx.mime, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
})

test('rejects URL credentials, private destinations, unsupported MIME, and cancellation', async () => {
  const values = [
    'https://user:password@example.com/file.txt',
    'https://example.com/file.txt?access_token=credential-value-12345',
    'http://127.0.0.1/file.txt',
    'http://[::1]/file.txt',
    'http://[::ffff:127.0.0.1]/file.txt',
    'ftp://example.com/file.txt',
  ]
  for (const value of values) {
    await assert.rejects(fetchKnowledgeUrl(value), error => error instanceof KnowledgeDocumentFailure)
  }

  const stopped = new AbortController()
  stopped.abort()
  await assert.rejects(fetchKnowledgeUrl('https://example.com/file.txt', stopped.signal), {name: 'AbortError'})
})

function makePdf(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let source = '%PDF-1.4\n'
  const offsets: number[] = []
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source))
    source += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(source)
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  source += offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(source)
}

async function makeDocx(text: string): Promise<Uint8Array> {
  const moduleName = 'jszip'
  const imported = await import(moduleName) as {
    default: new () => {
      file(path: string, value: string): void
      generateAsync(options: {readonly type: 'uint8array'}): Promise<Uint8Array>
    }
  }
  const zip = new imported.default()
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`)
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>
    </w:document>`)
  return await zip.generateAsync({type: 'uint8array'})
}
