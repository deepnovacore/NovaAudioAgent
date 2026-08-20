import {resolve} from 'node:path'
import type {ExecutorProgress} from './causal-runtime.js'
import type {Clock} from './clock.js'
import {snapshotJsonRecord} from './codex-safe-json.js'
import {PROGRESS_SUMMARY_LIMIT, validProgressSummary} from './events.js'
import {isPythonSpace} from './python-text.js'
import {
  CodexProtocolError,
  MAX_FINAL_TEXT_INPUT,
  MAX_INTERNAL_ACTIVITY,
  SUMMARY_PROSE_LIMIT,
  WORKING_INTERVAL,
} from './codex-protocol.js'

export interface TurnCompletion {
  readonly status: 'completed' | 'failed'
  readonly final_text: string | null
  readonly internal_activity: number
}

export class AppServerTurnProjection {
  readonly #clock: Clock
  readonly #onProgress: ((progress: ExecutorProgress) => void) | undefined
  readonly #workingInterval: number
  #threadId: string | null = null
  #notificationTurnId: string | null = null
  #responseTurnId: string | null = null
  #activeTurnId: string | null = null
  #startedAt: number | null = null
  #internalActivity = 0
  #lastWorkingAt: number | null = null
  #hasEmittedProse = false
  #completedAgentText: string | null = null
  #summaryProse: string | null = null
  #commands = 0
  #commandsFailed = 0
  #filesChanged = 0
  #toolCalls = 0

  constructor(options: {
    readonly clock: Clock
    readonly onProgress?: (progress: ExecutorProgress) => void
    readonly workingInterval?: number
  }) {
    this.#clock = options.clock
    this.#onProgress = options.onProgress
    this.#workingInterval = options.workingInterval ?? WORKING_INTERVAL
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

  bindThread(
    response: unknown,
    options: {
      readonly workspace: string
      readonly ephemeral?: boolean
      readonly expectedThreadId?: string
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
      if (envelope.approvalPolicy !== 'never') throw new TypeError('approval')
      const profile = requireObject(envelope.activePermissionProfile)
      if (profile.id !== 'nova_audio_agent') throw new TypeError('profile')
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
      throw new CodexProtocolError('turn_identity_mismatch')
    }
    this.#responseTurnId = turnId
    return turnId
  }

  notification(method: string, params: Readonly<Record<string, unknown>>): TurnCompletion | null {
    if (method !== 'turn/started' && method !== 'item/completed' && method !== 'turn/completed') {
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
    this.#commands = 0
    this.#commandsFailed = 0
    this.#filesChanged = 0
    this.#toolCalls = 0
    this.#hasEmittedProse = false
    this.#startedAt = this.#clock.now()
    this.#lastWorkingAt = this.#startedAt
    this.#emit({phase: 'started', internal_activity: 0, elapsed: 0, summary: null})
  }

  #itemCompleted(params: Readonly<Record<string, unknown>>): void {
    if (!this.#matchesItem(params) || this.#startedAt === null) return
    const completedItem = params.item
    if (completedItem.type === 'agentMessage' && typeof completedItem.text === 'string') {
      this.#completedAgentText = clipCodePoints(completedItem.text, MAX_FINAL_TEXT_INPUT)
    }
    this.#reduceSummaryItem(completedItem)
    if (this.#internalActivity < MAX_INTERNAL_ACTIVITY) this.#internalActivity += 1
    const now = this.#clock.now()
    const elapsed = Math.max(0, now - this.#startedAt)
    const intervalElapsed = this.#lastWorkingAt !== null
      && now - this.#lastWorkingAt >= this.#workingInterval
    const firstProse = this.#summaryProse !== null && !this.#hasEmittedProse
    if (!intervalElapsed && !firstProse) return
    this.#lastWorkingAt = now
    this.#hasEmittedProse ||= this.#summaryProse !== null
    this.#emit({
      phase: 'working',
      internal_activity: this.#internalActivity,
      elapsed,
      summary: this.#composeSummary(),
    })
  }

  #reduceSummaryItem(item: Readonly<Record<string, unknown>>): void {
    const type = item.type
    if (type === 'agentMessage' || type === 'plan') {
      if (typeof item.text === 'string') this.#summaryProse = boundedProse(item.text, SUMMARY_PROSE_LIMIT)
      return
    }
    if (type === 'commandExecution') {
      this.#commands += 1
      if (item.exitCode !== 0 && item.exitCode !== null && item.exitCode !== undefined) {
        this.#commandsFailed += 1
      }
      return
    }
    if (type === 'fileChange') {
      this.#filesChanged += Array.isArray(item.changes) ? item.changes.length : 1
      return
    }
    if (type === 'mcpToolCall' || type === 'webSearch') this.#toolCalls += 1
  }

  #composeSummary(): string | null {
    const segments: string[] = []
    if (this.#commands > 0) {
      const failed = this.#commandsFailed > 0 ? `（${this.#commandsFailed} 条失败）` : ''
      segments.push(`已执行 ${this.#commands} 条命令${failed}`)
    }
    if (this.#filesChanged > 0) segments.push(`已修改 ${this.#filesChanged} 处文件`)
    if (this.#toolCalls > 0) segments.push(`已调用 ${this.#toolCalls} 次工具`)
    const digest = segments.join('、')
    let combined = digest
    if (digest !== '' && this.#summaryProse !== null) combined += `。${this.#summaryProse}`
    else if (digest === '' && this.#summaryProse !== null) combined = this.#summaryProse
    return combined === '' ? null : boundedProse(combined, PROGRESS_SUMMARY_LIMIT)
  }

  #matchesItem(params: Readonly<Record<string, unknown>>): params is Readonly<{
    threadId: unknown
    turnId: unknown
    item: Record<string, unknown>
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
      if (
        isPlainObject(candidate)
        && candidate.type === 'agentMessage'
        && typeof candidate.text === 'string'
      ) finalText = clipCodePoints(candidate.text, MAX_FINAL_TEXT_INPUT)
    }
    if (finalText === null && turn.itemsView === 'notLoaded') finalText = this.#completedAgentText
    this.#activeTurnId = null
    this.#completedAgentText = null
    return Object.freeze({
      status: turn.status === 'completed' ? 'completed' : 'failed',
      final_text: finalText,
      internal_activity: this.#internalActivity,
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === Object.prototype || prototype === null
}
