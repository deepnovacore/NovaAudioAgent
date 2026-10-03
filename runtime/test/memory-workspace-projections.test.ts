import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {DatabaseSync} from 'node:sqlite'
import {MemoryLedgerStore} from '../src/memory-ledger/store.js'
import {EntryRevisionSchema,contentHash} from '../src/memory-substrate/store.js'
import {canonicalJson} from '../src/text/canonical-json.js'
import {normalizeWorkspaceContent,rebuildWorkspaceProjections,projectWorkspaceRevision,consumeWorkspaceProjectionChange} from '../src/memory-substrate/workspace-projections.js'

const logical={logical_workspace_id:'logical:one',display_name:'One',aliases:[],canonical_remote:null,created_at:1,updated_at:2,revision:3}
const instance={instance_id:'instance:one',logical_workspace_id:'logical:one',display_name:'Worktree',path_label:'project',branch:'main',repository_fingerprint:'repo:one',status:'active',first_seen_at:1,last_seen_at:2,revision:3}
const relation={source_logical_id:'logical:one',target_logical_id:'logical:two',relation_type:'depends_on',confidence:0.8,reason:'Shared runtime',evidence_refs:[{source:'user',ref:'conversation:one',observed_at:1}],first_seen_at:1,last_seen_at:2,status:'active',revision:3}
const row=(kind:string,data:Record<string,unknown>)=>EntryRevisionSchema.parse({entry_id:'workspace:'+kind+':'+contentHash(kind==='LogicalWorkspace'?String(data.logical_workspace_id):kind==='WorkspaceInstance'?String(data.instance_id):canonicalJson([data.source_logical_id,data.target_logical_id,data.relation_type])),revision:1,supersedes:null,kind,origin:'inferred',written_by:'merge',evidence_refs:['workspace:e:one'],entity_refs:[],content:data,valid_until:null,op:'add',recorded_at:'2026-09-21T00:00:00Z'})

test('workspace hand edits preserve identity, validate complete schemas, and advance domain revisions',()=>{
 assert.throws(()=>normalizeWorkspaceContent('LogicalWorkspace',{...logical,logical_workspace_id:'other'},logical,true))
 assert.throws(()=>normalizeWorkspaceContent('RelationCard',{...relation,evidence_refs:[]},relation,true))
 assert.throws(()=>normalizeWorkspaceContent('WorkspaceInstance',{...instance,status:'broken'},instance,true))
 const changed=normalizeWorkspaceContent('LogicalWorkspace',{...logical,display_name:'Renamed'},logical,true)
 assert.equal(changed.display_name,'Renamed');assert.equal(changed.revision,4)
 assert.deepEqual(normalizeWorkspaceContent('LogicalWorkspace',logical,logical),logical)
})

test('workspace projections rebuild typed cards and relation evidence and apply a single correction without deleting siblings',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'nova-workspace-projections-'))
 let db!:DatabaseSync
 const graph=new MemoryLedgerStore(join(root,'graph.sqlite'),path=>{db=new DatabaseSync(path);return db})
 try{
  graph.open();const a=row('LogicalWorkspace',logical),b=row('WorkspaceInstance',instance),c=row('RelationCard',relation)
  rebuildWorkspaceProjections(db,[a,b,c])
  assert.equal(consumeWorkspaceProjectionChange(db),true);assert.equal(consumeWorkspaceProjectionChange(db),false)
  assert.equal(graph.listLogicalWorkspaces()[0]?.display_name,'One')
  assert.equal(graph.getWorkspaceInstance(instance.instance_id)?.path_label,'project')
  assert.deepEqual(graph.listRelationEvidence('logical:one','logical:two','depends_on'),relation.evidence_refs)
  const corrected={...a,revision:2,supersedes:1,op:'update' as const,content:{...logical,display_name:'Updated',revision:4}}
  projectWorkspaceRevision(db,corrected,a)
  assert.equal(consumeWorkspaceProjectionChange(db),true)
  projectWorkspaceRevision(db,corrected,a);assert.equal(consumeWorkspaceProjectionChange(db),false,'unchanged projection needs no publication')
  assert.equal(graph.listLogicalWorkspaces()[0]?.display_name,'Updated');assert.equal(graph.listRelations().length,1)
  assert.throws(()=>rebuildWorkspaceProjections(db,[{...corrected,content:{...logical,display_name:''}},b,c]))
  assert.equal(graph.listLogicalWorkspaces()[0]?.display_name,'Updated','invalid replacement preserves existing projections')
  rebuildWorkspaceProjections(db,[a,corrected,b,{...c,revision:2,supersedes:1,op:'tombstone',content:{reason:'deleted'}}])
  assert.equal(graph.listRelations().length,0);assert.equal(graph.listRelationEvidence('logical:one','logical:two','depends_on').length,0)
 }finally{graph.close();await rm(root,{recursive:true,force:true})}
})
