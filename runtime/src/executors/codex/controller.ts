import type {CodingAgentControllerFactory} from '../../coding-executor.js'
import type {
  AgentActionResult,
  AgentCancelRequest,
  AgentController,
  AgentDispatchRequest,
  AgentDescriptor,
  AgentRuntimeDispatchPort,
} from '../../agent-controller.js'
import type {AgentExecutor, CancelContext} from '../../coding-executor.js'
import {IntakeController, type IntakeOptions, type IntakeEventPort, type IntakeSession} from '../coding/intake.js'
import {CODEX_AGENT_SUMMARY} from './contract.js'

export function codexAgentDescriptor(channel: string): AgentDescriptor {
  return Object.freeze({
    name: 'codex',
    summary: CODEX_AGENT_SUMMARY,
    ownedChannels: Object.freeze([channel]),
  })
}

/** Backward-compatible descriptor for the built-in Codex executor channel. */
export const CODEX_AGENT_DESCRIPTOR = codexAgentDescriptor('codex')

/**
 * The Codex-specific bridge behind the generic host controller port.
 *
 * Project roster/session resolution stays inside IntakeController and ProjectCodexAdapter. This
 * controller only translates a fenced public agent request into that existing private behavior.
 */
export class CodexAgentController implements AgentController {
  readonly descriptor: AgentDescriptor
  readonly #channel: string
  readonly #intake: IntakeController | undefined
  readonly #executor: Pick<AgentExecutor, 'cancel'> | undefined
  readonly #dispatchPort: AgentRuntimeDispatchPort | undefined
  readonly #resolveCancelTarget: CancelContext['resolveCancelTarget']

  constructor(options: {
    /** Runtime channel selected by the composition root's `coding` role. */
    readonly channel?: string
    readonly intake?: IntakeOptions
    readonly executor?: Pick<AgentExecutor, 'cancel'>
    readonly dispatchPort?: AgentRuntimeDispatchPort
    readonly resolveCancelTarget: CancelContext['resolveCancelTarget']
  }) {
    this.#channel = options.channel ?? 'codex'
    this.descriptor = codexAgentDescriptor(this.#channel)
    this.#intake = options.intake === undefined ? undefined : new IntakeController(options.intake)
    this.#executor = options.executor
    this.#dispatchPort = options.dispatchPort
    this.#resolveCancelTarget = options.resolveCancelTarget
  }

  get intake(): IntakeEventPort | undefined { return this.#intake }
  inspectIntakeForTest(): Readonly<IntakeSession> | null { return this.#intake?.view ?? null }
  async settleIntakeForTest(): Promise<void> { await this.#intake?.settled() }

  async dispatch(request: AgentDispatchRequest): Promise<AgentActionResult> {
    if (!request.stillWanted()) return {code: 'superseded', accepted: false, detail: {}}
    const intake = this.#intake
    if (intake === undefined) {
      const dispatchPort = this.#dispatchPort
      if (dispatchPort === undefined) return {code: 'unsupported_tool', accepted: false, detail: {}}
      // The controller owns the last fence before the runtime effect. The port repeats it at the
      // host/runtime boundary so neither a synchronous nor an asynchronous caller can bypass it.
      if (!request.stillWanted()) return {code: 'superseded', accepted: false, detail: {}}
      const admission = await dispatchPort.dispatch({
        channel: this.#channel, op: 'run', request: {work_order: request.instruction},
        origin_ref: request.origin_ref, stillWanted: request.stillWanted,
      })
      if (!request.stillWanted()) return {code: 'superseded', accepted: false, detail: {}}
      if (!admission.accepted || admission.delegate_id === null) {
        return {code: 'runtime_rejected', accepted: false, detail: {}}
      }
      return {
        code: 'delegated', accepted: true, delegate_id: admission.delegate_id,
        detail: {channel: this.#channel, op: 'run'},
      }
    }
    const code = intake.open(
      {work_order: request.instruction, project: null, session: 'latest'},
      request.originalUserText,
      request.origin_ref,
      String(request.sessionEpoch),
    )
    const state = intake.view?.state
    if (state === undefined) return {code: 'runtime_rejected', accepted: false, detail: {}}
    return {code, accepted: true, detail: {state}}
  }

  async cancel(request: AgentCancelRequest): Promise<AgentActionResult> {
    if (!request.stillWanted()) return {code: 'superseded', accepted: false, detail: {}}
    const executor = this.#executor
    if (executor === undefined) return {code: 'unsupported_tool', accepted: false, detail: {}}
    const result = await executor.cancel(request.instruction, {
      resolveCancelTarget: this.#resolveCancelTarget,
      stillWanted: request.stillWanted,
    })
    if (result.code === 'cancelled') {
      return {code: result.code, accepted: true, detail: {work: workDetail(result.work)}}
    }
    if (result.code === 'ambiguous_work') {
      return {code: result.code, accepted: true, detail: {running: result.running.map(workDetail)}}
    }
    return {code: result.code, accepted: true, detail: {}}
  }
}

function workDetail(work: {readonly work_id: string; readonly project: string; readonly title: string}) {
  return {work_id: work.work_id, project: work.project, title: work.title}
}

/** Concrete package supplies its controller through the existing composition seam. */
export const codingAgentControllerFactory: CodingAgentControllerFactory = {
  create: context => new CodexAgentController({
    channel: context.channel,
    ...(context.intake === undefined ? {} : {intake: context.intake}),
    ...(context.executor === undefined ? {} : {executor: context.executor}),
    dispatchPort: context.dispatchPort,
    resolveCancelTarget: context.resolveCancelTarget,
  }),
}
