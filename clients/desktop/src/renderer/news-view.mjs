import {confirmedInterests,renderInterests,renderWarmup} from './profile-preferences.mjs'
import {attachSources} from './source-popover.mjs'
const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n}
export function renderNews(panel,{news,warmup,command,button,local,preferencesLocal=local,rerender,profile,openArticle,delegate,connected=true,lead=[]}){
 panel.append(el('h2','Feeds · 为你发现'))
 renderWarmup(panel,{warmup,command,button})
 if(!news){const pending=el('p',connected?'正在准备资讯状态…':'资讯暂不可用。工作台连接后，可查看资讯设置和内容。');pending.setAttribute('role','status');panel.append(pending,...lead);return}
 const bar=el('div');bar.className='news-toolbar';panel.append(bar)
 const tabs=el('div');tabs.className='preference-segments';tabs.setAttribute('role','group');tabs.setAttribute('aria-label','资讯视图');bar.append(tabs)
 for(const [saved,label]of [[false,'为你推荐'],[true,'收藏']]){const b=button(label,()=>{local.saved=saved;rerender()},tabs);b.setAttribute('aria-pressed',String(Boolean(local.saved)===saved))}
 if(news.enabled){button(local.preferences?'收起兴趣':'调整兴趣',()=>{local.preferences=!local.preferences;rerender()},bar)
  const refresh=button(news.refreshing?'正在更新…':'刷新',()=>command('news.refresh'),bar,'news:refresh');refresh.disabled=news.refreshing
 }
 if(!news.enabled||local.preferences)renderInterests(panel,{news,warmup,command,button,local:preferencesLocal,rerender,delegate})
 if(news.enabled&&!local.preferences&&(!news.interests?.length||news.interests_seeded)){const note=el('p',news.interests?.length?`这几个兴趣是我从你的 Profile 里猜的：${news.interests.map(i=>i.text).join('、')}。先按时间给你看；点“就用这些”确认一下，我就按它们来排。`:'还不清楚你关心什么，先按时间给你看；等我整理好你的 Profile，就按你的兴趣来排。');note.className='hint';panel.append(note)
  if(news.interests?.length)button('就用这些',()=>command('news.configure',confirmedInterests(news)),note)}
 if(!news.enabled&&(news.items.length||news.saved.length)){const note=el('p','资讯更新已暂停，已获取的内容和收藏仍可阅读。');note.className='hint';panel.append(note)}
 if(news.refreshing){const loading=el('div');loading.className='warmup-status';loading.setAttribute('role','status');const spinner=el('span');spinner.className='warmup-spinner';spinner.setAttribute('aria-hidden','true');loading.append(spinner,el('p',news.items.length?'正在更新，已有内容仍可阅读。':'正在准备第一批资讯…'));panel.append(loading)}
 // Local-source summaries sit under the view switcher, ahead of the article list.
 panel.append(...lead)
 const items=local.saved?news.saved:news.items
 if(!items.length){const empty=el('section');empty.className='news-empty';panel.append(empty)
  empty.append(el('h3',local.saved?'还没有收藏的文章':!news.enabled?'资讯更新已关闭':news.refreshing?'正在获取资讯':'暂时没有新文章'))
  empty.append(el('p',local.saved?'看到想保留的文章时，可以点收藏。':!news.enabled?'开启后，这里会显示新文章。':news.refreshing?'获取完成后会显示在这里。':news.sources.some(s=>s.error)?'部分来源暂时无法连接；可以在下方查看来源状态。':'可以稍后刷新，或调整关注的主题。'))
 }
 const sources=el('details');sources.append(el('summary','来源与同步状态'));panel.append(sources)
 for(const source of news.sources){const row=el('div');row.append(el('p',`${source.name} · ${source.blocked?'已屏蔽':source.error?'获取失败：'+source.error:source.last_success?'最近成功：'+new Date(source.last_success).toLocaleString():'尚未获取'} · ${source.count??0} 条`));button(source.blocked?'恢复来源':'屏蔽来源',()=>command('news.action',{action:'block',source_id:source.id,value:!source.blocked}),row,`news-source:${source.id}`);sources.append(row)}
 if(news.rank_error)sources.append(el('p','推荐排序暂不可用，先展示已获取的资讯。'))
 if(!news.items.length&&!news.saved.length&&!news.sources.some(s=>s.error))sources.hidden=true
 for(const item of items){const card=el('article');card.className='personal-card news-card';card.dataset.articleId=item.id;panel.append(card)
  card.append(el('small',`${news.sources.find(s=>s.id===item.source_id)?.name??item.source_id} · ${item.published_at?new Date(item.published_at).toLocaleString():'来源未提供发布时间'}${item.read?' · 已读':''}${item.exploration?' · 探索':''}`),el('h3',item.title));const excerpt=el('p',item.summary);excerpt.className='news-excerpt';card.append(excerpt)
  if(item.ranking?.reason)card.append(el('p',`推荐理由：${item.ranking.reason}`))
  attachSources(card,(item.ranking?.matches??[]).map(m=>`${news.interests.find(i=>i.id===m.interest_id)?.text??''}：${m.quote}`),{title:'推荐依据'})
  const actions=el('div');actions.className='card-actions';card.append(actions)
  button('阅读原文',async()=>{await openArticle(item.url);await command('news.action',{action:'read',id:item.id,value:true})},actions)
  button(item.saved?'取消收藏':'收藏',()=>command('news.action',{action:'save',id:item.id,value:!item.saved}),actions,`news-save:${item.id}`)
  const conversionKey='convert:'+item.id,draft=local[conversionKey]
  if(!draft)button('转为个人事项',()=>{local[conversionKey]={id:item.id,content_hash:item.content_hash,kind:'idea',title:item.title.slice(0,200),note:''};rerender()},actions)
  else{
   const form=el('div');form.className='life-form';card.append(form)
   form.append(el('p','把这篇资讯作为参考，写下你自己的想法、目标或待办。保存不会授权 Nova 执行。'))
   const select=el('select');select.pendingKey=`news-convert:${item.id}`;select.setAttribute('aria-label','个人事项类型');for(const [value,label]of [['idea','想法'],['todo','待办'],['goal','目标']]){const option=el('option',label);option.value=value;select.append(option)}select.value=draft.kind;select.addEventListener('change',()=>{draft.kind=select.value});form.append(select)
   for(const [key,label,tag,limit]of [['title','个人事项标题','input',200],['note','我的补充说明','textarea',4000]]){const wrapper=el('label',label),input=el(tag);input.pendingKey=`news-convert:${item.id}`;input.value=draft[key];input.maxLength=limit;input.setAttribute('aria-label',label);input.addEventListener('input',()=>{draft[key]=input.value});wrapper.append(input);form.append(wrapper)}
   if(draft.content_hash!==item.content_hash)form.append(el('p','资讯已更新，请取消后重新打开转换。'))
   const save=button('保存个人事项',async()=>{await command('news.convert',{...draft});delete local[conversionKey];rerender()},form,`news-convert:${item.id}`);save.disabled=draft.content_hash!==item.content_hash
   button('取消转换',()=>{delete local[conversionKey];rerender()},form,`news-convert:${item.id}`)
  }
  for(const match of item.ranking?.matches??[]){const interest=news.interests.find(i=>i.id===match.interest_id);if(!interest)continue
   button(`多看「${interest.text}」`,()=>command('news.action',{action:'weight',interest_id:interest.id,value:Math.min(2,interest.weight+0.5)}),actions).className='quiet'
   button(`少看「${interest.text}」`,()=>command('news.action',{action:'weight',interest_id:interest.id,value:Math.max(0,interest.weight-0.5)}),actions).className='quiet'
  }
 }
}
