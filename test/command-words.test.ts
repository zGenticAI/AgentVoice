// Every message in src/ that names a command, the settings file as a place, or a docs page is built through
// src/commands.ts, so a clone's says what it always said and an installed one never names npm run, the clone's .env or
// a docs page that isn't there. Comments may name them: only what the code says is read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from '../src/config.ts'
import { literals } from './source-literals.ts'

const ALLOWED = new Set(['src/commands.ts'])
// .env named as a place ("in .env", "to .env", "from .env", "of .env", ".env's"), but not .env.example.
const FORBIDDEN: [string, RegExp][] = [
  ['npm run', /\bnpm run /],
  ['npm start', /\bnpm start\b/],
  ['npm install', /\bnpm install\b/],
  ['a setup script', /\bscripts\/install-/],
  ['.env as a place', /\b(?:in|to|from|of) \.env(?!\.?[\w-])/],
  [".env's", /\.env's/],
  ['a docs page', /\bdocs\/[\w-]+\.md\b/],
]

/** What a source's literals name that only commands.ts may, with its line. */
function named(source: string): string[] {
  const found: string[] = []
  for (const { text, line } of literals(source)) {
    for (const [what, pattern] of FORBIDDEN) if (pattern.test(text)) found.push(`${line}: ${what}: ${text.slice(0, 120)}`)
  }
  return found
}

test('the scan finds each form in strings and templates, and skips comments', () => {
  const source = [
    '// npm run join, npm start, scripts/install-service.sh, in .env, docs/setup.md: a comment may say them',
    '/* to .env, .env\'s */',
    "const a = 'Start it with npm start.'",
    'const b = `Run npm run slides -- check ${file}.`',
    'const c = "Set it in .env."',
    "const d = 'Take it out of .env, or see docs/make-it-yours.md'",
    "const e = `.env's AGENT_NAME`",
    "const f = 'Run npm install, or scripts/install-service.sh'",
    "const g = 'copy .env.example, or one from .env.example'",
    "const h = `in ${WORDS.envFile}: ${WORDS.doc('setup')}`",
  ].join('\n')
  assert.deepEqual(
    named(source).map(n => n.split(':').slice(0, 2).join(':')),
    ['3: npm start', '4: npm run', '5: .env as a place', '6: .env as a place', '6: a docs page', "7: .env's", '8: npm install', '8: a setup script'],
  )
  // A quote mark in a pattern inside a template's expression is not a string (src/server.ts's shellPath has one): the
  // comment after it stays a comment, and the string after that is read where it is.
  const pattern = ["const q = (p: string) => `'${p.replace(/'/g, \"'\\\\''\")}'`", '// npm start in a comment', "const r = 'in .env'"].join('\n')
  assert.deepEqual(named(pattern).map(n => n.split(':').slice(0, 2).join(':')), ['3: .env as a place'])
})

test('no code in src/ but src/commands.ts names an npm command, a setup script, .env as a place or a docs page', () => {
  const offenders: string[] = []
  const files = fs.readdirSync(path.join(ROOT, 'src'), { recursive: true, encoding: 'utf8' }).filter(f => f.endsWith('.ts'))
  assert.ok(files.length > 80, `${files.length} files`)
  for (const file of files.map(f => path.join('src', f))) {
    if (ALLOWED.has(file)) continue
    for (const found of named(fs.readFileSync(path.join(ROOT, file), 'utf8'))) offenders.push(`${file}:${found}`)
  }
  assert.deepEqual(offenders, [])
})
