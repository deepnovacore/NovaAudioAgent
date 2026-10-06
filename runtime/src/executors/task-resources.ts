/** Host configured physical resources. Ownership outlives task/UI control changes. */
const held=new Set<string>()
const uncertain=new Set<string>()
/** No provider stop/idle inspection is available: keep quarantine visible; no automatic unlock without provider stop evidence. */
export function quarantineTaskResources(keys:readonly string[]):void{for(const key of keys)uncertain.add(key)}
const waiting:{keys:readonly string[];signal:AbortSignal;grant:()=>void;abort:()=>void}[]=[]
function drain():void{
 const earlier=new Set<string>()
 for(const entry of [...waiting]){
  if(entry.keys.some(key=>held.has(key)||uncertain.has(key)||earlier.has(key))){for(const key of entry.keys)earlier.add(key);continue}
  waiting.splice(waiting.indexOf(entry),1);entry.signal.removeEventListener('abort',entry.abort)
  for(const key of entry.keys)held.add(key)
  entry.grant()
 }
}
export function acquireTaskResources(keys:readonly string[],signal:AbortSignal):Promise<()=>void>{
 signal.throwIfAborted();const unique=[...new Set(keys)]
 return new Promise((resolve,reject)=>{
  const entry={keys:unique,signal,grant:()=>{let released=false;resolve(()=>{if(released)return;released=true;for(const key of unique)held.delete(key);drain()})},abort:()=>{const index=waiting.indexOf(entry);if(index>=0)waiting.splice(index,1);reject(signal.reason instanceof Error?signal.reason:new Error('aborted'));drain()}}
  signal.addEventListener('abort',entry.abort,{once:true});waiting.push(entry);drain()
 })
}
export function taskResourcesBusy(keys:readonly string[]):boolean{return keys.some(key=>held.has(key)||uncertain.has(key)||waiting.some(entry=>entry.keys.includes(key)))}

export function taskResourcesUncertain(keys:readonly string[]):boolean{return keys.some(key=>uncertain.has(key))}
