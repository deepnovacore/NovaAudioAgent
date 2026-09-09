const { chmod, readdir, readFile, rename, writeFile } = require('node:fs/promises')
const { resolve } = require('node:path')

const ARCHITECTURES = Object.freeze({ 1: 'x64', 3: 'arm64', x64: 'x64', arm64: 'arm64' })

module.exports = async function afterPack(context) {
  const {platform, resourcesRoot} = await packagedResourceContext(context)
  const [
    { replacePackagedAsar },
    { runPackagedImportSmoke },
  ] = await Promise.all([
    import('./build-owned-asar.mjs'),
    import('./run-packaged-import-smoke.mjs'),
  ])
  await replacePackagedAsar({
    sourceRoot: resolve(__dirname, '../build/release-app'),
    archivePath: resolve(resourcesRoot, 'app.asar'),
  })
  await writeNativeResourceManifest(context)
  runPackagedImportSmoke({
    appOutDir: context.appOutDir,
    resourcesRoot,
    platform,
    productFilename: context.packager.appInfo.productFilename,
  })
}

async function packagedResourceContext(context) {
  const architecture = ARCHITECTURES[context.arch]
  const platform = context.electronPlatformName
  if (!architecture) throw new Error('native resource build rejected')
  const targetId = platform === 'darwin'
    ? `darwin-${architecture}`
    : platform === 'win32'
      ? `win32-${architecture}`
      : `linux-${architecture}-gnu`
  let resourcesRoot
  if (platform === 'darwin') {
    const applications = (await readdir(context.appOutDir, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && entry.name.endsWith('.app'))
    if (applications.length !== 1) throw new Error('native resource build rejected')
    resourcesRoot = resolve(context.appOutDir, applications[0].name, 'Contents/Resources')
  } else {
    resourcesRoot = resolve(context.appOutDir, 'resources')
  }
  return {architecture, platform, resourcesRoot, targetId}
}

async function writeNativeResourceManifest(context) {
  const {resourcesRoot, targetId} = await packagedResourceContext(context)
  const [
    { generateNativeResourceManifest },
    { parseStrictJson },
  ] = await Promise.all([
    import('./native-resource-contract.mjs'),
    import('./strict-json.mjs'),
  ])
  const reportPath = resolve(__dirname, '../build/release/production-dependencies-v1.json')
  const dependencyReport = parseStrictJson(await readFile(reportPath, 'utf8'))
  const manifest = await generateNativeResourceManifest({
    resourcesRoot,
    targetId,
    dependencyReport,
  })
  const destination = resolve(resourcesRoot, 'native-resources-v1.json')
  const temporary = resolve(resourcesRoot, '.native-resources-v1.json.hook')
  await writeFile(
    temporary,
    `${JSON.stringify(manifest)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
  await chmod(temporary, 0o600)
  await rename(temporary, destination)
}

module.exports.writeNativeResourceManifest = writeNativeResourceManifest
