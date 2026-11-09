import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attention, saidAfterName } from '../src/brain/attention.ts'
import { isCancelRequest, isLeaveRequest } from '../src/brain/text.ts'
import { ALEX_PROFILE, type AgentName, identity } from '../src/identity.ts'
import { checkName } from '../src/name-check.ts'
import { type Difference, compareCorpus, expected, loadCorpus, render, reportDifferences } from '../src/name-corpus.ts'
import { GENERIC_TERMS, findTerms, loadPrivateTerms } from './private-terms.ts'

const corpus = loadCorpus()

// A difference as a short line for a failure message.
const show = (d: Difference) => `${JSON.stringify(d.line)}: recorded ${JSON.stringify(d.was)}, now ${JSON.stringify(d.now)}`
const noDifferences = (differences: Difference[], why: string) =>
  assert.deepEqual(differences.slice(0, 10).map(show), [], `${differences.length} of ${corpus.lines.length} lines differ ${why}`)

// Sample names shaped like the default profile: two spellings, and two mishearings of which only the first
// counts for leaving, so every slot in the corpus has something in it.
const NOVA: AgentName = { name: 'Nova', variants: ['novah', 'nowa'], misheard: ['novel', 'nobel'], leaveMisheard: ['novel'] }
// Accents are ignored when matching, so lines with "Zoë" and with "zoë" read as they do with Alex.
const ZOE: AgentName = { name: 'Zoë', variants: ['zoey', 'zooey'], misheard: ['zoo', 'joey'], leaveMisheard: ['zoo'] }

test('the corpus is the default profile with about 1,900 lines, each a template, and nothing private in it', () => {
  assert.deepEqual(corpus.recordedWith, { ...ALEX_PROFILE })
  assert.ok(corpus.lines.length > 1800, `${corpus.lines.length} lines`)
  assert.ok(corpus.lines.filter(l => l.line.includes('{Name}')).length > 500)
  assert.ok(corpus.lines.some(l => l.line.includes('{Misheard}') && l.leave), 'a mishearing that leaves')
  assert.ok(corpus.lines.some(l => l.line.includes('{Variant}') && !l.leave), 'a spelling that does not')
  const text = JSON.stringify(corpus.lines)
  // Nothing private: no home folder, account link or address, nothing from your own private terms list if you have
  // one (test/private-terms.test.ts checks every file for them), and no link at all.
  assert.deepEqual(findTerms(JSON.stringify(corpus), [...GENERIC_TERMS, ...(loadPrivateTerms().terms ?? [])]), [])
  assert.doesNotMatch(JSON.stringify(corpus), /https?:/i)
  assert.doesNotMatch(text.replace(/\{\w+\}/g, ''), /\b(?:alex|alec|alexa|aleks|ionics|elix)\b/i, 'every name is a slot')
})

test('with the default profile every line gives exactly the recorded results, so a grammar change shows up here', () => {
  const { tried, skipped, differences } = compareCorpus(corpus, ALEX_PROFILE, { said: true })
  assert.equal(skipped, 0)
  assert.equal(tried, corpus.lines.length)
  noDifferences(differences, 'with Alex: if the change was meant, record them again with npm run record-name-corpus and review the diff')
})

test('the rules the service uses, bound to its own name (Alex under npm test), give the recorded results too', () => {
  assert.equal(identity.name, 'Alex', 'npm test pins the name, so a developer\'s own .env never changes the suite')
  const differences: Difference[] = []
  for (const entry of corpus.lines) {
    const line = render(entry.line, identity)!
    const was = expected(entry, identity)
    const now = { attention: attention(line), leave: isLeaveRequest(line), cancel: isCancelRequest(line), said: saidAfterName(line) }
    if (JSON.stringify(was) !== JSON.stringify(now)) differences.push({ line, was, now })
  }
  noDifferences(differences, 'with the process identity')
})

test('with another name, its spellings and mishearings, every line reads the same: nothing is hard-wired to Alex', () => {
  for (const sample of [NOVA, ZOE]) {
    const { skipped, differences } = compareCorpus(corpus, sample, { said: true })
    assert.equal(skipped, 0)
    noDifferences(differences, `as ${sample.name}`)
  }
})

test('a name with no spellings or mishearings set skips only the lines that need them, and reads the rest the same', () => {
  const plain: AgentName = { name: 'Juniper', variants: [], misheard: [], leaveMisheard: [] }
  assert.deepEqual(checkName(plain), { errors: [], warnings: [] })
  const { tried, skipped, differences } = compareCorpus(corpus, plain, { said: true })
  assert.equal(tried + skipped, corpus.lines.length)
  assert.ok(skipped > 20 && skipped < 100, `${skipped} skipped`)
  noDifferences(differences, 'as Juniper')
})

test('a name that is a word the rules use is refused, and the corpus shows what it would break', () => {
  const will: AgentName = { name: 'Will', variants: [], misheard: [], leaveMisheard: [] }
  assert.match(checkName(will).errors.join('\n'), /"Will" is a word the rules for who is being spoken to already use/)
  const comparison = compareCorpus(corpus, will)
  assert.ok(comparison.differences.length > 0)
  const report = reportDifferences(comparison, will).join('\n')
  assert.match(report, /^Would now be answered: the assistant would talk when nobody asked it: \d+ lines?$/m)
  assert.match(report, /- as "Will", ".*\bwill\b.*" is answered \(with the default name it was/i)
})
