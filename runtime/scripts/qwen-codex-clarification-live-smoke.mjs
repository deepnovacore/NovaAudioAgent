/**
 * Credential-gated, macOS-only voice E2E for adaptive Codex clarification.
 *
 * It uses the production Qwen realtime adapter, production frontend instructions, exact compiled
 * codex__project schema, locally synthesized Chinese PCM, and the shared semantic scorer. It never
 * executes Codex: a tool call is captured as the model's dispatch decision and the case ends.
 */

import {spawnSync} from 'node:child_process'
import {mkdirSync, mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'

import {CODEX_PROJECT_MANIFEST} from '../dist/src/codex-contract.js'
import {QwenAudioRealtimeAdapter} from '../dist/src/realtime/qwen.js'
import {webSocketQwenConnector} from '../dist/src/realtime/qwen-transport.js'
import {compileToolSchema} from '../dist/src/tool-schema.js'
import {scoreCodexClarificationTurn} from './qwen-codex-clarification-score.mjs'

const repositoryRoot = resolve(import.meta.dirname, '../..')
const fixture = JSON.parse(readFileSync(resolve(
  repositoryRoot,
  'fixtures/realtime/qwen/v1/codex-clarification.json',
), 'utf8'))

function dotenv() {
  const values = {}
  try {
    for (const line of readFileSync(resolve(repositoryRoot, '.env'), 'utf8').split('\n')) {
      const match = /^([A-Za-z0-9_]+)=(.*)$/.exec(line.trim())
      if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, '')
    }
  } catch { /* environment-only configuration is valid */ }
  return values
}

const file = dotenv()
const setting = name => process.env[name] ?? file[name]
const apiKey = setting('DASHSCOPE_API_KEY') ?? setting('NOVA_AUDIO_AGENT_MODEL_API_KEY')
if (!apiKey) {
  console.error('missing DASHSCOPE_API_KEY or NOVA_AUDIO_AGENT_MODEL_API_KEY')
  process.exit(2)
}
if (process.platform !== 'darwin') {
  console.error('Codex clarification voice smoke requires macOS say and afconvert')
  process.exit(2)
}

const url = setting('NOVA_AUDIO_AGENT_QWEN_REALTIME_URL')
  ?? 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime'
const model = setting('NOVA_AUDIO_AGENT_QWEN_REALTIME_MODEL') ?? 'qwen-audio-3.0-realtime-plus'
const voice = setting('NOVA_AUDIO_AGENT_QWEN_REALTIME_VOICE') ?? 'longanqian'

const compiled = compileToolSchema([CODEX_PROJECT_MANIFEST])
const projectTool = compiled.schemas.find(schema => schema.function?.name === 'codex__project')
if (!projectTool) throw new Error('compiled Codex project manifest has no codex__project tool')

function wavPcm(path) {
  const wav = readFileSync(path)
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('local speech synthesis did not produce PCM WAV')
  }
  let offset = 12
  while (offset + 8 <= wav.length) {
    const kind = wav.toString('ascii', offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    if (kind === 'data') return new Uint8Array(wav.subarray(offset + 8, offset + 8 + size))
    offset += 8 + size + (size % 2)
  }
  throw new Error('local speech WAV has no data chunk')
}

function synthesize(text, directory, index) {
  const aiff = join(directory, `turn-${index}.aiff`)
  const wav = join(directory, `turn-${index}.wav`)
  const spoken = spawnSync('/usr/bin/say', ['-v', 'Tingting', '-o', aiff, text], {encoding: 'utf8'})
  if (spoken.status !== 0) throw new Error(`say failed: ${spoken.stderr.trim()}`)
  const converted = spawnSync('/usr/bin/afconvert', [
    aiff, '-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', wav,
  ], {encoding: 'utf8'})
  if (converted.status !== 0) throw new Error(`afconvert failed: ${converted.stderr.trim()}`)
  return wavPcm(wav)
}

const delay = milliseconds => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds))

async function within(promise, milliseconds) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('clarification smoke timed out')), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function feed(adapter, pcm, signal) {
  const silence = new Uint8Array(16_000 * 2 * 0.4)
  const audio = new Uint8Array(silence.length + pcm.length + silence.length * 2)
  audio.set(silence, 0)
  audio.set(pcm, silence.length)
  for (let offset = 0; offset < audio.length; offset += 640) {
    await adapter.sendAudio(audio.subarray(offset, Math.min(audio.length, offset + 640)), signal)
    await delay(20)
  }
}

async function observeTurn(adapter, pcm, signal) {
  const events = []
  const terminal = (async () => {
    for await (const event of adapter.events(signal)) {
      events.push(event)
      if (event.kind === 'provider_error') throw new Error(`provider error: ${event.code}`)
      if (event.kind === 'response_terminal') return
    }
    throw new Error('provider event stream ended before a response terminal')
  })()
  await feed(adapter, pcm, signal)
  await within(terminal, 45_000)
  return {
    transcript: events
      .filter(event => event.kind === 'response_transcript_delta')
      .map(event => event.text)
      .join(''),
    toolCalls: events
      .filter(event => event.kind === 'tool_call_ready')
      .map(event => ({name: event.name, arguments: event.arguments})),
  }
}

async function runCase(testCase, directory) {
  const adapter = new QwenAudioRealtimeAdapter({
    url, apiKey, model, voice, connector: webSocketQwenConnector,
  })
  const stop = new AbortController()
  const failures = []
  try {
    const identity = await adapter.connect({tools: [projectTool], signal: stop.signal})
    await adapter.injectWorkspaceContext({
      kind: 'workspace_context',
      host_item_id: `clarification-context-${testCase.id}`,
      event_id: `clarification-context-event-${testCase.id}`,
      content: '<active_project_context>\nworkspace="Nova Audio Agent"\nsession=null\n</active_project_context>',
      call_id: null,
      session_epoch: identity.epoch,
      workspace_instance_id: 'clarification-smoke-workspace',
      revision: 1,
    }, {confirmationTimeout: 10, signal: stop.signal})

    for (const [index, turn] of testCase.turns.entries()) {
      const observation = await observeTurn(
        adapter,
        synthesize(turn.utterance, directory, index + 1),
        stop.signal,
      )
      const turnFailures = scoreCodexClarificationTurn({
        expectation: turn.expectation,
        requiredWorkOrderTerms: turn.required_work_order_terms,
      }, observation)
      failures.push(...turnFailures.map(failure => `turn ${index + 1}: ${failure}`))
      console.log(`${testCase.id}/turn-${index + 1}: expectation=${turn.expectation}, tools=${observation.toolCalls.length}, transcript_chars=${[...observation.transcript].length}`)
    }
  } finally {
    stop.abort()
    await adapter.close().catch(() => undefined)
  }
  return failures
}

const temporary = mkdtempSync(join(tmpdir(), 'nova-qwen-clarification-'))
const allFailures = []
try {
  for (const testCase of fixture.cases) {
    const caseDirectory = join(temporary, testCase.id)
    mkdirSync(caseDirectory)
    try {
      const failures = await runCase(testCase, caseDirectory)
      allFailures.push(...failures.map(failure => `${testCase.id}: ${failure}`))
    } catch (error) {
      allFailures.push(`${testCase.id}: ${error.message}`)
    }
  }
} finally {
  rmSync(temporary, {recursive: true, force: true})
}

if (allFailures.length > 0) {
  for (const failure of allFailures) console.error(`FAIL ${failure}`)
  process.exit(1)
}
console.log(`Qwen Codex clarification voice smoke passed (${fixture.cases.length} cases)`)
