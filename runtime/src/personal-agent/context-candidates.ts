import {createHash} from 'node:crypto'
import {basename,extname} from 'node:path'
import {interleave} from './sampling.js'
import type {ProjectDigest} from './project-digests.js'

interface Ref {entry_id:string;version:string|number}
export type ContextInput=
 | {kind:'file';id:string;version:string;content:string;source_id:string;file_id:string;root:string;rel_path:string;role:'document'|'code'|'config'|'cache';mtime_ms:number;priority:number;hidden_prefix_depth?:number;last_commit_ms?:number|null;own_commits?:number}
 | {kind:'memory';id:string;version:string|number;content:string;origin:'stated'|'inferred'}
/** `sources` lists every entry the candidate's text was derived from, including uncited digest inputs. */
export interface ContextCandidate {sources?:readonly string[];candidate_id:string;id:string;version:string;content:string;tab:'todos'|'ideas'|'goals';primaryFileId:string|null;refs:Ref[];excerpt:string;reason_code:'document_action'|'document_idea'|'stated_idea'|'project_focus'|'project_direction';root:string;priority:number;mtime_ms:number}

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const candidateId=(tab:string,primaryId:string,fingerprint:string)=>hash([tab,primaryId,fingerprint])
const excludedParts=new Set(['node_modules','vendor','dist','build','target','coverage','out','tmp','temp','.git','.claude','.codex','.agents','test-results','playwright-report'])
const excludedNames=/^(?:AGENTS|CLAUDE|SKILL|PROMPT|CONTRIBUTING|CHANGELOG|LICENSE|CODE_OF_CONDUCT)(?:\.[^/]*)?$/iu
const generatedNames=/(?:generated|template|fixture|sample|example|snapshot|report[-_]?\d|lockfile)/iu
/** Whether a file may feed a project digest; a card derived from a digest re-checks its sources with the same rule. */
export function digestEligible(entry:ContextInput):boolean {return entry.kind==='file'&&entry.priority>=1&&!!entry.content.trim()&&eligibleDocument(entry.rel_path,entry.role,entry.hidden_prefix_depth)}
export function eligibleDocument(path:string,role:string,hiddenPrefixDepth=0):boolean {
 if(role!=='document')return false
 const parts=path.split(/[\\/]/u)
 if(parts.some((part,index)=>excludedParts.has(part.toLowerCase())||(part.startsWith('.')&&index>=hiddenPrefixDepth)))return false
 if(excludedNames.test(basename(path))||generatedNames.test(basename(path)))return false
 return new Set(['.md','.markdown','.txt','.pdf','.docx']).has(extname(path).toLowerCase())
}
const ACTION_LINE=/^\s*(?:[-*]\s*)?(?:next step|todo|待办|下一步|下一步行动|行动项)\s*[:：-]\s*\S/imu
const IDEA_EVIDENCE=/\b(?:proposal|idea)\b|想法|提议|建议|可以考虑|计划|替代|改进方向|设计方案/iu
const actionLine=(text:string)=>ACTION_LINE.test(text)
const ideaEvidence=(text:string)=>IDEA_EVIDENCE.test(text)
const genericOverview=(path:string)=>/^readme(?:[._-][a-z]+)?\.(?:md|markdown|txt)$/iu.test(basename(path))

const GOAL_PROJECTS=3
/** Enough for the paragraph a keyword matched; the whole candidate set goes into one prompt, so longer excerpts mostly add latency. */
const EXCERPT_CHARS=400
/** The model must see the line that admitted the candidate: past the prefix, keep the first line and a window around the evidence line. */
function excerptFor(text:string,tab:'todos'|'ideas'):string{
 const prefix=text.slice(0,EXCERPT_CHARS),match=(tab==='todos'?ACTION_LINE:IDEA_EVIDENCE).exec(text)
 if(!match)return prefix
 const at=match.index+match[0].length-1,lineStart=text.lastIndexOf('\n',at)+1,next=text.indexOf('\n',at),lineEnd=next<0?text.length:next
 // The whole line fits in the prefix, or it is longer than any window and its evidence already shows there.
 if(lineEnd<=EXCERPT_CHARS||lineEnd-lineStart>=EXCERPT_CHARS&&at<EXCERPT_CHARS)return prefix
 const newline=text.indexOf('\n'),title=newline>0?text.slice(0,Math.min(newline,80))+'\n…\n':'…\n',budget=EXCERPT_CHARS-title.length
 // End on the evidence line when it fits, else start at it; begin on a line boundary when one is in reach.
 let from=lineEnd-lineStart>budget?lineStart:Math.max(0,lineEnd-budget)
 const boundary=text.indexOf('\n',from)
 if(from<lineStart&&boundary>=from&&boundary<lineStart)from=boundary+1
 return title+text.slice(from,from+budget)
}
/**
 * One todo candidate per own project with a stated focus or next step; the digest already read the project's documents.
 * The most active own projects also offer one long-term direction as a goal candidate; it is only a suggestion until the user adopts it.
 */
function digestCandidates(digests:readonly ProjectDigest[]):ContextCandidate[]{
 const own=digests.filter(d=>d.role==='own')
 const project=(d:ProjectDigest,tab:'todos'|'goals',lines:string[]):ContextCandidate=>{
  const excerpt=lines.join('\n'),version=hash([excerpt,d.refs]).slice(0,32),candidate_id=candidateId(tab,'project:'+d.project_key,version)
  return {candidate_id,id:candidate_id,version,content:excerpt,tab,primaryFileId:null,refs:d.refs.map(r=>({...r})),sources:[...new Set([...(d.inputs??[]),...d.refs.map(r=>r.entry_id)])],excerpt,reason_code:tab==='todos'?'project_focus':'project_direction',root:'project:'+d.project_key,priority:3,mtime_ms:0}
 }
 const todos=own.filter(d=>d.focus??d.next_step).slice(0,6).map(d=>project(d,'todos',[`项目：${d.name}`,`概况：${d.summary}`,...(d.focus?[`近期：${d.focus}`]:[]),...(d.next_step?[`写明的下一步：${d.next_step}`]:[])]))
 const goals=own.slice(0,GOAL_PROJECTS).map(d=>project(d,'goals',[`项目：${d.name}`,`概况：${d.summary}`,...(d.focus?[`近期：${d.focus}`]:[])]))
 return [...todos,...goals]
}
/** With digests, todos and goal directions come from the user's own projects instead of keyword-matched excerpts; ideas are unchanged. */
export function selectContextCandidates(inputs:readonly ContextInput[],digests?:readonly ProjectDigest[]):ContextCandidate[] {
 const groups=new Map<string,ContextCandidate[]>()
 if(digests)for(const candidate of digestCandidates(digests))groups.set(candidate.root,[...groups.get(candidate.root)??[],candidate])
 const sorted=[...inputs].sort((a,b)=>(b.kind==='file'?b.priority:0)-(a.kind==='file'?a.priority:0)||(b.kind==='file'?b.mtime_ms:0)-(a.kind==='file'?a.mtime_ms:0)||a.id.localeCompare(b.id))
 for(const input of sorted){
  if(!input.content.trim())continue
  if(input.kind==='memory'&&input.origin!=='stated')continue
  if(input.kind==='file'&&!eligibleDocument(input.rel_path,input.role,input.hidden_prefix_depth))continue
  const root=input.kind==='file'?input.root:'stated-memory'
  const version=String(input.version),primaryId=input.kind==='file'?input.file_id:input.id
  const tabs:('todos'|'ideas')[]=input.kind==='file'?
   [...(!digests&&input.priority>=2&&actionLine(input.content)?['todos' as const]:[]),...(input.priority>=1&&!genericOverview(input.rel_path)&&ideaEvidence(input.content)?['ideas' as const]:[])]:['ideas']
  if(input.kind==='memory'&&!/\bidea\b|想法|可以考虑|建议/u.test(input.content))continue
  for(const tab of tabs){
   const candidate_id=candidateId(tab,primaryId,version)
   const item:ContextCandidate={candidate_id,id:candidate_id,version,content:excerptFor(input.content,tab),tab,primaryFileId:input.kind==='file'?input.file_id:null,refs:[{entry_id:input.id,version:input.version}],excerpt:excerptFor(input.content,tab),reason_code:input.kind==='memory'?'stated_idea':tab==='todos'?'document_action':'document_idea',root,priority:input.kind==='file'?input.priority:2,mtime_ms:input.kind==='file'?input.mtime_ms:0}
   const group=groups.get(root)??[]
   if(group.filter(c=>c.tab===tab).length>=2)continue
   group.push(item);groups.set(root,group)
  }
 }
 // Goal candidates sit behind each project's todo, so a plain interleave would always drop them first; they keep their few slots.
 const goals=[...groups.values()].flat().filter(c=>c.tab==='goals')
 return [...interleave([...groups.values()].map(group=>group.filter(c=>c.tab!=='goals')),12-goals.length),...goals]
}
