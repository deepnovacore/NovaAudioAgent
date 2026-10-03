import {createHash,randomUUID} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {chmodSync,closeSync,constants,fstatSync,fsyncSync,linkSync,lstatSync,mkdirSync,openSync,readFileSync,readdirSync,renameSync,unlinkSync,writeFileSync} from 'node:fs'
import {dirname,join,parse,resolve} from 'node:path'
import {z} from 'zod'
import {EntryRevisionSchema,type EntryRevision} from './store.js'
import {canonicalJson} from '../text/canonical-json.js'

const MAX_FILE=8*1024*1024
const MAX_BATCH=64*1024*1024
const MAX_ENTRIES=10_000
const MARKER='.nova-memory.json'
const LOCK_POLL_MS=25
const LOCK_SLEEP=new Int32Array(new SharedArrayBuffer(4))
const JOURNAL='.nova-memory-batch.json'
const markerText='{"format":"nova-understanding","version":1}\n'
const hasPath=(path:string)=>lstatSync(path,{throwIfNoEntry:false})!==undefined
const digest=(text:string)=>createHash('sha256').update(text).digest('hex')
const entryPath=(id:string)=>`entries/${digest(id)}.md`
const failure=(code:string)=>new Error(`MEMORY_MARKDOWN_${code}`)
const journalSchema=z.object({version:z.literal(1),operationId:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),baseCommit:z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),files:z.array(z.object({path:z.string().regex(/^(entries\/[a-f0-9]{64}\.md|\.nova-memory\.json)$/),beforeHash:z.string().regex(/^[a-f0-9]{64}$/).nullable(),after:z.string().max(MAX_FILE)}).strict()).max(MAX_ENTRIES+1)}).strict()
type Journal=z.infer<typeof journalSchema>
interface LockOwner {owner:{pid:number;token:string};bytes:string;ino:number;dev:number}
export interface MarkdownEdit {entry_id:string;expected_revision:number;content:EntryRevision['content'];path:string;hash:string}
export type ApprovedMarkdownEdit=Pick<MarkdownEdit,'entry_id'|'expected_revision'|'path'|'hash'>
export interface MarkdownSnapshot {revisions:EntryRevision[];edits:MarkdownEdit[];baselines:Record<string,string>}

function history(revisions:readonly EntryRevision[]):Map<string,EntryRevision[]> {
 if(revisions.length>100_000)throw failure('LIMIT')
 const result=new Map<string,EntryRevision[]>()
 for(const value of revisions){const revision=EntryRevisionSchema.parse(value);const list=result.get(revision.entry_id)??[];list.push(revision);result.set(revision.entry_id,list)}
 if(result.size>MAX_ENTRIES)throw failure('LIMIT')
 for(const list of result.values()){
  list.sort((a,b)=>a.revision-b.revision)
  for(let i=0;i<list.length;i++)if(list[i]!.revision!==i+1||list[i]!.supersedes!==(i===0?null:i))throw failure('HISTORY')
 }
 return result
}
function body(current:EntryRevision):string {return typeof current.content.text==='string'?current.content.text:JSON.stringify(current.content,null,2)}
function render(list:EntryRevision[]):string {
 const current=list.at(-1)!
 // The header is immutable revision history. Only text below the divider is editable.
 const metadata=canonicalJson({format:1,revisions:list}).replace(/-->/g,'--\\u003e')
 const text=`<!-- nova-memory-v1\n${metadata}\n-->\n# ${current.kind}\n\n<!-- editable-current -->\n${body(current)}\n`
 if(Buffer.byteLength(text)>MAX_FILE)throw failure('LIMIT')
 return text
}
function decode(text:string):{revisions:EntryRevision[];content:EntryRevision['content']} {
 const match=/^<!-- nova-memory-v1\n([^\n]+)\n-->\n# ([^\n]*)\n\n<!-- editable-current -->\n([\s\S]*)\n$/.exec(text)
 if(!match)throw failure('FORMAT')
 const metadata=z.object({format:z.literal(1),revisions:z.array(EntryRevisionSchema).min(1)}).strict().parse(JSON.parse(match[1]!))
 const grouped=history(metadata.revisions);if(grouped.size!==1)throw failure('FORMAT')
 const current=metadata.revisions.at(-1)!
 if(current.kind!==match[2])throw failure('FORMAT')
 const content=typeof current.content.text==='string'?{...current.content,text:match[3]!}:z.record(z.string(),z.json()).parse(JSON.parse(match[3]!))
 return {revisions:metadata.revisions,content}
}

/** Synchronous, worker-owned repository. Caller makes its SQLite outbox durable before prepare(). */
export class MarkdownRepository {
 readonly root:string
 private baseline:Record<string,string>|undefined
 private initialized=false
 private readonly lockWaitMs:number
 constructor(root:string,options:{lockWaitMs?:number}={}){this.root=resolve(root);this.lockWaitMs=options.lockWaitMs??0}

 /** Initializes an independent, local-only Git repository; never recovers an operation implicitly. */
 initialize():void {
  if(this.initialized){this.ensureRoot();this.assertSafe(join(this.root,'entries'),true);return}
  this.ensureRoot()
  const gitPath=join(this.root,'.git')
  if(hasPath(gitPath)){
   this.assertSafe(gitPath,true)
   // A nonempty unrelated repository is not a migration target.
   if(!hasPath(join(this.root,MARKER))&&!hasPath(join(this.root,JOURNAL))){
    const tracked=this.git(['ls-tree','-r','--name-only','HEAD'],undefined,true)
    if(tracked)throw failure('UNOWNED_REPOSITORY')
   }
  }else this.git(['init','--quiet','--template='])
  const entries=join(this.root,'entries')
  if(!hasPath(entries))mkdirSync(entries,{mode:0o700})
  this.assertSafe(entries,true);chmodSync(entries,0o700)
  this.initialized=true
 }

 /** Covers the caller's full SQLite read/admit/commit/file-publication cycle. Never steals a live owner's lock. */
 withLock<T>(fn:()=>T):T {
  this.ensureRoot()
  const lock=join(this.root,'.nova-memory.lock')
  const owner={pid:process.pid,token:randomUUID()}
  const bytes=JSON.stringify(owner)
  const contender=`.nova-lock-${owner.pid}-${owner.token}.tmp`
  this.writeExclusive(contender,bytes)
  let acquired=false
  try {
   const deadline=Date.now()+this.lockWaitMs
   for(let stale=0;;){
    try{linkSync(join(this.root,contender),lock);acquired=true;break}
    catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error}
    let previous:LockOwner
    try{previous=this.lockOwner(lock)}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error}
    let dead=false
    try{process.kill(previous.owner.pid,0)}catch(error){dead=(error as NodeJS.ErrnoException).code==='ESRCH'}
    if(!dead){
     if(Date.now()>=deadline)throw failure('BUSY')
     Atomics.wait(LOCK_SLEEP,0,0,LOCK_POLL_MS)
     continue
    }
    if(stale++>=1)throw failure('BUSY')
    const checked=this.lockOwner(lock)
    if(checked.bytes!==previous.bytes||checked.ino!==previous.ino||checked.dev!==previous.dev)throw failure('BUSY')
    unlinkSync(lock)
   }
   this.syncDirectory(this.root)
   return fn()
  }finally{
   if(acquired){const current=this.lockOwner(lock);if(current.bytes!==bytes)throw failure('LOCK_CONFLICT');unlinkSync(lock)}
   if(hasPath(join(this.root,contender))){
    // Once the canonical link is removed this is again a regular, single-link owned file.
    if(this.readFile(contender)!==bytes)throw failure('LOCK_CONFLICT')
    unlinkSync(join(this.root,contender))
   }
   this.syncDirectory(this.root)
  }
 }
 hasSnapshot():boolean {this.initialize();return hasPath(join(this.root,MARKER))}

 open(initialRevisions:readonly EntryRevision[]):MarkdownSnapshot {
  this.initialize()
  if(this.pendingOperationId())throw failure('PENDING_OPERATION')
  if(!hasPath(join(this.root,MARKER))){
   if(readdirSync(join(this.root,'entries')).length)throw failure('UNOWNED_REPOSITORY')
   this.publish(initialRevisions)
  }
  return this.read()
 }

 read():MarkdownSnapshot {
  this.initialize()
  if(this.pendingOperationId())throw failure('PENDING_OPERATION')
  const revisions:EntryRevision[]=[];const edits:MarkdownEdit[]=[];const baselines:Record<string,string>={}
  if(hasPath(join(this.root,MARKER))){if(this.readFile(MARKER)!==markerText)throw failure('FORMAT');baselines[MARKER]=digest(markerText)}
  const names=readdirSync(join(this.root,'entries')).sort()
  if(names.length>MAX_ENTRIES)throw failure('LIMIT')
  const head=this.head()
  const tracked=head?this.git(['ls-tree','-r','--name-only',head,'--','entries']).split('\n').filter(Boolean):[]
  for(const path of tracked)if(!names.includes(path.slice('entries/'.length)))throw failure('CONFLICT')
  let bytes=0
  for(const name of names){
   const path=`entries/${name}`
   this.assertSafe(join(this.root,path),false)
   if(!/^[a-f0-9]{64}\.md$/.test(name))throw failure('UNSAFE_PATH')
   const text=this.readFile(path);bytes+=Buffer.byteLength(text);if(bytes>MAX_BATCH)throw failure('LIMIT')
   const parsed=decode(text);const current=parsed.revisions.at(-1)!
   if(path!==entryPath(current.entry_id))throw failure('FORMAT')
   if(head){
    if(!tracked.includes(path))throw failure('UNADMITTED_EDIT')
    const committed=decode(this.git(['show',`${head}:${path}`]))
    if(canonicalJson(parsed.revisions)!==canonicalJson(committed.revisions))throw failure('HISTORY_EDIT')
   }
   revisions.push(...parsed.revisions);baselines[path]=digest(text)
   if(canonicalJson(parsed.content)!==canonicalJson(current.content))edits.push({entry_id:current.entry_id,expected_revision:current.revision,content:parsed.content,path,hash:digest(text)})
  }
  revisions.sort((a,b)=>a.entry_id<b.entry_id?-1:a.entry_id>b.entry_id?1:a.revision-b.revision)
  this.baseline={...baselines}
  return {revisions,edits,baselines}
 }

 /** Preserve this baseline across admission of external corrections and the SQLite outbox commit. */
 prepare(revisions:readonly EntryRevision[],operationId:string=randomUUID(),baselines:Record<string,string>|undefined=this.baseline,approvedEdits:readonly ApprovedMarkdownEdit[]=[]):string {
  this.initialize()
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(operationId))throw failure('OPERATION_ID')
  if(this.pendingOperationId())throw failure('PENDING_OPERATION')
  const current=this.read()
  if(baselines&&canonicalJson(baselines)!==canonicalJson(current.baselines))throw failure('CONFLICT')
  const grouped=history(revisions)
  for(const old of current.revisions){
   const replacement=grouped.get(old.entry_id)?.find(item=>item.revision===old.revision)
   if(!replacement||canonicalJson(replacement)!==canonicalJson(old))throw failure('HISTORY')
  }
  for(const edit of current.edits){
   const accepted=grouped.get(edit.entry_id)?.at(-1)
   const approval=approvedEdits.some(item=>item.entry_id===edit.entry_id&&item.expected_revision===edit.expected_revision&&item.path===edit.path&&item.hash===edit.hash)
   if(accepted?.revision!==edit.expected_revision+1||accepted.supersedes!==edit.expected_revision||accepted.written_by!=='user_correction'||accepted.origin!=='stated'||(!approval&&canonicalJson(accepted.content)!==canonicalJson(edit.content)))throw failure('UNADMITTED_EDIT')
  }
  const files:Journal['files']=[{path:MARKER,beforeHash:current.baselines[MARKER]??null,after:markerText}]
  for(const [id,list] of [...grouped].sort(([a],[b])=>a.localeCompare(b)))files.push({path:entryPath(id),beforeHash:current.baselines[entryPath(id)]??null,after:render(list)})
  const journal:Journal={version:1,operationId,baseCommit:this.head(),files}
  const text=JSON.stringify(journal)
  if(Buffer.byteLength(text)>MAX_BATCH)throw failure('LIMIT')
  // Exclusive creation is the inter-process batch lock. No stale lock is ever removed implicitly.
  const stagedJournal=`.nova-batch-${operationId}.tmp`
  if(hasPath(join(this.root,stagedJournal))){if(this.readFile(stagedJournal,MAX_BATCH)!==text)throw failure('CONFLICT')}
  else this.writeExclusive(stagedJournal,text)
  linkSync(join(this.root,stagedJournal),join(this.root,JOURNAL))
  unlinkSync(join(this.root,stagedJournal));this.syncDirectory(this.root)
  return operationId
 }

 publish(revisions:readonly EntryRevision[]):void {const operation=this.prepare(revisions);this.publishPrepared(operation);this.finalize(operation)}
 pendingOperationId():string|null {this.initialize();return hasPath(join(this.root,JOURNAL))?this.journal().operationId:null}

 publishPrepared(operationId:string):void {
  this.initialize();const journal=this.journal();if(journal.operationId!==operationId)throw failure('OPERATION_ID')
  this.checkBatch(journal)
  const initialHead=this.head()
  if(initialHead!==journal.baseCommit&&!this.isOperationCommit(initialHead,journal))throw failure('CONFLICT')
  for(const file of journal.files){
   if(this.fileHash(file.path)===digest(file.after))continue
   this.checkFile(file)
   this.atomicWrite(file,journal.operationId)
  }
  this.checkBatch(journal,true)
  const head=this.head()
  if(head!==journal.baseCommit){
   if(!this.isOperationCommit(head,journal))throw failure('CONFLICT')
  }else {
   // Build exactly the owned understanding tree. Untracked files and the batch journal never enter Git.
   const entries:string[]=[];let marker=''
   for(const file of journal.files){const blob=this.git(['hash-object','-w','--stdin'],file.after).trim();if(file.path===MARKER)marker=blob;else entries.push(`100644 blob ${blob}\t${file.path.slice('entries/'.length)}\n`)}
   const treeEntries=this.git(['mktree'],entries.sort().join('')).trim()
   const tree=this.git(['mktree'],`100644 blob ${marker}\t${MARKER}\n040000 tree ${treeEntries}\tentries\n`).trim()
   const previousTree=head?this.git(['rev-parse',`${head}^{tree}`]).trim():null
   if(tree!==previousTree){
    const commit=this.git(['commit-tree',tree,...(head?['-p',head]:[])],`Nova understanding ${operationId}\n`).trim()
    this.checkBatch(journal,true)
    this.git(['update-ref','HEAD',commit,head??'0'.repeat(40)])
   }
  }
  this.checkBatch(journal,true)
 }

 finalize(operationId:string):void {
  const journal=this.journal();if(journal.operationId!==operationId)throw failure('OPERATION_ID')
  this.checkBatch(journal,true)
  if(!this.isOperationCommit(this.head(),journal))throw failure('UNCOMMITTED')
  const stagedJournal=join(this.root,`.nova-batch-${operationId}.tmp`)
  if(hasPath(stagedJournal)){
   const staged=lstatSync(stagedJournal),active=lstatSync(join(this.root,JOURNAL))
   if(staged.ino!==active.ino||staged.dev!==active.dev)throw failure('CONFLICT')
   unlinkSync(stagedJournal)
  }
  this.assertSafe(join(this.root,JOURNAL),false);unlinkSync(join(this.root,JOURNAL));this.syncDirectory(this.root)
  this.baseline=Object.fromEntries(journal.files.map(file=>[file.path,digest(file.after)]))
 }
 recover(operationId:string,expectedRevisions?:readonly EntryRevision[]):void {
  this.initialize()
  if(expectedRevisions){
   const journal=this.journal(),expected=history(expectedRevisions)
   if(journal.operationId!==operationId||journal.files.length!==expected.size+1)throw failure('CONFLICT')
   for(const [id,revisions] of expected){const file=journal.files.find(item=>item.path===entryPath(id));if(file?.after!==render(revisions))throw failure('CONFLICT')}
  }
  this.publishPrepared(operationId);this.finalize(operationId)
 }

 /** The caller first durably records the retained snapshot and these preimages in SQLite. */
 purge(revisions:readonly EntryRevision[],operationId:string,baselines:Record<string,string>):void {
  this.initialize();if(this.pendingOperationId())throw failure('PENDING_OPERATION')
  if(readdirSync(this.root).some(name=>name.startsWith('.nova-')&&name.endsWith('.tmp')&&!name.startsWith('.nova-lock-')))throw failure('PURGE_INCOMPLETE')
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(operationId))throw failure('OPERATION_ID')
  const files=new Map<string,string>([[MARKER,markerText]])
  for(const [id,list] of history(revisions))files.set(entryPath(id),render(list))
  const check=()=>{
   for(const [path,expected] of files)if(this.fileHash(path)!==digest(expected))throw failure('CONFLICT')
   for(const name of readdirSync(join(this.root,'entries'))){const path=`entries/${name}`;if(!files.has(path)&&(!Object.hasOwn(baselines,path)||this.fileHash(path)!==baselines[path]))throw failure('CONFLICT')}
   for(const path of Object.keys(baselines))if(path!==MARKER&&!/^entries\/[a-f0-9]{64}\.md$/.test(path))throw failure('UNSAFE_PATH')
  }
  check()
  // Other refs or a staged user change require explicit reconciliation, never silent removal.
  const branch=this.git(['symbolic-ref','-q','HEAD']).trim()
  if(this.git(['for-each-ref','--format=%(refname)']).trim().split('\n').filter(Boolean).some(ref=>ref!==branch)||this.git(['ls-files']).trim())throw failure('CONFLICT')
  // No path outside the known Git directory may participate in object cleanup.
  this.assertGitRefs(join(this.root,'.git'))
  if(hasPath(join(this.root,'.git','objects','info','alternates')))throw failure('UNSAFE_PATH')
  const entries:string[]=[];let marker=''
  for(const [path,text] of files){const blob=this.git(['hash-object','-w','--stdin'],text).trim();if(path===MARKER)marker=blob;else entries.push(`100644 blob ${blob}\t${path.slice('entries/'.length)}\n`)}
  const treeEntries=this.git(['mktree'],entries.sort().join('')).trim()
  const tree=this.git(['mktree'],`100644 blob ${marker}\t${MARKER}\n040000 tree ${treeEntries}\tentries\n`).trim()
  const head=this.head(),parents=head?this.git(['rev-list','--parents','-n','1',head]).trim().split(' '):[]
  if(!head||this.git(['rev-parse',`${head}^{tree}`]).trim()!==tree||parents.length!==1){
   const commit=this.git(['commit-tree',tree],`Nova permanent purge ${operationId}\n`).trim()
   check();this.git(['update-ref','HEAD',commit,head??'0'.repeat(40)])
  }
  check()
  for(const name of readdirSync(join(this.root,'entries'))){const path=`entries/${name}`;if(!files.has(path)){if(this.fileHash(path)!==baselines[path])throw failure('CONFLICT');unlinkSync(join(this.root,path))}}
  this.syncDirectory(join(this.root,'entries'))
  this.git(['reflog','expire','--expire=now','--all'])
  this.git(['-c','gc.auto=0','gc','--prune=now','--quiet'])
  if(this.git(['fsck','--no-reflogs','--unreachable']).trim())throw failure('PURGE_INCOMPLETE')
  this.baseline=Object.fromEntries([...files].map(([path,text])=>[path,digest(text)]))
 }

 private journal():Journal {
  const text=this.readFile(JOURNAL,MAX_BATCH,true)
  const value=journalSchema.parse(JSON.parse(text))
  const active=lstatSync(join(this.root,JOURNAL))
  if(active.nlink!==1){
   const staged=join(this.root,`.nova-batch-${value.operationId}.tmp`)
   if(active.nlink!==2||!hasPath(staged))throw failure('UNSAFE_PATH')
   const original=lstatSync(staged)
   if(original.isSymbolicLink()||original.ino!==active.ino||original.dev!==active.dev)throw failure('UNSAFE_PATH')
  }
  if(new Set(value.files.map(file=>file.path)).size!==value.files.length||value.files.filter(file=>file.path===MARKER&&file.after===markerText).length!==1)throw failure('FORMAT')
  for(const file of value.files)if(file.path!==MARKER){const entry=decode(file.after);if(entryPath(entry.revisions.at(-1)!.entry_id)!==file.path)throw failure('FORMAT')}
  return value
 }
 private checkFile(file:Journal['files'][number],published=false):void {
  const current=this.fileHash(file.path)
  if(current!==digest(file.after)&&(published||current!==file.beforeHash))throw failure('CONFLICT')
 }
 private checkBatch(journal:Journal,published=false):void {
  for(const file of journal.files)this.checkFile(file,published)
  const expected=new Set(journal.files.filter(file=>file.path!==MARKER).map(file=>file.path))
  for(const name of readdirSync(join(this.root,'entries')))if(!expected.has(`entries/${name}`))throw failure('CONFLICT')
 }
 private isOperationCommit(head:string|null,journal:Journal):boolean {
  if(!head)return false
  // Also handles a no-op batch whose tree already matched its base commit.
  const paths=this.git(['ls-tree','-r','--name-only',head]).trim().split('\n').filter(Boolean)
  if(paths.length!==journal.files.length)return false
  return journal.files.every(file=>paths.includes(file.path)&&digest(this.git(['show',`${head}:${file.path}`]))===digest(file.after))
 }
 private head():string|null {const value=this.git(['rev-parse','--verify','HEAD'],undefined,true).trim();return /^[a-f0-9]{40,64}$/.test(value)?value:null}
 private git(args:string[],input?:string,optional=false):string {
  const gitDir=join(this.root,'.git')
  if(hasPath(gitDir)){
   this.assertSafe(gitDir,true)
   if(hasPath(join(gitDir,'commondir'))||hasPath(join(gitDir,'gitdir')))throw failure('UNSAFE_PATH')
   // Git must not follow user-data symlinks into another repository or command configuration.
   for(const name of ['config','HEAD','objects','refs','index','packed-refs','shallow'])if(hasPath(join(gitDir,name)))this.assertSafe(join(gitDir,name),['objects','refs'].includes(name))
   const objects=join(gitDir,'objects')
   if(hasPath(objects))for(const name of readdirSync(objects))this.assertSafe(join(objects,name),true)
   const refs=join(gitDir,'refs')
   if(hasPath(refs))this.assertGitRefs(refs)
  }
  const env:NodeJS.ProcessEnv={...process.env}
  for(const key of Object.keys(env))if(key.startsWith('GIT_'))delete env[key]
  Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_AUTHOR_NAME:'Nova',GIT_AUTHOR_EMAIL:'nova@localhost',GIT_COMMITTER_NAME:'Nova',GIT_COMMITTER_EMAIL:'nova@localhost'})
  try{return execFileSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','commit.gpgSign=false','-C',this.root,...args],{input,encoding:'utf8',env,timeout:15_000,maxBuffer:MAX_BATCH,stdio:['pipe','pipe','pipe']})}
  catch(error){if(optional)return '';throw new Error('MEMORY_MARKDOWN_GIT',{cause:error})}
 }
 private ensureRoot():void {
  this.assertAncestors()
  if(!hasPath(this.root))mkdirSync(this.root,{recursive:true,mode:0o700})
  this.assertSafe(this.root,true);chmodSync(this.root,0o700)
 }
 private lockOwner(path:string):LockOwner {
  const stat=lstatSync(path)
  if(stat.isSymbolicLink()||!stat.isFile()||stat.size>4096)throw failure('UNSAFE_PATH')
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW)
  try{
   const bytes=readFileSync(fd,'utf8')
   const owner=z.object({pid:z.number().int().positive(),token:z.string().min(1).max(128)}).strict().parse(JSON.parse(bytes))
   return {owner,bytes,ino:stat.ino,dev:stat.dev}
  }finally{closeSync(fd)}
 }
 private assertGitRefs(path:string):void {
  for(const name of readdirSync(path)){const child=join(path,name);const stat=lstatSync(child);this.assertSafe(child,stat.isDirectory());if(stat.isDirectory())this.assertGitRefs(child)}
 }
 private assertAncestors():void {
  const root=parse(this.root).root;let cursor=root
  for(const component of this.root.slice(root.length).split(/[\\/]/).filter(Boolean)){
   cursor=join(cursor,component)
   if(!hasPath(cursor))continue
   // macOS has these system aliases; user-controlled symlink ancestors remain forbidden.
   if(process.platform==='darwin'&&['/tmp','/var','/etc'].includes(cursor))continue
   this.assertSafe(cursor,true)
  }
 }
 private assertSafe(path:string,directory:boolean):void {
  const stat=lstatSync(path)
  if(stat.isSymbolicLink()||(directory?!stat.isDirectory():!stat.isFile())||(!directory&&stat.nlink!==1))throw failure('UNSAFE_PATH')
 }
 private readFile(relative:string,limit=MAX_FILE,journalLink=false):string {
  const path=join(this.root,relative);this.assertSafe(dirname(path),true)
  if(journalLink){const stat=lstatSync(path);if(stat.isSymbolicLink()||!stat.isFile())throw failure('UNSAFE_PATH')}else this.assertSafe(path,false)
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW)
  try {if(fstatSync(fd).size>limit)throw failure('LIMIT');const text=readFileSync(fd,'utf8');if(Buffer.byteLength(text)>limit)throw failure('LIMIT');return text}finally{closeSync(fd)}
 }
 private fileHash(path:string):string|null {return hasPath(join(this.root,path))?digest(this.readFile(path)):null}
 private writeExclusive(relative:string,text:string):void {
  const path=join(this.root,relative);this.assertSafe(dirname(path),true)
  const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)
  try{writeFileSync(fd,text);fsyncSync(fd)}finally{closeSync(fd)}
  this.syncDirectory(dirname(path))
 }
 private atomicWrite(file:Journal['files'][number],operationId:string):void {
  const path=join(this.root,file.path);const temporary=`.nova-${operationId}-${digest(file.path)}.tmp`
  const temporaryPath=join(this.root,temporary)
  // The operation ID and expected bytes prove ownership of a crash-left staging file.
  if(hasPath(temporaryPath)){if(this.readFile(temporary)!==file.after)throw failure('CONFLICT')}
  else this.writeExclusive(temporary,file.after)
  this.checkFile(file)
  this.assertSafe(dirname(path),true)
  renameSync(temporaryPath,path);chmodSync(path,0o600);this.syncDirectory(dirname(path));this.syncDirectory(this.root)
 }
 private syncDirectory(path:string):void {
  if(process.platform==='win32')return
  const fd=openSync(path,constants.O_RDONLY);try{fsyncSync(fd)}finally{closeSync(fd)}
 }
}
