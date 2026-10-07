import { featureCards } from '../lib/home-features';
import { YouTubeCard } from './youtube-card';
import { sitePath } from '../lib/site-path';
import { ArrowRight, ArrowUpRight, Play } from 'lucide-react';
import { Header, Footer, repo } from './site-header';
import { InstallCommand } from './install-command';
import { StarField } from './star-field';
import { HeroHeaderScope } from './hero-header-scope';
export function HomePage({ en = false }: { en?: boolean }) {
  const doc = sitePath(en ? '/en/docs' : '/docs');
  const highlights = en ? [
    ['Real-time conversation', 'Keep talking while tasks run. Clarify a request or change direction whenever you need.'],
    ['Thoughtfully proactive', 'Nova reports meaningful progress and camera events, while routine updates stay quiet.'],
    ['Context that stays with you', 'Recall personal memories and your documents. Keep control through explicit approvals.'],
  ] : [
    ['边聊边做', '后台任务继续，前台对话照常。随时澄清需求、补充要求，或调整方向。'],
    ['主动有分寸', '重要进展、关注的画面变化，及时提醒；琐碎过程保持安静，不抢你说话。'],
    ['理解你的上下文', '结合个人记忆与知识库回答问题，需要授权时先确认，决定权始终在你。'],
  ];
  const preview = en ? [
    ['Context, joined up', 'Beyond your workspaces, Nova keeps the folders you authorize in sync and connects email, calendars and Feishu.'],
    ['Memory with sources', 'What Nova learns becomes structured memory in one ledger, each entry marked as something you said or something from your sources. Correct, forget or purge any of it.'],
    ['Align first, then act', 'Nova clarifies the request with your long-term context before handing it to Codex, then checks the result against its acceptance criteria. Take over or hand it back at any time.'],
    ['Three modes', 'Switch between the Workbench, the orb and background. In background the window hides and the microphone turns off; tasks keep running and the tray shows new reminders.'],
  ] : [
    ['拉通 Context', '除了 PC 上的各个工作区，小诺能持续同步你授权的本地目录，也能接入邮件、日历和飞书。'],
    ['沉淀 Memory', '把信息抽取成结构化记忆，写进统一的记忆账本；每条都标明是你说过的还是来自资料，可以纠正、忘记，也可以彻底删除。'],
    ['先对齐，再执行', '结合长期 Context 先把需求问清，再交给 Codex；结果对照验收标准核对，中途随时可以接管或交还。'],
    ['三种模式', '工作台、悬浮球、后台随时切换。后台时窗口隐藏、麦克风关闭，任务照常跑，新提醒由托盘告诉你。'],
  ];
  const cards = featureCards.filter(card => card.lang === (en ? 'en' : 'zh-CN'));
  const tile = (card: (typeof featureCards)[number]) => (
    <article className="feature-tile" key={card.image}>
      <div className="feature-tile-copy"><h3>{card.title}</h3><p>{card.description}</p></div>
      <a className="feature-image-stage" style={{ aspectRatio: `${card.width} / ${card.height}` }} href={sitePath(card.image)} target="_blank" rel="noreferrer" aria-label={card.alt}><img src={sitePath(card.image)} alt={card.alt} loading="lazy" width={card.width} height={card.height} /></a>
      {card.caption && <p className="feature-caption">{card.caption}</p>}
    </article>
  );
  return (
    <>
      <Header en={en} hero />
      <HeroHeaderScope />
      <main id="main">
        <section className="cosmos-hero theme-dark" id="overview">
          <StarField en={en} />
          <div className="hero-content">
            <p className="hero-kicker">
              {en ? 'A voice agent by DeepNovaCore' : '深穹星核 · 开源语音助手'}
            </p>
            <h1>
              NovaAudioAgent
            </h1>
            <h2>
              {en ? (
                <>
                  Stay in conversation.
                  <br />
                  Keep work moving.
                </>
              ) : (
                <>随时交流，专心做事。</>
              )}
            </h2>
            <p className="hero-description">
              {en
                ? 'A voice agent that listens, remembers, and acts. Talk naturally, explore your documents, or ask Nova to watch for changes—and hear back when it matters.'
                : '能对话、会记忆、也能行动的常驻语音助手。自然交流、查询资料、观察画面，让小诺在值得你关注时主动开口。'}
            </p>
            <div className="hero-actions">
              <a className="button primary" href={doc}>
                {en ? 'Get started' : '开始使用'} <ArrowUpRight size={15} />
              </a>
              <a className="button secondary" href="#demo">
                <Play size={12} />
                {en ? 'Watch on YouTube' : 'YouTube 演示'}
              </a>
            </div>
          </div>
          <div className="hero-bottom">
            <span>
              {en
                ? 'Always present. Thoughtfully proactive.'
                : '干活不停，言语有度。'}
            </span>
            <a href="#demo" aria-label={en ? 'Explore Nova' : '了解 Nova'}>
              ↓
            </a>
            <span>Apache 2.0</span>
          </div>
        </section>
        <section className="intro-section reading" id="demo">
          <p className="section-label">{en ? 'Meet Nova' : '认识小诺'}</p>
          <h2>
            {en ? (
              <>
                A little less switching.
                <br />A little more doing.
              </>
            ) : (
              <>
                少一点来回切换，
                <br />
                多一点专心做事。
              </>
            )}
          </h2>
          <p className="lead">
            {en
              ? 'Human-centric AI understands you before it helps. Nova sits between you and executors like Codex, connecting real-time voice with a Workbench for your todos, goals and delegated tasks, plus camera monitoring, personal memory, and document knowledge. Stay in conversation on your desktop or from your iPhone.'
              : '以人为中心的 AI，先了解你、理解你，再帮到你。小诺站在你和 Codex 这样的执行器之间，把实时语音、Workbench 里的待办与任务、视觉监控、个人记忆和知识库连在一起，也能通过 iPhone 随身连接。'}
          </p>
        </section>
        <div className="demo-media wrap"><YouTubeCard en={en} /></div>
        <section className="home-highlights wrap" aria-label={en ? 'Highlights' : '核心特性'}>
          {highlights.map(([title, body], i) => <article key={title}><span className="section-label">0{i + 1}</span><h2>{title}</h2><p>{body}</p></article>)}
        </section>
        <section className="main-features wrap" id="whats-new">
          <div className="main-features-heading"><p className="section-label">{en ? 'Personal agent · v0.3.0' : '个人 Agent · v0.3.0'}</p><h2>{en ? 'Understands what you mean. Helps with what you need.' : '懂你所想，帮你所需。'}</h2></div>
          <p>{en ? 'Install or upgrade: ' : '安装或升级：'}<code>npm install --global nova-audio-agent@latest</code>{en ? '.' : '。'}</p>
          <div className="home-highlights preview-grid">{preview.map(([title, body]) => <article key={title}><h3>{title}</h3><p>{body}</p></article>)}</div>
        </section>
        <section className="main-features wrap" id="features">
          <div className="main-features-heading"><p className="section-label">{en ? 'Use cases' : '使用场景'}</p><h2>{en ? 'More ways to work with Nova.' : '从一句话，到更多可能。'}</h2></div>
          <div className="feature-gallery">{cards.filter(card => card.group === 'use-case').map(tile)}</div>
          <div className="main-features-heading feature-group-heading"><p className="section-label">{en ? 'Main features' : '核心功能'}</p><h2>{en ? 'You stay in control.' : '每一步，都由你做主。'}</h2></div>
          <div className="feature-gallery">{cards.filter(card => card.group === 'feature').map(tile)}</div>
          <div className="main-features-heading feature-group-heading"><p className="section-label">{en ? 'New in v0.3' : 'v0.3 新功能'}</p><h2>{en ? 'Your day, on one Workbench.' : '一天的事，都在工作台上。'}</h2></div>
          <div className="feature-gallery">{cards.filter(card => card.group === 'new').map(tile)}</div>
        </section>
        <section className="philosophy" id="design">
          <div className="reading">
            <p className="section-label">
              {en ? 'The thinking behind Nova' : '我们的思考'}
            </p>
            <h2>
              {en ? (
                <>
                  Knowing what to say.
                  <br />
                  And when to say it.
                </>
              ) : (
                <>
                  知道怎么回答，
                  <br />
                  也知道何时开口。
                </>
              )}
            </h2>
            <p className="lead">
              {en
                ? 'An update is only useful if it deserves your attention. Nova treats doing the work and deciding when to speak as separate responsibilities.'
                : '并非每一条进度，都值得打断你。Nova 将“把事做好”和“何时告知”分开考虑，让任务持续推进，也让你的注意力得到尊重。'}
            </p>
            <div className="architecture-strip">
              <div>
                <small>01</small>
                <strong>{en ? 'Work progresses' : '任务有了进展'}</strong>
                <span>Executor / Memory</span>
              </div>
              <span className="flow-arrow">→</span>
              <div>
                <small>02</small>
                <strong>
                  {en ? 'Consider the value' : '判断是否值得告知'}
                </strong>
                <span>Proactive</span>
              </div>
              <span className="flow-arrow">→</span>
              <div>
                <small>03</small>
                <strong>{en ? 'Find the moment' : '等待合适的时机'}</strong>
                <span>Floor / Voice</span>
              </div>
            </div>
            <a className="text-link" href={doc + '/architecture/'}>
              {en ? 'Explore the architecture' : '了解运行时架构'}{' '}
              <ArrowRight size={14} />
            </a>
          </div>
        </section>
        <section className="start-section reading" id="quickstart">
          <p className="section-label">{en ? 'Get started' : '从这里开始'}</p>
          <h2>{en ? 'Your next task starts here.' : '下一件事，交给小诺。'}</h2>
          <p className="lead">
            {en
              ? 'Install Nova, configure your API keys, and start a conversation.'
              : '安装 Nova，配置 API Key，就可以开始对话。'}
          </p>
          <InstallCommand en={en} />
          <p className="requirements">
            Node.js 22+ · npm ·{' '}
            {en ? 'Codex required for coding tasks' : '编码任务需另行安装并登录 Codex'}
          </p>
          <div className="resource-links">
            <a href={doc}>
              {en ? 'Read the documentation' : '阅读使用文档'}{' '}
              <ArrowUpRight size={16} />
            </a>
            <a href={repo} target="_blank" rel="noreferrer">
              {en ? 'Explore the source' : '查看项目源码'}{' '}
              <ArrowUpRight size={16} />
            </a>
          </div>
        </section>
      </main>
      <Footer en={en} />
    </>
  );
}
