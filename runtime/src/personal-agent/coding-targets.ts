import type {TaskDispatchContext} from '../core/task-tools.js'
import {ProjectResolutionError, type CoordinatorDecision, type IntakeTarget} from '../executors/coding-executor.js'

export interface CodingTargetSelection {
  readonly workspace_id: string
  readonly session_id: string | null
}

/** Public labels and opaque IDs only; never paths, homes or executor thread IDs. */
export interface CodingTarget extends CodingTargetSelection {
  readonly project: string
  readonly title: string
  readonly executor: 'codex'
  /** Epoch ms of the executor's last use; sessions only. */
  readonly last_active?: number
  /** Title of the work holding this target's resources, when the executor's lock policy blocks it. */
  readonly running?: string
}

export interface CodingTargetPort {
  /** Directory is picker-only display metadata; validate returns a path-free persistent target. */
  list(): Promise<readonly (CodingTarget & {readonly directory?: string; readonly group_workspace_id?: string; readonly group_project?: string; readonly group_directory?: string})[]>
  forWork?(workId: string): Promise<CodingTarget | null>
  validate(selection: CodingTargetSelection): Promise<CodingTarget>
  resolve(decision: CoordinatorDecision, selection?: CodingTargetSelection,taskContext?:TaskDispatchContext): Promise<IntakeTarget>
}

/** Owned by one conversation. Global project/session focus is never a default here. */
export class CodingTargetController {
  #target: CodingTarget | null = null
  #revision = 0
  #work: {id: string; revision: number} | null = null
  constructor(readonly port: CodingTargetPort, readonly onUpdate?: (target: CodingTarget, stillCurrent: () => boolean) => Promise<boolean>) {}
  get revision(): number { return this.#revision }

  /** Claim only accepted dispatches/switches; older tasks cannot replace a newer selection. */
  async accepted(selection: CodingTargetSelection | null, workId: string | undefined, expectedRevision: number): Promise<void> {
    if (expectedRevision !== this.#revision) return
    const revision = ++this.#revision
    this.#work = null
    try {
      if (selection !== null) await this.#adopt(await this.port.validate(selection), revision)
    } finally {
      if (revision === this.#revision) this.#work = workId === undefined ? null : {id: workId, revision}
      await this.refreshWork()
    }
  }

  /** Project-view/progress notifications are triggers only; the work binding supplies authority. */
  async refreshWork(): Promise<void> {
    const work = this.#work
    if (work?.revision !== this.#revision || !this.port.forWork) return
    const target = await this.port.forWork(work.id)
    if (target === null || !await this.#adopt(target, work.revision)) return
    if (this.#work === work) this.#work = null
  }

  async #adopt(target: CodingTarget, revision: number): Promise<boolean> {
    const stillCurrent = () => revision === this.#revision
    if (!stillCurrent()) return false
    if (this.onUpdate && !await this.onUpdate({...target}, stillCurrent)) return false
    if (!stillCurrent()) return false
    this.#target = {...target}
    return true
  }
  get target(): CodingTarget | null { return this.#target === null ? null : {...this.#target} }
  activeProject(): string | null { return this.#target?.project ?? null }
  list(): ReturnType<CodingTargetPort['list']> { return this.port.list() }
  async setTarget(selection: CodingTargetSelection | null): Promise<CodingTarget | null> {
    const revision = ++this.#revision
    const target = selection === null ? null : await this.port.validate({...selection})
    if (revision !== this.#revision) throw new ProjectResolutionError('unknown_project', {reason: 'target_superseded'})
    this.#target = target === null ? null : {...target}
    return this.target
  }
  async resolveTarget(decision: CoordinatorDecision,taskContext?:TaskDispatchContext): Promise<IntakeTarget> {
    const target = this.#target
    if (decision.kind === 'create') return this.port.resolve(decision,undefined,taskContext)
    const bound = target !== null && (decision.project === null || decision.project.toLowerCase() === target.project.toLowerCase())
    if (!bound && decision.project === null) throw new ProjectResolutionError('unknown_project', {reason: 'explicit_project_required'})
    if (decision.kind === 'work' && decision.session === 'latest' && !decision.session_title && (!bound || target.session_id === null)) {
      throw new ProjectResolutionError('unknown_session', {reason: 'continuation_target_required'})
    }
    if (bound) {
      return this.port.resolve({...decision, project: target.project}, {
        workspace_id: target.workspace_id,
        session_id: decision.session === 'new' || decision.session_title ? null : target.session_id,
      },taskContext)
    }
    return this.port.resolve(decision,undefined,taskContext)
  }
}
