import {test} from 'node:test'
import assert from 'node:assert/strict'
import {renderFeedCard,feedActionLabel,sendPresented} from '../src/renderer/feed-card.mjs'
class Node{constructor(tag,text,cls){this.tag=tag;this.children=[];this.dataset={};this.className=cls??'';if(text!==undefined)this.textContent=text}append(...c){this.children.push(...c)}}
function harness(){
 const calls=[],opened=[],parent=new Node('div');let fail=false
 const el=(tag,text,cls)=>new Node(tag,text,cls),button=(label,action,p)=>{const b=new Node('button',label);b.action=action;p.append(b);return b}
 const chips=(p,values)=>{const row=new Node('div',undefined,'chips');for(const v of values.filter(Boolean))row.append(new Node('span',v));p.append(row)}
 const command=(m,p)=>{calls.push([m,p]);return fail?Promise.reject(new Error('x')):Promise.resolve()}
 return {parent,calls,opened,el,button,chips,command,openFeed:(id,label)=>opened.push([id,label]),presented:new Set(),setFail:v=>{fail=v}}
}
const item=(o={})=>({id:'f1',kind:'suggestion',title:'T',why_now:'W',lifecycle:'active',user_state:'new',task_ref:null,delivery:{presented_at:null},...o})
const buttons=card=>card.children.flatMap(function walk(n){return n.tag==='button'?[n.textContent]:n.children.flatMap(walk)})
test('actions follow kind and lifecycle',()=>{
 const h=harness()
 assert.deepEqual(buttons(renderFeedCard(h.parent,item(),h)),['讨论这个建议','稍后','忽略'])
 assert.deepEqual(buttons(renderFeedCard(h.parent,item({kind:'question',lifecycle:'resolved'}),h)),['回复这个问题'])
 assert.equal(feedActionLabel(item({kind:'task_result',task_ref:{work_id:'w'}})),'查看任务结果');assert.equal(feedActionLabel(item({task_ref:{work_id:'w'}})),'查看任务进展');assert.equal(feedActionLabel(item({kind:'change'})),'查看变化')
 const card=h.parent.children[0];assert.equal(card.dataset.feedId,'f1');assert.deepEqual(card.children[2].children.map(n=>n.textContent),['建议','待处理'])
})
test('dismissed cards keep content but expose no actions',()=>{
 const h=harness();const card=renderFeedCard(h.parent,item({user_state:'dismissed'}),h)
 assert.equal(card.dataset.dismissed,'true');assert.deepEqual(buttons(card),[]);assert.equal(card.children[0].textContent,'T')
})
test('presented receipt is sent once when visible and retried after failure',async()=>{
 const h=harness();h.setFail(true)
 renderFeedCard(h.parent,item(),{...h,visible:false});assert.equal(h.calls.length,0)
 renderFeedCard(h.parent,item(),h);await new Promise(r=>setImmediate(r));assert.equal(h.calls.length,1);assert.equal(h.presented.has('f1'),false,'failure allows retry')
 h.setFail(false);renderFeedCard(h.parent,item(),h);renderFeedCard(h.parent,item(),h);await new Promise(r=>setImmediate(r))
 assert.equal(h.calls.length,2);assert.ok(h.presented.has('f1'))
 renderFeedCard(h.parent,item({id:'f2',delivery:{presented_at:'2026-01-01T00:00:00Z'}}),h);assert.equal(h.calls.length,2,'already presented items send nothing')
})
test('primary action opens the feed conversation with its label; snooze and dismiss go through feed.action',async()=>{
 const h=harness();const card=renderFeedCard(h.parent,item(),h);const find=label=>card.children.flatMap(function walk(n){return n.tag==='button'&&n.textContent===label?[n]:n.children.flatMap(walk)})[0]
 await find('讨论这个建议').action();assert.deepEqual(h.opened,[['f1','讨论这个建议']])
 await find('忽略').action();assert.deepEqual(h.calls.at(-1),['feed.action',{id:'f1',action:'dismiss'}])
 await find('稍后').action();assert.equal(h.calls.at(-1)[1].action,'snooze');assert.ok(Date.parse(h.calls.at(-1)[1].snooze_until)>Date.now()+3500000)
})
test('prepared briefing text is kept as the card body and differs from why_now',()=>{
 const h=harness();const bodies=[];const card=renderFeedCard(h.parent,item({kind:'briefing',prepared:{text:'## 今日前瞻\n- 10:00 评审',trust:'untrusted_external',evidence_refs:[]},why_now:'每日简报'}),{...h,body:text=>{bodies.push(text);return new Node('div',text,'md')}})
 assert.deepEqual(bodies,['## 今日前瞻\n- 10:00 评审']);assert.equal(card.children[1].className,'md');assert.equal(card.children[2].textContent,'每日简报')
 const same=renderFeedCard(h.parent,item({prepared:{text:'W'}}),h);assert.equal(same.children[1].className,'feed-why','identical prepared text is not duplicated')
 const plain=renderFeedCard(h.parent,item({prepared:{text:'plain body'}}),{...h,body:undefined});assert.equal(plain.children[1].className,'feed-body')
})
test('sendPresented is independent of rendering and retries after failure',async()=>{
 const h=harness();const it=item()
 assert.equal(sendPresented(it,h),true);assert.equal(sendPresented(it,h),false);await new Promise(r=>setImmediate(r));assert.equal(h.calls.length,1)
 h.setFail(true);const other=item({id:'f9'});sendPresented(other,h);await new Promise(r=>setImmediate(r));assert.equal(h.presented.has('f9'),false)
 h.setFail(false);assert.equal(sendPresented(other,h),true)
 assert.equal(sendPresented(item({id:'done',delivery:{presented_at:'x'}}),h),false);assert.equal(sendPresented(it,{presented:undefined,command:h.command}),false)
})
