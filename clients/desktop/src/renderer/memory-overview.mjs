const text=(value,limit)=>typeof value==='string'&&value.trim().length>0&&value.length<=limit
/** The host supplies synthesis; the client only checks references and falls back to actual excerpts. */
export function memoryOverview(entries,provided) {
 const active=entries.filter(entry=>entry.status==='active')
 const sourceCount=new Set(active.flatMap(entry=>entry.source_refs??[]).map(source=>`${source.type}:${source.ref}`)).size
 const coverage=`本页 ${active.length} 条记忆 · ${sourceCount} 处来源`
 const byId=new Map(active.map(entry=>[entry.id,entry]))
 const valid=provided&&text(provided.summary,1200)&&Array.isArray(provided.sections)&&provided.sections.length>0&&provided.sections.length<=4&&provided.sections.every(section=>
  section&&text(section.title,80)&&text(section.summary,1200)&&Array.isArray(section.keywords)&&section.keywords.length<=5&&section.keywords.every(word=>text(word,80))&&Array.isArray(section.refs)&&section.refs.length>0&&section.refs.every(ref=>ref&&(typeof ref.version==='string'||typeof ref.version==='number')&&byId.has(ref.entry_id)&&byId.get(ref.entry_id).version===ref.version))
 if(valid)return {summary:provided.summary,coverage,generated:true,groups:provided.sections.map(section=>({...section,entries:[...new Set(section.refs.map(ref=>ref.entry_id))].map(id=>byId.get(id))}))}
 return {summary:active.length?'已记录的资料可在下方逐条查看。':'暂无记忆。',coverage,generated:false,groups:[]}
}
