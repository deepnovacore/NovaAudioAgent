import {selfHostedEndpoint} from '../../config/self-hosted.js'
import {committedConversationPairsSchema,type CommittedConversationPair} from '../history.js'
import {translateSystemPrompt, type PromptLanguage} from '../prompt-language.js'
import {cascadedNarrationInstructions} from './llm.js'
import {originalImageUrl} from './llm.js'
import {randomUUID} from 'node:crypto'
import {reportUsage, type UsageReporter, type UsageReport} from '../usage.js'
import type { Clock } from '../../core/clock.js'
import type { JsonObject } from '../protocol.js'
import { codePointLengthLikePython } from '../../text/python-text.js'
import type { JsonValue } from '../../core/events.js'
import {
  MAX_CASCADED_LLM_HISTORY_CODEPOINTS,
  MAX_CASCADED_LLM_HISTORY_ITEMS,
  type CascadedLlmEvent,
  type CascadedLlmFactory,
  type CascadedLlmInput,
  type CascadedLlmSession,
  type CascadedLlmTool,
} from './llm.js'

export {MAX_CASCADED_LLM_HISTORY_CODEPOINTS, MAX_CASCADED_LLM_HISTORY_ITEMS} from './llm.js'
const MAX_LINE_BYTES = 256 * 1024
const MAX_EVENT_BYTES = 512 * 1024
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_EVENTS = 4096

export type ChatCompletionsLlmFailureCode = 'configuration' | 'aborted' | 'timeout' | 'protocol' | 'overflow' | 'closed' | 'network' | 'http'
export class ChatCompletionsLlmFailure extends Error {
  constructor(readonly code: ChatCompletionsLlmFailureCode, readonly statusCode: number | null = null) {
    super(`Chat Completions LLM ${code} failure`)
    this.name = 'ChatCompletionsLlmFailure'
  }
}

export interface ChatCompletionsLlmFactoryOptions {
  readonly provider: 'qwen' | 'deepseek' | 'openai' | 'gemini' | 'self-hosted'
  readonly baseUrl: string; readonly apiKey: string; readonly model: string; readonly instructions: string
  readonly fetchImpl?: typeof globalThis.fetch; readonly idFactory?: () => string; readonly clock?: Clock
  readonly onUsage?: UsageReporter
  readonly idleTimeoutMs?: number; readonly closeTimeoutMs?: number
}
interface Call { readonly id: string; readonly type: 'function'; readonly extra_content?: JsonObject; readonly function: {readonly name: string; readonly arguments: string} }
interface Message { readonly role: 'system' | 'user' | 'assistant' | 'tool'; readonly content: string | readonly JsonObject[] | null; readonly tool_calls?: readonly Call[]; readonly tool_call_id?: string }
interface Fragment { extra_content?: JsonObject; id: string | null; name: string; arguments: string }
interface Active { completion: Promise<void> | null; usageDeadline: number | null; readonly controller: AbortController; reader: ReadableStreamDefaultReader<Uint8Array> | null; failureCode: ChatCompletionsLlmFailureCode | null }

function fail(code: ChatCompletionsLlmFailureCode, statusCode: number | null = null): ChatCompletionsLlmFailure { return new ChatCompletionsLlmFailure(code, statusCode) }
function object(value: unknown): value is Record<string, unknown> { return value !== null && !Array.isArray(value) && typeof value === 'object' }
function jsonObject(value: unknown): value is JsonObject { return object(value) }
function id(value: unknown): value is string { return typeof value === 'string' && value.length > 0 }
function copy(value: JsonValue): JsonValue { return structuredClone(value) }
function endpoint(baseUrl: string): string { try { const url = new URL(baseUrl); url.pathname = `${url.pathname.replace(/\/+$/u, '')}/chat/completions`; return url.toString() } catch { throw fail('configuration') } }
function message(input: CascadedLlmInput): Message { return input.kind === 'tool_result' ? {role: 'tool', content: JSON.stringify(copy(input.output)), tool_call_id: input.call_id} : {role: input.kind === 'user_text' || input.kind === 'host_activation' ? 'user' : 'system', content: input.kind === 'user_text' ? (input.image ? [{type: 'text', text: input.text}, {type: 'image_url', image_url: {url: originalImageUrl(input.image)}}] : input.text) : input.kind === 'host_activation' ? JSON.stringify({text_to_say: input.content}) : input.content} }
function schema(tool: CascadedLlmTool): JsonObject { return {type: 'function', function: {name: tool.name, ...(tool.description === undefined ? {} : {description: tool.description}), parameters: copy(tool.parameters)}} }
function size(units: readonly (readonly Message[])[]): {items: number; codepoints: number} { const all = units.flat(); return {items: all.length, codepoints: all.reduce((sum, item) => sum + codePointLengthLikePython(JSON.stringify(withoutImage(item))), 0)} }

class Session implements CascadedLlmSession {
  readonly #provider: 'qwen' | 'deepseek' | 'openai' | 'gemini' | 'self-hosted'
  readonly #onUsage: UsageReporter | undefined
  readonly #endpoint: string; readonly #apiKey: string; readonly #model: string; readonly #instructions: string; readonly #fetch: typeof fetch
  readonly #idleTimeoutMs: number; readonly #closeTimeoutMs: number; readonly #active = new Set<Active>()
  #started = false; #seeded = false
  #history: Message[][] = []; #unresolved: Message[] | null = null; #closed = false; #closePromise: Promise<void> | null = null
  constructor(options: ChatCompletionsLlmFactoryOptions,history?:readonly CommittedConversationPair[]) {
    this.#provider = options.provider
    this.#onUsage = options.provider === 'self-hosted' ? undefined : options.onUsage
    if ((!options.apiKey && options.provider !== 'self-hosted') || !options.model || !options.instructions) throw fail('configuration')
    this.#endpoint = endpoint(options.provider === 'self-hosted' ? selfHostedEndpoint(options.baseUrl, 'http', 'SELF_HOSTED_LLM_BASE_URL') : options.baseUrl); this.#apiKey = options.apiKey; this.#model = options.model; this.#instructions = options.instructions; this.#fetch = options.fetchImpl ?? globalThis.fetch
    this.#idleTimeoutMs = options.idleTimeoutMs ?? 30_000; this.#closeTimeoutMs = options.closeTimeoutMs ?? 1_000
    if(history!==undefined)this.#seed(history)
    if (!Number.isFinite(this.#idleTimeoutMs) || this.#idleTimeoutMs <= 0 || !Number.isFinite(this.#closeTimeoutMs) || this.#closeTimeoutMs <= 0) throw fail('configuration')
  }
  async *stream(input: {readonly language?: PromptLanguage; readonly inputs: readonly CascadedLlmInput[]; readonly tools: readonly CascadedLlmTool[]; readonly workspaceContext?: string | null; readonly responseAdaptation?: string | null; readonly signal: AbortSignal}): AsyncIterable<CascadedLlmEvent> {
    if (this.#closed) throw fail('closed'); if (input.signal.aborted) throw fail('aborted')
    this.#started = true
    const current = input.inputs.map(message), unresolved = this.#unresolved
    if (unresolved === null && input.inputs.some(item => item.kind === 'tool_result')) throw fail('protocol')
    if (unresolved !== null) this.#checkResults(input.inputs, unresolved)
    this.#trim(unresolved ?? [])
    const factOnly = input.inputs.some(item => item.kind === 'host_activation')
    const systemContent = [factOnly ? cascadedNarrationInstructions(input.language) : translateSystemPrompt(this.#instructions, input.language),
      factOnly ? null : input.workspaceContext, input.responseAdaptation]
      .filter((item): item is string => item !== null && item !== undefined)
      .join('\n\n')
    // Narration reads its own fact, not an unfinished question from a prior conversation turn.
    // Tool-call/result pairs stay intact; the full turn is still recorded for the next user turn.
    const context = factOnly
      ? [...(unresolved?.slice(-1) ?? []),
        ...input.inputs.filter(item => item.kind === 'host_activation' || item.kind === 'tool_result').map(message)]
      : [...this.#history.flat(), ...(unresolved ?? []), ...current]
    // Self-hosted Qwen chat templates accept system messages only at the beginning.
    const messages = this.#provider === 'self-hosted'
      ? [{role:'system' as const,content:[systemContent,...context.filter(item=>item.role==='system').map(item=>typeof item.content === 'string' ? item.content : '')].join('\n\n')},...context.filter(item=>item.role!=='system')]
      : [{role: 'system' as const, content: systemContent}, ...context]
    const body: Record<string, JsonValue> = {model: this.#model, messages: messages as unknown as JsonValue, stream: true, stream_options: {include_usage: true}}
    if (this.#provider === 'deepseek') body.thinking = {type: 'disabled'}
    else if (this.#provider === 'qwen') body.enable_thinking = false
    else if (this.#provider === 'openai') body.reasoning_effort = 'none'
    if (input.tools.length > 0) { body.tools = input.tools.map(schema); if (this.#provider !== 'gemini') body.parallel_tool_calls = false }
    const active: Active = {completion: null, usageDeadline: null, controller: new AbortController(), reader: null, failureCode: null}
    const stop = (): void => { active.failureCode ??= 'aborted'; active.controller.abort(); void this.#cancel(active.reader) }
    input.signal.addEventListener('abort', stop, {once: true}); this.#active.add(active)
    let responseId: string | null = null, terminal = false
    const usageId = randomUUID()
    let usage: Record<string, unknown> | undefined
    let events: AsyncIterator<Record<string, unknown>> | undefined
    const captureUsage = (event: Record<string, unknown>): void => {
      if (object(event.usage)) usage = event.usage
    }
    try {
      let response: Response
      try { response = await this.#timed(this.#fetch(this.#endpoint, {method: 'POST', redirect: this.#provider === 'self-hosted' ? 'error' : 'follow', headers: {...(this.#apiKey ? {authorization: `Bearer ${this.#apiKey}`} : {}), 'content-type': 'application/json', accept: 'text/event-stream'}, body: JSON.stringify(body), signal: active.controller.signal}), active) }
      catch (error) { if (error instanceof ChatCompletionsLlmFailure) throw error; throw fail(input.signal.aborted ? 'aborted' : this.#closed ? 'closed' : 'network') }
      if (!response.ok) { await this.#cancel(response.body?.getReader() ?? null); throw fail('http', response.status) }
      if (response.body === null || !response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) { await this.#cancel(response.body?.getReader() ?? null); throw fail('protocol') }
      active.reader = response.body.getReader()
      let started = false, text = '', sawText = false
      const fragments = new Map<number, Fragment>()
      events = this.#events(active)[Symbol.asyncIterator]()
      while (true) {
        const next = await events.next()
        if (next.done) break
        const event = next.value
        captureUsage(event)
        if (event.id !== undefined) {
          if (!id(event.id) || (responseId !== null && responseId !== event.id)) throw fail('protocol')
          responseId ??= event.id
        }
        if (!Array.isArray(event.choices)) continue
        for (const choice of event.choices) {
          if (!object(choice) || !object(choice.delta)) throw fail('protocol')
          const content = choice.delta.content, calls = choice.delta.tool_calls
          if (content !== undefined && content !== null && typeof content !== 'string') throw fail('protocol'); if (calls !== undefined && !Array.isArray(calls)) throw fail('protocol')
          if (!started && ((input.tools.length === 0 && typeof content === 'string' && content !== '') || (choice.finish_reason !== undefined && choice.finish_reason !== null))) { if (responseId === null) throw fail('protocol'); started = true; yield {kind: 'response_started', response_id: responseId} }
          if (typeof content === 'string' && content !== '') sawText = true
          if (typeof content === 'string' && content !== '') { text += content; if (input.tools.length === 0) yield {kind: 'text_delta', text: content} }
          for (const call of calls ?? []) this.#fragment(fragments, call)
          if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
            if (typeof choice.finish_reason !== 'string' || responseId === null) throw fail('protocol')
            if (choice.finish_reason === 'stop') {
              if (fragments.size > 0) throw fail('protocol')
              // With tools enabled, wait for the response kind before publishing speech.
              if (input.tools.length > 0 && text !== '') yield {kind: 'text_delta', text}
              this.#history.push([...(unresolved ?? []), ...current, {role: 'assistant' as const, content: text}].map(withoutImage))
              this.#unresolved = null; terminal = true
              yield {kind: 'response_completed', response_id: responseId}; return
            } else if (choice.finish_reason === 'tool_calls') {
              if ((sawText && input.tools.length === 0) || fragments.size === 0) throw fail('protocol'); const callsOut = this.#calls(fragments)
              for (const call of callsOut) yield {kind: 'tool_call', item_id: call.id, call_id: call.id, name: call.function.name, arguments: JSON.parse(call.function.arguments) as JsonObject}
              this.#unresolved = [...(unresolved ?? []), ...current, {role: 'assistant', content: null, tool_calls: callsOut}]
              terminal = true; yield {kind: 'response_completed', response_id: responseId}; return
            } else throw fail('protocol')
          }
        }
      }
      if (!terminal) throw fail(active.failureCode ?? (this.#closed ? 'closed' : input.signal.aborted ? 'aborted' : 'protocol'))
    } catch (error) {
      if (terminal) return
      const stable = error instanceof ChatCompletionsLlmFailure
        ? error : fail(active.failureCode ?? (this.#closed ? 'closed' : input.signal.aborted ? 'aborted' : 'network'))
      if (responseId !== null && !terminal) {
        yield {kind: 'response_failed', response_id: responseId, code: stable.code}
        return
      }
      throw stable
    } finally {
      // Receipt of a matching tool result survives interruption of its narration.
      // Preserve the resolved pair; the next user turn must not owe that result again.
      if (!terminal && unresolved !== null) {
        this.#history.push([...unresolved, ...current].map(withoutImage))
        this.#unresolved = null
      }
      const finish = async (): Promise<void> => {
        // Metering outlives semantic ownership; the next voice turn must not wait for this tail.
        if (terminal && this.#onUsage !== undefined && events !== undefined && !active.controller.signal.aborted) {
          active.usageDeadline = Date.now() + Math.min(this.#closeTimeoutMs, 1000)
          try { while (true) { const next = await events.next(); if (next.done) break; captureUsage(next.value) } } catch { /* Metering cannot change a completed response. */ }
        }
        const details = object(usage?.prompt_tokens_details) ? usage.prompt_tokens_details : {}
        const outputDetails = object(usage?.completion_tokens_details) ? usage.completion_tokens_details : {}
        reportUsage(this.#onUsage, {
          id: usageId, service: 'llm', provider: this.#provider, model: this.#model,
          status: terminal && usage !== undefined ? 'complete' : 'missing',
          ...(terminal && usage !== undefined ? {
            inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens,
            cachedTokens: this.#provider === 'deepseek' ? usage.prompt_cache_hit_tokens : details.cached_tokens, reasoningTokens: outputDetails.reasoning_tokens,
          } : {}),
        } as UsageReport)
        input.signal.removeEventListener('abort', stop); await this.#cancel(active.reader); this.#active.delete(active)
      }
      if (terminal && this.#onUsage !== undefined) active.completion = finish()
      else await finish()
    }
  }
  restoreHistory(history:readonly CommittedConversationPair[],signal:AbortSignal):Promise<void> {
    try {signal.throwIfAborted();if(this.#closed||this.#started||this.#seeded)throw fail('protocol');this.#seed(history);return Promise.resolve()}
    catch(error){return Promise.reject(error instanceof Error?error:fail('protocol'))}
  }
  #seed(history:readonly CommittedConversationPair[]):void {
    const pairs=committedConversationPairsSchema.parse(history)
    this.#history=pairs.map(pair=>[{role:'user',content:pair.user},{role:'assistant',content:pair.assistant}])
    this.#seeded=true
    this.#trim([])
  }
  #fragment(fragments: Map<number, Fragment>, value: unknown): void {
    if (!object(value) || typeof value.index !== 'number' || !Number.isSafeInteger(value.index) || value.index !== 0 || (value.function !== undefined && !object(value.function))) throw fail('protocol')
    const index = value.index
    const found = fragments.get(index) ?? {id: null, name: '', arguments: ''}
    // A null id on a later DashScope delta contributes no new identity; final validation still requires an id.
    if (value.id !== undefined && value.id !== null && value.id !== '') { if (!id(value.id) || (found.id !== null && found.id !== value.id)) throw fail('protocol'); found.id = value.id }
    // DashScope may append arguments:null after complete JSON; that delta contributes no bytes.
    const fn = value.function
    if (fn !== undefined) { if (fn.name !== undefined) { if (typeof fn.name !== 'string') throw fail('protocol'); found.name += fn.name }; if (fn.arguments !== undefined && fn.arguments !== null) { if (typeof fn.arguments !== 'string') throw fail('protocol'); found.arguments += fn.arguments } }
    if (this.#provider === 'gemini' && value.extra_content !== undefined) {
      if (!jsonObject(value.extra_content) || JSON.stringify(value.extra_content).length > MAX_EVENT_BYTES) throw fail('protocol')
      if (found.extra_content && JSON.stringify(found.extra_content) !== JSON.stringify(value.extra_content)) throw fail('protocol')
      found.extra_content = structuredClone(value.extra_content)
    }
    fragments.set(index, found)
  }
  #calls(fragments: ReadonlyMap<number, Fragment>): Call[] { if (fragments.size !== 1 || !fragments.has(0)) throw fail('protocol'); return [...fragments.entries()].map(([, part]) => { if (!id(part.id) || !id(part.name)) throw fail('protocol'); let args: unknown; try { args = JSON.parse(part.arguments) } catch { throw fail('protocol') }; if (!jsonObject(args)) throw fail('protocol'); return {id: part.id, type: 'function', ...(part.extra_content ? {extra_content: part.extra_content} : {}), function: {name: part.name, arguments: JSON.stringify(copy(args))}} }) }
  #checkResults(inputs: readonly CascadedLlmInput[], unresolved: readonly Message[]): void {
    const calls = (unresolved.at(-1)?.tool_calls ?? []).map(item => item.id).sort(), results = inputs.filter((item): item is Extract<CascadedLlmInput, {kind: 'tool_result'}> => item.kind === 'tool_result').map(item => item.call_id).sort()
    if (calls.length === 0 || calls.length !== results.length || calls.some((call, index) => call !== results[index]) || inputs.slice(0, results.length).some(item => item.kind !== 'tool_result')) throw fail('protocol')
  }
  abandonPendingResponse(): Promise<void> {
    if (this.#closed) return Promise.reject(fail('closed'))
    this.#unresolved = null
    return Promise.resolve()
  }
  #trim(unresolved: readonly Message[]): void { while (true) { const measured = size([...this.#history, unresolved]); if (measured.items <= MAX_CASCADED_LLM_HISTORY_ITEMS && measured.codepoints <= MAX_CASCADED_LLM_HISTORY_CODEPOINTS) return; if (this.#history.length === 0) throw fail('overflow'); this.#history.shift() } }
  async *#events(active: Active): AsyncIterable<Record<string, unknown>> {
    const reader = active.reader!, decoder = new TextDecoder('utf-8', {fatal: true}); let buffered = new Uint8Array(), total = 0, parts: string[] = [], partBytes = 0, count = 0
    const line = (raw: Uint8Array): Record<string, unknown> | 'done' | null => { let bytes = raw; if (bytes.at(-1) === 13) bytes = bytes.subarray(0, bytes.length - 1); if (bytes.length > MAX_LINE_BYTES) throw fail('overflow'); let text: string; try { text = decoder.decode(bytes) } catch { throw fail('protocol') }; if (text !== '') { if (text.startsWith(':') || !text.startsWith('data:')) return null; const part = text.slice(5).replace(/^ /u, ''); partBytes += new TextEncoder().encode(part).length + (parts.length === 0 ? 0 : 1); if (partBytes > MAX_EVENT_BYTES) throw fail('overflow'); parts.push(part); return null }; if (parts.length === 0) return null; count += 1; if (count > MAX_EVENTS) throw fail('overflow'); const joined = parts.join('\n'); parts = []; partBytes = 0; if (joined === '[DONE]') return 'done'; let parsed: unknown; try { parsed = JSON.parse(joined) } catch { throw fail('protocol') }; if (!object(parsed)) throw fail('protocol'); return parsed }
    while (true) {
      let read: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>; try { read = await this.#timed(reader.read(), active) } catch (error) { if (error instanceof ChatCompletionsLlmFailure) throw error; throw fail(active.controller.signal.aborted ? this.#closed ? 'closed' : 'aborted' : 'network') }
      if (read.done) { if (buffered.length > 0) { const event = line(buffered); if (event !== null && event !== 'done') yield event }; const event = line(new Uint8Array()); if (event !== null && event !== 'done') yield event; return }
      if (!(read.value instanceof Uint8Array)) throw fail('protocol'); total += read.value.length; if (total > MAX_RESPONSE_BYTES) throw fail('overflow'); const next = new Uint8Array(buffered.length + read.value.length); next.set(buffered); next.set(read.value, buffered.length); buffered = next
      let newline = buffered.indexOf(10); while (newline >= 0) { const event = line(buffered.subarray(0, newline)); buffered = buffered.slice(newline + 1); if (event === 'done') return; if (event !== null) yield event; newline = buffered.indexOf(10) }; if (buffered.length > MAX_LINE_BYTES) throw fail('overflow')
    }
  }
  async #cancel(reader: ReadableStreamDefaultReader<Uint8Array> | null): Promise<void> {
    if (reader === null) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        reader.cancel().catch(() => undefined),
        new Promise<void>(resolve => { timer = setTimeout(resolve, this.#closeTimeoutMs) }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  async #timed<T>(promise: Promise<T>, active: Active): Promise<T> { let timer: ReturnType<typeof setTimeout> | undefined; try { return await Promise.race([promise, new Promise<T>((_resolve, reject) => { timer = setTimeout(() => { active.failureCode ??= 'timeout'; active.controller.abort(); void this.#cancel(active.reader); reject(fail('timeout')) }, active.usageDeadline === null ? this.#idleTimeoutMs : Math.max(1, Math.min(this.#idleTimeoutMs, active.usageDeadline - Date.now()))) })]) } finally { if (timer !== undefined) clearTimeout(timer) } }
  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise
    this.#closed = true
    const cancellations = [...this.#active].map(async active => {
      active.failureCode ??= 'closed'
      active.controller.abort()
      await this.#cancel(active.reader)
      await active.completion
    })
    this.#closePromise = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          Promise.allSettled(cancellations),
          new Promise<void>(resolve => { timer = setTimeout(resolve, this.#closeTimeoutMs) }),
        ])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    })()
    return this.#closePromise
  }
}
export function createChatCompletionsLlmFactory(options: ChatCompletionsLlmFactoryOptions): CascadedLlmFactory { return {open: input => new Session(options,input?.history)} }

function withoutImage(message: Message): Message {
  return Array.isArray(message.content) ? {...message, content: (message.content as readonly JsonObject[]).filter(part => part.type === 'text').map(part => typeof part.text === 'string' ? part.text : '').join('\n')} : message
}
