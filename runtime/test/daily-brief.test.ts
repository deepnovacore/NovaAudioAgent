import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {dueDailyBriefs,isQuietTime} from '../src/personal-agent/daily-brief.js'
import {initialState,PersonalStore} from '../src/personal-agent/store.js'

const settings={discovery_enabled:true,discovery_interval_minutes:30,timezone:'Asia/Shanghai',briefing_outlook_enabled:true}
test('briefing defaults are off; local dates, weekdays and stale wakeups are respected',()=>{
 assert.deepEqual(dueDailyBriefs({discovery_enabled:true,discovery_interval_minutes:30},new Date('2026-09-14T00:30:00Z'),[]),[])
 const due=dueDailyBriefs(settings,new Date('2026-09-14T00:30:00Z'),[])
 assert.equal(dueDailyBriefs({...settings,discovery_enabled:false},new Date('2026-09-14T00:30:00Z'),[]).length,1)
 assert.equal(due[0]?.local_date,'2026-09-14');assert.equal(due[0]?.kind,'outlook')
 assert.deepEqual(dueDailyBriefs(settings,new Date('2026-09-13T00:30:00Z'),[]),[])
 assert.deepEqual(dueDailyBriefs(settings,new Date('2026-09-14T02:31:00Z'),[]),[])
 assert.equal(dueDailyBriefs({...settings,timezone:'America/Los_Angeles'},new Date('2026-09-14T15:30:00Z'),[])[0]?.local_date,'2026-09-14')
 assert.equal(dueDailyBriefs({...settings,timezone:'Pacific/Kiritimati'},new Date('2026-09-13T18:30:00Z'),[])[0]?.local_date,'2026-09-14')
})
test('quiet hours span midnight and DST slots never duplicate or invent a missing time',()=>{
 assert.equal(isQuietTime(settings,new Date('2026-09-14T15:00:00Z')),true)
 assert.equal(isQuietTime(settings,new Date('2026-09-14T23:59:00Z')),true)
 assert.equal(isQuietTime(settings,new Date('2026-09-15T00:00:00Z')),false)
 const dst={...settings,timezone:'America/New_York',briefing_weekdays:[7],briefing_outlook_time:'02:30',quiet_start:'00:00',quiet_end:'00:00'}
 assert.deepEqual(dueDailyBriefs(dst,new Date('2026-03-08T07:30:00Z'),[]),[])
 const fall={...dst,briefing_outlook_time:'01:30'}
 const first=dueDailyBriefs(fall,new Date('2026-11-01T05:35:00Z'),[])
 assert.equal(first.length,1)
 assert.deepEqual(dueDailyBriefs(fall,new Date('2026-11-01T06:35:00Z'),first.map(slot=>slot.dedupe_key)),[])
})
test('durable briefing claim survives restart independently from proposal dedupe',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-brief-'))
 try {
 const path=join(dir,'state.json'),now=new Date('2026-09-14T00:30:00Z'),state=initialState()
 state.settings=settings
 const due=dueDailyBriefs(settings,now,state.dedupe);assert.equal(due.length,1)
 state.dedupe.push(due[0]!.dedupe_key,'proposal-independent')
 await new PersonalStore(path).write(state)
 const reopened=await new PersonalStore(path).read()
 assert.deepEqual(dueDailyBriefs(reopened.settings,now,reopened.dedupe),[])
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('brief writer keeps empty distinct from malformed or failed model attempts',async()=>{
 const {GatewayPersonalWriter}=await import('../src/model/personal-writer.js')
 const snapshot={user_scope:'local',local_date:'2026-09-14',weekday:'Monday',timezone:'Asia/Shanghai',memory:[],evidence_refs:['allowed'],recent_delivery:[]}
 const slot={kind:'outlook' as const,local_date:snapshot.local_date,timezone:snapshot.timezone,scheduled_at:'2026-09-14T00:30:00Z',dedupe_key:'brief:test'}
 for(const text of ['null','not JSON',JSON.stringify({text:'invented',evidence_refs:['unknown'],memory_refs:[]})]){
  const writer=new GatewayPersonalWriter({model:'m',gateway:{async *stream(){/* preparation never streams */},complete:()=>Promise.resolve({text})}})
  if(text==='null')assert.equal(await writer.prepareBrief(snapshot,slot,new AbortController().signal),null)
  else await assert.rejects(writer.prepareBrief(snapshot,slot,new AbortController().signal))
 }
 const writer=new GatewayPersonalWriter({model:'m',gateway:{async *stream(){/* preparation never streams */},complete:()=>Promise.reject(Error('offline'))}})
 await assert.rejects(writer.prepareBrief(snapshot,slot,new AbortController().signal),/offline/)
})


test('brief schema is included in provider-visible prompt for JSON-object gateways',async()=>{
 const {GatewayPersonalWriter}=await import('../src/model/personal-writer.js')
 const writer=new GatewayPersonalWriter({model:'m',gateway:{async *stream(){/* preparation never streams */},complete:request=>{
  assert.match(request.system,/用中文撰写简报/);assert.match(request.system,/以自然语言/);assert.match(request.system,/转换到 snapshot.timezone/);const body=JSON.parse(request.prompt) as {schema:unknown;snapshot:{memory:{evidence_refs?:string[]}[]}};assert.deepEqual(body.schema,request.jsonSchema);assert.ok(JSON.stringify(body.schema).includes('memory_refs'));assert.equal(body.snapshot.memory[0]?.evidence_refs,undefined);assert.ok(!request.prompt.includes('nested-not-approved'));assert.ok(!request.prompt.includes('chat:1'));return Promise.resolve({text:'null'})
 }}})
 await writer.prepareBrief({user_scope:'local',local_date:'2026-10-04',weekday:'Sunday',timezone:'Asia/Shanghai',memory:[{id:'m',version:1,content:'task',kind:'todo',origin:'stated',source_refs:[{type:'conversation',ref:'chat:1',observed_at:'2026-10-04T00:00:00Z'}],evidence_refs:['nested-not-approved'],observed_at:'2026-10-04T00:00:00Z',recorded_at:'2026-10-04T00:00:00Z',topic:'work',status:'active',corrected_to:null,confidence_note:null}],evidence_refs:['allowed'],recent_delivery:[]},{kind:'outlook',local_date:'2026-10-04',timezone:'Asia/Shanghai',scheduled_at:'2026-10-04T14:26:00Z',dedupe_key:'brief:test'},new AbortController().signal)
})
