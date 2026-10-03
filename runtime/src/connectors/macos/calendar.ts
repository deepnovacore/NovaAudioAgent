import {MacNativeReader} from './reader.js'
import {createHash} from 'node:crypto'
import {z} from 'zod'
import {canonicalJson} from '../../text/canonical-json.js'
import {ComposioFailure,type GoogleScope} from '../composio/client.js'
import type {GoogleObject,GooglePage} from '../composio/google.js'
const requestSchema=z.discriminatedUnion('command',[
 z.object({command:z.enum(['status','request_access','list_calendars'])}).strict(),
 z.object({command:z.literal('snapshot'),calendars:z.array(z.string().min(1).max(1024)).min(1).max(20),start:z.iso.datetime(),end:z.iso.datetime()}).strict(),
])
const eventSchema=z.object({calendarId:z.string().min(1).max(1024),id:z.string().min(1).max(4096),occurrence:z.iso.datetime(),title:z.string().max(10000),notes:z.string().max(2*1024*1024),location:z.string().max(10000),start:z.iso.datetime(),end:z.iso.datetime(),allDay:z.boolean(),timeZone:z.string().max(100),cancelled:z.boolean()}).strict()
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
export function normalizeMacCalendarEvent(value:unknown):GoogleObject {
 const e=eventSchema.parse(value),key=hash(canonicalJson([e.calendarId,e.id,e.occurrence])),text=[e.title,e.notes,e.location,e.start,e.end,e.allDay?'全天':'',e.timeZone].join('\n')
 return {key,semanticHash:hash(canonicalJson(e)),metadata:{calendar_id:e.calendarId,remote_id:e.id,occurrence:e.occurrence,all_day:e.allDay,time_zone:e.timeZone,start:e.start,end:e.end,truncated:text.length>99000},text:text.length>99000?text.slice(0,99000)+'\n[正文已截断]':text,locator:'ical://',observedAt:e.start,retentionUntil:new Date(Date.parse(e.end)+30*86400000).toISOString(),kind:'calendar',status:e.cancelled?'provider_deleted':'current'}
}
/** Only a desktop-owned resources root is accepted; requests cannot choose an executable. */
export class MacCalendarClient {
 constructor(readonly resourcesRoot:string){}
 request(input:unknown,signal=AbortSignal.timeout(30000)){return new MacNativeReader(this.resourcesRoot,'macos_calendar').request(requestSchema.parse(input),signal)}
 async page(scope:GoogleScope,signal:AbortSignal):Promise<GooglePage>{
  if(scope.kind!=='calendar')throw new ComposioFailure('scope_denied')
  const now=Date.now(),result=await this.request({command:'snapshot',calendars:scope.calendars,start:new Date(now-scope.pastDays*86400000).toISOString(),end:new Date(now+scope.futureDays*86400000).toISOString()},signal)
  if(result.complete!==true||result.status!=='granted')throw new ComposioFailure('snapshot_incomplete')
  const events=z.array(eventSchema).max(200).parse(result.events)
  if(events.some(e=>!scope.calendars.includes(e.calendarId)||Date.parse(e.end)<=now-scope.pastDays*86400000||Date.parse(e.start)>=now+scope.futureDays*86400000))throw new ComposioFailure('scope_denied')
  return {objects:events.map(normalizeMacCalendarEvent),continuation:null,checkpoint:null,complete:true,snapshot:true}
 }
}
