import test from 'node:test'
import assert from 'node:assert/strict'
import {normalizeMacCalendarEvent,MacCalendarClient} from '../src/connectors/macos/calendar.js'
test('native calendar occurrence identity and all-day timezone survive normalization',()=>{
 const event={calendarId:'cal',id:'series',occurrence:'2026-09-19T16:00:00.000Z',title:'Holiday',notes:'',location:'',start:'2026-09-19T16:00:00.000Z',end:'2026-09-20T16:00:00.000Z',allDay:true,timeZone:'Asia/Shanghai',cancelled:false}
 const a=normalizeMacCalendarEvent(event),b=normalizeMacCalendarEvent({...event,occurrence:'2026-09-20T16:00:00.000Z'})
 assert.notEqual(a.key,b.key);assert.equal(a.metadata.time_zone,'Asia/Shanghai');assert.equal(a.retentionUntil,'2026-10-20T16:00:00.000Z');assert.equal(normalizeMacCalendarEvent({...event,cancelled:true}).status,'provider_deleted')
 assert.throws(()=>new MacCalendarClient('/missing-fixture').request({command:'delete'}))
})
