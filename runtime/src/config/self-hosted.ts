import {isIP} from 'node:net'
import {ConfigurationError} from './config.js'

/** Cleartext is confined to literal loopback; credentials never ride in URLs. */
export function selfHostedEndpoint(value: string, transport: 'http' | 'ws', name: string): string {
  const normalized = value.trim()
  let url: URL
  try { url = new URL(normalized) } catch { throw new ConfigurationError(`${name} 地址无效`) }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const loopback = host === '::1' || (isIP(host) === 4 && host.startsWith('127.'))
  const authority = normalized.split('://')[1]?.split(/[/?#]/)[0] ?? ''
  const literal = authority.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  if (!(url.protocol === `${transport}s:` || (url.protocol === `${transport}:` && loopback && isIP(literal)))
    || url.username || url.password || normalized.includes('@') || normalized.includes('?') || normalized.includes('#')) {
    throw new ConfigurationError(`${name} 必须使用 TLS；仅字面量回环地址可使用明文，且禁止 URL 凭据、查询和片段`)
  }
  return url.toString().replace(/\/$/, '')
}
