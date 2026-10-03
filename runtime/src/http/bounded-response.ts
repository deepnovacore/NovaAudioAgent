import {abortable} from '../core/camera-session.js'

/** Cancel abandoned bodies; neither error messages nor upstream text cross this boundary. */
export async function readBoundedResponse(response:Response,options:{limit:number;signal?:AbortSignal;failure:(code:string)=>Error;consume?:(bytes:number)=>void}):Promise<Uint8Array>{
 const declared=response.headers.get('content-length')
 if(declared!==null&&(!/^\d+$/u.test(declared)||Number(declared)>options.limit)){void response.body?.cancel().catch(()=>{ /* best-effort cancellation */ });throw options.failure('response_too_large')}
 const body:ReadableStream<Uint8Array>|null=response.body
 const reader=body?.getReader();if(!reader)return new Uint8Array()
 const chunks:Uint8Array[]= [];let size=0,done=false
 try{
  for(;;){
   options.signal?.throwIfAborted()
   const read=reader.read(),chunk=options.signal?await abortable(read,options.signal):await read
   if(chunk.done){done=true;break}
   size+=chunk.value.byteLength
   options.consume?.(chunk.value.byteLength)
   if(size>options.limit)throw options.failure('response_too_large')
   chunks.push(chunk.value)
  }
 }finally{if(!done)void reader.cancel().catch(()=>{ /* best-effort cancellation */ });reader.releaseLock()}
 return Buffer.concat(chunks,size)
}
