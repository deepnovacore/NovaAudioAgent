import {z} from 'zod'
/** Display projections are host-derived, never a model-authored channel label. */
export const sourceTagSchema=z.object({
 evidence_id:z.string().min(1).max(600),type:z.enum(['conversation','file','mail','calendar','im','task']),
 provider:z.string().max(80).optional(),label:z.string().max(120).optional(),
 observed_at:z.iso.datetime({offset:true}),summary:z.string().max(700).optional(),url:z.string().max(4096).optional(),mentioned_me:z.boolean().optional(),
}).strict()
export type SourceTag=z.infer<typeof sourceTagSchema>
export const imMetadataSchema=z.object({
 sender_id:z.string().min(1).max(512),account_id:z.string().min(1).max(512),provider:z.string().min(1).max(512).optional(),
 message_id:z.string().min(1).max(256).optional(),chat_id:z.string().min(1).max(256).optional(),recipient_id:z.string().min(1).max(256).optional(),sender_name:z.string().max(120).optional(),
 source_url:z.string().max(4096).optional(),
 mention:z.enum(['direct','all','none','unknown']).optional(),auto_capture:z.boolean().optional(),
}).strict()
export type ImMetadata=z.infer<typeof imMetadataSchema>
