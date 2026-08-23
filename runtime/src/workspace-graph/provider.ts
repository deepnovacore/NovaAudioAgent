import {z} from 'zod'

import {collapsePythonWhitespace, isWellFormed, stripLikePython} from '../python-text.js'
import {normalizeNfkcPinned} from '../unicode-normalize.js'
import {isOtherCategory} from '../unicode-tables.js'
import {SensitiveContentPolicy, SensitivePathPolicy} from './sensitivity.js'

const PROVIDER_PROTOCOL = 'nova_workspace_evidence' as const
const PROVIDER_SCHEMA_VERSION = 1 as const
const PROVIDER_NAME = 'mycontext' as const
const CAPABILITIES_PATH = 'nova/workspace-evidence/capabilities'
const LOOKUP_PATH = 'nova/workspace-evidence/lookup'
const PROVIDER_TIMEOUT_MS = 1_500
const MAX_REQUEST_BYTES = 8_192
const MAX_RESPONSE_BYTES = 65_536
const MAX_RESPONSE_CHUNKS = 128
const MAX_CANDIDATES = 32
const MAX_RESULTS = 8
const MAX_QUERY_CODE_POINTS = 4_096
const MAX_QUERY_BYTES = 8_192
const MAX_TEXT_CODE_POINTS = 4_000
const MAX_TEXT_BYTES = 12_000
const MAX_SOURCE_REF_CODE_POINTS = 512
const MAX_SOURCE_REF_BYTES = 2_048
const MAX_WORKSPACE_NAME_CODE_POINTS = 239
const MAX_STABLE_ID_CODE_POINTS = 239
const MAX_OMITTED = 65_535

export type ProviderDiagnostic =
  | 'unavailable'
  | 'timeout'
  | 'protocol'
  | 'malformed'
  | 'sensitive'

export interface ProviderSourceRef {
  readonly provider: 'mycontext'
  readonly ref: string
}

export interface ProviderEvidence {
  readonly provider: 'mycontext'
  readonly source: 'provider'
  readonly trust: 'untrusted_external'
  readonly source_ref: ProviderSourceRef
  readonly occurred_at: number
  readonly confidence: number
  readonly text: string
}

export interface ProviderEnrichmentResult {
  readonly evidence: readonly ProviderEvidence[]
  readonly omitted_evidence: number
  readonly degraded: boolean
  readonly diagnostic: ProviderDiagnostic | null
}

export interface WorkspaceEvidenceLookupInput {
  readonly logical_workspace_id: string
  readonly workspace_name: string
  readonly query: string
  readonly limit: number
}

export interface PersonalContextProvider {
  lookupWorkspaceEvidence(input: WorkspaceEvidenceLookupInput): Promise<ProviderEnrichmentResult>
}

export interface MyContextProviderOptions {
  readonly base_url: string
  /** Test seam only; production uses the platform global fetch implementation. */
  readonly fetch_impl?: typeof fetch
  readonly denied_roots?: readonly string[]
}

export class MyContextProviderError extends Error {
  readonly code = 'PROVIDER_INVALID_ENDPOINT'

  constructor() {
    super('personal context provider endpoint is invalid')
    this.name = 'MyContextProviderError'
  }
}

const capabilitySchema = z.object({
  protocol: z.literal(PROVIDER_PROTOCOL),
  schema_version: z.literal(PROVIDER_SCHEMA_VERSION),
  provider: z.literal(PROVIDER_NAME),
  capabilities: z.object({
    exact_workspace_scope: z.literal(true),
    read_only: z.literal(true),
    evidence_provenance: z.literal(true),
    mutations: z.literal(false),
    actions: z.literal(false),
  }).strict(),
}).strict()

const lookupEnvelopeSchema = z.object({
  protocol: z.literal(PROVIDER_PROTOCOL),
  schema_version: z.literal(PROVIDER_SCHEMA_VERSION),
  provider: z.literal(PROVIDER_NAME),
  logical_workspace_id: z.string(),
  workspace_name: z.string(),
  evidence: z.array(z.unknown()),
}).strict()

const evidenceCandidateSchema = z.object({
  source_ref: z.string(),
  occurred_at: z.number().finite().nonnegative(),
  confidence: z.number().finite().min(0).max(1),
  text: z.string(),
}).strict()

const lookupInputSchema = z.object({
  logical_workspace_id: z.string(),
  workspace_name: z.string(),
  query: z.string(),
  limit: z.number().int().positive(),
}).strict()

class ProviderFailure extends Error {
  constructor(readonly diagnostic: ProviderDiagnostic) {
    super('personal context provider request failed')
  }
}

const emptyResults: Readonly<Record<Exclude<ProviderDiagnostic, never>, ProviderEnrichmentResult>> =
  Object.freeze({
    unavailable: emptyResult('unavailable'),
    timeout: emptyResult('timeout'),
    protocol: emptyResult('protocol'),
    malformed: emptyResult('malformed'),
    sensitive: emptyResult('sensitive'),
  })

export class MyContextProvider implements PersonalContextProvider {
  readonly #baseUrl: string
  readonly #fetch: typeof fetch
  readonly #pathPolicy: SensitivePathPolicy
  readonly #contentPolicy = new SensitiveContentPolicy()
  #capability: Promise<boolean> | null = null
  #capabilityConfirmed = false

  constructor(options: MyContextProviderOptions) {
    this.#baseUrl = validateBaseUrl(options.base_url)
    this.#fetch = options.fetch_impl ?? globalThis.fetch
    this.#pathPolicy = new SensitivePathPolicy(
      options.denied_roots === undefined ? {} : {deniedRoots: options.denied_roots},
    )
  }

  async lookupWorkspaceEvidence(input: WorkspaceEvidenceLookupInput): Promise<ProviderEnrichmentResult> {
    const admitted = admitLookupInput(input, this.#pathPolicy, this.#contentPolicy)
    if (admitted === null) return emptyResults.protocol

    // Validate again at use so endpoint construction never depends on mutable URL state.
    let endpoints: {readonly capabilities: string; readonly lookup: string}
    try {
      endpoints = endpointUrls(validateBaseUrl(this.#baseUrl))
    } catch {
      return emptyResults.unavailable
    }

    try {
      if (!this.#capabilityConfirmed) {
        if (this.#capability === null) {
          this.#capability = this.#discoverCapabilities(endpoints.capabilities)
        }
        const compatible = await this.#capability
        if (!compatible) {
          this.#capability = null
          return emptyResults.unavailable
        }
        this.#capabilityConfirmed = true
      }
      return await this.#lookup(endpoints.lookup, admitted)
    } catch (error) {
      if (!this.#capabilityConfirmed) this.#capability = null
      return emptyResults[diagnosticFor(error)]
    }
  }

  async #discoverCapabilities(url: string): Promise<boolean> {
    try {
      const value = await this.#requestJson(url, {
        method: 'GET',
        headers: {accept: 'application/json'},
      })
      return capabilitySchema.safeParse(value).success
    } catch (error) {
      if (error instanceof ProviderFailure) throw error
      throw new ProviderFailure('unavailable')
    }
  }

  async #lookup(
    url: string,
    input: Readonly<WorkspaceEvidenceLookupInput>,
  ): Promise<ProviderEnrichmentResult> {
    const body = JSON.stringify({
      protocol: PROVIDER_PROTOCOL,
      schema_version: PROVIDER_SCHEMA_VERSION,
      logical_workspace_id: input.logical_workspace_id,
      workspace_name: input.workspace_name,
      query: input.query,
      limit: input.limit,
    })
    if (utf8Length(body) > MAX_REQUEST_BYTES) return emptyResults.protocol
    const value = await this.#requestJson(url, {
      method: 'POST',
      headers: {accept: 'application/json', 'content-type': 'application/json'},
      body,
    })
    const envelope = lookupEnvelopeSchema.safeParse(value)
    if (
      !envelope.success
      || envelope.data.logical_workspace_id !== input.logical_workspace_id
      || envelope.data.workspace_name !== input.workspace_name
    ) return emptyResults.protocol

    let omitted = Math.min(
      Math.max(0, envelope.data.evidence.length - MAX_CANDIDATES),
      MAX_OMITTED,
    )
    let rejectedSensitive = false
    let rejectedMalformed = false
    const accepted: ProviderEvidence[] = []
    const seenRefs = new Set<string>()
    for (const rawCandidate of envelope.data.evidence.slice(0, MAX_CANDIDATES)) {
      if (accepted.length >= input.limit) {
        omitted = boundedIncrement(omitted)
        continue
      }
      const candidate = evidenceCandidateSchema.safeParse(rawCandidate)
      if (!candidate.success) {
        rejectedMalformed = true
        omitted = boundedIncrement(omitted)
        continue
      }
      const admitted = admitEvidenceCandidate(
        candidate.data,
        seenRefs,
        this.#pathPolicy,
        this.#contentPolicy,
      )
      if (admitted.kind === 'malformed') {
        rejectedMalformed = true
        omitted = boundedIncrement(omitted)
        continue
      }
      if (admitted.kind === 'sensitive') {
        rejectedSensitive = true
        omitted = boundedIncrement(omitted)
        continue
      }
      seenRefs.add(admitted.evidence.source_ref.ref)
      accepted.push(admitted.evidence)
    }
    const diagnostic = rejectedSensitive
      ? 'sensitive'
      : rejectedMalformed || omitted > 0 ? 'malformed' : null
    return freezeResult(accepted, omitted, diagnostic)
  }

  async #requestJson(url: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, PROVIDER_TIMEOUT_MS)
    const aborted = rejectOnAbort(controller.signal)
    try {
      let response: Response
      try {
        response = await Promise.race([
          this.#fetch(url, {
            ...init,
            redirect: 'error',
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            signal: controller.signal,
          }),
          aborted,
        ])
      } catch {
        throw new ProviderFailure(controller.signal.aborted ? 'timeout' : 'unavailable')
      }
      let ok: boolean
      let contentType: string | null
      let declaredLength: string | null
      try {
        ok = response.ok
        contentType = response.headers.get('content-type')
        declaredLength = response.headers.get('content-length')
      } catch {
        throw new ProviderFailure('malformed')
      }
      if (!ok) throw new ProviderFailure('unavailable')
      if (contentType === null || !isJsonMediaType(contentType)) {
        throw new ProviderFailure('protocol')
      }
      if (declaredLength !== null) {
        const length = Number(declaredLength)
        if (!Number.isSafeInteger(length) || length < 0 || length > MAX_RESPONSE_BYTES) {
          throw new ProviderFailure('malformed')
        }
      }
      const bytes = await readBoundedBody(response, controller)
      let text: string
      try {
        text = new TextDecoder('utf-8', {fatal: true}).decode(bytes)
      } catch {
        throw new ProviderFailure('malformed')
      }
      try {
        return JSON.parse(text) as unknown
      } catch {
        throw new ProviderFailure('malformed')
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

function emptyResult(diagnostic: ProviderDiagnostic): ProviderEnrichmentResult {
  return Object.freeze({
    evidence: Object.freeze([]),
    omitted_evidence: 0,
    degraded: true,
    diagnostic,
  })
}

function freezeResult(
  evidence: readonly ProviderEvidence[],
  omittedEvidence: number,
  diagnostic: ProviderDiagnostic | null,
): ProviderEnrichmentResult {
  const owned = evidence.map(item => Object.freeze({
    ...item,
    source_ref: Object.freeze({...item.source_ref}),
  }))
  return Object.freeze({
    evidence: Object.freeze(owned),
    omitted_evidence: Math.min(omittedEvidence, MAX_OMITTED),
    degraded: diagnostic !== null,
    diagnostic,
  })
}

function diagnosticFor(error: unknown): ProviderDiagnostic {
  return error instanceof ProviderFailure ? error.diagnostic : 'unavailable'
}

function admitLookupInput(
  input: WorkspaceEvidenceLookupInput,
  pathPolicy: SensitivePathPolicy,
  contentPolicy: SensitiveContentPolicy,
): Readonly<WorkspaceEvidenceLookupInput> | null {
  let parsed: z.infer<typeof lookupInputSchema>
  try {
    const outcome = lookupInputSchema.safeParse(input)
    if (!outcome.success) return null
    parsed = outcome.data
  } catch {
    return null
  }
  const logicalWorkspaceId = admitBoundedText(
    parsed.logical_workspace_id,
    MAX_STABLE_ID_CODE_POINTS,
    pathPolicy,
    contentPolicy,
  )
  const workspaceName = admitBoundedText(
    parsed.workspace_name,
    MAX_WORKSPACE_NAME_CODE_POINTS,
    pathPolicy,
    contentPolicy,
  )
  const query = admitBoundedText(
    parsed.query,
    MAX_QUERY_CODE_POINTS,
    pathPolicy,
    contentPolicy,
  )
  if (logicalWorkspaceId === null || workspaceName === null || query === null) return null
  if (utf8Length(query) > MAX_QUERY_BYTES) return null
  return Object.freeze({
    logical_workspace_id: logicalWorkspaceId,
    workspace_name: workspaceName,
    query,
    limit: Math.min(parsed.limit, MAX_RESULTS),
  })
}

type AdmittedEvidence =
  | {readonly kind: 'accepted'; readonly evidence: ProviderEvidence}
  | {readonly kind: 'sensitive'}
  | {readonly kind: 'malformed'}

function admitEvidenceCandidate(
  candidate: z.infer<typeof evidenceCandidateSchema>,
  seenRefs: ReadonlySet<string>,
  pathPolicy: SensitivePathPolicy,
  contentPolicy: SensitiveContentPolicy,
): AdmittedEvidence {
  if (!isWellFormed(candidate.source_ref) || !isWellFormed(candidate.text)) {
    return {kind: 'malformed'}
  }
  const normalizedRefShadow = normalizeNfkcPinned(candidate.source_ref)
  const normalizedTextShadow = normalizeNfkcPinned(candidate.text)
  const neutralized = neutralizeEvidence(candidate.text)
  if (
    codePointLength(candidate.source_ref) > MAX_SOURCE_REF_CODE_POINTS
    || utf8Length(candidate.source_ref) > MAX_SOURCE_REF_BYTES
    || stripLikePython(candidate.source_ref) !== candidate.source_ref
    || candidate.source_ref === ''
    || hasDeniedControl(candidate.source_ref)
    || containsOtherCategory(candidate.source_ref)
    || !isWellFormed(normalizedRefShadow)
    || codePointLength(normalizedRefShadow) > MAX_SOURCE_REF_CODE_POINTS
    || utf8Length(normalizedRefShadow) > MAX_SOURCE_REF_BYTES
    || stripLikePython(normalizedRefShadow) !== normalizedRefShadow
    || normalizedRefShadow === ''
    || hasDeniedControl(normalizedRefShadow)
    || containsOtherCategory(normalizedRefShadow)
    || seenRefs.has(candidate.source_ref)
    || !isWellFormed(neutralized)
    || codePointLength(neutralized) > MAX_TEXT_CODE_POINTS
    || utf8Length(neutralized) > MAX_TEXT_BYTES
    || neutralized === ''
    || hasDeniedControl(neutralized)
    || containsOtherCategory(normalizedTextShadow)
    || containsOtherCategory(neutralized)
  ) return {kind: 'malformed'}
  if (
    !isClean(candidate.source_ref, 'source_ref', pathPolicy, contentPolicy)
    || !isClean(normalizedRefShadow, 'source_ref', pathPolicy, contentPolicy)
    || hasUnsafeStructure(candidate.source_ref)
    || hasUnsafeStructure(normalizedRefShadow)
    || looksLikeInstruction(normalizedRefShadow)
    || !isClean(normalizedTextShadow, 'provider_evidence', pathPolicy, contentPolicy)
    || looksLikeInstruction(normalizedTextShadow)
    || !isClean(neutralized, 'provider_evidence', pathPolicy, contentPolicy)
    || looksLikeInstruction(neutralized)
  ) return {kind: 'sensitive'}
  return {
    kind: 'accepted',
    evidence: Object.freeze({
      provider: PROVIDER_NAME,
      source: 'provider',
      trust: 'untrusted_external',
      source_ref: Object.freeze({provider: PROVIDER_NAME, ref: candidate.source_ref}),
      occurred_at: candidate.occurred_at,
      confidence: candidate.confidence,
      text: neutralized,
    }),
  }
}

function admitBoundedText(
  value: string,
  maxCodePoints: number,
  pathPolicy: SensitivePathPolicy,
  contentPolicy: SensitiveContentPolicy,
): string | null {
  if (!isWellFormed(value)) return null
  const normalized = normalizeNfkcPinned(value)
  if (
    value === ''
    || stripLikePython(value) !== value
    || codePointLength(value) > maxCodePoints
    || hasDeniedControl(value)
    || containsOtherCategory(value)
    || !isClean(value, 'provider_input', pathPolicy, contentPolicy)
    || normalized === ''
    || stripLikePython(normalized) !== normalized
    || !isWellFormed(normalized)
    || codePointLength(normalized) > maxCodePoints
    || hasDeniedControl(normalized)
    || containsOtherCategory(normalized)
    || !isClean(normalized, 'provider_input', pathPolicy, contentPolicy)
  ) return null
  return value
}

function isClean(
  value: string,
  field: string,
  pathPolicy: SensitivePathPolicy,
  contentPolicy: SensitiveContentPolicy,
): boolean {
  return contentPolicy.scrub(field, value).kind === 'clean'
    && pathPolicy.scrubText(field, value).kind === 'clean'
}

function neutralizeEvidence(value: string): string {
  const collapsed = stripLikePython(collapsePythonWhitespace(normalizeNfkcPinned(value)))
  let output = ''
  for (const character of collapsed) {
    output += STRUCTURAL_REPLACEMENTS[character] ?? character
  }
  return output
}

const STRUCTURAL_REPLACEMENTS: Readonly<Record<string, string>> = Object.freeze({
  '<': '‹',
  '>': '›',
  '`': 'ˋ',
  '#': '＃',
  '*': '＊',
  '[': '［',
  ']': '］',
  '{': '｛',
  '}': '｝',
  '|': '│',
})

function hasUnsafeStructure(value: string): boolean {
  return /[<>`#*\[\]{}|]/u.test(value)
}

function looksLikeInstruction(value: string): boolean {
  return /\b(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system|developer|user)\s+(?:instructions?|prompts?|messages?)\b/iu.test(value)
    || /\b(?:system|assistant|developer|user)\s*:/iu.test(value)
    || /<\/?(?:system|assistant|developer|user)>|\[(?:system|assistant|developer|user)\]/iu.test(value)
    || /\b(?:please\s+)?(?:run|execute|invoke|call|use|open|delete|send|write|switch)\s+(?:the\s+)?(?:tool|command|shell|terminal|workspace|file|message|request)\b/iu.test(value)
    || /(?:(?:请|必须|务必).{0,12})?(?:执行|运行|调用|切换|删除|发送|写入)(?:工具|命令|终端|工作区|文件|消息)(?:\s|$|[。！!])/u.test(value)
}

function validateBaseUrl(value: string): string {
  if (
    typeof value !== 'string'
    || value === ''
    || value.includes('\0')
    || value.includes('%')
    || value.includes('\\')
    || /(?:^|\/)\.{1,2}(?:\/|[?#]|$)/u.test(value)
  ) {
    throw new MyContextProviderError()
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new MyContextProviderError()
  }
  const hostname = parsed.hostname
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]' && hostname !== '::1')
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
    || /%|\/\//u.test(parsed.pathname)
  ) throw new MyContextProviderError()
  const segments = parsed.pathname.split('/').filter(Boolean)
  if (segments.some(segment => segment === '.' || segment === '..' || !/^[A-Za-z0-9._~-]+$/u.test(segment))) {
    throw new MyContextProviderError()
  }
  parsed.pathname = `/${segments.join('/')}${segments.length === 0 ? '' : '/'}`
  return parsed.toString()
}

function endpointUrls(baseUrl: string): {readonly capabilities: string; readonly lookup: string} {
  const base = new URL(baseUrl)
  return Object.freeze({
    capabilities: new URL(CAPABILITIES_PATH, base).toString(),
    lookup: new URL(LOOKUP_PATH, base).toString(),
  })
}

async function readBoundedBody(response: Response, controller: AbortController): Promise<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array>
  try {
    const body = response.body
    if (body === null) throw new ProviderFailure('malformed')
    reader = body.getReader()
  } catch (error) {
    if (error instanceof ProviderFailure) throw error
    throw new ProviderFailure('malformed')
  }
  const chunks: Uint8Array[] = []
  let total = 0
  const aborted = rejectOnAbort(controller.signal)
  try {
    for (let count = 0; ; count += 1) {
      if (count >= MAX_RESPONSE_CHUNKS) throw new ProviderFailure('malformed')
      const item = await Promise.race([reader.read(), aborted])
      if (item.done) break
      if (!(item.value instanceof Uint8Array)) throw new ProviderFailure('malformed')
      total += item.value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw new ProviderFailure('malformed')
      chunks.push(item.value.slice())
    }
  } catch (error) {
    if (error instanceof ProviderFailure) throw error
    throw new ProviderFailure(controller.signal.aborted ? 'timeout' : 'malformed')
  } finally {
    try {
      const cancellation = reader.cancel()
      void cancellation.catch(() => undefined)
    } catch {
      // Owned best-effort cleanup cannot extend the hard request timeout.
    }
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new ProviderFailure('timeout'))
      return
    }
    signal.addEventListener('abort', () => {
      reject(new ProviderFailure('timeout'))
    }, {once: true})
  })
}

function isJsonMediaType(value: string): boolean {
  return /^application\/(?:[A-Za-z0-9!#$&^_.+-]+\+)?json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/iu.test(value)
}

function hasDeniedControl(value: string): boolean {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
}

function containsOtherCategory(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && isOtherCategory(codePoint)) return true
  }
  return false
}

function codePointLength(value: string): number {
  return [...value].length
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function boundedIncrement(value: number): number {
  return Math.min(value + 1, MAX_OMITTED)
}
