// A feed item rendered inside the proactive conversation. The host mirrors every
// feed_item as a `feed:<id>` assistant message; the card adds the item's actions
// on top of that message instead of a separate 动态 page.
export const FEED_KIND_LABEL={question:'待回应'}
export const FEED_LIFECYCLE_LABEL={active:'待处理',resolved:'已完成',invalidated:'已失效'}
export function feedActionLabel(item){return item.kind==='task_result'?'查看任务结果':item.task_ref?'查看任务进展':item.kind==='question'?'回复这个问题':item.kind==='change'?'查看变化':'讨论这个建议'}
export const isDismissed=item=>item.user_state==='dismissed'||item.user_state==='dismiss'
/** Sends the presented receipt once per item; a failure clears the marker so the next visibility check retries. */
export function sendPresented(item,{presented,command}){
 if(!presented||!item||item.delivery?.presented_at||presented.has(item.id))return false
 presented.add(item.id)
 try{void Promise.resolve(command('feed.action',{id:item.id,action:'presented'})).catch(()=>presented.delete(item.id))}catch{presented.delete(item.id)}
 return true
}
/**
 * Renders one feed card into `parent`. `presented` is a shared Set so the
 * `presented` receipt is sent once per item and can be retried when it fails.
 */
export function renderFeedCard(parent,item,{el,button,chips,command,openFeed,visible=true,presented,body}){
 const card=el('article',undefined,'feed-card');card.dataset.feedId=item.id
 const dismissed=isDismissed(item);if(dismissed)card.dataset.dismissed='true'
 card.append(el('h3',item.title))
 // Briefings carry their substance in prepared.text (mirrored into the message); why_now alone would drop it.
 const prepared=typeof item.prepared?.text==='string'&&item.prepared.text.trim()&&item.prepared.text!==item.why_now?item.prepared.text:null
 if(prepared&&body)card.append(body(prepared))
 else if(prepared)card.append(el('p',prepared,'feed-body'))
 if(item.why_now)card.append(el('p',item.why_now,'feed-why'))
 chips(card,[FEED_KIND_LABEL[item.kind]??'建议',FEED_LIFECYCLE_LABEL[item.lifecycle]??item.lifecycle,item.task_ref?'关联任务':null])
 if(visible)sendPresented(item,{presented,command})
 if(!dismissed){
  const actions=el('div',undefined,'feed-actions');card.append(actions)
  const label=feedActionLabel(item);button(label,()=>openFeed(item.id,label),actions)
  if(item.lifecycle==='active'){button('稍后',()=>command('feed.action',{id:item.id,action:'snooze',snooze_until:new Date(Date.now()+3600000).toISOString()}),actions);button('忽略',()=>command('feed.action',{id:item.id,action:'dismiss'}),actions)}
 }
 parent.append(card);return card
}
