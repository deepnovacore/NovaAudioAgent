/* oxlint-disable jsx-a11y/media-has-caption -- Keep the supplied original demo without added subtitles. */
import Image from 'next/image';
import { featureCards } from '../lib/home-features';
import { sitePath } from '../lib/site-path';
import { ArrowRight, ArrowUpRight } from 'lucide-react';
import { Header, Footer, repo } from './site-header';
import { InstallCommand } from './install-command';
import { StarField } from './star-field';
import { HeroHeaderScope } from './hero-header-scope';
export function HomePage({ en = false }: { en?: boolean }) {
  const doc = sitePath(en ? '/en/docs' : '/docs');
  const highlights = en ? [
    ['Your proactive personal agent', 'Todos, Ideas, Goals, Feeds and Profile turn your context into suggestions you can act on.'],
    ['Wide and unstructured context', 'Connect folders, mail, calendars, conversations and documents. Keep personal memory traceable, editable and removable.'],
    ['Always-on voice, dual brains', 'The front brain stays in conversation while the back brain handles long-running work.'],
    ['A thin frontend task coordinator', 'Clarify, authorize and delegate to a coding agent. Check evidence, take over and hand control back.'],
    ['Restrained proactivity', 'Nova chooses what matters and when to speak. Routine updates stay quiet, and reminders respect your turn.'],
  ] : [
    ['你的主动式个人 Agent', '待办、想法、目标、资讯和 Profile，把 Nova 对你的了解变成可以行动的建议。'],
    ['广泛、非结构化的上下文', '接入文件夹、邮件、日历、对话和文档。个人记忆可追溯、可编辑、可删除。'],
    ['常驻语音，前后双脑协作', '前脑陪你交流，后脑处理长时间运行的工作。'],
    ['薄而清晰的前台任务协调层', '问清目标、确认授权，再委派给 coding agent。按证据核验，随时接管和交还。'],
    ['主动有分寸', '判断什么值得提醒、什么时候开口。琐碎更新保持安静，不抢你的话。'],
  ];
  const featureGroups = en ? [
    ['workbench', 'Your personal agent'],
    ['tasks', 'Your voice assistant'],
    ['connections', 'Use cases'],
  ] : [
    ['workbench', '你的个人 Agent'],
    ['tasks', '你的语音助手'],
    ['connections', '使用案例'],
  ];
  const cards = featureCards.filter(card => card.lang === (en ? 'en' : 'zh-CN'));
  const tile = (card: (typeof featureCards)[number]) => (
    <article className="feature-tile" key={card.image}>
      <div className="feature-tile-copy"><h3>{card.title}</h3><p>{card.description}</p></div>
      {card.video ? (
        <div className="feature-image-stage feature-video-stage">
          <video controls preload="none" poster={sitePath(card.image)} aria-label={card.alt} width={card.width} height={card.height}>
            <source src={sitePath(card.video)} type="video/mp4" />
            <a href={sitePath(card.video)}>{en ? 'Watch the demo' : '播放演示'}</a>
          </video>
          <a className="feature-video-link" href={sitePath(card.video)}>{en ? 'Open video' : '打开视频'} <ArrowUpRight size={14} /></a>
        </div>
      ) : <a className="feature-image-stage" style={{ aspectRatio: `${card.width} / ${card.height}` }} href={sitePath(card.image)} target="_blank" rel="noreferrer" aria-label={card.alt}><Image src={sitePath(card.image)} alt={card.alt} loading="lazy" width={card.width} height={card.height} /></a>}
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
              {en ? 'Your Personal Agent and Voice Assistant' : '你的个人 Agent 与语音助手'}
            </p>
            <h1>
              NovaAudioAgent
            </h1>
            <h2>
              {en ? (
                <>
                  Knows your context.
                  <br />
                  Gets things done.
                </>
              ) : (
                <>懂你的上下文，把事做成。</>
              )}
            </h2>
            <p className="hero-description">
              {en
                ? 'Todos, ideas and goals on one workbench, memory you can trace, and tasks checked against evidence.'
                : '待办、想法与目标集中在一个工作台，记忆可追溯，任务按证据验收。'}
            </p>
            <div className="hero-actions">
              <a className="button primary" href={doc}>
                {en ? 'Get started' : '开始使用'} <ArrowUpRight size={15} />
              </a>
            </div>
          </div>
          <div className="hero-bottom">
            <span aria-hidden="true" />
            <a href="#demo" aria-label={en ? 'Explore Nova' : '了解 Nova'}>
              ↓
            </a>
            <span>Apache 2.0</span>
          </div>
        </section>
        <section className="intro-section reading" id="demo">
          <p className="section-label">{en ? 'Meet Nova' : '认识 Nova'}</p>
          <h2>
            {en ? <>Remembers what matters.</> : <>记住重要的事。</>}
          </h2>
          <p className="lead">
            {en
              ? 'Talk through a goal, organize your todos, ideas and goals on the Workbench, and follow delegated work through to an evidence-backed result. Nova draws on the sources you authorize, keeps memory traceable, and lets you take over whenever you need.'
              : '一起问清目标，在 Workbench 中整理待办、想法与目标，再跟进任务直到得到有证据的结果。Nova 结合你授权的资料，保留记忆出处；需要时，你随时可以接管。'}
          </p>
        </section>
        <figure className="architecture-overview wrap">
          <a href={sitePath(`/doc-assets/assets/architecture/nova-personal-agent.${en ? 'en' : 'zh-CN'}.png`)} aria-label={en ? 'View Nova architecture' : '查看 Nova 架构图'}>
            <Image src={sitePath(`/doc-assets/assets/architecture/nova-personal-agent.${en ? 'en' : 'zh-CN'}.png`)} alt={en ? 'Nova personal agent: app context, conversation, task coordination and specialist execution' : 'Nova 个人 Agent：应用上下文、对话、任务协调与专长执行'} loading="lazy" width={1586} height={992} />
          </a>
          <figcaption>{en ? 'Your context informs the conversation. Nova coordinates work, checks results, and speaks when it matters.' : '上下文帮助理解，对话协调执行；结果按证据核对，提醒在合适时机开口。'}</figcaption>
        </figure>
        <section className="home-highlights wrap" id="whats-new" aria-label={en ? 'Highlights' : '核心特性'}>
          {highlights.map(([title, body], i) => <article key={title}><span className="section-label">0{i + 1}</span><h2>{title}</h2><p>{body}</p></article>)}
        </section>
        <section className="main-features wrap" id="features">
          <div className="main-features-heading"><p className="section-label">{en ? 'Work with Nova' : '和 Nova 一起做事'}</p><h2>{en ? 'From context to an outcome.' : '从理解上下文，到把事情做好。'}</h2></div>
          {featureGroups.map(([group, title], i) => <div key={group}>
            <div className="main-features-heading feature-group-heading" data-index={`0${i + 1}`}><h3>{title}</h3></div>
            <div className="feature-gallery">{cards.filter(card => card.group === group).map(tile)}</div>
          </div>)}
        </section>
        <section className="philosophy" id="design">
          <div className="reading">
            <p className="section-label">
              {en ? 'The thinking behind Nova' : '我们的思考'}
            </p>
            <h2>
              {en ? <>Helpful, not wordy.</> : <>有用，但不啰嗦。</>}
            </h2>
            <p className="lead">
              {en
                ? 'Nova works from the sources you authorize, shows the evidence behind its results, and speaks up only when it matters. You can take over at any time.'
                : 'Nova 只基于你授权的资料工作，给出结果背后的证据，只在值得的时候开口。需要时，你随时可以接管。'}
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
          <h2>{en ? 'Your next task starts here.' : '下一件事，交给 Nova。'}</h2>
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
