/**
 * Bounded Tavily Search adapter.
 *
 * Ported from `src/nova_audio_agent/executors/search.py`. Search is the always-on readonly executor:
 * the transport owns one bounded HTTP request, the adapter owns the executor contract and evidence
 * normalization, and neither writes Memory or speaks to the user.
 *
 * The reason this file is careful out of proportion to its size is that everything it returns is
 * `untrusted_external` and reaches the model as evidence. A URL that survives canonicalization is a URL
 * the agent may later be asked to trust; an evidence ref is an identifier the model cites. So the URL
 * rules refuse anything ambiguous rather than normalizing it, and the refs are content digests that
 * have to be byte-identical across both runtimes or the same search produces two different citations.
 */

import { createHash } from 'node:crypto'
import { compareCodePoints } from '../canonical-json.js'
import { pythonFloat } from '../prompting.js'
import { isOtherCategory } from '../unicode-tables.js'

const PROVIDER = 'tavily'
const ENDPOINT = 'https://api.tavily.com/search'
const HTTP_TIMEOUT_S = 8
/** A response larger than this is refused unread rather than buffered. */
const MAX_RESPONSE_BYTES = 256 * 1_024
const MAX_QUERY_CHARS = 512
const MAX_RESULTS = 5
const MAX_TITLE_CHARS = 300
const MAX_SNIPPET_CHARS = 2_000
const MAX_URL_CHARS = 2_048

/** A credential-free transport observation, normalized by the adapter. */
export class TavilyTransportFailure extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'TavilyTransportFailure'
    this.code = code
  }
}

export interface SearchTransport {
  search(query: string, options: {readonly maxResults: number}): Promise<Record<string, unknown>>
}

/** One direct, bounded Tavily `/search` request with no retries. */
export class TavilyTransport implements SearchTransport {
  readonly #apiKey: string
  readonly #fetch: typeof fetch

  constructor(apiKey: string | null, options: {readonly fetch?: typeof fetch} = {}) {
    this.#apiKey = apiKey ?? ''
    this.#fetch = options.fetch ?? globalThis.fetch
  }

  async search(
    query: string,
    options: {readonly maxResults: number},
  ): Promise<Record<string, unknown>> {
    // Reported as an authentication failure rather than attempted: a request with no key would leak
    // the query to the provider for nothing.
    if (this.#apiKey === '') throw new TavilyTransportFailure('authentication')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_S * 1_000)
    let response: Response
    try {
      response = await this.#fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          search_depth: 'basic',
          max_results: options.maxResults,
          include_answer: false,
          include_raw_content: false,
          include_images: false,
        }),
        // Never followed: a redirect from a search API is either a misconfiguration or a
        // redirect-to-attacker, and neither is worth chasing with a bearer token attached.
        redirect: 'manual',
        signal: controller.signal,
      })
    } catch (cause) {
      clearTimeout(timer)
      if (cause instanceof TavilyTransportFailure) throw cause
      if (isAbortError(cause)) throw new TavilyTransportFailure('timeout')
      throw new TavilyTransportFailure('transport')
    }

    try {
      checkStatus(response.status)
      const body = await readBounded(response, MAX_RESPONSE_BYTES)
      let value: unknown
      try {
        value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(body))
      } catch {
        throw new TavilyTransportFailure('malformed_response')
      }
      if (!isPlainObject(value)) throw new TavilyTransportFailure('malformed_response')
      return value
    } catch (cause) {
      if (cause instanceof TavilyTransportFailure) throw cause
      if (isAbortError(cause)) throw new TavilyTransportFailure('timeout')
      throw new TavilyTransportFailure('transport')
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Map a status to a credential-free code.
 *
 * The distinction that matters is between codes the adapter turns into `failed` -- meaning do not
 * retry, something is wrong with the request or the key -- and the rest, which become `unknown`.
 */
function checkStatus(status: number): void {
  if (status >= 300 && status < 400) throw new TavilyTransportFailure('redirect')
  if (status === 401 || status === 403) throw new TavilyTransportFailure('authentication')
  if (status === 429) throw new TavilyTransportFailure('rate_limited')
  if (status >= 500) throw new TavilyTransportFailure('upstream')
  if (status >= 400) throw new TavilyTransportFailure('provider_rejected')
}

/**
 * Read a response body, refusing one that grows past the bound.
 *
 * Checked per chunk rather than from `Content-Length`, which a provider need not send and an attacker
 * would not send honestly.
 */
async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  const body: ReadableStream<Uint8Array> | null = response.body
  if (body === null) return new Uint8Array()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const chunk: {
        readonly done?: boolean | undefined
        readonly value?: Uint8Array | undefined
      } = await reader.read()
      if (chunk.done === true) break
      const value = chunk.value
      if (value === undefined) continue
      total += value.length
      if (total > limit) throw new TavilyTransportFailure('response_too_large')
      chunks.push(value)
    }
  } finally {
    // Released whether or not the read completed, so an abandoned response does not hold the socket.
    reader.releaseLock()
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

export interface SearchDispatchContext {
  readonly delegate: {readonly delegate_id: string}
  readonly clock: {now(): number}
}

export interface SearchHandoff {
  readonly outcome: 'ok' | 'failed' | 'unknown'
  readonly trust: 'untrusted_external'
  readonly content: Record<string, unknown>
  readonly refs: readonly string[]
}

export interface SearchResult {
  readonly rank: number
  readonly title: string
  readonly source_label: string
  readonly snippet: string
  readonly canonical_url: string
  readonly content_digest: string
  readonly evidence_ref: string
}

export class SearchAdapter {
  readonly #transport: SearchTransport

  constructor(transport: SearchTransport) {
    this.#transport = transport
  }

  async dispatch(
    op: string,
    request: Record<string, unknown>,
    ctx: SearchDispatchContext,
  ): Promise<SearchHandoff> {
    if (op !== 'search') return failure('failed', 'unknown_op')

    const normalized = normalizeRequest(request)
    if (normalized === null) return failure('failed', 'invalid_params')
    const {query, maxResults} = normalized

    // Derived from the query and the delegate, so the same question in two different delegations gets
    // two refs -- the evidence belongs to a particular asking, not to a string.
    const queryRef = evidenceRef('query', [
      ['provider', digestString(PROVIDER)],
      ['query', digestString(query)],
      ['delegate_id', digestString(ctx.delegate.delegate_id)],
    ])

    let response: Record<string, unknown>
    try {
      response = await this.#transport.search(query, {maxResults})
    } catch (cause) {
      if (cause instanceof TavilyTransportFailure) {
        // `failed` means do not retry: the key is wrong or the request was rejected on its merits.
        // Everything else -- a timeout, a rate limit, an upstream fault -- is `unknown`, which leaves
        // the door open for the model to try again.
        const outcome = cause.code === 'authentication' || cause.code === 'provider_rejected'
          ? 'failed'
          : 'unknown'
        return failure(outcome, cause.code, {query, queryRef, fetchedAt: ctx.clock.now()})
      }
      return failure('unknown', 'adapter_exception', {
        query,
        queryRef,
        fetchedAt: ctx.clock.now(),
      })
    }

    const fetchedAt = ctx.clock.now()
    const results = normalizeResults(response.results, {queryRef, fetchedAt, maxResults})
    if (results.length === 0) {
      // A response with nothing usable in it is not a success. Reporting `ok` with no evidence would
      // tell the model the search worked and give it nothing to cite.
      return failure('unknown', 'empty_evidence', {query, queryRef, fetchedAt})
    }

    const providerRequestId = response.request_id
    return {
      outcome: 'ok',
      trust: 'untrusted_external',
      content: {
        provider: PROVIDER,
        query,
        query_ref: queryRef,
        fetched_at: fetchedAt,
        provider_request_id: typeof providerRequestId === 'string' ? providerRequestId : null,
        results,
      },
      refs: [queryRef, ...results.map(result => result.evidence_ref)],
    }
  }
}

function failure(
  outcome: 'failed' | 'unknown',
  code: string,
  extra: {
    readonly query?: string
    readonly queryRef?: string
    readonly fetchedAt?: number
  } = {},
): SearchHandoff {
  const content: Record<string, unknown> = {error: code, provider: PROVIDER}
  if (extra.query !== undefined) content.query = extra.query
  if (extra.queryRef !== undefined) content.query_ref = extra.queryRef
  if (extra.fetchedAt !== undefined) content.fetched_at = extra.fetchedAt
  return {
    outcome,
    trust: 'untrusted_external',
    content,
    refs: extra.queryRef === undefined ? [] : [extra.queryRef],
  }
}

/**
 * Accept a request, or refuse it whole.
 *
 * The key set has to match *exactly*: an extra field means the caller and this adapter disagree about
 * the contract, and guessing which fields to honour is how a stale caller gets silently different
 * behaviour.
 */
function normalizeRequest(
  request: Record<string, unknown>,
): {readonly query: string; readonly maxResults: number} | null {
  const keys = Object.keys(request)
  if (keys.length !== 2 || !keys.includes('query') || !keys.includes('k')) return null
  const rawQuery = request.query
  const rawMax = request.k
  if (typeof rawQuery !== 'string') return null
  const query = rawQuery.trim()
  if (query === '' || query.length > MAX_QUERY_CHARS) return null
  // Integer, not float, and not a boolean -- `true` is not one result.
  if (typeof rawMax !== 'number' || !Number.isInteger(rawMax)) return null
  if (rawMax < 1 || rawMax > MAX_RESULTS) return null
  return {query, maxResults: rawMax}
}

/**
 * Turn provider results into evidence, dropping anything unusable.
 *
 * Provider positions are preserved, so a skipped malformed entry leaves a gap in the ranks. That is
 * deliberate: the rank is the provider's ordering, and renumbering would claim a result was ranked
 * higher than the provider put it.
 */
function normalizeResults(
  value: unknown,
  options: {
    readonly queryRef: string
    readonly fetchedAt: number
    readonly maxResults: number
  },
): readonly SearchResult[] {
  if (!Array.isArray(value)) return []
  const results: SearchResult[] = []
  for (const [index, raw] of value.entries()) {
    if (results.length >= options.maxResults) break
    const rank = index + 1
    if (!isPlainObject(raw)) continue
    const title = boundedText(raw.title, MAX_TITLE_CHARS)
    const snippet = boundedText(raw.content, MAX_SNIPPET_CHARS)
    const canonicalUrl = canonicalizeUrl(raw.url)
    // All three or none: a result the model cannot attribute to a source is not evidence.
    if (title === '' || snippet === '' || canonicalUrl === '') continue
    const contentDigest = digest([
      ['canonical_url', digestString(canonicalUrl)],
      ['snippet', digestString(snippet)],
      ['title', digestString(title)],
    ])
    results.push({
      rank,
      title,
      source_label: sourceLabel(canonicalUrl),
      snippet,
      canonical_url: canonicalUrl,
      content_digest: contentDigest,
      evidence_ref: evidenceRef('evidence', [
        ['canonical_url', digestString(canonicalUrl)],
        ['content_digest', digestString(contentDigest)],
        // A Python `float`, so it always carries a decimal point -- even at a whole second.
        ['fetched_at', digestFloat(options.fetchedAt)],
        ['provider', digestString(PROVIDER)],
        ['query_ref', digestString(options.queryRef)],
        ['rank', digestInt(rank)],
      ]),
    })
  }
  return results
}

function boundedText(value: unknown, limit: number): string {
  // UTF-16 units, because the oracle's `[:limit]` counts what `len()` counts -- code points -- and
  // these bounds are large enough that the difference only appears for astral text, which the fixture
  // covers.
  return typeof value === 'string' ? [...value.trim()].slice(0, limit).join('') : ''
}

/**
 * Canonicalize a result URL, or refuse it.
 *
 * This is the security boundary of the module. Everything here refuses rather than repairs, because a
 * URL that arrives ambiguous and leaves unambiguous is a URL whose meaning this code chose -- and the
 * agent may later be asked to act on it.
 *
 * Userinfo is refused outright: `https://evil.com@good.com/` reads as `good.com` to a person and
 * resolves to `good.com` with credentials for `evil.com`, and no rendering of it is honest. Whitespace
 * and control characters are refused for the same reason -- they let a URL display as one thing and
 * resolve as another. Backslash, `<` and `>` are refused because browsers and parsers disagree about
 * them.
 */
function canonicalizeUrl(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.length > MAX_URL_CHARS) return ''
  for (const character of value) {
    if (character.trim() === '') return ''
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && isOtherCategory(codePoint)) return ''
  }
  if (value.includes('\\') || value.includes('<') || value.includes('>')) return ''

  // Read from the *source*, before any parser has a chance to repair it. WHATWG parsing is deliberately
  // forgiving in three ways the oracle is not, and each forgiveness is a URL whose meaning this code
  // would be choosing.
  const schemeEnd = value.indexOf('://')
  if (schemeEnd === -1) return ''
  const authorityStart = schemeEnd + 3
  const authorityEnd = findAuthorityEnd(value, authorityStart)
  const authority = value.slice(authorityStart, authorityEnd)
  // `https:///a` parses as host `a` under WHATWG and as no host at all in the oracle. An empty
  // authority is a URL with no host, whatever a lenient parser makes of the slashes.
  if (authority === '') return ''
  // `https://@good.com/` carries an *empty* userinfo, which WHATWG discards and the oracle refuses. The
  // presence of the delimiter is the signal, not what precedes it.
  if (authority.includes('@')) return ''

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return ''
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
  if (parsed.hostname === '') return ''
  if (parsed.username !== '' || parsed.password !== '') return ''
  // Dropped, not kept: a fragment is client-side only, so two results differing by one are the same
  // evidence and must digest the same.
  parsed.hash = ''
  let canonical = parsed.toString()
  // WHATWG always writes a path, so `https://example.com` comes back as `https://example.com/`. The
  // oracle preserves the absence. These are the same resource, and a citation has to spell it one way.
  if (authorityEnd === value.length && canonical.endsWith('/')) {
    canonical = canonical.slice(0, -1)
  }
  return canonical.length <= MAX_URL_CHARS ? canonical : ''
}

/**
 * What a person sees as the source. `www.` is noise in a spoken label.
 *
 * The brackets around an IPv6 host are URL syntax rather than part of the address, and the oracle's
 * `hostname` reports it without them.
 */
function sourceLabel(url: string): string {
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    return ''
  }
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1)
  return hostname.startsWith('www.') ? hostname.slice(4) : hostname
}

/** Where the authority ends: at the first `/`, `?`, or `#` after it, or at the end of the string. */
function findAuthorityEnd(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]
    if (character === '/' || character === '?' || character === '#') return index
  }
  return value.length
}

/**
 * A value in a digest body, with its JSON spelling stated rather than inferred.
 *
 * Python distinguishes `int` from `float` and `json.dumps` writes `2` and `2.0`; JavaScript has one
 * number type. An earlier version guessed from the field name -- correct for the two real shapes and
 * wrong for anything else, which is exactly the kind of rule that is right until it is silently not.
 * The spelling is now declared at the call site, where the type is actually known.
 */
export type DigestValue =
  | {readonly kind: 'string'; readonly value: string}
  | {readonly kind: 'int'; readonly value: number}
  | {readonly kind: 'float'; readonly value: number}

export const digestString = (value: string): DigestValue => ({kind: 'string', value})
export const digestInt = (value: number): DigestValue => ({kind: 'int', value})
export const digestFloat = (value: number): DigestValue => ({kind: 'float', value})

/**
 * A digest of an evidence value, byte-identical to the oracle's.
 *
 * The fields are passed as ordered pairs and sorted here, matching `sort_keys=True`. The model cites
 * the resulting refs and Memory stores them, so a one-byte difference means the same search produces
 * two different citations in the two runtimes.
 */
function digest(fields: readonly (readonly [string, DigestValue])[]): string {
  return createHash('sha256').update(renderDigestBody(fields), 'utf8').digest('hex')
}

function evidenceRef(
  kind: string,
  fields: readonly (readonly [string, DigestValue])[],
): string {
  return `web.search://${kind}/${digest(fields)}`
}

function renderDigestBody(fields: readonly (readonly [string, DigestValue])[]): string {
  const rendered = [...fields]
    .sort((left, right) => compareCodePoints(left[0], right[0]))
    .map(([key, value]) => `${JSON.stringify(key)}:${renderDigestValue(value)}`)
  return `{${rendered.join(',')}}`
}

function renderDigestValue(value: DigestValue): string {
  if (value.kind === 'string') return JSON.stringify(value.value)
  if (value.kind === 'int') {
    if (!Number.isInteger(value.value)) {
      throw new TypeError(`digest int must be an integer: ${value.value}`)
    }
    return `${value.value}`
  }
  return pythonFloat(value.value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === 'AbortError' || cause.name === 'TimeoutError')
}

/**
 * Test seams.
 *
 * The pinned surfaces are internal by design -- a caller has no reason to canonicalize a URL or build a
 * digest itself -- but they are exactly what the golden compares, and a test that reimplemented them
 * would only prove it agrees with itself.
 */
export {
  canonicalizeUrl as canonicalizeUrlForTest,
  digest as digestForTest,
  evidenceRef as evidenceRefForTest,
  normalizeRequest as normalizeRequestForTest,
  sourceLabel as sourceLabelForTest,
}
