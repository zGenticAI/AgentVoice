import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from '../src/config.ts'
import { literals } from './source-literals.ts'

// The default name, its spellings and mishearings. Only src/identity.ts may say them in code: everything the
// assistant says, shows or is told is built from the configured name. Comments may still use Alex as the example.
const DEFAULT_NAMES = /\b(?:alex|alec|alexa|aleks|ionics|elix)\b/i
const ALLOWED = new Set(['src/identity.ts'])
// Nothing is let through: the installed service's name (SERVICE_LABEL) and its log (data/agent-voice.log) are the
// project's, not the assistant's.
const namesDefault = (text: string) => DEFAULT_NAMES.test(text)

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
