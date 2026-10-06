# 飞书连接器配置

需要 `lark-cli >= 1.0.69`。通过 `FEISHU_CLI_PATH` 指定可执行文件；未指定时使用 `PATH` 中的 `lark-cli`。不包含任何预置应用或组织凭据。

打开 Nova「设置 → IM 渠道」，按三个步骤完成连接：

1. **连接应用**：选择「创建飞书应用」，前往官方页面完成创建，再回 Nova 点「我已完成，继续」；也可选择「绑定已有应用」，从开放平台的「凭证与基础信息」填写 App ID 和 App Secret。Secret 通过 CLI 标准输入传递，不放命令参数；不会覆盖已有应用配置。
2. **授权账号**：打开飞书授权页，完成后回到 Nova 继续。应用绑定和账号授权分开保存，取消或失败不会偷偷创建另一应用。
3. **选择会话**：统一列出真实会话名称，用 toggle 选择范围并确认整理用途；不预设「项目讨论」「设计协作」分类。

凭据仅保存在 Nova 专用隔离目录（个人代理数据库路径加 `.feishu/credentials`），不复用其他应用的登录目录，不自动降级系统钥匙串存储。创建流程使用 `config init --new --lang zh`，已有应用使用 `config init --app-id … --app-secret-stdin --brand feishu`。配置页提供取消和重新检查入口。

应用需要开通 `im:chat:read`、`im:message:readonly`、`im:message.reactions:read`；用户 OAuth 另外请求 `offline_access`。实际能读取的会话仍受用户资源权限与企业策略限制。

首次读取最近 7 天，之后按保存游标继续。支持文字与富文本消息的文字部分；不下载附件，其他格式会显示未提取提示。正文默认保留 30 天。

机器人提醒另行开启，只投递到当前登录用户的私聊。应用需启用机器人、发送消息权限，并在开发者后台启用 `card.action.trigger` 卡片回调。CLI 通过长连接收取操作，不需要公开回调 URL。「在 Nova 中查看」不授权执行任务。参见[官方卡片回调说明](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-card-action-reply.md)。

暂停保留登录和历史；断开停止采集与机器人并清除用户登录，保留应用配置及历史；「删除历史」单独清除已采集的消息并使依赖记忆失效，后续重新启用时使用新的采集批次。

本地测试覆盖命令边界、分页、卡片去重与删除重连。真实账号 OAuth、应用权限和卡片回调需要在部署环境验收；仅有 CLI 版本检查不代表这些步骤通过。

消息字段以 [v1.0.69 官方说明](https://github.com/larksuite/cli/blob/v1.0.69/skills/lark-im/references/lark-im-chat-messages-list.md)核对：CLI 输出 `messages[].content`，排序参数为 `--order`；连接器另兼容原始 API 的 `body.content`。仅人类发送者进入记忆，机器人提醒不会被重新收录。
