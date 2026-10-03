import {spawn} from 'node:child_process'
import {realpathSync} from 'node:fs'
import {resolve,isAbsolute} from 'node:path'
import {z} from 'zod'
import {snapshotRegularFile} from '../../storage/native-resource-snapshot.js'
import {ComposioFailure} from '../composio/client.js'
const record=z.record(z.string(),z.unknown())
/** Fixed desktop resources only; callers validate their readonly command protocol. */
export class MacNativeReader {
 constructor(readonly resourcesRoot:string,readonly resource:'macos_calendar'|'macos_mail'){}
 #executable():string {
  if(process.platform!=='darwin'||!isAbsolute(this.resourcesRoot)||realpathSync(this.resourcesRoot)!==this.resourcesRoot)throw new ComposioFailure('native_unavailable')
  const manifest=z.object({schema_version:z.literal(1),target:z.literal('darwin-'+process.arch),resources:z.array(record).max(256)}).parse(JSON.parse(snapshotRegularFile(resolve(this.resourcesRoot,'native-resources-v1.json'),1024*1024).bytes.toString('utf8')))
  const rows=manifest.resources.filter(r=>r.logical_id===this.resource)
  const r=z.object({relative_path:z.literal('native/'+this.resource),kind:z.literal('executable'),platform:z.literal('darwin'),architecture:z.literal(process.arch),byte_size:z.number().int().positive(),sha256:z.string().regex(/^[a-f0-9]{64}$/u),build_contract_version:z.literal(1)}).parse(rows.length===1?rows[0]:null)
  const path=resolve(this.resourcesRoot,r.relative_path);if(realpathSync(path)!==path)throw new ComposioFailure('native_unavailable')
  const file=snapshotRegularFile(path,16*1024*1024)
  if(file.size!==r.byte_size||file.sha256!==r.sha256)throw new ComposioFailure('native_unavailable')
  return path
 }
 request(input:unknown,signal=AbortSignal.timeout(30000)):Promise<Record<string,unknown>> {
  const body=JSON.stringify(input);if(Buffer.byteLength(body)>65536)throw new ComposioFailure('request_too_large')
  const executable=this.#executable()
  return new Promise((resolve,reject)=>{
   const child=spawn(executable,[],{shell:false,stdio:['pipe','pipe','ignore'],signal:AbortSignal.any([signal,AbortSignal.timeout(30000)])})
   let bytes=0;const chunks:Buffer[]=[]
   child.on('error',()=>reject(new ComposioFailure('native_unavailable')))
   child.stdout.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>2*1024*1024){child.kill();reject(new ComposioFailure('response_too_large'))}else chunks.push(chunk)})
   child.on('close',code=>{try{if(code!==0)throw new ComposioFailure('native_unavailable');const result=record.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));if(result.error)throw new ComposioFailure(z.enum(['native_unavailable','permission_denied','calendar_unavailable','mailbox_unavailable','snapshot_expired','response_too_large','timeout','scope_denied','invalid_request']).catch('native_unavailable').parse(result.error));resolve(result)}catch(error){reject(error instanceof ComposioFailure?error:new ComposioFailure('invalid_contract'))}})
   child.stdin.on('error',()=>{ /* child failure is reported on close/error */ });child.stdin.end(body)
  })
 }
}
