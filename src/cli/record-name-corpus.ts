// Records again what the rules make of every line of the name corpus, with the default name:
// npm run record-name-corpus
// Only after a change to the attention, leave or cancel rules that is meant to change results: review the diff
// of test/fixtures/name-corpus.json line by line, since every changed line is the assistant answering, leaving
// or stopping where it didn't before, or no longer doing so. The lines themselves are kept as they are.
import fs from 'node:fs'
import { ALEX_PROFILE } from '../identity.ts'
import { CORPUS_FILE, type CorpusLine, loadCorpus, reader, render, toTemplate } from '../name-corpus.ts'

const corpus = loadCorpus()
const read = reader(ALEX_PROFILE)
let changed = 0
const lines = corpus.lines.map(entry => {
  const line = render(entry.line, ALEX_PROFILE)!
  const now = read(line)
  const recorded: CorpusLine = { line: entry.line, attention: now.attention }
  if (now.leave) recorded.leave = true
  if (now.cancel) recorded.cancel = true
  if (now.said.length) recorded.said = now.said.map(said => toTemplate(said, ALEX_PROFILE))
  if (JSON.stringify(recorded) !== JSON.stringify(entry)) changed++
  return recorded
})

// One line per entry, so a diff shows exactly which lines changed.
const head = JSON.stringify({ about: corpus.about, recordedWith: ALEX_PROFILE }, null, 2)
const body = lines.map(entry => `    ${JSON.stringify(entry)}`).join(',\n')
fs.writeFileSync(CORPUS_FILE, head.replace(/\n}$/, `,\n  "lines": [\n${body}\n  ]\n}\n`))
console.log(`${lines.length} lines recorded, ${changed} changed. Review the diff of ${CORPUS_FILE} before committing it.`)
