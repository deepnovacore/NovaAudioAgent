import { ArrowUpRight, BookOpen, Brain, Layers, Rocket, Settings2, Smartphone, Workflow, Table2, Play } from 'lucide-react';
import pages from '../generated/docs.json';
import { sitePath } from '../lib/site-path';
import { YouTubeCard } from './youtube-card';
const icons = { 'getting-started': Rocket, features: Layers, 'knowledge-base': BookOpen, 'personal-memory': Brain, iphone: Smartphone, configuration: Settings2, architecture: Workflow, 'support-matrix': Table2 };
export function DocsIndex({ en = false }: { en?: boolean }) {
  const lang = en ? 'en' : 'zh-CN';
  const index = pages.find(p => p.lang === lang && p.slug === '')!;
  const architecture = pages.find(p => p.lang === lang && p.slug === 'architecture')!;
  return <div className="docs-index">
    <div className="docs-index-heading"><span className="eyebrow">{en ? 'DOCUMENTATION' : '使用指南'}</span><h1>{index.title}</h1><p>{architecture.intro}</p><a className="youtube-link" href="#demo"><Play size={19} />{en ? 'Watch the demo' : '观看演示'}<ArrowUpRight size={14} /></a></div>
    <section className="docs-demo" id="demo"><YouTubeCard en={en} /></section>
    <div className="guide-grid">{index.entries.filter(entry => entry.slug !== 'architecture').map((entry, i) => {
      const Icon = icons[entry.slug as keyof typeof icons] || BookOpen;
      return <a href={sitePath(entry.url)} className={`guide-card${i === 0 ? ' guide-featured' : ''}`} key={entry.url}>
        <span className="guide-icon"><Icon size={22} strokeWidth={1.5} /></span>
        <span className="guide-copy"><strong>{entry.title}</strong><span>{entry.description}</span></span>
        <ArrowUpRight className="guide-arrow" size={18} strokeWidth={1.5} />
      </a>;
    })}</div>
    {architecture.imageUrl && <section className="overview-diagram overview-blackboard"><div className="overview-diagram-heading"><h2>{architecture.title}</h2><a href={sitePath(architecture.url)}>{en ? 'Read more' : '了解详情'} <ArrowUpRight size={14} /></a></div><a className="blackboard-image" href={architecture.imageUrl} target="_blank" rel="noreferrer" aria-label={en ? 'Open architecture diagram at full size' : '查看完整架构图'}><img src={architecture.imageUrl} alt={en ? 'Nova runtime blackboard architecture' : 'Nova 运行时黑板架构'} width={1664} height={946} /></a></section>}

  </div>;
}
