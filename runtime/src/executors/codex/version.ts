export const MINIMUM_CODEX_VERSION = [0, 145, 0] as const

export interface AdmittedCodexVersion {
  readonly display: string
  readonly version: string
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u
const CODEX_CLI_PREFIX = 'codex-cli '

export function admitCodexCliVersion(value: unknown): AdmittedCodexVersion | null {
  if (typeof value !== 'string' || value[128] !== undefined
    || !value.startsWith(CODEX_CLI_PREFIX)) return null
  return admit(value.replace(CODEX_CLI_PREFIX, ''), value)
}

export function admitCodexVersion(value: unknown): AdmittedCodexVersion | null {
  return typeof value === 'string' && value[128] === undefined ? admit(value, value) : null
}

function admit(version: string, display: string): AdmittedCodexVersion | null {
  const match = SEMVER.exec(version)
  if (match === null || invalidNumericPrerelease(match[4])) return null
  const core = match.slice(1, 4).map(Number)
  if (!core.every(Number.isSafeInteger)) return null
  const comparison = compareCore(core, MINIMUM_CODEX_VERSION)
  if (comparison < 0 || (comparison === 0 && match[4] !== undefined)) return null
  return Object.freeze({display, version})
}

function invalidNumericPrerelease(value: string | undefined): boolean {
  return value?.split('.').some(identifier => /^\d+$/u.test(identifier)
    && identifier[1] !== undefined && identifier.startsWith('0')) ?? false
}

function compareCore(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < right.length; index += 1) {
    if (left[index]! > right[index]!) return 1
    if (left[index]! < right[index]!) return -1
  }
  return 0
}
