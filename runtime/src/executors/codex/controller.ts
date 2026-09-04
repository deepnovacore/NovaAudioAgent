import type {
  AgentActionResult,
  AgentCancelRequest,
  AgentController,
  AgentDispatchRequest,
  AgentDescriptor,
} from '../../agent-controller.js'
import type {AgentExecutor, CancelContext} from '../../coding-executor.js'
import type {IntakeController} from '../coding/intake.js'
import {CODEX_AGENT_SUMMARY} from './contract.js'

export const CODEX_AGENT_DESCRIPTOR: AgentDescriptor = Object.freeze({
  name: 'codex',
  summary: CODEX_AGENT_SUMMARY,
  ownedChannels: Object.freeze(['codex']),
})

/**
 * The Codex-specific bridge behind the generic host controller port.
 *
 * Project roster/session resolution stays inside IntakeController and ProjectCodexAdapter. This
 * controller only translates a fenced public agent request into that existing private behavior.
 */
export class CodexAgentController implements AgentController {
  readonly descriptor = CODEX_AGENT_DESCRIPTOR
  readonly #intake: Pick<IntakeController, 'open' | 'view'> | undefined
  readonly #executor: Pick<AgentExecutor, 'cancel'> | undefined
  readonly #resolveCancelTarget: CancelContext['resolveCancelTarget']

  constructor(options: {
    readonly intake?: Pick<IntakeController, 'open' | 'view'>
    readonly executor?: Pick<AgentExecutor, 'cancel'>
    readonly resolveCancelTarget: CancelContext['resolveCancelTarget']
  }) {
    this.#intake = options.intake
    this.#executor = options.executor
    this.#resolveCancelTarget = options.resolveCancelTarget
  }

  async dispatch(request: AgentDispatchRequest): Promise<AgentActionResult> {
    if (!request.stillWanted()) return {code: 'superseded', accepted: false, detail: {}}
    const intake = this.#intake
    if (intake === undefined) return {code: 'unsupported_tool', accepted: false, detail: {}}
    const code = intake.open(
      {work_order: request.instruction, project: null, session: 'latest'},
      request.originalUserText,
      request.origin_ref,
      String(request.sessionEpoch),
    )
    return {
      code,
      accepted: true,
      detail: intake.view === null ? {} : {state: intake.view.state},
    }
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
