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

/** Denies locations that must never be discovered or represented in graph state. */
export class SensitivePathPolicy {
  private readonly deniedRoots: readonly string[]
  private readonly deniedTextRoots: readonly string[]

  constructor(options: SensitivePathPolicyOptions = {}) {
    const roots = (options.deniedRoots ?? []).filter(path => isSupportedAbsolute(path))
    this.deniedRoots = roots.map(path => normalizePath(path))
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
    let scrubbed = value
    for (const root of this.deniedTextRoots) {
      const configuredRoot = /\s/u.test(root)
        ? new RegExp(`^.*${escapeRegExp(root)}.*$`, 'gmu')
        : new RegExp(`${escapeRegExp(root)}(?:[\\/][^\\s<>"'\`()\\[\\]{},;!?]+)*`, 'gu')
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
