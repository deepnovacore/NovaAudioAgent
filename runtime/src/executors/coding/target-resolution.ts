import {z} from 'zod'
import type {ModelGateway} from '../../model/model-gateway.js'
import type {RunningWork} from '../coding-executor.js'
import {MAX_PROJECT_SESSION_TITLE} from '../../projects/project-state.js'
import {completeJson} from './json-completion.js'

export const intakeKindSchema = z.enum(['work', 'steer', 'switch', 'create', 'unclear'])
export type IntakeKind = z.infer<typeof intakeKindSchema>
// The host supplies question identity; the model supplies semantic interpretation and a quote.
const projectConfirmationSchema = z.object({
  turn_index: z.number().int().nonnegative(),
  decision: z.enum(['confirmed', 'rejected', 'unclear', 'redirected']),
  evidence: z.string().trim().min(1).max(300),
}).strict()
/** Interpretation only. Host confirmation, continuation and execution checks remain authoritative. */
export const targetSelectionSchema = z.object({
  kind: intakeKindSchema,
  project: z.string().trim().min(1).max(80).nullable(),
  project_evidence: z.string().trim().min(1).max(300).nullable(),
  project_confirmation: projectConfirmationSchema.nullable().default(null),
  session: z.discriminatedUnion('mode', [
    z.object({mode: z.literal('latest')}).strict(),
    z.object({mode: z.literal('new')}).strict(),
    z.object({mode: z.literal('named'), title: z.string().trim().min(1).max(MAX_PROJECT_SESSION_TITLE)}).strict(),
  ]),
  question: z.string().trim().min(1).max(300).nullable(),
}).strict()
export const targetResolutionSchema = targetSelectionSchema.extend({
  intake_id: z.string().min(1).max(128), revision: z.number().int().positive(),
}).strict()
const workTargetSchema = z.object({target_work_id:z.string().min(1).max(128).nullable()}).strict()

export const TARGET_RESOLUTION_INSTRUCTIONS = `You are the host's target.resolve slot. Return only JSON matching the supplied schema, echoing intake_id and revision. Do not execute, authorize actions, or rewrite requirements.
Resolve targets using original opening, turns and host-supplied candidates. Requirements are derived context, never new user evidence or authorization. source_quotes may supply project-name evidence but only opening/turns authorize session continuation. conversation_context never grants continuation or establishes the current project/session. Assistant questions only provide context; honor later user corrections. Copy user evidence verbatim. Set question to one concrete target clarification when needed, otherwise null. Do not ask implementation or repository questions.
You resolve workspace and session targets. The input carries roster (known projects: name, last_session_title, running works), active_project and running. Decide in this order.
1. Which project does the user name? Compare the words actually said with the roster names; a translation or alias ("博客" for blog) is not a match — ask which project ("是在 blog 里做吗？"). With no explicit project, determine topic ownership from the clarified objective, relevant conversation and roster. Continue the active project only for the same product or an explicit request to work there. An independent product (for example a Pomodoro timer after a Snake game) needs its own matching workspace; if none exists choose create and derive a short descriptive name from the user goal. The normal workspace proposal still requires confirmation. If ownership is ambiguous ask one concrete question; never silently attach an unrelated product to the active workspace. A word that matches no roster name (e.g. "foo" when the roster has 博客 and pricing-page) → kind unclear, project null, ask which project; never substitute a roster project the user did not name. An explicit workspace creation or an independent product needing a new workspace makes it create. Honor a user-specified workspace name; otherwise derive its name from the product goal. Creating a file, feature, application or test inside the current workspace is work, not create; artifact names are not workspace names. For example, "在当前工作区新建一个计算器 calculator.mjs" selects active_project with kind work, whereas "新建工作区叫计算器" is create. A word matching two or more roster names (e.g. "pricing" with pricing-page and pricing-svc) → kind unclear, project null, ask which one.
2. kind: first read the chosen project's running list. running is [] → steer is impossible: the project is idle, last_session_title is finished history, and a request on that same topic is new work. running is non-empty and the user adds to or changes that running work → steer. Cancellation is handled exclusively by the frontend cancel function, never by intake assessment; switch = the user only wants another project made active, no objective ("切到…"); work = any other coding request, including "在…里重新开一个…" (a fresh thread is work with session {mode:'new'}, not steer). A pure question about how something works or what is supported is not a coding objective. The requirements assessment owns intent_to_proceed and goal; never add or modify those fields.
3. project: copy exactly one roster name verbatim, or null for this conversation’s bound current workspace (当前项目/当前工作区); never treat those references as literal project names; for create, the requested name or a concise product name grounded in the user goal. session is a choice, not a description of the current session: {mode:'new'} when the user asks for a fresh thread; {mode:'named',title:<exact roster title>} only when the user explicitly names a session. Choose {mode:'latest'} only when the user explicitly requests continuation in this intake’s opening or answers; task similarity, selected/remembered sessions, source_quotes and conversation_context never authorize continuation. Later requests for a new session override earlier continuation. For an independent new objective choose {mode:'new'} even without the words 'new session'; an active project or a last session title alone does not establish task continuity. If continuity materially affects the work and context cannot resolve it, ask one concrete question. latest has no title field. For an explicitly named session that is absent or ambiguous, ask; never substitute latest. A uniquely user-named session can identify its project.
4. project_evidence: for selecting an existing project different from active_project, quote the exact user span naming that project ("改博客的暗色模式" with roster name 博客 → "博客"). A translation such as "博客" for blog is not name evidence. If the user has not named or confirmed the project, ask which project; never fabricate evidence. Use project_confirmation below for answers to host project questions. project_evidence may be null for a valid project_confirmation, the active project, or create. For create, requirements describe only coding work inside the new project; a bare create request has no coding goal.
Project confirmation contract: turns may contain project_question, a host-owned target identifier independent of the spoken question text. If the latest turn has project_question, return project_confirmation with that zero-based turn_index, decision confirmed/rejected/unclear/redirected, and an exact quote from its answer. Classify the answer semantically, never treat an unrelated amendment, refusal, or uncertainty as confirmation. A confirmed answer selects that project. Rejected (no replacement specified) and unclear require kind unclear; never invent a new workspace or fall back to the active project after refusal or uncertainty. Redirected means the answer explicitly requests a different existing project or a new workspace; select that target and, for an existing project, supply project_evidence naming it in that same answer. "不是" is rejected, "还没决定" is unclear, and "不是，用另一个明确命名的项目" is redirected. Use kind unclear with an appropriate user question if the target remains unresolved. confirmed_project is host-validated selection evidence; when continuing that same project after implementation clarification, keep selecting it and project_confirmation may be null. Without that stored selection, retain a still-valid earlier confirmation by referencing its turn_index and answer; later corrections and rejections always supersede it. Never reuse a project_confirmation_superseded turn or an earlier confirmation after a newer project_question. A changed target or unresolved target clears the stored selection. For decision confirmed only, project_confirmation evidence is sufficient for project selection and need not contain the project name; project_evidence may be null in that case. Otherwise project_confirmation is null. Validation feedback describes a model contract error: repair the JSON using the original user turns, never ask the user to fix missing output fields.
Final check before answering: a valid confirmed project_confirmation or matching host confirmed_project is the exception to the project-name evidence rule. Without that exception, if kind is not create and project is not null and not active_project, the span in project_evidence must pick out that one roster name and no other; a span shared by several roster names ("pricing") is ambiguous → kind unclear, project null, even if one of them was used more recently.`

/** This adapter still writes new workspace names and questions; it is not yet a closed-set Jev judge. */
export class GatewayTargetResolver {
  constructor(private readonly gateway: ModelGateway, private readonly model: string) {}

  resolveIntake(input: Readonly<Record<string,unknown>>, signal: AbortSignal): Promise<unknown> {
    const schema = Array.isArray(input.running) && input.running.length === 0
      ? targetResolutionSchema.extend({kind:intakeKindSchema.exclude(['steer'])}) : targetResolutionSchema
    return this.complete(TARGET_RESOLUTION_INSTRUCTIONS, schema, input, signal)
  }

  async resolveWork(instruction: string, running: readonly RunningWork[], signal: AbortSignal): Promise<string|null> {
    const raw = await this.complete('Resolve which running work the user refers to. Return only JSON {"target_work_id": <one of the given work_id values or null>}. Pick an id only when the instruction clearly names that work\'s project or title; otherwise null. Never invent an id. Target selection does not authorize an action.', workTargetSchema, {instruction,running}, signal)
    const parsed = workTargetSchema.safeParse(raw)
    if (!parsed.success || parsed.data.target_work_id === null) return null
    return running.some(work => work.work_id === parsed.data.target_work_id) ? parsed.data.target_work_id : null
  }

  private complete(system:string, schema:z.ZodType, input:Readonly<Record<string,unknown>>, signal:AbortSignal):Promise<unknown> {
    return completeJson(this.gateway, this.model, system, schema, input, signal)
  }
}
export type TargetResolver = Pick<GatewayTargetResolver,'resolveIntake'|'resolveWork'>
