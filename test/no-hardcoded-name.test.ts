import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from '../src/config.ts'

// The default name, its spellings and mishearings. Only src/identity.ts may say them in code: everything the
// assistant says, shows or is told is built from the configured name. Comments may still use Alex as the example.
const DEFAULT_NAMES = /\b(?:alex|alec|alexa|aleks|ionics|elix)\b/i
const ALLOWED = new Set(['src/identity.ts'])
// Nothing is let through: the installed service's name (SERVICE_LABEL) and its log (data/agent-voice.log) are the
// project's, not the assistant's.
const namesDefault = (text: string) => DEFAULT_NAMES.test(text)

/** Every string, template and regular expression literal in JavaScript or TypeScript source, with its line. */
function literals(source: string): { text: string; line: number }[] {
  const found: { text: string; line: number }[] = []
  let i = 0
  let line = 1
  // The last token, to tell a regular expression from a division.
  let last = ''
  const lineAt = (from: number, to: number) => source.slice(from, to).split('\n').length - 1
  const readQuoted = (quote: string, nested = false): void => {
    const start = i
    i++
    while (i < source.length && source[i] !== quote) {
      if (source[i] === '\\') i++
      else if (quote === '`' && source[i] === '$' && source[i + 1] === '{') {
        // An expression in a template: skip to its closing brace, past any strings in it.
        let depth = 1
        i += 2
        while (i < source.length && depth > 0) {
          if (source[i] === '{') depth++
          else if (source[i] === '}') depth--
          else if (`'"\``.includes(source[i])) {
            readQuoted(source[i], true)
            continue
          }
          if (depth > 0) i++
        }
      }
      i++
    }
    i++
    // A string in a template's expression is given the template's first line, and its lines counted with the template's.
    found.push({ text: source.slice(start, i), line })
    if (!nested) line += lineAt(start, i)
  }
  while (i < source.length) {
    const c = source[i]
    if (c === '\n') {
      line++
      i++
    } else if (/\s/.test(c)) {
      i++
    } else if (source.startsWith('//', i)) {
      i = source.indexOf('\n', i)
      if (i < 0) break
    } else if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i) + 2
      line += lineAt(i, end)
      i = end
    } else if (`'"\``.includes(c)) {
      readQuoted(c)
      last = 'literal'
    } else if (c === '/' && (last === '' || '(,=:[!&|?{};+-*%<>~^'.includes(last) || ['return', 'typeof', 'case'].includes(last))) {
      const start = i
      let inClass = false
      for (i++; i < source.length && (source[i] !== '/' || inClass); i++) {
        if (source[i] === '\\') i++
        else if (source[i] === '[') inClass = true
        else if (source[i] === ']') inClass = false
      }
      i++
      found.push({ text: source.slice(start, i), line })
      last = 'literal'
    } else if (/[\w$]/.test(c)) {
      const start = i
      while (i < source.length && /[\w$]/.test(source[i])) i++
      last = source.slice(start, i)
    } else {
      last = c
      i++
    }
  }
  return found
}

/** A page with its comments taken out: HTML, CSS and script comments may still name the default. */
function withoutComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')
}

const files = (dir: string, ext: RegExp): string[] =>
  fs.readdirSync(path.join(ROOT, dir), { recursive: true, encoding: 'utf8' }).filter(f => ext.test(f)).map(f => path.join(dir, f))

test('the scanner finds strings, templates and patterns, and skips comments', () => {
  const source = "// Alex here\nconst a = 'x' /* Alex */ + `y ${'z'} w`\nconst re = /it's/i, b = 4 / 2 / 1\nconst c = \"q\""
  assert.deepEqual(literals(source).map(l => l.text), ["'x'", "'z'", "`y ${'z'} w`", "/it's/", '"q"'])
  assert.deepEqual(literals(source).map(l => l.line), [2, 2, 2, 3, 4])
})

test('no runtime string in src/ or public/ names the default name, its spellings or mishearings, outside src/identity.ts', () => {
  const offenders: string[] = []
  for (const file of files('src', /\.ts$/).filter(f => !ALLOWED.has(f))) {
    for (const { text, line } of literals(fs.readFileSync(path.join(ROOT, file), 'utf8'))) {
      if (namesDefault(text)) offenders.push(`${file}:${line} ${text.slice(0, 100)}`)
    }
  }
  for (const file of files('public', /\.js$/)) {
    for (const { text, line } of literals(fs.readFileSync(path.join(ROOT, file), 'utf8'))) {
      if (namesDefault(text)) offenders.push(`${file}:${line} ${text.slice(0, 100)}`)
    }
  }
  for (const file of files('public', /\.html$/)) {
    withoutComments(fs.readFileSync(path.join(ROOT, file), 'utf8')).split('\n').forEach((text, i) => {
      if (DEFAULT_NAMES.test(text)) offenders.push(`${file}:${i + 1} ${text.trim().slice(0, 100)}`)
    })
  }
  assert.deepEqual(offenders, [])
})

test('no line of the scripts or the service templates names the default name, outside comments', () => {
  const scripts = files('scripts', /\.(sh|plist|service)$/)
  assert.ok(scripts.length >= 4, scripts.join(', '))
  const offenders: string[] = []
  for (const file of scripts) {
    withoutComments(fs.readFileSync(path.join(ROOT, file), 'utf8')).split('\n').forEach((text, i) => {
      if (!text.trim().startsWith('#') && namesDefault(text)) offenders.push(`${file}:${i + 1} ${text.trim().slice(0, 100)}`)
    })
  }
  assert.deepEqual(offenders, [])
})

test("the meeting-assistant agent's instructions don't name the assistant, nor anyone else: the session and get_profile do", () => {
  const agent = fs.readFileSync(path.join(ROOT, '.claude/agents/meeting-assistant.md'), 'utf8')
  assert.doesNotMatch(agent, DEFAULT_NAMES)
  assert.doesNotMatch(agent, /\b(?:Sam|Priya|Acme)\b/, 'not the examples either: the names come from get_profile')
})
