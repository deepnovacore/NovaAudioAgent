import {onButton} from './button-action.mjs'
import {renderFeishu} from './feishu-view.mjs'

/** The settings window uses a narrow private IPC bridge, without a conversation session. */
export function createImPanel({document, api}) {
 const root=document.querySelector('#im-connection'),error=document.querySelector('#im-error')
 let state=null,busy=false,actionPending=false,setupTimer,openSetup=false,openedSetupUrl
 let actionNeedsRender=false,pendingLabel=null
 const local={chats:null,verification_url:null,onError:caught=>{error.textContent=caught.message||'连接暂时不可用'}}
 const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node}
 const button=(text,action,parent)=>{const node=el('button',text);node.type='button';node.disabled=busy||actionPending;if(actionPending&&pendingLabel===text)node.setAttribute('aria-busy','true');onButton(node,async()=>{actionPending=true;pendingLabel=text;try{return await action()}finally{actionPending=false;pendingLabel=null;if(actionNeedsRender){actionNeedsRender=false;render()}}},local.onError);parent.append(node);return node}
 function render(){
  if(actionPending)actionNeedsRender=true
  root.replaceChildren()
  const card=(title,description)=>{const node=el('article',undefined,'im-card');node.append(el('h3',title),el('p',description));root.append(node);return node}
  if(state===null){const loading=card('飞书','正在读取连接状态…');loading.setAttribute('aria-busy',String(busy));return}
  renderFeishu({state,local,card,el,button,command,refresh:render,api:{personal:{openFeishuVerification:api.openFeishuVerification}}})
  if(busy)for(const input of root.querySelectorAll('button,input'))input.disabled=true
 }
 async function command(method,params={},quiet=false){
  if(busy)throw new Error('请等待当前操作完成')
  clearTimeout(setupTimer)
  if(method==='feishu.app.start')openSetup=true
  if(method==='feishu.app.cancel')openSetup=false
  const previous=JSON.stringify(state)
  busy=true;actionNeedsRender=actionPending;if(!quiet){error.textContent='';for(const input of root.querySelectorAll('button,input'))input.disabled=true}
  try{
   const result=await api.feishuCommand(method,params)
   if(result?.error&&typeof result.available!=='boolean')throw new Error(result.error)
   state=method==='feishu.status'?result:await api.feishuCommand('feishu.status',{})
   const url=state?.app_setup?.verification_url
   if(openSetup&&url&&url!==openedSetupUrl){openedSetupUrl=url;await api.openFeishuVerification(url)}
   return result
  }finally{busy=false;if(!actionPending&&(!quiet||previous!==JSON.stringify(state)))render();if(state?.app_setup?.state==='waiting')setupTimer=setTimeout(()=>{void command('feishu.status',{},true).catch(local.onError)},1500)}
 }
 async function load(){if(busy||actionPending)return;try{await command('feishu.status')}catch(caught){root.replaceChildren(el('p','未能读取飞书连接状态，请重试。'));local.onError(caught)}}
 render()
 return {load}
}
