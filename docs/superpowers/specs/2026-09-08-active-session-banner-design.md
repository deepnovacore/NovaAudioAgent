# Nova active session banner

日期：2026-09-08

基线：`v0.2.0dev` / `aef12656051c3687c61e3ecd43701f1b0163727d`

分支：`feature/active-session-banner`

状态：用户已批准聊天中的设计方向，并补充“清晰易读”；本文等待书面设计审阅，尚未实现。

## 1. 目标与范围

在现有桌面 Orb 附近显示常驻任务卡片：当前运行 session、最新消息或进展摘要、打开会话、精确取消任务。卡片采用 Nova 现有琥珀色星核语言，不复制参考截图的白色胶囊。复用 Node + TypeScript runtime、桌面 WebSocket 和 Electron 宿主，不创建新的实时语音会话或协调模型。

同时在现有 Codex 执行端装配补充语音协作 developer instructions，改善进展和结果的信息组织。前台事实、授权、Surrogate 与 Floor 边界保留。本文参考 `docs/design-notes/2026-09-07-gpt-live-lessons-for-nova.md`；原笔记当前位于主 checkout 的未跟踪目录，不复制提交到本分支。

## 2. 已核对的现状

- `runtime/src/desktop-progress.ts` 已投影有界且经过清理的 `executor.progress` 和结果，进度携带 delegate 身份，但没有完整的 session 打开信息。
- `desktop/ambient-orb/src/renderer/bubbles.mjs` 的进度呈现会在 6 或 12 秒后消失，不能作为常驻运行状态。现有 roster 提供运行任务 ID 与标题。
- `desktop/ambient-orb/src/main/executor-result.mjs` 只打开结果对话框及 Memory Board，不是 Codex session 打开能力。
- `runtime/src/executors/codex/adapter-project.ts` 持有运行槽、任务身份、session 与线程绑定；取消最终通过对应槽的 AbortController 完成。语音取消可以调用模型消歧，鼠标点击已选定任务不需要再消歧。
- Codex 运行使用由宿主管理的项目 `CODEX_HOME`，不能假定全局 Codex 桌面可见所有线程。
- `runtime/src/executors/codex/factory.ts` 当前传入 `developerInstructions: null`。传输层已有该参数的接线。
- `runtime/src/realtime/frontend-instructions.ts` 已明确自然转述、任务归属、只转述最新未交付事实及禁止将进度说成完成。

## 3. 视觉与可读性

采用一张宽约 360 CSS px 的深色圆角卡片，高度随两行消息适度增长。背景使用接近不透明的深炭色，降低外部桌面背景对阅读的影响；标题使用暖白色，次要信息也须清晰。琥珀色用于状态点、细边缘和有限光效，文字区域不放渐变亮斑。

- 标题约 15px、消息至少 14px；普通文字与实际合成背景对比度至少 4.5:1。
- 第一行显示项目 / session 标题，第二个区域显示最新消息，默认最多两行。
- 长标题和消息省略时，通过焦点或悬停可以查看完整的公开文本；打开会话可查看原始完整内容。不得以缩小字号解决溢出。
- 打开使用箭头跳转图标，不占用“打开”文字；停止、隐藏同样使用明确图标。所有按钮保留中文可访问名称、悬停提示与键盘焦点；交互热区至少 32 × 32 CSS px。
- 状态同时用文字表达，不只依靠颜色。动画仅使用边缘轻微呼吸，遵循 `prefers-reduced-motion`。
- 默认在 Orb 上方；空间不足时移至下方并收进屏幕工作区。按 Electron DIP 与 Chromium zoom 计算，避免 Retina 重复缩放。
- Banner 不遮住 Orb 的麦克风、音量和关闭操作；权限确认界面优先，空间冲突时暂时收起任务卡片，确认结束恢复。

## 4. 选择、更新与生命周期

默认选中当前项目中的运行任务；若当前项目无运行任务，选中最近启动的运行任务。存在多个任务时显示数量并可从列表切换。用户手动选择后，新消息不得抢走选择。此操作仅改变卡片选择，不切换 runtime 活跃项目或前台音频 session。

所有任务按宿主 work ID 关联，消息文本不参与身份推断。每条卡片展示宿主提供的项目、session 标题、阶段及最新公开消息。UI 接收执行事实，不等待语音播报或 Surrogate 选择；视觉持续更新不意味着每条更新都要读出来。保留现有输出清理规则，不能为了展示原始命令而绕过过滤。

运行期间卡片常驻。进度更新原位替换消息，不每次新增气泡；同一任务的进度不再同时触发重复气泡。其他类别的提醒继续走已有呈现路径。

- 运行：展示最新已接收消息，无内容时明确显示“任务已开始”或“正在处理”。
- 取消中：点击后显示“正在停止”，防止连续提交；等待宿主终态，不能把请求接受等同于任务已停止。
- 成功 / 已取消：保留 8 秒；悬停或键盘焦点暂停隐藏，然后切回其他运行任务，没有任务则收起。
- 失败 / 结果未知：保持可查看，允许手动关闭或切换到其他任务。
- 断连：保留最后已知内容并标明“连接已断开，状态待同步”，禁用不能验证目标的操作。重连后由宿主快照恢复当前事实，不把旧气泡缓存当作真实运行状态。
- 隐藏：只隐藏卡片，不取消任务；Orb 上保留运行任务数量入口。新任务出现可再次显示，已隐藏任务的普通进度不反复弹回。

快照与后续事件应有同一连接代次内的单调修订信息，拒绝旧连接消息及过期状态覆盖。终态是吸收状态，迟到的 working 消息不得复活已结束 work ID。

## 5. 数据与组件边界

在现有桌面协议增加小型任务快照及操作请求 / 回执能力，不另建通用消息总线。

- runtime 任务视图：从运行槽、session 绑定和现有进度事实生成有界公开视图，负责连接时快照和运行变化更新。公开字段包括 work ID、执行器标识、项目与 session 标题、阶段、消息、修订以及当前允许的操作。
- renderer 卡片控制器：单独模块维护选中项、隐藏状态、终态计时和焦点；渲染只用 textContent，不执行消息里的 HTML 或链接。
- 桌面宿主：沿现有 IPC 和 WebSocket 认证检查处理操作；窗口尺寸与点击区域由主进程校验，renderer 不提交任意原生窗口参数。
- session 打开目标：由宿主使用 work / session 映射解析可信绑定，不接受 renderer 传任意路径、命令、URL 或 CODEX_HOME。

主要涉及 `runtime/src/desktop*.ts`、`runtime/src/realtime/service.ts`、Codex adapter/factory 及 `desktop/ambient-orb/src/{main,preload,renderer}` 对应模块。只提取本功能需要的状态控制模块，不重构整个 service 或窗口系统。生成的 wire frame 常量由既有 build 流程更新。

## 6. 打开与取消

打开默认进入卡片对应的 Codex session，不新建任务、不发送 prompt、不恢复执行。主进程采用经本地验证能定位该受管 home 和 thread 的会话打开入口；仅“调用成功”不能证明打开了正确会话。用户补充接受使用 Finder：无法直接定位受管 session 时，可由箭头打开该任务的项目目录，提示必须明确为“在 Finder 中打开项目”，不能写成“查看会话”。其他平台使用相应系统文件管理器。

实现前先验证当前安装的 Codex 打开能力及 Nova 项目 home 的可见性。如果安装版本无法定位该 session，使用上述 Finder 项目目录入口，并在交付说明中写明会话直达未支持；不得将空白 Codex 窗口或 Memory Board 伪装为已打开成功。Finder 目标必须使用卡片对应 work 的已验证项目路径，不能在用户点击后改用另一个活跃项目。

取消请求携带明确 work ID、执行器身份和关联请求 ID。宿主重新核对目标仍在运行且属于当前受控任务集合，调用现有精确任务取消路径，不把 ID 转成自然语言让模型选择。已结束任务返回 not_running；A 已结束、B 已启动的竞态不能停止 B。点击停止不重开审批对话，点击本身就是用户对该任务的取消请求。实际终态仍由原生命周期结算。

打开和取消的失败要在卡片内可见；恢复可重试操作前重新取得当前宿主状态。取消不停止前台语音连接，也不影响其他运行任务。

## 7. 前后台提示词

后台新增 Nova 专用 developer instructions，使用现有 factory → thread/start / thread/resume 参数链，避免修改用户全局配置或挤占 WorkOrder。要求：

1. 按 WorkOrder 完成实际工作，保留显式约束、验证要求与完整交付物。
2. 进度先讲有意义的新发现、阶段验证、阻塞和需要用户决定的事项，避免逐项罗列工具调用。
3. 最终先讲结果、验证范围及尚未解决的限制，再给必要细节和产物入口；不能为了简短遗漏失败。
4. 清楚知道输出将被语音前台转述，但不把结构化 WorkOrder 当作可能有误的原始转录重新解释。
5. 授权与运行状态归宿主，后台表述不扩大权限。

前台本轮不重写：当前已有相关表达要求，缺口在后台装配。用户问状态不触发新增执行，多个任务按宿主身份介绍。Banner 的频繁更新不改变 Surrogate、Host、Floor 的语音打断策略。

当前 progress projection 将计数放在 prose 前，再裁剪。本轮先接入后台指令并观察证据；只有定向回归证明重要结论或失败限定被计数挤掉时，才在既有 composeSummary 中调整顺序。不要新增摘要模型或复杂消息 schema。指令接线测试通过仅说明接线正确，不等同于真实语音体验已改善。

## 8. 连续转述模式评估（新增建议，尚未批准实现）

用户追加询问是否应支持全部转述及关闭 Surrogate。建议增加可选“连续转述”，默认仍为“智能播报”。该选项控制 coding 进度是否经过 Surrogate 的价值筛选，与视觉 Banner、气泡显示设置分开。

现状证据：`prompting.ts` 的三个主动性档位均拒绝 routine_delta，eager 也不是全部转述；`runtime.ts` 的 working progress 产生 suggestion 并唤醒 surrogate.watch；`realtime/service.ts` 在 progress_via_surrogate 为真时跳过直接进度播报。两处必须使用一致的有效模式，否则会重复播报或完全沉默。当前 final / user-awaited 交付本就有独立通道。

`settings.surrogate_model` 同时作为 realtime assembly 中 intakeModels 的 assessModel，参与需求评估和取消消歧。因此模式开关应绕过 coding 进度的 surrogate.watch 调用，不能删除该模型配置，也不能声称所有同型号模型调用都停止。监控和其他 ambient suggestion 的播报决策继续使用现有策略。若要彻底关闭所有 Surrogate 仲裁，需要另行设计这些通道的确定性策略，本次不推荐扩展到这个范围。

连续模式将每个通过宿主身份与内容验证的、新的非空 coding 进展摘要送入现有 Host → FrontBrain → Floor 交付链，由前台自然转述；不把工具原始输出或每个 token 直接接成音频。普通心跳与完全相同的摘要不触发新语音。等待用户说完、已过期进度撤销、结束后清理旧进度、最终结果优先等行为保留，因此该模式不应命名为“逐字无损全部朗读”。密集更新超过说话速度时仍需有界积压策略，已过期内容留在任务文本，不能播报几分钟前的旧状态。

显式静默是启用连续模式前必须解决的约束：现有 Surrogate 提示词承担对 trusted_user “不要播报 / 只记录”的部分语义判断，单纯绕过模型并不能自动保留这一能力。实现时须让宿主拥有明确的任务进度播报偏好，并将用户静默要求可靠映射到该偏好；不能用扫描后台消息关键词代替。没有这条接线及回归证据，不宣称连续模式保持了静默语义。

预期收益是后台更新更连续，且 coding 进度少一次筛选模型等待和费用；实际延迟变化要记录测量。代价是前台响应和 TTS 次数可能增加，语音总费用不保证减少。优先服务用户正在跟进的 coding 任务；不将摄像头监控心跳或所有内部事件自动朗读。

GPT-Live 对照：2026-09-08 核对 OpenAI 公开 `backend_prompt.md`，其前台默认只讲简短、有依据且有用的进度，但用户要求详细 / 高频更新时，应在后台新信息到达时持续更新；`realtime_start.md` 则要求执行端为中间层提供简洁、面向行动的信息。因此“连续模式 + 后台语音协作指令”可能更接近用户观察到的跟进体验；公开提示词不能证明桌面产品内部没有其他过滤器，也不能把它描述为逐条全文朗读。

来源（可变 main，非安装版本逐字还原）：
- https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/realtime/backend_prompt.md
- https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/realtime/realtime_start.md

若批准该扩展，验证两模式各自只走一条播报路径，连续模式 coding progress 的 surrogate.watch 调用数为零，intake 仍可正常使用原模型；覆盖普通进度可听、用户静默、用户讲话时等待、模式切换时撤回在途旧 verdict、结果不重复及多任务归属。模式切换不能重启正在执行的任务。

## 9. 验证与交付

- 基线：在新 worktree 运行与现有进度气泡、窗口几何相关的测试，记录已有失败；实现阶段安装所需依赖并运行完整受影响检查。
- 状态测试：新任务、并发任务、手动选中稳定性、乱序消息、重复终态、隐藏恢复、终态停留、断连与快照恢复。
- 行为测试：点击打开传递精确目标；不接受任意外部 URL；取消 A 不影响 B；结束与取消同时发生；取消中重复点击；宿主拒绝可见。
- 窗口测试：屏幕四角、上方空间不足、确认框并存、Retina 与 1× / 1.5× / 2× zoom；控件可点且不覆盖 Orb。
- 渲染检查：长中文、长英文、无消息、两条以上并发任务、亮 / 暗桌面背景、键盘导航、减少动态效果。用实际截图检查文本清晰度及光效位置，并核对文字对比度。
- 提示词：覆盖 start / resume 参数、已有 launch validation 及后续 steer 不重复累积或丢失指令；前台 golden 不发生无意变动。
- 集成：runtime 和 desktop 构建会写 runtime/dist，相关检查串行执行。运行相关 runtime / desktop 测试和根 check；真人语音、外部 Codex 正确会话打开、Windows / Linux 验收分别记录，不以单元测试代替。

实现交付报告应包含分支、worktree、实际测试结果、截图和集成限制。保持当前 checkout 的未提交文件不变，功能验证完成后形成一个连贯提交；不自动合入 v0.2.0dev 或 main、不发布。
