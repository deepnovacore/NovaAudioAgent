/** Mac pairing window. The host token travels only over stdin and a loopback socket. */
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {loadServerConfig} from '../dist/src/server-config.js'
import {pairingEndpoint} from '../dist/src/client-pairing.js'

try {
  if (process.platform !== 'darwin' || process.argv.length !== 3) throw new Error()
  const config = loadServerConfig()
  const server = pairingEndpoint(process.argv[2])
  const child = spawn('/usr/bin/swift', [fileURLToPath(new URL('./pair-device.swift', import.meta.url))],
    {stdio: ['pipe', 'inherit', 'inherit']})
  child.stdin.on('error', () => { /* Child exit reports failure without printing input. */ })
  child.stdin.end(JSON.stringify({port: config.port, token: config.token, server}))
  child.on('error', () => { console.error('无法打开配对窗口，请确认已安装 Xcode Command Line Tools。'); process.exitCode = 1 })
  child.on('exit', code => { process.exitCode = code ?? 1 })
} catch {
  console.error('用法：npm run server:pair --workspace @nova-audio-agent/runtime -- wss://你的主机\n请先配置与运行中服务一致的 SERVER_PORT 和 SERVER_TOKEN_FILE 环境变量，并在 Mac 上运行。')
  process.exitCode = 1
}
