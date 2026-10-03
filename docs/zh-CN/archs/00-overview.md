<a id="architecture-reference"></a>
# 架构参考

本系列介绍 NovaAudioAgent 如何协调实时对话、后台任务和主动提醒。按下面的顺序阅读，可以逐步了解状态管理、模型上下文、执行接口和验证方法。

1. [运行时主干](01-spine.md)
2. [记忆](02-memory.md)
3. [上下文视图](03-context-view.md)
4. [执行接口](04-ports.md)
5. [执行器](05-executors.md)
6. [本地开发](06-verification.md)
7. [设计约束](07-decision-record.md)
8. [路线图](09-roadmap.md)
9. [执行器接入](10-executor-onboarding.md)
10. [原生视觉与独立监控](11-vision.md)

开发新能力时，需要明确谁管理任务状态、谁决定提醒时机，以及谁负责向用户回复。各章围绕这些职责划分展开。
