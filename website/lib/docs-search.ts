export type SearchPage = { title: string; url: string; lang: string; section: string; headings: string; text: string };
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase();
export function searchDocs(pages: SearchPage[], query: string, lang: string) {
  const terms = normalize(query).trim().split(/\s+/u).filter(Boolean);
  if (!terms.length) return [];
  return pages.filter(page => page.lang === lang).map(page => {
    const title = normalize(page.title), headings = normalize(page.headings), text = normalize(page.text);
    if (!terms.every(term => `${title} ${headings} ${text}`.includes(term))) return null;
    const score = terms.reduce((total, term) => total + (title === term ? 100 : title.includes(term) ? 40 : headings.includes(term) ? 12 : 1), 0) + (page.section === 'users' ? 1 : 0);
    const first = Math.min(...terms.map(term => text.indexOf(term)).filter(index => index >= 0));
    const start = Number.isFinite(first) ? Math.max(0, first - 35) : 0;
    const snippet = (start ? '…' : '') + page.text.slice(start, start + 150) + (page.text.length > start + 150 ? '…' : '');
    return { ...page, score, snippet };
  }).filter(page => page !== null).sort((a,b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, 10);
}
