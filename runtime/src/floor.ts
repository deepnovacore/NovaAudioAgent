import { z } from 'zod'

export const floorStateSchema = z.enum(['idle', 'user_speaking', 'agent_speaking'])
export const floorDecisionSchema = z.enum(['allow', 'preempt', 'defer'])

export type FloorState = z.infer<typeof floorStateSchema>
export type FloorDecision = z.infer<typeof floorDecisionSchema>

export class Floor {
  readonly state: FloorState
  readonly utteranceId: string | null
  readonly priority: number | null
  readonly userSpeechId: string | null

  constructor(options: {
    readonly state?: FloorState
    readonly utteranceId?: string | null
    readonly priority?: number | null
    readonly userSpeechId?: string | null
  } = {}) {
    this.state = options.state ?? 'idle'
    this.utteranceId = options.utteranceId ?? null
    this.priority = options.priority ?? null
    this.userSpeechId = options.userSpeechId ?? null
  }

  decide(priority: number): FloorDecision {
    if (!Number.isInteger(priority)) throw new TypeError('floor priority must be an integer')
    if (this.state === 'idle') return 'allow'
    if (this.state === 'user_speaking') return 'defer'
    return priority > (this.priority ?? 0) ? 'preempt' : 'defer'
  }

  onSpeakStart(utteranceId: string, priority: number): Floor {
    return new Floor({state: 'agent_speaking', utteranceId, priority})
  }

  onSpeakEnd(utteranceId: string): Floor {
    if (this.state === 'user_speaking') return this
    if (this.state === 'agent_speaking' && utteranceId !== this.utteranceId) return this
    return new Floor()
  }

  onUserSpeakStart(speechId: string): Floor {
    return new Floor({state: 'user_speaking', userSpeechId: speechId})
  }

  onUserSpeakEnd(speechId: string): Floor {
    if (this.state !== 'user_speaking' || speechId !== this.userSpeechId) return this
    return new Floor()
  }
}
