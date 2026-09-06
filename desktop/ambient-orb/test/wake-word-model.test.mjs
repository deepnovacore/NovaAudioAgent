import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, mkdir, writeFile, rm, readdir} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {ensureWakeWordModel, validateKeywords, WAKE_WORD_MODEL_NAME, WAKE_WORD_MODEL_FILES, WAKE_WORD_KEYWORDS} from '../src/main/wake-word/model-manager.mjs'
import {pcm16Base64ToFloat32} from '../src/main/wake-word/sherpa-detector.mjs'

test('download failure and checksum failure leave no partial model; retry remains possible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-model-'))
  try {
    await assert.rejects(ensureWakeWordModel(root, {fetchImpl: async () => ({ok: false, status: 503})}), /503/)
    assert.deepEqual(await readdir(root), [])
    await assert.rejects(ensureWakeWordModel(root, {fetchImpl: async () => new Response('wrong archive')}), /校验失败/)
    assert.deepEqual(await readdir(root), [])
  } finally { await rm(root, {recursive: true, force: true}) }
})
test('verified keyword cache works offline and stale keywords cannot be reused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-model-'))
  const dir = join(root, WAKE_WORD_MODEL_NAME)
  try {
    await mkdir(dir)
    for (const file of Object.values(WAKE_WORD_MODEL_FILES)) await writeFile(join(dir, file), '')
    const tokens = WAKE_WORD_KEYWORDS.trim().split(/\s+/).filter(t => !t.startsWith('@'))
    await writeFile(join(dir, 'tokens.txt'), [...new Set(tokens)].map((t, i) => `${t} ${i}`).join('\n'))
    await writeFile(join(dir, 'keywords.txt'), WAKE_WORD_KEYWORDS)
    validateKeywords(dir)
    const offline = {fetchImpl: async () => { throw new Error('offline') }}
    assert.equal(await ensureWakeWordModel(root, offline), dir)
    await writeFile(join(dir, 'tokens.txt'), 'wrong 0')
    assert.throws(() => validateKeywords(dir), /token/)
    await writeFile(join(dir, 'keywords.txt'), '你好千问')
    await assert.rejects(ensureWakeWordModel(root, offline), /offline/)
  } finally { await rm(root, {recursive: true, force: true}) }
})
test('signed PCM bytes retain their values for local inference', () => {
  const pcm = Buffer.from([0, 128, 0, 0, 255, 127])
  assert.deepEqual([...pcm16Base64ToFloat32(pcm)], [-1, 0, 32767 / 32768])
})

test('terminated download workers clean only their own partial files', async () => {
  const {Worker} = await import('node:worker_threads')
  const {once} = await import('node:events')
  const {WakeWordRuntime} = await import('../src/main/wake-word/runtime.mjs')
  const modelModule = new URL('../src/main/wake-word/model-manager.mjs', import.meta.url).href
  const root = await mkdtemp(join(tmpdir(), 'wake-interrupted-'))
  class DownloadWorker extends Worker {
    constructor(_url, options) {
      super(new URL('data:text/javascript,' + encodeURIComponent(`
        import {parentPort, workerData} from 'node:worker_threads';
        import {readdir, stat} from 'node:fs/promises';
        import {join} from 'node:path';
        import {ensureWakeWordModel} from ${JSON.stringify(modelModule)};
        parentPort.on('message', () => {});
        ensureWakeWordModel(workerData.modelRoot, {fetchImpl: async () => new Response(new ReadableStream({
          start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); }
        }))});
        const timer = setInterval(async () => {
          for (const name of await readdir(workerData.modelRoot, {recursive: true})) {
            if (name.endsWith('.tar.bz2') && (await stat(join(workerData.modelRoot, name))).size) {
              clearInterval(timer); parentPort.postMessage({type: 'downloading'}); break;
            }
          }
        }, 10);
      `)), options)
    }
  }
  const first = new WakeWordRuntime({modelRoot: root, WorkerClass: DownloadWorker})
  const second = new WakeWordRuntime({modelRoot: root, WorkerClass: DownloadWorker})
  try {
    first.configure({wakeWordEnabled: true, autoHideSeconds: 60})
    await once(first.worker, 'message')
    const before = await readdir(root)
    second.configure({wakeWordEnabled: true, autoHideSeconds: 60})
    await once(second.worker, 'message')
    const activeFiles = (await readdir(root)).filter(name => !before.includes(name))
    assert.ok(activeFiles.length)
    const exited = once(first.worker, 'exit')
    first.stop()
    await exited
    // Cleanup follows the exit event and may retry transient Windows handles.
    for (let n = 0; n < 100 && (await readdir(root)).length !== activeFiles.length; n++) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.deepEqual((await readdir(root)).sort(), activeFiles.sort())
    const secondExited = once(second.worker, 'exit')
    second.stop()
    await secondExited
  } finally {
    first.stop(); second.stop()
    await rm(root, {recursive: true, force: true})
  }
})

test('startup removes proven-dead owners but preserves live, inaccessible and unrelated files', async t => {
  const {cleanAbandonedWakeWordDownloads} = await import('../src/main/wake-word/model-manager.mjs')
  const root = await mkdtemp(join(tmpdir(), 'wake-stale-'))
  const dead = ['.wake-word-download-424242-7', `.${WAKE_WORD_MODEL_NAME}-424242-123`, `${WAKE_WORD_MODEL_NAME}-424242-123.tar.bz2`]
  const retained = [`.wake-word-download-${process.pid}-8`, '.wake-word-download-424243-9', 'unrelated']
  try {
    for (const name of [...dead, ...retained]) await mkdir(join(root, name))
    t.mock.method(process, 'kill', pid => {
      if (pid === 424242) throw Object.assign(new Error('dead'), {code: 'ESRCH'})
      if (pid === 424243) throw Object.assign(new Error('inaccessible'), {code: 'EPERM'})
      assert.equal(pid, process.pid)
      return true
    })
    await cleanAbandonedWakeWordDownloads(root)
    assert.deepEqual((await readdir(root)).sort(), retained.sort())
  } finally { await rm(root, {recursive: true, force: true}) }
})

test('model install retries transient Windows handles with a finite limit', async t => {
  const {promises: fs} = await import('node:fs')
  const {installWakeWordModel} = await import('../src/main/wake-word/model-manager.mjs')
  const root = await mkdtemp(join(tmpdir(), 'wake-rename-'))
  const stage = join(root, 'stage'), target = join(root, 'target')
  const rename = fs.rename
  let calls = 0
  try {
    await mkdir(stage); await mkdir(target)
    await writeFile(join(stage, 'model'), 'verified')
    t.mock.method(fs, 'rename', async (...args) => {
      if (++calls < 3) throw Object.assign(new Error('scanner'), {code: 'EPERM'})
      return rename(...args)
    })
    await installWakeWordModel(stage, target)
    assert.equal(calls, 3)
    assert.equal(await fs.readFile(join(target, 'model'), 'utf8'), 'verified')
    calls = 0
    t.mock.method(fs, 'rename', async () => {
      calls++; throw Object.assign(new Error('locked'), {code: 'EBUSY'})
    })
    await assert.rejects(installWakeWordModel(stage, target), /locked/)
    assert.equal(calls, 11)
    calls = 0
    t.mock.method(fs, 'rename', async () => {
      calls++; throw Object.assign(new Error('invalid'), {code: 'EINVAL'})
    })
    await assert.rejects(installWakeWordModel(stage, target), /invalid/)
    assert.equal(calls, 1)
  } finally { await rm(root, {recursive: true, force: true}) }
})
