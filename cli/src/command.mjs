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
    if (report.capabilities !== undefined) {
      const status = report.capabilities
      stdout.write(`Capabilities: ${status.ok ? 'valid' : 'needs attention'}${status.reason ? ` (${status.reason})` : ''}\n`)
      if (status.modules) {
        for (const [name, module] of Object.entries(status.modules)) stdout.write(`  ${name}: ${module.enabled ? 'enabled' : 'disabled'}${module.provider ? ` (${module.provider})` : ''}\n`)
        stdout.write(`  FrontBrain budget: ${status.toolBudget}; exact count requires runtime composition\n`)
        for (const server of status.servers) stdout.write(`  MCP ${server.name}: ${server.status}${server.reason ? ` (${server.reason})` : ''}\n`)
        for (const name of status.overrides) stdout.write(`  Override: ${name}\n`)
      }
    }
    return report.supported && report.capabilities?.ok !== false ? 0 : 1
  }
  if (command !== 'start' && command !== 'config') {
    stdout.write(`${HELP_TEXT}\n`)
    return 2
  }
  const installed = await ensure()
  await launch(installed.executable, {openSettings: command === 'config'})
  return 0
}
