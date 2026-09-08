export function configureDevelopmentDockIcon({app, platform, iconFile}) {
  if (platform !== 'darwin' || app.isPackaged) return false
  app.dock.setIcon(iconFile)
  return true
}
