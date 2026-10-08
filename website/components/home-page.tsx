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
    ['Voice and text, together', 'Keep talking while work runs. Clarify a request, add constraints or change direction.'],
    ['Conversation beside your tasks', 'Todos, Ideas, Goals, Feeds, Tasks and Profile sit beside the conversation. Switch to the orb, or run in background with the microphone off.'],
    ['Context from your sources', 'Connect folders, mail, calendars and Feishu. Source access and permission for model processing are separate choices.'],
    ['Memory with sources', 'Trace what Nova learns to its evidence. Correct, forget or purge it; imported document knowledge stays separate.'],
    ['Tasks you can check', 'Clarify goals, confirm the execution place and delegate to Codex. Nova checks evidence against acceptance criteria; take over and return control at any time.'],
    ['Thoughtfully proactive', 'Meaningful progress, camera events and optional daily briefs get your attention at an appropriate moment. Routine updates stay quiet.'],
  ] : [
    ['语音与文字一起用', '后台任务继续，前台对话照常。随时澄清需求、补充约束或调整方向。'],
    ['对话与任务并排', '待办、想法、目标、资讯、任务和「关于我」与对话并排。切成悬浮球，或关闭麦克风在后台继续执行。'],
    ['上下文来自你的资料', '接入文件夹、邮件、日历和飞书；读取来源与允许模型处理内容，是两项独立的授权。'],
    ['个人记忆带着出处', '追溯小诺学到的信息，纠正、忘记或彻底删除；主动导入的文档知识库保持独立。'],
    ['任务可执行、可验收', '问清目标，确认执行位置，再交给 Codex；小诺按验收标准核对证据，你可以随时接管和交还。'],
    ['主动有分寸', '重要进展、关注的画面变化和可选每日简报，在合适时机提醒；琐碎更新保持安静。'],
  ];
  const featureGroups = en ? [
    ['workbench', 'Your workbench and context'],
    ['tasks', 'Delegate and steer work'],
    ['connections', 'Observe and stay connected'],
  ] : [
    ['workbench', '工作台与个人上下文'],
    ['tasks', '交办任务，随时调整'],
    ['connections', '观察画面，随身连接'],
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
              {en ? 'A personal agent by DeepNovaCore' : '深穹星核 · 开源个人 Agent'}
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
                ? 'A personal agent that understands your context, keeps work moving through conversation, checks results, and speaks when it matters.'
                : '理解你的上下文，通过对话推进工作，结果可验收，主动有分寸。'}
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
              ? 'Talk through a goal, organize your todos, ideas and goals on the Workbench, and follow delegated work through to an evidence-backed result. Nova draws on the sources you authorize, keeps memory traceable, and lets you take over whenever you need.'
              : '一起问清目标，在 Workbench 中整理待办、想法与目标，再跟进任务直到得到有证据的结果。小诺结合你授权的资料，保留记忆出处；需要时，你随时可以接管。'}
          </p>
        </section>
        <div className="demo-media wrap"><YouTubeCard en={en} /></div>
        <section className="home-highlights wrap" id="whats-new" aria-label={en ? 'Highlights' : '核心特性'}>
          {highlights.map(([title, body], i) => <article key={title}><span className="section-label">0{i + 1}</span><h2>{title}</h2><p>{body}</p></article>)}
        </section>
        <section className="main-features wrap" id="features">
          <div className="main-features-heading"><p className="section-label">{en ? 'Work with Nova' : '和小诺一起做事'}</p><h2>{en ? 'From context to an outcome.' : '从理解上下文，到把事情做好。'}</h2></div>
          {featureGroups.map(([group, title]) => <div key={group}>
            <div className="main-features-heading feature-group-heading"><h2>{title}</h2></div>
            <div className="feature-gallery">{cards.filter(card => card.group === group).map(tile)}</div>
          </div>)}
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
                <span>Executor / Runtime blackboard</span>
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
                <span>Floor / Conversation</span>
              </div>
            </div>
            <a className="text-link" href={doc + '/architecture/'}>
              {en ? 'Explore the personal agent architecture' : '了解个人 Agent 架构'}{' '}
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
