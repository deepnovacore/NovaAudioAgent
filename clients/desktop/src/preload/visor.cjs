const {contextBridge,ipcRenderer} = require('electron')
contextBridge.exposeInMainWorld('visor',Object.freeze({
  snapshot:()=>ipcRenderer.invoke('nova:visor:get'),
  configure:patch=>ipcRenderer.invoke('nova:visor:configure',patch),
  orb:()=>ipcRenderer.invoke('nova:visor:orb'),
  onChanged:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('nova:visor:changed',listener);return ()=>ipcRenderer.removeListener('nova:visor:changed',listener)},
}))
