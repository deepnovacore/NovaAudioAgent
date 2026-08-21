import {createPackageWithOptions} from '@electron/asar'
import {lstat, mkdtemp, rename, rm} from 'node:fs/promises'
import {basename, dirname, resolve} from 'node:path'

export async function replacePackagedAsar({sourceRoot, archivePath}) {
  if (basename(archivePath) !== 'app.asar') throw new Error('owned ASAR build rejected')
  const resourcesRoot = dirname(archivePath)
  const privateRoot = await mkdtemp(resolve(resourcesRoot, '.nova-owned-asar-'))
  const pendingArchive = resolve(privateRoot, 'app.asar')
  const pendingUnpacked = `${pendingArchive}.unpacked`
  try {
    await createPackageWithOptions(sourceRoot, pendingArchive, {
      unpack: resolve(sourceRoot, '**/*.{node,dylib,dll,so,so.*}'),
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
  } finally {
    await rm(privateRoot, {recursive: true, force: true})
  }
}
