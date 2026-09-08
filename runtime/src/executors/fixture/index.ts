/** Deterministic, in-memory boundary probe; supplied to assembly's normal name/role registry. */
import {HostApprovalController} from '../../approval.js'
import type {Clock} from '../../clock.js'
import type {ExecutorDispatchContext, ExecutorHandoff} from '../../causal-runtime.js'
import type {CodingAgentControllerFactory, CodingExecutorResource, ProjectExecutorAdapter, ProjectRuntimeDispatch} from '../../coding-executor.js'
import {executorManifestSchema} from '../../ports.js'
import {ProjectConfirmationController, type ConfirmedProjectOperation} from '../../project-confirmation.js'
import {consumeHostExecutorCapability} from '../../host-executor-capability.js'
import {IntakeController} from '../coding/intake.js'
import type {JsonValue} from '../../events.js'

export const FIXTURE_DESCRIPTOR = {name: 'fixture', summary: 'Deterministic boundary probe', ownedChannels: ['fixture']}
const nothing = (): void => undefined

export function createFixtureExecutor(clock: Clock, idFactory: () => string) {
  if (process.env.NODE_ENV === 'production') throw new Error('fixture executor is test-only')
  const approval = new HostApprovalController({clock, idFactory})
  const confirmation = new ProjectConfirmationController({clock, idFactory})
  const dispatched: ExecutorDispatchContext[] = []
  const bindings = new WeakSet<object>()
  const commits: ConfirmedProjectOperation[] = []
  const adapter: ProjectExecutorAdapter = {
    manifest: executorManifestSchema.parse({
      name: 'fixture', display_name: 'Fixture Worker', roles: ['coding'], approvals: true,
      model_visibility: 'hidden',
      policy: {channel: 'fixture', priority: 50, wake: 'fast', typical_latency: 1, compress_watermark: 5, suggest: false},
      ops: ['run', 'steer', 'status', 'cancel'].map(name => ({
        name, description: name, readonly: name === 'status', deadline_budget: 60,
        params: {type: 'object', properties: name === 'run' ? {work_order: {type: 'string'}}
          : name === 'steer' ? {instruction: {type: 'string'}} : {}, additionalProperties: false,
          required: name === 'run' ? ['work_order'] : name === 'steer' ? ['instruction'] : []},
      })),
    }),
    confirmationController: confirmation,
    initialize: () => Promise.resolve(), close: () => { approval.invalidate('closed'); return Promise.resolve() },
    activeCommittedWorkspace: () => Promise.resolve(null),
    observeProjectView: () => nothing, observeProjectContext: () => nothing,
    observeCommittedWorkspace: () => nothing, observeTerminalWorkOrder: () => nothing,
    publicProjectView: pending => ({workspace_display_name: null, session_title: null, roster: [], pending_confirmation: pending, pending_confirmation_busy: confirmation.committing}),
    publicProjectContext: pending => ({workspace_id: null, view: adapter.publicProjectView(pending)}),
    roster: () => [], running: () => [], cancel: () => Promise.resolve({code: 'not_running'}),
    resolveIntakeTarget: () => Promise.resolve({workspace: 'Fixture Project', action: 'create', workspace_display_name: 'Fixture Project', workspace_id: null, session_id: null, session_title: null}),
    async commitConfirmed(operation: ConfirmedProjectOperation, dispatch: ProjectRuntimeDispatch) {
      if (!confirmation.ownsConfirmed(operation)) return Promise.resolve({accepted: false, code: 'confirmation_invalid'})
      let launchAuthorized = false
      const admission = await dispatch({executor: adapter.manifest.name, op: 'run', request: {work_order: operation.work_order ?? ''}, origin_ref: operation.origin_ref},
        {kind: 'realtime_tool', priority: 100, routing_class: 'user_awaited', origin: null, selected_suggestion: null}, operation, () => launchAuthorized)
      if (!admission.accepted) return Promise.resolve({accepted: false, code: 'runtime_rejected'})
      if (!confirmation.recordRuntimeAdmission(operation) || !confirmation.claimConfirmed(operation)) return Promise.resolve({accepted: false, code: 'confirmation_invalid'})
      launchAuthorized = true
      bindings.add(operation)
      commits.push(operation)
      return Promise.resolve({accepted: true, code: 'started'})
    },
    async dispatch(op: string, _request: Readonly<Record<string, JsonValue>>, context: ExecutorDispatchContext): Promise<ExecutorHandoff> {
      if (op !== 'run') return {outcome: 'ok', trust: 'untrusted_external', content: {state: 'idle'}}
      const capability = consumeHostExecutorCapability(context)
      if (capability === undefined || !bindings.delete(capability)) {
        return {outcome: 'refused', trust: 'untrusted_external', content: {code: 'confirmation_invalid'}}
      }
      dispatched.push(context)
      context.progress({phase: 'started', internal_activity: 1, elapsed: 0, summary: 'Fixture execution started'})
      const resolution = await approval.offer({kind: 'permissions', local_detail: {kind: 'permissions', scope: 'fixture only'}, operation_summary: 'Allow deterministic fixture completion'}, context.signal)
      const accepted = resolution !== null && approval.consume(resolution) === 'accept'
      return {outcome: accepted ? 'ok' : 'refused', trust: 'untrusted_external', content: {result: {final_message: {text: accepted ? 'Fixture completed' : 'Fixture declined', truncated: false}}}}
    },
  }
  const agentControllerFactory: CodingAgentControllerFactory = {
    create(context) {
      if (context.intake === undefined) throw new Error('fixture requires real host intake')
      const intake = new IntakeController(context.intake)
      return {
        descriptor: FIXTURE_DESCRIPTOR, intake,
        dispatch: request => {
          if (!request.stillWanted()) return Promise.resolve({code: 'superseded', accepted: false, detail: {}})
          const code = intake.open({work_order: request.instruction, project: null, session: 'latest'}, request.originalUserText, request.origin_ref, String(request.sessionEpoch))
          return Promise.resolve({code, accepted: true, detail: {state: intake.view!.state}})
        },
        cancel: request => Promise.resolve(request.stillWanted()
          ? {code: 'not_running', accepted: true, detail: {}}
          : {code: 'superseded', accepted: false, detail: {}}),
      }
    },
  }
  const resource: CodingExecutorResource = {adapter, mode: 'project', projectView: null, approvalController: approval,
    agentDescriptor: FIXTURE_DESCRIPTOR, agentControllerFactory, start: () => Promise.resolve(), close: () => adapter.close()}
  return {adapter, resource, approval, confirmation, dispatched, commits, agentControllerFactory}
}
