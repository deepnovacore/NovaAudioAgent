import {processingGrantSchema,type ProcessingGrant} from '../../memory-substrate/source-state.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createFeishuRunner, FeishuAppNotConfigured, object, parseFeishuJson, type FeishuRun } from './cli.js';

export const FEISHU_SCOPES = ['offline_access', 'im:chat:read', 'im:message:readonly', 'im:message.reactions:read'];
export interface FeishuMessage {
  processing_consent?: ProcessingGrant;
  message_id?: string; chat_id?: string; recipient_id?: string; sender_name?: string;
  mention?: 'direct'|'all'|'none'|'unknown'; auto_capture?: boolean; source_url?: string;
  id: string; source_id: string; source_kind: 'im'; locator: string; raw_text: string;
  observed_at: string; retention_until: string; sender_id: string; account_id: string;
}
export interface FeishuSnapshot {
  available: boolean; configured: boolean; state: 'unauthorized' | 'ready' | 'paused' | 'disconnected' | 'error';
  account_name?: string; account_id?: string; chats: { id: string; name: string; selected: boolean }[];
  last_sync?: string; error?: string; bot_enabled: boolean; retention_days: 30; verification_url?: string;
  app_id?: string;
  scope_configured?: boolean;
  processing_consent_required?: boolean;
  app_setup?: {state: 'idle' | 'waiting' | 'ready' | 'error'; verification_url?: string; error?: string};
}
interface Cursor { start: string; end?: string; page?: string }
interface Saved {
  account?: string; openId?: string; name?: string; paused: boolean; connected: boolean;
  scopeConfigured?: boolean;
  processingConsent?: ProcessingGrant;
  bot: boolean; selected: string[]; cursors: Record<string, Cursor>; lastSync?: string;
  deliveries: Record<string, { nonce: string; message?: string; chat?: string }>;
  actions: string[];
  generation: number; sources: string[]; mentionCaptureSince?: string;
  /** Per chat: only mentions from this instant on may become Todos automatically; history never does. */
  captureFrom?: Record<string, string>; consentSince?: string;
}
export interface FeishuOptions {
  executable: string; credentialRoot: string; statePath: string;
  run?: FeishuRun;
  bootstrapOnly?: boolean;
  processingGrant?: (consent:boolean,revision:number,scopeRevision:number)=>ProcessingGrant | undefined;
  onProcessingConsent?: (sources:string[],grant:ProcessingGrant)=>Promise<void>;
  ingest?: (message: FeishuMessage) => Promise<void>;
  deleteSource?: (sourceId: string) => Promise<void>;
  onAction?: (action: { proposal_id: string; action: 'open' | 'snooze' | 'ignore'; event_id: string }) => Promise<void>;
  onChange?: (snapshot: FeishuSnapshot) => void;
  now?: () => Date;
}
const fresh = (): Saved => ({ paused: true, connected: false, bot: false, selected: [], cursors: {}, deliveries: {}, actions: [], generation: 0, sources: [] });
const str = (value: unknown): string => typeof value === 'string' ? value : '';
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
function jsonObject(text: string): Record<string, unknown> {
  try { return object(JSON.parse(text)); } catch { throw new Error('Invalid Feishu JSON payload'); }
}
function pageItems(data: Record<string, unknown>, alternative: string): unknown[] {
  const items = Object.hasOwn(data, 'items') ? data.items : data[alternative];
  if (typeof data.has_more !== 'boolean' || (items !== null && !Array.isArray(items))) throw new Error('Invalid Feishu page');
  return items ?? [];
}
function messageText(row: Record<string, unknown>): string | null {
  const kind = row.msg_type ?? row.message_type;
  if (kind !== 'text' && kind !== 'post') return null;
  // CLI 1.0.69 returns rendered top-level content; raw API records have body.content JSON.
  if (typeof row.content === 'string') return row.content;
  const raw = row.content ?? object(row.body).content;
  const content = typeof raw === 'string' ? jsonObject(raw) : object(raw);
  if (kind === 'text') return str(content.text);
  const post = Array.isArray(content.content) ? content : object(content.zh_cn ?? content.en_us ?? Object.values(content)[0]);
  if (!Array.isArray(post.content)) throw new Error('Invalid Feishu post');
  return [str(post.title), ...post.content.map((line: unknown) => {
    if (!Array.isArray(line)) throw new Error('Invalid Feishu post line');
    return line.map((segment) => str(object(segment).text)).join('');
  })].filter(Boolean).join('\n');
}


/** Only provider top-level mentions identify the addressed user; quotations and rendered names do not. */
export function structuredMention(row: Record<string, unknown>, openId: string): 'direct'|'all'|'none'|'unknown' {
  if (!Array.isArray(row.mentions)) {
    if ((row.msg_type ?? row.message_type) !== 'post') return 'unknown';
    try {
      const raw = object(row.body).content;
      const content = typeof raw === 'string' ? object(JSON.parse(raw)) : object(raw);
      const post = Array.isArray(content.content) ? content : object(content.zh_cn ?? content.en_us ?? Object.values(content)[0]);
      if (!Array.isArray(post.content)) return 'unknown';
      const nodes = post.content.flat().filter(node => node && typeof node === 'object') as Record<string, unknown>[];
      const targets = nodes.filter(node => node.tag === 'at').map(node => node.user_id);
      if (targets.includes(openId)) return 'direct';
      if (targets.includes('all')) return 'all';
      return targets.length ? 'none' : 'unknown';
    } catch { return 'unknown'; }
  }
  const mentions = row.mentions.filter(item => item && typeof item === 'object') as Record<string, unknown>[];
  if (mentions.some(item => (item.id_type === undefined || item.id_type === 'open_id') && item.id === openId)) return 'direct';
  if (mentions.some(item => item.id === 'all')) return 'all';
  return 'none';
}

function readSaved(value: unknown): Saved {
  const data = object(value);
  for (const key of ['paused', 'connected', 'bot']) if (typeof data[key] !== 'boolean') throw new Error('Invalid Feishu state');
  for (const key of ['selected', 'actions', 'sources']) if (!Array.isArray(data[key]) || !(data[key] as unknown[]).every((item) => typeof item === 'string')) throw new Error('Invalid Feishu state');
  if (!Number.isSafeInteger(data.generation) || Number(data.generation) < 0) throw new Error('Invalid Feishu generation');
  for (const key of ['account', 'openId', 'name', 'lastSync']) if (data[key] !== undefined && typeof data[key] !== 'string') throw new Error('Invalid Feishu identity');
  for (const cursor of Object.values(object(data.cursors))) {
    const row = object(cursor);
    if (!str(row.start) || !Number.isFinite(Date.parse(str(row.start))) || (row.end !== undefined && !Number.isFinite(Date.parse(str(row.end)))) || (row.page !== undefined && typeof row.page !== 'string')) throw new Error('Invalid Feishu cursor');
  }
  for (const delivery of Object.values(object(data.deliveries))) {
    const row = object(delivery);
    if (!str(row.nonce) || ['message', 'chat'].some((key) => row[key] !== undefined && typeof row[key] !== 'string')) throw new Error('Invalid Feishu delivery');
  }
  if (data.scopeConfigured !== undefined && typeof data.scopeConfigured !== 'boolean') throw new Error('Invalid Feishu scope state');
  if (data.consentSince !== undefined && !Number.isFinite(Date.parse(str(data.consentSince)))) throw new Error('Invalid Feishu consent state');
  for (const from of Object.values(object(data.captureFrom))) if (!Number.isFinite(Date.parse(str(from)))) throw new Error('Invalid Feishu capture state');
  if(data.processingConsent!==undefined)processingGrantSchema.parse(data.processingConsent);
  return data as unknown as Saved;
}

export class FeishuConnector {
  private readonly run: FeishuRun;
  private saved = fresh();
  private view: FeishuSnapshot = { available: false, configured: false, state: 'unauthorized', chats: [], bot_enabled: false, retention_days: 30 };
  private deviceCode: string | undefined;
  private deviceExpiry = 0;
  private active: AbortController | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private busy = false;
  private pending: Promise<void> | undefined;
  private listener: Promise<void> | undefined;
  private listenerController: AbortController | undefined;
  private listenerRetry: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private saving = Promise.resolve();
  private listenerApp: string | undefined;
  private currentApp: string | undefined;
  private lastPublished = '';
  private setupController: AbortController | undefined;
  private setupTask: Promise<void> | undefined;
  constructor(private readonly options: FeishuOptions) {
    if (!options.bootstrapOnly && (!options.ingest || !options.deleteSource || !options.onAction)) throw new Error('Feishu collection callbacks required');
    this.run = options.run ?? createFeishuRunner(options.executable, options.credentialRoot);
  }
  snapshot(): FeishuSnapshot { const view = structuredClone(this.view),expected=this.options.processingGrant?.(true,1,0); view.processing_consent_required=!this.saved.processingConsent?.extraction_provider||this.saved.processingConsent.extraction_provider!==expected?.extraction_provider||this.saved.processingConsent.embedding_provider!==expected?.embedding_provider||JSON.stringify([...(this.saved.processingConsent.conversation_providers??[])].sort())!==JSON.stringify([...(expected?.conversation_providers??[])].sort()); view.scope_configured = this.saved.scopeConfigured ?? this.saved.selected.length > 0; if (view.app_setup) delete view.app_setup.verification_url; return view; }
  private setupSnapshot(): FeishuSnapshot {const view=this.snapshot();if(this.view.app_setup)view.app_setup=structuredClone(this.view.app_setup);return view;}
  private publish(): void {
    if (this.closed) return;
    const snapshot = this.snapshot(); const key = JSON.stringify(snapshot);
    if (key === this.lastPublished) return;
    this.lastPublished = key;
    queueMicrotask(() => { if (!this.closed) this.options.onChange?.(snapshot); });
  }
  private async stopOwnedBus(): Promise<void> {
    if (!this.listenerApp) return;
    // This connector's isolated profile only; never --all or --force another consumer.
    await this.run(['event', 'stop', '--app-id', this.listenerApp, '--json']);
    this.listenerApp = undefined;
  }
  private now(): Date { return this.options.now?.() ?? new Date(); }
  private save(): Promise<void> {
    const contents = JSON.stringify(this.saved);
    const saving = this.saving.then(async () => {
      await mkdir(dirname(this.options.statePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.options.statePath}.${randomUUID()}.tmp`;
      await writeFile(temporary, contents, { mode: 0o600 });
      await rename(temporary, this.options.statePath);
    });
    this.saving = saving.catch(() => { /* Caller receives the failure; a later save can retry. */ });
    return saving;
  }
  private async json(args: string[], input?: string): Promise<Record<string, unknown>> {
    return parseFeishuJson(await this.run(args, { ...(input ? { input } : {}), ...(this.active ? { signal: this.active.signal } : {}) }));
  }
  async open(): Promise<void> {
    this.closed = false;
    try { this.saved = readSaved(JSON.parse(await readFile(this.options.statePath, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read Feishu state'); }
    try {
      const version = await this.run(['--version']);
      const match = /(\d+)\.(\d+)\.(\d+)/.exec(version);
      if (!match || Number(match[1]) < 1 || (Number(match[1]) === 1 && Number(match[2]) === 0 && Number(match[3]) < 69)) throw new Error('飞书 CLI 需要 1.0.69 或更高版本');
      this.view.available = true;
      await this.status();
      this.schedule();
    } catch (error) { this.view.state = 'error'; this.view.error = error instanceof Error ? error.message : '飞书连接不可用'; }
    this.publish();
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.cancelAppSetup();
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    if (this.listenerRetry) clearTimeout(this.listenerRetry); this.listenerRetry = undefined;
    this.listenerController?.abort(); await this.listener?.catch(() => { /* Stop the event process, not queued host actions. */ });
    this.active?.abort(); await this.pending?.catch(() => { /* Cancellation is expected while draining. */ });
    await this.saving;
    await this.stopOwnedBus();
  }
  private schedule(): void {
    if (this.closed || this.options.bootstrapOnly) return;
    this.startListener();
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.sync().catch(() => { this.view.error = '飞书同步失败，请重试或重新登录'; this.publish(); }).finally(() => this.schedule());
    }, 60_000);
    this.timer.unref();
  }
  private startListener(): void {
    if (this.options.bootstrapOnly || this.listener || this.listenerRetry || this.closed || !this.saved.bot || !this.saved.connected || this.saved.paused) return;
    void this.consumeActions().catch(() => { if (!this.closed && !this.saved.paused) { this.view.error = '飞书提醒连接中断，正在重连'; this.publish(); } }).finally(() => {
      if (this.closed || !this.saved.bot || !this.saved.connected || this.saved.paused) return;
      this.listenerRetry = setTimeout(() => { this.listenerRetry = undefined; this.startListener(); }, 5_000);
      this.listenerRetry.unref();
    });
  }
  async status(signal?: AbortSignal): Promise<FeishuSnapshot> {
    // Preserve the preflight error instead of attempting credential access with an unsupported CLI.
    if (!this.view.available) return this.snapshot();
    let data: Record<string, unknown>;
    try {data = signal ? parseFeishuJson(await this.run(['auth', 'status', '--json', '--verify'], {signal})) : await this.json(['auth', 'status', '--json', '--verify']);}
    catch (error) {if (!(error instanceof FeishuAppNotConfigured)) throw error; data = {};}
    const app = str(data.appId ?? data.app_id);
    this.currentApp = app || undefined;
    this.view.configured = Boolean(app);
    if (app) this.view.app_id = app; else delete this.view.app_id;
    const identities = data.identities ? object(data.identities) : {};
    const user = identities.user ? object(identities.user) : {};
    const scopes = Array.isArray(user.scopes ?? user.scope) ? user.scopes ?? user.scope : str(user.scope ?? user.scopes).split(/[ ,]+/);
    const id = str(user.openId ?? user.open_id);
    const valid = data.verified !== false && (user.status === 'authenticated' || user.tokenStatus === 'valid' || user.authenticated === true);
    if (!app || !id || !valid || !FEISHU_SCOPES.every((scope) => (scopes as unknown[]).includes(scope))) {
      if(this.saved.processingConsent?.extraction_provider)await this.setProcessingConsent(false);
      this.view.state = 'unauthorized'; this.view.bot_enabled = false;
      this.saved.connected = false; this.saved.bot = false;
      this.listenerController?.abort(); await this.listener?.catch(() => { /* Authorization is no longer valid. */ });
      await this.save();
      return this.snapshot();
    }
    const account = hash(JSON.stringify([app, user.tenantKey ?? user.tenant_key ?? null, id]));
    if (this.saved.account && this.saved.account !== account) {
      await this.setProcessingConsent(false);
      this.listenerController?.abort(); await this.listener?.catch(() => { /* Fence the old identity. */ });
      await this.stopOwnedBus();
      const { sources, generation } = this.saved;
      this.saved = { ...fresh(), sources, generation: generation + 1 };
      this.view.chats = [];
    }
    this.saved.mentionCaptureSince ??= this.now().toISOString();
    this.saved.account = account; this.saved.openId = id; this.saved.name = str(user.name ?? user.userName) || '已登录';
    this.view.account_name = this.saved.name;
    this.view.account_id = account;
    this.view.state = !this.saved.connected ? 'disconnected' : this.saved.paused ? 'paused' : 'ready';
    this.view.bot_enabled = this.saved.bot && this.saved.connected;
    if (this.saved.lastSync) this.view.last_sync = this.saved.lastSync;
    await this.save();
    return this.snapshot();
  }
  async beginLogin(): Promise<FeishuSnapshot> {
    if (this.setupController) throw new Error('请先完成应用配置');
    await this.pause();
    const data = await this.json(['auth', 'login', '--scope', FEISHU_SCOPES.join(','), '--no-wait', '--json']);
    const url = str(data.verification_url ?? data.verification_uri_complete ?? data.verificationUrl);
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !['feishu.cn', 'larksuite.com'].some((domain) => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`))) throw new Error('Invalid Feishu verification URL');
    this.deviceCode = str(data.device_code ?? data.deviceCode);
    if (!this.deviceCode) throw new Error('Missing Feishu device code');
    this.deviceExpiry = this.now().getTime() + Math.min(900, Number(data.expires_in ?? 900)) * 1000;
    this.view.verification_url = url;
    return this.snapshot();
  }
  beginAppSetup(binding?: {app_id: string; app_secret: string}): Promise<FeishuSnapshot> {
    if (this.closed || !this.view.available) throw new Error('飞书 CLI 暂不可用');
    if (this.setupController) return Promise.resolve(this.setupSnapshot());
    const controller = new AbortController(); this.setupController = controller;
    this.view.app_setup = {state: 'waiting'}; this.publish();
    const task = (async () => {
      // Never turn an OAuth/network/scope failure into a new app: establish absence first.
      await this.status(controller.signal); controller.signal.throwIfAborted();
      if (this.view.configured) {if (binding) throw new Error('app_already_configured'); this.view.app_setup = {state: 'ready'}; return;}
      let output = '';
      const inspect = (chunk: string): void => {
        if (controller.signal.aborted || this.closed) return;
        output = (output + chunk).slice(-8192);
        const candidate = /https:\/\/open\.feishu\.cn\/page\/cli\?[^\s<>"'\x1b]+(?=[\s<>"'\x1b])/u.exec(output)?.[0];
        if (!candidate || candidate.length > 4096) return;
        try {
          const url = new URL(candidate);
          if (url.origin !== 'https://open.feishu.cn' || url.pathname !== '/page/cli' || url.username || url.password || url.hash) return;
          this.view.app_setup = {state: 'waiting', verification_url: url.href}; this.publish();
        } catch { /* Incomplete streamed URL. */ }
      };
      if (binding) await this.run(['config', 'init', '--app-id', binding.app_id, '--app-secret-stdin', '--brand', 'feishu'], {signal: controller.signal, input: binding.app_secret});
      else await this.run(['config', 'init', '--new', '--lang', 'zh'], {signal: controller.signal, onOutput: inspect});
      controller.signal.throwIfAborted();
      await this.status(controller.signal); controller.signal.throwIfAborted();
      if (!this.view.configured) throw new Error('app_not_configured');
      this.view.app_setup = {state: 'ready'};
    })().catch(() => {
      this.view.app_setup = controller.signal.aborted ? {state: 'idle'} : {state: 'error', error: '应用配置未完成，请重试；已绑定应用不会被自动替换。'};
    }).finally(() => {
      if (this.setupController === controller) this.setupController = undefined;
      if (this.setupTask === task) this.setupTask = undefined;
      this.publish();
    });
    this.setupTask = task;
    return Promise.resolve(this.setupSnapshot());
  }
  async cancelAppSetup(): Promise<FeishuSnapshot> {
    this.setupController?.abort(); await this.setupTask;
    this.view.app_setup = {state: 'idle'}; this.publish();
    return this.snapshot();
  }
  async completeLogin(): Promise<FeishuSnapshot> {
    if (!this.deviceCode || this.now().getTime() >= this.deviceExpiry) throw new Error('请重新开始飞书登录');
    await this.json(['auth', 'login', '--device-code', this.deviceCode, '--json']);
    this.deviceCode = undefined; delete this.view.verification_url;
    await this.status();
    if (this.view.state === 'unauthorized') throw new Error('飞书授权缺少所需权限');
    this.saved.connected = true; this.saved.paused = true;
    this.view.state = 'paused'; await this.save();
    return this.snapshot();
  }
  async listChats(): Promise<FeishuSnapshot> {
    await this.status();
    if (!this.saved.openId || this.view.state === 'unauthorized') throw new Error('请先登录飞书');
    const chats: FeishuSnapshot['chats'] = [];
    let page = '';
    for (let count = 0; count < 20; count++) {
      const data = await this.json(['im', '+chat-list', '--as', 'user', '--types', 'p2p,group', '--sort', 'active_time', '--format', 'json', '--page-size', '50', ...(page ? ['--page-token', page] : [])]);
      const items = pageItems(data, 'chats');
      for (const item of items) {
        const row = object(item); const id = str(row.chat_id);
        if (!id) throw new Error('Missing Feishu chat ID');
        if (!chats.some((chat) => chat.id === id)) chats.push({ id, name: str(row.name) || '未命名会话', selected: this.saved.selected.includes(id) });
      }
      if (data.has_more !== true) { this.view.chats = chats; return this.snapshot(); }
      const next = str(data.page_token);
      if (!next || next === page) throw new Error('Invalid Feishu chat cursor');
      page = next;
    }
    this.view.chats = chats;
    throw new Error('会话列表超过本次读取上限，未完整加载');
  }
  async configure(chatIds: string[], consent: boolean): Promise<void> {
    if (!consent || this.view.state === 'unauthorized' || !this.saved.account || chatIds.some((id) => !this.view.chats.some((chat) => chat.id === id))) throw new Error('请选择已授权的飞书会话');
    await this.pause();
    await this.setProcessingConsent(false,true);
    const previous = new Set(this.saved.selected), since = this.now().toISOString();
    this.saved.scopeConfigured = true; this.saved.selected = [...new Set(chatIds)]; this.saved.connected = true; this.saved.paused = false;
    this.saved.captureFrom = Object.fromEntries(this.saved.selected.map((id) => [id, previous.has(id) ? this.saved.captureFrom?.[id] ?? this.saved.mentionCaptureSince ?? since : since]));
    this.view.chats = this.view.chats.map((chat) => ({ ...chat, selected: chatIds.includes(chat.id) }));
    this.view.state = 'ready'; await this.save();
  }
  async setProcessingConsent(consent:boolean,scopeChanged=false):Promise<void>{
    const prior=this.saved.processingConsent;
    const grant=this.options.processingGrant?.(consent,(prior?.revision??0)+1,(prior?.scope_revision??0)+Number(scopeChanged));
    if(!grant)return;
    const sources=consent?this.saved.sources.filter(id=>this.saved.selected.some(chat=>id===`feishu:${this.saved.account}:${this.saved.generation}:${chat}`)):this.saved.sources;
    await this.options.onProcessingConsent?.(sources,grant);
    this.saved.processingConsent=grant;
    // Automatic capture needs live consent and starts at the grant, never at older history.
    if(grant.extraction_provider)this.saved.consentSince=this.now().toISOString();else delete this.saved.consentSince;
    await this.save();this.publish();
  }
  async sync(): Promise<void> {
    if (this.options.bootstrapOnly) throw new Error('Feishu collection unavailable during setup');
    if (this.pending || this.closed) return;
    const pending = this.syncNow(); this.pending = pending;
    try { await pending; } finally { if (this.pending === pending) this.pending = undefined; this.publish(); }
  }
  private async syncNow(): Promise<void> {
    if (this.busy || this.saved.paused || !this.saved.connected) return;
    this.busy = true; this.active = new AbortController();
    let unsupported = 0;
    try {
      await this.status();
      if (this.view.state !== 'ready') return;
      for (const chat of this.saved.selected) {
        const sourceId = `feishu:${this.saved.account}:${this.saved.generation}:${chat}`;
        if (!this.saved.sources.includes(sourceId)) { this.saved.sources.push(sourceId); await this.save(); }
        const cursor = this.saved.cursors[chat] ?? { start: new Date(this.now().getTime() - 7 * 86400_000).toISOString() };
        cursor.end ??= this.now().toISOString();
        for (let count = 0; count < 20; count++) {
          const data = await this.json(['im', '+chat-messages-list', '--as', 'user', '--chat-id', chat, '--start', cursor.start, '--end', cursor.end, '--order', 'asc', '--page-size', '50', '--format', 'json', '--no-reactions', ...(cursor.page ? ['--page-token', cursor.page] : [])]);
          if (this.active.signal.aborted) return;
          const items = pageItems(data, 'messages');
          for (const item of items) {
            const row = object(item); const id = str(row.message_id);
            if (!id || (row.chat_id && row.chat_id !== chat)) throw new Error('Invalid Feishu message identity');
            const sender = row.sender ? object(row.sender) : {};
            const senderId = str(sender.open_id ?? sender.openId ?? sender.id);
            const senderType = str(sender.sender_type ?? sender.type);
            if (row.deleted === true || (senderType && senderType !== 'user') || !senderId.startsWith('ou_')) continue;
            const text = messageText(row);
            if (text === null) { unsupported++; continue; }
            if (!text) throw new Error('Missing Feishu message body');
            let mention = structuredMention(row, this.saved.openId!);
            if (mention === 'unknown' && (text.includes('@') || (row.msg_type ?? row.message_type) === 'post')) {
              try {
                const raw = await this.json(['api', 'GET', `/open-apis/im/v1/messages/${encodeURIComponent(id)}`, '--as', 'user', '--format', 'json']);
                const original = Array.isArray(raw.items) ? raw.items.map(object).find(item => item.message_id === id) : undefined;
                if (original && (!original.chat_id || original.chat_id === chat)) mention = structuredMention(original, this.saved.openId!);
              } catch { if (this.active.signal.aborted) return; /* Preserve unknown; rendered @names are not identity evidence. */ }
            }
            // A message you wrote yourself never addresses you.
            if (senderId === this.saved.openId) mention = 'none';
            const rawTime = row.create_time_iso ?? row.create_time;
            const numeric = Number(rawTime);
            const time = Number.isFinite(numeric) ? numeric < 1e12 ? numeric * 1000 : numeric : Date.parse(str(rawTime));
            if (!Number.isFinite(time) || time <= 0) throw new Error('Invalid Feishu message time');
            await this.options.ingest!({ ...(this.saved.processingConsent?{processing_consent:this.saved.processingConsent}:{}), id: hash(`${sourceId}:${id}:${hash(text)}`), source_id: sourceId, source_kind: 'im', ...(typeof row.message_app_link==='string'&&row.message_app_link.length<=4096&&row.message_app_link.startsWith('https://')?{source_url:row.message_app_link}:{}), message_id: id, chat_id: chat, recipient_id: this.saved.openId!, sender_name: str(sender.name).slice(0, 120), mention, auto_capture: mention === 'direct' && time >= Math.max(Date.parse(this.saved.captureFrom?.[chat] ?? this.saved.mentionCaptureSince!), Date.parse(this.saved.consentSince ?? '')), locator: `feishu://message/${encodeURIComponent(id)}`, raw_text: text, observed_at: new Date(time).toISOString(), retention_until: new Date(time + 30 * 86400_000).toISOString(), sender_id: senderId, account_id: this.saved.account! });
            if (this.active.signal.aborted) return;
          }
          if (data.has_more !== true) {
            this.saved.cursors[chat] = { start: new Date(new Date(cursor.end).getTime() - 60_000).toISOString() };
            await this.save(); break;
          }
          const next = str(data.page_token);
          if (!next || next === cursor.page) throw new Error('Invalid Feishu message cursor');
          cursor.page = next; this.saved.cursors[chat] = cursor; await this.save();
          if (count === 19) throw new Error('消息仍有后续页，将从保存位置继续');
        }
      }
      this.saved.lastSync = this.now().toISOString(); this.view.last_sync = this.saved.lastSync;
      if (unsupported) this.view.error = `已读取文字消息，${unsupported} 条附件或其他格式未提取正文`;
      else delete this.view.error;
      await this.save();
    } finally { this.busy = false; this.active = undefined; }
  }
  async pause(): Promise<void> {
    this.saved.paused = true; this.view.state = 'paused'; this.active?.abort();
    this.listenerController?.abort(); await this.listener?.catch(() => { /* Cancellation is expected. */ });
    await this.pending?.catch(() => { /* Cancellation is expected while draining. */ }); await this.save();
  }
  async disconnect(): Promise<void> {
    await this.pause(); await this.setProcessingConsent(false); this.saved.connected = false; this.saved.bot = false; this.view.bot_enabled = false; this.view.state = 'disconnected';
    this.deviceCode = undefined; delete this.view.verification_url; await this.save();
    try { await this.stopOwnedBus(); } finally { await this.json(['auth', 'logout', '--json']); }
  }
  async deleteHistory(): Promise<void> {
    if (this.options.bootstrapOnly) throw new Error('Feishu collection unavailable during setup');
    await this.pause();
    const sources = [...this.saved.sources];
    // Persist the new generation before deletion so a crash cannot resume into a fenced source.
    this.saved.generation++;
    this.saved.cursors = {}; this.saved.deliveries = {}; this.saved.actions = []; delete this.saved.lastSync; delete this.view.last_sync; await this.save();
    for (const source of sources) {
      await this.options.deleteSource!(source);
      this.saved.sources = this.saved.sources.filter((item) => item !== source); await this.save();
    }
  }
  async sendReminder(proposal: { id: string; title: string; body: string }): Promise<boolean> {
    if (this.pending || this.closed) return false;
    this.active = new AbortController();
    const task = this.sendReminderNow(proposal);
    const pending = task.then(() => { /* Track completion independently of the send result. */ }); this.pending = pending;
    try { return await task; } finally { await pending.catch(() => { /* Cancellation is expected while draining. */ }); if (this.pending === pending) this.pending = undefined; this.active = undefined; }
  }
  private async sendReminderNow(proposal: { id: string; title: string; body: string }): Promise<boolean> {
    if (!this.saved.bot || !this.saved.connected || this.saved.paused || !this.saved.openId) return false;
    await this.status();
    if (this.view.state !== 'ready' || this.active?.signal.aborted) return false;
    const delivery = this.saved.deliveries[proposal.id] ?? { nonce: randomUUID() };
    if (delivery.message) return true;
    this.saved.deliveries[proposal.id] = delivery; await this.save();
    const card = { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: proposal.title.slice(0, 150) } }, elements: [
      { tag: 'div', text: { tag: 'plain_text', content: proposal.body.slice(0, 2000) } },
      { tag: 'action', actions: [['open', '在 Nova 中查看'], ['snooze', '稍后提醒'], ['ignore', '忽略']].map(([action, label]) => ({ tag: 'button', text: { tag: 'plain_text', content: label }, value: { nonce: delivery.nonce, proposal_id: proposal.id, action } })) },
    ] };
    const result = await this.json(['im', '+messages-send', '--as', 'bot', '--user-id', this.saved.openId, '--msg-type', 'interactive', '--content', JSON.stringify(card), '--idempotency-key', delivery.nonce, '--format', 'json']);
    delivery.message = str(result.message_id); delivery.chat = str(result.chat_id);
    if (!delivery.message || !delivery.chat) throw new Error('Missing Feishu delivery receipt');
    await this.save(); return true;
  }
  async consumeActions(): Promise<void> {
    if (this.options.bootstrapOnly) throw new Error('Feishu collection unavailable during setup');
    if (this.listener || this.closed || !this.saved.bot || !this.saved.connected || this.saved.paused) return;
    const controller = new AbortController(); this.listenerController = controller;
    this.listenerApp = this.currentApp;
    let callbacks = Promise.resolve(); let queued = 0;
    const task = this.run(['event', 'consume', 'card.action.trigger', '--as', 'bot', '--quiet', '--timeout', '0s', '--max-events', '0'], {
      signal: controller.signal,
      onLine: (line) => {
        if (++queued > 200) { controller.abort(); throw new Error('Feishu callback queue limit'); }
        const event = jsonObject(line);
        callbacks = callbacks.then(async () => { await this.acceptAction(event); }).catch(() => { this.view.error = '飞书操作未保存，请在 Nova 中处理'; }).finally(() => { queued--; this.publish(); });
      },
    });
    const listener = task.then(() => { /* Process completion only: host callbacks use a separate queue. */ });
    this.listener = listener;
    try {
      await listener;
    } finally {
      if (this.listener === listener) this.listener = undefined;
      if (this.listenerController === controller) this.listenerController = undefined;
    }
  }
  async acceptAction(event: Record<string, unknown>): Promise<boolean> {
    if (this.closed || !this.saved.bot || !this.saved.connected || this.saved.paused || event.operator_id !== this.saved.openId || event.type !== 'card.action.trigger') return false;
    const action = jsonObject(str(event.action_value));
    const proposalId = str(action.proposal_id); const delivery = this.saved.deliveries[proposalId]; const eventId = str(event.event_id);
    if (!delivery || !eventId || this.saved.actions.includes(eventId) || action.nonce !== delivery.nonce || event.message_id !== delivery.message || event.chat_id !== delivery.chat) return false;
    if (action.action !== 'open' && action.action !== 'snooze' && action.action !== 'ignore') return false;
    // Host must reuse its feed action ledger; 'open' is navigation, never execution authorization.
    const account = this.saved.account; const generation = this.saved.generation;
    await this.options.onAction!({ proposal_id: proposalId, action: action.action, event_id: eventId });
    if (!this.closed && this.saved.account === account && this.saved.generation === generation) { this.saved.actions.push(eventId); await this.save(); }
    return true;
  }
  async command(method: string, params: Record<string, unknown> = {}): Promise<FeishuSnapshot> {
    if (!this.view.available && method !== 'feishu.status') throw new Error(this.view.error ?? '飞书 CLI 不可用');
    if (this.options.bootstrapOnly && !['feishu.status', 'feishu.app.start', 'feishu.app.status', 'feishu.app.cancel', 'feishu.app.bind', 'feishu.login', 'feishu.complete'].includes(method)) throw new Error('飞书同步需要运行中的模型服务');
    switch (method) {
      case 'feishu.app.bind':
        if (Object.keys(params).sort().join(',') !== 'app_id,app_secret' || typeof params.app_id !== 'string' || !/^cli_[A-Za-z0-9]{1,128}$/u.test(params.app_id)
          || typeof params.app_secret !== 'string' || !params.app_secret.trim() || params.app_secret.length > 4096 || /[\0\r\n]/u.test(params.app_secret)) throw new Error('Invalid app binding');
        return this.beginAppSetup({app_id: params.app_id, app_secret: params.app_secret});
      case 'feishu.app.start': case 'feishu.app.status': case 'feishu.app.cancel':
        if (Object.keys(params).length) throw new Error('Invalid app setup request');
        return method === 'feishu.app.start' ? this.beginAppSetup() : method === 'feishu.app.cancel' ? this.cancelAppSetup() : this.setupSnapshot();
      case 'feishu.status': await this.status(); return this.setupSnapshot();
      case 'feishu.login': return this.beginLogin();
      case 'feishu.complete': case 'feishu.auth.complete': return this.completeLogin();
      case 'feishu.chats': return this.listChats();
      case 'feishu.consent': {
        if(typeof params.consent!=='boolean')throw Error('invalid_request');
        await this.setProcessingConsent(params.consent);break;
      }
      case 'feishu.configure': {
        if (!Array.isArray(params.chat_ids) || !params.chat_ids.every((id) => typeof id === 'string')) throw new Error('Invalid chat selection');
        await this.configure(params.chat_ids, params.consent === true); break;
      }
      case 'feishu.sync': await this.sync(); break;
      case 'feishu.pause': await this.pause(); break;
      case 'feishu.resume': await this.status(); if (this.view.state === 'unauthorized' || !this.saved.connected) throw new Error('请先重新连接飞书'); this.saved.paused = false; this.view.state = 'ready'; await this.save(); break;
      case 'feishu.disconnect': await this.disconnect(); break;
      case 'feishu.delete': await this.deleteHistory(); break;
      case 'feishu.bot.configure':
        if (typeof params.enabled !== 'boolean' || !this.saved.connected) throw new Error('请先连接飞书');
        this.saved.bot = params.enabled; this.view.bot_enabled = this.saved.bot;
        if (!this.saved.bot) { this.listenerController?.abort(); await this.listener?.catch(() => { /* Delivery disabled. */ }); }
        await this.save(); break;
      default: throw new Error('Unsupported Feishu operation');
    }
    this.startListener();
    this.publish();
    return this.snapshot();
  }
}
