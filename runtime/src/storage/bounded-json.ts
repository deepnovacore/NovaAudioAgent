import {open,rename,unlink} from 'node:fs/promises'
import {constants} from 'node:fs'
import {dirname} from 'node:path'
import {randomUUID} from 'node:crypto'
import type {z} from 'zod'
import {preparePrivateDatabasePath} from './private-database.js'
/** Caller owns serialization and the PersonalAgentHost process lock. */
export class BoundedJsonStore<T>{
 constructor(readonly path:string,readonly schema:z.ZodType<T>,readonly limit=4*1024*1024){}
 async read(fallback:T):Promise<T>{preparePrivateDatabasePath(this.path);const file=await open(this.path,constants.O_RDONLY|constants.O_NOFOLLOW)
  try{if((await file.stat()).size>this.limit)throw Error('store_capacity');const text=await file.readFile('utf8');return text?this.schema.parse(JSON.parse(text)):fallback}finally{await file.close()}
 }
 async write(state:T){const text=JSON.stringify(this.schema.parse(state));if(Buffer.byteLength(text)>this.limit)throw Error('store_capacity')
  const tmp=this.path+'.'+randomUUID()+'.tmp';let renamed=false
  try{const file=await open(tmp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);try{await file.writeFile(text);await file.sync()}finally{await file.close()}
   await rename(tmp,this.path);renamed=true;
   // Node cannot fsync directories on Windows; the file was synced before rename.
   if(process.platform!=='win32'){const dir=await open(dirname(this.path),constants.O_RDONLY);try{await dir.sync()}finally{await dir.close()}}
  }finally{if(!renamed)await unlink(tmp).catch(()=>{/* optional cleanup/observer */})}
 }
}
