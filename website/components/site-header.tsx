import { sitePath } from '../lib/site-path';
import { ArrowUpRight } from 'lucide-react';
import { DocsSearch } from './docs-search';
import { LanguageSwitch } from './language-switch';
import { ThemeToggle } from './theme-toggle';
function NovaMark() {
  return <svg className="nova-mark" viewBox="0 0 32 32" fill="currentColor" aria-hidden="true">
    <path d="M16 1.5 19.2 12.8 30.5 16 19.2 19.2 16 30.5 12.8 19.2 1.5 16 12.8 12.8Z" />
    <path d="m5.4 5.4 8.2 4.7-3.5 3.5Zm21.2 0-4.7 8.2-3.5-3.5Zm0 21.2-8.2-4.7 3.5-3.5Zm-21.2 0 4.7-8.2 3.5 3.5Z" opacity=".65" />
  </svg>;
}
export const repo = 'https://github.com/deepnovacore/NovaAudioAgent';
export function Header({
  en = false,
  docs = false,
  alternate,
  section,
  hero = false,
}: {
  en?: boolean;
  docs?: boolean;
  alternate?: string;
  section?: 'users' | 'developers';
  hero?: boolean;
}) {
  const home = sitePath(en ? '/' : '/zh');
  const doc = sitePath(en ? '/en/docs' : '/docs');
  const developers = doc + '/archs/00-overview';
  return (
    <>
      <a className="skip" href="#main">
        {en ? 'Skip to content' : '跳转到正文'}
      </a>
      <header className={hero ? 'header theme-dark' : 'header'}>
        <div className="header-leading">
        <a href={home} className="brand" aria-label="Nova Audio Agent">
          <NovaMark />
          <span className="brand-name">nova</span>
          <span className="brand-caption">{en ? 'by DeepNovaCore' : '深穹星核'}</span>
        </a>
        <DocsSearch en={en} />
        </div>
        <nav aria-label={en ? 'Main navigation' : '主导航'}>
          <a className="audience-tab" href={doc} aria-current={section === 'users' ? 'page' : undefined}>
            {en ? 'Users' : '用户指南'}
          </a>
          <a className="audience-tab" href={developers} aria-current={section === 'developers' ? 'page' : undefined}>
            {en ? 'Developers' : '开发文档'}
          </a>
          <a className="nav-github" href={repo} target="_blank" rel="noreferrer">
            GitHub <ArrowUpRight size={12} />
          </a>
          <div className="header-controls">
            <ThemeToggle en={en} />
            <LanguageSwitch en={en} docs={docs} alternate={alternate} />
          </div>
        </nav>
      </header>
    </>
  );
}
export function Footer({ en = false }: { en?: boolean }) {
  return (
    <footer className="footer wrap">
      <a className="brand" href={sitePath(en ? '/' : '/zh')}>
        <NovaMark />nova
      </a>
      <span>© 2026 {en ? 'DeepNovaCore' : '深穹星核'}</span>
      <a href={repo + '/blob/main/LICENSE'}>Apache 2.0 ↗</a>
    </footer>
  );
}
