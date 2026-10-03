/**
 * Orders support-model calls. Foreground work (a profile or todo synthesis the user is waiting on) starts at once;
 * background backfill runs one call at a time and does not start while foreground work is in flight.
 * Nothing already sent is interrupted.
 */
export type ModelPriority='foreground'|'background'
export class ModelLane{
 #foreground=0;#background=false;#waiting:{start:()=>void;signal:AbortSignal|undefined}[]=[]
 run<T>(priority:ModelPriority,task:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
  if(priority==='foreground'){this.#foreground++;return task().finally(()=>{this.#foreground--;this.#drain()})}
  return new Promise<void>((resolve,reject)=>{
   const entry={start:()=>{signal?.removeEventListener('abort',abort);resolve()},signal}
   const abort=()=>{const index=this.#waiting.indexOf(entry);if(index>=0)this.#waiting.splice(index,1);reject(signal?.reason instanceof Error?signal.reason:Error('model_lane_aborted'))}
   if(signal?.aborted){abort();return}
   signal?.addEventListener('abort',abort,{once:true})
   this.#waiting.push(entry);this.#drain()
  }).then(()=>task().finally(()=>{this.#background=false;this.#drain()}))
 }
 #drain(){
  if(this.#background||this.#foreground)return
  const next=this.#waiting.shift();if(!next)return
  this.#background=true;next.start()
 }
 snapshot(){return {foreground:this.#foreground,background:Number(this.#background),waiting:this.#waiting.length}}
}
