import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertFeishuCommand, createFeishuRunner, FeishuAppNotConfigured, parseFeishuJson } from '../src/connectors/feishu/cli.js';

test('unsupported CLI stays unavailable on subsequent status requests without accessing credentials', async () => {
  const directory=await mkdtemp(join(tmpdir(),'nova-feishu-old-cli-'));
  const calls:string[][]=[];
  const connector=new FeishuConnector({bootstrapOnly:true,executable:'unused',credentialRoot:directory,statePath:join(directory,'state.json'),run:args=>{calls.push(args);return args[0]==='--version'?Promise.resolve('1.0.35'):Promise.reject(Error('credential initialization should not run'));}});
  try {
    await connector.open();
    const state=await connector.command('feishu.status');
    assert.equal(state.available,false);assert.match(state.error!,/1\.0\.69/);
    await assert.rejects(connector.command('feishu.login'),/1\.0\.69/);
    assert.ok(calls.every(args=>args[0]==='--version'));
  } finally {await connector.close();await rm(directory,{recursive:true,force:true});}
});
import {abortable} from '../src/core/camera-session.js';
import { structuredMention, FEISHU_SCOPES, FeishuConnector, type FeishuMessage } from '../src/connectors/feishu/index.js';

test('expired Feishu authorization preserves app binding and clears after login', async () => {
  const directory=await mkdtemp(join(tmpdir(),'nova-feishu-expired-'));
  let expired=false;
  const connector=new FeishuConnector({bootstrapOnly:true,executable:'fixture',credentialRoot:directory,statePath:join(directory,'state.json'),run:async(args)=>{
    await Promise.resolve();
    if(args[0]==='--version')return '1.0.97';
    if(args[1]==='status')return JSON.stringify({appId:'cli_fixture',verified:true,identities:{user:{openId:'ou_fixture',userName:'Fixture',status:expired?'missing':'authenticated',tokenStatus:expired?'expired':'valid',scope:FEISHU_SCOPES.join(' ')}}});
    throw Error('Unexpected command');
  }});
  try {
    await connector.open();expired=true;
    const status=await connector.command('feishu.status');
    assert.equal(status.configured,true);assert.equal(status.state,'unauthorized');
    assert.equal((status as unknown as {auth_issue:string}).auth_issue,'expired');
    expired=false;
    assert.equal((await connector.command('feishu.status') as unknown as {auth_issue?:string}).auth_issue,undefined);
  } finally {await connector.close();await rm(directory,{recursive:true,force:true});}
});

test('verified automatic token refresh does not require another Feishu login', async () => {
  const directory=await mkdtemp(join(tmpdir(),'nova-feishu-refresh-'));
  const connector=new FeishuConnector({bootstrapOnly:true,executable:'fixture',credentialRoot:directory,statePath:join(directory,'state.json'),run:(args)=>Promise.resolve(args[0]==='--version'?'1.0.97':JSON.stringify({appId:'cli_fixture',verified:true,identities:{user:{openId:'ou_fixture',status:'needs_refresh',available:true,verified:true,tokenStatus:'needs_refresh',scope:FEISHU_SCOPES.join(' ')}}}))});
  try {await connector.open();const state=connector.snapshot();assert.equal(state.state,'disconnected');assert.equal(state.auth_issue,undefined);}
  finally {await connector.close();await rm(directory,{recursive:true,force:true});}
});

test('Feishu runner rejects identity/flag/path expansion and malformed output', () => {
  assert.throws(() => createFeishuRunner('lark-cli', ''));
  assert.throws(() => assertFeishuCommand(['im', '+messages-send', '--as', 'user']));
  assert.throws(() => assertFeishuCommand(['im', '+chat-list', '--as', 'user']));
  assert.throws(() => assertFeishuCommand(['auth', 'status', '--json', '--verify', '--token', 'secret']));
  assert.throws(() => assertFeishuCommand(['api', 'POST', '/anything']));
  assert.throws(() => assertFeishuCommand(['auth', 'login', '--scope', 'admin', '--no-wait', '--json']));
  assert.doesNotThrow(() => assertFeishuCommand(['config', 'init', '--new', '--lang', 'zh']));
  assert.throws(() => assertFeishuCommand(['config', 'init', '--new', '--lang', 'zh', '--force-init']));
  assert.throws(() => assertFeishuCommand(['config', 'init', '--new', '--app-id', 'cli_fixture', '--app-secret-stdin', '--brand', 'feishu']));
  assert.throws(() => parseFeishuJson('{"code":123,"data":{}}'));
  assert.throws(() => parseFeishuJson('not JSON'));
  assert.deepEqual(parseFeishuJson('[AI agent] informational line\n{"data":{"items":[]}}'), { items: [] });
});

test('new app setup streams only the official link, never replaces an app, and separates OAuth', async () => {
  const directory=await mkdtemp(join(tmpdir(),'nova-feishu-app-'));
  let configured=false, setups=0, finish!:()=>void, entered!:()=>void, ready!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;}), completed=new Promise<void>(resolve=>{ready=resolve;});
  const connector: FeishuConnector=new FeishuConnector({executable:'fixture',credentialRoot:join(directory,'credentials'),statePath:join(directory,'state.json'),ingest:()=>Promise.resolve(),deleteSource:()=>Promise.resolve(),onAction:()=>Promise.resolve(),
    onChange:state=>{assert.equal(state.app_setup?.verification_url,undefined);if(state.app_setup?.state==='ready')ready();},
    run: (args,options)=>{
      if(args[0]==='--version')return Promise.resolve('1.0.69');
      if(args[0]==='auth'){assert.equal(args[1],'status');if(!configured)return Promise.reject(new FeishuAppNotConfigured());return Promise.resolve(JSON.stringify({appId:'cli_fixture',identities:{}}));}
      setups++;assert.deepEqual(args,['config','init','--new','--lang','zh']);
      options?.onOutput?.('Secret text and https://evil.test/ignored\nhttps://open.feishu.cn/page/cli?token=');
      assert.equal(connector.snapshot().app_setup?.verification_url,undefined);
      options?.onOutput?.('fixture-public-code\n');entered();
      return new Promise(resolve=>{finish=()=>{configured=true;resolve('app secret must never be displayed');};});
    }});
  try{
    await connector.open();assert.equal(connector.snapshot().available,true);assert.equal(connector.snapshot().configured,false);
    await connector.command('feishu.app.start');await abortable(started,AbortSignal.timeout(3000));
    const pending=await connector.command('feishu.app.status');assert.equal(pending.app_setup?.verification_url,'https://open.feishu.cn/page/cli?token=fixture-public-code');
    assert(!JSON.stringify(pending).includes('Secret text'));
    finish();await abortable(completed,AbortSignal.timeout(3000));
    assert.equal(connector.snapshot().configured,true);assert.equal(connector.snapshot().state,'unauthorized');
    await connector.command('feishu.app.start');await connector.cancelAppSetup();assert.equal(setups,1);
  }finally{finish?.();await connector.close();await rm(directory,{recursive:true,force:true});}
});

test('binding credentials use stdin and cancelling setup drains the child before returning', async()=>{
  const directory=await mkdtemp(join(tmpdir(),'nova-feishu-bind-'));
  let entered!:()=>void, stopped=false;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const connector: FeishuConnector=new FeishuConnector({executable:'fixture',credentialRoot:join(directory,'credentials'),statePath:join(directory,'state.json'),ingest:()=>Promise.resolve(),deleteSource:()=>Promise.resolve(),onAction:()=>Promise.resolve(),run:(args,options)=>{
    if(args[0]==='--version')return Promise.resolve('1.0.69');
    if(args[0]==='auth')return Promise.reject(new FeishuAppNotConfigured());
    assert.deepEqual(args,['config','init','--app-id','cli_fixture','--app-secret-stdin','--brand','feishu']);assert.equal(options?.input,'fixture-secret');entered();
    return new Promise((_resolve,reject)=>{options?.signal?.addEventListener('abort',()=>{stopped=true;reject(new Error('secret provider body'));},{once:true});});
  }});
  try{
    await connector.open();await connector.command('feishu.app.bind',{app_id:'cli_fixture',app_secret:'fixture-secret'});await abortable(started,AbortSignal.timeout(3000));
    await connector.command('feishu.app.cancel');assert(stopped);assert.equal(connector.snapshot().app_setup?.state,'idle');
    assert(!JSON.stringify(connector.snapshot()).includes('secret'));assert(!(await readFile(join(directory,'state.json'),'utf8')).includes('fixture-secret'));
  }finally{await connector.close();await rm(directory,{recursive:true,force:true});}
});

test('event cancellation closes stdin and waits for graceful unsubscription', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-feishu-process-'));
  const executable = join(directory, 'fake-cli');
  const credentials = join(directory, 'credentials');
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
process.stdin.resume();
process.stdin.on('end', () => { fs.writeFileSync('unsubscribed', 'yes'); process.exit(0); });
process.stdout.write('{"type":"fixture"}\\n');
`, { mode: 0o700 });
  const controller = new AbortController();
  try {
    await assert.rejects(createFeishuRunner(executable, credentials)(['event', 'consume', 'card.action.trigger', '--as', 'bot', '--quiet', '--timeout', '0s', '--max-events', '0'], {
      signal: controller.signal, onLine: () => { controller.abort(); },
    }), /cancelled/);
    assert.equal(await readFile(join(credentials, 'unsubscribed'), 'utf8'), 'yes');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('only explicit CLI not_configured errors permit application onboarding', {skip:process.platform==='win32'}, async()=>{
  const directory=await mkdtemp(join(tmpdir(),'nova-feishu-missing-')),executable=join(directory,'fixture-cli');
  try{
    await writeFile(executable,`#!/usr/bin/env node\nif(process.argv[3]==='keychain-downgrade')process.exit(0);\nprocess.stderr.write(JSON.stringify({ok:false,error:{type:'config',subtype:'not_configured',message:'private diagnostic'}}));process.exit(3);`,{mode:0o700});
    const run=createFeishuRunner(executable,join(directory,'credentials'));
    await assert.rejects(run(['auth','status','--json','--verify']),FeishuAppNotConfigured);
    await writeFile(executable,`#!/usr/bin/env node\nif(process.argv[3]==='keychain-downgrade')process.exit(0);\nprocess.stderr.write(JSON.stringify({ok:false,error:{type:'auth',subtype:'permission_denied',message:'private diagnostic'}}));process.exit(3);`,{mode:0o700});
    await assert.rejects(run(['auth','status','--json','--verify']),error=>error instanceof Error&&!(error instanceof FeishuAppNotConfigured)&&!error.message.includes('private'));
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('selected chat ingestion, pagination, delete generations, private bot and disconnect lifecycle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-feishu-'));
  const messages: FeishuMessage[] = []; const deleted: string[] = []; const calls: string[][] = []; const actions: string[] = []; const changes: string[] = [];
  let account = 'ou_fixture'; let nonce = ''; let pageCalls = 0;
  const connector = new FeishuConnector({
    executable: 'unused', credentialRoot: directory, statePath: join(directory, 'state.json'),
    now: () => new Date('2026-09-12T12:00:00.000Z'),
    ingest: (message) => { messages.push(message); return Promise.resolve(); }, deleteSource: (source) => { deleted.push(source); return Promise.resolve(); },
    onAction: (action) => { actions.push(action.event_id); return Promise.resolve(); },
    onChange: (snapshot) => { if (snapshot.last_sync) changes.push(snapshot.last_sync); },
    run: async (args) => {
      await Promise.resolve();
      assertFeishuCommand(args); calls.push(args);
      if (args[0] === '--version') return 'lark-cli 1.0.69';
      if (args[1] === 'status') return JSON.stringify({ appId: 'cli_fixture', verified: true, identities: { user: { openId: account, name: 'Fixture', status: 'authenticated', scopes: FEISHU_SCOPES } } });
      if (args[1] === 'login' && args.includes('--no-wait')) return JSON.stringify({ verification_url: 'https://accounts.feishu.cn/device', device_code: 'PRIVATE_DEVICE', expires_in: 900 });
      if (args[1] === '+chat-list') { assert.equal(args[args.indexOf('--sort') + 1], 'active_time'); }
      if (args[1] === '+chat-list') return JSON.stringify({ data: { items: [{ chat_id: 'oc_selected', name: '项目' }], has_more: false } });
      if (args[1] === '+chat-messages-list') {
        pageCalls++;
        const second = args.includes('--page-token');
        const message = second
          ? { message_id: 'om_2', msg_type: 'post', body: { content: '{"zh_cn":{"title":"评审","content":[[{"tag":"text","text":"周五前回复"}]]}}' }, create_time: '1789200000000', sender: { id: account, sender_type: 'user' } }
          : { message_id: 'om_1', msg_type: 'text', content: '周五前把评审意见发我', create_time: '2026-09-12T08:00:00Z', sender: { open_id: 'ou_other', sender_type: 'user' } };
        return JSON.stringify({ data: { messages: [message, { message_id: 'om_bot', msg_type: 'text', content: 'Nova 已完成工作', create_time: '1789200000000', sender: { id: 'cli_fixture', sender_type: 'app' } }], has_more: !second, ...(second ? {} : { page_token: 'next' }) } });
      }
      if (args[1] === '+messages-send') {
        nonce = args[args.indexOf('--idempotency-key') + 1]!;
        assert.equal(args[args.indexOf('--user-id') + 1], account);
        return JSON.stringify({ data: { message_id: 'om_card', chat_id: 'oc_private' } });
      }
      return '{}';
    },
  });
  try {
    await connector.open();
    const grant = await connector.beginLogin();
    assert.equal(grant.verification_url, 'https://accounts.feishu.cn/device');
    assert(!JSON.stringify(grant).includes('PRIVATE_DEVICE'));
    await connector.completeLogin(); await connector.listChats();
    await assert.rejects(connector.configure(['oc_unselected'], true));
    assert.equal(connector.snapshot().scope_configured, false);
    await connector.configure(['oc_selected'], true);
    assert.equal(connector.snapshot().scope_configured, true);
    assert.equal((JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')) as {scopeConfigured: boolean}).scopeConfigured, true);
    await connector.sync();
    assert.equal(pageCalls, 2); assert.equal(messages.length, 2);
    assert(changes.length > 0);
    assert.equal(messages[1]!.raw_text, '评审\n周五前回复');
    assert.equal(messages[0]!.sender_id, 'ou_other'); assert.equal(messages[1]!.sender_id, 'ou_fixture');
    assert.equal(messages[1]!.recipient_id,'ou_fixture');assert.equal(messages[1]!.chat_id,'oc_selected');assert.equal(messages[1]!.auto_capture,false);
    assert.equal(messages[0]!.source_kind, 'im');
    assert.equal(Date.parse(messages[0]!.retention_until) - Date.parse(messages[0]!.observed_at), 30 * 86400_000);
    await connector.command('feishu.bot.configure', { enabled: true });
    assert(await connector.sendReminder({ id: 'proposal', title: '评审意见', body: '周五前回复' }));
    assert(await connector.sendReminder({ id: 'proposal', title: '评审意见', body: '周五前回复' }));
    assert.equal(calls.filter((args) => args[1] === '+messages-send').length, 1);
    const event = { type: 'card.action.trigger', event_id: 'event', operator_id: account, chat_id: 'oc_private', message_id: 'om_card', action_value: JSON.stringify({ proposal_id: 'proposal', nonce, action: 'snooze' }) };
    assert.equal(await connector.acceptAction({ ...event, operator_id: 'ou_stranger' }), false);
    assert.equal(await connector.acceptAction(event), true);
    assert.equal(await connector.acceptAction(event), false); assert.deepEqual(actions, ['event']);
    const source = messages[0]!.source_id;
    await connector.deleteHistory(); assert.deepEqual(deleted, [source]);
    await connector.command('feishu.resume'); await connector.sync();
    assert.notEqual(messages[2]!.source_id, source); assert.notEqual(messages[2]!.id, messages[0]!.id);
    await connector.disconnect(); assert.equal(connector.snapshot().bot_enabled, false);
    assert(calls.some((args) => args[1] === 'logout')); assert(!calls.some((args) => args[1] === 'remove'));
    const stored = await readFile(join(directory, 'state.json'), 'utf8'); assert(!stored.includes('周五前')); assert(!stored.includes('PRIVATE_DEVICE'));
    account = 'ou_new'; await connector.status(); assert.deepEqual(connector.snapshot().chats, []);
    await connector.deleteHistory(); assert(deleted.includes(messages[2]!.source_id));
  } finally { await connector.close(); await rm(directory, { recursive: true, force: true }); }
});

test('page cap preserves a resumable window; revoked scopes fence reads and bot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-feishu-page-'));
  let pages = 0; let revoked = false; let malformed = false;
  const connector = new FeishuConnector({ executable: 'unused', credentialRoot: directory, statePath: join(directory, 'state.json'),
    ingest: () => Promise.resolve(), deleteSource: () => Promise.resolve(), onAction: () => Promise.resolve(),
    run: async (args) => {
      await Promise.resolve();
      if (args[0] === '--version') return '1.0.69';
      if (args[1] === 'status') return JSON.stringify({ appId: 'cli_test', identities: { user: { openId: 'ou_test', status: 'authenticated', scopes: revoked ? [] : FEISHU_SCOPES } } });
      if (args[1] === '+chat-list') return '{"chats":[{"chat_id":"oc_test"}],"has_more":false}';
      if (args[1] === '+chat-messages-list') {
        if (malformed) return '{}';
        pages++;
        if (pages === 21) assert.equal(args[args.indexOf('--page-token') + 1], 'page-20');
        return JSON.stringify({ messages: [], has_more: pages < 21, page_token: `page-${pages}` });
      }
      return '{}';
    },
  });
  try {
    await connector.open(); await connector.listChats(); await connector.configure(['oc_test'], true);
    await assert.rejects(connector.sync(), /后续页/); assert.equal(pages, 20); assert.equal(connector.snapshot().last_sync, undefined);
    await connector.sync(); assert.equal(pages, 21); assert(connector.snapshot().last_sync);
    malformed = true; await assert.rejects(connector.sync(), /Invalid Feishu page/);
    await connector.command('feishu.bot.configure', { enabled: true }); revoked = true;
    await connector.status(); assert.equal(connector.snapshot().state, 'unauthorized');
    assert.equal(await connector.sendReminder({ id: 'p', title: 't', body: 'b' }), false);
    await connector.sync(); assert.equal(pages, 21);
  } finally { await connector.close(); await rm(directory, { recursive: true, force: true }); }
});

test('pause drains an in-flight ingest before source deletion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-feishu-drain-'));
  let release!: () => void; let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const order: string[] = [];
  const connector = new FeishuConnector({ executable: 'unused', credentialRoot: directory, statePath: join(directory, 'state.json'),
    ingest: async () => { entered(); await waiting; order.push('ingested'); }, deleteSource: () => { order.push('deleted'); return Promise.resolve(); }, onAction: () => Promise.resolve(),
    run: async (args) => {
      await Promise.resolve();
      if (args[0] === '--version') return '1.0.69';
      if (args[1] === 'status') return JSON.stringify({ appId: 'cli_test', identities: { user: { openId: 'ou_test', status: 'authenticated', scopes: FEISHU_SCOPES } } });
      if (args[1] === '+chat-list') return '{"items":[{"chat_id":"oc_test"}],"has_more":false}';
      if (args[1] === '+chat-messages-list') return JSON.stringify({ items: [{ message_id: 'om_test', msg_type: 'text', body: { content: '{"text":"test"}' }, create_time: '1789200000000', sender: { id: 'ou_other' } }], has_more: false });
      return '{}';
    },
  });
  try {
    await connector.open(); await connector.listChats(); await connector.configure(['oc_test'], true);
    const syncing = connector.sync(); await started;
    const deleting = connector.deleteHistory(); await new Promise((resolve) => setTimeout(resolve, 5)); assert.deepEqual(order, []);
    release(); await syncing; await deleting; assert.deepEqual(order, ['ingested', 'deleted']);
  } finally { release(); await connector.close(); await rm(directory, { recursive: true, force: true }); }
});

test('persistent card stream does not block pause on a queued host callback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-feishu-event-'));
  let emit!: (line: string) => void; let release!: () => void; let callbackEntered!: () => void; let nonce = '';
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { callbackEntered = resolve; });
  const connector = new FeishuConnector({ executable: 'unused', credentialRoot: directory, statePath: join(directory, 'state.json'),
    ingest: () => Promise.resolve(), deleteSource: () => Promise.resolve(),
    onAction: async () => { callbackEntered(); await waiting; },
    run: async (args, options) => {
      await Promise.resolve();
      if (args[0] === '--version') return '1.0.69';
      if (args[1] === 'status') return JSON.stringify({ appId: 'cli_test', identities: { user: { openId: 'ou_test', status: 'authenticated', scopes: FEISHU_SCOPES } } });
      if (args[1] === '+chat-list') return '{"chats":[{"chat_id":"oc_test"}],"has_more":false}';
      if (args[1] === '+messages-send') { nonce = args[args.indexOf('--idempotency-key') + 1]!; return '{"message_id":"om_card","chat_id":"oc_private"}'; }
      if (args[1] === 'consume') {
        assertFeishuCommand(args); emit = options!.onLine!;
        await new Promise<void>((resolve) => { options!.signal!.addEventListener('abort', () => resolve(), { once: true }); });
      }
      return '{}';
    },
  });
  try {
    await connector.open(); await connector.listChats(); await connector.configure(['oc_test'], true);
    await connector.command('feishu.bot.configure', { enabled: true });
    assert(await connector.sendReminder({ id: 'p', title: 'title', body: 'body' }));
    emit(JSON.stringify({ type: 'card.action.trigger', operator_id: 'ou_test', event_id: 'e', message_id: 'om_card', chat_id: 'oc_private', action_value: JSON.stringify({ proposal_id: 'p', nonce, action: 'snooze' }) }));
    await entered;
    await connector.pause(); assert.equal(connector.snapshot().state, 'paused');
    release();
  } finally { release(); await waiting; await connector.close(); await rm(directory, { recursive: true, force: true }); }
});


test('macOS runner prepares isolated storage once before concurrent commands', {skip:process.platform!=='darwin'}, async()=>{
  const directory=await mkdtemp(join(tmpdir(),'nova-feishu-keychain-'));
  try {
    const executable=join(directory,'fixture-cli'), credentials=join(directory,'credentials');
    await writeFile(executable,`#!/usr/bin/env node
const fs=require('node:fs');
if(fs.realpathSync(process.env.HOME)!==process.cwd() || !process.env.LARKSUITE_CLI_CONFIG_DIR.startsWith(process.env.HOME)) process.exit(9);
if(process.argv[3]==='keychain-downgrade') { fs.appendFileSync('initialized','1'); process.exit(0); }
if(!fs.existsSync('initialized')) process.exit(8);
process.stdout.write('{}');
`,{mode:0o700});
    const run=createFeishuRunner(executable,credentials);
    await Promise.all([run(['auth','status','--json','--verify']),run(['auth','status','--json','--verify'])]);
    assert.equal(await readFile(join(credentials,'initialized'),'utf8'),'1');
  } finally {await rm(directory,{recursive:true,force:true});}
});


test('Feishu read scope never grants model processing and settings reports current provider consent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nova-feishu-consent-'));
  let provider = 'provider-one'; let conversationProviders = ['chat-one']; let failConsent = false;
  const connector = new FeishuConnector({
    executable: 'unused', credentialRoot: directory, statePath: join(directory, 'state.json'),
    ingest: () => Promise.resolve(), deleteSource: () => Promise.resolve(), onAction: () => Promise.resolve(),
    processingGrant: (allowed, revision, scope_revision) => ({revision, scope_revision, extraction_provider: allowed ? provider : null, embedding_provider: null, conversation_providers: allowed ? [...conversationProviders] : []}),
    onProcessingConsent: () => failConsent ? Promise.reject(new Error('consent_unavailable')) : Promise.resolve(),
    run: args => {
      if (args[0] === '--version') return Promise.resolve('lark-cli 1.0.69');
      if (args[1] === 'status') return Promise.resolve(JSON.stringify({appId: 'cli_fixture', verified: true, identities: {user: {openId: 'ou_fixture', status: 'authenticated', scopes: FEISHU_SCOPES}}}));
      if (args[1] === '+chat-list') return Promise.resolve(JSON.stringify({items: [{chat_id: 'oc_fixture'}], has_more: false}));
      return Promise.resolve('{}');
    },
  });
  try {
    await connector.open(); await connector.listChats();
    await connector.command('feishu.configure', {chat_ids: ['oc_fixture'], consent: true});
    let state = await connector.command('feishu.status');
    assert.equal(state.scope_configured, true);
    assert.equal(state.processing_consent_required, true);
    await connector.command('feishu.consent', {consent: true});
    assert.equal((await connector.command('feishu.status')).processing_consent_required, false);
    conversationProviders = ['chat-two', 'chat-one'];
    assert.equal((await connector.command('feishu.status')).processing_consent_required, true);
    await connector.command('feishu.consent', {consent: true});
    conversationProviders = ['chat-one', 'chat-two'];
    assert.equal((await connector.command('feishu.status')).processing_consent_required, false);
    provider = 'provider-two';
    assert.equal((await connector.command('feishu.status')).processing_consent_required, true);
    await connector.command('feishu.consent', {consent: true});
    assert.equal((await connector.command('feishu.status')).processing_consent_required, false);
    await connector.command('feishu.consent', {consent: false});
    state = await connector.command('feishu.status');
    assert.equal(state.processing_consent_required, true); assert.equal(state.state, 'ready');
    await connector.command('feishu.consent', {consent: true});
    failConsent = true;
    await assert.rejects(connector.command('feishu.configure', {chat_ids: [], consent: true}), /consent_unavailable/);
    assert.equal(connector.snapshot().state, 'paused');
    const stored = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')) as {selected: string[]};
    assert.deepEqual(stored.selected, ['oc_fixture']);
    failConsent = false;
    await connector.command('feishu.configure', {chat_ids: ['oc_fixture'], consent: true});
    assert.equal(connector.snapshot().processing_consent_required, true);
  } finally { await connector.close(); await rm(directory, {recursive: true, force: true}); }
});

test('direct mentions use structured identity, fall back to raw GET, and fence historical capture',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'nova-mention-')),messages:FeishuMessage[]=[]
 let now=new Date('2026-10-04T02:00:00Z'),fallbacks=0
 const connector=new FeishuConnector({executable:'fixture',credentialRoot:directory,statePath:join(directory,'state'),now:()=>now,
 processingGrant:(allowed,revision,scope_revision)=>({revision,scope_revision,extraction_provider:allowed?'provider':null,embedding_provider:null}),
 ingest:m=>{messages.push(m);return Promise.resolve()},deleteSource:()=>Promise.resolve(),onAction:()=>Promise.resolve(),run:async args=>{
  await Promise.resolve()
  assertFeishuCommand(args)
  if(args[0]==='--version')return '1.0.69'
  if(args[1]==='status')return JSON.stringify({appId:'fixture',identities:{user:{openId:'ou_me',status:'authenticated',scopes:FEISHU_SCOPES}}})
  if(args[1]==='login')return JSON.stringify({verification_url:'https://accounts.feishu.cn/device',device_code:'fixture',expires_in:900})
  if(args[1]==='+chat-list')return JSON.stringify({items:[{chat_id:'oc_test',name:'test'}],has_more:false})
  if(args[0]==='api'){fallbacks++;return JSON.stringify({data:{items:[{message_id:'om_missing',message_type:'text',body:{content:JSON.stringify({text:'@_user_1 请提交'})},mentions:[{id:'ou_me',id_type:'open_id'}]}]}})}
  if(args[1]==='+chat-messages-list')return JSON.stringify({has_more:false,items:[
   {message_id:'om_direct',mentions:[{id:'ou_me',id_type:'open_id'}]},
   {message_id:'om_all',mentions:[{id:'all'}]},
   {message_id:'om_other',mentions:[{id:'ou_other',id_type:'open_id'}]},
   {message_id:'om_old',create_time:'2026-10-03T02:00:00Z',mentions:[{id:'ou_me',id_type:'open_id'}]},
   {message_id:'om_missing'},
  ].map(row=>({msg_type:'text',content:'@_user_1 请提交',sender:{open_id:'ou_other'},create_time:now.toISOString(),...row}))})
  return '{}'
 }})
 try{await connector.open();await connector.beginLogin();await connector.completeLogin();await connector.listChats();await connector.configure(['oc_test'],true);await connector.command('feishu.consent',{consent:true});now=new Date('2026-10-04T02:01:00Z');await connector.sync()
 const byId=new Map(messages.map(m=>[m.message_id,m]));assert.equal(byId.get('om_direct')?.mention,'direct');assert.equal(byId.get('om_direct')?.auto_capture,true)
 assert.equal(byId.get('om_all')?.mention,'all');assert.equal(byId.get('om_other')?.mention,'none');assert.equal(byId.get('om_old')?.auto_capture,false);assert.equal(byId.get('om_missing')?.mention,'direct');assert.ok(fallbacks>0)
 }finally{await connector.close();await rm(directory,{recursive:true,force:true})}
})

test('raw rich-text mention nodes identify users but text and forwarded content do not',()=>{
 const raw={message_type:'post',body:{content:JSON.stringify({zh_cn:{content:[[{tag:'at',user_id:'ou_me'},{tag:'text',text:'处理'}]]}})}}
 assert.equal(structuredMention(raw,'ou_me'),'direct')
 assert.equal(structuredMention({...raw,message_type:'merge_forward'},'ou_me'),'unknown')
 assert.equal(structuredMention({message_type:'text',content:'@ou_me 请处理'},'ou_me'),'unknown')
})

test('mentions from before a chat was selected or consent was granted are never auto-captured, and self-sent messages never mention you',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'nova-capture-window-')),messages:FeishuMessage[]=[]
 let now=new Date('2026-10-04T02:00:00Z')
 const at=(minutes:number)=>new Date(Date.parse('2026-10-04T02:00:00Z')+minutes*60_000).toISOString()
 const connector=new FeishuConnector({executable:'fixture',credentialRoot:directory,statePath:join(directory,'state'),now:()=>now,
  processingGrant:(allowed,revision,scope_revision)=>({revision,scope_revision,extraction_provider:allowed?'provider':null,embedding_provider:null}),
  ingest:m=>{messages.push(m);return Promise.resolve()},deleteSource:()=>Promise.resolve(),onAction:()=>Promise.resolve(),run:async args=>{
   await Promise.resolve();assertFeishuCommand(args)
   if(args[0]==='--version')return '1.0.69'
   if(args[1]==='status')return JSON.stringify({appId:'fixture',identities:{user:{openId:'ou_me',status:'authenticated',scopes:FEISHU_SCOPES}}})
   if(args[1]==='login')return JSON.stringify({verification_url:'https://accounts.feishu.cn/device',device_code:'fixture',expires_in:900})
   if(args[1]==='+chat-list')return JSON.stringify({items:[{chat_id:'oc_a',name:'a'},{chat_id:'oc_b',name:'b'}],has_more:false})
   if(args[1]==='+chat-messages-list'){
    const chat=args[args.indexOf('--chat-id')+1]
    return JSON.stringify({has_more:false,items:[{message_id:`${chat}_before`,create_time:at(-30)},{message_id:`${chat}_after`,create_time:at(30)},{message_id:`${chat}_mine`,create_time:at(30),sender:{open_id:'ou_me'}}]
     .map(row=>({msg_type:'text',content:'@_user_1 请提交',sender:{open_id:'ou_other'},mentions:[{id:'ou_me',id_type:'open_id'}],...row}))})
   }
   return '{}'
  }})
 const capture=():Record<string,boolean|undefined>=>Object.fromEntries(messages.map(m=>[m.message_id??'',m.auto_capture]))
 try{
  await connector.open();await connector.beginLogin();await connector.completeLogin();await connector.listChats()
  // Consent is granted only after the first sync: everything ingested before it stays history.
  await connector.configure(['oc_a'],true);now=new Date(at(5));await connector.sync()
  assert.ok(messages.length>0&&messages.every(m=>m.auto_capture===false),'no live consent yet')
  await connector.command('feishu.consent',{consent:true});now=new Date(at(60));messages.length=0;await connector.sync()
  assert.equal(capture().oc_a_after,true);assert.equal(capture().oc_a_before,false)
  assert.equal(capture().oc_a_mine,false);assert.equal(messages.find(m=>m.message_id==='oc_a_mine')?.mention,'none')
  // A chat added later starts its own window at selection time, not at login.
  messages.length=0;now=new Date(at(20));await connector.configure(['oc_a','oc_b'],true);await connector.command('feishu.consent',{consent:true})
  now=new Date(at(90));await connector.sync()
  assert.equal(capture().oc_b_before,false);assert.equal(capture().oc_b_after,true)
 }finally{await connector.close();await rm(directory,{recursive:true,force:true})}
})
