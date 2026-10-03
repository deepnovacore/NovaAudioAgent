import {createHash} from 'node:crypto'
import {z} from 'zod'
import {MacNativeReader} from './reader.js'
import {canonicalJson} from '../../text/canonical-json.js'
import {ComposioFailure} from '../composio/client.js'
import type {GooglePage,GoogleObject} from '../composio/google.js'
export const macMailScopeSchema=z.object({kind:z.literal('macos_mail'),mailboxes:z.array(z.string().min(1).max(4096)).min(1).max(20),pastDays:z.number().int().min(1).max(180)}).strict()
export type MacMailScope=z.infer<typeof macMailScopeSchema>
const cursorSchema=z.object({box:z.number().int().min(0).max(20),offset:z.number().int().min(0).max(500),fingerprints:z.array(z.string().max(256)).max(20)}).strict()
const requestSchema=z.union([z.object({command:z.enum(['status','request_access','list_mailboxes'])}).strict(),z.object({command:z.literal('snapshot'),mailboxes:macMailScopeSchema.shape.mailboxes,start:z.iso.datetime(),end:z.iso.datetime(),cursor:cursorSchema.nullable()}).strict()])
const messageSchema=z.object({account:z.string().min(1).max(1024),mailbox:z.string().min(1).max(4096),id:z.string().min(1).max(128),messageId:z.string().max(4096),subject:z.string().max(10000),sender:z.string().max(10000),recipients:z.array(z.string().max(10000)).max(200),received:z.iso.datetime(),sent:z.iso.datetime(),content:z.string().max(2*1024*1024),read:z.boolean(),flagged:z.boolean()}).strict()
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
export function normalizeMacMailMessage(input:unknown):GoogleObject{
 const e=messageSchema.parse(input),{read,flagged,...semantic}=e,key=hash(canonicalJson([e.account,e.mailbox,e.id])),text=[e.subject,e.sender,e.recipients.join(', '),e.received,e.content].join('\n')
 return {key,semanticHash:hash(canonicalJson(semantic)),metadata:{account:e.account,mailbox:e.mailbox,remote_id:e.id,message_id:e.messageId,read,flagged,truncated:text.length>99000},text:text.length>99000?text.slice(0,99000)+'\n[正文已截断]':text,locator:e.messageId?'message://'+encodeURIComponent('<'+e.messageId+'>'):'message://',observedAt:e.received,retentionUntil:new Date(Date.parse(e.received)+180*86400000).toISOString(),kind:'mail',status:'current'}
}
export class MacMailClient {
 constructor(readonly resourcesRoot:string){}
 request(input:unknown,signal=AbortSignal.timeout(30000)){return new MacNativeReader(this.resourcesRoot,'macos_mail').request(requestSchema.parse(input),signal)}
 async page(scope:MacMailScope,cursor:unknown,anchor:number,signal:AbortSignal):Promise<Omit<GooglePage,'continuation'>&{continuation:z.infer<typeof cursorSchema>|null;scanLimited:boolean}>{
  const start=new Date(anchor-scope.pastDays*86400000).toISOString(),end=new Date(anchor).toISOString(),result=await this.request({command:'snapshot',mailboxes:scope.mailboxes,start,end,cursor},signal)
  const parsed=z.object({status:z.literal('granted'),messages:z.array(messageSchema).max(8),complete:z.boolean(),capped:z.boolean(),cursor:cursorSchema.nullable()}).strict().parse(result)
  if(parsed.complete!==(parsed.cursor===null))throw new ComposioFailure('invalid_contract')
  if(parsed.messages.some(e=>!scope.mailboxes.includes(e.mailbox)||e.received<start||e.received>=end))throw new ComposioFailure('scope_denied')
  // ponytail: Mail offset scans are not atomic; never infer provider deletion without a stable ID inventory.
  return {objects:parsed.messages.map(normalizeMacMailMessage),continuation:parsed.cursor,checkpoint:null,complete:parsed.complete,snapshot:false,scanLimited:parsed.capped}
 }
}
