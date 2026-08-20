/**
 * The Node leg of the Search parity suite.
 *
 * Everything Search returns is `untrusted_external` and reaches the model as evidence, which is why
 * both pinned surfaces matter more than the module's size suggests.
 *
 * URL canonicalization decides which links become citable sources. Most of the cases are refusals,
 * because a URL that arrives ambiguous and leaves unambiguous is one whose meaning this code chose.
 *
 * Evidence refs are SHA-256 digests over a canonical body. The model cites them and Memory stores them,
 * so one differing byte means the same search yields two different citations. The body carries a Python
 * `float` beside a Python `int`, spelled `2.0` and `2` — the likeliest place for the two runtimes to
 * disagree, so whole, fractional, and exponent-form timestamps are all pinned.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { canonicalJson } from '../src/canonical-json.js'
import {
  SearchAdapter,
  TavilyTransport,
  TavilyTransportFailure,
  digestFloat,
  digestInt,
  digestString,
  type DigestValue,
  canonicalizeUrlForTest,
  digestForTest,
  evidenceRefForTest,
  normalizeRequestForTest,
  sourceLabelForTest,
  type SearchTransport,
} from '../src/executors/search.js'

const fixtureRoot = resolve(import.meta.dirname, '../../../fixtures/executors/search/v1')

interface Case {
  readonly name: string
  readonly kind: string
  readonly value?: unknown
  readonly fields?: readonly {
    readonly key: string
    readonly kind: string
    readonly value: unknown
  }[]
  readonly request?: Record<string, unknown>
  readonly ref_kind?: string
  readonly op?: string
  readonly now?: number
  readonly delegate_id?: string
  readonly response?: Record<string, unknown>
  readonly transport_failure?: string
  readonly transport_raises?: boolean
}

const document = JSON.parse(readFileSync(resolve(fixtureRoot, 'cases.json'), 'utf8')) as {
  readonly cases: readonly Case[]
}
const golden = JSON.parse(readFileSync(resolve(fixtureRoot, 'cases-expected.json'), 'utf8')) as {
  readonly cases: readonly Record<string, unknown>[]
}

/**
 * Turn the fixture's declared fields into digest pairs.
 *
 * Each field states its JSON spelling, because a shared fixture cannot carry the difference between a
 * Python `int` and a `float` -- both reach JavaScript as the same number, and the whole point of these
 * cases is that they hash differently.
 */
function digestFields(
  name: string,
  fields: readonly {readonly key: string; readonly kind: string; readonly value: unknown}[],
): readonly (readonly [string, DigestValue])[] {
  return fields.map(field => {
    if (field.kind === 'string') return [field.key, digestString(field.value as string)] as const
    if (field.kind === 'int') return [field.key, digestInt(field.value as number)] as const
    if (field.kind === 'float') return [field.key, digestFloat(field.value as number)] as const
    throw new Error(`${name}: unsupported digest kind ${field.kind}`)
  })
}

class ScriptedTransport implements SearchTransport {
  constructor(private readonly spec: Case) {}

  search(): Promise<Record<string, unknown>> {
    if (this.spec.transport_failure !== undefined) {
      return Promise.reject(new TavilyTransportFailure(this.spec.transport_failure))
    }
    if (this.spec.transport_raises === true) {
      return Promise.reject(new Error('adapter boundary'))
    }
    return Promise.resolve(this.spec.response ?? {})
  }
}

async function runCase(spec: Case): Promise<Record<string, unknown>> {
  switch (spec.kind) {
    case 'canonical_url':
      return {url: canonicalizeUrlForTest(spec.value)}
    case 'source_label':
      return {label: sourceLabelForTest(spec.value as string)}
    case 'normalize_request': {
      const normalized = normalizeRequestForTest(spec.request!)
      return {
        normalized: normalized === null
          ? null
          : {query: normalized.query, k: normalized.maxResults},
      }
    }
    case 'digest': {
      const fields = digestFields(spec.name, spec.fields ?? [])
      return {
        digest: digestForTest(fields),
        ref: evidenceRefForTest(spec.ref_kind ?? 'evidence', fields),
      }
    }
    case 'dispatch': {
      const adapter = new SearchAdapter(new ScriptedTransport(spec))
      const handoff = await adapter.dispatch(
        spec.op ?? 'search',
        {...(spec.request ?? {query: 'q', k: 3})},
        {
          delegate: {delegate_id: spec.delegate_id ?? 'd-1'},
          clock: {now: () => spec.now ?? 1},
        },
      )
      return {
        outcome: handoff.outcome,
        trust: handoff.trust,
        content: handoff.content,
        refs: [...handoff.refs],
      }
    }
    default:
      throw new Error(`unsupported case kind: ${spec.kind}`)
  }
}

test('every search case matches the Python-exported golden', async () => {
  const divergent: string[] = []
  for (const [index, spec] of document.cases.entries()) {
    const actual = {name: spec.name, ...await runCase(spec)}
    const expected = golden.cases[index]
    if (canonicalJson(actual) !== canonicalJson(expected)) {
      divergent.push(
        `${spec.name}\n    python: ${canonicalJson(expected)}\n    node:   ${canonicalJson(actual)}`,
      )
    }
  }
  assert.deepEqual(divergent, [], 'search behaviour differs from the oracle')
})

test('the golden records one result per case, in order', () => {
  assert.deepEqual(
    golden.cases.map(entry => entry.name),
    document.cases.map(spec => spec.name),
  )
})

test('the URL set refuses more than it accepts, which is the point', () => {
  // Canonicalization is a security boundary, not a formatter. A set that mostly accepted would pass
  // with every refusal deleted.
  const urlCases = golden.cases.filter(entry => 'url' in entry)
  const refused = urlCases.filter(entry => entry.url === '').length
  assert.ok(refused >= 20, `only ${refused} refusals`)
  assert.ok(urlCases.length - refused >= 15, 'and enough acceptances to prove it is not refusing all')
})

test('userinfo is refused however it is spelled', () => {
  // `https://evil.com@good.com/` reads as `good.com` to a person and carries credentials for
  // `evil.com`. There is no honest rendering, so it is refused rather than normalized.
  for (const value of [
    'https://evil.com@good.com/',
    'https://user:pass@good.com/',
    'https://@good.com/',
    'https://user@good.com:443/x',
    'https://user%40a@good.com/',
  ]) {
    assert.equal(canonicalizeUrlForTest(value), '', value)
  }
})

test('a dispatch that succeeds cites every result it returns', async () => {
  // The refs are what the model may cite. A result present in the content but absent from the refs
  // would be evidence the agent is not allowed to point at.
  const adapter = new SearchAdapter(new ScriptedTransport({
    name: 'inline',
    kind: 'dispatch',
    response: {
      results: [
        {title: 'A', content: 'a body', url: 'https://a.example.com/'},
        {title: 'B', content: 'b body', url: 'https://b.example.com/'},
      ],
    },
  }))
  const handoff = await adapter.dispatch('search', {query: 'q', k: 2}, {
    delegate: {delegate_id: 'd-1'},
    clock: {now: () => 5},
  })
  assert.equal(handoff.outcome, 'ok')
  const results = handoff.content.results as readonly {readonly evidence_ref: string}[]
  assert.equal(handoff.refs.length, results.length + 1, 'the query ref plus one per result')
  for (const result of results) {
    assert.ok(handoff.refs.includes(result.evidence_ref), result.evidence_ref)
  }
})

test('a failure carries no provider detail beyond a code', async () => {
  // The content reaches the model. A provider message could carry a key, a URL, or an internal
  // identifier, so only the normalized code crosses.
  for (const code of ['authentication', 'rate_limited', 'upstream', 'timeout']) {
    const adapter = new SearchAdapter(new ScriptedTransport({
      name: 'inline',
      kind: 'dispatch',
      transport_failure: code,
    }))
    const handoff = await adapter.dispatch('search', {query: 'q', k: 1}, {
      delegate: {delegate_id: 'd-1'},
      clock: {now: () => 1},
    })
    assert.equal(handoff.content.error, code)
    assert.equal(handoff.trust, 'untrusted_external')
    assert.deepEqual(
      Object.keys(handoff.content).sort(),
      ['error', 'fetched_at', 'provider', 'query', 'query_ref'],
      'and nothing else',
    )
  }
})

test('an authentication failure does not retry, and a timeout does', async () => {
  // `failed` tells the runtime not to try again; `unknown` leaves the door open. Confusing the two
  // either wastes calls against a bad key or gives up on a transient fault.
  const outcomes = new Map<string, string>()
  for (const code of ['authentication', 'provider_rejected', 'timeout', 'rate_limited', 'upstream']) {
    const adapter = new SearchAdapter(new ScriptedTransport({
      name: 'inline',
      kind: 'dispatch',
      transport_failure: code,
    }))
    const handoff = await adapter.dispatch('search', {query: 'q', k: 1}, {
      delegate: {delegate_id: 'd-1'},
      clock: {now: () => 1},
    })
    outcomes.set(code, handoff.outcome)
  }
  assert.equal(outcomes.get('authentication'), 'failed')
  assert.equal(outcomes.get('provider_rejected'), 'failed')
  assert.equal(outcomes.get('timeout'), 'unknown')
  assert.equal(outcomes.get('rate_limited'), 'unknown')
  assert.equal(outcomes.get('upstream'), 'unknown')
})

test('a whole-second timestamp still digests as a float', () => {
  // The single likeliest divergence in this module: `fetched_at` is a Python float, so `json.dumps`
  // writes `2.0` where JavaScript would write `2`. Every evidence ref carries it.
  const whole = digestForTest([['fetched_at', digestFloat(2)], ['rank', digestInt(1)]])
  const fractional = digestForTest([['fetched_at', digestFloat(2.5)], ['rank', digestInt(1)]])
  assert.notEqual(whole, fractional)
  // The same key and the same value, spelled two ways, must not collide.
  assert.notEqual(
    digestForTest([['v', digestInt(1)]]),
    digestForTest([['v', digestFloat(1)]]),
    'an int and a float of the same value hash differently, as json.dumps writes them differently',
  )
})

test('a float k is accepted here and refused by the oracle, which is a chain gap not a local one', () => {
  // Python's `isinstance(k, int)` refuses a `3.0` that arrived as a JSON float; JavaScript cannot tell
  // it from `3` once parsed. The literal is only visible at the boundary where the provider's tool-call
  // arguments are parsed, which is several layers above this one — so this states the current
  // behaviour rather than pretending the adapter can close it. The backlog carries the gap.
  assert.deepEqual(
    normalizeRequestForTest({query: 'hello', k: 3}),
    {query: 'hello', maxResults: 3},
  )
  // A *fractional* k is refused by both, because that survives the parse.
  assert.equal(normalizeRequestForTest({query: 'hello', k: 3.5}), null)
  // And a boolean is refused by both: `true` is not one result.
  assert.equal(normalizeRequestForTest({query: 'hello', k: true}), null)
})

test('an empty authority and an empty userinfo are read from the source, not the parse', () => {
  // WHATWG parsing repairs both — `https:///a` becomes host `a`, and `https://@good.com/` loses its
  // empty userinfo — and each repair is a URL whose meaning this code would be choosing.
  assert.equal(canonicalizeUrlForTest('https:///a'), '')
  assert.equal(canonicalizeUrlForTest('https://@good.com/'), '')
  // The path-less form keeps its shape, matching the oracle rather than the parser.
  assert.equal(canonicalizeUrlForTest('https://example.com'), 'https://example.com')
  assert.equal(canonicalizeUrlForTest('https://example.com/'), 'https://example.com/')
  assert.equal(canonicalizeUrlForTest('https://example.com?q=1'), 'https://example.com/?q=1')
})

/**
 * The transport.
 *
 * Not in the shared golden — a fixture that stubbed the provider would be measuring the stub — but the
 * mapping from an HTTP outcome to a credential-free code *is* behaviour: it decides whether the runtime
 * retries, and what reaches the model when it does not.
 */
function stubFetch(response: {
  readonly status?: number
  readonly body?: string
  readonly bytes?: Uint8Array
  readonly reject?: Error
}): typeof fetch {
  return (): Promise<Response> => {
    if (response.reject !== undefined) return Promise.reject(response.reject)
    const payload = response.bytes ?? new TextEncoder().encode(response.body ?? '{}')
    return Promise.resolve(new Response(payload, {status: response.status ?? 200}))
  }
}

async function transportCode(
  transport: TavilyTransport,
  query = 'q',
): Promise<string> {
  try {
    await transport.search(query, {maxResults: 1})
    return 'ok'
  } catch (cause) {
    return cause instanceof TavilyTransportFailure ? cause.code : `unexpected:${String(cause)}`
  }
}

test('a missing key fails before the query leaves the process', async () => {
  // Attempting the request would hand the provider the user's question for nothing.
  let called = false
  const transport = new TavilyTransport('', {
    fetch: (() => {
      called = true
      return Promise.resolve(new Response('{}'))
    }) as unknown as typeof fetch,
  })
  assert.equal(await transportCode(transport), 'authentication')
  assert.equal(called, false, 'and the query never reached the network')
})

test('each HTTP status maps to the code the adapter keys its outcome on', async () => {
  for (const [status, code] of [
    [200, 'ok'],
    [301, 'redirect'],
    [302, 'redirect'],
    [401, 'authentication'],
    [403, 'authentication'],
    [429, 'rate_limited'],
    [400, 'provider_rejected'],
    [404, 'provider_rejected'],
    [418, 'provider_rejected'],
    [500, 'upstream'],
    [503, 'upstream'],
  ] as const) {
    const transport = new TavilyTransport('key', {fetch: stubFetch({status})})
    assert.equal(await transportCode(transport), code, `status ${status}`)
  }
})

test('a redirect is never followed, whatever the status says', async () => {
  // A redirect from a search API is either a misconfiguration or a redirect-to-attacker, and the
  // request carries a bearer token.
  let requestInit: RequestInit | undefined
  const transport = new TavilyTransport('key', {
    fetch: ((_url: string, init: RequestInit) => {
      requestInit = init
      return Promise.resolve(new Response('{}', {status: 200}))
    }) as unknown as typeof fetch,
  })
  await transportCode(transport)
  assert.equal(requestInit?.redirect, 'manual', 'the fetch is told not to follow')
})

test('a response larger than the bound is refused rather than buffered', async () => {
  // Checked per chunk, not from Content-Length, which a provider need not send and an attacker would
  // not send honestly.
  const oversized = new Uint8Array(256 * 1_024 + 1)
  oversized.fill(0x20)
  const transport = new TavilyTransport('key', {fetch: stubFetch({bytes: oversized})})
  assert.equal(await transportCode(transport), 'response_too_large')
})

test('a malformed or non-object body is refused', async () => {
  for (const body of ['not json', '[1,2]', '"a string"', '42', 'null']) {
    const transport = new TavilyTransport('key', {fetch: stubFetch({body})})
    assert.equal(await transportCode(transport), 'malformed_response', body)
  }
  const valid = new TavilyTransport('key', {fetch: stubFetch({body: '{"results":[]}'})})
  assert.equal(await transportCode(valid), 'ok')
})

test('a network failure and an abort are distinguished', async () => {
  const network = new TavilyTransport('key', {
    fetch: stubFetch({reject: new TypeError('fetch failed')}),
  })
  assert.equal(await transportCode(network), 'transport')

  const aborted = new Error('aborted')
  aborted.name = 'AbortError'
  const timedOut = new TavilyTransport('key', {fetch: stubFetch({reject: aborted})})
  assert.equal(await transportCode(timedOut), 'timeout')
})

test('the request carries the key as a bearer token and asks for nothing extra', async () => {
  // `include_raw_content` and `include_images` would pull far more untrusted content across the
  // boundary than the evidence shape needs.
  let init: RequestInit | undefined
  const transport = new TavilyTransport('secret-key', {
    fetch: ((_url: string, options: RequestInit) => {
      init = options
      return Promise.resolve(new Response('{"results":[]}'))
    }) as unknown as typeof fetch,
  })
  await transport.search('hello', {maxResults: 4})
  const headers = init?.headers as Record<string, string>
  assert.equal(headers.Authorization, 'Bearer secret-key')
  const rawBody = init?.body
  assert.equal(typeof rawBody, 'string', 'the body is JSON text')
  const body = JSON.parse(rawBody as string) as Record<string, unknown>
  assert.deepEqual(body, {
    query: 'hello',
    search_depth: 'basic',
    max_results: 4,
    include_answer: false,
    include_raw_content: false,
    include_images: false,
  })
})
