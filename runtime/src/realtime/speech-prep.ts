export const SPEECH_FINAL_LIMIT = 600

const FENCE = /```[\s\S]*?```/gu
const UNCLOSED_FENCE = /```[a-zA-Z0-9_+#-]*\s*/gu
const INLINE_CODE = /`([^`\n]*)`/gu
const IMAGE = /!\[([^\]]*)\]\([^)]*\)/gu
const LINK = /\[([^\]]*)\]\([^)]*\)/gu
const BARE_URL = /https?:\/\/[^\s，。、；：！？（）【】「」]+/gu
const HEX_RUN = /\b[0-9a-fA-F]{32,}\b/gu
const HEADING = /(?:^|(?<=\s))#{1,6}\s+/gu
const EMPHASIS = /\*{1,3}|_{2,}/gu
const LIST_MARKER = /(?:^|(?<=\s))[-*]\s+/gu
const RULE_RUN = /-{3,}/gu
const ARROW = /[←→↑↓⇐⇒]|->|=>/gu
const WHITESPACE = /\s+/gu

const CODE_PLACEHOLDER = '（代码示例略）'
const LINK_PLACEHOLDER = '（链接略）'

export function prepareForSpeech(
  text: string,
  options: {readonly limit: number},
): {readonly text: string; readonly truncated: boolean} {
  let prepared = text.replace(FENCE, CODE_PLACEHOLDER)
  prepared = prepared.replace(UNCLOSED_FENCE, ' ')
  prepared = prepared.replace(INLINE_CODE, '$1')
  prepared = prepared.replace(IMAGE, '$1')
  prepared = prepared.replace(LINK, '$1')
  prepared = prepared.replace(BARE_URL, LINK_PLACEHOLDER)
  prepared = prepared.replace(HEX_RUN, '')
  prepared = prepared.replace(HEADING, '')
  prepared = prepared.replace(EMPHASIS, '')
  prepared = prepared.replaceAll('|', ' ')
  prepared = prepared.replace(RULE_RUN, ' ')
  prepared = prepared.replace(LIST_MARKER, '')
  prepared = prepared.replace(ARROW, ' ')
  prepared = prepared.replace(WHITESPACE, ' ').trim()

  const characters = [...prepared]
  if (characters.length <= options.limit) return {text: prepared, truncated: false}
  return {text: characters.slice(0, options.limit).join(''), truncated: true}
}
