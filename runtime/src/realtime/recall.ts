/**
 * Bounded recall over the conversation Memory: which past items a model gets to see.
 *
 * Ported from `src/nova_audio_agent/realtime/recall.py`. Pure -- it reads Memory and mutates
 * nothing -- and every bound is part of the contract rather than a safety net, because the output is
 * what the model is shown. Two items scoring equally have to break the tie the same way on both
 * legs, or the two runtimes answer the same question differently.
 *
 * The scoring is lexical and deliberately crude: tokens shared between the query and an item's
 * evidence. What makes it delicate is Unicode. Tokenization runs over `NFKC` then lowercase, and
 * both stages diverge between CPython's Unicode database and the host ICU, so this module uses the
 * pinned pipeline from `unicode-normalize.ts` rather than the host's. A code point assigned after
 * the pin would otherwise tokenize differently here than in the oracle, and change which memories
 * come back.
 */

import type { z } from 'zod'
import { compareCodePoints } from '../canonical-json.js'
import { stripLikePython } from '../python-text.js'
import type { outcomeSchema, trustSchema } from '../events.js'
import {
  CONVERSATION_CHANNEL,
  makeMemoryRef,
  parseMemoryRef,
  type Memory,
  type MemoryItem,
  type MemoryRef,
} from '../memory.js'
import { normalizeAndLowerPinned } from '../unicode-normalize.js'
import { safeMemoryEvidence } from './evidence.js'

type Trust = z.infer<typeof trustSchema>
type Outcome = z.infer<typeof outcomeSchema>

export type RecallScope = 'recent' | 'any'
export type RecallMatch = 'lexical' | 'recency_fallback'
export type RecallState = 'ok' | 'empty' | 'error'

/** Per channel, in `recent` scope. Small because recency is the point of that scope. */
const RECENT_PER_CHANNEL = 5
/** The `any` scope reads the whole of Memory, so it needs a hard ceiling. */
const ANY_SCAN_LIMIT = 500
const HIT_LIMIT = 5
const MAX_QUERY_CHARS = 512

/** ASCII runs of two or more, which is what a Latin query matches on. */
const ASCII_TOKEN = /[a-z0-9]+/gu
/**
 * CJK runs, tokenized into overlapping bigrams rather than words.
 *
 * Chinese has no spaces, so a single character is too common to discriminate and a whole run is too
 * specific to match anything. Bigrams are the compromise the oracle chose.
 */
const CJK_RUN = /[㐀-䶿一-鿿豈-﫿]+/gu


/** The recall cutoff is not an accepted trusted-user conversation item. */
export class RecallOriginError extends Error {}

export interface RecallHit {
  readonly ref: MemoryRef
  readonly channel: string
  readonly ts: number
  readonly trust: Trust
  readonly outcome: Outcome | null
  readonly match: RecallMatch
  readonly evidence: string
}

export interface RecallView {
  readonly state: RecallState
  readonly scope: RecallScope
  readonly raw_scanned: number
  readonly searched_count: number
  readonly scan_truncated: boolean
  readonly hits: readonly RecallHit[]
  readonly omitted: number
}

interface Candidate {
  readonly item: MemoryItem
  readonly evidence: string
  readonly score: number
}

/** Compile a deterministic recall view without mutating Memory. */
export function compileMemoryRecall(
  memory: Memory,
  options: {
    readonly query: string
    readonly scope: RecallScope
    readonly beforeRef: MemoryRef
  },
): RecallView {
  const query = stripLikePython(options.query)
  // Code points, as Python's `len` counts: 512 astral characters are 1024 UTF-16 units, and
  // measuring those would reject a query the oracle accepts.
  const queryLength = [...query].length
  if (queryLength === 0 || queryLength > MAX_QUERY_CHARS) {
    throw new RangeError(`query must contain 1 to ${MAX_QUERY_CHARS} characters`)
  }
  if (options.scope !== 'recent' && options.scope !== 'any') {
    throw new TypeError("scope must be 'recent' or 'any'")
  }
  const cutoffSeq = conversationCutoff(memory, options.beforeRef)
  const {items: rawItems, truncated} = rawCandidates(memory, options.scope, cutoffSeq)
  const queryTokens = lexicalTokens(query)

  const candidates: Candidate[] = []
  for (const item of rawItems) {
    // An item with no safe evidence is not a candidate at all: recall may only surface what the
    // evidence layer has already judged safe to show. That layer returns null rather than an empty
    // string for everything it rejects, so null is the whole condition -- the oracle's
    // `if not evidence` reads as a falsy check but can only ever see None here.
    const evidence = safeMemoryEvidence(item)
    if (evidence === null) continue
    const itemTokens = lexicalTokens(evidence)
    let score = 0
    for (const token of queryTokens) {
      if (itemTokens.has(token)) score += 1
    }
    candidates.push({item, evidence, score})
  }

  if (candidates.length === 0) {
    return {
      state: 'empty',
      scope: options.scope,
      raw_scanned: rawItems.length,
      searched_count: 0,
      scan_truncated: truncated,
      hits: [],
      omitted: 0,
    }
  }

  const lexical = candidates.filter(candidate => candidate.score > 0)
  let ranked: Candidate[]
  let match: RecallMatch
  if (lexical.length > 0) {
    ranked = [...lexical].sort(byLexicalRank)
    match = 'lexical'
  } else {
    // Nothing matched, so the newest items are a better answer than none: the model asked about
    // something, and recent context is more likely relevant than silence.
    ranked = [...candidates].sort(byRecencyRank)
    match = 'recency_fallback'
  }

  const selected = ranked.slice(0, HIT_LIMIT)
  return {
    state: 'ok',
    scope: options.scope,
    raw_scanned: rawItems.length,
    searched_count: candidates.length,
    scan_truncated: truncated,
    hits: selected.map(candidate => ({
      // `ref` is derived from channel and sequence, as it is in the oracle, rather than stored.
      ref: makeMemoryRef(candidate.item.channel, candidate.item.seq),
      channel: candidate.item.channel,
      ts: candidate.item.ts,
      trust: candidate.item.trust,
      outcome: candidate.item.outcome ?? null,
      match,
      evidence: candidate.evidence,
    })),
    omitted: ranked.length - selected.length,
  }
}

/**
 * Encode a recall view, dropping only whole trailing hits to fit the budget.
 *
 * Whole hits, never truncated text: half an item's evidence is worse than none, because the model
 * cannot tell it was cut. The dropped ones are counted into `omitted` so the view stays honest
 * about what it is not showing.
 */
export function encodeMemoryRecall(
  view: RecallView,
  options: {readonly maxChars?: number} = {},
): string {
  const maxChars = options.maxChars ?? 3000
  // The messages here are spelled as the oracle spells them, snake_case parameter name included:
  // the golden records them, so they are part of the cross-language contract rather than wording.
  if (maxChars <= 0) throw new RangeError('max_chars must be positive')
  const hits = [...view.hits]
  let removed = 0
  for (;;) {
    const encoded = encodeRecallPayload(view, hits, removed)
    // Measured in code points, as Python's `len` is, not UTF-16 units.
    if ([...encoded].length <= maxChars) return encoded
    if (hits.length === 0) {
      throw new RangeError('max_chars is too small for the recall envelope')
    }
    hits.pop()
    removed += 1
  }
}

/**
 * The recall envelope, with keys in code-point order and no separator whitespace.
 *
 * Built by hand rather than via `canonicalJson` because the oracle uses `json.dumps` with
 * `sort_keys=True`, and this text is what a model reads: it has to be byte-identical, including the
 * key order and the absence of spaces. Verified against Python across control characters, U+007F,
 * U+00A0, U+2028, NUL, quotes, backslashes, CJK and astral characters -- identical on all of them.
 *
 * Lone surrogates are the one case where matching the oracle would be wrong. `json.dumps` with
 * `ensure_ascii=False` embeds a lone surrogate raw, producing a string that cannot be encoded as
 * UTF-8 at all, so those bytes could never reach a provider. This encoder refuses them instead.
 */
function encodeRecallPayload(
  view: RecallView,
  hits: readonly RecallHit[],
  removed: number,
): string {
  const encodedHits = hits.map(hit => {
    requireWellFormed(hit.evidence, 'evidence')
    requireWellFormed(hit.channel, 'channel')
    requireWellFormed(hit.ref, 'ref')
    const fields: readonly (readonly [string, string])[] = [
      ['channel', JSON.stringify(hit.channel)],
      ['evidence', JSON.stringify(hit.evidence)],
      ['match', JSON.stringify(hit.match)],
      ['outcome', hit.outcome === null ? 'null' : JSON.stringify(hit.outcome)],
      ['ref', JSON.stringify(hit.ref)],
      ['trust', JSON.stringify(hit.trust)],
      ['ts', encodeTimestamp(hit.ts)],
    ]
    return `{${fields.map(([key, value]) => `${JSON.stringify(key)}:${value}`).join(',')}}`
  })
  const fields: readonly (readonly [string, string])[] = [
    ['hits', `[${encodedHits.join(',')}]`],
    ['omitted', encodeCount(view.omitted + removed)],
    ['raw_scanned', encodeCount(view.raw_scanned)],
    ['scan_truncated', view.scan_truncated ? 'true' : 'false'],
    ['scope', JSON.stringify(view.scope)],
    ['searched_count', encodeCount(view.searched_count)],
    ['state', JSON.stringify(view.state)],
  ]
  return `{${fields.map(([key, value]) => `${JSON.stringify(key)}:${value}`).join(',')}}`
}

/**
 * Refuse text that cannot survive being encoded.
 *
 * A lone surrogate is not a valid scalar value, so an envelope containing one cannot be sent as
 * UTF-8. The oracle would embed it raw and fail at the transport instead; failing here names the
 * field, which is more use to a caller.
 */
function requireWellFormed(value: string, field: string): void {
  // `String.prototype.isWellFormed` is ES2024 and this project targets earlier; the regex says the
  // same thing -- a high surrogate not followed by a low one, or a low one not preceded by a high.
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
    throw new RangeError(`recall ${field} contains a lone surrogate and cannot be encoded`)
  }
}

/**
 * The range where a float's `json.dumps` spelling is reproducible in JavaScript.
 *
 * Below 1e16 Python writes positional notation and JavaScript agrees digit for digit. At and above
 * it Python switches to `1e+16` while JavaScript stays positional until 1e21, and their exponent
 * spellings differ anyway (`1e-07` versus `1e-7`). Rather than reimplement `repr`, this module
 * refuses that range: a timestamp there is a bug in the caller, not a formatting question.
 */
const MAX_REPRODUCIBLE_MAGNITUDE = 1e16

/**
 * A timestamp as `json.dumps` writes a Python float.
 *
 * `ts` is typed `float` in the oracle, so an integral value spells `1.0` there where JavaScript
 * would write `1`. The counts beside it are `int` and spell the same in both, which is why they use
 * `encodeCount` instead -- getting this backwards made every envelope differ.
 *
 * Negative zero is refused rather than encoded: Python writes `-0.0` where JavaScript writes `0`,
 * and a negative-zero timestamp has no meaning to preserve.
 */
function encodeTimestamp(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) >= MAX_REPRODUCIBLE_MAGNITUDE) {
    throw new RangeError(`recall cannot reproduce this timestamp's Python spelling: ${value}`)
  }
  if (Object.is(value, -0)) throw new RangeError('recall cannot encode a negative-zero timestamp')
  // A small magnitude can still render exponentially in JavaScript, where Python pads the exponent.
  if (String(value).includes('e')) {
    throw new RangeError(`recall cannot reproduce this timestamp's Python spelling: ${value}`)
  }
  return Number.isInteger(value) ? `${value}.0` : `${value}`
}

/** An integer count, spelled as both runtimes spell one. */
function encodeCount(value: number): string {
  if (!Number.isInteger(value)) throw new RangeError(`recall count must be an integer: ${value}`)
  return `${value}`
}

/**
 * Resolve the recall cutoff, which must be an accepted trusted-user conversation item.
 *
 * Recall answers "what happened before this turn of mine", so the cutoff has to be a real user turn
 * and not, say, an assistant message or an untrusted item -- otherwise a model could aim the cutoff
 * at content it chose and read past a boundary it does not own.
 */
function conversationCutoff(memory: Memory, beforeRef: MemoryRef): number {
  const message = 'before_ref must name an existing trusted user conversation item'
  let channel: string
  let seq: number
  try {
    ;[channel, seq] = parseMemoryRef(beforeRef)
  } catch {
    throw new RecallOriginError(message)
  }
  const conversation = memory.channels.get(CONVERSATION_CHANNEL)
  if (conversation === undefined) throw new RecallOriginError(message)
  if (channel !== CONVERSATION_CHANNEL || seq < 1 || seq > conversation.items.length) {
    throw new RecallOriginError(message)
  }
  const origin = conversation.items[seq - 1]
  if (
    origin === undefined
    || makeMemoryRef(origin.channel, origin.seq) !== beforeRef
    || origin.trust !== 'trusted_user'
  ) {
    throw new RecallOriginError(message)
  }
  return seq
}

function rawCandidates(
  memory: Memory,
  scope: RecallScope,
  cutoffSeq: number,
): {readonly items: readonly MemoryItem[]; readonly truncated: boolean} {
  if (scope === 'recent') {
    const items: MemoryItem[] = []
    for (const channel of memory.channels.values()) {
      // The cutoff item itself and everything after it are excluded: recall looks strictly before
      // the turn that asked.
      const eligible = channel.name === CONVERSATION_CHANNEL
        ? channel.items.slice(0, cutoffSeq - 1)
        : channel.items
      items.push(...eligible.slice(-RECENT_PER_CHANNEL))
    }
    return {items, truncated: false}
  }

  const items: MemoryItem[] = []
  for (const channel of memory.channels.values()) {
    for (const item of channel.items) {
      if (item.channel !== CONVERSATION_CHANNEL || item.seq < cutoffSeq) items.push(item)
    }
  }
  items.sort(byNewestRaw)
  return {items: items.slice(0, ANY_SCAN_LIMIT), truncated: items.length > ANY_SCAN_LIMIT}
}

/**
 * The tokens a piece of text matches on.
 *
 * Normalization runs through the pinned pipeline, not the host's: a code point assigned after the
 * pin would otherwise decompose or lowercase here and not in the oracle, and a query would match
 * memories the oracle would not return.
 */
function lexicalTokens(text: string): ReadonlySet<string> {
  const normalized = normalizeAndLowerPinned(text)
  const tokens = new Set<string>()
  for (const match of normalized.matchAll(ASCII_TOKEN)) {
    // Single characters are too common to discriminate.
    if (match[0].length >= 2) tokens.add(match[0])
  }
  for (const match of normalized.matchAll(CJK_RUN)) {
    const run = [...match[0]]
    // Overlapping bigrams. A one-character run contributes nothing, which is deliberate.
    for (let index = 0; index < run.length - 1; index += 1) {
      tokens.add(run.slice(index, index + 2).join(''))
    }
  }
  return tokens
}

/**
 * Newest first, then most important, then channel name, then newest sequence.
 *
 * Every tie-break has to match the oracle's tuple ordering exactly, including comparing channel
 * names by code point rather than by locale, because the selected set is what a model sees.
 */
function byNewestRaw(left: MemoryItem, right: MemoryItem): number {
  return (
    right.ts - left.ts
    || right.priority - left.priority
    || compareCodePoints(left.channel, right.channel)
    || right.seq - left.seq
  )
}

/** Best score first, then the recency ordering. Note `seq` ascends here, unlike the raw scan. */
function byLexicalRank(left: Candidate, right: Candidate): number {
  return right.score - left.score || byRecencyRank(left, right)
}

function byRecencyRank(left: Candidate, right: Candidate): number {
  return (
    right.item.ts - left.item.ts
    || right.item.priority - left.item.priority
    || compareCodePoints(left.item.channel, right.item.channel)
    || left.item.seq - right.item.seq
  )
}
