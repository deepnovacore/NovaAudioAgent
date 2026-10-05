# v0.4.0 进度

2026-09-11：按用户要求承接 M8 及之后的里程碑。2026-09-12：M8 邮件/日历与飞书 IM 拉回 v0.3.0（M8-Mail、M8-IM），
本版只剩 M9。以上为历史规划；当前 coding 实测状态见下文。

| 里程碑 | 一句话 | 依赖 | 退出条件 | 状态 |
|---|---|---|---|---|
| **M9-C** 多 coding 后端 | OpenCode、CodeBuddy、Pi、DeepSeek Harness 接入既有 coding 调度、审批、进度、取消 | v0.2 执行器/审批契约；不依赖 M7/M8 | 每个后端独立通过工作闭环及拒绝/取消/失败场景，支持矩阵明确 | 🟨 已接入并实跑；整体未验收 |
| **M9-G** GUI 执行器 | 以 AutoGLM 为首个 example，绑定设备与动作授权 | v0.2 执行器/审批契约；不依赖 M9-C、M7/M8 | 真机执行、拒绝、中途取消和状态不明场景通过 | ⬜ 未开始 |
| **M9-Demo** agent2agent | Nova 委派 coding/GUI 专长 agent 的复现说明与真实演示 | M9-C、M9-G | 版本/平台/权限/产物/限制完整，不把协作演示称为未经验证的 A2A 协议兼容 | ⬜ 未开始 |

完整要求见 [执行器](02-coding-and-gui-executors.md)。

2026-10-04：基于 `v0.4.0dev@d425dcb5` 开始独立项目实跑。四个 ACP 后端
及 Codex 均已生成可玩的俄罗斯方块，浏览器机制检查通过；但 Task 收口、
证据契约、原会话续做仍有阻塞，不能签整体 live 通过。部分证据补丁仅在本地
验收分支验证，尚未合并；GUI/语音/打包产品不属于本轮覆盖。
详见 [coding live 验收记录](../../testing/v040-coding-live-acceptance.md)。

2026-10-05：对 Oct-5 四后端 `task_check_unavailable` / Pi 重启
`task_origin_unavailable` / 续接 `unknown_session` 完成根因确认与本地修复
（未提交、未合并）。回放表明验证器回复为合法 `complete`，但 `criteria` 下标
越界被 `applyDecision` 拒绝并被吞成无诊断 waiting。修复包括：验证器阶段诊断 +
一次带 `validation_feedback` 的预校验重试、证据 64KB 保留最新观察、Blackboard
按通道公平淘汰、同 generation 恢复保留 `coding_target`，以及 transport/intake/
live 驱动的审查加固。本地 `runtime` 全量测试 3459 通过。

同日补齐错误原因透传（intake 失败的 schema 路径、验证器修复提示、ACP 失败的
固定分类诊断）后锁定模型原因：`qwen-flash` 会照抄前台改写的约束、`qwen-max`
验证器 JSON 类型稳定写错；`qwen3-max` 两项均通过（级联 Qwen 下 support/planner/
compressor 跟随前台模型）。`qwen3-max` live 重跑：DeepSeek Harness、CodeBuddy、
OpenCode、Pi 四个后端的原 Task、切换默认后端后原会话续做、重启后原会话续做全部
`completed`，首轮自然语言直接派发，后端身份与会话固定。DeepSeek 重启续做先因账户
402 失败，充值后按 `not_run` 对账并继续原 Task 完成；Pi 充值后从头重跑通过。期间
修复会话标题上限不一致、重启后续做被误追问、派发异常原因被吞三处缺陷。M9-C 的
runtime 文本工作闭环已通过；拒绝/取消/崩溃、GUI/语音/打包仍未覆盖。compressor 在
ACP 执行期间空转（约占 `qwen3-max` 输入的 91%），延后在 `v0.3.0dev` 独立 worktree 修复。
