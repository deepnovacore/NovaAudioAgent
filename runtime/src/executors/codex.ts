import type {CodexAppServerTransport} from '../codex-app-server-transport.js'
import {
  CODEX_BASE_MANIFEST,
  validateCodexRequest,
  type CodexStatusSnapshot,
} from '../codex-contract.js'
import type {
  ExecutorAdapter,
  ExecutorDispatchContext,
  ExecutorHandoff,
} from '../causal-runtime.js'
import type {JsonValue} from '../events.js'
import {
  CodexAdapterCore,
  failureHandoff,
  type CodexAdapterScheduler,
} from './codex-common.js'

export const CODEX_MANIFEST = CODEX_BASE_MANIFEST

export class CodexAdapter implements ExecutorAdapter {
  readonly manifest = CODEX_MANIFEST
  readonly #core: CodexAdapterCore

  constructor(transport: CodexAppServerTransport, scheduler?: CodexAdapterScheduler) {
    this.#core = new CodexAdapterCore(transport, {
      live: false,
      ...(scheduler === undefined ? {} : {scheduler}),
    })
  }

  get status(): CodexStatusSnapshot { return this.#core.status }

  async dispatch(
    op: string,
    request: Readonly<Record<string, JsonValue>>,
    context: ExecutorDispatchContext,
  ): Promise<ExecutorHandoff> {
    const admitted = validateCodexRequest('base', op, request)
    if (!admitted.ok) return failureHandoff(admitted.error, admitted.op)
    if (op === 'status') return this.#core.statusHandoff(context.clock.now())
    const workOrder = admitted.value.work_order
    if (typeof workOrder !== 'string') return failureHandoff('invalid_params', op)
    return await this.#core.run(workOrder, context)
  }
}
