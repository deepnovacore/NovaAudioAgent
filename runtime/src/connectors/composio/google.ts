import {z} from 'zod'
import {createHash} from 'node:crypto'
import {canonicalJson} from '../../text/canonical-json.js'
import type {JsonValue} from '../../core/events.js'
import {ComposioFailure,createComposioBudget,type ComposioBudget,type GoogleRead,type VerifiedConnection} from './client.js'
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
const rec=z.record(z.string(),z.unknown())
const text=(v:unknown,max=100000)=>{if(v===undefined||v===null)return '';if(typeof v!=='string'||v.length>max)throw new ComposioFailure('invalid_contract');return v}
const array=(v:unknown)=>{if(!Array.isArray(v)||v.length>200)throw new ComposioFailure('invalid_contract');return v as unknown[]}
const object=(v:unknown)=>{const r=rec.safeParse(v);if(!r.success)throw new ComposioFailure('invalid_contract');return r.data}
export interface GoogleObject {key:string;semanticHash:string;metadata:Record<string,JsonValue>;text:string;locator:string;observedAt:string;retentionUntil:string|null;kind:'mail'|'calendar';status:'current'|'coverage_removed'|'provider_deleted'}
function empty(kind:GoogleObject['kind'],remoteId:string,status:GoogleObject['status'],calendar=''):GoogleObject{
 return {key:hash(kind+':'+calendar+':'+remoteId),semanticHash:hash(status),metadata:{remote_id:remoteId,...(calendar?{calendar_id:calendar}:{})},text:'',locator:kind==='mail'?'https://mail.google.com/mail/u/0/#inbox/'+encodeURIComponent(remoteId):'https://calendar.google.com/',observedAt:new Date().toISOString(),retentionUntil:null,kind,status}
}
export function normalizeGmailMessage(value:unknown,labels:readonly string[],window:{start:number;end:number}):GoogleObject{
 const m=object(value),remoteId=text(m.messageId,128);if(!remoteId)throw new ComposioFailure('invalid_contract')
 const timestamp=Date.parse(text(m.messageTimestamp,100)),actualLabels=array(m.labelIds).map(x=>text(x,256))
 if(!Number.isFinite(timestamp))throw new ComposioFailure('invalid_contract')
 const item=empty('mail',remoteId,'current')
 item.metadata={...item.metadata,labels:actualLabels,thread_id:text(m.threadId,256)}
 if(timestamp<window.start||timestamp>=window.end||!labels.every(x=>actualLabels.includes(x)))return {...item,status:'coverage_removed'}
 item.text=[text(m.subject,10000),text(m.sender,4000),text(m.to,10000),text(m.messageText,2*1024*1024)].join('\n')
 item.observedAt=new Date(timestamp).toISOString();item.retentionUntil=new Date(timestamp+30*86400000).toISOString()
 item.semanticHash=hash(canonicalJson({text:item.text,at:item.observedAt}));return excerpt(item)
}
export function normalizeCalendarEvent(calendar:string,value:unknown,calendarZone='UTC'):GoogleObject{
 const e=object(value),remoteId=text(e.id,4096);if(!remoteId)throw new ComposioFailure('invalid_contract')
 if(e.status==='cancelled')return empty('calendar',remoteId,'provider_deleted',calendar)
 const start=object(e.start),end=object(e.end)
 for(const d of [start,end])if(!(typeof d.date==='string'&&/^\d{4}-\d{2}-\d{2}$/u.test(d.date))&&!(typeof d.dateTime==='string'&&Number.isFinite(Date.parse(d.dateTime))))throw new ComposioFailure('invalid_contract')
 const metadata=z.record(z.string(),z.json()).parse({calendar_id:calendar,remote_id:remoteId,start,end,recurringEventId:e.recurringEventId??null,originalStartTime:e.originalStartTime??null})
 const item=empty('calendar',remoteId,'current',calendar)
 item.metadata=metadata;item.text=[text(e.summary,10000),text(e.description,2*1024*1024),text(e.location,4000),canonicalJson({start,end})].join('\n')
 item.semanticHash=hash(canonicalJson({text:item.text,recurrence:e.recurrence??null,status:e.status??'confirmed'}))
 if(typeof e.updated==='string'&&Number.isFinite(Date.parse(e.updated)))item.observedAt=new Date(e.updated).toISOString()
 const endAt=typeof end.dateTime==='string'?Date.parse(end.dateTime):midnight(text(end.date),typeof end.timeZone==='string'?end.timeZone:calendarZone)
 item.retentionUntil=new Date(endAt+30*86400000).toISOString()
 return excerpt(item)
}
function midnight(date:string,timeZone:string):number{
 z.iso.date().parse(date)
 const target=Date.parse(date+'T00:00:00Z'),format=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'})
 let result=target
 for(let n=0;n<3;n++){const p=Object.fromEntries(format.formatToParts(result).map(x=>[x.type,x.value]));const shown=Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);result+=target-shown}
 return result
}
function excerpt(item:GoogleObject):GoogleObject{
 if(item.text.length>99000){item.text=item.text.slice(0,99000)+'\n[正文已截断，请打开原始来源查看完整内容]';item.metadata.truncated=true}
 return item
}
const cursorSchema=z.object({phase:z.enum(['snapshot','history']),start:z.number(),end:z.number(),calendar:z.number().int().nonnegative(),baseline:z.string().nullable(),token:z.string().max(16384).nullable(),nextToken:z.string().max(16384).nullable(),nextBaseline:z.string().nullable(),loaded:z.boolean(),pending:z.array(z.object({id:z.string().min(1).max(256),deleted:z.boolean()})).max(200),seenTokens:z.array(z.string().max(16384)).max(200)}).strict()
export type GoogleCursor=z.infer<typeof cursorSchema>
export interface GooglePage {objects:GoogleObject[];continuation:GoogleCursor|null;checkpoint:{historyId:string}|null;complete:boolean;snapshot:boolean}
interface Reader {read(handle:VerifiedConnection,request:GoogleRead,budget:ComposioBudget):Promise<Record<string,unknown>>}
function token(value:unknown):string|null{if(value===null||value===undefined||value==='')return null;if(typeof value!=='string'||value.length>16384)throw new ComposioFailure('invalid_contract');return value}
export class GoogleProvider {
 constructor(readonly client:Reader){}
 async page(verified:VerifiedConnection,continuation:unknown,budget=createComposioBudget(),checkpoint:{historyId:string}|null=null):Promise<GooglePage>{
  const scope=verified.scope,now=Date.now()
  const fresh:GoogleCursor={phase:checkpoint&&scope.kind==='gmail'?'history':'snapshot',start:now-scope.pastDays*86400000,end:scope.kind==='gmail'?now:now+scope.futureDays*86400000,calendar:0,baseline:checkpoint?.historyId??null,token:null,nextToken:null,nextBaseline:null,loaded:false,pending:[],seenTokens:[]}
  const parsed=cursorSchema.safeParse(continuation??fresh);if(!parsed.success)throw new ComposioFailure('invalid_cursor')
  const c=parsed.data
  const read=(request:GoogleRead)=>this.client.read(verified,request,budget)
  if(scope.kind==='calendar'){
   const calendar=scope.calendars[c.calendar];if(!calendar)throw new ComposioFailure('scope_denied')
   const d=await read({kind:'calendar.list',calendarId:calendar,timeMin:new Date(c.start).toISOString(),timeMax:new Date(c.end).toISOString(),...(c.token?{pageToken:c.token}:{})})
   const objects=array(d.items).map(e=>normalizeCalendarEvent(calendar,e,typeof d.timeZone==='string'?d.timeZone:'UTC')),next=token(d.nextPageToken)
   this.#advance(c,next)
   if(!next){c.calendar++;c.seenTokens=[]}
   const complete=c.calendar>=scope.calendars.length
   return {objects,continuation:complete?null:c,checkpoint:null,complete,snapshot:true}
  }
  if(!c.baseline){const p=await read({kind:'gmail.profile'});c.baseline=text(p.historyId,100);if(!/^\d+$/u.test(c.baseline))throw new ComposioFailure('invalid_contract')}
  if(!c.loaded){
   if(c.phase==='snapshot'){
    const d=await read({kind:'gmail.list',after:Math.floor(c.start/1000),before:Math.floor(c.end/1000),...(c.token?{pageToken:c.token}:{})})
    c.pending=array(d.messages).map(x=>({id:text(object(x).messageId,128),deleted:false}));c.nextToken=token(d.nextPageToken)
   }else{
    const d=await read({kind:'gmail.history',historyId:c.baseline,...(c.token?{pageToken:c.token}:{})})
    const pending=new Map<string,boolean>()
    for(const raw of array(d.history??[])){
     const h=object(raw)
     for(const field of ['messages','messagesAdded','messagesDeleted','labelsAdded','labelsRemoved'])for(const rawMessage of array(h[field]??[])){
      const entry=object(rawMessage),message=field==='messages'?entry:object(entry.message),id=text(message.id,128)
      if(!id)throw new ComposioFailure('invalid_contract')
      pending.set(id,field==='messagesDeleted'||pending.get(id)===true)
     }
    }
    if(pending.size>200)throw new ComposioFailure('history_too_large')
    c.pending=[...pending].map(([id,deleted])=>({id,deleted}));c.nextToken=token(d.nextPageToken);c.nextBaseline=text(d.historyId,100)
    if(!/^\d+$/u.test(c.nextBaseline))throw new ComposioFailure('invalid_contract')
   }
   c.loaded=true
  }
  const objects:GoogleObject[]=[]
  const readWindow=c.phase==='history'?{start:now-scope.pastDays*86400000,end:now}:{start:c.start,end:c.end}
  // At most eight metadata/body pairs, leaving requests for route verification and the page itself.
  for(let n=0;c.pending.length&&n<8&&budget.requests<18&&Date.now()<budget.deadline-15000;n++){
   const item=c.pending[0]!
   if(item.deleted)objects.push(empty('mail',item.id,'provider_deleted'))
   else try{
    if(c.phase==='history'){
     const metadata=await read({kind:'gmail.message',messageId:item.id,format:'metadata'})
     const admitted=normalizeGmailMessage(metadata,scope.labels,readWindow)
     if(admitted.status!=='current'){objects.push(admitted);c.pending.shift();continue}
    }
    const full=await read({kind:'gmail.message',messageId:item.id,format:'full'})
    if(full.messageId!==item.id)throw new ComposioFailure('object_mismatch')
    const normalized=normalizeGmailMessage(full,scope.labels,readWindow);normalized.locator='https://mail.google.com/mail/?authuser='+encodeURIComponent(verified.identity)+'#inbox/'+encodeURIComponent(item.id);objects.push(normalized)
   }catch(error){if(error instanceof ComposioFailure&&error.code==='not_found')objects.push(empty('mail',item.id,'provider_deleted'));else throw error}
   c.pending.shift()
  }
  let complete=false
  if(!c.pending.length){
   this.#advance(c,c.nextToken);c.loaded=false
   if(!c.token){if(c.phase==='snapshot'){c.phase='history';c.seenTokens=[]}else complete=true}
  }
  return {objects,continuation:complete?null:c,checkpoint:complete?{historyId:c.nextBaseline??c.baseline}:null,complete,snapshot:checkpoint===null}
 }
 #advance(cursor:GoogleCursor,next:string|null):void{
  if(next&&(cursor.seenTokens.includes(next)||cursor.seenTokens.length>=200))throw new ComposioFailure('pagination_loop')
  if(next)cursor.seenTokens.push(next)
  cursor.token=next
 }
}
