import {
  collapsePythonWhitespace,
  PYTHON_WHITESPACE_REGEX_CLASS,
  stripLikePython,
} from '../python-text.js'
import {isLetterCategory, isNumberCategory} from '../unicode-tables.js'

export const SPEECH_FINAL_LIMIT = 600

const FENCE = /```[\s\S]*?```/gu
const PYTHON_SPACE = `[${PYTHON_WHITESPACE_REGEX_CLASS}]`
const UNCLOSED_FENCE = new RegExp(`\`\`\`[a-zA-Z0-9_+#-]*${PYTHON_SPACE}*`, 'gu')
const INLINE_CODE = /`([^`\n]*)`/gu
const IMAGE = /!\[([^\]]*)\]\([^)]*\)/gu
const LINK = /\[([^\]]*)\]\([^)]*\)/gu
const BARE_URL = new RegExp(
  `https?:\\/\\/[^${PYTHON_WHITESPACE_REGEX_CLASS}，。、；：！？（）【】「」]+`,
  'gu',
)
const HEX_RUN = /[0-9a-fA-F]{32,}/gu
const HEADING = new RegExp(`(?:^|(?<=${PYTHON_SPACE}))#{1,6}${PYTHON_SPACE}+`, 'gu')
const EMPHASIS = /\*{1,3}|_{2,}/gu
const LIST_MARKER = new RegExp(`(?:^|(?<=${PYTHON_SPACE}))[-*]${PYTHON_SPACE}+`, 'gu')
const RULE_RUN = /-{3,}/gu
const ARROW = /[←→↑↓⇐⇒]|->|=>/gu

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
  prepared = prepared.replace(HEX_RUN, (match, offset: number, source: string) => (
    isPythonWord(previousCharacter(source, offset))
      || isPythonWord(nextCharacter(source, offset + match.length))
      ? match
      : ''
  ))
  prepared = prepared.replace(HEADING, '')
  prepared = prepared.replace(EMPHASIS, '')
  prepared = prepared.replaceAll('|', ' ')
  prepared = prepared.replace(RULE_RUN, ' ')
  prepared = prepared.replace(LIST_MARKER, '')
  prepared = prepared.replace(ARROW, ' ')
  prepared = stripLikePython(collapsePythonWhitespace(prepared))

  const characters = [...prepared]
  if (characters.length <= options.limit) return {text: prepared, truncated: false}
  return {text: characters.slice(0, options.limit).join(''), truncated: true}
}

function previousCharacter(text: string, offset: number): string | undefined {
  if (offset <= 0) return undefined
  const trailing = text.charCodeAt(offset - 1)
  if (trailing >= 0xdc00 && trailing <= 0xdfff && offset >= 2) {
    const leading = text.charCodeAt(offset - 2)
    if (leading >= 0xd800 && leading <= 0xdbff) return text.slice(offset - 2, offset)
  }
  return text.slice(offset - 1, offset)
}

function nextCharacter(text: string, offset: number): string | undefined {
  const codePoint = text.codePointAt(offset)
  return codePoint === undefined ? undefined : String.fromCodePoint(codePoint)
}

function isPythonWord(character: string | undefined): boolean {
  if (character === undefined || character === '') return false
  const codePoint = character.codePointAt(0)!
  return character === '_' || isLetterCategory(codePoint) || isNumberCategory(codePoint)
}
