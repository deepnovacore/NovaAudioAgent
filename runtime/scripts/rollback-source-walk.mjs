#!/usr/bin/env node
// Offline rollback for the v1 directory-ledger extension. Keep the input as the recovery copy.
import {lstat,readFile,realpath,writeFile,rename} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {resolve} from 'node:path'

const [input,output]=process.argv.slice(2)
if(!input||!output||resolve(input)===resolve(output))throw Error('usage: rollback-source-walk INPUT OUTPUT (distinct paths)')
const target=await lstat(output).catch(()=>null)
if(target||await realpath(output).catch(()=>null)===await realpath(input))throw Error('rollback_output_exists_or_aliases_input')
const disk=JSON.parse(await readFile(input,'utf8'))
if(disk.version!==1||!Array.isArray(disk.sources))throw Error('unsupported_source_state')
for(const source of disk.sources){
 const walk=source.walk
 if(!walk)continue
 const queued=new Map((walk.queue??[]).map(item=>[item.path,{path:item.path,offset:0,...(item.unit?{unit:item.unit}:{})}]))
 for(const item of walk.ledger??[])if(item.status!=='done'&&!queued.has(item.path))queued.set(item.path,{path:item.path,offset:0,...(item.unit?{unit:item.unit}:{})})
 if(queued.size>20000)throw Error('rollback_queue_capacity')
 source.walk={queue:[...queued.values()],pending:walk.pending??[],deferred:walk.deferred??[],...(walk.workspace_seeded?{workspace_seeded:walk.workspace_seeded}:{})}
}
const temp=`${output}.${randomUUID()}.tmp`
await writeFile(temp,JSON.stringify(disk),{flag:'wx',mode:0o600})
await rename(temp,output)
