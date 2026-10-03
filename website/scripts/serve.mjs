import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve('out');
const base = process.env.NEXT_PUBLIC_BASE_PATH || '';
const port = Number(process.env.PORT || 3108);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { res.writeHead(400).end(); return; }
  if (base && pathname !== base && !pathname.startsWith(base + '/')) { res.writeHead(404).end(); return; }
  const file = path.resolve(root, '.' + (pathname.slice(base.length) || '/'));
  if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  let target = file;
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    if (!pathname.endsWith('/')) { res.writeHead(308, { Location: pathname + '/' }).end(); return; }
    target = path.join(file, 'index.html');
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) { res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(fs.existsSync(path.join(root, '404.html')) ? fs.readFileSync(path.join(root, '404.html')) : 'Not found'); return; }
  res.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream' });
  fs.createReadStream(target).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${port}${base}/docs/`));
