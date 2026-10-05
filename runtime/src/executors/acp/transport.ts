import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {SensitiveContentPolicy, SensitivePathPolicy, redactUrlQueryCredentials} from '../../memory/sensitivity.js'
import {Readable, Writable} from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import type {ApprovalPort} from '../../core/approval.js'
import type {ApprovalDecision} from '../../core/approval-port.js'
import type {ExecutorDiagnostic} from '../../core/executor-diagnostic.js'
import type {AcpBackendId, CodingBackendId} from '../../config/coding-backends.js'
import type {CapabilityRegistry, McpServerConfig} from '../../config/capability-registry.js'
import {parseCodingProfiles, runtimeCodingProfiles, type RuntimeCodingProfile} from '../../config/coding-profiles.js'
import type {CodingBackendRouting} from '../codex/factory.js'
import {hostWorkspacePath, type HostWorkspace} from '../../projects/host-paths.js'
import {validateThreadId} from '../../projects/project-state.js'
import {normalizeNfcPinned} from '../../text/unicode-normalize.js'
import {hasOtherCategory} from '../../text/unicode-tables.js'
import {isPythonSpace} from '../../text/python-text.js'
import {redactApprovalDetail} from '../codex/approval-protocol.js'
import {takeUnconfirmedCodexProcessOwner, type CodexProcessOwnerFactory, type OwnedCodexProcess} from '../codex/process-owner.js'
import {
  CodexTransportError,
  type CodexAppServerTransport,
  type CodexTransportCode,
  type CodingPreflightReport,
  type ProjectConnectionBinding,
  type RunInput,
  type SteerInput,
  type SteerTransportResult,
  type TransportDeadline,
  type TransportObserver,
  type TransportOutcome,
} from '../codex/app-server-transport.js'
import type {AcpPreflightReport} from './preflight.js'
import {acpBackend, resolveAcpLaunch, type AcpLaunchInput} from './backends.js'
import {prepareAcpMcp, type PreparedAcpMcp} from './mcp.js'

/** Final-text accumulation bound; evidence admits at most this many original characters. */
const MAX_TEXT_UNITS = 65_536
const MAX_FRAME_BYTES = 8 * 1024 * 1024
const MAX_STDERR_BYTES = 256 * 1024
const observationSensitivity = new SensitiveContentPolicy()
const observationPathSensitivity = new SensitivePathPolicy()
interface ToolObservation {
  title: string; input: string; output: string; truncated: boolean; completed: boolean
  kind?: string; command?: string; exitCode?: number; terminalId?: string; outputSeen?: boolean; background?: boolean
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export interface AcpTransportOptions extends Omit<AcpLaunchInput, 'env'> {
  readonly env?: NodeJS.ProcessEnv
  /** Seconds between activity reports, matching CODEX_WORKING_INTERVAL (5–600). */
  readonly workingInterval?: number
  readonly resumeSessionId?: string | null
  readonly mcpServers?: readonly acp.McpServer[]
  readonly approvalController?: ApprovalPort | null
  /** Windows requires the packaged job-object guardian; injectable for ownership contract checks. */
  readonly processFactory?: CodexProcessOwnerFactory
}

/**
 * One owned ACP agent process behind the same transport interface as the Codex app-server.
 * A completed prompt does not imply process exit: completion evidence also needs observed teardown.
 * Steering is reported `unsupported`; it is never simulated by cancelling and resubmitting.
 */
export class AcpTransport implements CodexAppServerTransport {
  readonly #options: AcpTransportOptions
  #cwd: string
  #resume: string | null
  #approval: ApprovalPort | null
  #child: ChildProcessWithoutNullStreams | null = null
  #owner: OwnedCodexProcess | null = null
  #pendingSpawn: Promise<void> | null = null
  #ownerStop: 'none' | 'terminate' | 'kill' = 'none'
  #connection: acp.ClientConnection | null = null
  #initialized: acp.InitializeResponse | null = null
  #connecting: Promise<AcpPreflightReport> | null = null
  #closing: Promise<void> | null = null
  #session: string | null = null
  #pendingSessionUpdates: acp.SessionNotification[] | null = null
  #pendingSessionBytes = 0
  #observer: TransportObserver | null = null
  #running = false
  #written = false
  #text = ''
  #activity = 0
  #reportedActivity = 0
  #lastProgressAt = -Infinity
  readonly #workingInterval: number
  #turnId = ''
  readonly #tools = new Map<string, ToolObservation>()
  #started = 0
  readonly #lifetime = new AbortController()
  #failure: CodexTransportError | null = null
  #process: {exit_code: number | null; stop: 'none' | 'terminate' | 'kill'} | undefined

  constructor(options: AcpTransportOptions) {
    const interval = options.workingInterval ?? 30
    if (!Number.isFinite(interval) || interval < 5 || interval > 600) throw new CodexTransportError('workspace_invalid')
    this.#workingInterval = interval
    this.#options = options
    this.#cwd = options.cwd
    this.#resume = options.resumeSessionId ?? null
    this.#approval = options.approvalController ?? null
  }

  bindProject(binding: ProjectConnectionBinding): void {
    if (this.#running || this.#session !== null) throw new CodexTransportError('busy')
    const cwd = hostWorkspacePath(binding.workspace)
    if ((this.#child || this.#owner) && cwd !== this.#cwd) throw new CodexTransportError('workspace_root_mismatch')
    this.#cwd = cwd
    this.#resume = binding.resumeThreadId
    this.#approval = binding.approvalController
  }

  prewarmConnection(deadline: TransportDeadline): Promise<AcpPreflightReport> { return this.preflight(deadline) }
  prewarm(deadline: TransportDeadline): Promise<AcpPreflightReport> { return this.preflight(deadline) }
  async preflight(deadline: TransportDeadline): Promise<AcpPreflightReport> {
    this.#assertLive(deadline)
    if (this.#failure || this.#lifetime.signal.aborted) throw this.#failure ?? new CodexTransportError('transport_lost')
    this.#connecting ??= this.#connect(deadline)
    return this.#bounded(this.#connecting, deadline)
  }

  async #connect(deadline: TransportDeadline): Promise<AcpPreflightReport> {
    try {
      const backend = acpBackend(this.#options.backendId)
      const servers = this.#options.mcpServers ?? []
      if ((!backend.mcpInjection && servers.length > 0) || (!backend.perToolApproval && this.#options.permissionMode === 'ask')) {
        throw new CodexTransportError('unsupported_protocol')
      }
      const launch = resolveAcpLaunch({...this.#options, cwd: this.#cwd, env: this.#options.env ?? process.env})
      if (process.platform === 'win32' && !this.#options.processFactory) throw new CodexTransportError('unsupported_protocol')
      if (this.#options.processFactory) {
        const spawning = this.#options.processFactory.spawn({binary: launch.command, argv: launch.args,
          cwd: this.#cwd, environment: Object.fromEntries(Object.entries(launch.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
          shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        }, {expiresAtMs: deadline.expiresAtMs, signal: AbortSignal.any([this.#lifetime.signal, ...(deadline.signal ? [deadline.signal] : [])])})
          .then(owner => { this.#owner = owner }, (error: unknown) => {
            this.#owner ??= takeUnconfirmedCodexProcessOwner(error)
            throw error
          })
        // Closing must join ownership transfer, including owners attached to failed spawns.
        this.#pendingSpawn = spawning.catch(() => undefined)
        await spawning
        this.#assertLive(deadline)
        const owner = this.#owner!
        void owner.exit.then(() => this.#fail('transport_lost'), () => this.#fail('transport_lost'))
      } else {
        this.#child = spawn(launch.command, [...launch.args], {cwd: this.#cwd, env: launch.env, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe']})
        this.#child.on('error', () => this.#fail('spawn_failed'))
        this.#child.on('exit', () => this.#fail('transport_lost'))
      }
      const streams = this.#owner ?? this.#child!
      streams.stdin.on('error', () => this.#fail('transport_lost'))
      streams.stdout.on('error', () => this.#fail('transport_lost'))
      streams.stderr.on('error', () => this.#fail('transport_lost'))
      let stderrBytes = 0
      streams.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > MAX_STDERR_BYTES) this.#fail('stderr_too_large') })
      // Bound the pending NDJSON frame, not lifetime traffic. Streaming agents
      // repeatedly send growing tool arguments during ordinary project work.
      let frameBytes = 0
      const input = (Readable.toWeb(streams.stdout) as ReadableStream<Uint8Array>).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, controller) => {
          for (const byte of chunk) {
            if (++frameBytes > MAX_FRAME_BYTES) { this.#fail('transport_lost'); controller.error(new CodexTransportError('transport_lost')); return }
            if (byte === 10) frameBytes = 0
          }
          controller.enqueue(chunk)
        },
      }))
      const stream = acp.ndJsonStream(Writable.toWeb(streams.stdin), input)
      const writer = stream.writable.getWriter()
      this.#connection = acp.client()
        .onRequest('session/request_permission', ({params, signal}) => this.#permission(params, signal))
        .onNotification('session/update', ({params}) => { this.#update(params) })
        .connect({readable: stream.readable, writable: new WritableStream({
          write: async message => {
            if ('method' in message && message.method === 'session/prompt') {
              // A failed write may have reached the child: never classify it as safely refused.
              this.#written = true
              try { this.#observer?.onTurnStartWritten?.() } catch { /* advisory */ }
            }
            await writer.write(message)
          },
          close: () => writer.close(), abort: reason => writer.abort(reason),
        })})
      this.#connection.signal.addEventListener('abort', () => this.#fail('transport_lost'), {once: true})
      const initialized = await this.#bounded(this.#connection.agent.request<acp.InitializeResponse, acp.InitializeRequest>('initialize', {
        protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: {name: 'nova', version: '1'},
      }), deadline)
      if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) throw new CodexTransportError('unsupported_version')
      for (const server of servers) {
        if ('type' in server && (server.type === 'acp' || !initialized.agentCapabilities?.mcpCapabilities?.[server.type])) {
          throw new CodexTransportError('unsupported_protocol')
        }
      }
      this.#initialized = initialized
      const reported = initialized.agentInfo?.version === undefined ? undefined : this.#safeText(initialized.agentInfo.version)
      const version = typeof reported === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,79}$/u.test(reported)
        ? {agent_version: reported, tested_version: backend.packageVersion} : {}
      return {protocol: 'acp', version: String(initialized.protocolVersion), backend: backend.id, connected: true, ...version}
    } catch (error) {
      this.#owner ??= takeUnconfirmedCodexProcessOwner(error)
      const safe = error instanceof CodexTransportError ? error : new CodexTransportError(acpErrorCode(error, 'preflight_failed'),
        error instanceof acp.RequestError ? acpDiagnostic('initialize', error) : undefined)
      // Aborting the lifetime rejects awaiting callers with #failure; keep the diagnostic on it.
      this.#failure ??= safe
      this.#fail(safe.code)
      await this.close('failure')
      throw safe
    }
  }

  async run(input: RunInput, observer: TransportObserver, deadline: TransportDeadline, completionDeadline?: TransportDeadline | null): Promise<TransportOutcome> {
    if (this.#running) return {classification: 'refused', code: 'busy', turnStartWritten: false, completion: null}
    this.#running = true
    this.#observer = observer
    this.#started = Date.now()
    let outcome: TransportOutcome
    let cleaned = false
    let method = 'initialize'
    try {
      await this.preflight(deadline)
      this.#assertLive(deadline)
      const connection = this.#connection!
      const params = {cwd: this.#cwd, mcpServers: [...(this.#options.mcpServers ?? [])]}
      let sessionUpdates: acp.SessionNotification[] = []
      if (this.#resume !== null) {
        try { validateThreadId(this.#resume) } catch { throw new CodexTransportError('resume_unavailable') }
        const capabilities = this.#initialized?.agentCapabilities
        this.#session = this.#resume
        method = capabilities?.loadSession ? 'session/load' : 'session/resume'
        try {
          if (capabilities?.loadSession) await this.#bounded(connection.agent.request<acp.LoadSessionResponse, acp.LoadSessionRequest>('session/load', {...params, sessionId: this.#session}), deadline)
          else if (capabilities?.sessionCapabilities?.resume) await this.#bounded(connection.agent.request<acp.ResumeSessionResponse, acp.ResumeSessionRequest>('session/resume', {...params, sessionId: this.#session}), deadline)
          else throw new CodexTransportError('resume_unavailable')
        } catch (error) {
          // ACP RESOURCE_NOT_FOUND. The adapter keeps the session retryable: it may reappear after
          // a backend login, upgrade or configuration fix.
          if (error instanceof acp.RequestError && error.code === -32002) throw new CodexTransportError('resume_unavailable')
          throw error
        }
      } else {
        this.#pendingSessionUpdates = []
        method = 'session/new'
        try {
          const created = await this.#bounded<acp.NewSessionResponse>(connection.agent.request<acp.NewSessionResponse, acp.NewSessionRequest>('session/new', params), deadline)
          // Validate with the store's rule before any prompt is written, so a session the store would refuse never runs.
          try { validateThreadId(created.sessionId) } catch { throw new CodexTransportError('server_rejected') }
          if (this.#pendingSessionUpdates.some(update => update.sessionId !== created.sessionId)) throw new CodexTransportError('unexpected_server_request')
          this.#session = created.sessionId
          sessionUpdates = this.#pendingSessionUpdates
        } finally { this.#pendingSessionUpdates = null; this.#pendingSessionBytes = 0 }
      }
      const sessionId = this.#session
      observer.onThreadReady?.(sessionId)
      for (const update of sessionUpdates) this.#update(update)
      observer.onTurnBound?.()
      // History streamed by load is not the answer to the new prompt.
      this.#text = ''
      this.#activity = 0
      this.#turnId = randomUUID()
      this.#tools.clear()
      const promptDeadline = completionDeadline === undefined ? deadline : completionDeadline
      if (promptDeadline) this.#assertLive(promptDeadline)
      if (deadline.signal?.aborted) throw new CodexTransportError('adapter_timeout')
      // A superseded request throws here, before anything is written.
      deadline.beforeWrite?.()
      method = 'session/prompt'
      const result = await this.#bounded<acp.PromptResponse>(connection.agent.request<acp.PromptResponse, acp.PromptRequest>('session/prompt', {
        sessionId, prompt: [{type: 'text', text: input.workOrder}],
      }), promptDeadline, deadline.signal)
      if (this.#failure) throw this.#failure
      this.#emitProgress(true)
      if (result.stopReason !== 'end_turn') throw new CodexTransportError('turn_failed', {method, server_code: null, message: `stop_reason=${String(result.stopReason).replace(/[^a-z_]/gu, '').slice(0, 32)}`})
      // Match the existing public evidence format: bounded, NFC, printable text.
      const text = [...normalizeNfcPinned(this.#safeText(this.#text))]
        .map(character => isPythonSpace(character) || hasOtherCategory(character) ? ' ' : character)
        .join('')
      if (!text) throw new CodexTransportError('turn_failed', {method, server_code: null, message: 'empty_final_text'})
      outcome = {classification: 'completed', code: 'completed', turnStartWritten: this.#written,
        completion: {status: 'completed', final_text: text || null, internal_activity: this.#activity}}
    } catch (error) {
      const code = acpErrorCode(error, 'server_rejected')
      const diagnostic = error instanceof acp.RequestError ? acpDiagnostic(method, error)
        : error instanceof CodexTransportError ? error.diagnostic : undefined
      outcome = {classification: this.#written ? 'uncertain' : 'refused', code, turnStartWritten: this.#written, completion: null,
        ...(diagnostic === undefined ? {} : {diagnostic})}
    } finally {
      try { await this.close('shutdown'); cleaned = true }
      catch { outcome = {classification: 'uncertain', code: 'transport_lost', turnStartWritten: this.#written, completion: null} }
      finally { this.#observer = null; this.#running = false }
    }
    return {...outcome, ...(cleaned && this.#process ? {process: this.#process} : {})}
  }

  steer(input: SteerInput, deadline: TransportDeadline): Promise<SteerTransportResult> {
    void input
    void deadline
    // ACP defines no steer operation; enable only a separately verified negotiated extension.
    return Promise.resolve({code: 'unsupported', written: false})
  }

  #update(params: acp.SessionNotification): void {
    if (this.#lifetime.signal.aborted) return
    if (this.#pendingSessionUpdates !== null) {
      this.#pendingSessionBytes += Buffer.byteLength(JSON.stringify(params))
      if (this.#pendingSessionUpdates.length >= 128 || this.#pendingSessionBytes > 128 * 1024) {
        this.#fail('unexpected_server_request')
      } else this.#pendingSessionUpdates.push(params)
      return
    }
    if (params.sessionId !== this.#session) { this.#fail('unexpected_server_request'); return }
    const update = params.update
    this.#activity++
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      this.#text = (this.#text + this.#safeText(update.content.text)).slice(0, MAX_TEXT_UNITS)
    }
    // Loaded history and reasoning are not observations of the current work. ACP tool
    // notifications use the same public activity channel as app-server tool results.
    if (this.#written && this.#turnId && (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')) {
      const id = update.toolCallId
      if (id.length <= 512 && (this.#tools.has(id) || this.#tools.size < 256)) {
        const started = !this.#tools.has(id)
        const tool: ToolObservation = this.#tools.get(id) ?? {title: '', input: '', output: '', truncated: false, completed: false}
        const field = (value: unknown): string => {
          const raw = this.#safeText(redactUrlQueryCredentials(typeof value === 'string' ? value : JSON.stringify(value)))
          const scrubbed = observationSensitivity.scrub('executor_observation', raw)
          const content = scrubbed.kind === 'clean' ? raw : scrubbed.kind === 'redacted' ? scrubbed.value : '[redacted]'
          const paths = observationPathSensitivity.scrubText('executor_observation', content)
          const safe = paths.kind === 'clean' ? content : paths.kind === 'redacted' ? paths.value : '[redacted]'
          tool.truncated ||= safe.length > 6000
          return safe.slice(0, 6000)
        }
        if (!tool.completed) {
          if (update.title != null) tool.title = field(update.title)
          if (update.kind != null) tool.kind = update.kind
          const input = record(update.rawInput)
          if (typeof input?.command === 'string') tool.command = field(input.command)
          if (input?.run_in_background === true) tool.background = true
          // OpenCode reports the real process exit code in rawOutput.metadata.
          const rawOutput = record(update.rawOutput), metadata = record(rawOutput?.metadata)
          if (this.#options.backendId === 'opencode' && tool.kind === 'execute' && Number.isInteger(metadata?.exit)) {
            tool.exitCode = metadata!.exit as number
            tool.truncated ||= metadata?.truncated === true
          }
          // pi-acp streams terminal deltas in its ACP extension, not rawOutput.
          // Bind both output and exit to the terminal announced for this tool.
          if (this.#options.backendId === 'pi' && tool.kind === 'execute') {
            for (const part of update.content ?? []) if (part.type === 'terminal' && part.terminalId === id) {
              tool.terminalId = part.terminalId; tool.command = tool.title
            }
            const meta = record(update._meta), output = record(meta?.terminal_output), exit = record(meta?.terminal_exit)
            if (tool.terminalId && output?.terminal_id === tool.terminalId && typeof output.data === 'string') {
              tool.output = field(tool.output + output.data); tool.outputSeen = true
            }
            if (tool.terminalId && exit?.terminal_id === tool.terminalId && Number.isInteger(exit.exit_code)
              && (exit.signal === undefined || exit.signal === null)) tool.exitCode = exit.exit_code as number
          }
          if (update.rawInput !== undefined) tool.input = field(update.rawInput)
          if (update.rawOutput !== undefined) {
            tool.output = field(this.#options.backendId === 'opencode' && tool.kind === 'execute' && typeof rawOutput?.output === 'string' ? rawOutput.output : update.rawOutput)
            tool.outputSeen = true
          }
          else if (update.content?.some(part => part.type === 'content' && part.content.type === 'text')) {
            tool.output = field(update.content.filter(part => part.type === 'content' && part.content.type === 'text').map(part => part.type === 'content' && part.content.type === 'text' ? part.content.text : '').join('\n'))
            tool.outputSeen = true
          }
          if (update.status === 'completed' && tool.command && tool.outputSeen) {
            if (this.#options.backendId === 'codebuddy' && tool.kind === 'execute' && rawOutput?.type === 'text' && typeof rawOutput.text === 'string') {
              // CodeBuddy's command result wrapper always ends with the process status.
              const result = field(rawOutput.text), exit = /\nExit Code: (-?\d+)\nSignal: \(none\)\s*$/u.exec(result)
              // A result cut at the field bound has lost its real trailer; a forged one at the cut must not count.
              if (result.startsWith(`Command: ${tool.command}\n`) && exit && result.length < 6000) {
                tool.exitCode = Number(exit[1]); tool.output = result
              }
            }
            if (this.#options.backendId === 'deepseek' && tool.title === 'bash' && !tool.background) {
              // dsh-tool-bash 0.1.5-rc.2 renderResult / dsh-shell parseExitStatus:
              // a foreground completed result omits the exit marker only for exit 0.
              // Failure, signal, timeout, sandbox denial and background acknowledgements
              // must never become a successful check merely because ACP says completed.
              const output = tool.output.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/u, '')
              tool.truncated ||= /\[output truncated;|\[some output was dropped/u.test(output)
              // Output cut at our field bound has lost its footer: absence of a marker is then not exit 0.
              const cutHere = tool.output.length >= 6000
              if (!cutHere && !/\[timed out |\[killed by signal:|\[sandbox:/u.test(output)) {
                const exit = /\n\[exit code: (\d+)\]$/u.exec(output)
                // Only the final exact marker counts; a forged earlier 0 with a later failure must not win.
                if (exit) { tool.kind = 'execute'; tool.exitCode = Number(exit[1]); tool.output = output }
                else if (!/\[exit code:|\nExit Code:|\nSignal:/u.test(output)) {
                  tool.kind = 'execute'; tool.exitCode = 0; tool.output = output
                }
              }
            }
          }
          this.#tools.set(id, tool)
          // Text preceding a newly started or finished tool is interim narration.
          // Mid-tool deltas after the final reply must not wipe that reply.
          if (started || update.status === 'completed' || update.status === 'failed') this.#text = ''
          if (update.status === 'completed' || update.status === 'failed') {
            tool.completed = true
            const text = JSON.stringify(tool.kind === 'execute' && tool.command && tool.exitCode !== undefined && tool.outputSeen
              ? {type:'commandExecution', command:tool.command, status:update.status, output:tool.output, exit_code:tool.exitCode}
              : {type:'acpToolCall', title:tool.title, kind:tool.kind, status:update.status, input:tool.input, output:tool.output})
            try { this.#observer?.onActivity?.({thread_id:params.sessionId, turn_id:this.#turnId, item_id:id,
              stage:'completed', kind:'tool', text:text.slice(0,16000), refs:[],
              ...(tool.truncated || text.length > 16000 ? {text_truncated:true} : {})}) } catch { /* display callback is advisory */ }
          }
        }
      }
    }
    if (update.sessionUpdate === 'session_info_update' && update.title !== undefined) {
      this.#observer?.onThreadNamed?.(params.sessionId, update.title === null ? null : this.#safeText(update.title).slice(0, 200))
    }
    this.#emitProgress()
  }

  #emitProgress(flush = false): void {
    // session/load can replay history; it is not activity from this prompt.
    if (!this.#written || this.#lifetime.signal.aborted || this.#activity === this.#reportedActivity) return
    const now = Date.now()
    if (!flush && now - this.#lastProgressAt < this.#workingInterval * 1000) return
    this.#lastProgressAt = now
    this.#reportedActivity = this.#activity
    this.#observer?.onProgress?.({phase: 'working', internal_activity: this.#activity,
      elapsed: (now - this.#started) / 1000, summary: null})
  }

  #safeText(text: string): string {
    let result = redactApprovalDetail(text)
    for (const [key, value] of Object.entries(this.#options.env ?? process.env)) {
      if (/KEY|TOKEN|SECRET|PASSWORD/i.test(key) && value) result = result.replaceAll(value, '[redacted]')
    }
    for (const server of this.#options.mcpServers ?? []) {
      if (!('headers' in server)) continue
      for (const header of server.headers) {
        if (header.value) result = result.replaceAll(header.value, '[redacted]')
        const bearer = /^Bearer\s+(\S+)\s*$/iu.exec(header.value)?.[1]
        if (bearer) result = result.replaceAll(bearer, '[redacted]')
      }
    }
    return result
  }

  async #permission(params: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse> {
    const cancelled: acp.RequestPermissionResponse = {outcome: {outcome: 'cancelled'}}
    // Requests for another session, an ended run or a closed connection never authorize anything.
    if (params.sessionId !== this.#session || !this.#running || this.#lifetime.signal.aborted) return cancelled
    const options = params.options
    let kind = 'allow_once'
    if (this.#options.permissionMode === 'ask') {
      if (!this.#approval) return cancelled
      const allowed: ApprovalDecision[] = []
      if (options.some(option => option.kind === 'allow_once')) allowed.push('accept')
      allowed.push('decline')
      const tool = params.toolCall
      const input = tool.rawInput === undefined ? null : this.#safeText(JSON.stringify(tool.rawInput))
      const locations = tool.locations ? this.#safeText(JSON.stringify(tool.locations)) : null
      // Do not hide an unreviewed tail behind truncation: an oversized request is refused, never shortened.
      if ((input?.length ?? 0) > 2500 || (locations?.length ?? 0) > 1000) {
        const reject = options.find(option => option.kind === 'reject_once')
        return reject ? {outcome: {outcome: 'selected', optionId: reject.optionId}} : cancelled
      }
      const scope = [
        this.#safeText(tool.title ?? 'Agent operation').slice(0, 200),
        ...(tool.kind ? [`Kind: ${tool.kind}`] : []),
        ...(input === null ? [] : [`Input: ${input}`]),
        ...(locations === null ? [] : [`Locations: ${locations}`]),
      ].join('\n')
      const resolution = await this.#approval.offer({kind: 'permissions',
        local_detail: {kind: 'permissions', scope},
        operation_summary: '编码代理请求执行操作', allowed_decisions: allowed,
      }, AbortSignal.any([signal, this.#lifetime.signal]))
      if (!resolution) return cancelled
      const decision = this.#approval.consume(resolution)
      // ACP allow_always may persist beyond this session; it is not acceptForSession authority.
      kind = decision === 'accept' ? 'allow_once' : 'reject_once'
    }
    if (signal.aborted || this.#lifetime.signal.aborted) return cancelled
    const selected = options.find(option => option.kind === kind)
    return selected ? {outcome: {outcome: 'selected', optionId: selected.optionId}} : cancelled
  }

  #fail(code: CodexTransportCode): void {
    this.#failure ??= new CodexTransportError(code)
    this.#lifetime.abort()
    // Also reap a failed prewarmed connection when no run is awaiting it.
    queueMicrotask(() => { void this.close('failure').catch(() => undefined) })
  }

  #assertLive(deadline: TransportDeadline): void {
    if (deadline.signal?.aborted || deadline.expiresAtMs <= Date.now()) throw new CodexTransportError('adapter_timeout')
    if (this.#lifetime.signal.aborted) throw this.#failure ?? new CodexTransportError('transport_lost')
  }

  async #bounded<T>(promise: Promise<T>, deadline: TransportDeadline | null, signal?: AbortSignal): Promise<T> {
    const signals = [this.#lifetime.signal, ...(deadline?.signal ? [deadline.signal] : []), ...(signal ? [signal] : [])]
    const combined = AbortSignal.any(signals)
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort: (() => void) | undefined
    const stopped = new Promise<never>((_, reject) => {
      abort = () => { reject(this.#failure ?? new CodexTransportError('adapter_timeout')) }
      if (combined.aborted) abort()
      else combined.addEventListener('abort', abort, {once: true})
      if (deadline) timer = setTimeout(() => { reject(new CodexTransportError('adapter_timeout')) }, Math.max(0, deadline.expiresAtMs - Date.now()))
    })
    try { return await Promise.race([promise, stopped]) }
    finally { clearTimeout(timer); if (abort) combined.removeEventListener('abort', abort) }
  }

  close(reason: 'shutdown' | 'cancel' | 'failure' = 'shutdown'): Promise<void> {
    this.#closing ??= this.#close(reason).catch(() => {
      this.#closing = null
      throw new CodexTransportError('transport_lost')
    })
    return this.#closing
  }

  async #close(reason: 'shutdown' | 'cancel' | 'failure'): Promise<void> {
    void reason
    this.#lifetime.abort()
    this.#approval?.invalidate('transport_closed')
    if (this.#pendingSpawn) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([this.#pendingSpawn, new Promise<never>((_, reject) => {
          timer = setTimeout(() => { reject(new CodexTransportError('transport_lost')) }, 5000)
        })])
      } finally { clearTimeout(timer) }
    }
    const child = this.#child
    if (this.#session && this.#connection && this.#running) {
      await Promise.race([this.#connection.agent.notify('session/cancel', {sessionId: this.#session}).catch(() => undefined), new Promise(resolve => setTimeout(resolve, 50))])
      if (child) await waitForExit(child, 100)
    }
    this.#connection?.close()
    if (this.#owner) {
      const owner = this.#owner
      await owner.closeStdin()
      if (!await owner.waitTreeGone(100)) {
        this.#ownerStop = 'terminate'
        await owner.terminateTree()
      }
      if (!await owner.waitTreeGone(200)) throw new CodexTransportError('transport_lost')
      const exitCode = await owner.exit
      await owner.dispose()
      this.#process = {exit_code: exitCode, stop: this.#ownerStop}
      this.#owner = null
      return
    }
    if (!child) return
    if (child.pid) {
      const kill = (signal: NodeJS.Signals): void => {
        try { process.kill(-child.pid!, signal) }
        catch (error) {
          // macOS can report EPERM for a dying orphan group. Only the exit/group checks below
          // may establish cleanup success; an actual permission denial keeps ownership alive.
          if (!['ESRCH', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new CodexTransportError('transport_lost')
        }
      }
      kill('SIGTERM')
      await waitForExit(child, 100)
      kill('SIGKILL')
    }
    await waitForExit(child, 200)
    if (child.pid && child.exitCode === null && child.signalCode === null) throw new CodexTransportError('transport_lost')
    if (child.pid) {
      const expires = Date.now() + 750
      while (groupExists(child.pid)) {
        if (Date.now() >= expires) throw new CodexTransportError('transport_lost')
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
    this.#process = {exit_code: child.exitCode, stop: child.signalCode === null ? 'none' : child.signalCode === 'SIGKILL' ? 'kill' : 'terminate'}
    child.stdin.destroy()
    child.stdout.destroy()
    child.stderr.destroy()
    this.#child = null
  }
}

/** Descriptive hint only: agent prose never leaves the transport and never decides a code. */
function acpDiagnostic(method: string, error: acp.RequestError): ExecutorDiagnostic {
  const text = String(error.message)
  const kind = /insufficient.?balance|quota|billing|payment|\b402\b/iu.test(text) ? 'quota_exhausted'
    : /rate.?limit|too many requests|\b429\b/iu.test(text) ? 'rate_limited'
      : /context.{0,20}(?:length|window|too long)|maximum.{0,20}tokens/iu.test(text) ? 'context_overflow'
        : /unauthori[sz]ed|forbidden|auth|api.?key|\b40[13]\b/iu.test(text) ? 'auth'
          : /time.?out|timed out/iu.test(text) ? 'timeout' : 'unclassified'
  return {method, server_code: error.code, message: `class=${kind}`}
}

function acpErrorCode(error: unknown, fallback: 'preflight_failed' | 'server_rejected'): CodexTransportCode {
  if (error instanceof CodexTransportError) return error.code
  // ACP AUTH_REQUIRED, as emitted by RequestError.authRequired(); never infer from error prose.
  return error instanceof acp.RequestError && error.code === -32000 ? 'credential_missing' : fallback
}

function groupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true
    throw new CodexTransportError('transport_lost')
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams, ms: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise(resolve => {
    const finish = (): void => { clearTimeout(timer); child.removeListener('exit', finish); resolve() }
    const timer = setTimeout(finish, ms)
    child.once('exit', finish)
  })
}

/** Joins lazy MCP preparation and process ownership into the existing per-work transport lifetime. */
export class PreparedAcpTransport implements CodexAppServerTransport {
  readonly #abort = new AbortController()
  #prepared: Promise<{transport: CodexAppServerTransport; mcp: PreparedAcpMcp}> | undefined
  constructor(readonly prepare: (signal: AbortSignal) => Promise<{transport: CodexAppServerTransport; mcp: PreparedAcpMcp}>) {}
  async #get(deadline: TransportDeadline): Promise<CodexAppServerTransport> {
    if (this.#abort.signal.aborted) throw new CodexTransportError('transport_lost')
    if (deadline.signal?.aborted || deadline.expiresAtMs <= Date.now()) throw new CodexTransportError('adapter_timeout')
    this.#prepared ??= Promise.resolve().then(() => this.prepare(this.#abort.signal))
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort: (() => void) | undefined
    const stopped = new Promise<never>((_, reject) => {
      abort = () => { this.#abort.abort(); reject(new CodexTransportError('adapter_timeout')) }
      deadline.signal?.addEventListener('abort', abort, {once: true})
      timer = setTimeout(abort, Math.max(0, deadline.expiresAtMs - Date.now()))
    })
    try {
      const prepared = await Promise.race([this.#prepared, stopped])
      if (this.#abort.signal.aborted) throw new CodexTransportError('transport_lost')
      return prepared.transport
    } finally {
      clearTimeout(timer)
      if (abort) deadline.signal?.removeEventListener('abort', abort)
    }
  }
  async preflight(deadline: TransportDeadline): Promise<CodingPreflightReport> { return (await this.#get(deadline)).preflight(deadline) }
  async prewarm(deadline: TransportDeadline): Promise<CodingPreflightReport | null> { return (await this.#get(deadline)).prewarm(deadline) }
  async run(input: RunInput, observer: TransportObserver, deadline: TransportDeadline, completionDeadline?: TransportDeadline | null): Promise<TransportOutcome> {
    let transport: CodexAppServerTransport
    try { transport = await this.#get(deadline) }
    catch (error) {
      // Nothing was spawned or written: MCP preparation failures are pre-effect refusals.
      const code = error instanceof CodexTransportError ? error.code : 'mcp_tools_not_isolated'
      return {classification: 'refused', code, turnStartWritten: false, completion: null}
    }
    return transport.run(input, observer, deadline, completionDeadline)
  }
  async steer(input: SteerInput, deadline: TransportDeadline): Promise<SteerTransportResult> { return (await this.#get(deadline)).steer(input, deadline) }
  async close(reason?: 'shutdown' | 'cancel' | 'failure'): Promise<void> {
    this.#abort.abort()
    const prepared = await this.#prepared?.catch(() => undefined)
    if (prepared) {
      try { await prepared.transport.close(reason) } finally { await prepared.mcp.close() }
    }
  }
}

export interface AcpProjectBinding {
  readonly backendId: AcpBackendId
  readonly profileId: string
  readonly workspace: HostWorkspace
  readonly resumeSessionId: string | null
  readonly approvalController: ApprovalPort | null
}

export interface AcpTransportFactoryOptions {
  readonly profiles: Readonly<Record<string, RuntimeCodingProfile>>
  readonly capabilities: CapabilityRegistry
  readonly knowledgeEntries?: Readonly<Record<string, McpServerConfig>>
  readonly permissionMode: 'ask' | 'full'
  readonly workingInterval?: number
  readonly processFactory?: CodexProcessOwnerFactory
}

/**
 * Build the per-work ACP transport for a session binding. A profile that no longer matches the
 * bound backend (binary or config-source drift) refuses the resume rather than rebinding it.
 */
export function createAcpProjectTransport(options: AcpTransportFactoryOptions, binding: AcpProjectBinding): CodexAppServerTransport {
  const profile = options.profiles[binding.profileId]
  if (profile?.backendId !== binding.backendId) throw new CodexTransportError('resume_unavailable')
  return new PreparedAcpTransport(async signal => {
    const mcp = await prepareAcpMcp(binding.backendId, options.capabilities, options.knowledgeEntries, signal)
    try {
      return {mcp, transport: new AcpTransport({
        backendId: binding.backendId, cwd: hostWorkspacePath(binding.workspace), env: {...profile.environment},
        permissionMode: options.permissionMode,
        ...(options.workingInterval === undefined ? {} : {workingInterval: options.workingInterval}),
        ...(profile.binaryPath ? {binaryPath: profile.binaryPath} : {}),
        ...(options.processFactory === undefined ? {} : {processFactory: options.processFactory}),
        resumeSessionId: binding.resumeSessionId, mcpServers: mcp.servers, approvalController: binding.approvalController,
      })}
    } catch (error) {
      await mcp.close()
      throw error
    }
  })
}

/** Host routing for non-Codex sessions; installation and login are checked only when a task starts. */
export function createAcpBackendRouting(options: {
  readonly initialBackend: CodingBackendId
  readonly environment: NodeJS.ProcessEnv
  readonly capabilities: CapabilityRegistry
  readonly knowledgeEntries?: Readonly<Record<string, McpServerConfig>>
  readonly approvalMode: 'ask' | 'yolo'
  readonly workingInterval?: number
  readonly processFactory?: CodexProcessOwnerFactory
}): CodingBackendRouting {
  const profiles = runtimeCodingProfiles(parseCodingProfiles(options.environment.CODING_PROFILES), options.environment)
  const factory: AcpTransportFactoryOptions = {
    profiles: profiles.profiles, capabilities: options.capabilities,
    ...(options.knowledgeEntries === undefined ? {} : {knowledgeEntries: options.knowledgeEntries}),
    permissionMode: options.approvalMode === 'yolo' ? 'full' : 'ask',
    ...(options.workingInterval === undefined ? {} : {workingInterval: options.workingInterval}),
    ...(options.processFactory === undefined ? {} : {processFactory: options.processFactory}),
  }
  return Object.freeze({
    initialBackend: options.initialBackend,
    defaultProfile: (backend: AcpBackendId) => profiles.defaults[backend],
    displayName: (backend: AcpBackendId) => acpBackend(backend).displayName,
    create: (binding: AcpProjectBinding) => createAcpProjectTransport(factory, binding),
  })
}
