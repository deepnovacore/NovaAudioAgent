// Assistant replies arrive as untrusted Markdown text. This renderer builds DOM
// nodes directly (never innerHTML) so the workbench CSP (`script-src 'self'`,
// `img-src 'none'`) stays meaningful: no element can carry a script, images are
// echoed as their literal source text, and links are buttons that hand the URL
// to the host's validated opener instead of navigating the webContents.
const LINK_PROTOCOLS=['http:','https:']
export function safeLinkUrl(value){try{const url=new URL(value);return LINK_PROTOCOLS.includes(url.protocol)?url.href:null}catch{return null}}

// Single left-to-right pass. Every delimiter is resolved by scanning forward
// once from the current position; an unmatched opener is emitted as literal
// text and the scan resumes after it, so adversarial runs of `[`, `*` or
// backticks stay linear instead of rescanning the suffix per character.
const WORD=/[\p{L}\p{N}_]/u
function inline(text,ctx,depth=0){
 const {document,openLink,el}=ctx,nodes=[];let buffer='',i=0,emScan=-1
 // Cache forward searches, including misses, across malformed link openers.
 const linkEnds=new Map()
 const findLinkEnd=(token,start)=>{let end=linkEnds.get(token);if(end===undefined||(end!==-1&&end<start)){end=text.indexOf(token,start);linkEnds.set(token,end)}return end}
 const flushText=()=>{if(buffer){nodes.push(document.createTextNode(buffer));buffer=''}}
 const push=node=>{flushText();nodes.push(node)}
 while(i<text.length){
  const ch=text[i]
  if(ch==='`'){
   let run=i;while(run<text.length&&text[run]==='`')run++
   const fence='`'.repeat(run-i),close=text.indexOf(fence,run)
   if(close===-1){buffer+=fence;i=run;continue}
   const code=text.slice(run,close);push(el('code',code.trim()||code));i=close+fence.length;continue
  }
  if(ch==='*'&&depth<4){
   const strong=text.startsWith('**',i)
   if(strong){const close=text.indexOf('**',i+2);if(close>i+2){push(el('strong',undefined,inline(text.slice(i+2,close),ctx,depth+1)));i=close+2;continue}buffer+='**';i+=2;continue}
   const prev=text[i-1]??'',next=text[i+1]??''
   if(!WORD.test(prev)&&next&&!/\s/.test(next)&&next!=='*'){
    // Each '*' is inspected as a closer at most once per pass: the scan resumes from the last rejected position.
    let close=Math.max(text.indexOf('*',i+1),emScan)
    while(close!==-1&&close<text.length&&text[close]==='*'&&(text[close+1]==='*'||/\s/.test(text[close-1])||WORD.test(text[close+1]??'')))close=text.indexOf('*',close+1)
    if(close!==-1&&text[close]==='*'){push(el('em',undefined,inline(text.slice(i+1,close),ctx,depth+1)));i=close+1;continue}
    emScan=text.length
   }
   buffer+=ch;i++;continue
  }
  if(ch==='['||(ch==='!'&&text[i+1]==='[')){
   const open=ch==='!'?i+1:i,closeBracket=findLinkEnd(']',open+1)
   if(closeBracket!==-1&&text[closeBracket+1]==='('&&(findLinkEnd('[',open+1)===-1||findLinkEnd('[',open+1)>closeBracket)){
    const closeParen=findLinkEnd(')',closeBracket+2)
    if(closeParen!==-1&&!/\s/.test(text.slice(closeBracket+2,closeParen))){
     const raw=text.slice(i,closeParen+1),label=text.slice(open+1,closeBracket),target=text.slice(closeBracket+2,closeParen)
     if(ch==='!'){buffer+=raw;i=closeParen+1;continue} // image syntax stays literal text
     const url=safeLinkUrl(target)
     if(!url||!openLink){buffer+=url?label:raw;i=closeParen+1;continue}
     const link=el('button',label);link.type='button';link.className='md-link';link.title=url;link.dataset.url=url
     link.addEventListener('click',()=>{void Promise.resolve(openLink(url)).catch(()=>{})})
     push(link);i=closeParen+1;continue
    }
   }
   buffer+=ch;i++;continue
  }
  buffer+=ch;i++
 }
 flushText();return nodes
}

const FENCE=/^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/,HEADING=/^(#{1,6})\s+(.+?)\s*#*\s*$/,LIST=/^(\s*)([-*+]|\d+[.)])\s+(.*)$/,QUOTE=/^\s*>\s?(.*)$/
/** Blocks: fenced code, headings, bullet/ordered lists (one nested level), quotes, paragraphs. Unknown syntax is kept as text. */
export function renderMarkdown(text,{document=globalThis.document,openLink}={}){
 const el=(tag,content,children)=>{const node=document.createElement(tag);if(content!==undefined)node.textContent=String(content);if(children)node.append(...children);return node}
 const ctx={document,openLink,el},root=el('div');root.className='md'
 const lines=String(text??'').replace(/\r\n?/g,'\n').split('\n')
 let paragraph=[]
 const flush=()=>{if(paragraph.length){root.append(el('p',undefined,inline(paragraph.join('\n'),ctx)));paragraph=[]}}
 for(let i=0;i<lines.length;i++){
  const line=lines[i],fence=line.match(FENCE)
  if(fence){
   flush();const close=new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`),body=[];let j=i+1
   while(j<lines.length&&!close.test(lines[j]))body.push(lines[j++])
   const code=el('code',body.join('\n'));if(fence[2])code.dataset.lang=fence[2]
   root.append(el('pre',undefined,[code]));i=j;continue
  }
  const heading=line.match(HEADING)
  if(heading){flush();root.append(el(`h${Math.min(heading[1].length,6)}`,undefined,inline(heading[2],ctx)));continue}
  const list=line.match(LIST)
  if(list){
   flush();const ordered=/\d/.test(list[2]),outer=el(ordered?'ol':'ul');let item=null,inner=null
   while(i<lines.length){
    const m=lines[i].match(LIST);if(!m)break
    const nested=m[1].length>=2&&item
    if(nested){if(!inner){inner=el(/\d/.test(m[2])?'ol':'ul');item.append(inner)}inner.append(el('li',undefined,inline(m[3],ctx)))}
    else{if(/\d/.test(m[2])!==ordered&&item)break;inner=null;item=el('li',undefined,inline(m[3],ctx));outer.append(item)}
    i++
   }
   i--;root.append(outer);continue
  }
  const quote=line.match(QUOTE)
  if(quote){flush();const body=[quote[1]];while(i+1<lines.length&&QUOTE.test(lines[i+1]))body.push(lines[++i].match(QUOTE)[1]);root.append(el('blockquote',undefined,[el('p',undefined,inline(body.join('\n'),ctx))]));continue}
  if(!line.trim()){flush();continue}
  paragraph.push(line)
 }
 flush();return root
}
