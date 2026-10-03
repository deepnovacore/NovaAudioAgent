import {test} from 'node:test'
import assert from 'node:assert/strict'
import {selectProfileSources} from '../src/personal-agent/profile-sources.js'

const file=(root:string,rel_path:string,priority:number,mtime_ms:number)=>({
  kind:'file' as const,id:rel_path,version:'v1',content:'Current project work',source_id:'s',file_id:rel_path,
  root,rel_path,role:'document' as const,mtime_ms,priority,
})
test('profile selection favors active projects and balances files per project',()=>{
 const selected=selectProfileSources([
  file('/active','notes.md',2,4),file('/active','readme.md',2,3),file('/active','plan.md',2,2),
  file('/git','research.md',1,5),file('/downloads','meeting.txt',0,10),
  file('/active','sample-fixture.md',3,6),
 ])
 assert.deepEqual(selected.map(row=>row.id),['notes.md','readme.md','research.md'])
 assert.equal(selected.every(row=>row.source!==undefined),true)
 assert.deepEqual(selected[0]?.source,{project:'active',document:'notes.md'})
})
