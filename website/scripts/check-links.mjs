import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve('out');
const base = process.env.NEXT_PUBLIC_BASE_PATH || '';
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.html') ? [path.join(dir, e.name)] : []);
const errors = new Set();
const files = walk(root);
let checked = 0;
for (const file of files) {
  const html = fs.readFileSync(file, 'utf8');
  const route = '/' + path.relative(root, file).replace(/index\.html$/, '');
  for (const match of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
    const value = match[1].replaceAll('&amp;', '&');
    if (!value || /^(?:https?:|mailto:|tel:|data:|\/\/)/.test(value)) continue;
    const url = new URL(value, 'http://local' + base + route);
    const pathname = decodeURIComponent(url.pathname);
    if (base && pathname !== base && !pathname.startsWith(base + '/')) { errors.add(`${route}: missing base path: ${value}`); continue; }
    let target = path.join(root, pathname.slice(base.length));
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
    checked++;
    if (!fs.existsSync(target)) { errors.add(`${route}: missing file: ${value}`); continue; }
    if (url.hash && target.endsWith('.html')) {
      const id = decodeURIComponent(url.hash.slice(1));
      const content = fs.readFileSync(target, 'utf8');
      if (!content.includes(`id="${id}"`)) errors.add(`${route}: missing anchor: ${value}`);
    }
  }
}
if (errors.size) { console.error([...errors].join('\n')); process.exitCode = 1; }
else console.log(`Verified ${files.length} HTML pages and ${checked} local links/assets (base path: ${base || '/'}).`);
