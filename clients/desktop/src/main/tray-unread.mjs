export function updateTrayUnread(tray, count, platform = process.platform) {
  if (platform === 'darwin') tray?.setTitle(count ? String(count) : '')
  tray?.setToolTip(count ? `Nova · ${count} 条未读提醒` : 'Nova Audio Agent Desktop')
}
export function resetTrayUnreadForBackend(tray, previous, next, platform = process.platform) {
  if (next.state !== 'connected' || next.connection !== previous.connection) updateTrayUnread(tray, 0, platform)
}
