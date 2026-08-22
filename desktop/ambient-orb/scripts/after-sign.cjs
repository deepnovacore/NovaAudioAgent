'use strict'

const {writeNativeResourceManifest} = require('./after-pack.cjs')

async function refreshWindowsNativeManifestAfterSign(
  context,
  {writeManifest = writeNativeResourceManifest} = {},
) {
  if (context?.electronPlatformName !== 'win32') return
  await writeManifest(context)
}

module.exports = refreshWindowsNativeManifestAfterSign
module.exports.refreshWindowsNativeManifestAfterSign = refreshWindowsNativeManifestAfterSign
