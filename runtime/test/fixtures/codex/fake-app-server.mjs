import {spawn} from 'node:child_process'
import {createInterface} from 'node:readline'

const scenario = process.argv[2]
const allowedScenarios = new Set([
  'happy-chunks',
  'malformed-after-turn',
  'stdout-overflow',
  'stderr-overflow',
  'delayed-turn',
  'descendant-leader-first',
  'descendant-ignore-term',
])
if (!allowedScenarios.has(scenario)) fail('invalid_scenario')

let pendingTurnId = null
let threadId = 'fixture-thread-1'
const releases = new Set()

process.on('message', message => {
  if (!plain(message) || message.type !== 'release' || typeof message.name !== 'string') {
    fail('invalid_control')
  }
  releases.add(message.name)
  if (message.name === 'turn_start' && pendingTurnId !== null) {
    const id = pendingTurnId
    pendingTurnId = null
    turnCompletion(id)
  }
  if (message.name === 'leader_exit') {
    process.disconnect?.()
    process.exit(0)
  }
})

if (scenario === 'descendant-leader-first' || scenario === 'descendant-ignore-term') {
  const childScript = scenario === 'descendant-ignore-term'
    ? 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'
    : 'setInterval(()=>{},1000)'
  spawn(process.execPath, ['-e', childScript], {
    stdio: 'ignore',
    shell: false,
    detached: false,
  })
  barrier('descendant_started')
} else {
  const input = createInterface({input: process.stdin, crlfDelay: Infinity})
  input.on('line', line => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      fail('malformed_input')
    }
    if (!plain(message) || typeof message.method !== 'string') fail('invalid_shape')
    const params = plain(message.params) ? message.params : {}
    if (message.method === 'initialized') return
    if (!Number.isSafeInteger(message.id) || message.id <= 0) fail('invalid_id')
    if (message.method === 'initialize') {
      if (!plain(params.clientInfo)) fail('invalid_initialize')
      send({id: message.id, result: {serverInfo: {name: 'fake', version: '1'}}})
      return
    }
    if (message.method === 'config/read') {
      if (params.includeLayers !== true || typeof params.cwd !== 'string') fail('invalid_config')
      send({id: message.id, result: effectiveConfig(process.cwd())})
      return
    }
    if (message.method === 'thread/start' || message.method === 'thread/resume') {
      if (params.approvalPolicy !== 'never') fail('invalid_thread')
      if (message.method === 'thread/resume') {
        if (typeof params.threadId !== 'string') fail('invalid_resume')
        threadId = params.threadId
      }
      const persistent = params.ephemeral === false || message.method === 'thread/resume'
      send({id: message.id, result: threadResponse(process.cwd(), threadId, persistent)})
      return
    }
    if (message.method === 'turn/start') {
      if (params.threadId !== threadId || !Array.isArray(params.input)) fail('invalid_turn')
      send({method: 'turn/started', params: {
        threadId, turn: {id: 'fixture-turn-1', items: [], status: 'inProgress'},
      }})
      if (scenario === 'malformed-after-turn') {
        process.stdout.write(Buffer.from([0xff, 0x0a]))
        return
      }
      if (scenario === 'stdout-overflow') {
        process.stdout.write(Buffer.alloc(2 * 1024 * 1024 + 1, 0x78))
        return
      }
      if (scenario === 'stderr-overflow') {
        process.stderr.write(Buffer.alloc(64 * 1024 + 1, 0x73))
        return
      }
      if (scenario === 'delayed-turn') {
        pendingTurnId = message.id
        barrier('turn_start')
        return
      }
      turnCompletion(message.id)
      return
    }
    if (message.method === 'turn/steer') {
      if (params.threadId !== threadId || params.expectedTurnId !== 'fixture-turn-1') {
        send({id: message.id, error: {code: -32602, message: 'invalid'}})
      } else {
        send({id: message.id, result: {turnId: 'fixture-turn-1'}})
      }
      return
    }
    if (message.method === 'turn/interrupt') {
      send({id: message.id, result: {}})
      return
    }
    fail('unknown_method')
  })
  input.on('close', () => {
    process.disconnect?.()
    process.exit(0)
  })
}

function turnCompletion(id) {
  send({id, result: {turn: {id: 'fixture-turn-1', items: [], status: 'inProgress'}}})
  send({method: 'item/completed', params: {
    threadId, turnId: 'fixture-turn-1', item: {type: 'agentMessage', text: 'fixture result'},
  }})
  send({method: 'turn/completed', params: {
    threadId,
    turn: {id: 'fixture-turn-1', status: 'completed', itemsView: 'notLoaded', items: []},
  }})
}

function send(value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
  if (scenario !== 'happy-chunks') {
    process.stdout.write(bytes)
    return
  }
  let offset = 0
  for (const size of [1, 2, 5, 3, 11]) {
    if (offset >= bytes.length) break
    process.stdout.write(bytes.subarray(offset, Math.min(bytes.length, offset + size)))
    offset += size
  }
  if (offset < bytes.length) process.stdout.write(bytes.subarray(offset))
}

function barrier(name) {
  if (typeof process.send !== 'function') fail('missing_ipc')
  process.send({type: 'barrier', name})
}

function fail(code) {
  if (typeof process.send === 'function') process.send({type: 'failure', code})
  process.exit(91)
}

function effectiveConfig(workspace) {
  return {
    config: {
      default_permissions: 'nova_audio_agent', web_search: 'disabled', cwd: workspace,
      permissions: {nova_audio_agent: {
        filesystem: {':root': 'read', ':workspace_roots': {
          '.': 'write', '.git': 'read', '.agents': 'read', '.codex': 'read',
        }},
        network: {enabled: false},
      }},
      shell_environment_policy: {inherit: 'core', include_only: ['PATH', 'LANG', 'LC_ALL', 'TERM']},
      features: {
        hooks: false, apps: false, multi_agent: false, plugins: false,
        remote_plugin: false, plugin_sharing: false, tool_suggest: false, remote_control: false,
      },
      mcp_servers: {}, model_instructions_file: null,
    },
    origins: {},
  }
}

function threadResponse(workspace, id, persistent) {
  return {
    approvalPolicy: 'never', cwd: workspace, sandbox: {},
    activePermissionProfile: {id: 'nova_audio_agent'},
    ...(persistent ? {runtimeWorkspaceRoots: [workspace]} : {}),
    thread: {
      id, cwd: workspace, ephemeral: !persistent,
      path: persistent ? `${workspace}/.fixture-thread` : null,
    },
  }
}

function plain(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}
