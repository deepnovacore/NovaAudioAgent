/* eslint-disable @typescript-eslint/require-await -- executable fixture implements async host contracts */
/* eslint-disable @typescript-eslint/no-empty-function -- pending promise and no-op cleanup are the fixture behavior */
import {OwnedCodexAppServerTransport} from '../../../src/codex-app-server-transport.js'
import {
  hostBinaryForTest,
  hostCodexHomeForTest,
  hostWorkspaceForTest,
} from '../../../src/codex-process-owner.js'
import {supportedSchemaBundle} from './supported-schema-bundle.js'

const workspace = process.cwd()
let enteredResolve!: () => void
const entered = new Promise<void>(resolve => { enteredResolve = resolve })
const transport = new OwnedCodexAppServerTransport({
  config: {
    binary: hostBinaryForTest(process.execPath),
    workspace: hostWorkspaceForTest(workspace),
    codexHome: hostCodexHomeForTest(workspace, {ephemeral: true}),
    apiKey: 'fixture-key',
    developerInstructions: null,
    resumeThreadId: null,
    persistent: false,
  },
  processFactory: {spawn: async () => {
    enteredResolve()
    return await new Promise<never>(() => {})
  }},
  credentialSnapshotter: {
    prepare: async () => ({} as never),
    environment: () => ({
      PATH: '/safe-path', HOME: '/safe-home', CODEX_HOME: workspace,
      CODEX_API_KEY: 'fixture-key',
      CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1',
    }),
    removeEphemeralHome: async () => {},
  },
  preflightRunner: {run: async () => ({
    version: '0.145.0',
    root_matches: true,
    mount: 'workspace_only',
    subprocess: 'contained',
    network: 'blocked',
    credential: {present: true, identity: 'api_key', policy: 'process_only'},
    limits: {cpu: 'finite', as: 'finite', nofile: 'finite'},
  })},
  schemaProbe: {generate: async () => supportedSchemaBundle()},
})

const running = transport.run(
  {workOrder: 'prove waiter-local handles are released'},
  {},
  {expiresAtMs: Date.now() + 12_000},
)
await entered
const closeStartedAt = Date.now()
const closing = transport.close()
const runResult = await running
let closeCode = 'completed'
try { await closing } catch (error) {
  closeCode = error instanceof Error ? error.message : 'unknown'
}
process.stdout.write(`${JSON.stringify({
  closeElapsedMs: Date.now() - closeStartedAt,
  runCode: runResult.code,
  closeCode,
})}\n`)
