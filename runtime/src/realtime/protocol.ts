import { z } from 'zod'
import { jsonValueSchema, type JsonValue } from '../events.js'
import { MAX_PACKED_RECOVERY_CONTENT } from './history.js'

export const MAX_REALTIME_TEXT = 4_000
export const MAX_REALTIME_PCM_BYTES = 64 * 1_024

const pythonWhitespaceOnly = /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u
export const realtimeIdentifierSchema = z.string().refine(
  value => !pythonWhitespaceOnly.test(value),
  'identifier must be non-empty',
)
const epochSchema = z.number().int().positive()
const jsonObjectSchema = z.record(z.string(), jsonValueSchema)

function boundedText(allowEmpty = false): z.ZodString {
  return z.string()
    .refine(value => allowEmpty || !pythonWhitespaceOnly.test(value), 'text must be non-empty')
    .refine(value => [...value].length <= MAX_REALTIME_TEXT,
      `text exceeds ${MAX_REALTIME_TEXT} characters`)
}

export const hostItemKindSchema = z.enum([
  'progress',
  'final',
  'recovery',
  'dialogue_context',
  'tool_output',
  'workspace_context',
])

export const hostContextItemSchema = z.object({
  kind: hostItemKindSchema,
  host_item_id: realtimeIdentifierSchema,
  event_id: realtimeIdentifierSchema,
  content: boundedText(),
  call_id: realtimeIdentifierSchema.nullable().default(null),
  session_epoch: epochSchema.optional(),
  workspace_instance_id: realtimeIdentifierSchema.optional(),
  revision: z.number().int().nonnegative().optional(),
}).strict().superRefine((item, context) => {
  if (
    item.kind === 'dialogue_context'
    && [...item.content].length > MAX_PACKED_RECOVERY_CONTENT
  ) {
    context.addIssue({
      code: 'custom',
      path: ['content'],
      message: `dialogue context exceeds ${MAX_PACKED_RECOVERY_CONTENT} characters`,
    })
  }
  if (item.kind === 'tool_output' && item.call_id === null) {
    context.addIssue({code: 'custom', path: ['call_id'], message: 'tool output call_id is required'})
  } else if (item.kind !== 'tool_output' && item.call_id !== null) {
    context.addIssue({
      code: 'custom',
      path: ['call_id'],
      message: 'call_id is only valid for tool output',
    })
  }
  const workspaceContextFields = [
    item.session_epoch,
    item.workspace_instance_id,
    item.revision,
  ]
  if (item.kind === 'workspace_context') {
    for (const [index, field] of workspaceContextFields.entries()) {
      if (field === undefined) {
        context.addIssue({
          code: 'custom',
          path: [['session_epoch', 'workspace_instance_id', 'revision'][index]!],
          message: 'workspace context requires session_epoch, workspace_instance_id, and revision',
        })
      }
    }
  } else if (workspaceContextFields.some(field => field !== undefined)) {
    context.addIssue({
      code: 'custom',
      message: 'workspace context fields are only valid for workspace_context',
    })
  }
})

export type HostContextItem = z.infer<typeof hostContextItemSchema>

/**
 * A provider adapter reports one of these capabilities before it is allowed to make a
 * workspace-context item provider-visible. This is a contract declaration, not proof that a
 * specific provider implements the operation; provider-specific proof belongs at the adapter.
 */
export const workspaceContextDeliveryCapabilitySchema = z.enum([
  'replace_provider_item',
  'refresh_session',
  'unavailable',
])

/**
 * The provider-visible transition for a workspace-context revision. A previous provider item is
 * never left visible while a newer revision is accepted: it is either superseded explicitly or a
 * session refresh is recorded. `unavailable` is intentionally a non-delivery state.
 */
const workspaceContextDeliveryIdentity = {
  session_epoch: epochSchema,
  workspace_instance_id: realtimeIdentifierSchema,
  revision: z.number().int().nonnegative(),
  // The adapter must attest to the prior provider-visible state, even when it was empty.
  prior_provider_item_id: realtimeIdentifierSchema.nullable(),
}

const replaceWorkspaceContextDeliverySchema = z.object({
  capability: z.literal('replace_provider_item'),
  delivered: z.literal(true),
  ...workspaceContextDeliveryIdentity,
  provider_item_id: realtimeIdentifierSchema,
  superseded_provider_item_id: realtimeIdentifierSchema.nullable(),
}).strict().superRefine((delivery, context) => {
  if (delivery.superseded_provider_item_id !== delivery.prior_provider_item_id) {
    context.addIssue({
      code: 'custom',
      path: ['superseded_provider_item_id'],
      message: 'prior provider state must be explicitly superseded before a newer revision is visible',
    })
  }
  if (
    delivery.prior_provider_item_id !== null
    && delivery.provider_item_id === delivery.prior_provider_item_id
  ) {
    context.addIssue({
      code: 'custom',
      path: ['provider_item_id'],
      message: 'newer revision requires a distinct provider item id',
    })
  }
})

const refreshWorkspaceContextDeliverySchema = z.object({
  capability: z.literal('refresh_session'),
  delivered: z.literal(true),
  ...workspaceContextDeliveryIdentity,
  refresh_id: realtimeIdentifierSchema,
}).strict()

const unavailableWorkspaceContextDeliverySchema = z.object({
  capability: z.literal('unavailable'),
  delivered: z.literal(false),
  ...workspaceContextDeliveryIdentity,
}).strict()

export const workspaceContextDeliverySchema = z.discriminatedUnion('capability', [
  replaceWorkspaceContextDeliverySchema,
  refreshWorkspaceContextDeliverySchema,
  unavailableWorkspaceContextDeliverySchema,
])

export const workspaceContextDeliveryRecordSchema = z.object({
  item: hostContextItemSchema,
  asUserActivation: z.literal(false),
  delivery: workspaceContextDeliverySchema,
}).strict().superRefine((injection, context) => {
  if (injection.item.kind !== 'workspace_context') {
    context.addIssue({
      code: 'custom',
      path: ['item'],
      message: 'workspace context injection requires workspace_context item kind',
    })
  }
  if (
    injection.item.session_epoch !== injection.delivery.session_epoch
    || injection.item.workspace_instance_id !== injection.delivery.workspace_instance_id
    || injection.item.revision !== injection.delivery.revision
  ) context.addIssue({
    code: 'custom',
    path: ['delivery'],
    message: 'workspace context delivery proof must bind the exact session_epoch, workspace_instance_id, and revision',
  })
})

export const workspaceContextInjectionSchema = workspaceContextDeliveryRecordSchema.superRefine(
  (injection, context) => {
    if (injection.delivery.capability === 'unavailable') {
      context.addIssue({
        code: 'custom',
        path: ['delivery', 'capability'],
        message: 'workspace context is unavailable and cannot be injected',
      })
    }
  },
)

export type WorkspaceContextDeliveryCapability = z.infer<typeof workspaceContextDeliveryCapabilitySchema>
export type WorkspaceContextDelivery = z.infer<typeof workspaceContextDeliverySchema>
export type WorkspaceContextDeliveryRecord = z.infer<typeof workspaceContextDeliveryRecordSchema>

export const hostResponseKindSchema = z.enum([
  'host_fact',
  'tool_result',
  'delegation_acknowledgement',
])

export const hostResponseIntentSchema = z.object({
  kind: hostResponseKindSchema,
  item: hostContextItemSchema,
  task_summary: boundedText().nullable().default(null),
  origin_spoken: z.boolean().default(false),
}).strict().superRefine((intent, context) => {
  if (intent.item.kind === 'workspace_context') {
    context.addIssue({
      code: 'custom',
      path: ['item'],
      message: 'workspace context cannot create a response',
    })
  }
  if (intent.kind === 'host_fact' && intent.item.kind === 'tool_output') {
    context.addIssue({code: 'custom', path: ['item'], message: 'host fact cannot be tool output'})
  }
  if (intent.kind === 'host_fact' && intent.item.kind === 'dialogue_context') {
    context.addIssue({
      code: 'custom',
      path: ['item'],
      message: 'dialogue context cannot create a response',
    })
  }
  if (intent.kind === 'tool_result' && intent.item.kind !== 'tool_output') {
    context.addIssue({code: 'custom', path: ['item'], message: 'tool result requires tool output'})
  }
  if (intent.kind === 'delegation_acknowledgement') {
    if (intent.item.kind !== 'tool_output') {
      context.addIssue({
        code: 'custom',
        path: ['item'],
        message: 'delegation acknowledgement requires tool output',
      })
    }
    if (intent.task_summary === null) {
      context.addIssue({code: 'custom', path: ['task_summary'], message: 'task_summary is required'})
    }
  } else {
    if (intent.task_summary !== null) {
      context.addIssue({
        code: 'custom',
        path: ['task_summary'],
        message: 'task_summary is only valid for delegation acknowledgement',
      })
    }
    if (intent.origin_spoken) {
      context.addIssue({
        code: 'custom',
        path: ['origin_spoken'],
        message: 'origin_spoken is only valid for delegation acknowledgement',
      })
    }
  }
})

export type HostResponseIntent = z.infer<typeof hostResponseIntentSchema>

export const sessionIdentitySchema = z.object({
  epoch: epochSchema,
  provider_session_id: realtimeIdentifierSchema,
}).strict()

export const itemIdentitySchema = z.object({
  session_epoch: epochSchema,
  host_item_id: realtimeIdentifierSchema,
  provider_item_id: realtimeIdentifierSchema,
}).strict()

export type SessionIdentity = z.infer<typeof sessionIdentitySchema>
export type ItemIdentity = z.infer<typeof itemIdentitySchema>

const sessionEvent = <Kind extends z.ZodLiteral<string>, Shape extends z.ZodRawShape>(
  kind: Kind,
  shape: Shape,
) => z.object({kind, session_epoch: epochSchema, ...shape}).strict()

const itemTextShape = {
  item_id: realtimeIdentifierSchema,
  text: boundedText(true),
}

const responseTextShape = {
  response_id: realtimeIdentifierSchema,
  text: boundedText(true),
}

export const userSpeechStartedSchema = sessionEvent(z.literal('user_speech_started'), {
  speech_id: realtimeIdentifierSchema,
  provider_item_id: realtimeIdentifierSchema.nullable().default(null),
})
export const userSpeechEndedSchema = sessionEvent(z.literal('user_speech_ended'), {
  speech_id: realtimeIdentifierSchema,
  provider_item_id: realtimeIdentifierSchema.nullable().default(null),
})
export const userTranscriptDeltaSchema = sessionEvent(
  z.literal('user_transcript_delta'),
  itemTextShape,
)
export const userTranscriptFailedSchema = sessionEvent(z.literal('user_transcript_failed'), {
  item_id: realtimeIdentifierSchema,
})
export const userTranscriptFinalSchema = sessionEvent(
  z.literal('user_transcript_final'),
  itemTextShape,
)
export const responseStartedSchema = sessionEvent(z.literal('response_started'), {
  response_id: realtimeIdentifierSchema,
})
/**
 * Inbound provider audio is bounded by alignment, not by size.
 *
 * `ResponseAudioDelta.__post_init__` requires only non-empty PCM16 alignment, and the playback
 * registry is built for larger deltas: it splits one into `MAX_PLAYBACK_FRAME_BYTES` frames. A
 * size bound here would make that split unreachable from the provider path and would refuse audio
 * the oracle accepts -- narrowing the accepted domain on one leg only. `MAX_REALTIME_PCM_BYTES`
 * still bounds what we *send*, which is a different direction with its own reason.
 */
export const responseAudioDeltaSchema = sessionEvent(z.literal('response_audio_delta'), {
  response_id: realtimeIdentifierSchema,
  pcm: z.instanceof(Uint8Array)
    .refine(value => value.byteLength > 0 && value.byteLength % 2 === 0,
      'pcm must be non-empty aligned PCM16 bytes'),
})
export const responseTranscriptDeltaSchema = sessionEvent(
  z.literal('response_transcript_delta'),
  responseTextShape,
)
export const responseTranscriptFinalSchema = sessionEvent(
  z.literal('response_transcript_final'),
  responseTextShape,
)
export const toolCallReadySchema = sessionEvent(z.literal('tool_call_ready'), {
  call_id: realtimeIdentifierSchema,
  item_id: realtimeIdentifierSchema,
  name: realtimeIdentifierSchema,
  arguments: jsonObjectSchema,
  response_id: realtimeIdentifierSchema.nullable().default(null),
})
export const itemConfirmedSchema = sessionEvent(z.literal('item_confirmed'), {
  host_item_id: realtimeIdentifierSchema,
  provider_item_id: realtimeIdentifierSchema,
})
export const responseTerminalSchema = sessionEvent(z.literal('response_terminal'), {
  response_id: realtimeIdentifierSchema,
  status: z.enum(['completed', 'cancelled', 'failed']),
  reason: boundedText(),
})
export const responseCancelRejectedSchema = sessionEvent(z.literal('response_cancel_rejected'), {
  response_id: realtimeIdentifierSchema,
  cancel_request_id: realtimeIdentifierSchema,
  reason: z.literal('no_active_response'),
})
export const providerErrorEventSchema = sessionEvent(z.literal('provider_error'), {
  code: realtimeIdentifierSchema,
  recoverable: z.boolean().default(false),
})

export const realtimeProviderEventSchema = z.discriminatedUnion('kind', [
  userSpeechStartedSchema,
  userSpeechEndedSchema,
  userTranscriptDeltaSchema,
  userTranscriptFailedSchema,
  userTranscriptFinalSchema,
  responseStartedSchema,
  responseAudioDeltaSchema,
  responseTranscriptDeltaSchema,
  responseTranscriptFinalSchema,
  toolCallReadySchema,
  itemConfirmedSchema,
  responseTerminalSchema,
  responseCancelRejectedSchema,
  providerErrorEventSchema,
])

export type RealtimeProviderEvent = z.infer<typeof realtimeProviderEventSchema>
export type JsonObject = Readonly<Record<string, JsonValue>>

export interface RealtimeProvider {
  connect(options: {
    readonly tools: readonly JsonObject[]
    readonly signal: AbortSignal
  }): Promise<unknown>
  sendAudio(pcm: Uint8Array, signal: AbortSignal): Promise<void>
  injectHostItem(
    item: HostContextItem,
    options: {
      readonly confirmationTimeout: number | null
      readonly asUserActivation: boolean
      readonly signal: AbortSignal
    },
  ): Promise<unknown>
  injectWorkspaceContext?(
    item: HostContextItem,
    options: {
      readonly confirmationTimeout: number | null
      readonly signal: AbortSignal
    },
  ): Promise<unknown>
  createResponse(intent: HostResponseIntent, signal: AbortSignal): Promise<void>
  cancelResponse(responseId: string, signal: AbortSignal): Promise<void>
  events(signal: AbortSignal): AsyncIterable<unknown>
  close(): Promise<void>
}

export class RealtimeProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RealtimeProtocolError'
  }
}

export class ItemDeliveryUncertainError extends Error {
  readonly session_epoch: number
  readonly host_item_id: string
  readonly provider_item_id: string
  readonly item_kind: z.infer<typeof hostItemKindSchema>

  constructor(input: {
    readonly session_epoch: number
    readonly host_item_id: string
    readonly provider_item_id: string
    readonly item_kind: z.infer<typeof hostItemKindSchema>
  }) {
    super('host item confirmation timed out; delivery is uncertain')
    const identity = itemIdentitySchema.parse({
      session_epoch: input.session_epoch,
      host_item_id: input.host_item_id,
      provider_item_id: input.provider_item_id,
    })
    this.name = 'ItemDeliveryUncertainError'
    this.session_epoch = identity.session_epoch
    this.host_item_id = identity.host_item_id
    this.provider_item_id = identity.provider_item_id
    this.item_kind = hostItemKindSchema.parse(input.item_kind)
  }
}

export function hostFact(item: HostContextItem): HostResponseIntent {
  return hostResponseIntentSchema.parse({kind: 'host_fact', item})
}

export function toolResult(item: HostContextItem): HostResponseIntent {
  return hostResponseIntentSchema.parse({kind: 'tool_result', item})
}

export function delegationAcknowledgement(
  item: HostContextItem,
  taskSummary: string,
  originSpoken = false,
): HostResponseIntent {
  return hostResponseIntentSchema.parse({
    kind: 'delegation_acknowledgement',
    item,
    task_summary: taskSummary,
    origin_spoken: originSpoken,
  })
}
