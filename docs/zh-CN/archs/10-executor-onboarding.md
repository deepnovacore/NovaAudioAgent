<a id="10-执行器接入"></a>
<a id="10-executor-onboarding"></a>
# 接入执行器

接入执行器是让 Nova 扩展新能力的入口：你提供一份清单声明它的角色与操作，再由适配器把外部协议转换为有界进度和一次带类型的终态交接。装配层按角色接线，模型全程只看见清单允许的操作。

## 编写清单

清单包含一个唯一名称（可任意取）、声明的角色，以及各操作的参数 schema。不要新增固定的执行器枚举，角色才是路由依据。

## 为操作声明约束

每个操作都必须显式给出 `readonly`、`confirm`、`deadline_budget`、`verifies`、`sensitive_params` 和 `sync_result`。信任等级在交接（handoff）时判定，而不是写在 op spec 里。

## 实现与传输无关的适配器

适配器把外部协议转换为有界进度和一次带类型的终态交接，并配有确定性的测试替身。不要让模型直接访问传输层，适配器是唯一出口。

## 按角色装配

装配时按角色接线，并把 `AgentController` 注册表与清单分开维护：控制器描述 声明模型可见的工具和 `ownedChannels`；清单声明执行器提供的操作。隐藏的 Vision `watch` 和 `guard` 从不是分派目标。搜索仍是稳定的适配器契约，而内置 Camera capture 不是工具，详见 [原生视觉](11-vision.md)。可选的 Knowledge MCP 同样只向 FrontBrain 暴露 `mcp__nova_knowledge__recall`，其数据接入 API 仅供宿主使用，可选的 Codex `get_chunk` 解析器 不会进入语音工具枚举。

## 补充测试

覆盖非法输入、超时、取消、输出清洗，以及注册表与适配器之间的契约。只有在确定性生命周期测试全部通过后，才添加真实环境的冒烟测试。凭据与最小权限配置写在 上手指南 中。

## 注册控制器后，哪些工具可用

`dispatch`、`cancel`、`confirm` 三个宿主工具在至少注册一个 `AgentController` 时才会编译。缺少 `coding` 角色只影响 coding 的入口与 controller 接线；若注册了 Vision controller，这三个宿主工具仍可保留。一个 controller 都没有时，同一编译条件会省略这三个宿主工具，直接可用的只读工具依然有效，装配不会失败。
