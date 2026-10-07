# Nova Audio Agent v0.4.0 Spec Series

> 本系列描述的是下一个版本的计划，不在 v0.3.0 发布范围内。

2026-09-11 版本拆分：M8 及之后从 v0.3.0 移入本版。**2026-09-12 调整**：M8 邮件/日历与飞书 IM 拉回 v0.3.0
（见 [v0.3.0 04 卷](../v0.3.0/04-sources-and-connectors.md) 的 M8-Mail / M8-IM）；本版只保留 M9 执行器。当前只有规划，不声明实现或发布。

- M9-C：Kimi Code + pi agent；见 [02](02-coding-and-gui-executors.md)。
- M9-G：GUI / AutoGLM example；见 [02](02-coding-and-gui-executors.md)。
- M9-Demo：真实 agent2agent 闭环；依赖 M9-C、M9-G 验收。

执行器复用 v0.2 调度与授权，不依赖邮件/日历或 IM。Home Assistant 与 MyContext 仍是后续候选。公共/内部隔离不变；发布需要真实设备和服务证据。

[v0.3.0](../v0.3.0/00-overview.md) · [进度](STATUS.zh-CN.md)
