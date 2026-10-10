import {createPackageWithOptions, extractAll, getRawHeader, uncache} from '@electron/asar'
import {createHash} from 'node:crypto'
import {lstat, mkdtemp, readFile, rename, rm, writeFile} from 'node:fs/promises'
import plist from 'plist'
import {basename, dirname, join, resolve} from 'node:path'

export const OWNED_ASAR_UNPACK_DIR = join('node_modules', 'sherpa-onnx')

export async function replacePackagedAsar({sourceRoot, archivePath}) {
  if (basename(archivePath) !== 'app.asar') throw new Error('owned ASAR build rejected')
  const resourcesRoot = dirname(archivePath)
  const privateRoot = await mkdtemp(resolve(resourcesRoot, '.nova-owned-asar-'))
  const pendingArchive = resolve(privateRoot, 'app.asar')
  const pendingUnpacked = `${pendingArchive}.unpacked`
  try {
    await createPackageWithOptions(sourceRoot, pendingArchive, {
      unpack: resolve(sourceRoot, '**/*.{node,dylib,dll,so,so.*}'),
      unpackDir: OWNED_ASAR_UNPACK_DIR,
    })
    const status = await lstat(pendingArchive)
    if (!status.isFile() || status.size <= 0) throw new Error('owned ASAR build rejected')
    await rm(archivePath, {force: true})
    await rm(`${archivePath}.unpacked`, {recursive: true, force: true})
    await rename(pendingArchive, archivePath)
    try {
      const unpackedStatus = await lstat(pendingUnpacked)
      if (!unpackedStatus.isDirectory()) throw new Error('owned ASAR build rejected')
      await rename(pendingUnpacked, `${archivePath}.unpacked`)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    uncache(archivePath)
  } finally {
    await rm(privateRoot, {recursive: true, force: true})
  }
}

// Signing can grow an unpacked binary; rebuild the header from the sealed bytes.
export async function refreshSignedAsar(archivePath) {
  const sourceRoot = await mkdtemp(resolve(dirname(archivePath), '.nova-signed-asar-'))
  try {
    extractAll(archivePath, sourceRoot)
    await replacePackagedAsar({sourceRoot, archivePath})
  } finally {await rm(sourceRoot, {recursive: true, force: true})}
}

export async function refreshMacAsarIntegrity(archivePath, plistPath) {
  const info = plist.parse(await readFile(plistPath, 'utf8'))
  info.ElectronAsarIntegrity = {
    ...info.ElectronAsarIntegrity,
    'Resources/app.asar': {
      algorithm: 'SHA256',
      hash: createHash('sha256').update(getRawHeader(archivePath).headerString).digest('hex'),
    },
  }
  await writeFile(plistPath, plist.build(info))
}
