const api=window.visor
function render(value){for(const mode of ['focus','showcase'])document.getElementById(mode).setAttribute('aria-pressed',String(value.preferences.mode===mode))}
const run=fn=>async()=>{try{await fn()}catch{document.getElementById('status').textContent='操作失败'}}
for(const mode of ['focus','showcase'])document.getElementById(mode).onclick=run(()=>api.configure({mode}))
document.getElementById('hide').onclick=run(()=>api.configure({enabled:false}))
document.getElementById('orb').onclick=run(()=>api.orb())
api.onChanged(render);api.snapshot().then(render).catch(()=>{})
