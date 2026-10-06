export type FeatureGroup = "use-case" | "feature" | "new";

// 与 README 的「Use Cases / Main Features / New in v0.3」三组卡片一一对应；width / height 是原图尺寸。
export const featureCards: { lang: "en" | "zh-CN"; group: FeatureGroup; title: string; description: string; alt: string; image: string; width: number; height: number; caption: string }[] = [
  {
    "lang": "en",
    "group": "use-case",
    "title": "Your personal workbench",
    "description": "Todos, Ideas, Goals, Feeds and your Profile sit on the left, the conversation with Nova on the right. Start a task from any todo; Nova checks the result against its acceptance criteria, and you can take over or hand it back at any time.",
    "alt": "Workbench window with todos on the left and the conversation with Nova on the right",
    "image": "/doc-assets/assets/features/workbench-window.png",
    "width": 1680,
    "height": 1194,
    "caption": ""
  },
  {
    "lang": "en",
    "group": "use-case",
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
    "group": "use-case",
    "title": "Voice Vibe Coding",
    "description": "Describe a feature and refine it by voice while Codex writes and tests the code. Nova reports key milestones and keeps routine progress quiet.",
    "alt": "Voice requests flow to Codex for coding and testing",
    "image": "/doc-assets/assets/features/coding.en.svg",
    "width": 887,
    "height": 887,
    "caption": ""
  },
  {
    "lang": "en",
    "group": "use-case",
    "title": "Take Nova with you",
    "description": "Connect your iPhone over Tailscale to talk and approve tasks on your PC.",
    "alt": "iPhone home and connection settings",
    "image": "/doc-assets/assets/features/iphone.en.png",
    "width": 1262,
    "height": 1246,
    "caption": ""
  },
  {
    "lang": "en",
    "group": "feature",
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
    "group": "feature",
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
    "group": "feature",
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
    "group": "feature",
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
    "group": "new",
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
    "group": "new",
    "title": "Ideas and goals",
    "description": "Jot down ideas and set goals. Nova suggests more from your sources, and nothing is added without you.",
    "alt": "Ideas and Goals pages with suggestions from Nova",
    "image": "/doc-assets/assets/features/ideas-goals.png",
    "width": 1280,
    "height": 1280,
    "caption": ""
  },
  {
    "lang": "en",
    "group": "new",
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
    "group": "new",
    "title": "Profile and personal memory",
    "description": "See what Nova knows about you, each entry marked as something you said or something from your sources. Continue, correct, forget or purge any of it.",
    "alt": "Profile overview and personal memory controls",
    "image": "/doc-assets/assets/features/profile-memory.en.png",
    "width": 1280,
    "height": 1280,
    "caption": ""
  },
  {
    "lang": "zh-CN",
    "group": "use-case",
    "title": "你的个人工作台",
    "description": "待办、想法、目标、资讯和「关于我」在左侧，和小诺的对话在右侧。从任意一条待办发起任务，小诺对照验收标准核对结果；中途你随时可以接管，也可以交还给它。",
    "alt": "Workbench 窗口：左侧待办，右侧与小诺的对话",
    "image": "/doc-assets/assets/features/workbench-window.png",
    "width": 1680,
    "height": 1194,
    "caption": ""
  },
  {
    "lang": "zh-CN",
    "group": "use-case",
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
    "group": "use-case",
    "title": "Voice Vibe Coding",
    "description": "用语音描述功能、调整需求，Codex 在后台编码与测试。关键进展主动告知，琐碎过程保持安静。",
    "alt": "语音需求交给 Codex，完成编码与测试的流程示意",
    "image": "/doc-assets/assets/features/coding.svg",
    "width": 887,
    "height": 887,
    "caption": ""
  },
  {
    "lang": "zh-CN",
    "group": "use-case",
    "title": "把 Nova 带在身边",
    "description": "iPhone 通过 Tailscale 连接电脑，随时对话和审批。",
    "alt": "iPhone 主界面与连接设置",
    "image": "/doc-assets/assets/features/iphone.png",
    "width": 1262,
    "height": 1246,
    "caption": ""
  },
  {
    "lang": "zh-CN",
    "group": "feature",
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
    "group": "feature",
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
    "group": "feature",
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
    "group": "feature",
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
    "group": "new",
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
    "group": "new",
    "title": "想法与目标",
    "description": "想法随手记，目标慢慢定。小诺会从你的资料里补充建议，但不会自作主张加进来。",
    "alt": "想法和目标页面，以及小诺给出的建议",
    "image": "/doc-assets/assets/features/ideas-goals.png",
    "width": 1280,
    "height": 1280,
    "caption": ""
  },
  {
    "lang": "zh-CN",
    "group": "new",
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
    "group": "new",
    "title": "「关于我」与个人记忆",
    "description": "小诺对你的了解，每条都标明是你说过的还是来自资料；可以接着聊、纠正、忘记，也可以彻底删除。",
    "alt": "Profile 个人概述与记忆管理操作",
    "image": "/doc-assets/assets/features/profile-memory.png",
    "width": 1280,
    "height": 1280,
    "caption": ""
  }
];
