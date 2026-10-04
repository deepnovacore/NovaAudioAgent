import type {CommittedConversationPair} from './history.js'
import type {PromptLanguage} from './prompt-language.js'
import type {UsageReporter} from './usage.js'
import type {FrontendModuleSelection} from './frontend-instructions.js'
import type {IntegratedWireProfile} from './integrated-wire-profile.js'

/** Raised by a transport when the peer closed; mapped to a recoverable disconnect. */
export class RealtimeSocketClosedError extends Error {
  constructor(message = 'realtime socket closed') {
    super(message)
    this.name = 'RealtimeSocketClosedError'
  }
}

export interface RealtimeSocket {
  send(payload: string): Promise<void>
  /** Resolves the next text frame, or throws RealtimeSocketClosedError at EOF. */
  receive(): Promise<string>
  close(): Promise<void>
}

export interface RealtimeConnectorOptions {
  readonly binaryJson?: boolean
  readonly endpoint: string
  readonly headers: Readonly<Record<string, string>>
  readonly openTimeout: number
  readonly signal: AbortSignal
}

export type RealtimeConnector = (options: RealtimeConnectorOptions) => Promise<RealtimeSocket>

export interface RealtimeAdapterOptions {
  readonly history?:readonly CommittedConversationPair[]
  readonly language?: PromptLanguage
  readonly url: string
  readonly apiKey: string
  readonly model: string
  readonly voice: string
  readonly connector: RealtimeConnector
  readonly onUsage?: UsageReporter
  readonly idFactory?: () => string
  readonly connectTimeout?: number
  readonly itemConfirmationTimeout?: number
  readonly closeTimeout?: number
  readonly now?: () => number
  readonly executorApproval?: boolean
  readonly modules?: FrontendModuleSelection
  readonly wireProfile?: IntegratedWireProfile
}
