'use client';
import { useEffect, useMemo, useState } from 'react';
import { FileText, Search, ArrowUpRight, X } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogClose, DialogTrigger } from './ui/dialog';
import { Command, CommandInput, CommandList, CommandItem } from './ui/command';
import { searchDocs, type SearchPage } from '../lib/docs-search';
import { sitePath } from '../lib/site-path';
function Highlight({ text, query }: { text: string; query: string }) {
  const terms = query.trim().split(/\s+/u).filter(Boolean).map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!terms.length) return <>{text}</>;
  const regex = new RegExp(`(${terms.join('|')})`, 'giu');
  return <>{text.split(regex).map((part, index) => index % 2 ? <mark key={index}>{part}</mark> : part)}</>;
}
export function DocsSearch({ en = false }: { en?: boolean }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [pages, setPages] = useState<SearchPage[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !event.isComposing) { event.preventDefault(); setOpen(value => !value); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!open || pages) return;
    let cancelled = false;
    setFailed(false);
    import('../generated/search.json').then(module => { if (!cancelled) setPages(module.default); }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [open, pages]);
  const results = useMemo(() => searchDocs(pages || [], query, en ? 'en' : 'zh-CN'), [pages, query, en]);
  return <Dialog open={open} onOpenChange={value => { setOpen(value); if (!value) setQuery(''); }}>
    <DialogTrigger className="docs-search-trigger" aria-label={en ? 'Search documentation' : '搜索文档'}><Search size={16} /><span>{en ? 'Search docs' : '搜索文档'}</span><kbd>⌘ K</kbd></DialogTrigger>
    <DialogContent className="docs-search-dialog" showCloseButton={false}>
      <DialogTitle className="sr-only">{en ? 'Search documentation' : '搜索文档'}</DialogTitle>
      <DialogDescription className="sr-only">{en ? 'Search titles and full text. Use arrow keys to choose a result and Enter to open it.' : '搜索标题和正文。使用方向键选择结果，按回车打开。'}</DialogDescription>
      <Command shouldFilter={false} loop className="docs-command">
        <div className="docs-search-input"><CommandInput autoFocus value={query} onValueChange={setQuery} placeholder={en ? 'Search documentation…' : '搜索文档…'} aria-label={en ? 'Search query' : '搜索关键词'} /><DialogClose className="search-close" aria-label={en ? 'Close search' : '关闭搜索'}><X size={18} /></DialogClose></div>
        <CommandList>
          <div className="search-status" role="status">{failed ? (en ? 'Could not load search. Close and reopen to retry.' : '搜索加载失败，请关闭后重新打开。') : !pages ? (en ? 'Loading…' : '正在加载…') : !query.trim() ? (en ? 'Search guides, models, executors and architecture.' : '查找使用指南、模型、执行器和架构。') : results.length ? (en ? `${results.length} results` : `${results.length} 条结果`) : (en ? 'No results. Try another term.' : '没有找到结果，试试其他关键词。')}</div>
          {results.map(result => <CommandItem key={result.url} value={result.url} onSelect={() => window.location.assign(sitePath(result.url))} className="docs-search-result"><FileText size={18} /><span className="search-result-copy"><span className="search-result-meta">{result.section === 'users' ? (en ? 'Users' : '用户指南') : (en ? 'Developers' : '开发文档')}</span><strong><Highlight text={result.title} query={query} /></strong><span className="search-result-snippet"><Highlight text={result.snippet} query={query} /></span></span><ArrowUpRight size={16} /></CommandItem>)}
        </CommandList>
        <div className="search-footer"><span>↑ ↓ {en ? 'Navigate' : '选择'}</span><span>↵ {en ? 'Open' : '打开'}</span><span>esc {en ? 'Close' : '关闭'}</span></div>
      </Command>
    </DialogContent>
  </Dialog>;
}
