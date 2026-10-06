import {t} from './locale.mjs'
import {OrbDragGesture} from './drag-gesture.mjs'

const CONTROLS=[
 {action:'close',label:'关闭窗口',title:'关闭（转入后台）',className:'window-close'},
 {action:'minimize',label:'最小化',title:'最小化',className:'window-minimize'},
]

/**
 * Close and minimize controls for the frameless workbench (maximize is the topbar double-click), plus a drag strip that also maximizes on double-click.
 * `dblclick` never fires on a native `-webkit-app-region: drag` element, so the blank part of the topbar is a
 * no-drag strip that drives the move itself through the main process's cursor poll.
 */
export function mountWindowChrome(root,{api,el}){
 const controls=el('div',undefined,'window-controls');controls.setAttribute('role','group');controls.setAttribute('aria-label',t('窗口控制'))
 for(const spec of CONTROLS){
  const node=el('button',undefined,`window-control ${spec.className}`);node.type='button'
  node.setAttribute('aria-label',t(spec.label));node.title=t(spec.title)
  node.addEventListener('click',()=>api.windowControls?.[spec.action]?.())
  controls.append(node)
 }
 root.append(controls)

 const grip=el('div',undefined,'window-grip');grip.setAttribute('aria-hidden','true')
 const gesture=new OrbDragGesture()
 const drag=api.windowDrag
 grip.addEventListener('pointerdown',event=>{
  if(event.button!==0)return
  gesture.start(event.clientX,event.clientY)
  grip.setPointerCapture?.(event.pointerId)
  drag?.start()
 })
 grip.addEventListener('pointermove',event=>{
  const delta=gesture.move(event.clientX,event.clientY)
  if(delta)drag?.move(delta.dx,delta.dy)
 })
 const finish=cancelled=>{
  const result=cancelled?gesture.cancel():gesture.finish()
  if(result.active)drag?.end()
 }
 grip.addEventListener('pointerup',()=>finish(false))
 grip.addEventListener('pointercancel',()=>finish(true))
 grip.addEventListener('dblclick',()=>api.windowControls?.toggleMaximize?.())
 return {controls,grip}
}
