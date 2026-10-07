import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'

test('settings IM bridge only forwards closed Feishu commands from the settings window', async()=>{
 const source=await readFile(new URL('../src/main/main.mjs',import.meta.url),'utf8')
 const block=source.slice(source.indexOf("  ipcMain.handle('nova:settings:feishu'"),source.indexOf("  ipcMain.handle('nova:settings:personal'"))
 const sender={},calls=[];let receive
 new Function('ipcMain','settingsWindow','backendControl','settingsGeneration','backendStatus',block)(
  {handle:(_,fn)=>{receive=fn}},{webContents:sender},{request:async(method,params)=>{calls.push({method,params});return {state:'disconnected'}}},1,{state:'connected'})
 await assert.rejects(receive({sender:{}},{method:'feishu.status',params:{}}),/rejected/)
 await assert.rejects(receive({sender},{method:'memory.evidence',params:{evidence_id:'private'}}),/rejected/)
 await assert.rejects(receive({sender},{method:'state',params:{}}),/rejected/)
 await assert.rejects(receive({sender},{method:'feishu.status',params:{},extra:true}),/rejected/)
 assert.deepEqual(await receive({sender},{method:'feishu.status',params:{}}),{state:'disconnected'})
 for(const consent of [false,true])await receive({sender},{method:'feishu.consent',params:{consent}})
 assert.deepEqual(calls,[{method:'feishu.status',params:{}},{method:'feishu.consent',params:{consent:false}},{method:'feishu.consent',params:{consent:true}}])
})

test('settings connections bridge only forwards sources, connectors and discovery methods from the settings window', async()=>{
 const source=await readFile(new URL('../src/main/main.mjs',import.meta.url),'utf8')
 const block=source.slice(source.indexOf("  ipcMain.handle('nova:settings:personal'"),source.indexOf("  ipcMain.handle('nova:knowledge:action'"))
 const sender={},calls=[];let receive
 const control={request:async(method,params)=>{calls.push({method,params});return {sources:[]}}}
 new Function('ipcMain','settingsWindow','backendControl','settingsGeneration',block)({handle:(_,fn)=>{receive=fn}},{webContents:sender},control,1)
 await assert.rejects(receive({sender:{}},{method:'state',params:{}}),/rejected/)
 for(const method of ['memory.list','memory.evidence','feed.action','conversations.select','life.mutate','news.refresh','understanding.action','feishu.status'])await assert.rejects(receive({sender},{method,params:{}}),/rejected/)
 await assert.rejects(receive({sender},{method:'state',params:{},extra:true}),/rejected/)
 await assert.rejects(receive({sender},{method:'state',params:null}),/rejected/)
 await assert.rejects(receive({sender},{method:'sources.add',params:{path:'x'.repeat(17000),consent:true}}),/rejected/)
 assert.deepEqual(await receive({sender},{method:'state',params:{}}),{sources:[]})
 await receive({sender},{method:'discovery.configure',params:{enabled:false}})
 for(const method of ['sources.priority.add','sources.priority.remove'])await receive({sender},{method,params:{path:'/Users/me/Documents'}})
 assert.deepEqual(calls,[{method:'state',params:{}},{method:'discovery.configure',params:{enabled:false}},
  {method:'sources.priority.add',params:{path:'/Users/me/Documents'}},{method:'sources.priority.remove',params:{path:'/Users/me/Documents'}}])
 new Function('ipcMain','settingsWindow','backendControl','settingsGeneration',block)({handle:(_,fn)=>{receive=fn}},{webContents:sender},null,1)
 await assert.rejects(receive({sender},{method:'state',params:{}}),/unavailable/)
})

test('directory and connector authorization IPC accept both windows and reject others', async()=>{
 const source=await readFile(new URL('../src/main/main.mjs',import.meta.url),'utf8')
 const mainWindow={webContents:{}},settingsWindow={webContents:{}},opened=[],dialogs=[]
 const connector=source.slice(source.indexOf("  ipcMain.handle('nova:personal:connector-authorization'"),source.indexOf("  ipcMain.handle('nova:personal:article'"))
 let handler;new Function('ipcMain','mainWindow','settingsWindow','shell','connectorAuthorizationUrl',connector)({handle:(_,fn)=>{handler=fn}},mainWindow,settingsWindow,{openExternal:async url=>opened.push(url)},url=>url)
 await assert.rejects(handler({sender:{}},'https://x'),/rejected/)
 await handler({sender:mainWindow.webContents},'https://a');await handler({sender:settingsWindow.webContents},'https://b');assert.deepEqual(opened,['https://a','https://b'])
 const directory=source.slice(source.indexOf("  ipcMain.handle('nova:personal:directory'"),source.indexOf("  mainWindow.on('close'"))
 new Function('ipcMain','mainWindow','settingsWindow','dialog',directory)({handle:(_,fn)=>{handler=fn}},mainWindow,settingsWindow,{showOpenDialog:async(owner)=>{dialogs.push(owner);return {canceled:false,filePaths:['/p']}}})
 await assert.rejects(handler({sender:{}}),/rejected/)
 assert.equal(await handler({sender:mainWindow.webContents}),'/p');assert.equal(await handler({sender:settingsWindow.webContents}),'/p')
 assert.deepEqual(dialogs,[mainWindow,settingsWindow],'the dialog is parented to the requesting window')
})
