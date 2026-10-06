import { z } from 'zod';
export const versionSchema = z.union([z.number().int().nonnegative(), z.string().min(1).max(128)]);
export const proposalSchema = z.object({ kind: z.enum(['notify', 'question']), summary: z.string().trim().min(1).max(200), why_now: z.string().max(200), evidence_refs: z.array(z.string().min(1).max(512)).max(16), memory_refs: z.array(z.object({ entry_id: z.string().min(1).max(256), version: versionSchema }).strict()).max(16) }).strict().refine(p => p.evidence_refs.length + p.memory_refs.length > 0);
export type Proposal = z.infer<typeof proposalSchema>;
export const personalCommandSchema = z.object({ type: z.literal('personal.command'), request_id: z.string().min(1).max(128), method: z.enum(['context.dismiss','context.adopt','profile.refresh','presentation.set','presentation.seen','understanding.start','understanding.action','life.mutate','news.convert','news.configure','news.action','news.refresh','news.state','conversations.targets','conversations.target','conversations.read','conversations.create','conversations.select','conversations.open_work','conversations.clear','conversations.confirm','conversations.open_feed','conversations.voice','state', 'feed.action', 'memory.list', 'memory.evidence', 'memory.correct', 'memory.forget', 'memory.purge', 'memory.reextract', 'discovery.configure', 'sources.add', 'sources.authorize_computer', 'sources.consent', 'sources.pause', 'sources.resume', 'sources.disconnect', 'sources.delete', 'sources.sync', 'connector.mail_status', 'connector.mail_access', 'connector.mail_connect', 'connector.local_status', 'connector.local_access', 'connector.local_connect', 'connector.status', 'connector.link', 'connector.complete', 'connector.configure', 'connector.consent', 'connector.scopes', 'connector.sync', 'connector.pause', 'connector.resume', 'connector.disconnect', 'connector.delete', 'feishu.status', 'feishu.app.start', 'feishu.app.status', 'feishu.app.cancel', 'feishu.app.bind', 'feishu.login', 'feishu.complete', 'feishu.chats', 'feishu.configure', 'feishu.consent', 'feishu.sync', 'feishu.pause', 'feishu.resume', 'feishu.disconnect', 'feishu.delete', 'feishu.bot.configure','tasks.list','tasks.get','tasks.delegate','tasks.control','tasks.input','tasks.cancel','tasks.continue','tasks.reconcile','tasks.complete_todo','conversations.approve']), params: z.record(z.string(), z.unknown()).default({}) }).strict();
export const preparedContentSchema=z.object({trust:z.literal('untrusted_external'),text:z.string().trim().min(1).max(12000),evidence_refs:z.array(z.string().min(1).max(512)).max(16)}).strict();
export type PreparedContent=z.infer<typeof preparedContentSchema>;
export interface PreparedMaterial {prepared:PreparedContent;action_label:string;memory_refs:Proposal['memory_refs']}
export interface FeedItem {
    prepared?:PreparedContent|undefined;
    action_label?:string|undefined;
    id: string;
    kind: 'notify' | 'question' | 'task_result' | 'schedule' | 'change';
    title: string;
    why_now: string;
    evidence_refs: string[];
    memory_refs: Proposal['memory_refs'];
    source: {
        type: 'conversation' | 'task' | 'memory' | 'file' | 'mail' | 'calendar' | 'im';
        ref: string;
    };
    suggestion_id: string | null;
    task_ref: {
        work_id: string;
    } | null;
    subject_key: string;
    priority: number;
    created_at: string;
    updated_at: string;
    expires_at: string | null;
    user_state: 'new' | 'seen' | 'snoozed' | 'dismissed';
    snooze_until: string | null;
    lifecycle: 'active' | 'resolved' | 'invalidated';
    delivery: {
        presented_at: string | null;
        notified_at: string | null;
        spoken_at: string | null;
        im_sent_at?: string | null | undefined;
    };
}
export interface PersonalSettings {
    discovery_enabled: boolean;
    discovery_interval_minutes: number;
    timezone?:string|undefined;
    briefing_outlook_enabled?:boolean|undefined;
    briefing_review_enabled?:boolean|undefined;
    briefing_outlook_time?:string|undefined;
    briefing_review_time?:string|undefined;
    briefing_weekdays?:number[]|undefined;
    quiet_start?:string|undefined;
    quiet_end?:string|undefined;
}
export const feedItemSchema: z.ZodType<FeedItem> = z.object({
    prepared:preparedContentSchema.optional(),action_label:z.string().trim().min(1).max(80).optional(),
    id: z.string().min(1).max(128), kind: z.enum(['notify', 'question', 'task_result', 'schedule', 'change']), title: z.string().max(120), why_now: z.string().max(200), evidence_refs: z.array(z.string().max(512)).max(16), memory_refs: z.array(z.object({ entry_id: z.string().max(256), version: versionSchema }).strict()).max(16), source: z.object({ type: z.enum(['conversation', 'task', 'memory', 'file', 'mail', 'calendar', 'im']), ref: z.string().max(512) }).strict(), suggestion_id: z.string().nullable(), task_ref: z.object({ work_id: z.string() }).strict().nullable(), subject_key: z.string(), priority: z.number().finite(), created_at: z.string().datetime(), updated_at: z.string().datetime(), expires_at: z.string().datetime().nullable(), user_state: z.enum(['new', 'seen', 'snoozed', 'dismissed']), snooze_until: z.string().datetime().nullable(), lifecycle: z.enum(['active', 'resolved', 'invalidated']), delivery: z.object({ presented_at: z.string().datetime().nullable(), notified_at: z.string().datetime().nullable(), spoken_at: z.string().datetime().nullable(), im_sent_at: z.string().datetime().nullable().optional() }).strict(),
}).strict();
const wallClockSchema=z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u);
const timezoneSchema=z.string().min(1).max(80).refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return true}catch{return false}},'invalid timezone');
export const personalSettingsSchema = z.object({ discovery_enabled: z.boolean(), discovery_interval_minutes: z.number().int().min(5).max(1440),
    timezone:timezoneSchema.optional(),briefing_outlook_enabled:z.boolean().optional(),briefing_review_enabled:z.boolean().optional(),
    briefing_outlook_time:wallClockSchema.optional(),briefing_review_time:wallClockSchema.optional(),
    briefing_weekdays:z.array(z.number().int().min(1).max(7)).max(7).refine(days=>new Set(days).size===days.length).optional(),
    quiet_start:wallClockSchema.optional(),quiet_end:wallClockSchema.optional(),
}).strict();
