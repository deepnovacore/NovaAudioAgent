import {spawn} from 'node:child_process'
import {resolve} from 'node:path'
import {createInterface} from 'node:readline'

const scenario = process.argv[2]
const allowedScenarios = new Set([
  'happy-chunks',
  'malformed-after-turn',
  'stdout-overflow',
  'stderr-overflow',
  'delayed-turn',
  'duplicate-response',
  'unknown-response',
  'server-request',
  'file-approval',
  'file-approval-decline',
  'file-approval-turn-interrupted',
  'file-approval-process-exit',
  'file-approval-start-mismatch',
  'command-approval',
  'clean-eof',
  'pending-eof',
  'turn-rejection-order',
  'descendant-leader-first',
  'descendant-ignore-term',
])
if (!allowedScenarios.has(scenario)) fail('invalid_scenario')

let pendingTurnId = null
let approvalTurnId = null
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
  if (message.name === 'clean_eof' && scenario === 'clean-eof') endAndExit()
  if (message.name === 'leader_exit') {
    process.disconnect?.()
    process.exit(0)
  }
})

if (scenario === 'descendant-leader-first' || scenario === 'descendant-ignore-term') {
  const readyFile = process.env.NOVA_FAKE_DESCENDANT_READY_FILE
  const childScript = scenario === 'descendant-ignore-term'
    ? 'if(process.env.NOVA_FAKE_DESCENDANT_READY_FILE)require("node:fs").writeFileSync(process.env.NOVA_FAKE_DESCENDANT_READY_FILE,"ready");process.on("SIGTERM",()=>{});process.send?.({type:"ready"});setInterval(()=>{},1000)'
    : 'if(process.env.NOVA_FAKE_DESCENDANT_READY_FILE)require("node:fs").writeFileSync(process.env.NOVA_FAKE_DESCENDANT_READY_FILE,"ready");process.send?.({type:"ready"});setInterval(()=>{},1000)'
  const descendant = spawn(process.execPath, ['-e', childScript], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    shell: false,
    detached: false,
    env: {...process.env, ...(readyFile === undefined ? {} : {NOVA_FAKE_DESCENDANT_READY_FILE: readyFile})},
  })
  descendant.once('message', message => {
    if (plain(message) && message.type === 'ready') barrier('descendant_started')
    else fail('invalid_descendant_ready')
  })
} else {
  const input = createInterface({input: process.stdin, crlfDelay: Infinity})
  input.on('line', line => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      fail('malformed_input')
    }
    if (
      plain(message)
      && message.id === 910
      && plain(message.result)
      && message.result.decision === expectedApprovalDecision()
      && approvalTurnId !== null
    ) {
      const id = approvalTurnId
      approvalTurnId = null
      barrier('approval_response', {decision: message.result.decision})
      if (scenario !== 'file-approval-turn-interrupted') turnCompletion(id)
      return
    }
    if (
      plain(message)
      && message.id === 909
      && plain(message.error)
      && message.error.code === -32601
      && message.error.message === 'Method not implemented'
    ) return
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
      const approvalScenario = isApprovalScenario()
      if (params.approvalPolicy !== (approvalScenario ? 'on-request' : 'never')) fail('invalid_thread')
      if (message.method === 'thread/resume') {
        if (typeof params.threadId !== 'string') fail('invalid_resume')
        threadId = params.threadId
      }
      const persistent = params.ephemeral === false || message.method === 'thread/resume'
      const response = {id: message.id, result: threadResponse(
        process.cwd(), threadId, persistent, approvalScenario ? 'on-request' : 'never',
      )}
      if (scenario === 'duplicate-response') {
        sendMany([response, response])
        return
      }
      if (scenario === 'unknown-response') {
        sendMany([response, {id: 999_999, result: {private: 'unknown'}}])
        return
      }
      if (scenario === 'server-request') {
        sendMany([response, {
          id: 909, method: 'account/private', params: {message: 'remote-private'},
        }])
        return
      }
      send(response)
      return
    }
    if (message.method === 'turn/start') {
      if (params.threadId !== threadId || !Array.isArray(params.input)) fail('invalid_turn')
      send({method: 'turn/started', params: {
        threadId, turn: {id: 'fixture-turn-1', items: [], status: 'inProgress'},
      }})
      if (
        isApprovalScenario()
      ) {
        approvalTurnId = message.id
        if (isFileApprovalScenario()) {
          send({method: 'item/started', params: {
            threadId,
            turnId: 'fixture-turn-1',
            startedAtMs: 1000,
            item: {
              id: 'fixture-file-item',
              type: 'fileChange',
              status: 'inProgress',
              changes: [{
                path: resolve(process.cwd(), 'fixture-change.txt'),
                diff: '@@ -0,0 +1 @@\n+fixture\n',
                kind: {type: 'add'},
              }],
            },
          }})
          send({
            id: 910,
            method: 'item/fileChange/requestApproval',
            params: {
              itemId: 'fixture-file-item',
              startedAtMs: scenario === 'file-approval-start-mismatch' ? 1001 : 1000,
              threadId,
              turnId: 'fixture-turn-1',
              grantRoot: null,
              reason: null,
            },
          })
        } else {
          send({
            id: 910,
            method: 'item/commandExecution/requestApproval',
            params: {
              approvalId: null,
              command: 'node --version',
              commandActions: null,
              cwd: process.cwd(),
              environmentId: null,
              itemId: 'fixture-command-item',
              networkApprovalContext: null,
              proposedExecpolicyAmendment: null,
              proposedNetworkPolicyAmendments: null,
              reason: null,
              startedAtMs: 1001,
              threadId,
              turnId: 'fixture-turn-1',
            },
          })
        }
        barrier('approval_request')
        if (scenario === 'file-approval-turn-interrupted') {
          send({id: message.id, result: {
            turn: {id: 'fixture-turn-1', items: [], status: 'inProgress'},
          }})
          send({method: 'turn/completed', params: {
            threadId,
            turn: {
              id: 'fixture-turn-1', status: 'interrupted', itemsView: 'notLoaded', items: [],
            },
          }})
        } else if (scenario === 'file-approval-process-exit') endAndExit()
        return
      }
      if (scenario === 'clean-eof') {
        barrier('turn_start')
        return
      }
      if (scenario === 'pending-eof') {
        endAndExit()
        return
      }
      if (scenario === 'turn-rejection-order') {
        send({id: message.id, error: {code: -32000, message: 'remote-private-rejection'}})
        return
      }
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

function sendMany(values) {
  process.stdout.write(Buffer.from(
    values.map(value => `${JSON.stringify(value)}\n`).join(''),
    'utf8',
  ))
}

function barrier(name, detail = {}) {
  if (typeof process.send !== 'function') fail('missing_ipc')
  process.send({type: 'barrier', name, ...detail})
}

function isApprovalScenario() {
  return isFileApprovalScenario() || scenario === 'command-approval'
}

function isFileApprovalScenario() {
  return scenario === 'file-approval'
    || scenario === 'file-approval-decline'
    || scenario === 'file-approval-turn-interrupted'
    || scenario === 'file-approval-process-exit'
    || scenario === 'file-approval-start-mismatch'
}

function expectedApprovalDecision() {
  return scenario === 'file-approval-decline'
    || scenario === 'file-approval-turn-interrupted'
    || scenario === 'file-approval-start-mismatch'
    ? 'decline'
    : 'accept'
}

function endAndExit() {
  process.stdout.end(() => {
    process.disconnect?.()
    process.exit(0)
  })
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

function threadResponse(workspace, id, persistent, approvalPolicy = 'never') {
  return {
    approvalPolicy, cwd: workspace, sandbox: {},
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
