import {renderInterests,renderWarmup} from './profile-preferences.mjs'
import {attachSources} from './source-popover.mjs'
const el=(tag,text,className)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n}
const labels={todo:'待办',idea:'想法',goal:'目标'}
const statuses={todo:{open:'待办',doing:'进行中',waiting:'等待他人',done:'已完成',cancelled:'已取消'},idea:{active:'保留',archived:'已归档'},goal:{active:'推进中',paused:'已暂停',completed:'已达成',archived:'已归档'}}
export function renderLife(panel,{kind,state,command,button,local,rerender,delegate,openArticle,suggested=0,clampable,bindPending,run=action=>action()}){
 const rows=state?.[kind==='todo'?'todos':kind==='idea'?'ideas':'goals']??[]
 panel.append(el('h2',`${{todo:'Todos',idea:'Ideas',goal:'Goals'}[kind]} · ${labels[kind]}`))
 const toolbar=el('div',undefined,'page-toolbar'),toolbarActions=el('div',undefined,'page-toolbar-actions');panel.append(toolbar)
 toolbar.append(el('p',{todo:'你要做的、在等别人回的，都放这里。要帮忙就叫我。',idea:'想到什么先放这里，想动手了再转成待办或目标。',goal:'写下想去的方向和怎样算到了，再挂几件待办一步步走。'}[kind],'page-intro'),toolbarActions)
 const formKey=kind+':form';const draft=local[formKey]??={title:'',note:'',goal_id:'',due:'',success_criteria:''}
 const field=(parent,key,label,multiline=false)=>{const wrapper=el('label',label),input=el(multiline?'textarea':'input');input.pendingKey=`life:${draft.id??kind+':new'}`;input.value=draft[key]??'';input.maxLength=key==='title'?200:key==='success_criteria'?2000:4000;input.setAttribute('aria-label',label);if(key==='due')input.type='date';input.addEventListener('input',()=>{draft[key]=input.value});wrapper.append(input);parent.append(wrapper);return input}
 const openKey=kind+':formOpen',formOpen=Boolean(local[openKey])||Boolean(draft.id)
 button(local[kind+':all']?'隐藏已完成／归档':'显示已完成／归档',()=>{local[kind+':all']=!local[kind+':all'];rerender()},toolbarActions).className='ghost'
 button(formOpen&&!draft.id?'收起表单':`添加${labels[kind]}`,()=>{local[openKey]=!formOpen;if(!local[openKey])delete local[formKey];rerender()},toolbarActions).className='page-add'
 const form=el('div');form.className='life-form';form.hidden=!formOpen;panel.append(form)
 field(form,'title',`${labels[kind]}标题`);field(form,'note',kind==='goal'?'为什么重要':'补充说明',true)
 if(kind==='todo')field(form,'due','到期日期')
 if(kind==='goal')field(form,'success_criteria','怎样算达成',true)
 else{const wrapper=el('label','关联目标'),select=el('select');select.pendingKey=`life:${draft.id??kind+':new'}`;select.setAttribute('aria-label','关联目标');for(const g of [{id:'',title:'不关联'},...(state?.goals??[])]){const opt=el('option',g.title);opt.value=g.id;select.append(opt)}select.value=draft.goal_id??'';select.addEventListener('change',()=>{draft.goal_id=select.value});wrapper.append(select);form.append(wrapper)}
 button(draft.id?'保存修改':'保存',async()=>{const params={op:draft.id?'update':'create',kind,title:draft.title,note:draft.note};if(draft.id)Object.assign(params,{id:draft.id,expected_version:draft.version});if(kind==='todo')params.due=draft.due||null;if(kind==='goal')params.success_criteria=draft.success_criteria;else params.goal_id=draft.goal_id||null;await command('life.mutate',params);delete local[formKey];delete local[openKey];rerender()},form,`life:${draft.id??kind+':new'}`)
 if(draft.id)button('取消编辑',()=>{delete local[formKey];delete local[openKey];rerender()},form,`life:${draft.id}`)
 const visible=rows.filter(r=>local[kind+':all']||!['done','cancelled','archived','completed'].includes(r.status))
 const group=el('section',undefined,'card-group');group.setAttribute('aria-label',`我的${labels[kind]}`);group.append(el('h3',`我的${labels[kind]} · ${visible.length}`,'section-label'));panel.append(group)
 if(!visible.length&&state&&!rows.length&&suggested)group.append(el('p',{todo:'你自己记下的待办会放在这里；上面的建议不会自动加进来。',idea:'你自己记下的想法会放在这里；下面的建议不会自动加进来。',goal:'你自己定下的目标会放在这里；下面的方向不会自动加进来。'}[kind],'hint'))
 else if(!visible.length){const empty=el('section',undefined,'workbench-empty empty-state');const copy=!state?['正在读取已保存的内容','稍后会在这里显示你的记录。']:rows.length?{todo:['当前没有进行中的待办','已完成的记录可以从上方展开。'],idea:['当前没有保留的想法','已归档的想法可以从上方展开。'],goal:['当前没有推进中的目标','已归档的目标可以从上方展开。']}[kind]:{todo:['还没有待办','想起一件要做的事，可以随时记在这里。'],idea:['还没有保存想法','有个念头时，先用一句话记下来就好。'],goal:['还没有设定目标','可以先写下想推进的方向，以及怎样算达成。']}[kind];empty.append(el('h3',copy[0]),el('p',copy[1]));group.append(empty)}
 for(const row of visible){const card=el('article');card.className='personal-card life-card';card.dataset.lifeId=row.id;const note=el(clampable&&row.note?'button':'p',row.note,clampable&&row.note?'card-body':undefined);if(clampable&&row.note)clampable(note,`life:${kind}:${row.id}`,row.title);card.append(el('h3',row.title),note);group.append(card)
  const meta=el('div',undefined,'chips');card.append(meta)
  if(row.due)meta.append(el('span',`到期：${row.due}`))
  if(row.goal_id)meta.append(el('span',`目标：${state.goals.find(g=>g.id===row.goal_id)?.title??'不可用'}`))
  if(row.idea_id)meta.append(el('span',`来自想法：${state.ideas.find(i=>i.id===row.idea_id)?.title??'不可用'}`))
  const footer=el('div',undefined,'card-footer'),actions=el('div',undefined,'card-actions')
  if(row.news_source){card.append(el('p',`由你从公开资讯保存：${row.news_source.title}`),el('p',row.news_source.url));if(openArticle)button('查看资讯原文',()=>openArticle(row.news_source.url),actions).className='ghost'}
  if(kind==='goal'){card.append(el('p',`达成标准：${row.success_criteria||'尚未填写'}`),el('p',row.progress.total?`行动进度：${row.progress.done}/${row.progress.total}（不含已取消待办；目标是否达成由你确认）`:'尚未关联待办；不代表目标已达成'))}
  const select=el('select');select.setAttribute('aria-label',`${row.title}状态`);for(const [value,label]of Object.entries(statuses[kind])){const opt=el('option',label);opt.value=value;select.append(opt)}select.value=row.status;const saving=el('span','正在保存…','action-progress');saving.setAttribute('role','status');saving.hidden=true;const change=async()=>{const value=select.value;try{await command('life.mutate',{op:'update',kind,id:row.id,expected_version:row.version,status:value})}finally{select.value=row.status}};if(bindPending)bindPending(select,`life:${row.id}`,change,'change',saving);else select.addEventListener('change',()=>run(change));footer.append(select,saving,actions)
  if(kind==='idea'){const converted=[...(state?.todos??[]),...(state?.goals??[])].filter(r=>r.idea_id===row.id);for(const target of ['todo','goal']){const existing=converted.find(r=>r.kind===target);if(existing)card.append(el('p',`已转为${labels[target]}：${existing.title}`));else if(row.status!=='archived')button(`转为${labels[target]}`,()=>command('life.mutate',{op:'convert',id:row.id,target,expected_version:row.version}),actions,`life:${row.id}`).className='ghost'}}
  if(kind==='todo'&&!['done','cancelled'].includes(row.status))button('请 Nova 协助',()=>delegate(`请帮我处理待办「${row.title}」。${row.note}。先和我确认处理方式。`,{id:row.id,version:row.version}),actions,`assist:${row.id}`).className='soft'
  button('编辑',()=>{local[formKey]={...row};rerender()},actions,`life:${row.id}`).className='ghost'
  card.append(footer)
 }
}
export function renderProfile(panel,{state,news,warmup,command,button,local,preferencesLocal=local,rerender,delegate}){
 panel.append(el('h2','Profile · 关于我'))
 renderWarmup(panel,{warmup,command,button})
 const card=el('section');card.className='preference-card';panel.append(card)
 const confirmed=state?.profile?.about??'',suggested=state?.profile?.version>0?'':warmup?.draft?.about?.text??'',about=confirmed||suggested
 const work=state?.profile?.version>0?[]:warmup?.draft?.work??[]
 const sources=new Map((warmup?.sources??[]).map(source=>[source.id,source.label]))
 const sourceDetails=(host,refs)=>attachSources(host,refs?.map(ref=>sources.get(ref.entry_id)),{title:'查看来源'})
 card.append(el('h3','关于我'))
 if(local.profile){
  const draft=local.profile,input=el('textarea');input.value=draft.about;input.maxLength=5000;input.setAttribute('aria-label','关于我');input.addEventListener('input',()=>{draft.about=input.value});card.append(input);input.pendingKey='profile:save'
  const actions=el('div');actions.className='preference-actions';card.append(actions)
  button('保存介绍',async()=>{await command('life.mutate',{op:'profile',expected_version:draft.version,about:draft.about});delete local.profile;rerender()},actions,'profile:save').className='page-add'
  button('取消编辑',()=>{delete local.profile;rerender()},actions,'profile:save')
 }else{
  const caption=el('p',confirmed?'你写下的介绍':state?.profile?.version>0?'你已清空个人介绍，可以随时重新写一段。':suggested||work.length?'我照你最近的工作写的，随时可以改':'我还不太了解你。看完你的资料会先写一版，你也可以自己写一段。');caption.className='preference-caption';card.append(caption)
  if(about){const holder=el('div');holder.className='profile-about';const preview=el('p',about);preview.className='profile-preview';holder.append(preview);card.append(holder);if(state?.profile?.version===0&&warmup?.draft?.about)sourceDetails(holder,warmup.draft.about.refs)}
  if(work.length){const grid=el('div');grid.className='profile-work';card.append(grid);for(const item of work){const block=el('article');block.className='profile-work-item';block.append(el('h4',item.title),el('p',item.text));sourceDetails(block,item.refs);grid.append(block)}}
  const actions=el('div');actions.className='preference-actions';card.append(actions)
  button(about||work.length?'编辑概览':'自己写一段',()=>{local.profile={about:confirmed||[suggested,...work.map(item=>`${item.title}：${item.text}`)].filter(Boolean).join('\n\n'),version:state?.profile?.version??0};rerender()},actions)
  if(delegate)button('和 Nova 聊聊',()=>delegate('我想完善个人介绍，请根据已有资料和我一起调整。'),actions)
 }
 renderInterests(panel,{news,warmup,command,button,local:preferencesLocal,rerender,delegate})
}
