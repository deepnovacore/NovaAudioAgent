import {homedir} from 'node:os'

const MAX_LENGTH = 296

/** One terminal-safe line describing a startup exception, with the home directory and token-like strings removed. */
export function describeStartupError(error: unknown, home: string = homedir()): string {
  const code = error instanceof Error ? (error as {code?: unknown}).code : undefined
  const detail = error instanceof Error
    ? `${error.name}${typeof code === 'string' ? ` [${code}]` : ''}: ${error.message}`
    : typeof error
  let line = detail.replace(/[\r\n]+/gu, ' ')
  if (home.length > 1) line = line.split(home).join('~')
  line = line
    .replace(/\b(Bearer|Basic)\s+\S+/giu, '$1 <redacted>')
    .replace(/([?&](?:key|token|secret|password|api_key|access_token)=)[^\s&'"]+/giu, '$1<redacted>')
    .replace(/[A-Za-z0-9_+=-]{32,}/gu, '<redacted>')
  return line.slice(0, MAX_LENGTH)
}
