import {test} from 'node:test'
import assert from 'node:assert/strict'
import {renderMarkdown,safeLinkUrl} from '../src/renderer/markdown.mjs'
class Node{constructor(tag,text){this.tag=tag;this.children=[];this.listeners={};this.dataset={};this.className='';if(text!==undefined)this.textContent=text}append(...c){this.children.push(...c)}addEventListener(k,v){this.listeners[k]=v}
 get innerHTML(){throw new Error('innerHTML read')}set innerHTML(_){throw new Error('innerHTML write')}
 get text(){return this.children.length?this.children.map(c=>c.text).join(''):(this.textContent??'')}}
const dom={createElement:tag=>new Node(tag),createTextNode:text=>new Node('#text',text)}
const all=node=>[node,...node.children.flatMap(all)]
const render=(text,openLink)=>renderMarkdown(text,{document:dom,openLink})
test('headings, lists, code blocks and inline marks become structured nodes',()=>{
 const root=render('# 本周待办\n\n- 修复 `login`\n- 回复 **设计** 评审\n  - 子项\n\n1. one\n2. two\n\n```js\nconst a=1\n```\n\n> 引用\n\n收尾段落')
 assert.deepEqual(root.children.map(c=>c.tag),['h1','ul','ol','pre','blockquote','p'])
 const ul=root.children[1];assert.equal(ul.children.length,2);assert.equal(ul.children[0].children[1].tag,'code');assert.equal(ul.children[0].children[1].textContent,'login')
 assert.equal(ul.children[1].children[1].tag,'strong');assert.equal(ul.children[1].children.at(-1).tag,'ul');assert.equal(ul.children[1].children.at(-1).children[0].text,'子项')
 const code=root.children[3].children[0];assert.equal(code.tag,'code');assert.equal(code.dataset.lang,'js');assert.equal(code.textContent,'const a=1')
 assert.equal(root.children[4].children[0].text,'引用');assert.equal(root.children[5].text,'收尾段落')
})
test('paragraph line breaks survive and unknown syntax stays literal text',()=>{
 const root=render('第一行\n第二行 ~~不支持~~ | 表格 |\n\n<b>tag</b>')
 assert.equal(root.children[0].text,'第一行\n第二行 ~~不支持~~ | 表格 |');assert.equal(root.children[1].text,'<b>tag</b>')
 assert.ok(all(root).every(n=>n.tag!=='b'&&n.tag!=='img'&&n.tag!=='a'))
})
test('links are buttons routed through the opener and only for web urls',async()=>{
 const opened=[];const root=render('看 [文档](https://example.com/a?b=1) 与 [本地](file:///etc/passwd) 与 [脚本](javascript:alert(1))',url=>{opened.push(url)})
 const buttons=all(root).filter(n=>n.tag==='button');assert.equal(buttons.length,1)
 assert.equal(buttons[0].className,'md-link');assert.equal(buttons[0].textContent,'文档');assert.equal(buttons[0].dataset.url,'https://example.com/a?b=1')
 await buttons[0].listeners.click();assert.deepEqual(opened,['https://example.com/a?b=1'])
 const p=root.children[0];assert.equal(p.text,'看 文档 与 [本地](file:///etc/passwd) 与 [脚本](javascript:alert(1))')
 assert.equal(all(render('[x](https://e.com)')).filter(n=>n.tag==='button').length,0,'no opener means no link controls')
 assert.equal(safeLinkUrl('HTTP://E.com/x'),'http://e.com/x');assert.equal(safeLinkUrl('data:text/html,1'),null)
})
test('image syntax is echoed as text and never creates an img',()=>{
 const root=render('前 ![截图](https://x/y.png) 后')
 assert.equal(root.children[0].text,'前 ![截图](https://x/y.png) 后');assert.ok(all(root).every(n=>n.tag!=='img'))
})
test('unclosed fences, empty input and CRLF are bounded',()=>{
 assert.equal(render('').children.length,0)
 const root=render('```\r\nabc\r\ndef');assert.equal(root.children[0].tag,'pre');assert.equal(root.children[0].children[0].textContent,'abc\ndef');assert.equal(root.children[0].children[0].dataset.lang,undefined)
 const italic=render('a * b * c and *强调* and 2*3*4');assert.equal(all(italic).filter(n=>n.tag==='em').length,1)
})
test('adversarial delimiter runs parse in linear time and unmatched openers never drop characters',()=>{
 for(const ch of ['[','*','x`','![','**','](','[a](']){
  const text=ch.repeat(20000),t0=performance.now(),root=render(text);const spent=performance.now()-t0
  assert.ok(spent<200,`${JSON.stringify(ch)} took ${spent.toFixed(0)}ms`)
  if(ch!=='x`')assert.equal(root.children.map(c=>c.text).join(''),text,`${JSON.stringify(ch)} kept verbatim`)
 }
 assert.equal(all(render('x`'.repeat(200))).filter(n=>n.tag==='code').length,100,'paired backticks still form code spans')
 const fence='`'.repeat(20000),t0=performance.now(),block=render(fence);assert.ok(performance.now()-t0<200);assert.equal(block.children[0].tag,'pre','a bare backtick run is an unclosed fence, kept as one code block')
 const nested='*'.repeat(50)+'x'+'*'.repeat(50);assert.equal(render(nested).children[0].text.replace(/\*/g,'').length,1)
})
test('invalid emphasis closers are scanned once, and valid emphasis still resolves afterwards',()=>{
 const text='x '+'*a '.repeat(16000),t0=performance.now(),root=render(text);const spent=performance.now()-t0
 assert.ok(spent<200,`took ${spent.toFixed(0)}ms`);assert.equal(root.children[0].text,text)
 const mixed=render('*a *b *c* and *ok*');assert.equal(all(mixed).filter(n=>n.tag==='em').length,2)
 assert.equal(render('**unclosed strong').children[0].text,'**unclosed strong')
})

test('large unmatched link delimiters do not repeatedly scan the remaining reply',()=>{
 for(const text of ['['.repeat(320000),'[a]( '.repeat(60000)+')']){
  const start=performance.now(),root=render(text)
  assert.equal(root.children[0].text,text)
  assert.ok(performance.now()-start<500,'malformed link parsing exceeded 500ms')
 }
 assert.equal(all(render('[[bad [ok](https://example.com)',()=>{})).filter(n=>n.tag==='button').length,1)
})
