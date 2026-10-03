import {ClientPairing} from './server/client-pairing.js'
/** Headless production service. No Electron, parent-port, or stdin lifecycle dependency. */
import {pathToFileURL} from 'node:url'
import {renamedEnvironmentWarnings} from './config/config.js'
import {initializeServerToken, loadServerConfig, type ServerConfig} from './server/server-config.js'
import type {DesktopEntryOptions, DesktopStopEventSource} from './desktop/desktop-session.js'

export async function runServerEntry(options: {
  readonly environment?: NodeJS.ProcessEnv
  readonly stop?: AbortController
  readonly processEvents?: DesktopStopEventSource
  readonly construct?: DesktopEntryOptions['construct']
  readonly onDiagnostic?: (line: string) => void
} = {}): Promise<0 | 2> {
  const onDiagnostic = options.onDiagnostic ?? (line => { process.stderr.write(`${line}\n`) })
  // Before the configuration check, so a stale name is reported even when it is the reason startup fails.
  for (const warning of renamedEnvironmentWarnings(options.environment ?? process.env)) onDiagnostic(warning)
  let config: ServerConfig
  let pairing: ClientPairing
  try {
    config = loadServerConfig(options.environment)
    const environment = options.environment ?? process.env
    pairing = new ClientPairing(config.token, `${environment.SERVER_TOKEN_FILE}.devices.json`)
  } catch {
    onDiagnostic('[runtime-diagnostic] configuration_required')
    return 2
  }
  const stop = options.stop ?? new AbortController()
  const events = options.processEvents ?? process
  const requestStop = (): void => stop.abort()
  events.once('SIGINT', requestStop)
  events.once('SIGTERM', requestStop)
  try {
    if (config.mediaMode === 'aoq_chat') {
      const {AoqChatServer, issueAoqCredential, aoqCredentialURL} = await import('./server/aoq-chat-server.js')
      const environment = options.environment ?? process.env
      const apiHost = environment.AOQ_API_HOST ?? ''
      try { aoqCredentialURL(apiHost) } catch {
        onDiagnostic('[runtime-diagnostic] aoq_api_host_required')
        return 2
      }
      const server = new AoqChatServer({token: config.token, pairing, port: config.port,
        ...(config.language === undefined ? {} : {language: config.language}),
        issueCredential: signal => issueAoqCredential(environment.DASHSCOPE_API_KEY ?? '', signal, apiHost)})
      try {
        if (stop.signal.aborted) return 0
        const readiness = await server.start()
        onDiagnostic(`[server-ready] ws://${readiness.host}:${readiness.port}/client/v1`)
        if (!stop.signal.aborted) await new Promise<void>(resolve => stop.signal.addEventListener('abort', () => resolve(), {once: true}))
        return 0
      } catch {
        onDiagnostic('[runtime-diagnostic] aoq_server_unavailable')
        return 2
      } finally { await server.close() }
    }
    const {runDesktopEntry} = await import('./desktop/desktop-session.js')
    const aoq = config.mediaMode === 'aoq_runtime'
    const environment = options.environment ?? process.env
    const aoqModule = aoq ? await import('./server/aoq-chat-server.js') : undefined
    const aoqProvider = aoq ? await import('./realtime/aoq.js') : undefined
    const link = aoqProvider === undefined ? undefined : new aoqProvider.AoqRuntimeLink()
    const apiHost = environment.AOQ_API_HOST ?? ''
    if (aoq) {
      try { aoqModule!.aoqCredentialURL(apiHost) } catch {
        onDiagnostic('[runtime-diagnostic] aoq_api_host_required'); return 2
      }
    }
    return await runDesktopEntry({
      token: config.token, stop, onDiagnostic, listenBeforeRealtime: aoq,
      announce: (_endpoint, readiness) => {
        onDiagnostic(`[server-ready] ws://${readiness.host}:${readiness.port}/client/v1`)
        return Promise.resolve()
      },
      construct: options.construct ?? (async ownership => {
        const {buildProductionComposition} = await import('./composition/production-composition.js')
        const {ClientServer} = await import('./server/client-server.js')
        return buildProductionComposition({
          token: config.token, stop, ownership, onDiagnostic, remote: true,
          environment: aoq ? {...environment, PIPELINE_MODE: 'integrated',
            INTEGRATED_PROVIDER: 'qwen',
            QWEN_REALTIME_MODEL: 'qwen-audio-3.0-realtime-plus',
            QWEN_REALTIME_VOICE: 'longanqian'} : environment,
          ...(link === undefined ? {} : {integratedProviders: {qwen: input => new aoqProvider!.AoqRealtimeAdapter({
            ...input.config, ...(input.language === undefined ? {} : {language: input.language}), link, onDiagnostic, idFactory: input.idFactory, now: input.now,
            executorApproval: input.executorApproval,
            ...(input.modules === undefined ? {} : {modules: input.modules}),
          })}}),
          createServer: (serverOptions, media) => link === undefined
            ? new ClientServer({...serverOptions, pairing, ...(media === undefined ? {} : {media}), port: config.port})
            : new aoqModule!.AoqChatServer({token: config.token, pairing, port: config.port, onDiagnostic,
                issueCredential: signal => aoqModule!.issueAoqCredential(environment.DASHSCOPE_API_KEY ?? '', signal, apiHost),
                runtime: {...serverOptions,
                  onProviderConnect: attachment => link.attach(attachment),
                  onProviderEvent: (id, event) => link.receive(id, event),
                  onProviderDisconnect: id => link.detach(id),
                },
              }),
        })
      }),
    })
  } finally {
    for (const event of ['SIGINT', 'SIGTERM']) {
      if (events.off !== undefined) events.off(event, requestStop)
      else events.removeListener?.(event, requestStop)
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'token-init') {
    try {
      initializeServerToken(process.env.SERVER_TOKEN_FILE ?? '')
      process.stderr.write('[server-token] initialized local credential file\n')
    } catch {
      process.stderr.write('[runtime-diagnostic] token_initialization_failed\n')
      process.exitCode = 2
    }
  } else if (process.argv.length > 2) {
    process.stderr.write('Usage: server-entry.js [token-init]\n')
    process.exitCode = 2
  } else process.exitCode = await runServerEntry()
}
