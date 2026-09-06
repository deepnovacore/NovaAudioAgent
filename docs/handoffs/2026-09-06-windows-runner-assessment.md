# Windows 构建机评估（2026-09-06）

## 结论

这台阿里云机器可以承担单路 Windows 构建和自动化测试。当前尚未注册 GitHub Actions runner，仓库的自托管 runner 数量为 0。

建议保留 public 仓库的标准 GitHub 托管 CI，将这台机器用于受信代码的复现、打包和桌面验证。GitHub 官方当前将 public 仓库的标准托管 runner，以及 self-hosted runner 的运行分钟列为免费；不能把自托管解释为必然节省原有 CI 分钟费用。云主机、网络和可能的存储费用仍需单独考虑。

## 实测配置与边界

| 项目 | 实测 |
| --- | --- |
| 系统 | Windows Server 2022 Datacenter，10.0.20348 |
| CPU | Intel Xeon Platinum；4 个逻辑处理器，虚拟拓扑显示 2 核 / 4 线程 |
| 内存 | 7.73 GiB；一次测试期间快照剩余 4.87 GiB，不代表峰值 |
| 系统盘 | 39.9 GiB；评估时剩余 12.3 GiB |
| 软件 | Node 24.20.0；另在 npm 缓存安装 Node 22.23.2 对照 CI；已有 Git、MSVC 和 Electron 43.2.0 |
| 账户 | 远程维护为 SYSTEM；Administrator 有 session 1 的已登录桌面 |

4 vCPU / 8 GB 已能完成本项目的构建及桌面套件。先保持一个 runner、一个 job，runtime 与 desktop 串行，避免争用 `runtime/dist`。目前更值得改善的是磁盘：长期使用建议增加独立构建盘或扩至约 80–100 GB，并限定 artifact/cache 保留量；不要清理开发账户原有工作来腾空间。

最终 Node 22 验证：`check` 通过，runtime 2208 通过 / 8 跳过（约 241 秒），desktop 869 通过 / 20 跳过（约 51 秒，复用已完成的构建），CLI 21/21；真实窗口启动通过。实际 Windows ASAR 中的唤醒 Worker/WASM 正例 1 次、反例 0 次；空闲机器的按帧正例 131/131 帧接收、报告丢帧 2，不能写成零丢帧或真人验收。NSIS 生成被 GitHub 连接超时阻挡，尚未完成安装程序验证。

网络尚不能视为已满足 runner 全部要求：npm 下载成功，GitHub API 的一次 HTTP 探测返回 200，但唤醒模型的 GitHub release 下载发生 `ECONNRESET`。本轮使用 ECS 回环转发传输已有模型并核对 SHA-256；这不等价于证明 GitHub Actions 所有端点稳定可达。正式接入前应运行 runner 的连接诊断，覆盖 Actions、release assets、artifact/cache 所需域名。

## GitHub Actions 接入方式

1. 准备独立的 `nova-ci` 账户和 `C:\actions-runner`（或独立数据盘目录）；CI 不继承 SYSTEM / Administrator 的 Codex 登录、个人密钥或开发配置。
2. 在目标仓库 `Settings → Actions → Runners → New self-hosted runner` 选择 Windows / x64，按页面命令下载、校验并解压 runner，执行 `config.cmd`。注册令牌由 GitHub 临时生成，有效期一小时；不要写入仓库或聊天。
3. 设置名称 `aliyun-win`、自定义标签 `nova-windows`，只注册一个 runner。Windows 配置阶段可选择安装服务；安装服务需要管理员权限，但日常 job 使用独立账户。
4. 在 workflow 用 `runs-on: [self-hosted, Windows, X64, nova-windows]` 路由，显式串行运行项目现有命令；接入前先验证 runner online 和连接诊断。

当前 NovaAudioAgent 是 public 仓库，GitHub 官方不建议将持久自托管机器暴露给公共 PR。只改 `runs-on` 或一个 job 的 `if` 不足以形成可信隔离。更稳妥的方案是：公共 PR 继续使用 GitHub 托管 runner；将这台 runner 注册到私有 CI 控制仓库，只手动构建固定的受信分支。若使用组织 runner group，则还需实际核对并配置允许的仓库和工作流限制。

以下是**私有 CI 控制仓库**的最小示例，尚未部署：

```yaml
name: Nova Windows internal
on: workflow_dispatch
permissions:
  contents: read
concurrency:
  group: nova-windows
  cancel-in-progress: false
jobs:
  verify:
    runs-on: [self-hosted, Windows, X64, nova-windows]
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
        with:
          repository: deepnovacore/NovaAudioAgent
          ref: v0.2.0dev
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: '22.23.2'
      - run: npm.cmd ci
      - run: npm.cmd run check
      - run: npm.cmd run test:runtime:win
      - run: npm.cmd run test:desktop
      - run: npm.cmd run test:cli
```

桌面窗口 smoke 已分别在 SYSTEM 和 Administrator 下执行成功；它仍不替代真人麦克风、耳机、唤醒和长时间运行验收。需要交互桌面或音频设备的检查应使用专门的已登录会话，不将服务进程通过测试等同于真人验收。

## 官方依据

- [GitHub Actions 计费](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- [添加 self-hosted runner](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners)
- [平台与网络要求](https://docs.github.com/en/actions/reference/runners/self-hosted-runners)
- [工作流标签路由](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/use-in-a-workflow)
- [持久自托管 runner 与不可信代码风险](https://docs.github.com/en/actions/reference/security/secure-use#hardening-for-self-hosted-runners)
