import {t} from './locale.mjs'
import {attachSources} from './source-popover.mjs'
const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node}
/** Renders the Todo recap and grounded suggestions; these cards never become Life objects automatically, and a goal suggestion is saved only when the user adopts it. */
export function renderSourceSuggestions(panel,{tab,context,sources=[],button,command,continueChat,delegate=continueChat,openSettings,connected=true,everConnected=true,startupFailed=false,clampable}){
 if(!['todos','ideas','goals'].includes(tab))return
 // The goal list above has its own empty state; a goal suggestion appears only when there is one.
 if(tab==='goals'&&!(context?.cards??[]).some(item=>item.tab==='goals'))return
 const projects=tab==='todos'?(context?.recap?.projects??[]).slice(0,4):[]
 if(tab==='todos'&&(context?.recap?.text||projects.length)){
  const recap=el('section',undefined,'workbench-recap');recap.setAttribute('aria-label','最近在忙');panel.append(recap)
  recap.append(el('h2','最近在忙'))
  if(context.recap.text)recap.append(el('p',context.recap.text))
  if(projects.length){const list=el('ul',undefined,'recap-projects');for(const project of projects){const row=el('li');row.append(el('strong',project.name),el('span',project.line));row.setAttribute('aria-label',`${project.name} · ${project.line}`);list.append(row)}recap.append(list)}
 }
 const heading=tab==='todos'?'可以接着做':tab==='goals'?'可以定下的方向':'我想到的'
 const section=el('section',undefined,'workbench-suggestions');section.setAttribute('aria-label',heading);panel.append(section)
 section.append(el('h2',heading))
 const cards=(context?.cards??[]).filter(item=>item.tab===tab).slice(0,3)
 for(const item of cards){const card=el('article',undefined,'card');card.append(el('h3',item.title));section.append(card)
  const body=el(clampable?'button':'p',tab==='todos'?item.why||item.body:item.body,clampable?'card-body':undefined)
  if(clampable)clampable(body,item.id,item.title)
  card.append(body)
  if(item.next)card.append(el('p',`${tab==='goals'?'先从':'下一步'}：${item.next}`,'workbench-next'))
  attachSources(card,item.refs?.map(ref=>ref.label??ref.entry_id))
  const actions=el('div',undefined,'card-actions');card.append(actions)
  if(tab==='goals')button('设为目标',()=>command('context.adopt',{id:item.id}),actions,`suggestion:${item.id}`)
  else if(tab==='todos'&&item.next)button('帮我做',()=>delegate(`请帮我推进「${item.title}」：${item.next}`),actions,`suggestion:${item.id}`)
  else button('聊聊这个',()=>continueChat(`${item.title}：${item.body}`),actions,`suggestion:${item.id}`)
  button('隐藏',()=>command('context.dismiss',{id:item.id}),actions,`suggestion:${item.id}`).className='quiet'
 }
 const failed=sources.filter(source=>source.state==='error'),sourceName=source=>source.scope==='computer'?'整机资料':source.path?.split(/[\\/]/u).filter(Boolean).pop()??'已连接目录'
 if(cards.length){if(failed.length){const note=el('p',`${failed.map(sourceName).join('、')}还没读完，先给你看读到的部分。`,'hint');section.append(note);if(openSettings)button('查看来源',()=>openSettings('connections'),section)}return}
 const empty=el('div',undefined,'workbench-empty');section.append(empty)
 const reason=context?.empty_reasons?.[tab]??context?.empty_reason
 let title='暂时没什么要提的',body='想查资料里的东西，直接问我就行。'
 // Before the first connection this is ordinary startup, not an outage.
 if(!sources.length&&!connected&&!everConnected&&!startupFailed){title=t('正在连接后台');body=t('连上之后，我就来看看你的资料。')}
 else if(!sources.length&&!connected){title='暂时连不上后台';body='连上之后，我再看看你的资料。'}
 else if(!sources.length){title='还没给我看过资料';body='连一个文件夹进来，我读过之后就能帮你理出要做的事。'}
 else if(sources.every(source=>source.state==='paused'||source.state==='disconnected')){title='资料来源已暂停';body='恢复之后我再接着读。'}
 else if(sources.some(source=>source.processing_consent_required)&&context?.candidate_count===0){title='这些资料我还不能用';body='去来源设置里看看处理授权，允许之后我再读。'}
 else if(failed.length){title=`${failed.map(sourceName).join('、')}有一部分没读到`;body='读到的部分照常能用，详情在来源设置里。'}
 else if(context?.status==='working'){title='我在看你的资料';body='稍等一下，已有的记录照常能用。'}
 else if(context?.status==='failed'){title='这次没整理完';body='我过一会儿再试，已有的记录照常能用。'}
 else if(tab==='todos'&&reason==='digests_pending'){title='还在看你最近的项目';body='看完就把你在忙什么、接下来可以做什么放在这里。'}
 else if(sources.some(source=>source.scan_pending&&source.state==='connected')){title='还在读你给我的资料';body='读完再来这里看看。'}
 else if(reason==='model_abstained'){title='暂时没什么要提的';body='资料我都看过了，没找到有把握的建议。'}
 else if(reason==='no_eligible_sources'){title='暂时没什么要提的';body='现有的资料里还没有适合放这里的事。'}
 empty.append(el('h3',title),el('p',body))
 if(!sources.length&&connected&&openSettings)button('连接资料',()=>openSettings('connections'),empty)
 else if(sources.some(source=>source.state==='error'||source.processing_consent_required)&&openSettings)button('查看来源',()=>openSettings('connections'),empty)
}
