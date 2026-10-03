import type {BigIntStats, Dirent} from 'node:fs'
import {lstat, opendir} from 'node:fs/promises'
import {setImmediate} from 'node:timers/promises'

export interface DirectoryIdentity {dev:string; ino:string; mtimeNs:string}
export interface DirectoryScan {identity:DirectoryIdentity; complete:boolean; seen:number; capped:boolean}
const identityOf=(stat:BigIntStats):DirectoryIdentity=>({dev:stat.dev.toString(),ino:stat.ino.toString(),mtimeNs:stat.mtimeNs.toString()})

/** A pass is restartable because admissions are keyed by path, never by entry position. */
export async function scanDirectory(path:string,signal:AbortSignal,onEntry:(entry:Dirent)=>void|Promise<void>,options:{hardSafetyCap?:number;chunkSize?:number}={}):Promise<DirectoryScan>{
 const before=await lstat(path,{bigint:true})
 if(!before.isDirectory()||before.isSymbolicLink())throw Error('directory_unavailable')
 const cap=options.hardSafetyCap??20_000,chunk=options.chunkSize??64
 let seen=0,capped=false
 for await(const entry of await opendir(path)){
  signal.throwIfAborted()
  if(seen===cap){capped=true;break}
  await onEntry(entry)
  if(++seen%chunk===0)await setImmediate()
 }
 const after=await lstat(path,{bigint:true})
 const identity=identityOf(after)
 return {identity,seen,capped,complete:!capped&&before.dev===after.dev&&before.ino===after.ino&&before.mtimeNs===after.mtimeNs}
}
