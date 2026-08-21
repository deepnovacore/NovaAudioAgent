import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {constants as fsConstants} from 'node:fs'
import {mkdir, open, readdir, rm, writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'

const ASSETS = Object.freeze([
  Object.freeze({
    name: 'MANIFEST.json',
    sha256: 'd0f6a2610011449068165b111c5e144f9238de5ec2c3fb72d48e53398ca73f76',
  }),
  Object.freeze({
    name: 'LICENSE.silero-vad.txt',
    sha256: '2e63e9a38b6e8fc0c7bc37ce174caca1862870856c6daf5697cfb785e925520b',
  }),
  Object.freeze({
    name: 'silence-16k-s16le.pcm',
    sha256: '354c4c84336b04e0bd855bd6a2be99d114760ee7f398953471694f42cb88f30e',
  }),
  Object.freeze({
    name: 'speech-16k-s16le.pcm',
    sha256: '5ecb547c0ffbfba27f9705bf4de7ecafd5343c3a86c23ecd2d347a7618a8a962',
  }),
])

async function readOwnedAsset(path, expectedHash) {
  let handle
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    const status = await handle.stat()
    assert.ok(status.isFile() && status.size > 0 && status.size <= 1024 * 1024,
      'endpointing_probe_asset_invalid')
    const bytes = Buffer.alloc(status.size)
    const {bytesRead} = await handle.read(bytes, 0, bytes.length, 0)
    assert.equal(bytesRead, bytes.length, 'endpointing_probe_asset_invalid')
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedHash,
      'endpointing_probe_asset_invalid')
    const after = await handle.stat()
    assert.equal(after.dev, status.dev, 'endpointing_probe_asset_changed')
    assert.equal(after.ino, status.ino, 'endpointing_probe_asset_changed')
    assert.equal(after.size, status.size, 'endpointing_probe_asset_changed')
    return bytes
  } finally {
    await handle?.close().catch(() => {})
  }
}

export async function stageEndpointingProbeAssets({repositoryRoot, outputRoot}) {
  const source = resolve(repositoryRoot, 'fixtures/realtime/volcengine/v1/endpointing')
  const inventory = (await readdir(source)).sort()
  assert.deepEqual(inventory, ASSETS.map(asset => asset.name).sort(),
    'endpointing_probe_asset_inventory_invalid')
  const destination = resolve(outputRoot, 'endpointing/volcengine-v1')
  await rm(destination, {recursive: true, force: true})
  await mkdir(destination, {recursive: true, mode: 0o700})
  for (const asset of ASSETS) {
    const bytes = await readOwnedAsset(resolve(source, asset.name), asset.sha256)
    await writeFile(resolve(destination, asset.name), bytes, {mode: 0o600})
  }
  return destination
}
