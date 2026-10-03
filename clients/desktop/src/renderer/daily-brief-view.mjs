import {t} from './locale.mjs'
/** Edits host-owned scheduling settings through the existing personal command. */
export function renderDailyBrief({settings={},connected,card,el,button,command}) {
 const a=card(t('每日简报'),t('在主动提醒中查看当天安排和进展。')),fields={}
 const field=(key,title,type,value)=>{
  const label=el('label',undefined,'im-field'),input=el('input');input.type=type;input.setAttribute('aria-label',title);input.disabled=!connected
  if(type==='checkbox'){input.checked=value;input.setAttribute('role','switch')}else input.value=value
  label.append(el('span',title),input);a.append(label);fields[key]=input;return input
 }
 field('briefing_outlook_enabled',t('早间简报'),'checkbox',settings.briefing_outlook_enabled??false)
 field('briefing_outlook_time',t('早间时间'),'time',settings.briefing_outlook_time??'08:30')
 field('briefing_review_enabled',t('晚间简报'),'checkbox',settings.briefing_review_enabled??false)
 field('briefing_review_time',t('晚间时间'),'time',settings.briefing_review_time??'18:30')
 const days=el('fieldset');days.append(el('legend',t('重复日期')));const weekdays=[]
 for(const [index,title]of [t('周一'),t('周二'),t('周三'),t('周四'),t('周五'),t('周六'),t('周日')].entries()){
  const label=el('label',undefined,'personal-consent'),input=el('input');input.type='checkbox';input.checked=(settings.briefing_weekdays??[1,2,3,4,5]).includes(index+1);input.disabled=!connected;input.setAttribute('aria-label',title);label.append(input,el('span',title));days.append(label);weekdays.push(input)
 }
 a.append(days)
 field('timezone',t('时区'),'text',settings.timezone??Intl.DateTimeFormat().resolvedOptions().timeZone)
 field('quiet_start',t('免打扰开始'),'time',settings.quiet_start??'22:00')
 field('quiet_end',t('免打扰结束'),'time',settings.quiet_end??'08:00')
 a.append(el('p',t('免打扰期间不发送提醒。'),'personal-hint'))
 const save=button(t('保存简报设置'),async()=>{
  const params=Object.fromEntries(Object.entries(fields).map(([key,input])=>[key,input.type==='checkbox'?input.checked:input.value]))
  params.briefing_weekdays=weekdays.flatMap((input,index)=>input.checked?[index+1]:[])
  if(!params.briefing_weekdays.length)throw new Error(t('请选择至少一天'))
  try{new Intl.DateTimeFormat('zh-CN',{timeZone:params.timezone}).format()}catch{throw new Error(t('请输入有效时区，例如 Asia/Shanghai'))}
  for(const key of ['briefing_outlook_time','briefing_review_time','quiet_start','quiet_end'])if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(params[key]))throw new Error(t('请输入有效时间'))
  await command('discovery.configure',params)
 },a);save.disabled=!connected
 return fields
}
