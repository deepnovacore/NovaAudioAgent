// The workbench's left icon rail. Item order and keyboard mapping are plain
// data so tests and the live scripts can address pages by their visible label.
export const RAIL_ITEMS=Object.freeze([
 Object.freeze({id:'todos',label:'Todos',title:'待办',icon:'M9 11l3 3 8-8M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9'}),
 Object.freeze({id:'ideas',label:'Ideas',title:'想法',icon:'M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.6.6 1 1.3 1 2.5h6c0-1.2.4-1.9 1-2.5A6 6 0 0 0 12 3z'}),
 Object.freeze({id:'goals',label:'Goals',title:'目标',icon:'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'}),
 Object.freeze({id:'feeds',label:'Feeds',title:'资讯',icon:'M4 4h16v16H4zM8 8h8M8 12h8M8 16h5'}),
 Object.freeze({id:'tasks',label:'任务',title:'Agent 执行',icon:'M13 2L4 14h7l-1 8 9-12h-7z'}),
 Object.freeze({id:'profile',label:'Profile',title:'关于我',icon:'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0'}),
])
export const RAIL_IDS=RAIL_ITEMS.map(item=>item.id)
export function railItemForKey(active,key){
 if(key==='Home')return RAIL_IDS[0];if(key==='End')return RAIL_IDS.at(-1)
 const current=RAIL_IDS.indexOf(active);if(current===-1)return null
 if(key==='ArrowUp')return RAIL_IDS[(current+RAIL_IDS.length-1)%RAIL_IDS.length]
 if(key==='ArrowDown')return RAIL_IDS[(current+1)%RAIL_IDS.length]
 return null
}
const SVG='http://www.w3.org/2000/svg'
function icon(document,path){const svg=document.createElementNS(SVG,'svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');const p=document.createElementNS(SVG,'path');p.setAttribute('d',path);svg.append(p);return svg}
/** Mounts the rail; `onSelect(id)` fires for page items, `footer` entries are plain buttons. */
export function mountRail(root,{document=globalThis.document,onSelect,footer=[]}){
 const nav=document.createElement('nav');nav.className='rail';nav.setAttribute('aria-label','工作区')
 const list=document.createElement('div');list.className='rail-pages';list.setAttribute('role','tablist');list.setAttribute('aria-orientation','vertical');nav.append(list)
 const buttons=new Map(),badges=new Map();let active=null
 const make=(item,parent)=>{
  const b=document.createElement('button');b.type='button';b.className='rail-item';b.title=`${item.label} · ${item.title}`;b.setAttribute('aria-label',b.title)
  b.append(icon(document,item.icon));const label=document.createElement('span');label.className='rail-label';label.textContent=item.label;b.append(label)
  parent.append(b);return b
 }
 for(const item of RAIL_ITEMS){
  const b=make(item,list);b.setAttribute('role','tab');b.dataset.page=item.id;buttons.set(item.id,b)
  const badge=document.createElement('span');badge.className='rail-badge';badge.hidden=true;b.append(badge);badges.set(item.id,badge)
  b.addEventListener('click',()=>onSelect(item.id))
  b.addEventListener('keydown',event=>{const next=railItemForKey(item.id,event.key);if(!next)return;event.preventDefault();onSelect(next);buttons.get(next)?.focus?.()})
 }
 const foot=document.createElement('div');foot.className='rail-footer';nav.append(foot)
 for(const item of footer){const b=make(item,foot);b.addEventListener('click',item.onClick)}
 root.append(nav)
 function select(id){active=id;for(const [key,b]of buttons){const current=key===id;b.setAttribute('aria-current',String(current));b.setAttribute('aria-selected',String(current));b.tabIndex=current?0:-1}}
 function badge(id,count){const node=badges.get(id);if(!node)return;node.hidden=!count;node.textContent=count?String(count):''}
 return {select,badge,get active(){return active},element:nav}
}
