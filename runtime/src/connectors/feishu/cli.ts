import { spawn } from 'node:child_process';
import { mkdir, chmod } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export type FeishuRun = (args: string[], options?: { input?: string; signal?: AbortSignal; onLine?: (line: string) => void; onOutput?: (chunk: string) => void }) => Promise<string>;
export class FeishuAppNotConfigured extends Error { constructor() { super('Feishu app not configured'); } }

// Full command AND flag validation. No shell, arbitrary API, identity override or downloads.
export function assertFeishuCommand(args: readonly string[]): void {
  const definitions: [string[], Record<string, string | true>][] = [
    [['--version'], {}],
    [['config', 'keychain-downgrade'], {}],
    [['auth', 'status'], { '--json': true, '--verify': true }],
    [['auth', 'login'], { '--scope': '*', '--no-wait': true, '--json': true, '--device-code': '*' }],
    [['auth', 'logout'], { '--json': true }],
    [['config', 'init'], { '--app-id': '*', '--app-secret-stdin': true, '--brand': 'feishu', '--new': true, '--lang': 'zh' }],
    [['im', '+chat-list'], { '--as': 'user', '--types': 'p2p,group', '--sort': 'active_time', '--format': 'json', '--page-size': '50', '--page-token': '*' }],
    [['im', '+chat-messages-list'], { '--as': 'user', '--chat-id': '*', '--start': '*', '--end': '*', '--order': 'asc', '--page-size': '50', '--page-token': '*', '--format': 'json', '--no-reactions': true }],
    [['im', '+messages-send'], { '--as': 'bot', '--user-id': '*', '--content': '*', '--msg-type': 'interactive', '--idempotency-key': '*', '--format': 'json' }],
    [['event', 'consume', 'card.action.trigger'], { '--as': 'bot', '--quiet': true, '--timeout': '0s', '--max-events': '0' }],
    [['event', 'stop'], { '--json': true, '--app-id': '*' }],
  ];
  const definition = definitions.find(([prefix]) => prefix.every((part, i) => args[i] === part));
  if (!definition) throw new Error('Unsupported Feishu command');
  const [prefix, flags] = definition;
  const seen = new Set<string>();
  for (let i = prefix.length; i < args.length; i++) {
    const flag = args[i]!;
    const expected = flags[flag];
    if (!expected || seen.has(flag)) throw new Error('Unsupported Feishu argument');
    seen.add(flag);
    if (expected !== true) {
      const value = args[++i];
      if (!value || value.startsWith('--') || value.includes('\0') || (expected !== '*' && value !== expected)) {
        throw new Error('Invalid Feishu argument');
      }
    }
  }
  if (prefix[0] === 'im' || (prefix[0] === 'event' && prefix[1] === 'consume')) {
    if (!seen.has('--as')) throw new Error('Feishu identity required');
  }
  const key = prefix.join(' ');
  const required: Record<string, string[]> = {
    'auth status': ['--json', '--verify'], 'auth logout': ['--json'],
    'im +chat-list': ['--as', '--types', '--sort', '--format', '--page-size'],
    'im +chat-messages-list': ['--as', '--chat-id', '--start', '--end', '--order', '--page-size', '--format', '--no-reactions'],
    'im +messages-send': ['--as', '--user-id', '--content', '--msg-type', '--idempotency-key', '--format'],
    'event consume card.action.trigger': ['--as', '--quiet', '--timeout', '--max-events'], 'event stop': ['--json', '--app-id'],
  };
  if (required[key]?.some((flag) => !seen.has(flag))) throw new Error('Missing Feishu command argument');
  if (key === 'config init') {
    const exact = seen.has('--new') ? ['--new', '--lang'] : ['--app-id', '--app-secret-stdin', '--brand'];
    if (seen.size !== exact.length || exact.some(flag => !seen.has(flag))) throw new Error('Invalid Feishu app configuration');
  }
  if (key === 'auth login') {
    const device = seen.has('--device-code');
    if (!seen.has('--json') || (device ? seen.has('--scope') || seen.has('--no-wait') : !seen.has('--scope') || !seen.has('--no-wait'))) throw new Error('Invalid Feishu login command');
    if (!device && args[args.indexOf('--scope') + 1] !== 'offline_access,im:chat:read,im:message:readonly,im:message.reactions:read') throw new Error('Unsupported Feishu scope');
  }
}

export function createFeishuRunner(executable: string, credentialRoot: string): FeishuRun {
  if (!executable.trim() || !credentialRoot.trim() || !isAbsolute(credentialRoot)) throw new Error('Absolute Feishu credential root required');
  const execute: FeishuRun = async (args, options = {}) => {
    assertFeishuCommand(args);
    const stream = args[0] === 'event' && args[1] === 'consume';
    const setup = args[0] === 'config' && args[1] === 'init' && args.includes('--new');
    if (stream && (!options.onLine || !options.signal)) throw new Error('Feishu event stream requires consumer and cancellation');
    if (setup && (!options.onOutput || !options.signal)) throw new Error('Feishu app setup requires progress and cancellation');
    await mkdir(credentialRoot, { recursive: true, mode: 0o700 });
    await chmod(credentialRoot, 0o700);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: credentialRoot, USERPROFILE: credentialRoot,
      XDG_CONFIG_HOME: join(credentialRoot, 'config'),
      LARKSUITE_CLI_CONFIG_DIR: join(credentialRoot, 'config', 'lark-cli'),
      LARKSUITE_CLI_LOG_DIR: join(credentialRoot, 'logs'),
    };
    return new Promise<string>((resolve, reject) => {
      const child = spawn(executable, args, { env, cwd: credentialRoot, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '';
      let statusError = '';
      let bytes = 0;
      let failure: Error | undefined;
      let terminateTimer: ReturnType<typeof setTimeout> | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = (reason: string) => {
        if (failure) return;
        failure = new Error(reason);
        // EOF lets event consume unregister its subscription before the process exits.
        child.stdin.end();
        if (stream) terminateTimer = setTimeout(() => { child.kill('SIGTERM'); }, 1_000);
        else child.kill('SIGTERM');
        killTimer = setTimeout(() => { child.kill('SIGKILL'); }, 3_000);
      };
      const abort = () => stop('Feishu operation cancelled');
      const timer = stream ? undefined : setTimeout(() => stop('Feishu operation timed out'), setup ? 300_000 : 90_000);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (failure) return;
        stdout += chunk;
        if (setup) options.onOutput?.(chunk);
        if (Buffer.byteLength(stdout) > 2_000_000) { stop('Feishu output limit exceeded'); return; }
        if (stream) {
          let newline: number;
          while ((newline = stdout.indexOf('\n')) >= 0) {
            const line = stdout.slice(0, newline); stdout = stdout.slice(newline + 1);
            try { if (line.trim()) options.onLine!(line); } catch { stop('Invalid Feishu event stream'); return; }
          }
        }
      });
      // Never attach provider stderr to errors: it can contain credentials or message bodies.
      child.stderr.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (args[0] === 'auth' && args[1] === 'status') statusError = (statusError + chunk.toString('utf8')).slice(-65536);
        if (bytes > 2_000_000) stop('Feishu output limit exceeded'); else if (setup) options.onOutput?.(chunk.toString('utf8'));
      });
      child.on('error', () => { failure = new Error('Feishu CLI unavailable'); });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (terminateTimer) clearTimeout(terminateTimer);
        if (killTimer) clearTimeout(killTimer);
        options.signal?.removeEventListener('abort', abort);
        if (!failure && code === 3 && statusError) {
          try { const response = JSON.parse(statusError) as {error?: {type?: string; subtype?: string}}; if (response.error?.type === 'config' && response.error.subtype === 'not_configured') failure = new FeishuAppNotConfigured(); } catch { /* Never echo provider errors. */ }
        }
        if (failure || code !== 0) reject(failure ?? new Error(`Feishu CLI failed (${code})`));
        else resolve(stdout);
      });
      child.stdin.on('error', () => { /* Process close reports a sanitized error. */ });
      if (!stream) child.stdin.end(options.input ?? '');
    });
  };
  let credentialAccess: Promise<string> | undefined;
  return async (args, options = {}) => {
    assertFeishuCommand(args);
    if (process.platform === 'darwin' && args[0] !== '--version' && args[1] !== 'keychain-downgrade') {
      // The isolated HOME has no login Keychain. Use the CLI's supported 0600
      // file backend; it preserves any existing master key and OS entry.
      credentialAccess ??= execute(['config', 'keychain-downgrade']).catch(() => {
        credentialAccess = undefined;
        throw new Error('飞书凭据存储初始化失败，请取消钥匙串弹窗后重试；无需还原系统钥匙串');
      });
      await credentialAccess;
      if (options.signal?.aborted) throw new Error('Feishu operation cancelled');
    }
    return execute(args, options);
  };
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Feishu response');
  return value as Record<string, unknown>;
}

export function parseFeishuJson(text: string): Record<string, unknown> {
  // CLI may print an informational line before its JSON envelope.
  let payload: Record<string, unknown> | undefined;
  for (const offset of [0, ...Array.from(text.matchAll(/\n(?=[{])/g), (match) => match.index + 1)]) {
    try { payload = object(JSON.parse(text.slice(offset))); break; } catch { /* try next complete JSON envelope */ }
  }
  if (!payload || payload.success === false || payload.error || (typeof payload.code === 'number' && payload.code !== 0)) throw new Error('Invalid or failed Feishu response');
  return payload.data && typeof payload.data === 'object' ? object(payload.data) : payload;
}
