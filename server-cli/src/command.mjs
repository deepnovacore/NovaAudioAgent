import {fileURLToPath} from 'node:url'
const HELP = `Usage: novaaudio-server [--env-file PATH] [start|token-init|pair WSS_URL|--help]

  start          Run the headless service in the foreground
  token-init     Create the configured private host credential file
  pair WSS_URL   Show a one-use pairing QR in an interactive terminal

Requires SERVER_PORT and SERVER_TOKEN_FILE.
Configure model credentials and workspace in the environment or --env-file.
`
const modules = {
  entry: '../runtime/dist/src/server-entry.js',
  config: '../runtime/dist/src/server/server-config.js',
  pair: '../runtime/scripts/pair-device.mjs',
}

export async function main(argv, {
  environment = process.env,
  write = text => process.stdout.write(text),
  loadEnvFile = path => process.loadEnvFile(path),
  load = name => import(new URL(modules[name], import.meta.url)),
} = {}) {
  const args = [...argv]
  let envFile
  if (args[0] === '--env-file') {
    args.shift()
    envFile = args.shift()
    if (!envFile || envFile.startsWith('-')) { write(HELP); return 2 }
  }
  const command = args.shift() ?? 'start'
  if (command === '--help' && args.length === 0) { write(HELP); return 0 }
  if (!['start', 'token-init', 'pair'].includes(command)
    || args.length !== (command === 'pair' ? 1 : 0)) { write(HELP); return 2 }
  if (envFile) loadEnvFile(envFile)
  if (command === 'start') {
    environment.CODEX_RESOURCES_PATH ??= fileURLToPath(new URL('../resources', import.meta.url))
    return (await load('entry')).runServerEntry({environment})
  }
  const config = await load('config')
  if (command === 'token-init') {
    config.initializeServerToken(environment.SERVER_TOKEN_FILE ?? '')
    write('[server-token] initialized local credential file\n')
  } else {
    const {terminalPair} = await load('pair')
    await terminalPair({...config.loadServerConfig(environment), server: args[0]})
  }
  return 0
}
