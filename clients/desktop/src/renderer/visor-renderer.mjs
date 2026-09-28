import {compactOrbLabel} from './state.mjs'
const $=id=>document.getElementById(id),root=$('visor'),svgNS='http://www.w3.org/2000/svg'
function path(group,d,kind=''){const node=document.createElementNS(svgNS,'path');node.setAttribute('d',d);if(kind)node.setAttribute('class',kind);group.append(node)}
function frame(){
 const w=innerWidth,h=innerHeight,x=Math.min(230,w*.18)
 for(const id of ['left','right','top','bottom'])$('frame-'+id).replaceChildren()
 const left=$('frame-left'),right=document.createElementNS(svgNS,'g');$('frame-right').append(right)
 const outline=`M ${x} 18 L 58 12 Q 34 14 22 46 L 9 ${h*.22} L 16 ${h*.72} Q 19 ${h-78} 60 ${h-52} L ${x} ${h-18}`
 path(left,outline);path(right,outline);right.setAttribute('transform',`translate(${w} 0) scale(-1 1)`)
 for(const g of [left,right]){
 path(g,`M ${x-18} 34 L 66 30 L 40 68 L 25 ${h*.23} L 31 ${h*.72} Q 33 ${h-90} 73 ${h-64} L ${x+10} ${h-35}`,'secondary')
 path(g,`M 36 48 L 29 70 M 15 ${h*.32} L 15 ${h*.32+24} M 37 ${h-76} L 54 ${h-61}`,'accent')
 for(let i=0;i<28;i++){let y=h*.25+i*h*.015;path(g,`M 19 ${y} h ${i%5===0?17:7}`,'tick')}
 }
 path($('frame-top'),`M ${x} 18 L ${w*.34} 37 L ${w*.37} 10 L ${w*.63} 10 L ${w*.66} 37 L ${w-x} 18`)
 path($('frame-top'),`M ${w*.37-8} 14 l -13 14 M ${w*.63+8} 14 l 13 14`,'accent')
 path($('frame-bottom'),`M ${x} ${h-18} L ${w*.34} ${h-53} H ${w*.41} M ${w*.59} ${h-53} H ${w*.66} L ${w-x} ${h-18}`)
 path($('frame-bottom'),`M ${x+18} ${h-10} L ${w*.34} ${h-43} M ${w*.66} ${h-43} L ${w-x-18} ${h-10}`,'secondary')
}
frame();addEventListener('resize',frame)
const history=[];let lastSample=0,lastEnabled=false,animationTimer,preferences={},ai={},raf=0,lastFrame=0,phase=0
const stateNames={idle:'待机',listening:'监听中',thinking:'思考中',speaking:'回答中',error:'连接异常',sleeping:'休眠',muted:'已闭麦',connecting:'连接中'}
const text=(id,value)=>$(id).textContent=value
const count=v=>Number.isFinite(v)?new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:1}).format(v):'—'
const percent=v=>Number.isFinite(v)?`${Math.round(v)}%`:'—'
function update(data){
 preferences={...data.preferences,motion:data.preferences.motion&&!matchMedia('(prefers-reduced-motion: reduce)').matches};ai=data.ai??{}
 root.style.setProperty('--strength',preferences.opacity)
 root.classList.toggle('focus',preferences.mode==='focus');root.classList.toggle('no-motion',!preferences.motion)
 root.classList.toggle('hardware-hidden',!preferences.hardware);root.classList.toggle('ai-hidden',!preferences.ai)
 root.classList.toggle('off',!preferences.enabled)
 if(preferences.enabled&&!lastEnabled&&preferences.motion){root.classList.remove('assembling');void root.offsetWidth;root.classList.add('assembling');clearTimeout(animationTimer);animationTimer=setTimeout(()=>root.classList.remove('assembling'),2200)}
 lastEnabled=preferences.enabled;text('mode-label',preferences.mode==='focus'?'FOCUS':'SHOWCASE')
 const h=data.hardware
 if(h){text('cpu',percent(h.cpu));text('ram',`${(h.memoryUsed/2**30).toFixed(1)} / ${(h.memoryTotal/2**30).toFixed(0)} GB`);text('disk',percent(h.disk));text('battery',h.battery?percent(h.battery.percent):'—');text('battery-detail',h.battery?(h.battery.charging?'接通电源':'使用电池'):'无电池或暂不可用');$('ram-bar').style.width=`${100*h.memoryUsed/h.memoryTotal}%`;$('disk-bar').style.width=`${h.disk??0}%`;text('hardware-status',Date.now()-h.updatedAt<6000?'LIVE · 2s':'DATA DELAYED');if(h.updatedAt!==lastSample){lastSample=h.updatedAt;if(Number.isFinite(h.cpu))history.push(h.cpu);if(history.length>40)history.shift();$('cpu-graph').setAttribute('d',history.map((v,i)=>`${i?'L':'M'} ${i*180/39} ${30-v*.28}`).join(' '))}}
 const usage=ai.usage,rows=usage?.rows??[]
 text('requests',count(usage?.requests));text('input',rows.some(r=>Number.isFinite(r.inputTokens))?count(rows.reduce((s,r)=>s+(r.inputTokens??0),0)):'—');text('output',rows.some(r=>Number.isFinite(r.outputTokens))?count(rows.reduce((s,r)=>s+(r.outputTokens??0),0)):'—')
 text('cost',usage?.pricedReports>0?`¥${usage.costCny.toFixed(3)}`:'—');text('cost-detail',usage?.unpricedReports||usage?.missingReports?'部分用量未计价 · 已知部分估算':'接口报告用量 · 费用估算')
 const status=ai.backend!=='connected'?'未连接':ai.muted?'已闭麦':stateNames[ai.state]??compactOrbLabel(ai.state)
 text('ai-state',status);text('core-state',status);text('microphone',`MIC · ${ai.muted?'MUTED':ai.activated?'ACTIVE':'OFF'}`);text('model',ai.model||'未选择');text('clock',new Date().toLocaleTimeString('en-GB',{hour12:false}))
 draw(performance.now());if(preferences.enabled&&preferences.motion&&!raf)raf=requestAnimationFrame(loop)
}
const canvas=$('core'),ctx=canvas.getContext('2d')
function draw(now){
 ctx.clearRect(0,0,180,180);const active=['listening','speaking','thinking'].includes(ai.state)&&ai.backend==='connected';const t=preferences.motion?phase:0
 ctx.strokeStyle='#86e6ff';ctx.lineWidth=.7;ctx.globalAlpha=.8
 for(let i=0;i<3;i++){ctx.beginPath();ctx.arc(90,90,53+i*9,t*(i%2?-.6:.4)+i,t*(i%2?-.6:.4)+i+Math.PI*1.6);ctx.stroke()}
 for(let i=0;i<100;i++){const a=i*2.39996+t*.12,r=43*Math.sqrt((i+.5)/100),pulse=active?1+.08*Math.sin(t*3):1;ctx.fillStyle=i%9===0?'#ffe0a3':'#91eeff';ctx.globalAlpha=.25+.65*(.5+.5*Math.sin(i+t));ctx.beginPath();ctx.arc(90+Math.cos(a)*r*pulse,90+Math.sin(a)*r*pulse,(i%5===0?1.4:.7),0,Math.PI*2);ctx.fill()}
 const glow=ctx.createRadialGradient(90,90,0,90,90,22);glow.addColorStop(0,'#dcfcff');glow.addColorStop(.13,'#82edff');glow.addColorStop(1,'#50dfff00');ctx.globalAlpha=1;ctx.fillStyle=glow;ctx.fillRect(65,65,50,50)
}
function loop(now){raf=0;if(!preferences.enabled||!preferences.motion||document.hidden)return;if(now-lastFrame>1000/(preferences.mode==='focus'?15:30)){phase+=Math.min(.1,(now-lastFrame)/1000);lastFrame=now;draw(now)}raf=requestAnimationFrame(loop)}
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&preferences.motion&&!raf)raf=requestAnimationFrame(loop)})
window.visor.onChanged(update);window.visor.snapshot().then(update).catch(()=>text('ai-state','状态不可用'))
