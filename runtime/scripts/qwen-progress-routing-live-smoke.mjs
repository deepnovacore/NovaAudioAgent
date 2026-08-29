/**
 * macOS-only, credential-gated Chinese routing smoke for the real Qwen realtime model.
 * It synthesizes the fixture utterances locally, feeds PCM through smart-turn VAD, and
 * verifies active-context, Memory-first, and no-evidence fallback routing. It also
 * rejects pre-tool filler and verbose/internal status narration. No audio, transcript,
 * tool output, or credential is persisted.
 */

import {spawnSync} from 'node:child_process'
import {mkdirSync, mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {QwenAudioRealtimeAdapter} from '../dist/src/realtime/qwen.js'
import {webSocketQwenConnector} from '../dist/src/realtime/qwen-transport.js'

const repositoryRoot = resolve(import.meta.dirname, '../..')
const fixture = JSON.parse(readFileSync(resolve(
  repositoryRoot,
  'fixtures/realtime/qwen/v1/progress-routing.json',
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
  console.error('Chinese routing smoke requires macOS say and afconvert')
  process.exit(2)
}

const url = setting('NOVA_AUDIO_AGENT_QWEN_REALTIME_URL')
  ?? 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime'
const model = setting('NOVA_AUDIO_AGENT_QWEN_REALTIME_MODEL') ?? 'qwen-audio-3.0-realtime-plus'
const voice = setting('NOVA_AUDIO_AGENT_QWEN_REALTIME_VOICE') ?? 'longanqian'
const statusTool = {
  type: 'function',
  function: {
    name: 'codex__status',
    description: '仅在用户明确询问 Codex 存活或终态时查询一次',
    parameters: {type: 'object', properties: {}, additionalProperties: false},
  },
}
const memoryTool = {
  type: 'function',
  function: {
    name: 'memory__recall',
    description: '从当前会话的历史记忆中查找与用户问题相关的证据',
    parameters: {
      type: 'object',
      properties: {
        query: {type: 'string', minLength: 1, maxLength: 512},
        scope: {type: 'string', enum: ['recent', 'any']},
      },
      required: ['query', 'scope'],
      additionalProperties: false,
    },
  },
}

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

function synthesize(text, directory) {
  const aiff = join(directory, 'query.aiff')
  const wav = join(directory, 'query.wav')
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
        timer = setTimeout(() => reject(new Error('routing smoke timed out')), milliseconds)
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

async function runCase(testCase, pcm) {
  const adapter = new QwenAudioRealtimeAdapter({url, apiKey, model, voice, connector: webSocketQwenConnector})
  const stop = new AbortController()
  const events = []
  let toolOutputs = 0
  let failure
  try {
    const identity = await adapter.connect({tools: [memoryTool, statusTool], signal: stop.signal})
    const context = fixture.contexts[testCase.context]
    if (typeof context !== 'string') throw new Error(`${testCase.id}: missing context fixture`)
    await adapter.injectWorkspaceContext({
      kind: 'workspace_context',
      host_item_id: `routing-context-${testCase.id}`,
      event_id: `routing-context-event-${testCase.id}`,
      content: context,
      call_id: null,
      session_epoch: identity.epoch,
      workspace_instance_id: 'routing-smoke-workspace',
      revision: 1,
    }, {confirmationTimeout: 10, signal: stop.signal})

    const terminal = (async () => {
      let callsInResponse = 0
      for await (const event of adapter.events(stop.signal)) {
        events.push(event)
        if (event.kind === 'provider_error') throw new Error(`provider error: ${event.code}`)
        if (event.kind === 'tool_call_ready') {
          let content
          if (event.name === 'memory__recall') {
            content = testCase.memory_evidence
              ? {
                  query: '当前任务进度', raw_scanned: 1, searched_count: 1,
                  matches: [{channel: 'codex', phase: 'working', summary: '正在运行定向测试', elapsed_s: 17}],
                }
              : {query: '当前任务进度', raw_scanned: 0, searched_count: 0, matches: []}
          } else if (event.name === 'codex__status') {
            content = {
              state: 'running', summary: '正在运行定向测试', elapsed_s: 21,
              process: 'codex-internal-process', protocol: 'internal-v2',
              preflight: 'completed', prewarm: 'completed',
            }
          } else {
            throw new Error(`${testCase.id}: unexpected tool ${event.name}`)
          }
          toolOutputs += 1
          callsInResponse += 1
          await adapter.injectHostItem({
            kind: 'tool_output',
            host_item_id: `routing-output-${testCase.id}-${toolOutputs}`,
            event_id: `routing-output-event-${testCase.id}-${toolOutputs}`,
            content: JSON.stringify(content),
            call_id: event.call_id,
          }, {confirmationTimeout: 10, asUserActivation: false, signal: stop.signal})
        }
        if (event.kind === 'response_terminal') {
          if (callsInResponse > 0) {
            callsInResponse = 0
            await adapter.ensureResponse(stop.signal)
            continue
          }
          return
        }
      }
      throw new Error('provider event stream ended before a response terminal')
    })()
    await feed(adapter, pcm, stop.signal)
    await within(terminal, 45_000)
  } catch (error) {
    failure = error
  } finally {
    stop.abort()
    await adapter.close().catch(() => undefined)
  }
  if (failure) throw failure
  const statusCalls = events.filter(event => (
    event.kind === 'tool_call_ready' && event.name === 'codex__status'
  )).length
  const recallCalls = events.filter(event => (
    event.kind === 'tool_call_ready' && event.name === 'memory__recall'
  )).length
  if (statusCalls < testCase.min_status_calls || statusCalls > testCase.max_status_calls) {
    throw new Error(`${testCase.id}: expected ${testCase.min_status_calls}..${testCase.max_status_calls} status calls, got ${statusCalls}`)
  }
  if (recallCalls < testCase.min_recall_calls || recallCalls > testCase.max_recall_calls) {
    throw new Error(`${testCase.id}: expected ${testCase.min_recall_calls}..${testCase.max_recall_calls} recall calls, got ${recallCalls}`)
  }
  const transcript = events
    .filter(event => event.kind === 'response_transcript_delta')
    .map(event => event.text)
    .join('')
  const firstToolIndex = events.findIndex(event => event.kind === 'tool_call_ready')
  if (testCase.min_recall_calls + testCase.min_status_calls > 0 && firstToolIndex >= 0) {
    const preToolSpeech = events.slice(0, firstToolIndex).some(event => (
      (event.kind === 'response_transcript_delta' && event.text.trim() !== '')
      || event.kind === 'response_audio_delta'
    ))
    if (preToolSpeech) throw new Error(`${testCase.id}: pre-tool filler was generated`)
  }
  const normalizedTranscript = transcript.toLocaleLowerCase('zh-CN')
  for (const term of fixture.forbidden_transcript_terms) {
    if (normalizedTranscript.includes(term.toLocaleLowerCase('zh-CN'))) {
      throw new Error(`${testCase.id}: forbidden status detail leaked: ${term}`)
    }
  }
  if ([...transcript].length > fixture.max_transcript_codepoints) {
    throw new Error(`${testCase.id}: response is too verbose (${[...transcript].length} code points)`)
  }
  console.log(`${testCase.id}: recall_calls=${recallCalls}, status_calls=${statusCalls}, transcript_chars=${[...transcript].length}`)
}

const temporary = mkdtempSync(join(tmpdir(), 'nova-qwen-routing-'))
try {
  for (const testCase of fixture.cases) {
    const caseDirectory = join(temporary, testCase.id)
    mkdirSync(caseDirectory)
    await runCase(testCase, synthesize(testCase.utterance, caseDirectory))
  }
  console.log('Qwen Chinese progress routing smoke passed')
} finally {
  rmSync(temporary, {recursive: true, force: true})
}
