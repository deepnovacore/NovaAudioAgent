import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

// electron-builder.yml is small and structurally simple (two-space indents,
// no anchors/aliases, no flow collections except the `[a, b]` target lists),
// so a hand-rolled block parser is enough to assert its shape without adding
// a YAML dependency. It only needs to answer: which top-level key is a line
// under, and what are this key's scalar/list/mapping values.

const CONFIG_PATH = resolve(import.meta.dirname, '../electron-builder.yml')

function indentOf(line) {
  const match = /^( *)/.exec(line)
  return match[1].length
}

// Strips full-line and trailing comments outside of quotes. Good enough for
// this file: no `#` ever appears inside a quoted value here.
function stripComment(line) {
  const hashIndex = line.indexOf('#')
  if (hashIndex === -1) return line
  return line.slice(0, hashIndex)
}

// Parses the flat subset of YAML this file uses into a plain JS tree: maps,
// lists of scalars, lists of maps (for extraResources' `- from:/to:` items),
// and inline `[a, b]` lists.
function parseYaml(text) {
  const rawLines = text.split('\n')
  const lines = []
  for (const raw of rawLines) {
    const stripped = stripComment(raw)
    if (stripped.trim() === '') continue
    lines.push({ indent: indentOf(stripped), text: stripped.trim() })
  }

  let pos = 0

  function parseInlineList(value) {
    const inner = value.slice(1, -1).trim()
    if (inner === '') return []
    return inner.split(',').map((item) => parseScalar(item.trim()))
  }

  function parseScalar(value) {
    if (value.startsWith('[') && value.endsWith(']')) return parseInlineList(value)
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      return value.slice(1, -1)
    }
    if (value === 'true') return true
    if (value === 'false') return false
    return value
  }

  // Parses every line whose indent is >= minIndent into a block (map or
  // list), stopping as soon as a line falls back below minIndent.
  function parseBlock(minIndent) {
    if (pos >= lines.length || lines[pos].indent < minIndent) return {}
    const blockIndent = lines[pos].indent
    const isList = lines[pos].text.startsWith('- ') || lines[pos].text === '-'

    if (isList) {
      const items = []
      while (pos < lines.length && lines[pos].indent === blockIndent && lines[pos].text.startsWith('-')) {
        const rest = lines[pos].text.slice(1).trim()
        if (rest === '') {
          pos += 1
          items.push(parseBlock(blockIndent + 1))
          continue
        }
        // `- key: value` starts a map item whose first key is inline.
        const colonIndex = rest.indexOf(':')
        if (colonIndex !== -1 && !rest.startsWith('[')) {
          const key = rest.slice(0, colonIndex).trim()
          const valuePart = rest.slice(colonIndex + 1).trim()
          const item = {}
          pos += 1
          if (valuePart === '') {
            Object.assign(item, { [key]: parseBlock(blockIndent + 2) })
          } else {
            item[key] = parseScalar(valuePart)
          }
          // Sibling keys of this map item, indented past the `-`.
          const itemIndent = blockIndent + 2
          while (pos < lines.length && lines[pos].indent === itemIndent) {
            const siblingText = lines[pos].text
            const siblingColon = siblingText.indexOf(':')
            const siblingKey = siblingText.slice(0, siblingColon).trim()
            const siblingValue = siblingText.slice(siblingColon + 1).trim()
            pos += 1
            if (siblingValue === '') {
              item[siblingKey] = parseBlock(itemIndent + 2)
            } else {
              item[siblingKey] = parseScalar(siblingValue)
            }
          }
          items.push(item)
        } else {
          pos += 1
          items.push(parseScalar(rest))
        }
      }
      return items
    }

    const map = {}
    while (pos < lines.length && lines[pos].indent === blockIndent) {
      const text = lines[pos].text
      const colonIndex = text.indexOf(':')
      assert.ok(colonIndex !== -1, `expected "key: value" at line: ${text}`)
      const key = text.slice(0, colonIndex).trim()
      const valuePart = text.slice(colonIndex + 1).trim()
      pos += 1
      if (valuePart === '') {
        map[key] = parseBlock(blockIndent + 1)
      } else {
        map[key] = parseScalar(valuePart)
      }
    }
    return map
  }

  return parseBlock(0)
}

let config

test.before(async () => {
  const text = await readFile(CONFIG_PATH, 'utf8')
  config = parseYaml(text)
})

test('mac, win, and linux platform blocks all exist', () => {
  assert.ok(config.mac, 'expected a mac: block')
  assert.ok(config.win, 'expected a win: block')
  assert.ok(config.linux, 'expected a linux: block')
})

test('each platform targets exactly what packaging expects', () => {
  assert.deepEqual(config.mac.target, ['dir'])
  assert.deepEqual(config.win.target, ['nsis'])
  assert.deepEqual(config.linux.target, ['AppImage', 'deb'])
})

test('mac points at the generated .icns and win at the generated .ico', () => {
  assert.equal(config.mac.icon, 'build/icon.icns')
  assert.equal(config.win.icon, 'build/icon.ico')
})

test('linux is described for packaging: category, icon dir, executable name, synopsis', () => {
  assert.equal(config.linux.category, 'Utility')
  assert.equal(config.linux.icon, 'build/icons')
  assert.equal(config.linux.executableName, 'nova-ambient-orb')
  assert.equal(config.linux.synopsis, 'Nova ambient voice orb')
})

test('nsis is a per-user, non-silent installer', () => {
  assert.equal(config.nsis.oneClick, false)
  assert.equal(config.nsis.perMachine, false)
})

test('deb recommends the CJK font package the tray/UI needs', () => {
  assert.deepEqual(config.deb.recommends, ['fonts-noto-cjk'])
})

test('the Swift AEC helper resource is scoped to mac only, not top-level', () => {
  const topLevelHasHelper = (config.extraResources ?? []).some(
    (entry) => entry.from === 'build/macos_voice_io',
  )
  assert.equal(topLevelHasHelper, false, 'the macOS-only helper must not be top-level (win/linux builds would fail on the missing file)')

  const macHasHelper = (config.mac.extraResources ?? []).some(
    (entry) => entry.from === 'build/macos_voice_io' && entry.to === 'native/macos_voice_io',
  )
  assert.ok(macHasHelper, 'expected the Swift helper extraResources entry under mac:')
})

test('the tray icon resource stays top-level for every platform', () => {
  const topLevelHasTray = (config.extraResources ?? []).some(
    (entry) => entry.from === 'resources/tray' && entry.to === 'tray',
  )
  assert.ok(topLevelHasTray, 'expected resources/tray -> tray to remain a top-level extraResources entry')

  const macHasTray = (config.mac.extraResources ?? []).some((entry) => entry.from === 'resources/tray')
  assert.equal(macHasTray, false, 'the tray resource should not be duplicated under mac:')
})

test('THIRD_PARTY_NOTICES.md and LICENSES/** ship in files for every platform', () => {
  assert.ok(config.files.includes('THIRD_PARTY_NOTICES.md'), 'expected THIRD_PARTY_NOTICES.md in files')
  assert.ok(config.files.includes('LICENSES/**/*'), 'expected LICENSES/**/* in files')
})
