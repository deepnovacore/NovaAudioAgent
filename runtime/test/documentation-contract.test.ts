import assert from 'node:assert/strict'
import {readdir, readFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {test} from 'node:test'

import {
  environmentContract,
  publicEnvironmentContract,
} from '../src/environment-contract.js'

const repositoryRoot = resolve(import.meta.dirname, '../../..')
const currentDocs = [
  'README.md',
  'README.zh-CN.md',
  'docs/getting-started.md',
  'docs/getting-started.zh-CN.md',
  'docs/status.md',
  'docs/archs/node-runtime-migration/plan.md',
  'docs/archs/node-runtime-migration/backlog.md',
  'docs/archs/node-runtime-migration/parity-matrix.md',
  'docs/releases/node-runtime-migration-unreleased.md',
] as const

test('current docs state the Node release truth and do not advertise retired capabilities', async () => {
  const documents = await Promise.all(currentDocs.map(async file => ({
    file,
    text: await readFile(resolve(repositoryRoot, file), 'utf8'),
  })))
  for (const {file, text} of documents) {
    assert.doesNotMatch(text, /active executors?[^\n]*(?:Home Assistant|AutoGLM)|(?:Home Assistant|AutoGLM)[^\n]*(?:implemented|supported active)/iu, file)
    assert.equal(text.includes('tests/snapshots') && file !== 'docs/archs/node-runtime-migration/parity-matrix.md', false, file)
    assert.doesNotMatch(text, /no production source constructs (?:it|CausalRuntime)|does not instantiate CausalRuntime|desktop (?:microphone )?audio remains (?:deliberately )?unwired/iu, file)
    assert.doesNotMatch(text, /live (?:DashScope )?smoke[^\n]*(?:landed|pass)|runtime:smoke:qwen[^\n]*pass/iu, file)
    assert.doesNotMatch(text, /v1-mini[^\n]*(?:real|actual) executor[^\n]*(?:proven|pass)|v1-mini path runs locally/iu, file)
  }
  const status = documents.find(item => item.file === 'docs/status.md')!.text
  assert.match(status, /Node\.js and TypeScript[^\n]*primary/iu)
  assert.match(status, /pending external evidence/iu)

  const release = documents.find(item => item.file.endsWith('unreleased.md'))!.text
  assert.match(release, /gate_state:\s*pending_external_evidence/u)
  assert.doesNotMatch(release, /gate_state:\s*passed|Node is (?:now )?the default|signed installer|clean-machine gate passed/iu)
})

test('audio pipeline docs distinguish the selectable topology, credentials, and deferred settings effects', async () => {
  const documents = new Map(await Promise.all(currentDocs.map(async file => [
    file,
    await readFile(resolve(repositoryRoot, file), 'utf8'),
  ] as const)))
  const english = `${documents.get('README.md')}\n${documents.get('docs/getting-started.md')}`
  const chinese = `${documents.get('README.zh-CN.md')}\n${documents.get('docs/getting-started.zh-CN.md')}`

  assert.match(english, /integrated.*cascaded/isu)
  assert.match(english, /qwen-audio-3\.0-realtime-plus.*longanqian/isu)
  assert.match(english, /Volcengine ASR\s*->\s*Qwen `qwen-flash`\s*->\s*Volcengine TTS/u)
  assert.match(english, /Ark.*explicit.*cascaded LLM/isu)
  assert.match(english, /one key per platform.*reused/isu)
  assert.match(english, /ASR.*fallback.*DOUBAO_BIGMODEL_API_KEY/isu)
  assert.match(english, /conditional.*Settings Panel/isu)
  assert.match(english, /write-only.*presence/isu)
  assert.match(english, /next launch/iu)
  assert.match(english, /opt-in live smoke/iu)

  assert.match(chinese, /集成.*级联/su)
  assert.match(chinese, /qwen-audio-3\.0-realtime-plus.*longanqian/su)
  assert.match(chinese, /火山 ASR\s*->\s*Qwen `qwen-flash`\s*->\s*火山 TTS/u)
  assert.match(chinese, /Ark.*显式.*级联 LLM/su)
  assert.match(chinese, /每个平台.*一把密钥.*复用/su)
  assert.match(chinese, /ASR.*回退.*DOUBAO_BIGMODEL_API_KEY/su)
  assert.match(chinese, /条件.*设置面板/su)
  assert.match(chinese, /只写.*存在/u)
  assert.match(chinese, /下次启动/u)
  assert.match(chinese, /可选.*在线 smoke/u)

  const englishReadme = documents.get('README.md')!
  const chineseReadme = documents.get('README.zh-CN.md')!
  assert.match(englishReadme, /DASHSCOPE_API_KEY.*integrated Qwen.*cascaded Qwen/isu)
  assert.match(englishReadme, /cascaded\s+Ark.*ARK_API_KEY.*DOUBAO_BIGMODEL_API_KEY/isu)
  assert.doesNotMatch(englishReadme, /launcher.*requires[^.]*DASHSCOPE_API_KEY.*TAVILY_API_KEY/isu)
  assert.match(chineseReadme, /DASHSCOPE_API_KEY.*集成 Qwen.*级联 Qwen/su)
  assert.match(chineseReadme, /级联 Ark.*ARK_API_KEY.*DOUBAO_BIGMODEL_API_KEY/su)
  assert.doesNotMatch(chineseReadme, /启动器.*需要[^。]*DASHSCOPE_API_KEY.*TAVILY_API_KEY/su)

  for (const [file, text] of documents) {
    assert.doesNotMatch(text, /NOVA_AUDIO_AGENT_(?:REALTIME_PROVIDER|VOLCENGINE_ARK_MODEL|VOLCENGINE_ARK_SUPPORT_MODEL)/u, file)
  }
})

test('English, Chinese, and env example generated blocks contain every public variable once', async () => {
  const files = ['.env.example', 'docs/getting-started.md', 'docs/getting-started.zh-CN.md'] as const
  const documents = await Promise.all(files.map(file => readFile(resolve(repositoryRoot, file), 'utf8')))
  for (const entry of publicEnvironmentContract()) {
    for (const [index, document] of documents.entries()) {
      const generated = generatedBlock(document)
      const escaped = entry.name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
      assert.equal(
        [...generated.matchAll(new RegExp(`(?<![A-Z0-9_])${escaped}(?![A-Z0-9_])`, 'gu'))].length,
        1,
        `${files[index]}: ${entry.name}`,
      )
    }
  }
  for (const document of documents) {
    assert.doesNotMatch(document, /NOVA_AUDIO_AGENT_REALTIME_PROVIDER\s*=/u)
    assert.doesNotMatch(document, /NOVA_AUDIO_AGENT_(?:HA|AUTOGLM)_[A-Z_]+\s*=/u)
    assert.doesNotMatch(document, /NOVA_AUDIO_AGENT_DESKTOP_(?:TOKEN|READY_ENDPOINT|READY_FD)\s*=/u)
  }
})

test('the public contract exposes product-shaped pipeline selectors and retires the vendor selector', () => {
  const publicNames = new Set(publicEnvironmentContract().map(entry => entry.name))
  assert.deepEqual([
    'NOVA_AUDIO_AGENT_PIPELINE_MODE',
    'NOVA_AUDIO_AGENT_INTEGRATED_PROVIDER',
    'NOVA_AUDIO_AGENT_CASCADE_ENDPOINTING_PROVIDER',
    'NOVA_AUDIO_AGENT_CASCADE_ASR_PROVIDER',
    'NOVA_AUDIO_AGENT_CASCADE_LLM_PROVIDER',
    'NOVA_AUDIO_AGENT_CASCADE_LLM_MODEL',
    'NOVA_AUDIO_AGENT_CASCADE_TTS_PROVIDER',
  ].every(name => publicNames.has(name)), true)
  assert.equal(publicNames.has('NOVA_AUDIO_AGENT_REALTIME_PROVIDER'), false)
})

test('the generic model credential is an optional support-model override only', () => {
  const entry = environmentContract.find(candidate =>
    candidate.name === 'NOVA_AUDIO_AGENT_MODEL_API_KEY')
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

test('current Node Codex and release claims remain exact', async () => {
  const joined = (await Promise.all(currentDocs.map(file =>
    readFile(resolve(repositoryRoot, file), 'utf8')))).join('\n')
  assert.match(joined, /app-server-only/iu)
  assert.match(joined, /JSONL[^\n]*fixture-parser-only/iu)
  assert.match(joined, /HA(?:\/| and )AutoGLM[^\n]*retired/iu)
})

test('every production environment name is classified and private names stay private', async () => {
  const classified = new Map(environmentContract.map(entry => [entry.name, entry]))
  assert.equal(classified.size, environmentContract.length, 'environment names must be unique')
  const sources = [
    ...await sourceFiles(resolve(repositoryRoot, 'runtime/src')),
    ...await sourceFiles(resolve(repositoryRoot, 'desktop/ambient-orb/src')),
  ]
  const environmentName = /\b(?:NOVA_AUDIO_AGENT_[A-Z0-9_]+|DASHSCOPE_API_KEY|ARK_API_KEY|DOUBAO_[A-Z0-9_]+|TAVILY_API_KEY|CODEX_HOME|VIRTUAL_ENV|NOVA_ORB_OPAQUE|HOME)\b/gu
  for (const source of sources) {
    const text = await readFile(source, 'utf8')
    for (const match of text.matchAll(environmentName)) {
      assert.equal(classified.has(match[0]), true, `${source}: ${match[0]}`)
    }
  }
  for (const entry of environmentContract) {
    if (entry.owner === 'host_private' || entry.owner.startsWith('retired_')) {
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
