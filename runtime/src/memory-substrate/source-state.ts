import {createHash} from 'node:crypto'
import {z} from 'zod'
import type {LedgerDatabase} from '../memory-ledger/store.js'

export const sourceIdSchema=z.string().min(1).max(256)
export const revisionSchema=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const fenceSchema=z.object({connection_id:sourceIdSchema,generation:revisionSchema,epoch:revisionSchema,scope_revision:revisionSchema}).strict()
export type Fence=z.infer<typeof fenceSchema>
export const processingGrantSchema=z.object({revision:revisionSchema,scope_revision:revisionSchema,extraction_provider:sourceIdSchema.nullable(),embedding_provider:sourceIdSchema.nullable(),conversation_providers:z.array(sourceIdSchema).max(8).optional()}).strict()
export type ProcessingGrant=z.infer<typeof processingGrantSchema>
export function readProcessingGrant(db:LedgerDatabase,sourceId:string):ProcessingGrant|null{
 const row=db.prepare('SELECT payload_json FROM source_grants WHERE source_id=?').get(sourceId)
 return row?processingGrantSchema.parse(JSON.parse(String(row.payload_json))):null
}
export function allowsProcessing(db:LedgerDatabase,sourceId:string,purpose:'extraction'|'embedding'|'conversation',provider:string):boolean{
 const permitted=(grant:ProcessingGrant|null)=>purpose==='conversation'?(grant?.conversation_providers??[]).includes(provider):grant?.[purpose==='extraction'?'extraction_provider':'embedding_provider']===provider
 const grant=readProcessingGrant(db,sourceId);if(!grant||!permitted(grant))return false
 const object=sourceObjectFor(db,sourceId)
 if(!object)return true
 const c=readConnection(db,object.connection_id),connectionGrant=readProcessingGrant(db,object.connection_id)
 if(connectionGrant&&(connectionGrant.revision!==grant.revision||connectionGrant.scope_revision!==grant.scope_revision||!permitted(connectionGrant)))return false
 return c!==null&&c.state==='connected'&&c.fence.scope_revision===grant.scope_revision&&c.fence.generation===object.generation
}
export const activationSchema=z.object({object_key:sourceIdSchema,revision:revisionSchema}).strict()
export type Activation=z.infer<typeof activationSchema>
export const extractionTicketSchema=z.object({evidence_id:z.string().min(1).max(512),activation:activationSchema.nullable(),consent_revision:revisionSchema,extraction_provider:sourceIdSchema,fence:fenceSchema.nullable()}).strict()
export type ExtractionTicket=z.infer<typeof extractionTicketSchema>
export interface SourceChange {revision:number;phase:'invalidated'|'ready'}
const boundedJson=z.json().refine(v=>Buffer.byteLength(JSON.stringify(v))<=65536,'source state too large')
export const syncStatusSchema=z.object({attempt_at:z.number(),complete_at:z.number().nullable(),error:z.string().max(64).nullable(),failures:z.number().int().nonnegative(),retry_at:z.number()}).strict()
export const connectionSchema=z.object({fence:fenceSchema,namespace:sourceIdSchema,state:z.enum(['connected','paused','disconnected']),scope:boundedJson,checkpoint:boundedJson,continuation:boundedJson,pending_ids:z.array(sourceIdSchema).max(200),batch:revisionSchema,completed_batch:revisionSchema,deleting:z.array(revisionSchema).max(100),sync_status:syncStatusSchema.optional()}).strict()
export type SourceConnection=z.infer<typeof connectionSchema>
export const sourceObjectSchema=z.object({connection_id:sourceIdSchema,generation:revisionSchema,object_key:sourceIdSchema,source_id:sourceIdSchema,semantic_hash:sourceIdSchema,metadata:z.record(z.string(),z.json()),current_evidence_ids:z.array(z.string().min(1).max(512)).max(256),activation_revision:revisionSchema,status:z.enum(['current','coverage_removed','provider_deleted']),observed_at:z.iso.datetime({offset:true})}).strict()
export type SourceObject=z.infer<typeof sourceObjectSchema>
export function readConnection(db:LedgerDatabase,id:string):SourceConnection|null{
 const row=db.prepare('SELECT payload_json FROM source_connections WHERE id=?').get(id)
 return row?connectionSchema.parse(JSON.parse(String(row.payload_json))):null
}
export function sourceObjectFor(db:LedgerDatabase,sourceId:string):SourceObject|null{
 const row=db.prepare("SELECT payload_json FROM source_objects WHERE json_extract(payload_json,'$.source_id')=?").get(sourceId)
 return row?sourceObjectSchema.parse(JSON.parse(String(row.payload_json))):null
}
export function isCurrentEvidence(db:LedgerDatabase,evidenceId:string,sourceId:string):boolean{
 const object=sourceObjectFor(db,sourceId);if(!object)return true
 const connection=readConnection(db,object.connection_id)
 return connection!==null&&connection.fence.generation===object.generation&&object.status==='current'&&object.current_evidence_ids.includes(evidenceId)
}
export const sha256=(text:string):string=>createHash('sha256').update(text).digest('hex')
export function connectorSourceId(namespace:string,generation:number,objectKey:string):string{
 sourceIdSchema.parse(namespace);revisionSchema.parse(generation);z.string().min(1).max(16384).parse(objectKey)
 const personal=/^personal:[a-f0-9]{64}:/u.exec(namespace)?.[0]??''
 return `${personal}connector:${sha256(namespace)}:${generation}:${sha256(objectKey)}`
}

/** Called by the graph schema migration; also supports isolated in-memory memory tests. */
export function initializeSourceState(db:LedgerDatabase):void{
 db.exec(`
 CREATE TABLE IF NOT EXISTS source_connections(id TEXT PRIMARY KEY,payload_json TEXT NOT NULL) STRICT;
 CREATE TABLE IF NOT EXISTS source_objects(connection_id TEXT NOT NULL,generation INTEGER NOT NULL,object_key TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(connection_id,generation,object_key)) STRICT;
 CREATE TABLE IF NOT EXISTS source_pages(connection_id TEXT NOT NULL,batch_id TEXT NOT NULL,page_id TEXT NOT NULL,payload_hash TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(connection_id,batch_id,page_id)) STRICT;
 CREATE TABLE IF NOT EXISTS source_grants(source_id TEXT PRIMARY KEY,payload_json TEXT NOT NULL) STRICT;
 CREATE TABLE IF NOT EXISTS source_extractions(ticket_key TEXT PRIMARY KEY,payload_json TEXT NOT NULL) STRICT;
 CREATE TABLE IF NOT EXISTS source_clock(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL) STRICT;
 INSERT OR IGNORE INTO source_clock VALUES(1,0);
 CREATE INDEX IF NOT EXISTS source_objects_source ON source_objects(json_extract(payload_json,'$.source_id'));
 `)
}

export function assertSourceStateSchema(db:LedgerDatabase):void{
 const shapes:Record<string,string[]>={source_connections:['id','payload_json'],source_objects:['connection_id','generation','object_key','payload_json'],source_pages:['connection_id','batch_id','page_id','payload_hash','result_json'],source_grants:['source_id','payload_json'],source_extractions:['ticket_key','payload_json'],source_clock:['id','revision']}
 for(const [table,columns] of Object.entries(shapes)){
  const actual=db.prepare(`PRAGMA table_info(${table})`).all()
  const keys=table==='source_objects'||table==='source_pages'?3:1
  if(actual.length!==columns.length||actual.some((c,i)=>c.name!==columns[i]||c.type!==(c.name==='generation'||table==='source_clock'?'INTEGER':'TEXT')||Number(c.pk)!==(i<keys?i+1:0)||Number(c.notnull)!==(table==='source_clock'&&i===0?0:1)))throw Error('STORE_SCHEMA_UNSUPPORTED')
  if(db.prepare('SELECT strict FROM pragma_table_list WHERE name=?').get(table)?.strict!==1)throw Error('STORE_SCHEMA_UNSUPPORTED')
 }
}

/** A manual correction inherits only the intersection of still-authorized source destinations. */
export function correctionProcessingGrant(db:LedgerDatabase,sourceIds:readonly string[]):ProcessingGrant|null {
 if(!sourceIds.length)return null
 const sources=[...new Set(sourceIds)],grants=sources.map(source=>readProcessingGrant(db,source))
 if(grants.some(grant=>grant===null))return null
 const first=grants[0]!
 const authorized=(purpose:'extraction'|'embedding'|'conversation',provider:string|null)=>provider!==null&&sources.every(source=>allowsProcessing(db,source,purpose,provider))
 const extraction=authorized('extraction',first.extraction_provider)?first.extraction_provider:null
 const embedding=authorized('embedding',first.embedding_provider)?first.embedding_provider:null
 const conversations=(first.conversation_providers??[]).filter(provider=>authorized('conversation',provider))
 if(extraction===null&&embedding===null&&!conversations.length)return null
 return {revision:1,scope_revision:0,extraction_provider:extraction,embedding_provider:embedding,conversation_providers:conversations}
}
