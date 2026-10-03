<a id="5-执行器"></a>
<a id="直接-mcp-与-vision"></a>
<a id="适配器职责"></a>
# 执行器

<a id="5-executors"></a>

Executor 是异步执行层，负责承接运行时或模型分派出的任务，直到任务结束。装配阶段按 manifest 声明的角色路由 executor，不做名字硬编码，因此 executor 名称只需唯一，系统不维护固定的枚举。manifest 描述 executor 自身的操作、参数结构和策略；信任级别标记在返回结果上；独立的 `AgentController` 注册表描述对模型可见的控制器及其私有通道，两者分别配置。

## 可选的 coding 角色

若没有 manifest 声明 `coding` 角色，只移除 coding 的 intake 与控制器接线，装配仍然合法，不构成 `AssemblyError`。此时只要至少注册了一个 `AgentController`（例如 Vision 控制器），宿主工具 `dispatch`、`cancel`、`confirm` 仍会编译；控制器数量为零时编译器才省略它们，直接可读工具不受影响。

## Codex

Codex executor 在确定性后端与 live app-server 后端上使用同一套按角色路由的 dispatch/cancel 边界。live 后端可提供 `codex.steer`，用于在同一轮内追加约束，并通过宿主审批协议处理有副作用的操作。workspace 与 Session 身份由宿主持有，不从 executor 的输出文本推断。呈现给 Codex 的工具不占用实时 FrontBrain 的工具预算。

## MCP 工具与视觉能力

<a id="direct-mcp-and-vision"></a>

搜索保持稳定的 `SearchAdapter` 契约，MCP 只是其背后的一种传输方式。摄像头采集是原生能力，归属于某个对话轮次或监控任务。外部 MCP 工具由用户选择引入，计入上下文成本，不会成为 agent 工具或 intake 工具。Vision 控制器拥有隐藏通道 `watch` 和 `guard`；模型只能对 `vision` 控制器 dispatch 或 cancel，无法操作这些隐藏通道。所有直接操作都按各使用方的工具白名单提供；allowlist 本身不授权任务，也不改变发言控制。

## 适配器负责什么

<a id="adapter-responsibilities"></a>

适配器负责以下工作：

- 校验凭据与端点；
- 处理传输超时与取消；
- 规范化请求；
- 清洗输出并判定信任级别；
- 在集成支持时验证副作用。

运行时只负责通用的已分派任务的生命周期。与具体能力相关的恢复逻辑放在适配器中，不写入运行时分支。
