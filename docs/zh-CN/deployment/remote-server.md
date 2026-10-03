# 远程服务

在 Ubuntu 22.04+ x64 或 Mac 上以 Node 服务运行 Nova，通过私有 Tailscale 网络连接 iPhone，无需 Electron。服务默认使用 `relay` 媒体模式，通过 `/client/v1` 提供连接；远程会话不支持原生摄像头采集。

桌面用户可直接从 Nova 菜单选择“连接 iPhone…”，参见 [iPhone 指南](../iphone.md)。下面介绍独立管理服务的方式。

请为服务准备独立的可写工作区与状态目录。若要复用桌面端的状态，先退出桌面实例，避免两个运行时同时写入。桌面托管的手机服务使用单独的 `phone` 目录，可以与桌面端共存。

远程凭据存储依赖 POSIX 属主和私有文件权限，当前不支持 Windows 远程宿主；这不影响 Windows 桌面应用。npm 包面向 Ubuntu 22.04+ x64，macOS 可使用源码入口；下文 launchd 示例仅适用于 macOS。

## 通过 npm 安装

使用 Node.js >=22.14.0，运行 `npm install --global nova-audio-agent-server`。按下文配置环境后，运行 `novaaudio-server token-init`，再运行 `novaaudio-server --env-file /absolute/path/server.env start`。另开交互终端，使用相同配置运行 `novaaudio-server --env-file /absolute/path/server.env pair wss://your-host.ts.net` 显示一次性二维码（SSH 需加 `-t`）。无需 Electron 或图形会话。

Ubuntu 下直接使用已安装的 `tailscale` 命令完成下文的私有 WSS 配置；服务可在前台运行，也可由进程管理器以相同用户和显式环境文件托管。

## 构建与配置（源码方式）

使用 Node >=22.13，并确保检出目录已安装常规工作区依赖。构建需与桌面端串行执行，因为两者都会写入 `runtime/dist`：

```sh
cd /absolute/path/to/nova-audio-agent
npm ci
npm run build --workspace @nova-audio-agent/runtime
```

在检出目录之外创建私有目录。以下两个变量必须设置；端口无默认值，取值须为 1–65535。缺失或非法取值会在构造模型、MCP、Codex 资源之前报错。

```sh
mkdir -p "$HOME/.nova-remote"
chmod 700 "$HOME/.nova-remote"
export SERVER_PORT=19876
export SERVER_TOKEN_FILE="$HOME/.nova-remote/client-token"
npm run server:token-init --workspace @nova-audio-agent/runtime
```

初始化会生成一个随机的 128 位小写十六进制 token，权限为 0600，并拒绝覆盖任何已存在的文件。加载器拒绝相对路径、符号链接、非普通文件、非本用户属主，以及 0600 以外的权限。设备独立凭据请使用下方二维码配对。手动兜底方式是在本机读取该文件，再把 token 填入手机端由 Keychain 支持的连接设置；不要把它放进 URL、shell 参数、日志或 Git。

模型/执行器配置需显式写入私有环境文件，例如 `$HOME/.nova-remote/server.env`（0600），沿用既有的 Runtime 环境变量约定。该文件是 Node `--env-file` 文件，不是 shell 脚本，需写绝对路径，不会展开 `$HOME`/`~`。至少配置所需的 pipeline 及其凭据。使用 Codex 还需设置 `EXECUTORS=codex`、绝对路径的 `CODEX_WORKSPACE`，并把 `CODEX_PROJECT_STATE_ROOT` 指向预期的私有状态目录。无界面入口不读取 Electron Settings，也不从 cwd 推断项目。Codex 登录及可执行文件/资源路径配置必须对运行该服务的同一用户可用；GUI 应用的环境变量不会被继承。

兼容管线见[支持矩阵](../support-matrix.md)。远程音频使用单声道 PCM16 LE，输入 16000 Hz、输出 24000 Hz；不兼容的格式会被拒绝。

先在前台启动（无人值守时把两个 server 变量写入环境文件）：

```sh
node --env-file="$HOME/.nova-remote/server.env" runtime/dist/src/server-entry.js
```

启动成功会输出 `[server-ready] ws://127.0.0.1:19876/client/v1`，不含 token。服务只绑定回环地址。端口被占用即视为错误，不会另选端口。SIGINT/SIGTERM 会按顺序停止服务并释放模型与执行器资源。关闭标准输入不会自动停止服务。


## 用 Tailscale 搭建私有 WSS

在 Mac 和 iPhone 上安装并登录 Tailscale，将 tailnet 访问限制在自己的设备内。macOS 上应调用 App 自带的 CLI，并通过 `TAILSCALE_BE_CLI=1` 强制 CLI 模式，非 TTY 自动化中同样如此，以免可执行文件根据 shell 环境选择 GUI 模式；参见官方 [macOS CLI 说明](https://tailscale.com/docs/reference/tailscale-cli?tab=macos)。先查看现有 Serve 配置：

```sh
TAILSCALE_BE_CLI=1 /Applications/Tailscale.app/Contents/MacOS/Tailscale serve status
```

如果存在未使用的 HTTPS 监听：

```sh
TAILSCALE_BE_CLI=1 /Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg --https=443 http://127.0.0.1:19876
TAILSCALE_BE_CLI=1 /Applications/Tailscale.app/Contents/MacOS/Tailscale serve status
```

手机上使用 `wss://<machine>.<tailnet>.ts.net/client/v1`，应用 token 仍放在认证帧中。使用 Serve，不要用公开的 Funnel。HTTPS 前置条件和监听管理见官方 [Tailscale Serve CLI 参考](https://tailscale.com/docs/reference/tailscale-cli/serve)。移除该专用监听时（不要移除其他服务共用的监听）：

```sh
TAILSCALE_BE_CLI=1 /Applications/Tailscale.app/Contents/MacOS/Tailscale serve --https=443 off
```

## 使用 launchd 托管服务

前台验证通过后，把用户级 LaunchAgent 保存为 `~/Library/LaunchAgents/com.nova.remote.plist`。所有绝对路径占位符都要替换；launchd 不展开 shell 变量。环境文件放在 Git 之外，凭据放在其中，不要写进 plist。先创建日志目录。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.nova.remote</string>
  <key>ProgramArguments</key><array>
    <string>/absolute/path/to/node</string>
    <string>--env-file=/Users/your-user/.nova-remote/server.env</string>
    <string>/absolute/path/to/nova-audio-agent/runtime/dist/src/server-entry.js</string>
  </array>
  <key>WorkingDirectory</key><string>/absolute/path/to/nova-audio-agent</string>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/Users/your-user/.nova-remote/server.log</string>
  <key>StandardErrorPath</key><string>/Users/your-user/.nova-remote/server.log</string>
</dict></plist>
```

```sh
plutil -lint "$HOME/Library/LaunchAgents/com.nova.remote.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.nova.remote.plist"
launchctl print "gui/$(id -u)/com.nova.remote"
# Stop and unload before maintenance or credential rotation:
launchctl bootout "gui/$(id -u)/com.nova.remote"
```

LaunchAgent 在用户登录会话中运行，出错后不会自动重启。排除问题后重新加载即可；重启服务不会恢复未完成命令或待处理审批。


## 扫码配对与设备撤销

保持服务运行，在同一台 Mac 的另一个交互终端中加载相同的端口和认证文件配置，然后执行：

```sh
npm run server:pair --workspace @nova-audio-agent/runtime -- wss://你的主机.ts.net
```

在 iPhone 中选择“扫码连接主机”，确认地址后保存连接。终端显示一次性二维码，其中不包含主机长期 token。WSS 地址需要事先通过 Tailscale Serve 转发到该服务。通过 SSH 操作时使用 `ssh -t`；配对命令不接受管道、重定向输出或宽度不足的终端。

重新生成会使旧二维码失效。二维码没有定时过期限制，但只能兑换一次。中断命令会尝试取消当前二维码；异常退出后，可重新生成或重启服务使旧码失效。

macOS 上可使用窗口模式进行配对和设备撤销，此模式需要 Xcode Command Line Tools：

```sh
npm run server:pair --workspace @nova-audio-agent/runtime -- --window wss://你的主机.ts.net
```

将 token 文件及 `${SERVER_TOKEN_FILE}.devices.json` 保存在 0700 私有目录中，两个文件都应仅允许服务用户访问。设备存储最多支持 32 台设备，只能由一个进程写入，不要在服务运行时编辑。

Tailscale Serve 必须转发整个服务，包括 `/client/v1`、`/client/pair` 和 `/client/pair-admin`。管理请求需要主机 token，设备 token 没有管理其他设备的权限。撤销一台设备不会影响其他设备凭据。

## 凭据轮换与重连

轮换共享主机 token 时，先停止服务，删除配置中的 token 文件并移走旧设备文件，再运行 `server:token-init`。重启服务后，手机需要重新配对。运行中修改 token 文件不会使现有连接失效，也不会让进程重新加载凭据。

手机断开本身不会取消后台工作。重连会恢复当前项目、执行器、审批状态和保留的结果，不会重放旧音频。消息回执只表示送达，不表示任务完成。服务进程重启会使待处理审批失效，也不会自动续跑命令。

连接故障后若语音仍不可用，可以点击“停止”再重新连接。这会替换实时模型会话，无需重启宿主；绑定旧会话的审批会失效。

## 连接问题

- `configuration_required`：检查固定端口、认证文件绝对路径、属主、0600 权限和模型配置。
- 端口被占用：用 `lsof -nP -iTCP:19876 -sTCP:LISTEN` 查看占用者；Nova 不会自动换端口。
- 手机无法连接：确认两台设备都在允许访问的 Tailscale 网络内，Serve 转发到正确端口。
- `assembly_failed` 或 `backend_unavailable`：查看本机服务日志和模型、执行器连接配置。分享日志前删除凭据。
