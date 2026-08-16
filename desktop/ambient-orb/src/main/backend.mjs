const MAX_READINESS_BYTES = 4096

export function backendLaunchSpec({ python, workspace, token, parentEnv }) {
  if (typeof python !== 'string' || !python) throw new Error('python is required')
  if (typeof workspace !== 'string' || !workspace) throw new Error('workspace is required')
  if (!/^[a-f0-9]{32}$/.test(token)) throw new Error('128-bit token is required')
  return {
    command: python,
    argv: ['-m', 'nova_audio_agent.realtime.desktop'],
    env: {
      ...parentEnv,
      NOVA_AUDIO_AGENT_DESKTOP_TOKEN: token,
      NOVA_AUDIO_AGENT_DESKTOP_READY_FD: '3',
      NOVA_AUDIO_AGENT_CODEX_WORKSPACE: workspace,
      NOVA_AUDIO_AGENT_EXECUTOR: 'codex',
    },
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  }
}

export function parseReadiness(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_READINESS_BYTES) {
    throw new Error('desktop readiness is too large')
  }
  let value
  try {
    value = JSON.parse(raw.trim())
  } catch {
    throw new Error('desktop readiness is invalid')
  }
  if (
    !value
    || typeof value !== 'object'
    || Object.keys(value).sort().join(',') !== 'host,port'
  ) {
    throw new Error('desktop readiness fields are invalid')
  }
  if (value.host !== '127.0.0.1') throw new Error('desktop readiness must use loopback')
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
    throw new Error('desktop readiness port is invalid')
  }
  return Object.freeze({ endpoint: `ws://127.0.0.1:${value.port}/` })
}

async function collectReadiness(stream) {
  let buffer = ''
  for await (const chunk of stream) {
    buffer += chunk.toString('utf8')
    if (Buffer.byteLength(buffer) > MAX_READINESS_BYTES) {
      throw new Error('desktop readiness is too large')
    }
    const newline = buffer.indexOf('\n')
    if (newline >= 0) return parseReadiness(buffer.slice(0, newline + 1))
  }
  throw new Error('desktop backend exited before readiness')
}

export async function readReadiness(stream, {
  timeoutMs = 15_000,
  onTimeout = () => {},
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('desktop readiness timeout is invalid')
  }
  let timer
  try {
    return await Promise.race([
      collectReadiness(stream),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout()
          reject(new Error('desktop readiness timed out'))
        }, timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
