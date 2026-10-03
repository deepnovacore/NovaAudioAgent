import {conversationsStateSchema,initialConversations,type ConversationsState} from './conversations.js';
import {Worker} from 'node:worker_threads';
import { z } from 'zod';
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { preparePrivateDatabasePath } from '../storage/private-database.js';
import { feedItemSchema, personalSettingsSchema, type FeedItem, type PersonalSettings } from './contracts.js';
export interface PersonalState {
    conversations:ConversationsState;
    user_scope: string | null;
    revision: number;
    feed: FeedItem[];
    dedupe: string[];
    settings: PersonalSettings;
    receipts: Record<string, {
        payload: string;
        result: unknown;
    }>;
}
export const initialState = (): PersonalState => ({ conversations:initialConversations(), user_scope: null, revision: 0, feed: [], dedupe: [], settings: { discovery_enabled: true, discovery_interval_minutes: 30 }, receipts: {} });
// ponytail: bounded JSON ledger; move to the existing Worker if 10000 retained matters are needed.
const MAX_STORE_BYTES = 16 * 1024 * 1024;
const stateSchema = z.object({ conversations:conversationsStateSchema.default(initialConversations), user_scope: z.string().max(512).nullable(), revision: z.number().int().nonnegative(), feed: z.array(feedItemSchema).max(10000), dedupe: z.array(z.string().max(128)).max(20000), settings: personalSettingsSchema, receipts: z.record(z.string().max(128), z.object({ payload: z.string().max(16384), result: z.unknown() })).refine(r => Object.keys(r).length <= 256) }).strict();
export class PersonalStore {
    constructor(readonly path: string) { }
    async read(): Promise<PersonalState> {
        preparePrivateDatabasePath(this.path);
        const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            if ((await file.stat()).size > MAX_STORE_BYTES)
                throw Error('personal_store_capacity');
            const text = await file.readFile('utf8');
            return text === '' ? initialState() : stateSchema.parse(JSON.parse(text));
        }
        finally {
            await file.close();
        }
    }
    async write(state: PersonalState): Promise<void> {
        const text = JSON.stringify(stateSchema.parse(state));
        if (Buffer.byteLength(text) > MAX_STORE_BYTES)
            throw Error('personal_store_capacity');
        preparePrivateDatabasePath(this.path);
        const tmp = this.path + '.' + randomUUID() + '.tmp';
        const file = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
            await file.writeFile(text);
            await file.sync();
        }
        catch (e) {
            await unlink(tmp).catch(() => { /* cleanup retains original failure */ });
            throw e;
        }
        finally {
            await file.close();
        }
        try {
            await rename(tmp, this.path);
            // Node cannot fsync directories on Windows; the file was synced before rename.
            if (process.platform !== 'win32') {
                const directory = await open(dirname(this.path), constants.O_RDONLY);
                try {
                    await directory.sync();
                }
                finally {
                    await directory.close();
                }
            }
        }
        catch (e) {
            await unlink(tmp).catch(() => { /* cleanup retains original failure */ });
            throw e;
        }
    }
}
/** SQLite's OS lock is released on process death; the Worker stores no user content. */
export async function acquirePersonalLock(path: string): Promise<() => Promise<void>> {
    const worker = new Worker(new URL('./store-lock-worker.js', import.meta.url), {workerData: {path: path + '.owner.sqlite'}});
    try {
        await new Promise<void>((resolve, reject) => {
            worker.once('message', (message: {ready:boolean}) => message.ready ? resolve() : reject(Error('personal_store_locked')));
            worker.once('error', reject);
            worker.once('exit', code => reject(Error(`personal_store_lock_exit:${code}`)));
        });
    } catch (error) { await worker.terminate(); throw error; }
    // Ownership must not keep an otherwise stopped host process alive.
    worker.unref();
    let released=false;
    return async () => {
        if(released)return;
        released=true;
        worker.ref();
        const exited=new Promise<void>(resolve=>worker.once('exit',()=>resolve()));
        worker.postMessage('release');
        await exited;
    };
}
