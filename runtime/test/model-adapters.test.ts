import {GatewayProactivity} from '../src/model/proactivity.js'
import {GatewayPersonalWriter} from '../src/model/personal-writer.js'
import {GatewayTaskVerifier} from '../src/model/task-verifier.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve,join } from 'node:path'
import {mkdtemp,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import { test } from 'node:test'
import { VirtualClock } from '../src/core/clock.js'
import type { ContextView } from '../src/core/context-view.js'
import type { MemoryItem } from '../src/core/memory.js'
import type {
  CompleteRequest,
  GatewayCompletion,
  GatewayDelta,
  ModelGateway,
  StreamRequest,
} from '../src/model/model-gateway.js'
import {
  GatewayCompressor,
  compressorPrompt,
} from '../src/model/model-adapters.js'

const fixtureRoot = resolve(import.meta.dirname, '../../../tests/fixtures/adapters/v1')

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(fixtureRoot, name), 'utf8')) as T
}

void new VirtualClock()

class ScriptedGateway implements ModelGateway {
  readonly requests: StreamRequest[] = []
  readonly completions: CompleteRequest[] = []
  constructor(
    private readonly deltas: readonly GatewayDelta[] = [],
    private readonly text = '',
  ) {}

  async *stream(request: StreamRequest): AsyncIterable<GatewayDelta> {
    this.requests.push(request)
    for (const delta of this.deltas) {
      // Yield across a real turn so the consumer cannot depend on synchronous delivery.
      await Promise.resolve()
      yield delta
    }
  }

  complete(request: CompleteRequest): Promise<GatewayCompletion> {
    this.completions.push(request)
    return Promise.resolve({text: this.text})
  }
}

class QueuedGateway implements ModelGateway {
  readonly completions: CompleteRequest[] = []
  constructor(private readonly replies: string[], private readonly error?: Error) {}
  async *stream(): AsyncIterable<GatewayDelta> { /* unused */ }
  complete(request: CompleteRequest): Promise<GatewayCompletion> {
    this.completions.push(request)
    if (this.error && this.completions.length === 1) return Promise.reject(this.error)
    const text = this.replies.shift()
    if (text === undefined) return Promise.reject(new Error('no queued reply'))
    return Promise.resolve({text})
  }
}

const emptyView: ContextView = {
  channels: [], in_flight: [], affordances: [], floor: 'idle', now: 0, trigger_kind: null,
}

test('the compressor prompt matches the Python oracle byte for byte', () => {
  const fixture = loadJson<{
    readonly schema_version: number
    readonly scenarios: readonly {readonly id: string, readonly covers: string,
      readonly items: readonly MemoryItem[]}[]
  }>('compressor-items.json')
  const golden = loadJson<{
    readonly schema_version: number
    readonly prompts: Readonly<Record<string, string>>
  }>('compressor-items-expected.json')
  assert.equal(fixture.schema_version, golden.schema_version)
  assert.deepEqual(
    fixture.scenarios.map(scenario => scenario.id).sort(),
    Object.keys(golden.prompts).sort(),
  )
  for (const scenario of fixture.scenarios) {
    assert.equal(
      compressorPrompt(scenario.items),
      golden.prompts[scenario.id],
      `${scenario.id}: ${scenario.covers}`,
    )
  }
  // Guard the premise: the scenario must actually exercise both hazards.
  const sorted = golden.prompts['sorted-keys-and-float-ts']!
  // Code-point key order, which JavaScript would otherwise reorder.
  assert.match(sorted, /"10": "ten", "2": "two"/u)
  // An integral float renders without a decimal point on BOTH sides, because the
  // oracle routes this through prompt_json. json.dumps would have written 1.0 here,
  // which no JavaScript number can express.
  assert.match(sorted, /"ts": 1\}/u)
  assert.doesNotMatch(sorted, /"ts": 1\.0/u)
})

test('the Proactive selector rejects output that is not contract-shaped', async () => {
  const good = new GatewayProactivity({
    gateway: new ScriptedGateway([], '{"speak":true,"suggestion_id":"s-1","progress_class":"milestone","reason":"因为"}'),
    model: 'm',
    proactivityPreset: 'balanced',
  })
  assert.deepEqual(await good.select(emptyView),
    {speak: true, suggestion_id: 's-1', progress_class: 'milestone', reason: '因为'})

  for (const text of ['not json', '{}', '{"speak":"yes","suggestion_id":null,"reason":"r"}',
    '{"speak":true,"suggestion_id":7,"progress_class":"milestone","reason":"r"}',
    '{"speak":true,"suggestion_id":null,"progress_class":null}',
    '{"speak":true,"suggestion_id":"s-1","reason":"missing classification"}']) {
    const bad = new GatewayProactivity({
      gateway: new ScriptedGateway([], text),
      model: 'm',
      proactivityPreset: 'balanced',
    })
    await assert.rejects(bad.select(emptyView), TypeError, text)
  }
})

test('the Proactive selector preserves its structured progress decision', async () => {
  const proactive = new GatewayProactivity({
    gateway: new ScriptedGateway(
      [],
      '{"speak":true,"suggestion_id":"s-1","progress_class":"routine_delta","reason":"file count changed"}',
    ),
    model: 'm',
    proactivityPreset: 'eager',
  })

  assert.deepEqual(await proactive.select(emptyView), {
    speak: true,
    suggestion_id: 's-1',
    progress_class: 'routine_delta',
    reason: 'file count changed',
  })
})

test('the Proactive selector receives the selected proactivity policy at its model boundary', async () => {
  const systems = new Map<string, string>()
  for (const preset of ['conservative', 'balanced', 'eager'] as const) {
    const gateway = new ScriptedGateway(
      [],
      '{"speak":false,"suggestion_id":null,"progress_class":null,"reason":"routine"}',
    )
    const proactive = new GatewayProactivity({gateway, model: 'm', proactivityPreset: preset})

    await proactive.select(emptyView)

    const system = gateway.completions[0]?.system
    assert.ok(system !== undefined)
    assert.match(system, new RegExp(`<proactivity_policy preset="${preset}">`, 'u'))
    systems.set(preset, system)
  }

  assert.equal(new Set(systems.values()).size, 3)
  assert.match(systems.get('conservative') ?? '', /action_required.*blocker.*验证证据.*milestone/u)
  assert.match(systems.get('balanced') ?? '', /改变用户对任务状态理解的 milestone/u)
  assert.match(systems.get('eager') ?? '', /首次出现的具体工作方向/u)
  assert.doesNotMatch(systems.get('eager') ?? '', /开始或完成验证/u)

  for (const system of systems.values()) {
    const policy = /<proactivity_policy[^>]*>([\s\S]*?)<\/proactivity_policy>/u.exec(system)?.[1]
    assert.match(policy ?? '', /trusted_user.*静默/u)
  }
  for (const preset of ['balanced', 'eager'] as const) {
    const system = systems.get(preset) ?? ''
    assert.doesNotMatch(system, /常规调查结论、实现细节、计划、计数和中间解释/u)
    assert.doesNotMatch(system, /只有需要用户行动或决定、出现风险或阻塞/u)
  }
})

test('the compressor trims its answer and sends the schema-free request', async () => {
  const gateway = new ScriptedGateway([], '  摘要文本  ')
  const compressor = new GatewayCompressor({gateway, model: 'qwen-flash'})
  assert.equal(await compressor.compress([]), '摘要文本')
  assert.equal(gateway.completions[0]?.jsonSchema, undefined)
  assert.equal(gateway.completions[0]?.prompt, '[]')
})

test('the compressor strips exactly the whitespace Python strips', async () => {
  const compressor = new GatewayCompressor({
    gateway: new ScriptedGateway([], '\u001c\u0085\ufeffsummary\ufeff\u0085\u001c'),
    model: 'qwen-flash',
  })
  assert.equal(await compressor.compress([]), '\ufeffsummary\ufeff')
})

test('discovery uses bounded Proactive gateway without speech or execution', async () => {
  const gateway=new ScriptedGateway([],JSON.stringify({proposal:null}))
  const proactive=new GatewayProactivity({gateway,model:'same-model',proactivityPreset:'balanced'})
  const snapshot={user_scope:'local',local_date:'2026-09-11',weekday:'Friday',timezone:'Asia/Shanghai',memory:[],evidence_refs:[],recent_delivery:[]}
  assert.equal(await proactive.discover(snapshot,new AbortController().signal),null)
  assert.match(gateway.completions[0]!.system,/json/i,'JSON mode requires an explicit JSON instruction even when source text has no JSON keyword')
  const conflicted=new GatewayProactivity({gateway:new ScriptedGateway([],JSON.stringify({speak:true,suggestion_id:'s-1',progress_class:null,reason:'bad',proposal:{kind:'question',summary:'Q',why_now:'Now',evidence_refs:['conversation:1'],memory_refs:[]}})),model:'same-model',proactivityPreset:'balanced'})
  await assert.rejects(conflicted.select(emptyView),/契约/)
})

test('read-only preparation makes one completion and rejects invented or stale snapshot references',async()=>{
 const snapshot={user_scope:'local',local_date:'2026-09-14',weekday:'Monday',timezone:'Asia/Shanghai',memory:[],evidence_refs:['file:allowed'],recent_delivery:[]}
 const proposal={kind:'question' as const,summary:'Review project',why_now:'meeting today',evidence_refs:['file:allowed'],memory_refs:[]}
 const gateway=new ScriptedGateway([],JSON.stringify({text:'A source-grounded outline',evidence_refs:['file:allowed'],memory_refs:[]}))
 const writer=new GatewayPersonalWriter({gateway,model:'same'})
 const prepared=await writer.prepareProposal(snapshot,proposal,new AbortController().signal)
 assert.equal(prepared?.prepared.trust,'untrusted_external')
 assert.equal(prepared?.prepared.text,'A source-grounded outline')
 assert.equal(gateway.completions.length,1)
 assert.equal(Object.hasOwn(gateway.completions[0]!,'tools'),false)
 for(const refs of [{evidence_refs:['file:invented'],memory_refs:[]},{evidence_refs:[],memory_refs:[{entry_id:'missing',version:1}]}]){
  const invalid=new GatewayPersonalWriter({gateway:new ScriptedGateway([],JSON.stringify({text:'Do this',...refs})),model:'same'})
  assert.equal(await invalid.prepareProposal(snapshot,proposal,new AbortController().signal),null)
 }
 const brief=await writer.prepareBrief(snapshot,{kind:'outlook',local_date:'2026-09-14',timezone:'Asia/Shanghai',scheduled_at:'2026-09-14T00:30:00Z',dedupe_key:'brief:test'},new AbortController().signal)
 assert.equal(brief?.action_label,'查看简报')
 assert.equal(gateway.completions.length,2)
})


test('preparation rejects a stale active-memory version and skips an empty snapshot',async()=>{
 const memory={id:'m',version:2,content:'Meeting plan',kind:'plan' as const,origin:'stated' as const,source_refs:[{type:'conversation' as const,ref:'conversation:1',observed_at:'2026-09-14T00:00:00Z'}],observed_at:'2026-09-14T00:00:00Z',recorded_at:'2026-09-14T00:00:00Z',topic:'work',status:'active' as const,corrected_to:null,confidence_note:null}
 const snapshot={user_scope:'local',local_date:'2026-09-14',weekday:'Monday',timezone:'Asia/Shanghai',memory:[memory],evidence_refs:[],recent_delivery:[]}
 const proposal={kind:'question' as const,summary:'Meeting',why_now:'today',evidence_refs:[],memory_refs:[{entry_id:'m',version:2}]}
 const gateway=new ScriptedGateway([],JSON.stringify({text:'Prepared',evidence_refs:[],memory_refs:[{entry_id:'m',version:1}]}))
 const writer=new GatewayPersonalWriter({gateway,model:'same'})
 assert.equal(await writer.prepareProposal(snapshot,proposal,new AbortController().signal),null)
 assert.equal(await writer.prepareProposal({...snapshot,memory:[]},proposal,new AbortController().signal),null)
 assert.equal(gateway.completions.length,1)
})


test('Proactive receives the actual progress trigger, not an unlabelled snapshot', async () => {
  const gateway = new ScriptedGateway([], '{"speak":false,"suggestion_id":null,"progress_class":"routine_delta","reason":"counter only"}')
  const proactive = new GatewayProactivity({gateway, model: 'm', proactivityPreset: 'eager'})
  await proactive.select({...emptyView, trigger_kind: 'progress'})
  assert.match(gateway.completions[0]!.prompt, /当前触发事件：progress/u)
})

test('task verifier sends its actual decision schema through the JSON-object gateway and applies a correction',async()=>{
 const {OpenAIModelGateway}=await import('../src/model/model-gateway.js'),{TaskService}=await import('../src/personal-agent/tasks.js'),{taskDecisionSchema}=await import('../src/personal-agent/task-loop.js'),{z}=await import('zod')
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-verifier-schema-')),tasks=new TaskService(join(dir,'tasks.json'))
 try{
  await tasks.open();const task=await tasks.delegate('declare',{conversation_id:'c',goal:'Three steps',acceptance:['three distinct steps'],origin_ref:'user:1'}),fence={task_id:task.id,control_revision:0,goal_revision:0}
  await tasks.recordDelivery(fence,'first','Step one only');const evidence=tasks.evidence(task.id)
  const decision={kind:'correct' as const,instruction:'Provide all three distinct steps',evidence_refs:[evidence[0]!.ref]};let requests=0,receivedSchema:unknown,receivedFormat:unknown
  const gateway=new OpenAIModelGateway({baseUrl:'https://example.invalid/v1',apiKey:'test',clock:new VirtualClock(),metrics:{record:()=>undefined},fetch:(_url,init)=>{
   assert.ok(typeof init?.body==='string')
   const body=JSON.parse(init.body) as {messages:{role:string;content:string}[];response_format:unknown},prompt=JSON.parse(body.messages.find(message=>message.role==='user')!.content) as {output_schema:unknown}
   requests++;receivedFormat=body.response_format;receivedSchema=prompt.output_schema
   return Promise.resolve(new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(decision)}}]}),{status:200}))
  }})
  const verifier=new GatewayTaskVerifier({gateway,model:'test'}),actual=await verifier.evaluateTask(task,evidence,new AbortController().signal)
  assert.deepEqual(receivedFormat,{type:'json_object'});assert.deepEqual(receivedSchema,z.toJSONSchema(taskDecisionSchema));assert.deepEqual(actual,decision);const corrected=await tasks.applyDecision(fence,actual);assert.equal(corrected.corrections,1);assert.equal(corrected.phase,'queued');assert.equal(requests,1)
 }finally{await tasks.close();await rm(dir,{recursive:true,force:true})}
})

test('task evaluation separates accepted user steering from executor evidence and requests durable reconciliation',async()=>{
 const {TaskService}=await import('../src/personal-agent/tasks.js'),dir=await mkdtemp(join(await realpath(tmpdir()),'task-input-verifier-')),tasks=new TaskService(join(dir,'tasks.json'))
 try{await tasks.open();let task=await tasks.delegate('declare',{conversation_id:'c',goal:'red',acceptance:['red observed'],origin_ref:'user:1'});let fence={task_id:task.id,control_revision:0,goal_revision:0};await tasks.bindWork(fence,'work','session');task=await tasks.controlClient('take',fence,'client','takeover');fence={...fence,control_revision:task.control_revision};await tasks.input('blue',fence,task.controller,'session','Change goal to blue',()=>Promise.resolve('accepted'));task=await tasks.controlClient('return',fence,'client','return')
 const decision={kind:'reconcile',input_refs:['blue'],goal_change:{goal:'blue',acceptance:['blue observed']}},gateway=new ScriptedGateway([],JSON.stringify(decision)),verifier=new GatewayTaskVerifier({gateway,model:'test'})
 const evaluate=verifier.evaluateTask.bind(verifier) as (...args:unknown[])=>Promise<unknown>;assert.deepEqual(await evaluate(task,[],new AbortController().signal,tasks.inputReceipts(task.id)),decision)
 const prompt=JSON.parse(gateway.completions[0]!.prompt) as {accepted_user_inputs:{request_id:string;text:string}[]};assert.deepEqual(prompt.accepted_user_inputs.map(x=>({request_id:x.request_id,text:x.text})),[{request_id:'blue',text:'Change goal to blue'}])
 }finally{await tasks.close();await rm(dir,{recursive:true,force:true})}
})

test('workbench generation includes its schema in the provider-visible prompt',async()=>{
 const gateway=new ScriptedGateway([],JSON.stringify({cards:[]}))
 const writer=new GatewayPersonalWriter({gateway,model:'same'})
 await writer.generateContext([{candidate_id:'c1',id:'c1',version:'v1',content:'A project document',tab:'ideas',primaryFileId:'doc',refs:[{entry_id:'source:doc',version:'v1'}],excerpt:'A project document',reason_code:'document_idea',root:'/project',priority:0,mtime_ms:1}],new AbortController().signal)
 const prompt=JSON.parse(gateway.completions[0]!.prompt) as {output_schema:{properties:{cards:unknown}}}
 assert.ok(prompt.output_schema.properties.cards)
 assert.doesNotMatch(gateway.completions[0]!.prompt,/\/project/u)
 assert.match(gateway.completions[0]!.system,/正文只写一句话/u)
 assert.match(gateway.completions[0]!.system,/每类最多三张/u)
 assert.equal(gateway.completions[0]!.maxTokens,4000,'nine full cards fit under the ceiling')
 const sent=(JSON.parse(gateway.completions[0]!.prompt) as {candidates:Record<string,unknown>[]}).candidates
 assert.deepEqual(sent,[{key:'c1',tab:'ideas',excerpt:'A project document',reason_code:'document_idea'}],'identifiers and refs stay with the adapter')
})
test('context cards cite short keys, and the adapter restores each candidate, its tab and its refs',async()=>{
 const candidate=(id:string,tab:'todos'|'ideas'|'goals',refs:number)=>({candidate_id:id,id,version:'v1',content:'x',tab,primaryFileId:null,refs:Array.from({length:refs},(_,i)=>({entry_id:'source:'+id+String(i),version:'v'+String(i)})),excerpt:'x',reason_code:tab==='todos'?'project_focus' as const:tab==='goals'?'project_direction' as const:'document_idea' as const,root:'project:'+id,priority:3,mtime_ms:0})
 const candidates=[candidate('long-todo-a','todos',6),candidate('long-todo-b','todos',6),candidate('long-idea','ideas',1),candidate('long-goal','goals',2)]
 const card=(key:string,title:string)=>({key,title,body:'B',why:null,next:null})
 const reply={recap:{text:'近况',keys:['c1','c2','c3','c9']},cards:[card('c1','a'),card('c9','forged'),card('c3','idea'),card('c4','goal'),{...card('c2','no refs'),refs:[]},card('c2','b')]}
 const gateway=new ScriptedGateway([],JSON.stringify(reply))
 const result=await new GatewayPersonalWriter({gateway,model:'m'}).generateContext(candidates,new AbortController().signal)
 assert.deepEqual(result.cards.map(item=>[item.candidate_id,item.tab,item.title]),[['long-todo-a','todos','a'],['long-idea','ideas','idea'],['long-goal','goals','goal'],['long-todo-b','todos','b']],'a forged key or an unknown field drops only that card')
 assert.deepEqual(result.cards[2]!.refs,candidates[3]!.refs)
 assert.equal(result.recap,null,'one forged or ungrounded key rejects the whole recap')
 const valid=await new GatewayPersonalWriter({gateway:new ScriptedGateway([],JSON.stringify({...reply,recap:{text:'近况',keys:['c1','c2']}})),model:'m'}).generateContext(candidates,new AbortController().signal)
 assert.deepEqual(valid.recap?.refs.map(ref=>ref.entry_id),['source:long-todo-a0','source:long-todo-b0','source:long-todo-a1','source:long-todo-b1','source:long-todo-a2','source:long-todo-b2','source:long-todo-a3','source:long-todo-b3'],'the recap takes todo refs in turn, at most eight')
 const onlyIdea=await new GatewayPersonalWriter({gateway:new ScriptedGateway([],JSON.stringify({recap:{text:'近况',keys:['c3']},cards:[]})),model:'m'}).generateContext(candidates,new AbortController().signal)
 assert.equal(onlyIdea.recap,null,'a recap citing no todo candidate is withheld')
})
test('recap keys must all resolve and every non-todo ref must have exact todo grounding',async()=>{
 const a={entry_id:'source:a',version:'v1'},b={entry_id:'source:b',version:'v1'},privateRef={entry_id:'memory:private',version:'v1'}
 const candidate=(id:string,tab:'todos'|'ideas'|'goals',refs:typeof a[])=>({candidate_id:id,id,version:'v1',content:'x',tab,primaryFileId:null,refs,excerpt:'x',reason_code:tab==='todos'?'project_focus' as const:tab==='goals'?'project_direction' as const:'stated_idea' as const,root:'project:nova',priority:3,mtime_ms:0})
 const candidates=[candidate('todo','todos',[a,b]),candidate('goal','goals',[a,b]),candidate('partial-goal','goals',[a,privateRef]),candidate('stale-goal','goals',[a,{...b,version:'v2'}]),candidate('idea','ideas',[privateRef]),candidate('empty-goal','goals',[])]
 for(const keys of [['c1','c9'],['c1','c3'],['c1','c4'],['c1','c5'],['c1','c6'],['c5']]){
  const gateway=new ScriptedGateway([],JSON.stringify({recap:{text:'工作台和私人计划。',keys},cards:[]}))
  const result=await new GatewayPersonalWriter({gateway,model:'m'}).generateContext(candidates,new AbortController().signal)
  assert.equal(result.recap,null,`reject the entire recap for ${keys.join(',')}`)
 }
 for(const keys of [['c2'],['c1','c2','c2']]){
  const gateway=new ScriptedGateway([],JSON.stringify({recap:{text:'这周主要在做工作台。',keys},cards:[]}))
  const result=await new GatewayPersonalWriter({gateway,model:'m'}).generateContext(candidates,new AbortController().signal)
  assert.deepEqual(result.recap,{text:'这周主要在做工作台。',refs:[a,b]},'same-project goal refs are fully backed by a todo, with duplicates removed')
 }
})
test('a cut-off context reply retries once with half the candidates, and each tab keeps at most three cards',async()=>{
 const candidate=(id:string)=>({candidate_id:id,id,version:'v1',content:'A project document',tab:'todos' as const,primaryFileId:id,refs:[{entry_id:'source:'+id,version:'v1'}],excerpt:'A project document',reason_code:'document_action' as const,root:'/project',priority:0,mtime_ms:1})
 const card=(key:string)=>({key,title:'T'+key,body:'B',why:null,next:null})
 const replies=['{"recap":null,"cards":[{"key":"c1","title":"cut',JSON.stringify({recap:null,cards:[card('c1'),card('c2'),card('c3'),card('c4'),card('c5')]})]
 const prompts:string[]=[]
 const gateway={complete:(request:CompleteRequest)=>{prompts.push(request.prompt);return Promise.resolve({text:replies.shift()!})}} as unknown as ModelGateway
 const result=await new GatewayPersonalWriter({gateway,model:'m'}).generateContext([...['a','b','c','d'].map(candidate),{...candidate('e'),tab:'ideas' as const}],new AbortController().signal)
 assert.equal(prompts.length,2);assert.equal((JSON.parse(prompts[1]!) as {candidates:unknown[]}).candidates.length,3)
 assert.deepEqual(result.cards.map(item=>item.candidate_id),['a','b','c'],'the retry only knows its own three keys, and each tab keeps at most three')
 const broken={complete:()=>Promise.resolve({text:'{'})} as unknown as ModelGateway
 await assert.rejects(new GatewayPersonalWriter({gateway:broken,model:'m'}).generateContext([candidate('a'),candidate('b')],new AbortController().signal),SyntaxError,'a second failure surfaces for the backoff')
})
test('workbench generation allows no candidates and makes no model call',async()=>{
 const gateway=new ScriptedGateway([],JSON.stringify({cards:[]}))
 const writer=new GatewayPersonalWriter({gateway,model:'same'})
 assert.deepEqual(await writer.generateContext([],new AbortController().signal),{recap:null,cards:[]})
 assert.equal(gateway.completions.length,0)
})
test('a queued digest batch re-checks consent when it leaves the lane, and never sends after revocation',async()=>{
 class HeldGateway extends ScriptedGateway{release!:()=>void
  override complete(request:CompleteRequest):Promise<GatewayCompletion>{this.completions.push(request);if(this.completions.length>1)return Promise.resolve({text:JSON.stringify({digests:[]})});return new Promise(r=>{this.release=()=>r({text:JSON.stringify({cards:[]})})})}}
 const gateway=new HeldGateway(),writer=new GatewayPersonalWriter({gateway,model:'same'})
 const candidate={candidate_id:'c1',id:'c1',version:'v1',content:'x',tab:'ideas' as const,primaryFileId:'doc',refs:[{entry_id:'source:doc',version:'v1'}],excerpt:'x',reason_code:'document_idea' as const,root:'/p',priority:0,mtime_ms:1}
 const foreground=writer.generateContext([candidate],new AbortController().signal)
 let consented=true
 const digest=writer.generateDigests([{project_key:'k',name:'p',signals:{tier:1,own_commits_30d:0,last_own_commit_days:null,last_modified_days:0},documents:[{entry_id:'source:doc',version:'v1',document:'README.md',excerpt:'x'}]}],new AbortController().signal,()=>{if(!consented)throw Error('processing_consent_required')})
 await new Promise(r=>setImmediate(r));assert.equal(gateway.completions.length,1,'the digest waits behind foreground work')
 consented=false;gateway.release();await foreground
 await assert.rejects(digest,/processing_consent_required/u);assert.equal(gateway.completions.length,1,'no digest request was sent')
})


test('coding evaluator cannot complete from prose, truncated checks, or another work/session',async()=>{
 const {TaskService}=await import('../src/personal-agent/tasks.js'),dir=await mkdtemp(join(await realpath(tmpdir()),'task-proof-')),tasks=new TaskService(join(dir,'tasks.json'))
 try{
  await tasks.open();const task=await tasks.delegate('declare',{conversation_id:'c',execution_route:'codex',goal:'Run checks',acceptance:['actual check output'],origin_ref:'user:1'}),fence={task_id:task.id,control_revision:0,goal_revision:0}
  await tasks.bindWork(fence,'work','session')
  await tasks.appendEvent({task_id:task.id,work_id:'work',session_id:'session',thread_id:'thread',turn_id:'turn',item_id:'check',kind:'tool',stage:'completed',text:JSON.stringify({type:'commandExecution',status:'completed',command:'node --test',output:'1 passed',exit_code:0}),refs:[]},'check')
  await tasks.recordWorkOutcome('work','ok',{worker:'codex',final_message:'All tests and UI passed'})
  const current=tasks.get(task.id),valid=tasks.evidence(task.id),decision={kind:'complete',evidence_refs:[valid[0]!.ref],criteria:[{index:0,evidence_refs:[valid[0]!.ref]}]}
  for(const invalid of [
   {...valid[0]!,observations:[]},
   {...valid[0]!,outcome:'failed'},
   {...valid[0]!,observations:[{...valid[0]!.observations[0]!,text:JSON.stringify({type:'commandExecution',status:'completed',command:'node --test',output:'test failed',exit_code:1})}]},
   {...valid[0]!,observations:[{...valid[0]!.observations[0]!,text_truncated:true}]},
   {...valid[0]!,observations:[{...valid[0]!.observations[0]!,thread_id:undefined}]},
   {...valid[0]!,observations:[{...valid[0]!.observations[0]!,text:JSON.stringify({type:'mcpToolCall',server:'cua_live',tool:'js',status:'completed',is_error:true,readback:'tool failed'})}]},
   {...valid[0]!,observations:[{...valid[0]!.observations[0]!,work_id:'other'}]},
   {...valid[0]!,observations:[{...valid[0]!.observations[0]!,session_id:'other'}]},
   {...valid[0]!,observations:[{...valid[0]!.observations[0]!,text:'commandExecution completed'}]},
  ]){
   const gateway=new ScriptedGateway([],JSON.stringify(decision)),verifier=new GatewayTaskVerifier({gateway,model:'test'})
   assert.equal((await verifier.evaluateTask(current,[invalid],new AbortController().signal)).kind,'wait')
   assert.equal((await verifier.evaluateTask({...current,execution_route:undefined},[invalid],new AbortController().signal)).kind,'wait')
  }
  const gateway=new ScriptedGateway([],JSON.stringify(decision)),verifier=new GatewayTaskVerifier({gateway,model:'test'})
  assert.deepEqual(await verifier.evaluateTask(current,valid,new AbortController().signal),decision)
  assert.deepEqual((JSON.parse(gateway.completions[0]!.prompt) as {evidence:{observations:unknown}[]}).evidence[0]!.observations,valid[0]!.observations)
  const mcp=structuredClone(valid);mcp[0]!.observations[0]!.text=JSON.stringify({type:'mcpToolCall',server:'cua_live',tool:'js',status:'completed',is_error:false,readback:'Counter value: 1'})
  assert.deepEqual(await verifier.evaluateTask(current,mcp,new AbortController().signal),decision)
 }finally{await tasks.close();await rm(dir,{recursive:true,force:true})}
})


test('coding evaluator can use complete later checks despite an unrelated truncated observation',async()=>{
 const {TaskService}=await import('../src/personal-agent/tasks.js'),dir=await mkdtemp(join(await realpath(tmpdir()),'task-partial-proof-')),tasks=new TaskService(join(dir,'tasks.json'))
 try{
  await tasks.open();const task=await tasks.delegate('declare',{conversation_id:'c',execution_route:'codex',goal:'Verify the fix',acceptance:['actual check output'],origin_ref:'user:1'})
  await tasks.bindWork({task_id:task.id,control_revision:0,goal_revision:0},'work','session')
  const identity={task_id:task.id,work_id:'work',session_id:'session',thread_id:'thread',turn_id:'turn',kind:'tool' as const,stage:'completed' as const,refs:[]}
  await tasks.appendEvent({...identity,item_id:'docs',text_truncated:true,text:'Truncated tool documentation'},'docs')
  await tasks.appendEvent({...identity,item_id:'test',text:JSON.stringify({type:'commandExecution',status:'completed',command:'node --test',output:'1 passed',exit_code:0})},'test')
  await tasks.recordWorkOutcome('work','ok',{worker:'codex',final_message:'Done'})
  const current=tasks.get(task.id),evidence=tasks.evidence(task.id),decision={kind:'complete',evidence_refs:[evidence[0]!.ref],criteria:[{index:0,evidence_refs:[evidence[0]!.ref]}]}
  assert.equal(evidence[0]!.observations_truncated,true)
  const gateway=new ScriptedGateway([],JSON.stringify(decision)),verifier=new GatewayTaskVerifier({gateway,model:'test'})
  assert.deepEqual(await verifier.evaluateTask(current,evidence,new AbortController().signal),decision)
  assert.equal((JSON.parse(gateway.completions[0]!.prompt) as {evidence:{observations_truncated:boolean}[]}).evidence[0]!.observations_truncated,true)
  const mcp=structuredClone(evidence);mcp[0]!.observations[1]!.text=JSON.stringify({type:'mcpToolCall',server:'cua_live',tool:'js',status:'completed',is_error:false,readback:'Counter value: 2'})
  assert.deepEqual(await verifier.evaluateTask(current,mcp,new AbortController().signal),decision)
  for(const incomplete of [evidence,mcp]){
   incomplete[0]!.observations[1]!.text_truncated=true
   assert.equal((await verifier.evaluateTask(current,incomplete,new AbortController().signal)).kind,'wait')
  }
 }finally{await tasks.close();await rm(dir,{recursive:true,force:true})}
})

test('a verifier completion must map every criterion to evidence, and listing files is not a check',async()=>{
 const {TaskService}=await import('../src/personal-agent/tasks.js'),dir=await mkdtemp(join(await realpath(tmpdir()),'task-criteria-')),tasks=new TaskService(join(dir,'tasks.json'))
 try{
  await tasks.open();const task=await tasks.delegate('declare',{conversation_id:'c',execution_route:'codex',goal:'Fix and test',acceptance:['bug fixed','tests pass'],origin_ref:'user:1'}),fence={task_id:task.id,control_revision:0,goal_revision:0}
  await tasks.bindWork(fence,'work','session')
  const identity={task_id:task.id,work_id:'work',session_id:'session',thread_id:'thread',turn_id:'turn',kind:'tool' as const,stage:'completed' as const,refs:[]}
  await tasks.appendEvent({...identity,item_id:'ls',text:JSON.stringify({type:'commandExecution',status:'completed',command:"/bin/zsh -lc 'cd app && ls -la'",output:'a b',exit_code:0})},'ls')
  await tasks.recordWorkOutcome('work','ok',{worker:'codex',final_message:'Done'})
  const current=tasks.get(task.id),ref=tasks.evidence(task.id)[0]!.ref,run=async(decision:object)=>new GatewayTaskVerifier({gateway:new ScriptedGateway([],JSON.stringify(decision)),model:'test'}).evaluateTask(current,tasks.evidence(task.id),new AbortController().signal)
  assert.equal((await run({kind:'complete',evidence_refs:[ref],criteria:[{index:0,evidence_refs:[ref]}]})).kind,'wait','criterion 1 has no evidence')
  assert.equal((await run({kind:'complete',evidence_refs:[ref]})).kind,'wait','no mapping at all')
  assert.equal((await run({kind:'complete',evidence_refs:[ref],criteria:[{index:0,evidence_refs:[ref]},{index:1,evidence_refs:[ref]}]})).kind,'wait','ls is not a check')
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('a coding task without criteria completes on a bound check, and wrapped no-ops are not checks',async()=>{
 const {TaskService}=await import('../src/personal-agent/tasks.js')
 const verdict=async(command:string)=>{
  const dir=await mkdtemp(join(await realpath(tmpdir()),'task-check-')),tasks=new TaskService(join(dir,'tasks.json'))
  try{
   await tasks.open();const task=await tasks.delegate('declare',{conversation_id:'c',execution_route:'codex',goal:'Fix and test',acceptance:[],origin_ref:'user:1'}),fence={task_id:task.id,control_revision:0,goal_revision:0}
   await tasks.bindWork(fence,'work','session')
   await tasks.appendEvent({task_id:task.id,work_id:'work',session_id:'session',thread_id:'thread',turn_id:'turn',kind:'tool',stage:'completed',refs:[],item_id:'check',text:JSON.stringify({type:'commandExecution',status:'completed',command,output:'ok',exit_code:0})},'check')
   await tasks.recordWorkOutcome('work','ok',{worker:'codex',final_message:'Done'})
   const ref=tasks.evidence(task.id)[0]!.ref
   return (await new GatewayTaskVerifier({gateway:new ScriptedGateway([],JSON.stringify({kind:'complete',evidence_refs:[ref]})),model:'test'}).evaluateTask(tasks.get(task.id),tasks.evidence(task.id),new AbortController().signal)).kind
  }finally{await rm(dir,{recursive:true,force:true})}
 }
 assert.equal(await verdict('node --test'),'complete')
 assert.equal(await verdict('env CI=1 node --test'),'complete')
 assert.equal(await verdict('cat README.md\nnode --test'),'complete')
 assert.equal(await verdict('command true'),'wait')
 assert.equal(await verdict('env'),'wait')
 assert.equal(await verdict("/bin/zsh -lc 'cd app && ls'"),'wait')
})

test('a check observed in another session of the same task does not prove a work bound to a different session',async()=>{
 const {TaskService}=await import('../src/personal-agent/tasks.js'),dir=await mkdtemp(join(await realpath(tmpdir()),'task-work-session-')),tasks=new TaskService(join(dir,'tasks.json'))
 try{
  await tasks.open();const task=await tasks.delegate('declare',{conversation_id:'c',execution_route:'codex',goal:'Fix and test',acceptance:[],origin_ref:'user:1'}),fence={task_id:task.id,control_revision:0,goal_revision:0}
  await tasks.bindWork(fence,'work','session-a');await tasks.bindWork(fence,'other','session-b')
  await tasks.appendEvent({task_id:task.id,work_id:'work',session_id:'session-b',thread_id:'thread',turn_id:'turn',kind:'tool',stage:'completed',refs:[],item_id:'check',text:JSON.stringify({type:'commandExecution',status:'completed',command:'node --test',output:'ok',exit_code:0})},'check')
  await tasks.recordWorkOutcome('work','ok',{worker:'codex',final_message:'Done'})
  const ref=tasks.evidence(task.id)[0]!.ref
  assert.equal((await new GatewayTaskVerifier({gateway:new ScriptedGateway([],JSON.stringify({kind:'complete',evidence_refs:[ref]})),model:'test'}).evaluateTask(tasks.get(task.id),tasks.evidence(task.id),new AbortController().signal)).kind,'wait')
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('verifier retries once with validation_feedback when the reply is unparsable, schema-invalid, or cites unknown/missing/out-of-range refs',async()=>{
 const {TaskService}=await import('../src/personal-agent/tasks.js'),{TaskCheckError}=await import('../src/personal-agent/task-loop.js'),{GatewayError}=await import('../src/model/model-gateway.js')
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-verifier-retry-')),tasks=new TaskService(join(dir,'tasks.json'))
 try{
  await tasks.open();const task=await tasks.delegate('declare',{conversation_id:'c',execution_route:'codex',goal:'Fix',acceptance:['tests pass'],origin_ref:'user:1'}),fence={task_id:task.id,control_revision:0,goal_revision:0}
  await tasks.bindWork(fence,'work','session')
  await tasks.appendEvent({task_id:task.id,work_id:'work',session_id:'session',thread_id:'thread',turn_id:'turn',kind:'tool',stage:'completed',refs:[],item_id:'check',text:JSON.stringify({type:'commandExecution',status:'completed',command:'node --test',output:'ok',exit_code:0})},'check')
  await tasks.recordWorkOutcome('work','ok',{worker:'codex',final_message:'Done'})
  const current=tasks.get(task.id),ref=tasks.evidence(task.id)[0]!.ref
  const good=JSON.stringify({kind:'complete',evidence_refs:[ref],criteria:[{index:0,evidence_refs:[ref]}]})
  const cases:[string,string][]=[['not json','json_parse'],[JSON.stringify({kind:'wait',reason:'hold',evidence_refs:[],criteria:[{index:0,evidence_refs:[ref]}]}),'schema'],[JSON.stringify({kind:'correct',instruction:'retry',evidence_refs:['call_00_x']}),'evidence_ref'],[JSON.stringify({kind:'complete',evidence_refs:[],criteria:[{index:0,evidence_refs:[ref]}]}),'evidence_ref'],[JSON.stringify({kind:'complete',evidence_refs:[ref],criteria:[{index:1,evidence_refs:[ref]}]}),'evidence_ref']]
  for(const [bad,stage] of cases){
   const gateway=new QueuedGateway([bad,good]),actual=await new GatewayTaskVerifier({gateway,model:'test'}).evaluateTask(current,tasks.evidence(task.id),new AbortController().signal)
   assert.equal(actual.kind,'complete');assert.equal(gateway.completions.length,2)
   const first=JSON.parse(gateway.completions[0]!.prompt) as {valid_evidence_refs:string[]},second=JSON.parse(gateway.completions[1]!.prompt) as {validation_feedback:{stage:string;valid_evidence_refs:string[];previous_response:string}}
   assert.deepEqual(first.valid_evidence_refs,[ref]);assert.equal(second.validation_feedback.stage,stage);assert.deepEqual(second.validation_feedback.valid_evidence_refs,[ref]);assert.ok(second.validation_feedback.previous_response.length<=2000)
  }
  // Live qwen-max shape: a bare string where an array is required; feedback must name the path and expected type.
  const scalar=new QueuedGateway([JSON.stringify({kind:'complete',evidence_refs:[ref],criteria:[{index:0,evidence_refs:ref}]}),good])
  assert.equal((await new GatewayTaskVerifier({gateway:scalar,model:'test'}).evaluateTask(current,tasks.evidence(task.id),new AbortController().signal)).kind,'complete')
  const repair=(JSON.parse(scalar.completions[1]!.prompt) as {validation_feedback:{issues:{path:string;message:string}[]}}).validation_feedback
  assert.equal(repair.issues[0]?.path,'criteria.0.evidence_refs');assert.match(repair.issues[0]?.message ?? '',/array/)
  const indexed=new QueuedGateway([JSON.stringify({kind:'complete',evidence_refs:[ref],criteria:[{index:3,evidence_refs:[ref]}]}),good])
  await new GatewayTaskVerifier({gateway:indexed,model:'test'}).evaluateTask(current,tasks.evidence(task.id),new AbortController().signal)
  assert.match((JSON.parse(indexed.completions[1]!.prompt) as {validation_feedback:{hint:string}}).validation_feedback.hint,/\[0, 1\)/)
  const twice=new QueuedGateway([JSON.stringify({kind:'complete',evidence_refs:[ref],criteria:[{index:1,evidence_refs:[ref]}]}),JSON.stringify({kind:'complete',evidence_refs:[ref],criteria:[{index:2,evidence_refs:[ref]}]})])
  await assert.rejects(new GatewayTaskVerifier({gateway:twice,model:'test'}).evaluateTask(current,tasks.evidence(task.id),new AbortController().signal),error=>error instanceof TaskCheckError&&error.stage==='evidence_ref'&&error.code==='criterion_index')
  assert.equal(twice.completions.length,2)
  // First reply unknown ref retries; second has valid refs but only inspect-only observations so bound check fails.
  const inspectDir=await mkdtemp(join(await realpath(tmpdir()),'task-verifier-nocheck-')),inspectTasks=new TaskService(join(inspectDir,'tasks.json'))
  await inspectTasks.open();const inspectTask=await inspectTasks.delegate('declare',{conversation_id:'c',execution_route:'codex',goal:'Fix',acceptance:['tests pass'],origin_ref:'user:1'}),inspectFence={task_id:inspectTask.id,control_revision:0,goal_revision:0}
  await inspectTasks.bindWork(inspectFence,'work','session');await inspectTasks.appendEvent({task_id:inspectTask.id,work_id:'work',session_id:'session',thread_id:'thread',turn_id:'turn',kind:'tool',stage:'completed',refs:[],item_id:'ls',text:JSON.stringify({type:'commandExecution',status:'completed',command:'ls',output:'a',exit_code:0})},'ls');await inspectTasks.recordWorkOutcome('work','ok',{worker:'codex'})
  const inspectRef=inspectTasks.evidence(inspectTask.id)[0]!.ref
  const inspectGateway=new QueuedGateway([JSON.stringify({kind:'complete',evidence_refs:[inspectRef],criteria:[{index:0,evidence_refs:['nope']}]}),JSON.stringify({kind:'complete',evidence_refs:[inspectRef],criteria:[{index:0,evidence_refs:[inspectRef]}]})])
  assert.equal((await new GatewayTaskVerifier({gateway:inspectGateway,model:'test'}).evaluateTask(inspectTasks.get(inspectTask.id),inspectTasks.evidence(inspectTask.id),new AbortController().signal)).kind,'wait')
  await inspectTasks.close();await rm(inspectDir,{recursive:true,force:true})
  const transport=new QueuedGateway([],new GatewayError('TimeoutError'))
  await assert.rejects(new GatewayTaskVerifier({gateway:transport,model:'test'}).evaluateTask(current,tasks.evidence(task.id),new AbortController().signal),error=>error instanceof TaskCheckError&&error.stage==='model_call'&&error.code==='timeout_error')
  assert.equal(transport.completions.length,1)
 }finally{await tasks.close();await rm(dir,{recursive:true,force:true})}
})
