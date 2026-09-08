import {join} from 'node:path'

export const DESKTOP_PRODUCT_NAME = 'Nova Audio Agent Desktop'
// Storage ABI only: Electron derives OS encryption identities before app readiness.
// Keep existing encrypted settings readable without copying or re-encrypting secrets.
export const LEGACY_STORAGE_NAME = 'Nova Audio Agent Ambient Orb'
export function configureDesktopIdentity(app) {
  app.setName(LEGACY_STORAGE_NAME)
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    app.setPath('userData', join(app.getPath('appData'), LEGACY_STORAGE_NAME))
  }
  // Crypto configuration has captured the stable identity before ready. Restore the
  // public name before any window/menu is created; productName also names the binary.
  return app.whenReady().then(() => app.setName(DESKTOP_PRODUCT_NAME))
}
