import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('static preview serves full files and single video byte ranges', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naa-preview-'));
  fs.mkdirSync(path.join(dir, 'out'));
  fs.writeFileSync(path.join(dir, 'out', 'demo.mp4'), '0123456789');
  const reservation = net.createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./serve.mjs', import.meta.url))], {
    cwd: dir, env: { ...process.env, PORT: String(port), NEXT_PUBLIC_BASE_PATH: '/NovaAudioAgent' },
  });
  t.after(async () => {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await once(child.stdout, 'data');
  const url = `http://127.0.0.1:${port}/NovaAudioAgent/demo.mp4`;
  const full = await fetch(url);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.equal(await full.text(), '0123456789');
  for (const [range, body, contentRange] of [
    ['bytes=2-5', '2345', 'bytes 2-5/10'],
    ['bytes=8-', '89', 'bytes 8-9/10'],
    ['bytes=-3', '789', 'bytes 7-9/10'],
    ['bytes=9-99', '9', 'bytes 9-9/10'],
  ]) {
    const response = await fetch(url, { headers: { Range: range } });
    assert.equal(response.status, 206, range);
    assert.equal(response.headers.get('content-range'), contentRange);
    assert.equal(response.headers.get('content-length'), String(body.length));
    assert.equal(await response.text(), body);
  }
  for (const range of ['bytes=10-', 'bytes=5-2', 'bytes=-0', 'bytes=0-1,3-4', 'bytes=-', 'bytes=9007199254740992-']) {
    const response = await fetch(url, { headers: { Range: range } });
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get('content-range'), 'bytes */10');
  }
  const head = await fetch(url, { method: 'HEAD', headers: { Range: 'bytes=0-1' } });
  assert.equal(head.status, 206);
  assert.equal(head.headers.get('content-length'), '2');
  assert.equal(await head.text(), '');
  assert.equal((await fetch(`http://127.0.0.1:${port}/demo.mp4`)).status, 404);
});
