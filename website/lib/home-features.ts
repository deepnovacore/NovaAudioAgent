export type FeatureGroup = "workbench" | "tasks" | "connections";

// Keep bilingual cards aligned with section 2 of the README.
export const featureCards: { lang: "en" | "zh-CN"; group: FeatureGroup; title: string; description: string; alt: string; image: string; width: number; height: number; caption: string; video?: string }[] = [
  {
    "lang": "en",
    "group": "workbench",
    "title": "Your personal workbench",
    "description": "Turn scattered context into source-backed recaps and suggested todos. Choose what to do next, then continue with Nova.",
    "alt": "Nova workbench with project recaps, suggested todos and conversation",
    "image": "/doc-assets/assets/features/workbench-original.en.png",
    "width": 1502,
    "height": 1047,
    "caption": ""
  },
  {
    "lang": "zh-CN",
    "group": "workbench",
    "title": "你的个人工作台",
    "description": "把零散上下文整理成有出处的近况与待办建议。选好下一步，再和 Nova 接着做。",
    "alt": "Nova 工作台中的项目近况、待办建议和对话",
    "image": "/doc-assets/assets/features/workbench-original.png",
    "width": 2240,
    "height": 1560,
    "caption": ""
  },
  {
    "lang": "en",
    "group": "workbench",
    "title": "Profile and personal memory",
    "description": "Nova builds an editable picture of your work and interests. Trace personal memories to their sources, correct them or remove them.",
    "alt": "Nova Profile showing a personal overview and recent projects",
    "image": "/doc-assets/assets/features/profile-original.en.png",
    "width": 1502,
    "height": 1047,
    "caption": ""
  },
  {
    "lang": "zh-CN",
    "group": "workbench",
    "title": "关于你，也由你来改",
    "description": "Nova 根据近期工作和兴趣形成个人概览。个人记忆可以追溯来源、纠正、忘记或彻底删除。",
    "alt": "Nova 关于我页面中的个人概览与近期项目",
    "image": "/doc-assets/assets/features/profile-original.png",
    "width": 2240,
    "height": 1560,
    "caption": ""
  },
  {
    "lang": "en",
    "group": "workbench",
    "title": "Ideas and goals",
    "description": "Keep an idea, choose a direction, and turn it into a todo when you are ready. Suggestions wait for you to adopt them.",
    "alt": "Nova Ideas and Goals with actual suggestions and adoption controls",
    "image": "/doc-assets/assets/features/ideas-goals-original.en.png",
    "width": 1254,
    "height": 1254,
    "caption": ""
  },
  {
    "lang": "zh-CN",
    "group": "workbench",
    "title": "把想法变成方向",
    "description": "记下想法，设定目标，准备好后再转成待办。Nova 的建议由你决定是否采纳。",
    "alt": "Nova 想法与目标页面中的建议和采纳入口",
    "image": "/doc-assets/assets/features/ideas-goals-original.png",
    "width": 1254,
    "height": 1254,
    "caption": ""
  },
  {
    "lang": "en",
    "group": "workbench",
    "title": "Feeds that follow your interests",
    "description": "Review public news ranked by your Profile. Save a story or turn it into an idea, todo or goal.",
    "alt": "Nova interest-ranked news feed with save and personal-item controls",
    "image": "/doc-assets/assets/features/feeds-original.en.png",
    "width": 1502,
    "height": 1047,
    "caption": ""
  },
  {
    "lang": "zh-CN",
    "group": "workbench",
    "title": "围绕兴趣发现资讯",
    "description": "根据 Profile 为公开资讯排序。收藏感兴趣的内容，也能转成自己的想法、待办或目标。",
    "alt": "Nova 按兴趣排序的资讯及收藏、转为个人事项入口",
    "image": "/doc-assets/assets/features/feeds-original.png",
    "width": 2240,
    "height": 1560,
    "caption": ""
  },
  {
    "lang": "en",
    "group": "tasks",
    "title": "Understands what you mean",
    "description": "Describe your goal naturally. Nova asks for missing details before starting a task; keep talking and refining it while the back brain works.",
    "alt": "Nova voice orb asking a clarifying question before starting a task",
    "image": "/doc-assets/assets/features/conversation-polished.en.png",
    "width": 1254,
    "height": 1254,
    "caption": ""
  },
  {
    "lang": "zh-CN",
    "group": "tasks",
    "title": "理解意图，问清再做",
    "description": "自然描述目标，Nova 问清缺失信息后再开始任务。后台继续执行，前台随时补充约束或调整方向。",
    "alt": "Nova 语音悬浮球在执行前澄清需求",
    "image": "/doc-assets/assets/features/conversation-polished.png",
    "width": 1254,
    "height": 1254,
    "caption": ""
  },
  {
    "lang": "en",
    "group": "tasks",
    "title": "You set the boundaries",
    "description": "Nova coordinates tasks and checks results against your criteria. Review permissions, take over when needed, and hear updates when they matter.",
    "alt": "Nova asking for permission to access the network for a task",
    "image": "/doc-assets/assets/features/permission-polished.en.png",
    "width": 1254,
    "height": 1254,
    "caption": ""
  },
  {
    "lang": "zh-CN",
    "group": "tasks",
    "title": "任务有边界，主动有分寸",
    "description": "Nova 协调任务，按你的标准核对结果。权限由你确认，执行可以接管；值得提醒的进展才在合适时机开口。",
    "alt": "Nova 请求任务所需的网络访问权限",
    "image": "/doc-assets/assets/features/permission-polished.png",
    "width": 1254,
    "height": 1254,
    "caption": ""
  },
  {
    "lang": "en",
    "group": "tasks",
    "title": "Voice-run workspaces",
    "description": "Create and switch workspaces and sessions by voice. A new workspace waits for your confirmation.",
    "alt": "Nova waits for approval to create a workspace",
    "image": "/doc-assets/assets/features/workspace-polished.en.png",
    "width": 1254,
    "height": 1254,
    "caption": ""
  },
  {
    "lang": "zh-CN",
    "group": "tasks",
    "title": "语音管理工作区",
    "description": "用语音创建、切换工作区和会话；新建工作区前，先等你确认。",
    "alt": "Nova 等待你确认创建工作区",
    "image": "/doc-assets/assets/features/workspace-polished.png",
    "width": 1254,
    "height": 1254,
    "caption": ""
  },
  {
    "lang": "en",
    "group": "tasks",
    "title": "Bring your tools and knowledge",
    "description": "Configure ASR / LLM / TTS and MCP; ask questions across your documents.",
    "alt": "Knowledge-base answer using the CN-27 demo documents",
    "image": "/doc-assets/assets/features/knowledge-polished.en.png",
    "width": 1254,
    "height": 1254,
    "caption": ""
  },
  {
    "lang": "zh-CN",
    "group": "tasks",
    "title": "接入工具与知识",
    "description": "自由配置 ASR / LLM / TTS 和 MCP，基于自己的资料问答。",
    "alt": "基于 CN-27 演示资料的知识库回答",
    "image": "/doc-assets/assets/features/knowledge-polished.png",
    "width": 1254,
    "height": 1254,
    "caption": ""
  },
  {
    "lang": "en",
    "group": "connections",
    "title": "Voice Vibe Coding",
    "description": "Describe what you want, let a coding agent build and test it, and refine the work through conversation.",
    "alt": "Voice requests delegated to a background coding agent",
    "image": "/doc-assets/assets/features/coding.en.svg",
    "width": 887,
    "height": 887,
    "caption": ""
  },
  {
    "lang": "zh-CN",
    "group": "connections",
    "title": "用语音 Vibe Coding",
    "description": "说出你想做的东西，让 coding agent 编写和测试，再通过对话不断调整。",
    "alt": "语音需求交给后台编码 Agent 执行",
    "image": "/doc-assets/assets/features/coding.svg",
    "width": 887,
    "height": 887,
    "caption": ""
  },
  {
    "lang": "en",
    "group": "connections",
    "title": "Camera Monitoring",
    "description": "Ask Nova to watch for a condition and tell you when it happens. Observation runs independently of coding tasks.",
    "alt": "Camera monitoring a cat on a sofa",
    "image": "/doc-assets/assets/features/vision-camera.png",
    "width": 1280,
    "height": 720,
    "caption": ""
  },
  {
    "lang": "zh-CN",
    "group": "connections",
    "title": "帮你留意画面变化",
    "description": "让 Nova 留意指定情况，发生时再提醒你。相机观察独立运行，不占用编码任务。",
    "alt": "相机观察沙发上的猫",
    "image": "/doc-assets/assets/features/vision-camera.png",
    "width": 1280,
    "height": 720,
    "caption": ""
  },
  {
    "lang": "en",
    "group": "connections",
    "title": "Weekly Report",
    "description": "Ask Nova to recall recent work and help organize a weekly report. Watch the original phone demo.",
    "alt": "Original phone demo of a conversation about recent work and a weekly report",
    "image": "/doc-assets/assets/demos/weekly-report/poster.en.png",
    "width": 941,
    "height": 1672,
    "caption": "",
    "video": "/doc-assets/assets/demos/weekly-report/weekly-report.mp4"
  },
  {
    "lang": "zh-CN",
    "group": "connections",
    "title": "一起整理周报",
    "description": "让 Nova 回顾近期工作，帮你整理周报。直接观看手机端的真实演示。",
    "alt": "手机端回顾近期工作与整理周报的原始演示",
    "image": "/doc-assets/assets/demos/weekly-report/poster.png",
    "width": 540,
    "height": 960,
    "caption": "",
    "video": "/doc-assets/assets/demos/weekly-report/weekly-report.mp4"
  },
  {
    "lang": "en",
    "group": "connections",
    "title": "Take Nova with you",
    "description": "Connect your iPhone over Tailscale to your desktop or headless server. Talk to Nova and approve tasks wherever you are.",
    "alt": "Nova iPhone client and connection settings",
    "image": "/doc-assets/assets/features/iphone.en.png",
    "width": 1262,
    "height": 1246,
    "caption": ""
  },
  {
    "lang": "zh-CN",
    "group": "connections",
    "title": "把 Nova 带在身边",
    "description": "通过 Tailscale 将 iPhone 连到桌面端或无头服务。随时对话，也能在手机上确认任务权限。",
    "alt": "Nova iPhone 客户端与连接设置",
    "image": "/doc-assets/assets/features/iphone.png",
    "width": 1262,
    "height": 1246,
    "caption": ""
  }
];
