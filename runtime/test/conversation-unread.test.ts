import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createConversation,markConversationRead,conversationUnreadCount,conversationSchema} from '../src/personal-agent/conversations.js'
test('proactive read receipt does not consume later messages or revive trimmed history',()=>{
 const c=createConversation('proactive','主动提醒')
 const message=(id:string)=>({id,conversation_id:c.id,role:'assistant' as const,text:id,created_at:new Date().toISOString()})
 c.messages.push(message('one'),message('two'))
 markConversationRead(c,'one');assert.equal(conversationUnreadCount(c),1)
 c.messages.push(message('three'));markConversationRead(c,'one');assert.equal(conversationUnreadCount(c),2)
 markConversationRead(c,'two');c.messages.shift();assert.equal(conversationUnreadCount(conversationSchema.parse(c)),1)
 assert.throws(()=>markConversationRead(c,'absent'),/message_not_found/)
})
