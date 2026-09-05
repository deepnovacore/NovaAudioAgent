import {randomUUID} from 'node:crypto'
import {loadCapabilityRegistry, CapabilityConfigurationError} from '../dist/src/capability-registry.js'
import {McpSearchTransport} from '../dist/src/executors/search-mcp.js'
import {SearchAdapter} from '../dist/src/executors/search.js'
import {RealClock} from '../dist/src/clock.js'

let transport
try {
  const registry = loadCapabilityRegistry({environment: {...process.env, NOVA_AUDIO_AGENT_SEARCH_PROVIDER: 'mcp'}})
  if (!registry.modules.search.enabled || registry.modules.search.mcp === undefined) throw new CapabilityConfigurationError('search_disabled')
  transport = new McpSearchTransport(registry.modules.search.mcp)
  const result = await new SearchAdapter(transport).dispatch('search', {query: process.argv[2] || 'Model Context Protocol official documentation', k: 3}, {
    clock: new RealClock(), delegate: {delegate_id: randomUUID()}, signal: new AbortController().signal, progress: () => undefined,
  })
  if (result.outcome !== 'ok') throw new CapabilityConfigurationError(String(result.content.error))
  process.stdout.write(`MCP search PASS: ${result.content.results.length} canonical results; trust=${result.trust}; Node=${process.version}; platform=${process.platform}\n`)
} catch (error) {
  process.stderr.write(`MCP search FAIL: ${error instanceof CapabilityConfigurationError ? error.reason : 'mcp_search_failed'}\n`)
  process.exitCode = 1
} finally { await transport?.close() }
