const { readdir, readFile, writeFile } = require('node:fs/promises')
const { resolve } = require('node:path')

const ARCHITECTURES = Object.freeze({ 1: 'x64', 3: 'arm64', x64: 'x64', arm64: 'arm64' })

module.exports = async function afterPack(context) {
  const architecture = ARCHITECTURES[context.arch]
  const platform = context.electronPlatformName
  const targetId = platform === 'darwin'
    ? `darwin-${architecture}`
    : platform === 'win32'
      ? `win32-${architecture}`
      : `linux-${architecture}-gnu`
  if (!architecture) throw new Error('native resource build rejected')
  let resourcesRoot
  if (platform === 'darwin') {
    const applications = (await readdir(context.appOutDir, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && entry.name.endsWith('.app'))
    if (applications.length !== 1) throw new Error('native resource build rejected')
    resourcesRoot = resolve(context.appOutDir, applications[0].name, 'Contents/Resources')
  } else {
    resourcesRoot = resolve(context.appOutDir, 'resources')
  }
  const [{ generateNativeResourceManifest }, { parseStrictJson }, { replacePackagedAsar }] = await Promise.all([
    import('./native-resource-contract.mjs'),
    import('./strict-json.mjs'),
    import('./build-owned-asar.mjs'),
  ])
  await replacePackagedAsar({
    sourceRoot: resolve(__dirname, '../build/release-app'),
    archivePath: resolve(resourcesRoot, 'app.asar'),
  })
  const reportPath = resolve(__dirname, '../build/release/production-dependencies-v1.json')
  const dependencyReport = parseStrictJson(await readFile(reportPath, 'utf8'))
  const manifest = await generateNativeResourceManifest({
    resourcesRoot,
    targetId,
    dependencyReport,
  })
  await writeFile(
    resolve(resourcesRoot, 'native-resources-v1.json'),
    `${JSON.stringify(manifest)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
}
