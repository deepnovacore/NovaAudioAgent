import test from 'node:test'
import assert from 'node:assert/strict'
import {markVisibleRead} from '../src/renderer/chat-pane.mjs'
test('proactive read requires open pane, expanded focused visible final rendered message and is idempotent', async () => {
 const calls=[];const c={connected:true,collapsed:false,selectedId:'p',snapshot:{conversations:{items:[{id:'p',kind:'proactive',unread_count:2}],messages:[{id:'m',conversation_id:'p'}]}},command:(...args)=>{calls.push(args);return Promise.resolve()}}
 const document={visibilityState:'visible',hasFocus:()=>true};const history={scrollHeight:200,scrollTop:100,clientHeight:100};const readMessages=new Set()
 const read=(overrides={})=>markVisibleRead({c,document,history,readMessages,...overrides})
 read({chatOpen:false})
 c.collapsed=true;read();c.collapsed=false
 document.visibilityState='hidden';read();document.visibilityState='visible'
 history.scrollTop=0;read();history.scrollTop=100
 document.hasFocus=()=>false;read();document.hasFocus=()=>true
 assert.equal(calls.length,0)
 read();read()
 assert.equal(calls.length,1);assert.equal(calls[0][0],'conversations.read');assert.equal(calls[0][1].through_message_id,'m')
})
test('a failed read confirmation can be retried and non-proactive conversations never confirm', async () => {
 const calls=[];const c={connected:true,collapsed:false,selectedId:'p',snapshot:{conversations:{items:[{id:'p',kind:'proactive',unread_count:1},{id:'c',kind:'chat'}],messages:[{id:'m',conversation_id:'p'},{id:'n',conversation_id:'c'}]}},command:(...args)=>{calls.push(args);return Promise.reject(new Error('offline'))}}
 const document={visibilityState:'visible',hasFocus:()=>true};const history={scrollHeight:100,scrollTop:0,clientHeight:100};const readMessages=new Set()
 markVisibleRead({c,document,history,readMessages});await Promise.resolve();await Promise.resolve()
 assert.equal(readMessages.has('m'),false);markVisibleRead({c,document,history,readMessages});assert.equal(calls.length,2)
 c.selectedId='c';markVisibleRead({c,document,history,readMessages});assert.equal(calls.length,2)
})
