import assert from 'node:assert/strict'
import {readdir, readFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {test} from 'node:test'

import {
  environmentContract,
  publicEnvironmentContract,
} from '../src/config/environment-contract.js'

const repositoryRoot = resolve(import.meta.dirname, '../../..')
const currentDocs = [
  'README.md',
  'README.zh-CN.md',
  'docs/en/getting-started.md',
  'docs/zh-CN/getting-started.md',
  'docs/en/architecture.md',
  'docs/en/archs/06-verification.md',
  'docs/zh-CN/archs/06-verification.md',
] as const

test('current docs state the Node release truth and do not advertise retired capabilities', async () => {
  const documents = await Promise.all(currentDocs.map(async file => ({
    file,
    text: await readFile(resolve(repositoryRoot, file), 'utf8'),
  })))
  for (const {file, text} of documents) {
    assert.doesNotMatch(text, /active executors?[^\n]*(?:Home Assistant|AutoGLM)|(?:Home Assistant|AutoGLM)[^\n]*(?:implemented|supported active)/iu, file)
    assert.equal(text.includes('tests/snapshots'), false, file)
    assert.doesNotMatch(text, /no production source constructs (?:it|CausalRuntime)|does not instantiate CausalRuntime|desktop (?:microphone )?audio remains (?:deliberately )?unwired/iu, file)
    assert.doesNotMatch(text, /live (?:DashScope )?smoke[^\n]*(?:landed|pass)|runtime:smoke:qwen[^\n]*pass/iu, file)
    assert.doesNotMatch(text, /v1-mini[^\n]*(?:real|actual) executor[^\n]*(?:proven|pass)|v1-mini path runs locally/iu, file)
  }
  const gettingStarted = documents.find(item => item.file === 'docs/en/getting-started.md')!.text
  assert.match(documents.find(item => item.file === 'docs/en/archs/06-verification.md')!.text, /Node\.js and TypeScript[^\n]*only product runtime/iu)
  assert.match(gettingStarted, /Desktop targets macOS arm64, Windows x64, and Ubuntu 22\.04\+ x64/iu)
  assert.doesNotMatch(gettingStarted, /Linux is available for source use/iu)
})

test('audio pipeline docs distinguish the selectable topology, credentials, and deferred settings effects', async () => {
  const documents = new Map(await Promise.all(currentDocs.map(async file => [
    file,
    await readFile(resolve(repositoryRoot, file), 'utf8'),
  ] as const)))
  const english = `${documents.get('README.md')}\n${documents.get('docs/en/getting-started.md')}\n${documents.get('docs/en/archs/06-verification.md')}`
  const chinese = `${documents.get('README.zh-CN.md')}\n${documents.get('docs/zh-CN/getting-started.md')}\n${documents.get('docs/zh-CN/archs/06-verification.md')}`

  assert.match(english, /integrated.*cascaded/isu)
  assert.match(english, /qwen-audio-3\.0-realtime-plus.*longanqian/isu)
  assert.match(english, /Volcengine ASR\s*->\s*DeepSeek `deepseek-flash`\s*->\s*Volcengine TTS/u)
  assert.match(english, /Ark.*explicit.*cascaded LLM/isu)
  assert.match(english, /one key per platform.*reused/isu)
  assert.match(english, /ASR.*fallback.*DOUBAO_BIGMODEL_API_KEY/isu)
  assert.match(english, /conditional.*Settings Panel/isu)
  assert.match(english, /write-only.*presence/isu)
  assert.match(english, /next launch/iu)
  assert.match(english, /opt-in live smoke/iu)

  assert.match(chinese, /集成.*级联/su)
  assert.match(chinese, /qwen-audio-3\.0-realtime-plus.*longanqian/su)
  assert.match(chinese, /火山 ASR\s*->\s*DeepSeek `deepseek-flash`\s*->\s*火山 TTS/u)
  assert.match(chinese, /Ark.*显式.*级联 LLM/su)
  assert.match(chinese, /每个平台.*一把密钥.*复用/su)
  assert.match(chinese, /ASR.*回退.*DOUBAO_BIGMODEL_API_KEY/su)
  assert.match(chinese, /条件.*设置面板/su)
  assert.match(chinese, /只写.*存在/u)
  assert.match(chinese, /下次启动/u)
  assert.match(chinese, /可选.*在线 smoke/u)

  for (const [file, text] of documents) {
    assert.doesNotMatch(text, /workspace-graph surfaces|工作区图谱|WORKSPACE_GRAPH/u, file)
    assert.doesNotMatch(text, /(?:REALTIME_PROVIDER|VOLCENGINE_ARK_MODEL|VOLCENGINE_ARK_SUPPORT_MODEL)/u, file)
  }
})

test('configuration guides share a concise public subset and env example stays complete', async () => {
  const example = generatedBlock(await readFile(resolve(repositoryRoot, '.env.example'), 'utf8'))
  for (const entry of publicEnvironmentContract()) {
    assert.equal(example.split(`# ${entry.name}=`).length - 1, 1, entry.name)
  }
  const publicNames = new Set(publicEnvironmentContract().map(entry => entry.name))
  const selections: string[][] = []
  for (const file of ['docs/en/configuration.md', 'docs/zh-CN/configuration.md']) {
    const block = generatedBlock(await readFile(resolve(repositoryRoot, file), 'utf8'))
    const names = [...block.matchAll(/^\| `([A-Z0-9_]+)` \|/gmu)].map(match => match[1]!)
    assert.equal(new Set(names).size, names.length, file)
    assert.ok(names.length <= 20 && names.length > 0, file)
    for (const name of names) assert.ok(publicNames.has(name), `${file}: ${name}`)
    for (const essential of ['DASHSCOPE_API_KEY', 'DEEPSEEK_API_KEY', 'PIPELINE_MODE', 'MEMORY_CONNECTION']) {
      assert.ok(names.includes(essential), `${file}: ${essential}`)
    }
    selections.push(names)
  }
  assert.deepEqual(selections[0], selections[1])
  for (const file of ['docs/en/getting-started.md', 'docs/zh-CN/getting-started.md']) {
    assert.doesNotMatch(await readFile(resolve(repositoryRoot, file), 'utf8'), /BEGIN GENERATED ENV CONTRACT/u)
  }
})

test('the public contract exposes product-shaped pipeline selectors and retires the vendor selector', () => {
  const publicNames = new Set(publicEnvironmentContract().map(entry => entry.name))
  assert.deepEqual([
    'PIPELINE_MODE',
    'INTEGRATED_PROVIDER',
    'CASCADE_ENDPOINTING_PROVIDER',
    'CASCADE_ASR_PROVIDER',
    'CASCADE_LLM_PROVIDER',
    'CASCADE_LLM_MODEL',
    'CASCADE_TTS_PROVIDER',
  ].every(name => publicNames.has(name)), true)
  assert.equal(publicNames.has('REALTIME_PROVIDER'), false)
})

test('the v4 settings environment additions are classified as public overrides', () => {
  const publicNames = new Set(publicEnvironmentContract().map(entry => entry.name))
  assert.deepEqual([
    'CODEX_APPROVAL_MODE',
    'CLARIFICATION_DEPTH',
    'PLAN_READBACK',
    'PLANNER_MODEL',
    'PROGRESS_BUBBLES',
    'CAPABILITIES_CONFIG',
    'SEARCH_PROVIDER',
    'SEARCH_MCP_URL',
    'SEARCH_MCP_TOOL',
    'KNOWLEDGE_PATH',
    'EMBEDDING_PROVIDER',
    'EMBEDDING_MODEL',
  ].every(name => publicNames.has(name)), true)
})

test('the generic model credential is an optional support-model override only', () => {
  const entry = environmentContract.find(candidate =>
    candidate.name === 'MODEL_API_KEY')
  assert.ok(entry !== undefined)
  assert.equal(entry.required, 'never')
  assert.match(entry.descriptionEn, /optional generic support-model.*override/iu)
  assert.match(entry.descriptionZh, /可选.*通用.*辅助模型.*覆盖/u)
  assert.doesNotMatch(`${entry.descriptionEn}\n${entry.descriptionZh}`, /Qwen.*fallback|Qwen 回退/iu)
})

function generatedBlock(document: string): string {
  const start = document.indexOf('BEGIN GENERATED ENV CONTRACT')
  const end = document.indexOf('END GENERATED ENV CONTRACT')
  assert.ok(start >= 0 && end > start)
  return document.slice(start, end)
}

test('current Node Codex transport claim remains exact', async () => {
  const gettingStarted = await readFile(
    resolve(repositoryRoot, 'docs/en/archs/06-verification.md'),
    'utf8',
  )
  assert.match(gettingStarted, /Codex is app-server-only; JSONL is\s+fixture-parser-only/iu)
})

test('every production environment name is classified and private names stay private', async () => {
  const classified = new Map(environmentContract.map(entry => [entry.name, entry]))
  assert.equal(classified.size, environmentContract.length, 'environment names must be unique')
  const sources = [
    ...await sourceFiles(resolve(repositoryRoot, 'runtime/src')),
    ...await sourceFiles(resolve(repositoryRoot, 'clients/desktop/src')),
  ]
  const systemNames = new Set(['HTTPS_PROXY', 'HTTP_PROXY', 'PATH', 'APPDATA'])
  const environmentName = /\b(?:process\.env|environment|parentEnv|env)\.([A-Z][A-Z0-9_]+)\b/gu
  for (const source of sources) {
    const text = await readFile(source, 'utf8')
    for (const match of text.matchAll(environmentName)) {
      assert.ok(classified.has(match[1]!) || systemNames.has(match[1]!), `${source}: ${match[1]}`)
    }
  }
  for (const entry of environmentContract) {
    if (entry.owner === 'host_private') {
      assert.equal(entry.public, false, entry.name)
    }
  }
})

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(root, {withFileTypes: true})) {
    const path = resolve(root, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(path))
    else if (entry.isFile() && /\.(?:js|mjs|ts)$/u.test(entry.name)) files.push(path)
  }
  return files
}


test('current architecture and numbered specs do not depend on the retired graph', async () => {
  const roots = ['docs/en/archs']
  for (const root of roots) {
    for (const file of await readdir(resolve(repositoryRoot, root))) {
      if (!/^\d.*\.md$/u.test(file)) continue
      const text = await readFile(resolve(repositoryRoot, root, file), 'utf8')
      assert.doesNotMatch(text, /workspace-graph\/|workspace_graph|WORKSPACE_GRAPH|GraphContext|PublishedGraphSnapshot/u, `${root}/${file}`)
      assert.doesNotMatch(text, /Workspace Graph|workspace graph|工作区图/u, `${root}/${file}`)
    }
  }
})


test('focused user guides describe use without branch or documentation-maintenance labels', async () => {
  for (const file of ['docs/en/README.md', 'docs/zh-CN/README.md', 'docs/en/getting-started.md', 'docs/zh-CN/getting-started.md', 'docs/en/configuration.md', 'docs/zh-CN/configuration.md', 'docs/en/knowledge-base.md', 'docs/zh-CN/knowledge-base.md', 'docs/en/personal-memory.md', 'docs/zh-CN/personal-memory.md', 'docs/en/features.md', 'docs/zh-CN/features.md', 'docs/en/iphone.md', 'docs/zh-CN/iphone.md', 'docs/en/architecture.md', 'docs/zh-CN/architecture.md']) {
    const markdown = await readFile(resolve(repositoryRoot, file), 'utf8')
    const visible = markdown.replace(/\]\([^)]+\)/gu, ']')
    assert.doesNotMatch(visible, /v0\.[23](?:\.0)?(?:dev)?|M1\.5c|Documentation verification|文档维护|本轮|本地基线/u, file)
  }
})
