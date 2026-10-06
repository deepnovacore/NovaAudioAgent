import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';
import GithubSlugger from 'github-slugger';

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const docsRoot = path.resolve(site, '../docs');
const repoRoot = path.dirname(docsRoot);
const escape = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.md') ? [path.join(dir, e.name)] : []);
const urlFor = (lang, slug) => `${lang === 'en' ? '/en' : ''}/docs${slug ? '/' + slug : ''}`;

export function generateDocs() {
  const files = ['en', 'zh-CN'].flatMap(lang => walk(path.join(docsRoot, lang)));
  const records = files.map(file => {
    const relative = path.relative(docsRoot, file).split(path.sep).join('/');
    const [lang, ...parts] = relative.split('/');
    const slug = parts.join('/').replace(/\.md$/, '').replace(/^README$/, '');
    return { file, relative, lang, slug, url: urlFor(lang, slug) };
  });
  const byFile = new Map(records.map(r => [r.file, r]));
  const assets = new Map();
  const pages = records.map(record => {
    const markdown = fs.readFileSync(record.file, 'utf8');
    const slugger = new GithubSlugger();
    const toc = [];
    const rewrite = href => {
      if (/^(?:javascript|data|vbscript):/i.test(href)) throw new Error('Unsupported URL scheme');
      if (!href || /^(?:[a-z][a-z\d+.-]*:|#|\/)/i.test(href)) return href;
      const [name, hash] = href.split('#');
      const target = path.resolve(path.dirname(record.file), decodeURIComponent(name));
      const page = byFile.get(target);
      if (page) return basePath + page.url + (hash ? '#' + hash : '');
      const relative = path.relative(repoRoot, target).split(path.sep).join('/');
      if (relative.startsWith('../') || path.isAbsolute(relative)) throw new Error(`Link outside repository: ${record.relative}: ${href}`);
      if (!fs.existsSync(target)) throw new Error(`Missing link: ${record.relative}: ${href}`);
      if (/\.(png|jpe?g|webp|gif|svg)$/i.test(target)) {
        assets.set(relative, target);
        return basePath + '/doc-assets/' + relative;
      }
      return 'https://github.com/deepnovacore/NovaAudioAgent/blob/main/' + relative + (hash ? '#' + hash : '');
    };
    const marked = new Marked({ gfm: true, walkTokens(token) {
      if (token.type === 'link' || token.type === 'image') token.href = rewrite(token.href);
    }, renderer: {
      html({ text }) {
        if (/^\s*<!--[\s\S]*?-->\s*$/.test(text)) return '';
        const anchor = text.trim().match(/^<a\s+(?:id|name)="([^"]+)"\s*>(<\/a>)?$/i);
        if (anchor) return `<a id="${escape(anchor[1])}">${anchor[2] || ''}`;
        if (text.trim() === '</a>') return '</a>';
        return escape(text);
      },
      heading({ tokens, depth, text }) {
        const id = slugger.slug(text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*`]/g, ''));
        if (depth === 2 || depth === 3) toc.push({ id, title: text.replace(/[`*]/g, ''), depth });
        return `<h${depth} id="${escape(id)}">${this.parser.parseInline(tokens)}</h${depth}>`;
      },
      code({ text, lang }) {
        return lang === 'mermaid' ? `<pre class="mermaid">${escape(text)}</pre>` : `<pre><code class="language-${escape(lang || 'text')}">${escape(text)}</code></pre>`;
      },
    }});
    const tokens = marked.lexer(markdown);
    const table = tokens.find(token => token.type === 'table');
    const entries = record.slug === '' && table ? table.rows.flatMap(row => {
      const link = row[1]?.tokens?.find(token => token.type === 'link');
      if (!link) return [];
      const target = byFile.get(path.resolve(path.dirname(record.file), link.href));
      return target ? [{ title: link.text, description: row[0].text, url: target.url, slug: target.slug }] : [];
    }) : [];
    const intro = tokens.find(token => token.type === 'paragraph' && token.tokens?.[0]?.type === 'text')?.text || '';
    let imageUrl = '';
    marked.walkTokens(tokens, token => { if (token.type === 'image' && !imageUrl) imageUrl = rewrite(token.href); });
    const html = marked.parse(markdown);
    const diagram = html.match(/<pre class="mermaid">[\s\S]*?<\/pre>/)?.[0] || '';
    const translated = records.find(r => r.lang !== record.lang && r.slug === record.slug);
    return { ...record, file: undefined, html, toc, entries, intro, diagram, imageUrl, title: markdown.match(/^#\s+(.+)$/m)?.[1] || record.slug, alternate: translated?.url || urlFor(record.lang === 'en' ? 'zh-CN' : 'en', '') };
  });
  fs.mkdirSync(path.join(site, 'generated'), { recursive: true });
  fs.writeFileSync(path.join(site, 'generated/docs.json'), JSON.stringify(pages));
  const plain = value => value.replace(/<[^>]*>/g, ' ').replace(/&(?:amp|lt|gt|quot|#39);/g, entity => ({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'"})[entity]).replace(/\s+/g, ' ').trim().normalize('NFKC');
  const userSlugs = ['', 'getting-started', 'features', 'support-matrix', 'knowledge-base', 'personal-memory', 'iphone', 'configuration', 'architecture'];
  const index = pages.map(p => ({ title: p.title, url: p.url, lang: p.lang, section: userSlugs.includes(p.slug) ? 'users' : 'developers', headings: p.toc.map(h => h.title).join(' '), text: plain(p.html) }));
  fs.writeFileSync(path.join(site, 'generated/search.json'), JSON.stringify(index));
  for (const name of ['vision-camera.png', 'workbench-window.png', 'ideas-goals.png', 'feeds.png']) {
    const relative = `assets/features/${name}`;
    assets.set(relative, path.join(repoRoot, relative));
  }
  for (const suffix of ['', '.en']) {
    const relative = `assets/features/coding${suffix}.svg`;
    assets.set(relative, path.join(repoRoot, relative));
  }
  for (const name of ['conversation', 'permission', 'workspace', 'knowledge', 'iphone', 'workbench', 'profile-memory']) {
    for (const suffix of ['', '.en']) {
      const relative = `assets/features/${name}${suffix}.png`;
      assets.set(relative, path.join(repoRoot, relative));
    }
  }
  const assetRoot = path.join(site, 'public/doc-assets');
  fs.rmSync(assetRoot, { recursive: true, force: true });
  for (const [relative, source] of assets) {
    const destination = path.join(assetRoot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  console.log(`Generated ${pages.length} documentation pages and ${assets.size} assets.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) generateDocs();
