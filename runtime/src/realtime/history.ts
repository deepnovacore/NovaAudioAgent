import { z } from 'zod'
import { CONVERSATION_CHANNEL, type MemoryItem } from '../memory.js'
import {stripLikePython} from '../python-text.js'

export const MAX_PACKED_RECOVERY_CONTENT = 3900

const recoveryTurnBase = z.object({
  sequence: z.number().int().positive(),
  text: z.string().refine(value => stripLikePython(value) !== '', 'recovery text must be non-empty'),
  source: z.literal('conversation').default('conversation'),
}).strict()

const userRecoveryTurnSchema = recoveryTurnBase.extend({
  role: z.literal('user'),
  delivery: z.literal('user_final'),
  played_ms: z.null(),
  trust: z.literal('trusted_user'),
})

const assistantRecoveryTurnSchema = recoveryTurnBase.extend({
  role: z.literal('assistant'),
  delivery: z.literal('spoken'),
  played_ms: z.number().int().nonnegative().nullable(),
  trust: z.literal('trusted_system'),
})

export const recoveryTurnSchema = z.discriminatedUnion('role', [
  userRecoveryTurnSchema,
  assistantRecoveryTurnSchema,
])

export type RecoveryTurn = z.infer<typeof recoveryTurnSchema>

export function projectRecoveryTurns(
  items: readonly MemoryItem[],
  options: {readonly maxPairs: number; readonly maxChars?: number},
): readonly RecoveryTurn[] {
  const maxChars = options.maxChars ?? 3500
  if (!Number.isInteger(options.maxPairs)) throw new TypeError('maxPairs must be an integer')
  if (options.maxPairs <= 0 || maxChars <= 0) return []

  const pairs: [RecoveryTurn, RecoveryTurn][] = []
  let pendingUser: RecoveryTurn | undefined
  for (const item of items) {
    if (item.channel !== CONVERSATION_CHANNEL || item.outcome !== null) continue
    const text = item.content.text
    if (typeof text !== 'string' || stripLikePython(text) === '') continue
    if (item.trust === 'trusted_user' && !Object.hasOwn(item.content, 'delivery')) {
      pendingUser = recoveryTurnSchema.parse({
        sequence: item.seq,
        role: 'user',
        text,
        delivery: 'user_final',
        played_ms: null,
        trust: 'trusted_user',
      })
      continue
    }
    if (
      pendingUser === undefined
      || item.trust !== 'trusted_system'
      || item.content.delivery !== 'spoken'
    ) {
      if (pendingUser !== undefined && item.trust === 'trusted_system') pendingUser = undefined
      continue
    }
    const playedMs = item.content.played_ms
    const assistant = recoveryTurnSchema.parse({
      sequence: item.seq,
      role: 'assistant',
      text,
      delivery: 'spoken',
      played_ms: typeof playedMs === 'number' && Number.isInteger(playedMs) ? playedMs : null,
      trust: 'trusted_system',
    })
    pairs.push([pendingUser, assistant])
    pendingUser = undefined
  }

  const selected = pairs.slice(-options.maxPairs)
  while (selected.length > 0 && pairTextLength(selected) > maxChars) selected.shift()
  return selected.flat()
}

export function packRecoveryTurns(
  history: readonly RecoveryTurn[],
  options: {readonly maxChars?: number} = {},
): {readonly turns: readonly RecoveryTurn[]; readonly content: string} {
  const maxChars = options.maxChars ?? MAX_PACKED_RECOVERY_CONTENT
  const turns = history.map(turn => recoveryTurnSchema.parse(turn))
  while (turns.length > 0) {
    const content = JSON.stringify({
      version: 1,
      turns: turns.map(turn => ({sequence: turn.sequence, role: turn.role, text: turn.text})),
    })
    if (codePointLength(content) <= maxChars) return {turns, content}
    turns.splice(0, 2)
  }
  return {turns: [], content: ''}
}

function pairTextLength(pairs: readonly (readonly [RecoveryTurn, RecoveryTurn])[]): number {
  return pairs.reduce((total, pair) => (
    total + codePointLength(pair[0].text) + codePointLength(pair[1].text)
  ), 0)
}

function codePointLength(value: string): number {
  return [...value].length
}
