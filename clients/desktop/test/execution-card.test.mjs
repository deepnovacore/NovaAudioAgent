import test from 'node:test'
import assert from 'node:assert/strict'
import {executionChoices,mountExecutionCard,proposalText} from '../src/renderer/execution-card.mjs'
class Node {
 constructor(tag,text){this.tagName=tag.toUpperCase();this.children=[];this.listeners={};this.textContent=text??'';this.value=''}
 append(...nodes){this.children.push(...nodes)} replaceChildren(...nodes){this.children=nodes;if(this.tagName==='SELECT')this.value=nodes[0]?.value??''} setAttribute(k,v){this[k]=v} addEventListener(k,f){this.listeners[k]=f}
}
const el=(tag,text,className)=>{const node=new Node(tag,text);if(className)node.className=className;return node}
const targets=[
 {workspace_id:'w1',session_id:null,project:'counter',title:'counter',executor:'codex'},
 {workspace_id:'w1',session_id:'s-old',project:'counter',title:'Old fix',executor:'codex',last_active:1},
 {workspace_id:'w1',session_id:'s-new',project:'counter',title:'Add tests',executor:'codex',last_active:9},
 {workspace_id:'w2',session_id:null,project:'site',title:'site',executor:'codex',running:'Redesign header'},
 {workspace_id:'w2',session_id:'s-site',project:'site',title:'Header',executor:'codex',last_active:5,running:'Redesign header'},
]
const proposal={proposal_id:'p1',conversation_id:'chat',action:'resume_session',workspace:'counter',session:'Add tests',busy:false}
function mount(reply=async()=>({accepted:true})){
 const root=el('div'),calls=[],sent=[],owners=[]
 const card=mountExecutionCard(root,{el,command:async(method,params)=>{calls.push([method,params]);return method==='conversations.targets'?{targets}:reply(method,params)},submitText:(text,id)=>{sent.push(text);owners.push(id)},run:action=>action()})
 const all=()=>[root].flatMap(function walk(n){return [n,...n.children.flatMap(walk)]})
 return {card,calls,sent,owners,find:label=>all().find(n=>n['aria-label']===label||n.textContent===label)}
}
const settle=()=>new Promise(resolve=>setImmediate(resolve))

test('choices lead with the proposal, order sessions by recency, and disable places another work holds',()=>{
 const choices=executionChoices(proposal,targets)
 assert.deepEqual(choices.map(entry=>[entry.project,entry.disabled]),[['counter',false],['site',true]])
 assert.deepEqual(choices[0].sessions.map(session=>session.title),['Add tests','Old fix'])
 assert.equal(choices[1].sessions[0].disabled,true)
 const own=executionChoices({...proposal,workspace:'site',session:'Header'},targets)
 assert.equal(own.find(entry=>entry.project==='site').disabled,false,'the proposal itself stays selectable when it is queued behind a busy lock')
 assert.equal(own.find(entry=>entry.project==='site').sessions[0].disabled,false)
 assert.equal(proposalText({action:'create_workspace',workspace:'new-app',session:null}),'新建工作区「new-app」')
 assert.equal(proposalText(proposal),'工作区「counter」· 延续会话「Add tests」')
})

test('confirming the proposal as shown confirms it; a changed place cancels it and asks Nova by display name',async()=>{
 const m=mount();m.card.update(proposal,'chat');await settle();m.card.update(proposal,'chat')
 const workspace=m.find('工作区'),session=m.find('会话')
 assert.equal(workspace.value,'counter');assert.equal(session.value,'Add tests')
 await m.find('按此执行').listeners.click()
 assert.deepEqual(m.calls.at(-1),['conversations.confirm',{id:'chat',proposal_id:'p1',confirmed:true}]);assert.deepEqual(m.sent,[])
 session.value='';session.listeners.change()
 const change=m.find('改为此位置执行');assert.ok(change,'the action names the change');await change.listeners.click()
 assert.deepEqual(m.calls.at(-1),['conversations.confirm',{id:'chat',proposal_id:'p1',confirmed:false}])
 assert.deepEqual(m.sent,['改为在工作区「counter」新开会话执行。'])
})

test('a proposal already decided elsewhere says so and sends no change',async()=>{
 const m=mount(async()=>{throw Error('confirmation_not_owned')});m.card.update(proposal,'chat');await settle()
 m.find('会话').value='Old fix';m.find('会话').listeners.change();await m.find('改为此位置执行').listeners.click()
 assert.ok(m.find('这个提议已在另一端处理'));assert.deepEqual(m.sent,[])
 m.card.update(null,'chat');assert.equal(m.find('执行位置').hidden,true)
})

test('a changed place goes to the conversation that owned the proposal, even after switching away',async()=>{
 let release;const m=mount(()=>new Promise(resolve=>{release=resolve}));m.card.update(proposal,'chat');await settle()
 m.find('会话').value='';m.find('会话').listeners.change()
 const clicked=m.find('改为此位置执行').listeners.click();await settle()
 m.card.update({...proposal,proposal_id:'p2',conversation_id:'other'},'other');release({accepted:true});await clicked
 assert.deepEqual(m.owners,['chat'])
})
