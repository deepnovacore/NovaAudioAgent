import test from 'node:test'
import assert from 'node:assert/strict'
import {bm25} from '../src/memory-substrate/retrieval.js'
import {validateResolution} from '../src/memory-substrate/resolution.js'
import {EntryRevisionSchema} from '../src/memory-substrate/store.js'

const old=EntryRevisionSchema.parse({entry_id:'personal:me:spicy',revision:3,supersedes:2,op:'update',kind:'preference',origin:'stated',written_by:'user_correction',evidence_refs:['e:correction'],entity_refs:[],content:{text:'不吃辣'},valid_until:null,recorded_at:'2026-09-21T00:00:00Z'})
test('resolution rejects missing, repeated, cross-kind and authority-bearing model decisions',()=>{
 const decision={candidate_index:0,action:'update',target_id:old.entry_id}
 for(const decisions of [[],[decision,decision],[{...decision,target_id:'invented'}],[{...decision,revision:4}],[{...decision,action:'add'}],[{...decision,candidate_index:1}]])assert.throws(()=>validateResolution({decisions},[{kind:'preference'}],[old]))
 assert.throws(()=>validateResolution({decisions:[decision]},[{kind:'commitment'}],[old]))
 assert.throws(()=>validateResolution({decisions:[decision,{...decision,candidate_index:1,action:'no_change'}]},[{kind:'preference'},{kind:'preference'}],[old]))
 assert.deepEqual(validateResolution({decisions:[{...decision,action:'no_change'}]},[{kind:'preference'}],[old]),[{candidate_index:0,action:'no_change',target_id:'personal:me:spicy'}])
})

test('BM25 rewards focused and rare terms, normalizes Unicode and avoids substring-only matches',()=>{
 const lengthScores=bm25('spicy',['spicy '+Array(100).fill('other').join(' '),'spicy'])
 assert.ok(lengthScores[1]!>lengthScores[0]!)
 const rarityScores=bm25('coffee tea',['coffee','tea','tea','tea'])
 assert.ok(rarityScores[0]!>rarityScores[1]!)
 assert.ok(bm25('ＣＯＦＦＥＥ',['coffee'])[0]!>0)
 assert.deepEqual(bm25('report',['reporter']),[0])
 const chineseScores=bm25('不吃辣 饮食',['饮食偏好 不吃辣','每天跑步'])
 assert.ok(chineseScores[0]!>0);assert.equal(chineseScores[1],0)
})
