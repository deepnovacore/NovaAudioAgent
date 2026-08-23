import { basename, isAbsolute, normalize, relative, win32 } from 'node:path'

export type ScrubResult =
  | {readonly kind: 'clean'}
  | {readonly kind: 'redacted'; readonly value: string; readonly matches: number}
  | {readonly kind: 'rejected'}

export interface SensitivePathPolicyOptions {
  readonly deniedRoots?: readonly string[]
}

const credentialComponent = /(?:^|[._-])(?:credential|credentials|secret|secrets|password|passwd|token|tokens|api[-_]?key|private[-_]?key|key|keys)(?:$|[._-])/iu
const privateKeyComponent = /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|.+\.(?:pem|p12|pfx))$/iu
const concatenatedCredentialName = new Set([
  'accesstoken',
  'refreshtoken',
  'clientsecret',
  'apikey',
  'privatekey',
])
const credentialQueryName = new Set([
  'token',
  'secret',
  'password',
  'credential',
  'clientsecret',
  'apikey',
  'accesstoken',
  'refreshtoken',
])
const absolutePathSpan = /(?:[A-Za-z]:[\\/]|\/)[^\s<>"'`()\[\]{},;!?]+/gu
const absolutePathStart = /[A-Za-z]:[\\/]|[\\/]/gu
const absolutePathStartBoundary = /[\s<>"'`()\[\]{},;!?=:]/u
const pathCandidateBoundary = /[\s<>"'`()\[\]{},;!?\\/]/gu

/** Denies locations that must never be discovered or represented in graph state. */
export class SensitivePathPolicy {
  private readonly deniedRoots: readonly string[]
  private readonly deniedTextRoots: readonly string[]
  private readonly deniedLineRoots: readonly string[]

  constructor(options: SensitivePathPolicyOptions = {}) {
    const roots = (options.deniedRoots ?? []).filter(path => isSupportedAbsolute(path))
    this.deniedRoots = roots.map(path => normalizePath(path))
    this.deniedLineRoots = roots
      .filter(root => /\s/u.test(root))
      .map(root => normalizePath(root))
    this.deniedTextRoots = [...new Set(roots.flatMap(root => [
      root,
      root.replaceAll('\\', '/'),
      root.replaceAll('/', '\\'),
    ]))]
  }

  allows(path: string): boolean {
    if (!isSupportedAbsolute(path) || path.includes('\u0000')) return false
    if (path.split(/[\\/]+/u).some(component => isSensitiveComponent(component))) return false

    const normalized = normalizePath(path)
    return !this.deniedRoots.some(root => pathIsWithin(normalized, root))
  }

  redactLabel(path: string): string | null {
    if (!this.allows(path)) return null
    return basenameForPath(normalizePath(path))
  }

  /** Redacts denied absolute path spans embedded in otherwise safe free text. */
  scrubText(_field: string, value: string): ScrubResult {
    let matches = 0
    let scrubbed = value.replace(/^.*$/gmu, line => {
      if (!lineContainsDeniedRoot(line, this.deniedLineRoots)) return line
      matches += 1
      return '[redacted]'
    })
    for (const root of this.deniedTextRoots) {
      if (/\s/u.test(root)) continue
      const configuredRoot = new RegExp(
        `${escapeRegExp(root)}(?:[\\/][^\\s<>"'\`()\\[\\]{},;!?]+)*`,
        'gu',
      )
      scrubbed = scrubbed.replace(configuredRoot, () => {
        matches += 1
        return '[redacted]'
      })
    }
    scrubbed = scrubbed.replace(absolutePathSpan, path => {
      if (this.allows(path)) return path
      matches += 1
      return '[redacted]'
    })
    if (matches === 0) return {kind: 'clean'}
    if (!hasMeaningfulContent(scrubbed)) return {kind: 'rejected'}
    return {kind: 'redacted', value: scrubbed, matches}
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function lineContainsDeniedRoot(line: string, deniedRoots: readonly string[]): boolean {
  if (deniedRoots.length === 0) return false
  for (const candidate of boundedAbsolutePathCandidates(line)) {
    const normalized = normalizePath(candidate)
    if (deniedRoots.some(root => pathIsWithin(normalized, root))) return true
  }
  return false
}

/**
 * Emits plausible absolute-path spans without letting later text rewrite an
 * earlier path during normalization. A span never crosses the next absolute
 * path start. Because supported paths may contain spaces, every generic text
 * or component boundary is also exposed as a possible end before the complete
 * span. This keeps later traversal from erasing an already-denied prefix.
 */
function *boundedAbsolutePathCandidates(line: string): Generator<string> {
  const starts: number[] = []
  for (const match of line.matchAll(absolutePathStart)) {
    const start = match.index
    if (start > 0 && !absolutePathStartBoundary.test(line[start - 1] ?? '')) continue
    starts.push(start)
  }

  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]
    if (start === undefined) continue
    const end = starts[index + 1]
    const span = line.slice(start, end)
    for (const boundary of span.matchAll(pathCandidateBoundary)) {
      if (boundary.index > 0) yield span.slice(0, boundary.index)
    }
    yield span
  }
}

/** Removes credential-bearing spans while retaining the non-sensitive field context. */
export class SensitiveContentPolicy {
  scrub(_field: string, value: string): ScrubResult {
    let matches = 0
    let scrubbed = value

    scrubbed = scrubbed.replace(/https?:\/\/[^\s<>"']+/giu, match => {
      if (!urlCarriesCredentials(match)) return match
      matches += 1
      return '[redacted]'
    })
    scrubbed = replaceAll(scrubbed, /\b(?:proxy-)?authorization[ \t]*:[ \t]*[^\r\n]+/giu, () => {
      matches += 1
      return '[redacted]'
    })
    scrubbed = scrubbed.replace(/(\b(?:set-cookie|cookie)[ \t]*:[ \t]*)[^\r\n]+/giu, (_match, prefix: string) => {
      matches += 1
      return `${prefix}[redacted]`
    })
    scrubbed = replaceAll(scrubbed, /(?:\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token)\b|["'](?:password|passwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token)["'])\s*(?:=|:)\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, () => {
      matches += 1
      return '[redacted]'
    })
    scrubbed = replaceAll(scrubbed, /(?:密码|["']密码["'])\s*(?:=|:|：)\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gu, () => {
      matches += 1
      return '[redacted]'
    })
    scrubbed = replaceAll(scrubbed, /\b(?:sk|rk|pk|ak|xox[baprs]|ghp|github_pat)[_-][A-Za-z0-9][A-Za-z0-9_-]{11,}\b/giu, () => {
      matches += 1
      return '[redacted]'
    })
    scrubbed = replaceAll(scrubbed, /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}\b/giu, () => {
      matches += 1
      return '[redacted]'
    })
    scrubbed = replaceAll(scrubbed, /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/gu, () => {
      matches += 1
      return '[redacted]'
    })

    if (matches === 0) return {kind: 'clean'}
    if (!hasMeaningfulContent(scrubbed)) return {kind: 'rejected'}
    return {kind: 'redacted', value: scrubbed, matches}
  }
}

function isSensitiveComponent(component: string): boolean {
  const normalized = component.toLowerCase()
  return normalized.startsWith('.env')
    || normalized === '.ssh'
    || normalized === '.gnupg'
    || credentialComponent.test(normalized)
    || privateKeyComponent.test(normalized)
    || normalized.split(/[._-]+/u).some(part => concatenatedCredentialName.has(part))
}

function isSupportedAbsolute(path: string): boolean {
  return isAbsolute(path) || win32.isAbsolute(path)
}

function normalizePath(path: string): string {
  return win32.isAbsolute(path) ? win32.normalize(path) : normalize(path)
}

function basenameForPath(path: string): string {
  return win32.isAbsolute(path) ? win32.basename(path) : basename(path)
}

function pathIsWithin(candidate: string, root: string): boolean {
  const windowsPath = win32.isAbsolute(candidate) || win32.isAbsolute(root)
  const operations = windowsPath ? win32 : {isAbsolute, relative}
  const relativePath = operations.relative(root, candidate)
  const outsideRoot = relativePath === '..'
    || relativePath.startsWith('../')
    || relativePath.startsWith('..\\')
  return relativePath === '' || (!outsideRoot && !operations.isAbsolute(relativePath))
}

function urlCarriesCredentials(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.username !== '' || url.password !== '') return true
    return [...url.searchParams.keys()].some(key => {
      const normalized = key.replace(/[_-]/gu, '').toLowerCase()
      return credentialQueryName.has(normalized)
    })
  } catch {
    return false
  }
}

function replaceAll(value: string, pattern: RegExp, replacement: () => string): string {
  return value.replace(pattern, replacement)
}

function hasMeaningfulContent(value: string): boolean {
  const withoutRedactions = value
    .replaceAll('[redacted]', '')
    .replace(/\b(?:set-cookie|cookie)\s*:/giu, '')
  return /[\p{L}\p{N}]/u.test(withoutRedactions)
}

/** Keeps a scrubbed graph label schema-valid without splitting a redaction marker or code point. */
export function boundRedactedLabel(value: string, maxUtf16Units = 239): string | null {
  const redaction = '[redacted]'
  const redactionUtf16Units = 10
  const crossingRedaction = value.lastIndexOf(redaction, maxUtf16Units - 1)
  const bounded = crossingRedaction >= 0
    && crossingRedaction + redactionUtf16Units > maxUtf16Units
    ? `${truncateUtf16(value.slice(0, crossingRedaction), maxUtf16Units - redactionUtf16Units)}${redaction}`
    : truncateUtf16(value, maxUtf16Units)
  return /\S/u.test(bounded) ? bounded : null
}

function truncateUtf16(value: string, maxUnits: number): string {
  let bounded = ''
  for (const character of value) {
    if (bounded.length + character.length > maxUnits) break
    bounded += character
  }
  return bounded
}
