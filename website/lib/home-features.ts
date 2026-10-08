export type FeatureGroup = "workbench" | "tasks" | "connections";

// 与中英 README 的三组场景卡片对应；width / height 是原图尺寸。
export const featureCards: { lang: "en" | "zh-CN"; group: FeatureGroup; title: string; description: string; alt: string; image: string; width: number; height: number; caption: string }[] = [
  {
    "lang": "en",
    "group": "workbench",
    "title": "Your personal workbench",
    "description": "Todos, Ideas, Goals, Feeds, Tasks and Profile sit beside your conversation with Nova. Switch to the voice orb, or hide the window and turn off the microphone while tasks keep running.",
    "alt": "Workbench window with todos on the left and the conversation with Nova on the right",
    "image": "/doc-assets/assets/features/workbench-window.png",
    "width": 1680,
    "height": 1194,
    "caption": ""
  },
  {
    "lang": "en",
    "group": "workbench",
    "title": "Profile and personal memory",
    "description": "See what Nova knows about you, each entry marked as something you said or something from your sources. Continue, correct, forget or purge any of it.",
    "alt": "Profile overview and personal memory controls",
    "image": "/doc-assets/assets/features/profile-memory.en.png",
    "width": 1280,
    "height": 1280,
    "caption": ""
  },
  {
    "lang": "en",
    "group": "workbench",
    "title": "Todos and project recaps",
    "description": "Recent project activity becomes recap cards and suggested next steps, each with its sources. Pick one and ask Nova to help.",
    "alt": "Workbench project recaps and next-step suggestions",
    "image": "/doc-assets/assets/features/workbench.en.png",
    "width": 1280,
    "height": 1280,
    "caption": ""
  },
  {
    "lang": "en",
    "group": "workbench",
    "title": "Ideas and goals",
    "description": "Jot down ideas and set goals. Review source-grounded suggestions before adopting them.",
    "alt": "Ideas and Goals pages with suggestions from Nova",
    "image": "/doc-assets/assets/features/ideas-goals.png",
    "width": 1280,
    "height": 1280,
    "caption": ""
  },
  {
    "lang": "en",
    "group": "workbench",
    "title": "Feeds ranked by your interests",
    "description": "Nova infers your interests from your Profile and ranks public news by them. Save an item, or turn it into an idea, todo or goal of your own.",
    "alt": "Interest-ranked news feed",
    "image": "/doc-assets/assets/features/feeds.png",
    "width": 1280,
    "height": 1280,
    "caption": ""
  },
  {
    "lang": "en",
    "group": "workbench",
    "title": "Bring your tools and knowledge",
    "description": "Configure ASR / LLM / TTS and MCP; ask questions across your documents.",
    "alt": "Knowledge-base answer using the CN-27 demo documents",
    "image": "/doc-assets/assets/features/knowledge.en.png",
    "width": 1276,
    "height": 1233,
    "caption": ""
  },
  {
    "lang": "en",
    "group": "tasks",
    "title": "Understands what you mean",
    "description": "Describe your goal naturally. Nova asks for the missing details before turning it into a task.",
    "alt": "Nova clarifies the requested application before starting",
    "image": "/doc-assets/assets/features/conversation.en.png",
    "width": 1277,
    "height": 1232,
    "caption": ""
  },
  {
    "lang": "en",
    "group": "tasks",
    "title": "Voice Vibe Coding",
    "description": "Clarify a goal, let Codex work in the background, and refine it by voice or text. Nova checks task evidence against acceptance criteria; take over and hand it back at any time.",
    "alt": "Voice requests flow to Codex for coding and testing",
    "image": "/doc-assets/assets/features/coding.en.svg",
    "width": 887,
    "height": 887,
    "caption": ""
  },
  {
    "lang": "en",
    "group": "tasks",
    "title": "Voice-run workspaces",
    "description": "Create and switch workspaces and sessions by voice. A new workspace waits for your confirmation.",
    "alt": "Nova waits for approval to create a workspace",
    "image": "/doc-assets/assets/features/workspace.en.png",
    "width": 887,
    "height": 887,
    "caption": ""
  },
  {
    "lang": "en",
    "group": "tasks",
    "title": "You control permissions",
    "description": "Review requests to run commands or access the network, then allow or deny them.",
    "alt": "Network permission request with allow and deny controls",
    "image": "/doc-assets/assets/features/permission.en.png",
    "width": 887,
    "height": 887,
    "caption": ""
  },
  {
    "lang": "en",
    "group": "connections",
    "title": "Camera monitoring and timely alerts",
    "description": "Ask Nova to watch for a condition and tell you when it occurs.",
    "alt": "Camera observation and spoken alert",
    "image": "/doc-assets/assets/features/vision-camera.png",
    "width": 1280,
    "height": 720,
    "caption": "Camera observation: a tabby cat has climbed onto the sofa."
  },
  {
    "lang": "en",
    "group": "connections",
    "title": "Take Nova with you",
    "description": "Connect your iPhone over Tailscale to Nova on macOS or an Ubuntu headless server, then talk and approve tasks from your phone.",
    "alt": "iPhone home and connection settings",
    "image": "/doc-assets/assets/features/iphone.en.png",
    "width": 1262,
    "height": 1246,
    "caption": ""
  },
  {
    "lang": "zh-CN",
    "group": "workbench",
    "title": "你的个人工作台",
    "description": "待办、想法、目标、资讯、任务和「关于我」与对话并排。可以切成悬浮球，也可以隐藏窗口、关闭麦克风，让任务继续运行。",
    "alt": "Workbench 窗口：左侧待办，右侧与小诺的对话",
    "image": "/doc-assets/assets/features/workbench-window.png",
    "width": 1680,
    "height": 1194,
    "caption": ""
  },
  {
    "lang": "zh-CN",
    "group": "workbench",
    "title": "「关于我」与个人记忆",
    "description": "小诺对你的了解，每条都标明是你说过的还是来自资料；可以接着聊、纠正、忘记，也可以彻底删除。",
    "alt": "Profile 个人概述与记忆管理操作",
    "image": "/doc-assets/assets/features/profile-memory.png",
    "width": 1280,
    "height": 1280,
    "caption": ""
  },
  {
    "lang": "zh-CN",
    "group": "workbench",
    "title": "待办与项目回顾",
    "description": "根据最近的项目动态生成回顾卡片和下一步建议，每条都带出处；挑一条，就能让小诺接着做。",
    "alt": "Workbench 中的项目回顾与下一步建议",
    "image": "/doc-assets/assets/features/workbench.png",
    "width": 1280,
    "height": 1280,
    "caption": ""
  },
  {
    "lang": "zh-CN",
    "group": "workbench",
    "title": "想法与目标",
    "description": "想法随手记，目标慢慢定；小诺从你的资料里提出建议，由你决定是否采纳。",
    "alt": "想法和目标页面，以及小诺给出的建议",
    "image": "/doc-assets/assets/features/ideas-goals.png",
    "width": 1280,
    "height": 1280,
    "caption": ""
  },
  {
    "lang": "zh-CN",
    "group": "workbench",
    "title": "按兴趣排序的资讯",
    "description": "从「关于我」推断你关心的方向，给公开资讯排序；看到有用的，可以收藏，或转成自己的想法、待办和目标。",
    "alt": "按兴趣排序的资讯流",
    "image": "/doc-assets/assets/features/feeds.png",
    "width": 1280,
    "height": 1280,
    "caption": ""
  },
  {
    "lang": "zh-CN",
    "group": "workbench",
    "title": "接入工具与知识",
    "description": "自由配置 ASR / LLM / TTS 和 MCP，基于自己的资料问答。",
    "alt": "基于 CN-27 演示资料的知识库回答",
    "image": "/doc-assets/assets/features/knowledge.png",
    "width": 720,
    "height": 696,
    "caption": ""
  },
  {
    "lang": "zh-CN",
    "group": "tasks",
    "title": "理解意图，问清再做",
    "description": "自然描述目标，Nova 理解你的意图，问清缺失信息后再开始任务。",
    "alt": "Nova 在开始任务前澄清应用形式与需求",
    "image": "/doc-assets/assets/features/conversation.png",
    "width": 1276,
    "height": 1233,
    "caption": ""
  },
  {
    "lang": "zh-CN",
    "group": "tasks",
    "title": "Voice Vibe Coding",
    "description": "问清目标，交给 Codex 在后台执行，再用语音或文字补充要求。小诺对照验收标准核对任务证据；你随时可以接管，再交还给它。",
    "alt": "语音需求交给 Codex，完成编码与测试的流程示意",
    "image": "/doc-assets/assets/features/coding.svg",
    "width": 887,
    "height": 887,
    "caption": ""
  },
  {
    "lang": "zh-CN",
    "group": "tasks",
    "title": "语音管理工作区",
    "description": "用语音创建、切换工作区和会话；新建工作区前，先等你点头。",
    "alt": "Nova 等待你确认创建工作区",
    "image": "/doc-assets/assets/features/workspace.png",
    "width": 887,
    "height": 887,
    "caption": ""
  },
  {
    "lang": "zh-CN",
    "group": "tasks",
    "title": "操作权限，由你决定",
    "description": "执行命令或访问网络需要额外权限时，查看请求并选择允许或拒绝。",
    "alt": "带允许和拒绝选项的网络访问请求",
    "image": "/doc-assets/assets/features/permission.png",
    "width": 887,
    "height": 887,
    "caption": ""
  },
  {
    "lang": "zh-CN",
    "group": "connections",
    "title": "视觉监控与主动提醒",
    "description": "告诉 Nova 要关注的画面变化，条件触发时主动提醒。",
    "alt": "摄像头观察结果与主动播报",
    "image": "/doc-assets/assets/features/vision-camera.png",
    "width": 1280,
    "height": 720,
    "caption": "画面观察：虎斑猫已爬上沙发。"
  },
  {
    "lang": "zh-CN",
    "group": "connections",
    "title": "把 Nova 带在身边",
    "description": "iPhone 通过 Tailscale 连接 macOS 上的小诺或 Ubuntu 无头服务，随时对话和审批。",
    "alt": "iPhone 主界面与连接设置",
    "image": "/doc-assets/assets/features/iphone.png",
    "width": 1262,
    "height": 1246,
    "caption": ""
  }
];
