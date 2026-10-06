<a id="executors"></a>
# 执行器

执行器让后台任务与前台对话并行推进：任务状态、权限和结果交付均由 Nova 统一管理。

| 执行器 | 用途 | 状态 |
|---|---|---|
| [Coding](coding.md) | 在已批准的项目中写代码、修改文件、运行命令 | 已接入 Codex app-server |
| [Loop Camera](loop-camera.md) | 观察指定摄像头，条件满足时上报 | 已接入原生摄像头与独立视觉模型 |
| GUI-use | 操作跨应用的图形界面 | 计划中，暂无配置指南 |

Loop Camera 是面向用户的功能名；运行时由 `vision` 控制器承载，内部使用 `watch` / `guard` 两个执行器。它与对话中的视觉能力相互独立，后者只针对一次提交的语音转写或文字输入抓取一帧。

委派出去的工作现在是一个持久化的 Task：它会出现在 [Tasks](../tasks.md) 页面，带有目标与验收标准；Nova 在标记完成前会对照这些标准进行核验，用户随时可以接管其控制权，也可以交还给 Nova。

新执行器复用既有的任务分发、审批、进度上报、取消和结果交接机制，参见[接入流程](../archs/10-executor-onboarding.md)与[执行器契约](../archs/05-executors.md)。GUI-use 的规划见[路线图](../archs/09-roadmap.md)。
