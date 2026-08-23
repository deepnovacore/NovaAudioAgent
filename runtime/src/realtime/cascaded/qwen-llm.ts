import type { Clock } from '../../clock.js'
import type { JsonObject } from '../protocol.js'
import { codePointLengthLikePython } from '../../python-text.js'
import type { JsonValue } from '../../events.js'
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

export type QwenCascadedLlmFailureCode = 'configuration' | 'aborted' | 'timeout' | 'protocol' | 'overflow' | 'closed' | 'network' | 'http'
export class QwenCascadedLlmFailure extends Error {
  constructor(readonly code: QwenCascadedLlmFailureCode, readonly statusCode: number | null = null) {
    super(`Qwen cascaded LLM ${code} failure`)
    this.name = 'QwenCascadedLlmFailure'
  }
}

export interface QwenCascadedLlmFactoryOptions {
  readonly baseUrl: string; readonly apiKey: string; readonly model: string; readonly instructions: string
  readonly fetchImpl?: typeof globalThis.fetch; readonly idFactory?: () => string; readonly clock?: Clock
  readonly idleTimeoutMs?: number; readonly closeTimeoutMs?: number
}
interface Call { readonly id: string; readonly type: 'function'; readonly function: {readonly name: string; readonly arguments: string} }
interface Message { readonly role: 'system' | 'user' | 'assistant' | 'tool'; readonly content: string | null; readonly tool_calls?: readonly Call[]; readonly tool_call_id?: string }
interface Fragment { id: string | null; name: string; arguments: string }
interface Active { readonly controller: AbortController; reader: ReadableStreamDefaultReader<Uint8Array> | null; failureCode: QwenCascadedLlmFailureCode | null }

function fail(code: QwenCascadedLlmFailureCode, statusCode: number | null = null): QwenCascadedLlmFailure { return new QwenCascadedLlmFailure(code, statusCode) }
function object(value: unknown): value is Record<string, unknown> { return value !== null && !Array.isArray(value) && typeof value === 'object' }
function jsonObject(value: unknown): value is JsonObject { return object(value) }
function id(value: unknown): value is string { return typeof value === 'string' && value.length > 0 }
function copy(value: JsonValue): JsonValue { return structuredClone(value) }
function endpoint(baseUrl: string): string { try { const url = new URL(baseUrl); url.pathname = `${url.pathname.replace(/\/+$/u, '')}/chat/completions`; return url.toString() } catch { throw fail('configuration') } }
function message(input: CascadedLlmInput): Message { return input.kind === 'tool_result' ? {role: 'tool', content: JSON.stringify(copy(input.output)), tool_call_id: input.call_id} : {role: 'user', content: input.kind === 'user_text' ? input.text : input.content} }
function schema(tool: CascadedLlmTool): JsonObject { return {type: 'function', function: {name: tool.name, ...(tool.description === undefined ? {} : {description: tool.description}), parameters: copy(tool.parameters)}} }
function size(units: readonly (readonly Message[])[]): {items: number; codepoints: number} { const all = units.flat(); return {items: all.length, codepoints: all.reduce((sum, item) => sum + codePointLengthLikePython(JSON.stringify(item)), 0)} }

class Session implements CascadedLlmSession {
  readonly #endpoint: string; readonly #apiKey: string; readonly #model: string; readonly #instructions: string; readonly #fetch: typeof fetch
  readonly #idleTimeoutMs: number; readonly #closeTimeoutMs: number; readonly #active = new Set<Active>()
  #history: Message[][] = []; #unresolved: Message[] | null = null; #closed = false; #closePromise: Promise<void> | null = null
  constructor(options: QwenCascadedLlmFactoryOptions) {
    if (!options.apiKey || !options.model || !options.instructions) throw fail('configuration')
    this.#endpoint = endpoint(options.baseUrl); this.#apiKey = options.apiKey; this.#model = options.model; this.#instructions = options.instructions; this.#fetch = options.fetchImpl ?? globalThis.fetch
    this.#idleTimeoutMs = options.idleTimeoutMs ?? 30_000; this.#closeTimeoutMs = options.closeTimeoutMs ?? 1_000
    if (!Number.isFinite(this.#idleTimeoutMs) || this.#idleTimeoutMs <= 0 || !Number.isFinite(this.#closeTimeoutMs) || this.#closeTimeoutMs <= 0) throw fail('configuration')
  }
  async *stream(input: {readonly inputs: readonly CascadedLlmInput[]; readonly tools: readonly CascadedLlmTool[]; readonly signal: AbortSignal}): AsyncIterable<CascadedLlmEvent> {
    if (this.#closed) throw fail('closed'); if (input.signal.aborted) throw fail('aborted')
    const current = input.inputs.map(message), unresolved = this.#unresolved
    if (unresolved === null && input.inputs.some(item => item.kind === 'tool_result')) throw fail('protocol')
    if (unresolved !== null) this.#checkResults(input.inputs, unresolved)
    this.#trim(unresolved ?? [])
    const messages = [{role: 'system' as const, content: this.#instructions}, ...this.#history.flat(), ...(unresolved ?? []), ...current]
    const body: Record<string, JsonValue> = {model: this.#model, messages: messages as unknown as JsonValue, stream: true, stream_options: {include_usage: true}}
    if (input.tools.length > 0) { body.tools = input.tools.map(schema); body.parallel_tool_calls = false }
    const active: Active = {controller: new AbortController(), reader: null, failureCode: null}
    const stop = (): void => { active.failureCode ??= 'aborted'; active.controller.abort(); void this.#cancel(active.reader) }
    input.signal.addEventListener('abort', stop, {once: true}); this.#active.add(active)
    let responseId: string | null = null, terminal = false
    try {
      let response: Response
      try { response = await this.#timed(this.#fetch(this.#endpoint, {method: 'POST', headers: {authorization: `Bearer ${this.#apiKey}`, 'content-type': 'application/json', accept: 'text/event-stream'}, body: JSON.stringify(body), signal: active.controller.signal}), active) }
      catch (error) { if (error instanceof QwenCascadedLlmFailure) throw error; throw fail(input.signal.aborted ? 'aborted' : this.#closed ? 'closed' : 'network') }
      if (!response.ok) { await this.#cancel(response.body?.getReader() ?? null); throw fail('http', response.status) }
      if (response.body === null || !response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) { await this.#cancel(response.body?.getReader() ?? null); throw fail('protocol') }
      active.reader = response.body.getReader()
      let started = false, text = '', sawText = false
      const fragments = new Map<number, Fragment>()
      for await (const event of this.#events(active)) {
        if (event.id !== undefined) {
          if (!id(event.id) || (responseId !== null && responseId !== event.id)) throw fail('protocol')
          responseId ??= event.id
        }
        if (!Array.isArray(event.choices)) continue
        for (const choice of event.choices) {
          if (!object(choice) || !object(choice.delta)) throw fail('protocol')
          const content = choice.delta.content, calls = choice.delta.tool_calls
          if (content !== undefined && typeof content !== 'string') throw fail('protocol'); if (calls !== undefined && !Array.isArray(calls)) throw fail('protocol')
          if (!started && (content !== undefined || calls !== undefined || choice.finish_reason !== undefined)) { if (responseId === null) throw fail('protocol'); started = true; yield {kind: 'response_started', response_id: responseId} }
          if (content !== undefined) sawText = true
          if (typeof content === 'string' && content !== '') { text += content; yield {kind: 'text_delta', text: content} }
          for (const call of calls ?? []) this.#fragment(fragments, call)
          if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
            if (typeof choice.finish_reason !== 'string' || responseId === null) throw fail('protocol')
            if (choice.finish_reason === 'stop') {
              if (fragments.size > 0) throw fail('protocol')
              this.#history.push([...(unresolved ?? []), ...current, {role: 'assistant', content: text}])
              this.#unresolved = null; terminal = true
              yield {kind: 'response_completed', response_id: responseId}; return
            } else if (choice.finish_reason === 'tool_calls') {
              if (sawText || fragments.size === 0) throw fail('protocol'); const callsOut = this.#calls(fragments)
              for (const call of callsOut) yield {kind: 'tool_call', item_id: call.id, call_id: call.id, name: call.function.name, arguments: JSON.parse(call.function.arguments) as JsonObject}
              this.#unresolved = [...(unresolved ?? []), ...current, {role: 'assistant', content: null, tool_calls: callsOut}]
              terminal = true; yield {kind: 'response_completed', response_id: responseId}; return
            } else throw fail('protocol')
          }
        }
      }
      if (!terminal) throw fail(active.failureCode ?? (this.#closed ? 'closed' : input.signal.aborted ? 'aborted' : 'protocol'))
    } catch (error) {
      const stable = error instanceof QwenCascadedLlmFailure
        ? error : fail(active.failureCode ?? (this.#closed ? 'closed' : input.signal.aborted ? 'aborted' : 'network'))
      if (responseId !== null && !terminal) {
        yield {kind: 'response_failed', response_id: responseId, code: stable.code}
        return
      }
      throw stable
    } finally { input.signal.removeEventListener('abort', stop); await this.#cancel(active.reader); this.#active.delete(active) }
  }
  #fragment(fragments: Map<number, Fragment>, value: unknown): void {
    if (!object(value) || typeof value.index !== 'number' || !Number.isSafeInteger(value.index) || value.index !== 0 || (value.function !== undefined && !object(value.function))) throw fail('protocol')
    const index = value.index
    const found = fragments.get(index) ?? {id: null, name: '', arguments: ''}
    if (value.id !== undefined) { if (!id(value.id) || (found.id !== null && found.id !== value.id)) throw fail('protocol'); found.id = value.id }
    const fn = value.function
    if (fn !== undefined) { if (fn.name !== undefined) { if (typeof fn.name !== 'string') throw fail('protocol'); found.name += fn.name }; if (fn.arguments !== undefined) { if (typeof fn.arguments !== 'string') throw fail('protocol'); found.arguments += fn.arguments } }
    fragments.set(index, found)
  }
  #calls(fragments: ReadonlyMap<number, Fragment>): Call[] { if (fragments.size !== 1 || !fragments.has(0)) throw fail('protocol'); return [...fragments.entries()].map(([, part]) => { if (!id(part.id) || !id(part.name)) throw fail('protocol'); let args: unknown; try { args = JSON.parse(part.arguments) } catch { throw fail('protocol') }; if (!jsonObject(args)) throw fail('protocol'); return {id: part.id, type: 'function', function: {name: part.name, arguments: JSON.stringify(copy(args))}} }) }
  #checkResults(inputs: readonly CascadedLlmInput[], unresolved: readonly Message[]): void {
    const calls = (unresolved.at(-1)?.tool_calls ?? []).map(item => item.id).sort(), results = inputs.filter((item): item is Extract<CascadedLlmInput, {kind: 'tool_result'}> => item.kind === 'tool_result').map(item => item.call_id).sort()
    if (calls.length === 0 || calls.length !== results.length || calls.some((call, index) => call !== results[index]) || results.length !== inputs.length) throw fail('protocol')
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
      let read: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>; try { read = await this.#timed(reader.read(), active) } catch (error) { if (error instanceof QwenCascadedLlmFailure) throw error; throw fail(active.controller.signal.aborted ? this.#closed ? 'closed' : 'aborted' : 'network') }
      if (read.done) { if (buffered.length > 0) { const event = line(buffered); if (event !== null && event !== 'done') yield event }; const event = line(new Uint8Array()); if (event !== null && event !== 'done') yield event; return }
      if (!(read.value instanceof Uint8Array)) throw fail('protocol'); total += read.value.length; if (total > MAX_RESPONSE_BYTES) throw fail('overflow'); const next = new Uint8Array(buffered.length + read.value.length); next.set(buffered); next.set(read.value); buffered = next
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
  async #timed<T>(promise: Promise<T>, active: Active): Promise<T> { let timer: ReturnType<typeof setTimeout> | undefined; try { return await Promise.race([promise, new Promise<T>((_resolve, reject) => { timer = setTimeout(() => { active.failureCode ??= 'timeout'; active.controller.abort(); void this.#cancel(active.reader); reject(fail('timeout')) }, this.#idleTimeoutMs) })]) } finally { if (timer !== undefined) clearTimeout(timer) } }
  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise
    this.#closed = true
    const cancellations = [...this.#active].map(active => {
      active.failureCode ??= 'closed'
      active.controller.abort()
      return this.#cancel(active.reader)
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
export function createQwenCascadedLlmFactory(options: QwenCascadedLlmFactoryOptions): CascadedLlmFactory { return {open: () => new Session(options)} }
