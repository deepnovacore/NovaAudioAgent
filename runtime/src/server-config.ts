import {randomBytes} from 'node:crypto'
import {constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync} from 'node:fs'
import {isAbsolute} from 'node:path'
import type {Settings} from './config.js'
import type {ClientMedia} from './client-protocol.js'

export interface ServerConfig {readonly port: number; readonly token: string; readonly mediaMode: 'relay' | 'aoq_chat' | 'aoq_runtime'}

export class ServerConfigurationError extends Error {
  override readonly name = 'ServerConfigurationError'
}

function tokenPath(path: string | undefined): string {
  if (!path || !isAbsolute(path)) throw new ServerConfigurationError('server token file must be absolute')
  return path
}

/** Exclusive creation; rotation is an explicit stop, remove, initialize, restart operation. */
export function initializeServerToken(path: string): void {
  writeFileSync(tokenPath(path), `${randomBytes(16).toString('hex')}\n`, {flag: 'wx', mode: 0o600})
}

export function loadServerConfig(environment: NodeJS.ProcessEnv = process.env): ServerConfig {
  const mediaMode = environment.NOVA_AUDIO_AGENT_SERVER_MEDIA_MODE ?? 'relay'
  if (mediaMode !== 'relay' && mediaMode !== 'aoq_chat' && mediaMode !== 'aoq_runtime') throw new ServerConfigurationError('invalid server media mode')
  const rawPort = environment.NOVA_AUDIO_AGENT_SERVER_PORT ?? ''
  if (!/^[0-9]+$/u.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
    throw new ServerConfigurationError('server port must be an integer from 1 to 65535')
  }
  const path = tokenPath(environment.NOVA_AUDIO_AGENT_SERVER_TOKEN_FILE)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 64
      || (process.getuid !== undefined && stat.uid !== process.getuid())) {
      throw new ServerConfigurationError('server token file must be an owned regular file with mode 0600')
    }
    const token = readFileSync(fd, 'utf8').trim()
    // Keep headless configuration independent of the desktop/host-control import graph.
    if (!/^[a-f0-9]{32}$/u.test(token)) throw new ServerConfigurationError('invalid server token')
    return {port: Number(rawPort), token, mediaMode}
  } finally { closeSync(fd) }
}

/** Remote v1 advertises the fixed PCM formats of these production adapters only. */
export function validateRemoteAudioSettings(settings: Settings): void {
  if (settings.pipeline_mode === 'integrated' && settings.integrated_provider === 'qwen') return
  if (settings.pipeline_mode === 'cascaded' && settings.cascade_asr_provider === 'volcengine'
    && settings.cascade_tts_provider === 'volcengine' && settings.doubao_tts_output_sample_rate === 24_000) return
  throw new ServerConfigurationError('remote v1 requires mono PCM16 input 16000 and output 24000')
}

/** Host configuration selects the pipeline; the client never supplies a provider or endpoint. */
export function remoteClientMedia(settings: Settings): ClientMedia {
  validateRemoteAudioSettings(settings)
  return {transport: 'host_pcm_v1', path: 'relay', audio_owner: 'client', pipeline: settings.pipeline_mode}
}
