const api=window.novaAudioAgentDesktop?.visor,status=document.getElementById('visor-settings-status')
const keys=['enabled','mode','opacity','motion','hardware','ai']
const inputs=Object.fromEntries(keys.map(key=>[key,document.getElementById(`visor-${key}`)]))
let busy=false
function render(preferences){for(const [key,input] of Object.entries(inputs)){if(input.type==='checkbox')input.checked=preferences[key];else input.value=preferences[key]}}
async function refresh(){if(busy||!api)return;try{render((await api.snapshot()).preferences)}catch{status.textContent='无法读取 Visor 设置'}}
for(const [key,input] of Object.entries(inputs))input.addEventListener('change',async()=>{
 if(busy||!api)return;busy=true;for(const i of Object.values(inputs))i.disabled=true
 try{render(await api.configure({[key]:input.type==='checkbox'?input.checked:key==='opacity'?Number(input.value):input.value}));status.textContent='已即时保存'}catch{status.textContent='保存失败，请重试'}finally{busy=false;for(const i of Object.values(inputs))i.disabled=false;await refresh()}
})
document.getElementById('category-themes')?.addEventListener('click',refresh)
window.addEventListener('focus',refresh);void refresh()
