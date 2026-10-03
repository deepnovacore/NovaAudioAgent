import assert from 'node:assert/strict'
import {constants} from 'node:fs'
import {mkdtemp,realpath,readdir,lstat,mkdir,writeFile,open,rm,utimes} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname,extname,isAbsolute,join,relative} from 'node:path'
import {fileURLToPath} from 'node:url'

// Original docs are metadata-only. All parser/Worker inputs are newly generated in tmp.
const original=fileURLToPath(new URL('../../../docs/',import.meta.url))
const directory=await mkdtemp(join(await realpath(tmpdir()),'nova-directory-snapshot-'))
const output=process.env.NOVA_LIVE_MODULE_REPORT??join(directory,'result.json')
assert.ok(isAbsolute(output),'NOVA_LIVE_MODULE_REPORT must be absolute')
const report={version:1,module:'directory-snapshot',layer:'runtime-live',synthetic:true,status:'failed',started_at:new Date().toISOString(),checkpoint:'metadata',checks:[],stages:[],coverage:[],limitations:['Metadata snapshot of repository docs only; original file bodies are never opened.','Text-file directory topology is retained with anonymized names; binary formats and symlinks are not copied.','Synthetic body sizes are clamped to 64–16384 bytes; this is not exact original-byte or 20000-entry stress acceptance.','Real LocalDirectorySources and Knowledge Worker; deterministic local embedding only, no model/provider/network/GUI or actual user database.','Polling is disabled. Restart reopens services/Worker, not the complete desktop application.'],artifacts:{directory},external_calls:0}
const originalFetch=globalThis.fetch
globalThis.fetch=async()=>{report.external_calls++;throw Error('network_forbidden_in_directory_snapshot')}
let LocalDirectorySources,KnowledgeService,KnowledgeStoreClient,embeddingCalls=0
async function save(){const file=await open(output,constants.O_CREAT|constants.O_WRONLY|constants.O_TRUNC|constants.O_NOFOLLOW,0o600);try{await file.chmod(0o600);await file.writeFile(JSON.stringify(report,null,2)+'\n');await file.sync()}finally{await file.close()}}
async function phase(name){report.checkpoint=name;await save()}
const embedding={id:'synthetic-local-directory',dims:2,embed:async texts=>{embeddingCalls++;return texts.map(()=>new Float32Array([1,0]))}}
const failure=error=>({name:error?.name??'Error',message:String(error?.message??error).split(original).join('[metadata-root]')})
const snapshot=source=>({state:source.state,scanned:source.scanned,read:source.read,skipped:source.skipped,reasons:source.reasons,failures:source.failures.map(item=>({code:item.code}))})
async function metadata(){
 assert.equal((await lstat(original)).isSymbolicLink(),false,'Metadata root must not be a symlink')
 const files=[],pending=[original],extensions=new Set(['.md','.markdown','.txt','.json','.yaml','.yml','.csv']),stats={files:0,symlinks:0,unsupported:0,too_deep:0,bytes:0,max_depth:0}
 while(pending.length){const parent=pending.pop();for(const entry of (await readdir(parent,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  const path=join(parent,entry.name)
  if(entry.isSymbolicLink()){stats.symlinks++;continue}
  if(entry.isDirectory()){pending.push(path);continue}
  if(!entry.isFile())continue
  const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()){stats.symlinks++;continue}
  const parts=relative(original,path).split('/'),depth=parts.length-1;stats.files++;stats.bytes+=stat.size;stats.max_depth=Math.max(stats.max_depth,depth)
  if(!extensions.has(extname(entry.name).toLowerCase())){stats.unsupported++;continue}
  if(depth>16){stats.too_deep++;continue}
  files.push({parts,size:stat.size,extension:extname(entry.name).toLowerCase()})
 }}
 files.sort((a,b)=>a.parts.join('/').localeCompare(b.parts.join('/')))
 report.metadata={...stats,eligible:files.length,selected_max:Math.min(500,files.length)}
 assert.ok(files.length>0,'No eligible repository docs metadata found');return files
}
function services(root,invalidated){
 const knowledge=new KnowledgeService({store:new KnowledgeStoreClient({path:join(root,'db','knowledge.sqlite')}),embedding})
 const sources=new LocalDirectorySources({path:join(root,'db','sources.json'),knowledge,pollMs:0,onInvalidate:ref=>{invalidated.push(ref)},processingGrant:(_consent,revision,scope_revision)=>({revision,scope_revision,extraction_provider:null,embedding_provider:embedding.id})})
 return {sources,knowledge}
}
async function scale(files,count){
 const selected=files.slice(0,count),stage={files:count,status:'failed',checks:[],snapshots:[],original_bytes:selected.reduce((sum,file)=>sum+file.size,0),synthetic_bytes:selected.reduce((sum,file)=>sum+Math.max(64,Math.min(16384,file.size)),0),max_depth:Math.max(...selected.map(file=>file.parts.length-1))};report.stages.push(stage)
 const root=join(directory,'scale-'+count),folder=join(root,'shape'),invalidated=[],names=new Map();let resources
 try{
  await phase('scale-'+count+'-materialize')
  for(const [index,file]of selected.entries()){
   let sourceParent='';const dirs=file.parts.slice(0,-1).map(part=>{sourceParent+='/'+part;if(!names.has(sourceParent))names.set(sourceParent,'d'+String(names.size+1).padStart(4,'0'));return names.get(sourceParent)})
   const path=join(folder,...dirs,'f'+String(index).padStart(4,'0')+file.extension),size=Math.max(64,Math.min(16384,file.size)),header=`Synthetic directory record ${index}.\n`
   await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,header+'x'.repeat(size-header.length),{mode:0o600});await utimes(path,1700000000,1700000000)
  }
  resources=services(root,invalidated);await resources.knowledge.open();await resources.sources.open()
  const budget=Math.min(200,Math.max(1,Math.floor(count/2)));stage.max_files=budget
  await phase('scale-'+count+'-initial-scan')
  const {id}=await resources.sources.command('sources.add',{path:folder,consent:true,max_files:budget,max_bytes:20*1024*1024})
  let view=resources.sources.list()[0];stage.snapshots.push({phase:'initial',...snapshot(view)})
  assert.equal(view.state,'connected');assert.equal(view.scanned,count);assert.equal(view.read,Math.min(count,budget));assert.equal(view.reasons.body_budget??0,Math.max(0,count-budget))
  stage.checks.push('complete metadata scan; per-pass body count limit')
  for(let round=0;(await resources.knowledge.listSources()).length<count&&round<Math.ceil(count/budget);round++)await resources.sources.command('sources.sync',{id})
  let indexed=await resources.knowledge.listSources();assert.equal(indexed.length,count,'Deferred bodies must be indexed on subsequent explicit scans')
  const signatures=indexed.map(row=>[row.id,row.fingerprint]).sort();await resources.sources.command('sources.sync',{id})
  view=resources.sources.list()[0];assert.equal(view.read,0);assert.deepEqual((await resources.knowledge.listSources()).map(row=>[row.id,row.fingerprint]).sort(),signatures)
  stage.snapshots.push({phase:'drained-rescan',...snapshot(view)});stage.checks.push('deferred body drain; unchanged rescan reads zero bodies')
  await phase('scale-'+count+'-edit-delete')
  const chosen=indexed[0],oldRef=`file:${chosen.id}:${chosen.fingerprint}`
  await writeFile(chosen.locator,'Synthetic directory changed record. Unique replacement marker.\n',{mode:0o600});await utimes(chosen.locator,1700000002,1700000002)
  await resources.sources.command('sources.sync',{id});indexed=await resources.knowledge.listSources()
  const updated=indexed.find(row=>row.locator===chosen.locator);assert.ok(updated);assert.notEqual(updated.fingerprint,chosen.fingerprint);assert.ok(invalidated.includes(oldRef));assert.equal(resources.sources.evidence(oldRef),null)
  const hits=await resources.knowledge.recall('Unique replacement marker',5);assert.ok(hits.some(hit=>hit.text.includes('Unique replacement marker')),'Actual Worker retrieval must see replacement body')
  await rm(chosen.locator);await resources.sources.command('sources.sync',{id});indexed=await resources.knowledge.listSources();assert.equal(indexed.length,count-1);assert.ok(!indexed.some(row=>row.locator===chosen.locator))
  assert.equal(resources.sources.evidence(`file:${updated.id}:${updated.fingerprint}`),null);stage.checks.push('modification changes fingerprint and invalidates old evidence; complete scan removes deleted source')
  await phase('scale-'+count+'-restart')
  const stable=indexed.map(row=>[row.id,row.fingerprint]).sort();await resources.sources.close();await resources.knowledge.close();resources=services(root,invalidated);await resources.knowledge.open();await resources.sources.open()
  assert.equal(resources.sources.list()[0].id,id);assert.equal(resources.sources.list()[0].read,0);assert.deepEqual((await resources.knowledge.listSources()).map(row=>[row.id,row.fingerprint]).sort(),stable)
  stage.checks.push('service/Worker restart retains IDs and current indexed content without rereading unchanged files');stage.status='passed'
 }catch(error){stage.failure={checkpoint:report.checkpoint,...failure(error)};process.exitCode=1}
 finally{for(const object of [resources?.sources,resources?.knowledge])try{await object?.close()}catch(error){stage.status='failed';stage.cleanup_failure=failure(error);process.exitCode=1}await save()}
 console.log(stage.status.toUpperCase(),'directory scale',count)
}
async function boundaries(){
 const stage={files:3,status:'failed',checks:[],snapshots:[]};report.boundaries=stage
 const root=join(directory,'boundaries'),folder=join(root,'shape'),deep16=join(folder,...Array.from({length:16},(_,i)=>'level-'+i)),deep17=join(deep16,'level-16'),invalidated=[];let resources
 try{
  await phase('depth-and-byte-boundaries');await mkdir(deep17,{recursive:true,mode:0o700})
  await writeFile(join(folder,'root.md'),'synthetic-root!!');await writeFile(join(deep16,'allowed.md'),'synthetic-deep!!');await writeFile(join(deep17,'excluded.md'),'synthetic-cutoff')
  resources=services(root,invalidated);await resources.knowledge.open();await resources.sources.open()
  const {id}=await resources.sources.command('sources.add',{path:folder,consent:true,max_files:200,max_bytes:16})
  let view=resources.sources.list()[0];assert.equal(view.scanned,2);assert.equal(view.read,1);assert.equal(view.reasons.depth_limit,1);assert.equal(view.reasons.body_budget,1);stage.snapshots.push({phase:'bounded-initial',...snapshot(view)})
  await resources.sources.command('sources.sync',{id});assert.equal((await resources.knowledge.listSources()).length,2)
  assert.ok(!(await resources.knowledge.listSources()).some(row=>row.locator===join(deep17,'excluded.md')));stage.checks.push('depth 16 indexed, depth 17 skipped; aggregate byte budget defers an eligible body')
  await rm(join(folder,'root.md'));await resources.sources.command('sources.sync',{id});assert.equal((await resources.knowledge.listSources()).length,2,'Incomplete depth-limited scan must not infer deletion')
  await rm(deep17,{recursive:true});await resources.sources.command('sources.sync',{id});assert.equal((await resources.knowledge.listSources()).length,1);assert.equal(resources.sources.list()[0].reasons.depth_limit??0,0)
  stage.checks.push('incomplete depth scan retains index; complete scan subsequently reconciles deletion');stage.status='passed'
 }catch(error){stage.failure={checkpoint:report.checkpoint,...failure(error)};process.exitCode=1}
 finally{for(const object of [resources?.sources,resources?.knowledge])try{await object?.close()}catch(error){stage.status='failed';stage.cleanup_failure=failure(error);process.exitCode=1}await save()}
 console.log(stage.status.toUpperCase(),'directory depth/byte boundaries')
}
try{
 await save();const files=await metadata();await phase('loading-compiled-runtime')
 ;[{LocalDirectorySources},{KnowledgeService},{KnowledgeStoreClient}]=await Promise.all([import('../../dist/src/personal-agent/sources.js'),import('../../dist/src/knowledge/service.js'),import('../../dist/src/knowledge/store-client.js')])
 for(const count of [...new Set([1,10,100,Math.min(500,files.length)].filter(value=>value<=files.length))].sort((a,b)=>a-b))await scale(files,count)
 await boundaries();assert.equal(report.external_calls,0)
 report.coverage=report.stages.flatMap(stage=>stage.checks.map(check=>({files:stage.files,check}))).concat(report.boundaries.checks.map(check=>({boundary:true,check})))
 report.status=report.stages.every(stage=>stage.status==='passed')&&report.boundaries.status==='passed'?'passed':'failed'
 report.checks=['metadata-only source snapshot','all runtime input files generated in a new temporary directory','no external network call'];if(report.status==='failed')process.exitCode=1
}catch(error){report.failure={checkpoint:report.checkpoint,...failure(error)};process.exitCode=1}
finally{report.embedding_calls=embeddingCalls;report.finished_at=new Date().toISOString();globalThis.fetch=originalFetch;await save();console.log('Directory runtime report:',output)}
