import {personalSettingsSchema,type PersonalSettings} from './contracts.js'

export const DAILY_BRIEF_WINDOW_MS=2*60*60*1000
export interface DailyBriefSlot {
 readonly kind:'outlook'|'review'
 readonly local_date:string
 readonly timezone:string
 readonly scheduled_at:string
 readonly dedupe_key:string
}
export function dailyBriefSettings(input:PersonalSettings) {
 const settings=personalSettingsSchema.parse(input)
 return {
  timezone:settings.timezone??Intl.DateTimeFormat().resolvedOptions().timeZone,
  briefing_outlook_enabled:settings.briefing_outlook_enabled??false,
  briefing_review_enabled:settings.briefing_review_enabled??false,
  briefing_outlook_time:settings.briefing_outlook_time??'08:30',
  briefing_review_time:settings.briefing_review_time??'18:30',
  briefing_weekdays:settings.briefing_weekdays??[1,2,3,4,5],
  quiet_start:settings.quiet_start??'22:00',quiet_end:settings.quiet_end??'08:00',
 }
}
function formatter(timezone:string):Intl.DateTimeFormat {
 return new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})
}
function localParts(format:Intl.DateTimeFormat,date:Date):{date:string;time:string;weekday:number} {
 const parts=Object.fromEntries(format.formatToParts(date).map(part=>[part.type,part.value]))
 const day=`${parts.year}-${parts.month}-${parts.day}`
 return {date:day,time:`${parts.hour}:${parts.minute}`,weekday:new Date(`${day}T00:00:00Z`).getUTCDay()||7}
}
function quiet(time:string,start:string,end:string):boolean {return start===end?false:start<end?time>=start&&time<end:time>=start||time<end}
export function isQuietTime(input:PersonalSettings,now:Date):boolean {
 const settings=dailyBriefSettings(input)
 return quiet(localParts(formatter(settings.timezone),now).time,settings.quiet_start,settings.quiet_end)
}
/** Returns only recent real wall-clock slots; the host tracks bounded durable attempts for each key. */
export function dueDailyBriefs(input:PersonalSettings,now:Date,claimed:Iterable<string>):DailyBriefSlot[] {
 const settings=dailyBriefSettings(input),format=formatter(settings.timezone),current=localParts(format,now)
 if(quiet(current.time,settings.quiet_start,settings.quiet_end))return []
 const seen=new Set(claimed),due:DailyBriefSlot[]=[]
 for(const kind of ['outlook','review'] as const){
  if(!settings[`briefing_${kind}_enabled`])continue
  const time=settings[`briefing_${kind}_time`]
  if(quiet(time,settings.quiet_start,settings.quiet_end))continue
  // At most 121 minute probes. Real instants avoid invented spring-forward slots; the key folds repeated fall-back slots.
  for(let instant=Math.floor(now.getTime()/60000)*60000;instant>=now.getTime()-DAILY_BRIEF_WINDOW_MS;instant-=60000){
   const scheduled=localParts(format,new Date(instant))
   if(scheduled.date!==current.date||scheduled.time!==time||!settings.briefing_weekdays.includes(scheduled.weekday))continue
   const dedupe_key=`brief:${settings.timezone}:${scheduled.date}:${kind}`
   if(!seen.has(dedupe_key))due.push({kind,local_date:scheduled.date,timezone:settings.timezone,scheduled_at:new Date(instant).toISOString(),dedupe_key})
   break
  }
 }
 return due
}
