import {fileURLToPath} from 'node:url'
import {writeFileSync} from 'node:fs'
import {dirname, resolve} from 'node:path'
import {installAcceptanceGate,probeAcceptanceGate,acceptanceRuntimeHash} from './desktop/workbench-acceptance.js'
import {installDesktopControl, handleFeishuSettings, handlePersonalSettings, PERSONAL_SETTINGS_METHODS, desktopBudgetFailure, desktopConfigurationFailure, type DesktopCapabilityState} from './desktop/desktop-control.js'
import {runDesktopEntryWithStopSources, type DesktopStopParentSource} from './desktop/desktop-session.js'
import {describeStartupError} from './desktop/startup-error.js'
import {announceReadiness} from './desktop.js'
import {buildProductionComposition} from './composition/production-composition.js'
import {renamedEnvironmentWarnings} from './config/config.js'
import type {CodingBackendId} from './config/coding-backends.js'

type UtilityProcess = NodeJS.Process & {readonly parentPort?: DesktopStopParentSource & {postMessage(message: unknown): void}}

const acceptance=installAcceptanceGate()
if(process.argv.includes('--nova-workbench-acceptance-required')&&!acceptance)throw Error('acceptance_gate_missing')

const token = process.env.DESKTOP_TOKEN ?? ''
const readyEndpoint = process.env.DESKTOP_READY_ENDPOINT ?? ''
const stop = new AbortController()
const parentPort = (process as UtilityProcess).parentPort
const acceptanceProbe=acceptance?await probeAcceptanceGate():undefined
if(acceptance&&acceptanceProbe)parentPort?.postMessage({type:'nova:acceptance:gate-ready',buildCommit:acceptance.buildCommit,runtimeHash:acceptanceRuntimeHash(fileURLToPath(import.meta.url)),...acceptanceProbe})

let capabilityView: (() => DesktopCapabilityState | undefined) = () => undefined
let knowledgeHandle: ((method: string, params: unknown) => Promise<unknown>) | undefined
let feishuHandle: ((method: string, params: unknown) => Promise<unknown>) | undefined
let personalSettingsHandle: ((method: string, params: unknown) => Promise<unknown>) | undefined
let phoneHandle: ((method:string,params:unknown)=>Promise<unknown>) | undefined
let clearConversation: (() => Promise<void>) | undefined
let updateCodingBackend: ((backend: CodingBackendId) => void) | undefined
const control = installDesktopControl({...(parentPort === undefined ? {} : {parentPort}), signal: stop.signal,
  updateCodingBackend: backend => {
    if (updateCodingBackend === undefined) throw new Error('coding_unavailable')
    updateCodingBackend(backend)
  },
  status: () => capabilityView(), handle: async (method, params) => {
    if (['phone.start','phone.stop','phone.status'].includes(method)) return phoneHandle?.(method,params)
    if (method.startsWith('feishu.')) return feishuHandle?.(method, params)
    if (PERSONAL_SETTINGS_METHODS.includes(method)) return personalSettingsHandle?.(method, params)
    if (method !== 'conversation.clear') return knowledgeHandle?.(method, params)
    if (clearConversation === undefined || params === null || typeof params !== 'object'
      || Array.isArray(params) || Object.keys(params).length !== 0) return {error: 'unavailable'}
    try { await clearConversation(); return {cleared: true} }
    catch { return {error: 'clear_failed'} }
  }})

const onDiagnostic = (line: string): void => {
  process.stderr.write(`${line}\n`)
}
for (const warning of renamedEnvironmentWarnings(process.env)) onDiagnostic(warning)

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
    const code=error instanceof Error?(error as {code?:unknown}).code:undefined
    const detail=error instanceof Error?`${error.name}${typeof code==='string'?` [${code}]`:''}: ${error.message}`:typeof error
    onDiagnostic(`[runtime-startup-error] ${describeStartupError(error)}`)
    if(acceptance){
      onDiagnostic(`[acceptance-startup-error] ${detail.replace(/[\r\n]/gu,' ').slice(0,300)}`)
      const report=process.env.NOVA_WORKBENCH_ACCEPTANCE_REPORT
      if(report)writeFileSync(resolve(dirname(report),'startup-error.json'),JSON.stringify({detail,stack:error instanceof Error?error.stack?.split('\n').slice(0,8):undefined})+'\n',{mode:0o600})
    }
    const status = desktopBudgetFailure(error) ?? desktopConfigurationFailure(error)
    capabilityView = () => status
    control.publish()
  },
  construct: async ownership => {
    const composition = await buildProductionComposition({token, stop, ownership, onDiagnostic, onUsage: control.publishUsage,
      onKnowledge: knowledge => { knowledgeHandle = (method, params) => knowledge.service.handle(method, params) },
      onCoding: coding => { if (coding.updateDefaultBackend) updateCodingBackend = backend => coding.updateDefaultBackend!(backend) },
    })
    phoneHandle = composition.phoneControl
    capabilityView = () => ({...composition.realtime.capabilityStatus, state: 'running'})
    clearConversation = () => composition.realtime.clearConversation()
    feishuHandle = (method, params) => handleFeishuSettings(input => composition.realtime.personalAgent.command(input), method, params)
    personalSettingsHandle = (method, params) => handlePersonalSettings(input => composition.realtime.personalAgent.command(input), method, params)
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
// Electron utility processes can retain native/IPC handles after all owned
// services have drained. Finish only here, after stop-source and control disposal.
if (exitCode !== 0 || parentPort !== undefined) {
  await new Promise<void>(resolve => process.stderr.write('', () => resolve()))
  process.exit(exitCode)
}
