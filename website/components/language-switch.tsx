'use client';
import { sitePath } from '../lib/site-path';
export function LanguageSwitch({
  en = false,
  docs = false,
  alternate,
}: {
  en?: boolean;
  docs?: boolean;
  alternate?: string;
}) {
  const target = sitePath(alternate ?? (docs ? (en ? '/docs' : '/en/docs') : (en ? '/zh' : '/')));
  function follow(e: React.MouseEvent<HTMLAnchorElement>) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    const sections = Array.from(
      document.querySelectorAll<HTMLElement>('main section[id]'),
    );
    let anchor = window.location.hash;
    const active = sections
      .filter((s) => s.getBoundingClientRect().top < innerHeight * 0.45)
      .at(-1);
    if (active) anchor = '#' + active.id;
    window.location.assign(target + (docs ? '' : anchor));
  }
  return (
    <a
      href={target}
      onClick={follow}
      className="language-switch"
      lang={en ? 'zh-CN' : 'en'}
      aria-label={en ? '切换到中文' : 'Switch to English'}
    >
      {en ? '中文' : 'EN'}
      <span aria-hidden="true">⌄</span>
    </a>
  );
}
