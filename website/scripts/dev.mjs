import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { generateDocs, docsRoot } from './docs.mjs';
generateDocs();
let timer;
const watcher = fs.watch(docsRoot, { recursive: true }, (_event, filename) => {
  if (!filename?.endsWith('.md')) return;
  clearTimeout(timer);
  timer = setTimeout(() => { try { generateDocs(); } catch (error) { console.error(error); } }, 150);
});
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--webpack', ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => { watcher.close(); clearTimeout(timer); process.exit(code ?? 0); });
