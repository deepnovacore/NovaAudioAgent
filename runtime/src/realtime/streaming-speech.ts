import {prepareForSpeech} from './speech-prep.js'
import {MAX_REALTIME_TEXT} from './protocol.js'

// ponytail: handles voice-facing Markdown, not full CommonMark; use a parser if arbitrary documents become input.
/** Per-response presentation only: never changes displayed text or tool arguments. */
export class StreamingSpeech {
  #pending = ''
  #lineStart = true

  push(text: string): string {
    this.#pending += text
    if (this.#pending.length > MAX_REALTIME_TEXT * 2) throw new RangeError('speech buffer overflow')
    return this.#drain(false)
  }

  finish(): string { return this.#drain(true) }

  #drain(final: boolean): string {
    let result = ''
    const clean = (text: string) => prepareForSpeech(text, {limit: MAX_REALTIME_TEXT}).text
    const take = (length: number, spoken?: string) => {
      const raw = this.#pending.slice(0, length)
      this.#pending = this.#pending.slice(length)
      result += spoken ?? raw
      this.#lineStart = raw.endsWith('\n') || (this.#lineStart && /^[ \t]*$/u.test(raw))
    }
    while (this.#pending) {
      const text = this.#pending
      if (this.#lineStart) {
        if (!final && /^(?:-{1,}|_{1,}|\*{1,}|~{1,})[ \t]*$/u.test(text)) break
        const rule = /^(?:-{3,}|_{3,}|\*{3,})[ \t]*(?:\n|$)/u.exec(text)
        if (rule) {take(rule[0].length, ' '); continue}
        if (!final && /^[ \t]*(?:#{1,6}|>|[-+]|\d+[.)]?)?$/u.test(text)) break
        const prefix = /^[ \t]*(?:#{1,6}[ \t]+|>[ \t]+|[-+][ \t]+|\d+[.)][ \t]+)/u.exec(text)
        if (prefix) {take(prefix[0].length, ''); this.#lineStart = true; continue}
        if (/^[ \t]*\|/u.test(text)) {
          const end = text.indexOf('\n')
          if (end < 0 && !final) break
          const row = text.slice(0, end < 0 ? text.length : end + 1)
          take(row.length, /^[\s|:-]+$/u.test(row) ? ' ' : clean(row) + ' ')
          continue
        }
      }
      if (text.startsWith('`') || text.startsWith('~~~')) {
        const ticks = /^(?:`+|~+)/u.exec(text)![0]
        if (ticks.length === text.length && !final) break
        const end = text.indexOf(ticks, ticks.length)
        if (end < 0 && !final) break
        const length = end < 0 ? text.length : end + ticks.length
        take(length, ticks.length >= 3 ? '（代码示例略）' : clean(text.slice(ticks.length, end < 0 ? undefined : end)))
        continue
      }
      if (text.startsWith('[') || text.startsWith('![') || text === '!') {
        const close = text.indexOf(']')
        if ((close < 0 || close === text.length - 1) && !final) break
        if (close >= 0 && text[close + 1] === '(') {
          let depth = 1, end = close + 2
          for (; end < text.length && depth; end++) {
            if (text[end] === '\\') {end++; continue}
            if (text[end] === '(') depth++
            if (text[end] === ')') depth--
          }
          if (depth && !final) break
          take(end, clean(text.slice(text.startsWith('![') ? 2 : 1, close)))
          continue
        }
        if (close < 0 && final && text.startsWith('[')) {take(text.length, clean(text.slice(1))); continue}
        if (close >= 0) {take(close + 1, clean(text.slice(text.startsWith('![') ? 2 : 1, close))); continue}
      }
      if (!final && ['http://', 'https://'].some(prefix => prefix.startsWith(text))) break
      if (/^https?:\/\//u.test(text)) {
        const end = text.search(/[\s，。、；：！？（）【】「」]/u)
        if (end < 0 && !final) break
        take(end < 0 ? text.length : end, '（链接略）')
        continue
      }
      if (text.startsWith('*') || text.startsWith('_')) {take(1, ''); continue}
      if (text === '~' && !final) break
      if (text.startsWith('~~')) {take(2, ''); continue}
      // Preserve a surrogate pair when an upstream stream splits UTF-16 units.
      if (text.length === 1 && /[\uD800-\uDBFF]/u.test(text) && !final) break
      const point = String.fromCodePoint(text.codePointAt(0)!)
      take(point.length)
    }
    return result
  }
}
