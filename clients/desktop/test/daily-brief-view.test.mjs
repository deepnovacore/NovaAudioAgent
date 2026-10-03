import test from 'node:test'
import assert from 'node:assert/strict'
import {renderDailyBrief} from '../src/renderer/daily-brief-view.mjs'
function harness(settings,connected=true){const nodes=[],calls=[];let save
 const el=(tag,text)=>{const node={tag,text,children:[],append(...items){this.children.push(...items)},setAttribute(key,value){this[key]=value}};nodes.push(node);return node}
 const fields=renderDailyBrief({settings,connected,el,card:()=>el('article'),button:(title,action,parent)=>{save=action;const b=el('button',title);parent.append(b);return b},command:async(...args)=>calls.push(args)})
 return {fields,nodes,calls,save:()=>save()}
}
test('brief configuration starts disabled with weekdays, local timezone and quiet hours',async()=>{
 const h=harness({});assert.equal(h.fields.briefing_outlook_enabled.checked,false);assert.equal(h.fields.briefing_review_enabled.checked,false)
 assert.equal(h.fields.briefing_outlook_time.value,'08:30');assert.equal(h.fields.briefing_review_time.value,'18:30');assert.equal(h.fields.quiet_start.value,'22:00');assert.equal(h.fields.quiet_end.value,'08:00');assert.equal(h.calls.length,0)
 h.fields.briefing_outlook_enabled.checked=true;h.fields.timezone.value='Asia/Shanghai';await h.save()
 assert.equal(h.calls[0][0],'discovery.configure');assert.deepEqual(h.calls[0][1].briefing_weekdays,[1,2,3,4,5]);assert.equal(h.calls[0][1].briefing_outlook_enabled,true)
 assert.equal(h.calls[0][1].enabled,undefined)
})
test('existing settings are retained, invalid schedule cannot send, disconnected controls disabled',async()=>{
 const h=harness({timezone:'UTC',briefing_outlook_time:'09:15',briefing_weekdays:[6,7]});assert.equal(h.fields.briefing_outlook_time.value,'09:15');await h.save();assert.deepEqual(h.calls[0][1].briefing_weekdays,[6,7])
 h.fields.timezone.value='invalid/timezone';await assert.rejects(h.save(),/时区/);assert.equal(h.calls.length,1)
 const disconnected=harness({},false);assert.equal(disconnected.nodes.filter(n=>n.tag==='input'||n.tag==='button').every(n=>n.disabled),true)
})
