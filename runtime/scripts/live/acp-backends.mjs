import {mkdtemp, readFile, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {randomUUID} from 'node:crypto'
import {AcpTransport} from '../../dist/src/executors/acp/transport.js'
import {ACP_BACKENDS} from '../../dist/src/executors/acp/backends.js'
import {Server} from '@modelcontextprotocol/sdk/server/index.js'
import {ListToolsRequestSchema, CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js'
import {startLoopbackMcpServer} from '../../dist/src/mcp/http-server.js'
import {prepareAcpMcp} from '../../dist/src/executors/acp/mcp.js'
import {parseCapabilityRegistry} from '../../dist/src/config/capability-registry.js'

// Explicit opt-in live provider requests (OpenCode, CodeBuddy, Pi, DeepSeek); only synthetic
// instructions and this temporary cwd. Codex is verified through its app-server live checks.
const backendId = process.argv[2]
const backend = ACP_BACKENDS.find(item => item.id === backendId)
if (!backend) throw new Error('Usage: node runtime/scripts/live/acp-backends.mjs BACKEND [installed-bin-directory]')
const cwd = await mkdtemp(join(tmpdir(), `nova-live-${backendId}-`))
const nonce = randomUUID()
const marker = join(cwd, 'acceptance.txt')
const binDirectory = process.argv[3] && resolve(process.argv[3])
const installedVersion = binDirectory
  ? JSON.parse(await readFile(join(binDirectory, '..', backend.packageName, 'package.json'), 'utf8')).version : null
const evidence = {backend: backendId, cwd, baselineVersion: backend.packageVersion, installedVersion, steps: [], permissions: 0, mcpCalls: 0}
let upstream, mcp
if (process.env.NOVA_ACP_LIVE_MCP === '1') {
  upstream = await startLoopbackMcpServer(() => {
    const server = new Server({name: 'nova-acceptance', version: '1'}, {capabilities: {tools: {}}})
    server.setRequestHandler(ListToolsRequestSchema, () => ({tools: [{name: 'acceptance_token',
      description: 'Return the synthetic acceptance token.', inputSchema: {type: 'object', properties: {}, additionalProperties: false}}]}))
    server.setRequestHandler(CallToolRequestSchema, () => {
      evidence.mcpCalls++
      return {content: [{type: 'text', text: nonce}]}
    })
    return server
  })
  const registry = parseCapabilityRegistry({version: 1, mcpServers: {acceptance: {
    transport: 'streamable-http', url: upstream.url, tools: {acceptance_token: {enabled: true}},
    exposeTo: {codex: false, backends: {[backendId]: true}},
  }}})
  try {
    mcp = await prepareAcpMcp(backendId, registry, {acceptance: {...registry.mcpServers.acceptance,
      headers: {authorization: `Bearer ${upstream.token}`}}})
  } catch (error) { await upstream.close(); throw error }
}
const options = {backendId, cwd, permissionMode: backendId === 'pi' ? 'full' : 'ask',
  ...(mcp ? {mcpServers: mcp.servers} : {}),
  env: {...process.env, ...(binDirectory ? {PATH: `${binDirectory}:${process.env.PATH ?? ''}`} : {})},
  ...(binDirectory ? {binaryPath: join(binDirectory, backend.command)} : {}),
  approvalController: {
    offer: async offer => {
      evidence.permissions++
      return {decision: offer.allowed_decisions.includes('accept') ? 'accept' : 'decline'}
    },
    consume: decision => decision.decision,
    invalidate: () => false,
  },
}
const deadline = () => ({expiresAtMs: Date.now() + 120_000})
async function step(name, run) {
  try { evidence.steps.push({name, ...await run()}) }
  catch (error) { evidence.steps.push({name, ok: false, code: error?.code ?? 'exception'}) }
  await writeFile(join(cwd, 'evidence.json'), JSON.stringify(evidence, null, 2), {mode: 0o600})
  console.log(JSON.stringify(evidence.steps.at(-1)))
}
let sessionId
try {
await step('new-and-prompt', async () => {
  const transport = new AcpTransport(options)
  try {
    const preflight = await transport.preflight(deadline())
    const tokenInstruction = mcp ? 'Call the acceptance_token MCP tool and use the exact token it returns' : `Use the exact token ${nonce}`
    const outcome = await transport.run({workOrder: `This is an isolated acceptance test. ${tokenInstruction}. Create acceptance.txt in the current directory containing exactly that token. Do not access other project directories. Then finish.`},
      {onThreadReady: id => {sessionId = id}}, deadline(), deadline())
    const markerMatches = await readFile(marker, 'utf8').then(text => text.trim() === nonce, () => false)
    return {ok: outcome.classification === 'completed' && markerMatches && (!mcp || evidence.mcpCalls > 0), preflight, code: outcome.code,
      process: outcome.process, markerMatches, sessionCreated: Boolean(sessionId)}
  } finally { await transport.close() }
})
if (sessionId && evidence.steps[0]?.ok) {
  await step('resume', async () => {
    const transport = new AcpTransport({...options, resumeSessionId: sessionId})
    let bound
    try {
      const outcome = await transport.run({workOrder: 'Continue the earlier acceptance task. Append a new line containing exactly resumed to acceptance.txt, preserving its existing contents. Then finish.'},
        {onThreadReady: id => {bound = id}}, deadline(), deadline())
      const markerMatches = await readFile(marker, 'utf8').then(text => text.trim() === `${nonce}\nresumed`, () => false)
      return {ok: outcome.classification === 'completed' && bound === sessionId && markerMatches,
        code: outcome.code, sameSession: bound === sessionId, markerMatches, process: outcome.process}
    } finally { await transport.close() }
  })
  await step('cancel', async () => {
    const transport = new AcpTransport({...options, resumeSessionId: sessionId})
    const abort = new AbortController()
    try {
      const outcome = await transport.run({workOrder: 'Wait for further instructions; do not change any files.'},
        {onTurnStartWritten: () => abort.abort()}, {...deadline(), signal: abort.signal}, null)
      return {ok: outcome.turnStartWritten && outcome.process !== undefined && outcome.classification !== 'completed',
        code: outcome.code, process: outcome.process}
    } finally { await transport.close('cancel') }
  })
}
console.log(JSON.stringify({evidence: join(cwd, 'evidence.json'), ok: evidence.steps.every(step => step.ok)}))
process.exitCode = evidence.steps.every(step => step.ok) ? 0 : 1
} finally { await mcp?.close(); await upstream?.close() }
