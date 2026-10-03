import {onButton} from './button-action.mjs'
import {t} from './locale.mjs'
export const PHONE_STATES = {
  idle: [t("建立设备连接"), t("在 iPhone 上继续与这台电脑的 Nova 对话。首次连接只需扫码。"), t("启用手机连接"), 'enable'],
  not_installed: [t("还差一个安全连接"), t("在电脑和 iPhone 安装 Tailscale，登录同一账号，然后回来继续。"), t("下载 Tailscale"), 'install'],
  needs_login: [t("连接同一 Tailscale 网络"), t("在电脑和 iPhone 上打开 Tailscale，登录同一账号并连接。完成后回来重新检测。"), t("打开 Tailscale"), 'login'],
  needs_serve: [t("设备已在线"), t("允许同一 Tailscale 网络中的设备连接这台 Nova。连接仍需扫码授权。"), t("开启安全连接"), 'network'],
  conflict: [t("已有其他服务使用此地址"), t("Nova 不会覆盖现有转发。可在高级设置填写另一个已配置的安全地址。"), t("查看配置帮助"), 'help'],
  public_endpoint: [t("此地址已公开到互联网"), t("请为 Nova 使用私有 Tailscale Serve 地址，再重新检测。"), t("查看配置帮助"), 'help'],
  unavailable: [t("暂时无法读取网络状态"), t("请确认 Tailscale 正在运行，然后重试。也可以在高级设置填写地址。"), t("重新检测"), 'status'],
  service_unavailable: [t("手机服务未能启动"), t("请检查 Nova 的语音配置。若使用已有服务，请检查高级设置中的连接信息。"), t("重试连接"), 'enable'],
  qr_unavailable: [t("二维码暂时不可用"), t("请确认这台 Mac 已安装 Xcode Command Line Tools，然后重试。"), t("重试"), 'refresh'],
  unsupported: [t("目前支持在 Mac 上连接"), t("请在 Mac 版 Nova 打开此页面。"), '', 'status'],
  ready: [t("用 iPhone 扫码"), t("打开手机 Nova → 连接主机 → 扫码连接。"), t("重新生成二维码"), 'refresh'],
  invalidated: [t("二维码已取消"), t("重新生成二维码，即可继续配对。"), t("重新生成二维码"), 'refresh'],
  paired: [t("iPhone 已配对"), t("在手机上开始对话。你也可以继续连接另一台设备。"), t("连接另一台设备"), 'refresh'],
}

export function createPhonePanel({document, api, save}) {
  const node = id => document.getElementById(id)
  let active = false, busy = false, action = 'enable', timer, generation = 0
  const render = view => {
    const [title, detail, label, next] = PHONE_STATES[view.state] ?? PHONE_STATES.unavailable
    action = next
    const step = view.state === 'paired' ? 'done' : view.image ? 'scan' : 'network'
    for (const name of ['network', 'scan', 'done']) node(`phone-step-${name}`).setAttribute('aria-current', name === step ? 'step' : 'false')
    node('phone-title').textContent = title
    node('phone-description').textContent = detail
    node('phone-primary').textContent = label
    node('phone-primary').hidden = !label
    node('phone-primary').disabled = busy
    node('phone-state').textContent = view.state === 'ready' ? t("等待扫码") : view.state === 'paired' ? t("已配对") : view.service ? t("本机服务已就绪") : t("私人设备连接")
    node('phone-qr').hidden = !view.image
    if (node('phone-qr').getAttribute('src') !== (view.image ?? '')) node('phone-qr').src = view.image ?? ''
    node('phone-illustration').hidden = Boolean(view.image)
    node('phone-host').textContent = view.host ?? ''
    node('phone-disable').hidden = view.state === 'idle' || view.state === 'unsupported'
    const devices = node('phone-devices')
    devices.replaceChildren()
    for (const device of view.devices ?? []) {
      const row = document.createElement('div')
      row.className = 'phone-device'
      const name = document.createElement('span'); name.textContent = device.name
      const button = document.createElement('button'); button.type = 'button'; button.textContent = t("撤销连接")
      onButton(button, () => { return run('revoke', device.id) })
      row.append(name, button); devices.append(row)
    }
    devices.hidden = !(view.devices?.length)
  }
  async function run(next = 'status', deviceId, quiet = false) {
    if (busy || !active) return
    busy = true
    const epoch = generation
    if (!quiet) {
      node('phone-primary').disabled = true
      node('phone-primary').textContent = next === 'network' ? t("正在配置…") : t("正在准备…")
    }
    try {
      const view = await api.phoneAction(next, deviceId)
      if (epoch === generation) { busy = false; render(view) }
    } catch { if (epoch === generation) { busy = false; render({state: 'unavailable'}) } }
    finally { busy = false; if (epoch !== generation && active) void run('status') }
  }
  onButton(node('phone-primary'), () => { return run(action) })
  onButton(node('phone-recheck'), () => { return run('status') })
  onButton(node('phone-disable'), () => { return run('disable') })
  onButton(node('phone-pairing-open'), async () => { if (!busy && (await save()).saved) return run('enable') })
  render({state: 'idle'})
  return {
    setActive(value) {
      if (active === value) return
      active = value; generation++
      clearInterval(timer)
      if (active) { void run(); timer = setInterval(() => { if (action === 'refresh') void run('status', undefined, true) }, 3000); timer.unref?.() }
      else { node('phone-qr').hidden = true; node('phone-qr').src = ''; void api.phoneAction('cancel').catch(() => {}) }
    },
  }
}
