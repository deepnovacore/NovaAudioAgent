import type {z} from 'zod'
import {CandidateSchema,type Candidate,type EntryRevision} from './store.js'

type AutomaticCandidateInput=Omit<z.input<typeof CandidateSchema>,'expected_revision'|'written_by'>

/**
 * Bind an automatic proposal to a host-owned target snapshot, taken before model work.
 * This prepares the existing merge contract; it neither grants consent nor writes data.
 * Producers must refresh and recompute after a conflict, never rebase a stale proposal.
 */
export function prepareAutomaticCandidate(input:AutomaticCandidateInput,current:EntryRevision|null):Candidate{
 if('written_by' in input||'expected_revision' in input)throw Error('STORE_AUTOMATIC_AUTHORITY')
 // Tombstones still have an observed version. Merge owns whether new evidence may
 // revive a system-retired entry or must leave a user's forgotten entry untouched.
 if(current&&(current.entry_id!==input.entry_id||current.kind!==input.kind))throw Error('STORE_INVALID_TARGET')
 return CandidateSchema.parse({...input,written_by:'merge',expected_revision:current?.revision??0})
}
