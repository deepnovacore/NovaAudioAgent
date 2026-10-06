import assert from 'node:assert/strict'
import {test} from 'node:test'
import {access,mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Worker} from 'node:worker_threads'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'

test('close waits for a slow locked worker and leaves the ledger reopenable', {timeout:15000}, async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'nova-ledger-close-')),path=join(root,'memory.sqlite')
 const storeUrl=new URL('../src/memory-ledger/store.js',import.meta.url).href
 const client=new MemoryLedgerClient(path,{workerFactory:(url,options)=>new Worker(`
  (async()=>{
   const {MemoryLedgerStore}=await import(${JSON.stringify(storeUrl)});
   const close=MemoryLedgerStore.prototype.close;
   MemoryLedgerStore.prototype.close=function(){
    const deadline=Date.now()+600;
    while(Date.now()<deadline){}
    return close.call(this);
   };
   await import(${JSON.stringify(url.href)});
  })()
 `,{...options,eval:true,execArgv:[]})})
 let next:MemoryLedgerClient|undefined
 try{
  await client.open();await client.close()
  await assert.rejects(access(path+'.memory/.nova-memory.lock'),{code:'ENOENT'})
  next=new MemoryLedgerClient(path,{memoryLockWaitMs:100});await next.open()
 }finally{await client.close();await next?.close();await rm(root,{recursive:true,force:true})}
})

for(const failure of ['error','exit'] as const)test(`close settles when its worker reports ${failure}`,{timeout:5000},async()=>{
 const client=new MemoryLedgerClient(':memory:',{workerFactory:()=>new Worker(`
  const {parentPort}=require('node:worker_threads');
  parentPort.on('message',request=>{
   if(request.operation==='close')${failure==='error'?"throw Error('fixture worker failure')":"process.exit(1)"};
   else parentPort.postMessage({kind:'response',request_id:request.request_id,ok:true,result:null});
  });
 `,{eval:true,execArgv:[]})})
 try{await client.open();await client.close();await client.close()}
 finally{await client.close()}
})
