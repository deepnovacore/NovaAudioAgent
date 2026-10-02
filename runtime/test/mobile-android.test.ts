import sharp from 'sharp'
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createAndroidDevice} from '../src/executors/mobile-android.js'

test('ADB binds serial, rejects shell input, restores keyboard and stops after cancellation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nova-adb-test-'))
  const previousPath = process.env.PATH
  process.env.PATH = `${root}:${previousPath}`
  t.after(async () => { process.env.PATH = previousPath; await rm(root, {recursive: true, force: true}) })
  const log = join(root, 'commands.jsonl')
  const png = (await sharp({create: {width: 1, height: 3, channels: 3, background: 'white'}}).png().toBuffer()).toString('base64')
  await writeFile(join(root, 'adb'), `#!${process.execPath}
const fs=require('node:fs'); const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
const c=args.slice(2).join(' ');
const mode=fs.existsSync(${JSON.stringify(join(root,'mode'))})?fs.readFileSync(${JSON.stringify(join(root,'mode'))},'utf8'):'';
if(mode==='permission'&&c.startsWith('shell input')){process.stderr.write('SecurityException: INJECT_EVENTS');process.exit(1);}
if(mode==='unknown'&&c.startsWith('shell input'))process.exit(1);
if(mode==='broadcast_failure'&&c.startsWith('shell am broadcast')){process.stderr.write('SecurityException');process.exit(1);}
if(mode==='disconnect'&&c==='get-state')process.exit(1);
if(c==='get-state') console.log('device');
else if(c==='shell dumpsys window') console.log('mCurrentFocus=Window{0 u0 com.example.app/.Main}\\ntype=statusBars frame=[0,0][1,1] visible=true\\ntype=navigationBars frame=[0,2][1,3] visible=true');
else if(c==='exec-out screencap -p') process.stdout.write(Buffer.from('${png}','base64'));
else if(c==='shell settings get secure default_input_method') console.log('com.example.ime/.IME');
else if(c==='shell dumpsys input_method') {const calls=fs.readFileSync(${JSON.stringify(log)},'utf8').split('\\n').filter(x=>x.includes('input_method')&&x.includes('dumpsys')).length;console.log('mCurId=com.android.adbkeyboard/.AdbIME mHaveConnection=true mBoundToMethod='+(calls>1));}
else if(c==='shell ime list -s') console.log('com.android.adbkeyboard/.AdbIME');
else if(c.startsWith('shell am broadcast')) console.log('Broadcast completed: result=0');
`, {mode: 0o700})
  const controller = new AbortController()
  const device = await createAndroidDevice('test-phone', controller.signal)
  assert.deepEqual(device.size, {width: 1, height: 3})
  await device.perform('Tap', {x: 0, y: 0})
  await device.perform('Type', {text: '奶茶 $(bad)'})
  await assert.rejects(device.perform('Launch', {packageName: 'a.b;reboot'}))
  await assert.rejects(device.perform('Tap', {x: -1, y: 0}))
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
  assert.equal(calls.filter(args => args[3] === 'dumpsys' && args[4] === 'input_method').length, 2)
  assert.ok(calls.every(args => args[0] === '-s' && args[1] === 'test-phone'))
  assert.ok(calls.some(args => args.includes(Buffer.from('奶茶 $(bad)').toString('base64')) && args.includes('-p') && args.includes('com.android.adbkeyboard')))
  assert.deepEqual(calls.find(args => args[3] === 'input'), ['-s', 'test-phone', 'shell', 'input', 'tap', '0', '0'])
  assert.deepEqual(calls.filter(args => args[3] === 'ime' && args[4] === 'set').map(args => args[5]),
    ['com.android.adbkeyboard/.AdbIME', 'com.example.ime/.IME'])
  for (const [mode, action, params, message] of [
    ['permission', 'Tap', {x:0,y:0}, 'needs_user_action'],
    ['unknown', 'Tap', {x:0,y:0}, 'cleanup_unknown'],
    ['broadcast_failure', 'Type', {text:'奶茶'}, 'needs_user_action'],
    ['disconnect', 'Home', {}, 'action_failed'],
  ] as const) {
    await writeFile(join(root,'mode'),mode)
    await assert.rejects(device.perform(action,params),{message})
    if (mode === 'broadcast_failure') {
      const last = (await readFile(log,'utf8')).trim().split('\n').at(-1)!
      assert.deepEqual(JSON.parse(last),['-s','test-phone','shell','ime','set','com.example.ime/.IME'])
    }
  }
  await rm(join(root,'mode'))
  controller.abort()
  const before = await readFile(log, 'utf8')
  await assert.rejects(device.perform('Home', {}), {message: 'cancelled'})
  assert.equal(await readFile(log, 'utf8'), before)
})
