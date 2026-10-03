import { sitePath } from '../lib/site-path';
import { developerGroups, isDeveloperDoc, userSlugs } from '../lib/docs-navigation';
import { Header, Footer, repo } from './site-header';
import pages from '../generated/docs.json';
import { DocBody } from './doc-body';
import { DocsMobileNav } from './docs-mobile-nav';
import { DocsIndex } from './docs-index';
import { notFound } from 'next/navigation';

export function DocsPage({ en = false, slug = '' }: { en?: boolean; slug?: string }) {
  const lang = en ? 'en' : 'zh-CN';
  const page = pages.find(p => p.lang === lang && p.slug === slug);
  if (!page) return notFound();
  const developers = isDeveloperDoc(slug);
  const groups = developers ? developerGroups : [{ en: 'User guides', zh: '用户指南', slugs: userSlugs }];
  const navigation = groups.map(group => ({ title: en ? group.en : group.zh, pages: group.slugs.map(s => pages.find(p => p.lang === lang && p.slug === s)).filter(p => p !== undefined) }));
  const label = (p: typeof page) => !p.slug ? (en ? 'Overview' : '文档概览') : p.title.replace(/^\d+\.\s*/, '');
  return <>
    <Header en={en} docs section={developers ? 'developers' : 'users'} alternate={page.alternate} />
    <main id="main" className={`docs-layout wrap${slug ? '' : ' docs-overview-layout'}`}>
      <DocsMobileNav en={en} current={sitePath(page.url)} groups={navigation.map(group => ({ title: group.title, items: group.pages.map(p => ({url: sitePath(p.url), title: label(p)})) }))} />
      <aside className="docs-sidebar">
        {navigation.map(group => <div className="docs-nav-group" key={group.title}><p className="nav-group-label">{group.title}</p>
          <nav aria-label={group.title}>{group.pages.map(p => <a key={p.url} href={sitePath(p.url)} aria-current={p.url === page.url ? 'page' : undefined}>{label(p)}</a>)}</nav>
        </div>)}
        <a className="source-link" href={`${repo}/blob/main/docs/${page.relative}`}>{en ? 'View source ↗' : '查看源文档 ↗'}</a>
      </aside>
      <article className="docs-article">{slug ? <DocBody html={page.html} /> : <DocsIndex en={en} />}</article>
      {slug && page.toc.length > 0 && <aside className="docs-toc"><p>{en ? 'On this page' : '本页目录'}</p><nav>{page.toc.map(item => <a key={item.id} href={'#' + item.id} className={item.depth === 3 ? 'nested' : ''}>{item.title}</a>)}</nav></aside>}
    </main>
    <Footer en={en} />
  </>;
}
