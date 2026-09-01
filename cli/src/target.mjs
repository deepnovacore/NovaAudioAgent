import { homedir } from 'node:os'
import { join } from 'node:path'

export const PRODUCT_VERSION = '0.1.0'
export const RELEASE_REPOSITORY = 'deepnovacore/NovaAudioAgent'

const DEFINITIONS = Object.freeze({
  'darwin-arm64': Object.freeze({
    artifact: `nova-audio-agent-${PRODUCT_VERSION}-macos-arm64-app.zip`,
    executable: 'Nova Audio Agent Ambient Orb.app/Contents/MacOS/Nova Audio Agent Ambient Orb',
    archive: 'zip',
  }),
  'darwin-x64': Object.freeze({
    artifact: `nova-audio-agent-${PRODUCT_VERSION}-macos-x64-app.zip`,
    executable: 'Nova Audio Agent Ambient Orb.app/Contents/MacOS/Nova Audio Agent Ambient Orb',
    archive: 'zip',
  }),
  'win32-x64': Object.freeze({
    artifact: `nova-audio-agent-${PRODUCT_VERSION}-windows-x64-portable.zip`,
    executable: 'Nova Audio Agent Ambient Orb.exe',
    archive: 'zip',
  }),
  'linux-x64': Object.freeze({
    artifact: `nova-audio-agent-${PRODUCT_VERSION}-linux-x64.AppImage`,
    executable: 'NovaAudioAgent.AppImage',
    archive: 'file',
  }),
})

export function resolveTarget(platform = process.platform, arch = process.arch) {
  const id = `${platform}-${arch}`
  const definition = DEFINITIONS[id]
  if (definition === undefined) {
    throw new Error(`unsupported platform: ${platform}-${arch}`)
  }
  return Object.freeze({id, ...definition})
}

export function releaseBaseUrl(version = PRODUCT_VERSION) {
  return `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${version}`
}

export function releaseRoot({
  home = homedir(),
  version = PRODUCT_VERSION,
  target = resolveTarget(),
} = {}) {
  return join(home, '.nova-audio-agent', 'cli', 'releases', version, target.id)
}

export function desktopSettingsPath({
  platform = process.platform,
  home = homedir(),
  environment = process.env,
} = {}) {
  const product = 'Nova Audio Agent Ambient Orb'
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', product, 'ambient-orb-settings.json')
  }
  if (platform === 'win32') {
    const appData = environment.APPDATA || join(home, 'AppData', 'Roaming')
    return join(appData, product, 'ambient-orb-settings.json')
  }
  const config = environment.XDG_CONFIG_HOME || join(home, '.config')
  return join(config, product, 'ambient-orb-settings.json')
}
