import { ensureDesktop, inspectDoctor, launchDesktop } from './runtime.mjs'
import { PRODUCT_VERSION } from './target.mjs'

export const HELP_TEXT = `Usage: novaaudio [start|config|doctor|--version|--help]

  novaaudio          Install if needed and launch Nova Audio Agent
  novaaudio start    Install if needed and launch Nova Audio Agent
  novaaudio config   Open the desktop settings window
  novaaudio doctor   Inspect local installation and configuration status`

export async function main(argv, {
  stdout = process.stdout,
  ensure = ensureDesktop,
  launch = launchDesktop,
  doctor = inspectDoctor,
} = {}) {
  const command = argv[0] ?? 'start'
  if (argv.length > 1) {
    stdout.write(`${HELP_TEXT}\n`)
    return 2
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    stdout.write(`${HELP_TEXT}\n`)
    return 0
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    stdout.write(`${PRODUCT_VERSION}\n`)
    return 0
  }
  if (command === 'doctor') {
    const report = await doctor()
    stdout.write(`Nova Audio Agent ${PRODUCT_VERSION}\n`)
    stdout.write(`Platform: ${report.platform} (${report.supported ? 'supported' : 'unsupported'})\n`)
    if (report.supported) {
      stdout.write(`Desktop cache: ${report.desktopReady ? 'ready' : 'missing'}\n`)
      stdout.write(`Settings: ${report.settingsPresent ? 'present' : 'missing'}\n`)
      stdout.write(`Configured keys: ${report.configuredSecretKeys.length === 0 ? 'none' : report.configuredSecretKeys.join(', ')}\n`)
      stdout.write(`Codex: ${report.codexPresent ? 'found' : 'missing'}\n`)
    }
    return report.supported ? 0 : 1
  }
  if (command !== 'start' && command !== 'config') {
    stdout.write(`${HELP_TEXT}\n`)
    return 2
  }
  const installed = await ensure()
  launch(installed.executable, {openSettings: command === 'config'})
  return 0
}
