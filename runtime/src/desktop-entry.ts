import {installDesktopControl, desktopBudgetFailure, type DesktopCapabilityState} from './desktop-control.js'
import {runDesktopEntryWithStopSources, type DesktopStopParentSource} from './desktop-service.js'
import {announceReadiness} from './desktop.js'
import {buildProductionComposition} from './production-composition.js'

type UtilityProcess = NodeJS.Process & {readonly parentPort?: DesktopStopParentSource & {postMessage(message: unknown): void}}

const token = process.env.NOVA_AUDIO_AGENT_DESKTOP_TOKEN ?? ''
const readyEndpoint = process.env.NOVA_AUDIO_AGENT_DESKTOP_READY_ENDPOINT ?? ''
const stop = new AbortController()
const parentPort = (process as UtilityProcess).parentPort

let capabilityView: (() => DesktopCapabilityState | undefined) = () => undefined
let knowledgeHandle: ((method: string, params: unknown) => Promise<unknown>) | undefined
let clearConversation: (() => Promise<void>) | undefined
const control = installDesktopControl({...(parentPort === undefined ? {} : {parentPort}), signal: stop.signal,
  status: () => capabilityView(), handle: async (method, params) => {
    if (method !== 'conversation.clear') return knowledgeHandle?.(method, params)
    if (clearConversation === undefined || params === null || typeof params !== 'object'
      || Array.isArray(params) || Object.keys(params).length !== 0) return {error: 'unavailable'}
    try { await clearConversation(); return {cleared: true} }
    catch { return {error: 'clear_failed'} }
  }})

const onDiagnostic = (line: string): void => {
  process.stderr.write(`${line}\n`)
}

const exitCode = await runDesktopEntryWithStopSources({
  token,
  readyEndpoint,
  stop,
  announce: (endpoint, readiness, signal) => announceReadiness(
    endpoint,
    readiness,
    {signal},
  ),
  onDiagnostic,
  onStartupFailure: error => {
    const status = desktopBudgetFailure(error)
    capabilityView = () => status
    control.publish()
  },
  construct: async ownership => {
    const composition = await buildProductionComposition({token, stop, ownership, onDiagnostic, onUsage: control.publishUsage,
      onKnowledge: knowledge => { knowledgeHandle = (method, params) => knowledge.service.handle(method, params) },
    })
    capabilityView = () => ({...composition.realtime.capabilityStatus, state: 'running'})
    clearConversation = () => composition.realtime.clearConversation()
    control.publish()
    return composition
  },
}, {
  processEvents: process,
  stdin: process.stdin,
  ...(parentPort === undefined ? {} : {parentPort}),
})

control.dispose()
process.exitCode = exitCode
if (exitCode !== 0) {
  await new Promise<void>(resolve => process.stderr.write('', () => resolve()))
  process.exit(exitCode)
}
