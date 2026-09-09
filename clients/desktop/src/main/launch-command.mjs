export const OPEN_SETTINGS_ARGUMENT = '--open-settings'

export function shouldOpenSettings(argv) {
  return Array.isArray(argv) && argv.includes(OPEN_SETTINGS_ARGUMENT)
}
