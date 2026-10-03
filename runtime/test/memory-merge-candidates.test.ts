import test from 'node:test'
import assert from 'node:assert/strict'
import {prepareAutomaticCandidate} from '../src/memory-substrate/candidates.js'
import {merge,type EntryRevision} from '../src/memory-substrate/store.js'

const input={entry_id:'personal:test:spicy',kind:'preference' as const,origin:'inferred' as const,evidence_refs:['evidence:1'],content:{text:'我不吃辣'},recorded_at:'2026-09-21T00:00:00Z'}
const current:EntryRevision={...input,revision:3,supersedes:2,written_by:'merge',entity_refs:[],valid_until:null,op:'update'}

test('automatic preparation uses the observed version and keeps add fenced at zero',()=>{
 const candidate=prepareAutomaticCandidate(input,current)
 assert.equal(candidate.expected_revision,3)
 assert.throws(()=>merge({...current,revision:4},candidate),/STALE_REVISION/)
 const add=prepareAutomaticCandidate(input,null)
 assert.equal(add.expected_revision,0)
 assert.equal(merge(null,add)?.revision,1)
 assert.throws(()=>merge(current,add),/STALE_REVISION/)
})

test('automatic preparation rejects authority overrides and unrelated targets',()=>{
 for(const extra of [{written_by:'user_correction'},{expected_revision:99}]){
  assert.throws(()=>prepareAutomaticCandidate({...input,...extra},current),/AUTOMATIC_AUTHORITY/)
 }
 for(const target of [{...current,entry_id:'other'},{...current,kind:'fact'}]){
  assert.throws(()=>prepareAutomaticCandidate(input,target),/INVALID_TARGET/)
 }
})

test('system tombstones can receive replacement evidence but user forgetting remains authoritative',()=>{
 const retired:EntryRevision={...current,op:'tombstone',content:{reason:'evidence_superseded'}}
 const candidate=prepareAutomaticCandidate({...input,evidence_refs:['evidence:2']},retired)
 assert.equal(merge(retired,candidate)?.revision,4)
 assert.equal(merge({...retired,written_by:'user_correction'},candidate),null)
 assert.equal(merge(retired,candidate,{suppressed:true}),null)
})

test('prepared candidates retain merge correction and stated-fact priority',()=>{
 const next=prepareAutomaticCandidate({...input,content:{text:'新推断'}},current)
 assert.equal(merge({...current,written_by:'user_correction',origin:'stated'},next),null)
 assert.equal(merge({...current,origin:'stated'},next),null)
 assert.equal(merge(current,prepareAutomaticCandidate(input,current)),null)
})
