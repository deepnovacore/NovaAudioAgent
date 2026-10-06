import {execFile} from 'node:child_process'
import {createHash} from 'node:crypto'
import {homedir} from 'node:os'
import {lstat,readFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {promisify} from 'node:util'
import {z} from 'zod'
import {BoundedJsonStore} from '../storage/bounded-json.js'

export interface RootSignal {path:string; selected:boolean; currentWorkspace:boolean; lastGitCommitMs:number|null; mtimeMs:number}

const recentGit=(root:RootSignal,now:number)=>root.lastGitCommitMs!==null&&now-root.lastGitCommitMs<30*86_400_000
const recentMtime=(root:RootSignal,now:number)=>now-root.mtimeMs<7*86_400_000

export function orderComputerRoots<T extends RootSignal>(roots: readonly T[]): T[] {
  const now=Date.now()
  return [...roots].sort((a,b)=>Number(b.selected)-Number(a.selected)
    || Number(b.currentWorkspace)-Number(a.currentWorkspace)
    || Number(recentGit(b,now))-Number(recentGit(a,now))
    || (b.lastGitCommitMs??0)-(a.lastGitCommitMs??0)
    || Number(recentMtime(b,now))-Number(recentMtime(a,now))
    || (recentMtime(b,now)?b.mtimeMs-a.mtimeMs:0) || a.path.localeCompare(b.path))
}

/** Four selected/current, two recent-Git, one recent-mtime, then one other turn. */
export function nextComputerRoot<T extends RootSignal>(roots:readonly T[],turn:number,cursors:number[],skipped:ReadonlySet<string>=new Set()):T|undefined {
  const now=Date.now()
  const tiers=[
    roots.filter(root=>root.selected||root.currentWorkspace),
    roots.filter(root=>!root.selected&&!root.currentWorkspace&&recentGit(root,now)),
    roots.filter(root=>!root.selected&&!root.currentWorkspace&&!recentGit(root,now)&&recentMtime(root,now)),
    roots.filter(root=>!root.selected&&!root.currentWorkspace&&!recentGit(root,now)&&!recentMtime(root,now)),
  ]
  const preferred=[0,0,0,0,1,1,2,3][turn%8]!
  for(const tier of [preferred,(preferred+1)%4,(preferred+2)%4,(preferred+3)%4]){
    const available=tiers[tier]!.filter(root=>!skipped.has(root.path))
    if(!available.length)continue
    const cursor=cursors[tier]??0
    cursors[tier]=cursor+1
    return available[cursor%available.length]
  }
  return undefined
}

const run = promisify(execFile)
export async function rootActivity(path:string):Promise<{lastGitCommitMs:number|null;ownCommits:number;mtimeMs:number}> {
  const stat=await lstat(path).catch(()=>null)
  let lastGitCommitMs:number|null=null,ownCommits=0
  const marker=await lstat(join(path,'.git')).catch(()=>null)
  if(marker&&(marker.isDirectory()||marker.isFile())&&!marker.isSymbolicLink()){
    try{
      const ident=await run('git',['-C',path,'var','GIT_AUTHOR_IDENT'],{timeout:500,maxBuffer:512})
      const email=/<([^<>]+)>/u.exec(ident.stdout)?.[1]?.toLowerCase()
      if(email){
        const {stdout}=await run('git',['-C',path,'log','-50','--since=30.days','--format=%ae|%ct'],{timeout:500,maxBuffer:8192})
        for(const line of stdout.trim().split('\n')){
          const at=line.lastIndexOf('|'),seconds=Number(line.slice(at+1))
          if(at>0&&line.slice(0,at).toLowerCase()===email&&Number.isFinite(seconds)&&seconds>0)
            {lastGitCommitMs=Math.max(lastGitCommitMs??0,seconds*1000);ownCommits++}
        }
      }
    }catch{/* A missing or unavailable Git history is only an absent ranking clue. */}
  }
  return {lastGitCommitMs,ownCommits,mtimeMs:stat?.mtimeMs??0}
}

export type RootActivity=Awaited<ReturnType<typeof rootActivity>>
/** Cheap metadata that changes whenever a commit, checkout, or identity change could alter the Git clues. */
export async function activityKey(path:string):Promise<string>{
  const stamp=async(target:string)=>{const info=await lstat(target).catch(()=>null);return info?`${info.mtimeMs}:${info.size}`:'-'}
  const git=join(path,'.git')
  // A linked worktree or submodule keeps a `gitdir:` pointer file; its HEAD and reflog live there.
  const pointer=/^gitdir: (.+)$/mu.exec(await readFile(git,'utf8').catch(()=>''))?.[1]?.trim()
  const dir=pointer?resolve(path,pointer):git
  const shared=(await readFile(join(dir,'commondir'),'utf8').catch(()=>'')).trim()
  const common=shared?resolve(dir,shared):dir
  // The effective author identity also comes from global config and the environment.
  const config=process.env.XDG_CONFIG_HOME?.trim() ? process.env.XDG_CONFIG_HOME : join(homedir(),'.config')
  const identity=['GIT_AUTHOR_EMAIL','GIT_AUTHOR_NAME','EMAIL','GIT_CONFIG_GLOBAL'].map(name=>process.env[name]??'').join(',')
  const stamps=await Promise.all([path,git,dir,join(dir,'HEAD'),join(dir,'logs','HEAD'),join(common,'config'),join(dir,'config.worktree'),process.env.GIT_CONFIG_GLOBAL?.trim() ? process.env.GIT_CONFIG_GLOBAL : join(homedir(),'.gitconfig'),join(config,'git','config')].map(stamp))
  return [...stamps,createHash('sha256').update(identity).digest('hex').slice(0,16)].join('|')
}

const activitySchema=z.object({lastGitCommitMs:z.number().nullable(),ownCommits:z.number().int().nonnegative(),mtimeMs:z.number()})
const cacheSchema=z.object({version:z.literal(1),roots:z.record(z.string().max(4096),z.object({key:z.string().max(512),checked:z.number(),value:activitySchema}))})
type CacheState=z.infer<typeof cacheSchema>

/** Git activity survives restarts: an unchanged repository costs a few lstats, not two Git processes. */
export class GitActivityCache{
  readonly #store:BoundedJsonStore<CacheState>|undefined
  readonly #memory=new Map<string,{key:string;checked:number;value:RootActivity;verified:number}>()
  readonly #probe:(path:string)=>Promise<RootActivity>
  #dirty=false
  constructor(path?:string,probe:(path:string)=>Promise<RootActivity>=rootActivity){
    this.#store=path?new BoundedJsonStore(path,cacheSchema,2*1024*1024):undefined;this.#probe=probe
  }
  async open():Promise<void>{
    const state=await this.#store?.read({version:1,roots:{}}).catch(()=>undefined)
    // A scan may already have probed a root while the file was being read; its result is newer.
    for(const [path,entry] of Object.entries(state?.roots??{}))if(!this.#memory.has(path))this.#memory.set(path,{...entry,verified:0})
  }
  peek(path:string):RootActivity|undefined{return this.#memory.get(path)?.value}
  /** Rechecks metadata at most every `recheckMs`; runs Git only when the key moved or the record is a day old. */
  async get(path:string,recheckMs=300_000):Promise<RootActivity>{
    const now=Date.now(),cached=this.#memory.get(path)
    if(cached&&now-cached.verified<recheckMs)return cached.value
    const key=await activityKey(path)
    if(cached?.key===key&&now-cached.checked<86_400_000){cached.verified=now;return cached.value}
    const value=await this.#probe(path)
    this.#memory.set(path,{key,checked:now,value,verified:now});this.#dirty=true
    return value
  }
  async flush():Promise<void>{
    if(!this.#store||!this.#dirty)return
    this.#dirty=false
    // Newest 256 roots; older entries only cost a Git probe if they return.
    const roots=Object.fromEntries([...this.#memory].sort((a,b)=>b[1].checked-a[1].checked).slice(0,256).map(([path,{key,checked,value}])=>[path,{key,checked,value}]))
    try{await this.#store.write({version:1,roots})}catch{this.#dirty=true}
  }
}

/** Directories a repository ignores (build output, data, dependencies), listed once without descending into them. */
export async function gitIgnoredDirectories(root:string):Promise<Set<string>|null>{
  try{
    const {stdout}=await run('git',['-C',root,'ls-files','--others','--ignored','--exclude-standard','--directory','--no-empty-directory','-z'],{timeout:5000,maxBuffer:512*1024})
    const dirs=new Set<string>()
    for(const entry of stdout.split('\0'))if(entry.endsWith('/')&&dirs.size<5000)dirs.add(join(root,entry.slice(0,-1)))
    return dirs
  }catch{return null/* Without Git the walk falls back to its name exclusions. */}
}
