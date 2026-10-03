import {homedir} from 'node:os'
import {join, resolve} from 'node:path'

const setupMethods = new Set(['feishu.status', 'feishu.app.start', 'feishu.app.status', 'feishu.app.cancel', 'feishu.app.bind', 'feishu.login', 'feishu.complete'])
export function createFeishuSetupOwner({Connector, environment = process.env}) {
  let owner = null, queue = Promise.resolve(), releasing = false
  const configured = environment.BLACKBOARD_PATH ?? '~/.nova-audio-agent/blackboard.sqlite'
  const blackboard = resolve(configured.startsWith('~/') ? join(homedir(), configured.slice(2)) : configured)
  return {
    request(method, params) {
      if (releasing || !setupMethods.has(method)) return Promise.reject(new Error('请先完成模型配置，再使用飞书同步'))
      const result = queue.then(async () => {
        if (releasing) throw new Error('IM connection changed')
        if (!owner) {
          owner = new Connector({bootstrapOnly: true,
            executable: environment.FEISHU_CLI_PATH ?? 'lark-cli',
            credentialRoot: join(blackboard + '.personal.json.feishu', 'credentials'),
            statePath: join(blackboard + '.personal.json.feishu', 'state.json'),
          })
          await owner.open()
        }
        return owner.command(method, params)
      })
      queue = result.catch(() => {})
      return result
    },
    async release() {
      releasing = true
      await queue
      const previous = owner; owner = null
      await previous?.close()
      releasing = false
    },
  }
}
