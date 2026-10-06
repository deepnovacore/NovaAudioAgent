import {SensitiveContentPolicy,SensitivePathPolicy,redactUrlQueryCredentials} from '../../memory/sensitivity.js'
import {isAbsolute,relative,resolve} from 'node:path'
import type {ExecutorProgress,ExecutorActivity} from '../../core/causal-runtime.js'
import type {Clock} from '../../core/clock.js'
import {snapshotJsonRecord} from './safe-json.js'
import type {CodexLaunchProfile} from './launch-profile.js'
import {validProgressSummary} from '../../core/events.js'
import {isPythonSpace} from '../../text/python-text.js'
import {
  CodexProtocolError,
  MAX_FINAL_TEXT_INPUT,
  MAX_INTERNAL_ACTIVITY,
  MAX_STDOUT,
  SUMMARY_PROSE_LIMIT,
  WORKING_INTERVAL,
} from './protocol.js'

const observationSensitivity = new SensitiveContentPolicy()
const artifactPathSensitivity = new SensitivePathPolicy()
const EAGER_ACTIVITY_INTERVAL_SECONDS = 60

export interface TurnCompletion {
  readonly status: 'completed' | 'failed'
  readonly final_text: string | null
  readonly internal_activity: number
  readonly error_code?: 'usage_limit_exceeded' | null
}

export class AppServerTurnProjection {
  readonly #sanitizePublicText:((text:string)=>{text:string;truncated:boolean})|undefined
  readonly #onActivity:((event:ExecutorActivity)=>void)|undefined
  readonly #publicStages=new Set<string>()
  #pendingPublic:ExecutorActivity[]=[]
  #pendingPublicBytes=0
  #workspace:string|null=null
  readonly #clock: Clock
  readonly #onProgress: ((progress: ExecutorProgress) => void) | undefined
  readonly #workingInterval: number
  readonly #eagerProgress: boolean
  #reportedActivities = new Set<string>()
  #lastSummaryAt: number | null = null
  #threadId: string | null = null
  #notificationTurnId: string | null = null
  #responseTurnId: string | null = null
  #activeTurnId: string | null = null
  #startedAt: number | null = null
  #internalActivity = 0
  #lastWorkingAt: number | null = null
  #lastEmittedProse: string | null = null
  #completedAgentText: string | null = null
  #summaryProse: string | null = null
  readonly #fileChangeItems = new Map<string, {
    readonly item: Readonly<Record<string, unknown>>
    readonly startedAtMs: number
  } | null>()

  constructor(options: {
    readonly clock: Clock
    readonly sanitizePublicText?:(text:string)=>{text:string;truncated:boolean}
    readonly onActivity?:(event:ExecutorActivity)=>void
    readonly onProgress?: (progress: ExecutorProgress) => void
    readonly workingInterval?: number
    readonly eagerProgress?: boolean
  }) {
    this.#sanitizePublicText=options.sanitizePublicText
    this.#onActivity=options.onActivity
    this.#clock = options.clock
    this.#onProgress = options.onProgress
    this.#workingInterval = options.workingInterval ?? WORKING_INTERVAL
    this.#eagerProgress = options.eagerProgress === true
    if (!Number.isFinite(this.#workingInterval) || this.#workingInterval < 0) {
      throw new RangeError('working interval must be non-negative and finite')
    }
  }

  get threadId(): string | null { return this.#threadId }

  get activePair(): readonly [string, string] | null {
    if (this.#threadId === null || this.#activeTurnId === null) return null
    return Object.freeze([this.#threadId, this.#activeTurnId])
  }

  get turnWasStarted(): boolean { return this.#notificationTurnId !== null }

  fileChangeItemForApproval(
    threadId: string,
    turnId: string,
    itemId: string,
    startedAtMs: number,
  ): Readonly<Record<string, unknown>> | null {
    if (
      threadId !== this.#threadId
      || turnId !== this.#activeTurnId
      || typeof itemId !== 'string'
      || itemId === ''
      || !Number.isSafeInteger(startedAtMs)
      || startedAtMs < 0
    ) return null
    const context = this.#fileChangeItems.get(itemId)
    return context?.item ?? null
  }

  bindThread(
    response: unknown,
    options: {
      readonly workspace: string
      readonly ephemeral?: boolean
      readonly expectedThreadId?: string
      readonly approvalPolicy?: 'never' | 'on-request'
      readonly launchProfile?: CodexLaunchProfile
    },
  ): void {
    try {
      const envelope = snapshotJsonRecord(response)
      const thread = requireObject(envelope.thread)
      const threadId = requireNonemptyString(thread.id)
      const ephemeral = options.ephemeral ?? true
      if (options.expectedThreadId !== undefined && threadId !== options.expectedThreadId) {
        throw new TypeError('thread identity')
      }
      if (thread.ephemeral !== ephemeral) throw new TypeError('thread mode')
      if (ephemeral) {
        if (thread.path !== null) throw new TypeError('thread path')
      } else {
        requireNonemptyString(thread.path)
      }
      if (!samePath(thread.cwd, options.workspace) || !samePath(envelope.cwd, options.workspace)) {
        throw new TypeError('workspace')
      }
      if (!ephemeral) {
        const roots = envelope.runtimeWorkspaceRoots
        if (!Array.isArray(roots) || roots.length !== 1 || !samePath(roots[0], options.workspace)) {
          throw new TypeError('workspace roots')
        }
      }
      const launchProfile = options.launchProfile
      if (envelope.approvalPolicy !== (launchProfile?.thread.approvalPolicy ?? options.approvalPolicy ?? 'never')) {
        throw new TypeError('approval')
      }
      if (envelope.approvalsReviewer !== 'user') throw new TypeError('reviewer')
      if (launchProfile !== undefined && 'sandbox' in launchProfile.thread) {
        if (requireObject(envelope.sandbox).type !== 'dangerFullAccess') throw new TypeError('sandbox')
        if (envelope.activePermissionProfile !== null && envelope.activePermissionProfile !== undefined) {
          const profile = requireObject(envelope.activePermissionProfile)
          if (profile.id === 'nova_audio_agent') throw new TypeError('profile')
        }
      } else {
        const profile = requireObject(envelope.activePermissionProfile)
        if (profile.id !== 'nova_audio_agent') throw new TypeError('profile')
      }
      this.#workspace=options.workspace
      this.#threadId = threadId
    } catch {
      throw new CodexProtocolError('unsupported_protocol')
    }
  }

  bindTurnResponse(response: unknown): string {
    let turnId: string
    try {
      const envelope = snapshotJsonRecord(response)
      turnId = requireNonemptyString(requireObject(envelope.turn).id)
    } catch {
      throw new CodexProtocolError('unsupported_protocol')
    }
    if (this.#notificationTurnId !== null && this.#notificationTurnId !== turnId) {
      this.#pendingPublic=[];this.#pendingPublicBytes=0
      throw new CodexProtocolError('turn_identity_mismatch')
    }
    this.#responseTurnId = turnId
    const pending=this.#pendingPublic;this.#pendingPublic=[];this.#pendingPublicBytes=0
    for(const event of pending)this.#emitActivity(event)
    return turnId
  }

  notification(method: string, params: Readonly<Record<string, unknown>>): TurnCompletion | null {
    if (
      method !== 'turn/started'
      && method !== 'item/started'
      && method !== 'item/completed'
      && method !== 'turn/completed'
    ) {
      return null
    }
    let snapshot: Record<string, unknown>
    try {
      snapshot = snapshotJsonRecord(params)
    } catch {
      throw new CodexProtocolError('unsupported_protocol')
    }
    if (method === 'turn/started') {
      this.#turnStarted(snapshot)
      return null
    }
    if (method === 'item/started') {
      this.#itemStarted(snapshot)
      return null
    }
    if (method === 'item/completed') {
      this.#itemCompleted(snapshot)
      return null
    }
    return this.#turnCompleted(snapshot)
  }

  #turnStarted(params: Readonly<Record<string, unknown>>): void {
    if (params.threadId !== this.#threadId || !isPlainObject(params.turn)) return
    const turnId = params.turn.id
    if (typeof turnId !== 'string' || turnId === '' || this.#notificationTurnId !== null) return
    if (this.#responseTurnId !== null && this.#responseTurnId !== turnId) {
      throw new CodexProtocolError('turn_identity_mismatch')
    }
    this.#notificationTurnId = turnId
    this.#activeTurnId = turnId
    this.#completedAgentText = null
    this.#summaryProse = null
    this.#fileChangeItems.clear()
    this.#lastEmittedProse = null
    this.#startedAt = this.#clock.now()
    this.#lastWorkingAt = this.#startedAt
    this.#lastSummaryAt = this.#startedAt
    this.#reportedActivities.clear()
    this.#emit({phase: 'started', internal_activity: 0, elapsed: 0, summary: null})
  }

  #itemStarted(params: Readonly<Record<string, unknown>>): void {
    if (!this.#matchesItem(params)) return
    this.#publicItem(params.item,'started')
    const startedItem = params.item
    if (
      startedItem.type !== 'fileChange'
      || typeof startedItem.id !== 'string'
      || startedItem.id === ''
      || typeof params.startedAtMs !== 'number'
      || !Number.isSafeInteger(params.startedAtMs)
      || params.startedAtMs < 0
    ) return
    this.#fileChangeItems.set(
      startedItem.id,
      this.#fileChangeItems.has(startedItem.id)
        ? null
        : Object.freeze({item: startedItem, startedAtMs: params.startedAtMs}),
    )
  }

  #itemCompleted(params: Readonly<Record<string, unknown>>): void {
    if (!this.#matchesItem(params) || this.#startedAt === null) return
    this.#publicItem(params.item,'completed')
    const completedItem = params.item
    if (typeof completedItem.id === 'string') this.#fileChangeItems.delete(completedItem.id)
    if (completedItem.type === 'agentMessage' && typeof completedItem.text === 'string') {
      this.#completedAgentText = clipCodePoints(completedItem.text, MAX_FINAL_TEXT_INPUT)
    }
    this.#reduceSummaryItem(completedItem)
    if (this.#internalActivity < MAX_INTERNAL_ACTIVITY) this.#internalActivity += 1
    const now = this.#clock.now()
    const elapsed = Math.max(0, now - this.#startedAt)
    const intervalElapsed = this.#lastWorkingAt !== null
      && now - this.#lastWorkingAt >= this.#workingInterval
    let summary = this.#summaryProse !== this.#lastEmittedProse ? this.#summaryProse : null
    if (summary !== null) this.#reportedActivities.clear()
    else if (this.#eagerProgress && this.#lastSummaryAt !== null
      && now - this.#lastSummaryAt >= Math.max(EAGER_ACTIVITY_INTERVAL_SECONDS, this.#workingInterval)) {
      // Use only structured completion facts. Never summarize commands, paths, output or reasoning.
      const activity = completedItem.type === 'commandExecution'
        ? completedItem.status === 'failed' ? '一条工作区命令执行失败，尚未确认恢复结果。'
          : completedItem.status === 'completed' ? '一条工作区命令已执行结束，尚未确认任务最终结果。' : null
        : completedItem.type === 'fileChange' && completedItem.status === 'completed'
          ? '已应用一批文件修改，尚未确认验证结果。' : null
      if (activity !== null && !this.#reportedActivities.has(activity)) {
        summary = activity
        this.#reportedActivities.add(activity)
      }
    }
    if (summary !== null) this.#lastSummaryAt = now
    if (!intervalElapsed && summary === null) return
    this.#lastWorkingAt = now
    this.#lastEmittedProse = this.#summaryProse
    this.#emit({
      phase: 'working',
      internal_activity: this.#internalActivity,
      elapsed,
      summary,
    })
  }

  #publicItem(item:Readonly<Record<string,unknown>>,stage:'started'|'completed'):void{
    if(!this.#onActivity)return
    if(typeof item.id!=='string'||!item.id||item.id.length>512)return
    const key=JSON.stringify([item.id,stage]);if(this.#publicStages.has(key)||(stage==='started'&&this.#publicStages.has(JSON.stringify([item.id,'completed']))))return
    let kind:ExecutorActivity['kind'],text:string,sender:ExecutorActivity['sender']
    if(item.type==='agentMessage'&&typeof item.text==='string'){kind='message';text=item.text;sender='executor'}
    else if(item.type==='commandExecution'||item.type==='fileChange'||item.type==='mcpToolCall'||item.type==='webSearch'){
      kind='tool';text=String(item.type)+' '+stage+(typeof item.status==='string'&&['completed','failed','inProgress','declined'].includes(item.status)?': '+item.status:'')
    }else return
    let fieldTruncated=false
    const publicField=(raw:unknown):string|null=>{
      if(typeof raw!=='string')return null
      const value=redactUrlQueryCredentials(raw)
      const scrubbed=observationSensitivity.scrub('executor_observation',value)
      const safe=scrubbed.kind==='clean'?value:scrubbed.kind==='redacted'?scrubbed.value:'[redacted]'
      const sanitized=this.#sanitizePublicText?.(safe)??{text:safe,truncated:false}
      fieldTruncated||=sanitized.truncated;return sanitized.text
    }
    const status=typeof item.status==='string'&&['completed','failed','inProgress','declined'].includes(item.status)?item.status:null
    if(stage==='completed'&&item.type==='commandExecution')text=JSON.stringify({type:item.type,status,command:publicField(item.command),output:publicField(item.aggregatedOutput),exit_code:Number.isSafeInteger(item.exitCode)?item.exitCode:null})
    if(stage==='completed'&&item.type==='mcpToolCall'){
      const result=isPlainObject(item.result)&&Array.isArray(item.result.content)?item.result.content:[]
      const readback=result.filter((part):part is Record<string,unknown>=>isPlainObject(part)&&part.type==='text'&&typeof part.text==='string').map(part=>part.text as string).join('\n')
      text=JSON.stringify({type:item.type,server:publicField(item.server),tool:publicField(item.tool),status,is_error:isPlainObject(item.result)&&typeof item.result.isError==='boolean'?item.result.isError:null,readback:publicField(readback)})
    }
    this.#publicStages.add(key)
    const refs:string[]=[]
    if(item.type==='fileChange'&&Array.isArray(item.changes)&&this.#workspace)for(const change of item.changes){
      if(!isPlainObject(change)||typeof change.path!=='string')continue
      const absolutePath=resolve(this.#workspace,change.path)
      const path=relative(this.#workspace,absolutePath)
      if(path&&!isAbsolute(path)&&path!=='..'&&!path.startsWith('../')&&!/[\p{C}]/u.test(path)&&path.length<=480&&artifactPathSensitivity.allows(absolutePath)&&observationSensitivity.scrub('artifact_path',path).kind==='clean')refs.push('workspace-file:'+path)
      if(refs.length===128)break
    }
    const sanitized=this.#sanitizePublicText?.(text)??{text,truncated:false};text=sanitized.text
    const event:ExecutorActivity={thread_id:this.#threadId!,turn_id:this.#activeTurnId!,item_id:item.id,stage,kind,...(sender?{sender}:{}),text:text.slice(0,16000),refs,...(fieldTruncated||sanitized.truncated||text.length>16000?{text_truncated:true}:{})}
    if(this.#responseTurnId===null){
      this.#pendingPublicBytes+=Buffer.byteLength(JSON.stringify(event))
      if(this.#pendingPublicBytes>MAX_STDOUT){this.#pendingPublic=[];this.#pendingPublicBytes=0;throw new CodexProtocolError('unsupported_protocol')}
      this.#pendingPublic.push(event)
    }else this.#emitActivity(event)
  }
  #emitActivity(event:ExecutorActivity):void{try{this.#onActivity?.(event)}catch{/* public display is advisory */}}


  #reduceSummaryItem(item: Readonly<Record<string, unknown>>): void {
    const type = item.type
    if (type === 'agentMessage' || type === 'plan') {
      if (typeof item.text === 'string') this.#summaryProse = boundedProse(item.text, SUMMARY_PROSE_LIMIT)
      return
    }
  }

  #matchesItem(params: Readonly<Record<string, unknown>>): params is Readonly<{
    threadId: unknown
    turnId: unknown
    item: Record<string, unknown>
    startedAtMs?: unknown
  }> {
    return this.#threadId !== null
      && this.#activeTurnId !== null
      && params.threadId === this.#threadId
      && params.turnId === this.#activeTurnId
      && isPlainObject(params.item)
  }

  #turnCompleted(params: Readonly<Record<string, unknown>>): TurnCompletion | null {
    if (params.threadId !== this.#threadId) return null
    if (!isPlainObject(params.turn)) return null
    const turn = params.turn
    if (turn.id !== this.#activeTurnId) return null
    if (
      (turn.status !== 'completed' && turn.status !== 'failed' && turn.status !== 'interrupted')
      || !Array.isArray(turn.items)
    ) throw new CodexProtocolError('unsupported_protocol')
    let finalText: string | null = null
    for (const candidate of turn.items) {
      if(isPlainObject(candidate))this.#publicItem(candidate,'completed')
      if (
        isPlainObject(candidate)
        && candidate.type === 'agentMessage'
        && typeof candidate.text === 'string'
      ) finalText = clipCodePoints(candidate.text, MAX_FINAL_TEXT_INPUT)
    }
    if (finalText === null && turn.itemsView === 'notLoaded') finalText = this.#completedAgentText
    this.#activeTurnId = null
    this.#completedAgentText = null
    this.#fileChangeItems.clear()
    return Object.freeze({
      status: turn.status === 'completed' ? 'completed' : 'failed',
      final_text: finalText,
      internal_activity: this.#internalActivity,
      error_code: safeTurnErrorCode(turn.error),
    })
  }

  #emit(progress: ExecutorProgress): void {
    if (this.#onProgress === undefined) return
    if (
      !Number.isFinite(progress.elapsed)
      || progress.elapsed < 0
      || !Number.isSafeInteger(progress.internal_activity)
      || progress.internal_activity < 0
      || !validProgressSummary(progress.summary, progress.phase)
    ) return
    try {
      this.#onProgress(Object.freeze({...progress}))
    } catch {
      // Progress is advisory and consumer failures cannot affect turn correlation.
    }
  }
}

function boundedProse(text: string, limit: number): string {
  const words: string[] = []
  let word = ''
  for (const character of text) {
    if (isPythonSpace(character)) {
      if (word !== '') {
        words.push(word)
        word = ''
      }
    } else word += character
  }
  if (word !== '') words.push(word)
  return clipCodePoints(words.join(' '), limit)
}

function clipCodePoints(text: string, limit: number): string {
  const result: string[] = []
  for (const character of text) {
    if (result.length >= limit) break
    result.push(character)
  }
  return result.join('')
}

function samePath(value: unknown, expected: string): boolean {
  return typeof value === 'string' && resolve(value) === resolve(expected)
}

function requireNonemptyString(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw new TypeError('string')
  return value
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) throw new TypeError('object')
  return value
}

function safeTurnErrorCode(value: unknown): 'usage_limit_exceeded' | null {
  if (!isPlainObject(value)) return null
  return value.codexErrorInfo === 'usageLimitExceeded' ? 'usage_limit_exceeded' : null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === Object.prototype || prototype === null
}
