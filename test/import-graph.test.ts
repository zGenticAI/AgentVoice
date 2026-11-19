// Which modules reach which, read from the source. Three rules hold here:
// - the voice service and the Claude Code channel never load the converter (src/slides/render-child.ts), pdf.js or the
//   native canvas: a hostile PDF is parsed only in the converter's own process;
// - the converter never imports env.ts or config.ts, even through another module: importing env.ts loads .env, and
//   would put every API key back into the process whose environment was cleared of them;
// - npm run slides reaches no network code: prepare and check need no key and no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT } from '../src/config.ts'

// import ... from '...', import '...', export ... from '...', import('...'), require('...') and require.resolve('...').
// Type-only imports count too: the rule is about what a module names, which stays true when a type import changes.
const SPECIFIER = /\b(?:import|export)\s+(?:type\s+)?(?:[\w*${}\s,]+?\s+from\s+)?['"]([^'"\n]+)['"]|\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)|\brequire(?:\.resolve)?\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g

interface Graph {
  /** Every local module reached, as paths from the root given. */
  files: Set<string>
  /** Every package and builtin named, with the module that names it. */
  packages: Map<string, string>
}

/** What a module imports, as written. */
function specifiers(source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map(m => m[1] ?? m[2] ?? m[3])
}

/** Everything reachable from these entry modules, following relative imports. */
function graph(entries: string[], root = ROOT): Graph {
  const files = new Set<string>()
  const packages = new Map<string, string>()
  const todo = entries.map(e => path.resolve(root, e))
  while (todo.length) {
    const file = todo.pop() as string
    const rel = path.relative(root, file)
    if (files.has(rel)) continue
    assert.ok(fs.existsSync(file), `${rel} exists`)
    files.add(rel)
    for (const spec of specifiers(fs.readFileSync(file, 'utf8'))) {
      if (spec.startsWith('.')) todo.push(path.resolve(path.dirname(file), spec))
      else if (!packages.has(spec)) packages.set(spec, rel)
    }
  }
  return { files, packages }
}

const forbiddenPackages = (g: Graph) => [...g.packages.keys()].filter(p => /^(pdfjs-dist|@napi-rs\/canvas)(\/|$)/.test(p))

test('the scanner reads every form of import, and follows type-only ones', () => {
  const source = [
    "import fs from 'node:fs'",
    "import { a,\n  b } from './a.ts'",
    "import type { C } from '../c.ts'",
    "export { d } from './d.ts'",
    "import './side-effect.ts'",
    "const e = await import('./e.ts')",
    "const f = require('@napi-rs/canvas')",
    "const g = require.resolve('pdfjs-dist/legacy/build/pdf.mjs')",
    "let h: typeof import('pdfjs-dist')",
  ].join('\n')
  assert.deepEqual(specifiers(source), ['node:fs', './a.ts', '../c.ts', './d.ts', './side-effect.ts', './e.ts', '@napi-rs/canvas', 'pdfjs-dist/legacy/build/pdf.mjs', 'pdfjs-dist'])
})

test('the walk finds a module reached only through others, a type import included', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-import-graph-'))
  try {
    fs.mkdirSync(path.join(dir, 'slides'))
    fs.writeFileSync(path.join(dir, 'slides/child.ts'), "import { x } from './helper.ts'\n")
    fs.writeFileSync(path.join(dir, 'slides/helper.ts'), "import type { Y } from '../config.ts'\nexport const x = 1\n")
    fs.writeFileSync(path.join(dir, 'config.ts'), "import './env.ts'\n")
    fs.writeFileSync(path.join(dir, 'env.ts'), "import { config } from 'dotenv'\n")
    const g = graph(['slides/child.ts'], dir)
    assert.deepEqual([...g.files].sort(), ['config.ts', 'env.ts', 'slides/child.ts', 'slides/helper.ts'])
    assert.equal(g.packages.get('dotenv'), 'env.ts')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  assert.ok(graph(['src/server.ts']).files.has('src/env.ts'), 'and the service does reach env.ts')
})

test('the voice service and the channel never load the converter, pdf.js or the native canvas', () => {
  for (const entry of ['src/server.ts', 'src/channel/server.ts']) {
    const g = graph([entry])
    assert.ok(!g.files.has('src/slides/render-child.ts'), `${entry} reaches render-child.ts`)
    assert.deepEqual(forbiddenPackages(g), [], entry)
  }
  assert.ok(graph(['src/server.ts']).files.has('src/slides/deck.ts'), 'the service does use the loader (for the retention sweep)')
})

test('the converter child never imports env.ts or config.ts, even through another module', () => {
  const g = graph(['src/slides/render-child.ts'])
  assert.ok(!g.files.has('src/env.ts'), [...g.files].join(', '))
  assert.ok(!g.files.has('src/config.ts'), [...g.files].join(', '))
  assert.ok(!g.files.has('src/identity.ts'), 'identity.ts imports env.ts')
  assert.ok(!g.packages.has('dotenv'))
  assert.deepEqual([...g.files].sort(), ['src/slides/child-protocol.ts', 'src/slides/manifest.ts', 'src/slides/page-text.ts', 'src/slides/render-child.ts', 'src/untrusted.ts'])
})

test('only the converter names pdf.js or the native canvas, anywhere in src/', () => {
  const named: string[] = []
  for (const file of fs.readdirSync(path.join(ROOT, 'src'), { recursive: true, encoding: 'utf8' }).filter(f => f.endsWith('.ts'))) {
    if (specifiers(fs.readFileSync(path.join(ROOT, 'src', file), 'utf8')).some(s => /^(pdfjs-dist|@napi-rs\/canvas)(\/|$)/.test(s))) named.push(file)
  }
  assert.deepEqual(named, [path.join('slides', 'render-child.ts')])
})

test('npm run slides reaches no network code: no HTTP, sockets, Recall, Claude, Deepgram or ElevenLabs', () => {
  const g = graph(['src/cli/slides.ts'])
  const network = [...g.packages.keys()].filter(p => /^(node:)?(http|https|http2|net|tls|dgram|dns)$/.test(p) || /^(ws|@anthropic-ai\/sdk|@modelcontextprotocol\/sdk)(\/|$)/.test(p))
  assert.deepEqual(network, [])
  for (const file of ['src/recall.ts', 'src/brain/brain.ts', 'src/pipeline/deepgram.ts', 'src/pipeline/tts.ts', 'src/server.ts']) assert.ok(!g.files.has(file), file)
  for (const file of g.files) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, file), 'utf8'), /\bfetch\s*\(/, file)
})
