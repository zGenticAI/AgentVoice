// The presentation script (src/slides/script.ts): the parser and its errors and warnings, the check against a deck,
// the estimate, the canonical text (no comments), the skeleton prepare writes, and the update merge, which never
// changes a written paragraph.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SentenceSplitter } from '../src/brain/text.ts'
import { MS_PER_CHAR, spokenLength } from '../src/pipeline/playback.ts'
import { sha256 } from '../src/slides/deck.ts'
import type { Manifest, ManifestSlide } from '../src/slides/manifest.ts'
import {
  LEAD_MS, MAX_SCRIPT_CHARS, QUIET_MS, canonicalText, checkScript, mergeScript, parseScript, sectionMs, sentencesOf, skeleton, structureProblems,
} from '../src/slides/script.ts'

const ID = 'q4-roadmap-k7m2qa'

/** A deck's manifest with these pages' texts ('' for an image-only page); the pages in `excluded` left out. */
function deck(texts: string[], opts: { id?: string; excluded?: number[]; warnings?: Record<number, ManifestSlide['warnings']> } = {}): Manifest {
  const excluded = opts.excluded ?? []
  const slides = texts
    .map((text, i) => ({ text, n: i + 1 }))
    .filter(({ n }) => !excluded.includes(n))
    .map(({ text, n }) => ({
      n, title: text.split('\n')[0], pageLabel: null, text, file: `${String(n).padStart(3, '0')}.webp`, bytes: 1000, sha256: sha256(`image ${n}`),
      textHash: sha256(text), warnings: opts.warnings?.[n] ?? [],
    }))
  return { format: 1, id: opts.id ?? ID, label: 'Q4 roadmap', created: '2026-11-19T10:02:11Z', pages: texts.length, excluded: excluded.length, script: null, slides }
}

const DECK = deck([
  'Q4 roadmap\nWhat ships this quarter',
  'Agenda',
  'What ships\nSSO, audit log, EU region',
  'Adoption',
  'Pricing\nTeam 12 per user per month\nBusiness 29',
  'Rollout',
  'Customer voice',
  'Security details',
  'Customer list',
])

const SAMPLE = `---
deck: ${ID}      # written by prepare; don't change it
title: Q4 roadmap
minutes: 15
---

<!-- One section per slide. Comments like this one are for you. -->

## 1 · Q4 roadmap

Hello everyone. I'll walk you through what ships this quarter and what it costs.
If you have a question at any point, say my name and I'll stop.

## 3 · What ships
hold: 3s

There's a lot on this slide, so I'll pick out the three things that matter most: single sign-on, the audit log export, and
data residency in Europe.
<!-- Your notes: "Don't mention the Acme renewal." -->

## 5 - Pricing
pause: 5s

Team is twelve dollars per user per month, and Business is twenty-nine. Any questions on pricing before I move on?

## 8 : Security details
on-request: yes

Here are the details of our security certifications. We're certified to the main standards our customers ask for.

## 9 – Customer list
exclude: yes
`

const parse = (text: string) => parseScript(text)
const messages = (problems: { message: string }[]) => problems.map(p => p.message)
const errorsOf = (text: string, manifest: Manifest | null = DECK) => checkScript(parse(text), manifest).errors
const warningsOf = (text: string, manifest: Manifest | null = DECK) => checkScript(parse(text), manifest).warnings
/** A script around these sections. */
const script = (sections: string, front = '') => `---\ndeck: ${ID}\n${front}---\n\n${sections}`

test('the sample parses: front matter, sections by page, keys, paragraphs and sentences', () => {
  const { script: s, errors } = parse(SAMPLE)
  assert.deepEqual(errors, [])
  assert.ok(s)
  assert.equal(s.deck, ID)
  assert.equal(s.title, 'Q4 roadmap')
  assert.equal(s.minutes, 15)
  assert.deepEqual(s.sections.map(x => x.page), [1, 3, 5, 8, 9])
  assert.deepEqual(s.sections.map(x => x.heading), ['Q4 roadmap', 'What ships', 'Pricing', 'Security details', 'Customer list'])
  const [intro, ships, pricing, security, customers] = s.sections
  assert.deepEqual(intro.sentences, [
    'Hello everyone.',
    "I'll walk you through what ships this quarter and what it costs.",
    "If you have a question at any point, say my name and I'll stop.",
  ])
  assert.equal(ships.hold, 3)
  assert.equal(pricing.pause, 5)
  assert.equal(security.onRequest, true)
  assert.equal(customers.exclude, true)
  assert.deepEqual(customers.paragraphs, [])
  const checked = checkScript(parse(SAMPLE), DECK)
  assert.deepEqual(checked.errors, [])
  assert.equal(checked.narrated, 3)
  assert.equal(checked.onRequest, 1)
  assert.equal(checked.excluded, 1)
})

test('a hard-wrapped paragraph is said in whole sentences, never line fragments', () => {
  const { script: s } = parse(script('## 5 · Pricing\n\nTeam is twelve dollars per user per\nmonth, and Business is twenty-nine.\nAny questions?\n'))
  assert.deepEqual(s?.sections[0].sentences, ['Team is twelve dollars per user per month, and Business is twenty-nine.', 'Any questions?'])
  // As the service's own splitter gives them once the lines are joined: the splitter alone would end a sentence at each line.
  const splitter = new SentenceSplitter()
  const joined = 'Team is twelve dollars per user per month, and Business is twenty-nine. Any questions?'
  assert.deepEqual(s?.sections[0].sentences, [...splitter.push(joined), ...splitter.flush()])
  const raw = new SentenceSplitter()
  assert.deepEqual([...raw.push('per user per\nmonth, and'), ...raw.flush()], ['per user per', 'month, and'], 'which is why lines are joined first')
  assert.deepEqual(sentencesOf(['One. Two!', 'Three?']), ['One.', 'Two!', 'Three?'], 'a paragraph always ends a sentence')
})

test("comments are stripped before anything else, and the owner's notes never survive into the parsed script", () => {
  const { script: s, errors } = parse(SAMPLE)
  assert.deepEqual(errors, [])
  const all = JSON.stringify(s)
  assert.ok(!all.includes('Acme') && !all.includes('<!--'))
  // A comment between a heading and its keys never opens a gap that makes a key spoken text.
  const between = parse(script('## 1 · Intro\n<!-- a note -->\nhold: 3s\n\nHello everyone.\n'))
  assert.deepEqual(between.errors, [])
  assert.equal(between.script?.sections[0].hold, 3)
  assert.deepEqual(between.script?.sections[0].paragraphs, ['Hello everyone.'])
  const inline = parse(script('## 1 · Intro\n\nHello <!-- not this --> everyone.\n<!--\n## 2 · Hidden\nNot a section.\n-->\n'))
  assert.deepEqual(inline.script?.sections.map(x => x.paragraphs), [['Hello everyone.']])
  assert.deepEqual(messages(parse(script('## 1 · Intro\n\nHello. <!-- never closed\n')).errors), ['a comment (<!--) is never closed with -->'])
})

test("the canonical text: front matter, headings, keys and paragraphs, no comment, and it parses back to the same script", () => {
  const parsed = parse(SAMPLE)
  assert.ok(parsed.script)
  const canonical = canonicalText(parsed.script)
  assert.ok(!canonical.includes('<!--'))
  assert.ok(!canonical.includes('Acme') && !canonical.includes('# written by prepare'))
  assert.ok(!canonical.includes('Customer list'), 'an excluded section keeps only its page number')
  assert.match(canonical, /^---\ndeck: q4-roadmap-k7m2qa\ntitle: Q4 roadmap\nminutes: 15\n---\n\n## 1 · Q4 roadmap\n\nHello everyone\. I'll walk you/)
  assert.match(canonical, /## 3 · What ships\nhold: 3s\n\nThere's a lot on this slide, .* and data residency in Europe\.\n/)
  assert.match(canonical, /## 9\nexclude: yes\n$/)
  const again = parse(canonical)
  assert.deepEqual(again.errors, [])
  assert.equal(canonicalText(again.script!), canonical)
  assert.deepEqual(again.script?.sections.map(s => s.sentences), parsed.script.sections.map(s => (s.exclude ? [] : s.sentences)))
})

test('errors: keys under the heading (an unknown one is never spoken nor dropped), and a blank line before the text', () => {
  assert.deepEqual(messages(errorsOf(script('## 5 · Pricing\npause: 5s\nNote: Team is twelve dollars per user per month.\n'))), [
    '"Note:" is not a key, so it is never spoken: keys are hold, pause, on-request, exclude, check. Spoken text goes after a blank line',
    'nothing to say: write the narration, add "hold: Ns" for a silent slide, or add "exclude: yes"',
  ])
  assert.deepEqual(messages(errorsOf(script('## 1 · Intro\nHello everyone.\n'))), ['put a blank line between the heading (and its keys) and the spoken text'])
  assert.match(messages(errorsOf(script('## 1 · Intro\nhold: 45s\n\nHi.\n')))[0], /hold: takes seconds from 0 to 30/)
  assert.match(messages(errorsOf(script('## 1 · Intro\npause: soon\n\nHi.\n')))[0], /pause: takes seconds from 0 to 60/)
  assert.match(messages(errorsOf(script('## 1 · Intro\non-request: maybe\n\nHi.\n## 2\n\nHi.\n')))[0], /on-request: takes yes or no/)
  assert.match(messages(errorsOf(script('## 1 · Intro\nhold: 1s\nhold: 2s\n\nHi.\n')))[0], /hold is given twice/)
  assert.match(messages(errorsOf(script('## 1 · Intro\ncheck: done\n\nHi.\n')))[0], /check: is "yes"/)
  assert.match(messages(errorsOf(script('## 1 · Intro\non-request: yes\nexclude: yes\n\n## 2\n\nHi.\n')))[0], /on-request or excluded, not both/)
  assert.match(messages(errorsOf(script('## 1 · Intro\n\nHi.\n\nhold: 3s\n')))[0], /"hold:" looks like a key, but it is in the spoken text/)
})

test('errors: TODO, an empty body (unless hold or exclude), lists, tables, URLs, HTML and stray headings are not speech', () => {
  const one = (body: string, keys = '') => messages(errorsOf(script(`## 1 · Intro\n${keys}\n${body}\n`)))
  assert.deepEqual(one('TODO'), ['TODO: write the narration, or add "exclude: yes"'])
  assert.deepEqual(messages(errorsOf(script('## 1 · Intro\nexclude: yes\n\nTODO\n\n## 2 · Agenda\n\nHi.\n'))), [], 'an excluded section is never spoken')
  assert.deepEqual(one(''), ['nothing to say: write the narration, add "hold: Ns" for a silent slide, or add "exclude: yes"'])
  assert.deepEqual(one('', 'hold: 5s\n'), [], 'a silent slide')
  assert.deepEqual(one('- one\n- two'), ['a list is not speech: write it as sentences', 'nothing to say: write the narration, add "hold: Ns" for a silent slide, or add "exclude: yes"'])
  assert.match(one('1. First we ship.')[0], /a list is not speech/)
  assert.match(one('| a | b |')[0], /a table is not speech/)
  assert.match(one('See https://example.com/pricing for more.')[0], /a URL is not speech/)
  assert.match(one('See www.example.com.')[0], /a URL is not speech/)
  assert.match(one('Hello <b>everyone</b>.')[0], /HTML is not speech/)
  assert.match(one('Hello. --> everyone')[0], /HTML is not speech/)
  assert.match(one('### Details')[0], /a heading must be "## <page> · <title>"/)
  assert.match(one('## Details')[0], /a heading must be/)
  assert.match(one('![chart](chart.png)')[0], /an image is not speech/)
})

test('emphasis and links are taken out, not refused: they are not heard', () => {
  const s = parse(script('## 1 · Intro\n\nThis is **very** important, and *so* is [our plan](https://example.com/plan), and `this`.\n')).script
  assert.deepEqual(s?.sections[0].paragraphs, ['This is very important, and so is our plan, and this.'])
  assert.deepEqual(parse(script('## 1 · Intro\n\nFive * three is fifteen, snake_case stays.\n')).script?.sections[0].paragraphs, ['Five * three is fifteen, snake_case stays.'])
})

test('errors: order, duplicates, pages the deck lacks or left out, check: changed, the front matter, and nothing to present', () => {
  assert.match(messages(errorsOf(script('## 3 · A\n\nHi.\n\n## 2 · B\n\nHi.\n')))[0], /sections must be in page order: this comes after page 3/)
  assert.match(messages(errorsOf(script('## 2 · A\n\nHi.\n\n## 2 · B\n\nHi.\n')))[0], /this page has two sections/)
  assert.deepEqual(messages(errorsOf(script('## 1 · A\n\nHi.\n\n## 12 · B\n\nHi.\n'))), ['not in the deck: it has 9 pages: add "exclude: yes", or prepare the deck again with it'])
  const left = deck(['A', 'B', 'C'], { excluded: [2] })
  assert.deepEqual(messages(errorsOf(script('## 1 · A\n\nHi.\n\n## 2 · B\n\nHi.\n'), left)), ['left out when the deck was prepared (--exclude): add "exclude: yes", or prepare the deck again with it'])
  assert.deepEqual(messages(errorsOf(script('## 1 · A\n\nHi.\n\n## 2 · B\nexclude: yes\n'), left)), [], 'excluded in the script too: ignored')
  assert.match(messages(errorsOf(script('## 1 · A\ncheck: changed\n\nHi.\n')))[0], /the slide changed after this was written/)
  assert.deepEqual(messages(errorsOf(script('## 1 · A\non-request: yes\n\nHi.\n'))), ['nothing to present: every section is excluded or on request'])
  assert.deepEqual(messages(errorsOf('---\ntitle: x\n---\n\n## 1\n\nHi.\n')), ['the front matter has no "deck:" line: prepare writes it'])
  assert.deepEqual(messages(errorsOf('---\ndeck: ../../etc\n---\n\n## 1\n\nHi.\n')), ['deck: is not a deck id: it is the id prepare wrote, such as q4-roadmap-k7m2qa'])
  assert.match(messages(errorsOf('## 1\n\nHi.\n'))[0], /must start with its front matter/)
  assert.deepEqual(errorsOf(script('## 1\n\nHi.\n', 'speaker: Sam\n')), [{ line: 3, message: 'this is not a front matter key: they are deck, title and minutes' }])
  assert.match(messages(errorsOf(script('## 1\n\nHi.\n', 'minutes: soon\n')))[0], /minutes: must be a whole number/)
  assert.match(messages(errorsOf(script('Welcome!\n\n## 1\n\nHi.\n')))[0], /text before the first section is never spoken/)
  assert.deepEqual(messages(errorsOf(script(''))), ['the script has no sections: one "## <page> · <title>" per slide'])
})

test("check quotes nothing of a file that only looks like a script: a line number for its first line that is no key, never its text", () => {
  // A YAML file's front matter, never closed: one line number, and nothing of any line.
  const yaml = '---\napiVersion: v1\nkind: Secret\nstringData:\n  db_password: fake-example-value\n  api_token: fake-token-0123\n'
  const unclosed = parse(yaml)
  assert.equal(unclosed.script, null)
  assert.deepEqual(unclosed.errors, [
    { line: 2, message: 'this is not a front matter key: they are deck, title and minutes' },
    { line: 7, message: 'the front matter is never closed with a "---" line' },
  ])
  // Closed, with a deck line that is no id, and keys of its own: still only line numbers.
  const notes = parse('---\ndeck: fake-not-an-id-but-a-secret-value-123\nclient: Example Client Ltd\nfee: 250000\n---\n\n## 1\n\nHi.\n')
  const all = JSON.stringify(notes.errors)
  for (const secret of ['fake-not-an-id', 'Example Client', '250000', 'fake-example-value']) assert.ok(!all.includes(secret), secret)
  assert.deepEqual(notes.errors.map(e => e.line).sort(), [2, 3])
  assert.ok(!JSON.stringify(unclosed.errors).includes('fake'), 'nothing of the YAML')
})

test('errors: the caps on a sentence, a section, the script and the number of sections', () => {
  const long = `${'word '.repeat(90)}end.`
  assert.deepEqual(messages(errorsOf(script(`## 1\n\n${long}\n`))), ['a sentence is 454 characters: at most 400, so it can be said and resumed'])
  const section = Array.from({ length: 90 }, () => 'This sentence is about fifty characters long, yes.').join(' ')
  assert.match(messages(errorsOf(script(`## 1\n\n${section}\n`)))[0], /the section's text is \d+ characters: at most 4000/)
  const sections = Array.from({ length: 12 }, (_, i) => `## ${i + 1}\n\n${section.slice(0, 3900)}.\n`).join('\n')
  assert.ok(messages(errorsOf(script(sections), null)).some(m => m.includes(`at most ${MAX_SCRIPT_CHARS} (about 45 minutes)`)))
  const many = Array.from({ length: 101 }, (_, i) => `## ${i + 1}\n\nHi.\n`).join('\n')
  assert.ok(messages(errorsOf(script(many), null)).some(m => /at most 100 sections|pages run from 1 to 100/.test(m)))
})

test('warnings: drafts, say-as hazards, figures not on the slide, timing, pages without a section, and the deck\'s own', () => {
  const manifest = deck(['Pricing\nTeam 12 per user\nBusiness 29', 'Chart', 'Closing'], { warnings: { 2: ['no-text'] } })
  const text = script(
    `## 1 · Pricing\ncheck: yes\n\nTeam is $12 a month and Business is 29, or 18% less than SSO elsewhere.\n\n## 2 · Chart\nhold: 2s\n\nAs you can see.\n`,
    'minutes: 1\n',
  )
  const warnings = warningsOf(text, manifest)
  const at = (page: number | undefined) => warnings.filter(w => w.page === page).map(w => w.message)
  assert.deepEqual(at(1), [
    'drafted, not yet checked by you: read it, then delete "check: yes"',
    'say-as: "$12", "29", "18%", "SSO": write figures, signs and abbreviations as they are spoken ("twelve dollars")',
    '18 is not on the slide: check the figures',
  ])
  assert.deepEqual(at(2), ['the slide has no text, so it can be answered about only from your script'])
  assert.deepEqual(at(3), ["no section, so it won't be shown"])
  assert.deepEqual(errorsOf(text, manifest), [])

  const short = warningsOf(script('## 1 · Pricing\n\nHi.\n'), manifest)
  assert.ok(short.some(w => w.message === 'on screen for only a few seconds: add "hold: 3s" so people can read it'))
  // A TODO section is not written yet: its error says so, and it is neither timed nor warned about as narration.
  const todo = checkScript(parse(script('## 1 · Pricing\ncheck: yes\n\nTODO 99\n')), manifest)
  assert.deepEqual(messages(todo.warnings), ['drafted, not yet checked by you: read it, then delete "check: yes"', 'say-as: "99": write figures, signs and abbreviations as they are spoken ("twelve dollars")', "no section, so it won't be shown", "no section, so it won't be shown"])
  assert.deepEqual([todo.narrated, todo.todo, todo.totalMs, todo.estimates.size], [0, 1, 0, 0])
  const long = warningsOf(script(`## 1 · Pricing\n\n${'This sentence keeps the slide on screen for a while. '.repeat(40)}\n`), manifest)
  assert.ok(long.some(w => /about \d+ s on one slide: consider splitting it/.test(w.message)))
  assert.ok(!long.some(w => /over 70%/.test(w.message)), 'without minutes, no budget to go over')
  const timed = warningsOf(script(`## 1 · Pricing\n\n${'This sentence keeps the slide on screen for a while. '.repeat(40)}\n`, 'minutes: 2\n'), manifest)
  assert.ok(timed.some(w => /the narration takes about \d+ min, over 70% of your 2 min: leave time for questions/.test(w.message)))
})

test('the estimate: the speech at the playback rate, plus the lead, the hold, the pause and the quiet', () => {
  const s = parse(script('## 1 · A\nhold: 3s\npause: 5s\n\nTeam is twelve dollars.\n')).script!.sections[0]
  assert.equal(sectionMs(s), spokenLength('Team is twelve dollars.') * MS_PER_CHAR + LEAD_MS + 3000 + 5000 + QUIET_MS)
  const checked = checkScript(parse(SAMPLE), DECK)
  const narrated = parse(SAMPLE).script!.sections.filter(x => !x.exclude && !x.onRequest)
  assert.equal(checked.totalMs, narrated.reduce((sum, x) => sum + sectionMs(x), 0), 'on-request and excluded sections are not counted')
  assert.equal(checked.estimates.size, 4)
})

test('the skeleton: one section per rendered page, check: yes and TODO, the slide text as a comment that cannot break out', () => {
  const manifest = deck(['Q4 roadmap\nWhat ships', '', 'Arrows --> and <!-- tricks', 'Left out'], { excluded: [4] })
  const text = skeleton(manifest, { name: 'Nova', scriptPath: 'q4.script.md', notes: new Map([[1, 'Say hello first.']]) })
  assert.match(text, /^---\ndeck: q4-roadmap-k7m2qa {6}# written by prepare: don't change it\ntitle: Q4 roadmap\n# minutes: 15 /)
  assert.match(text, /Nova says only the paragraphs, word for word\./)
  assert.match(text, /npm run slides -- check q4\.script\.md -->/)
  assert.match(skeleton(manifest, { name: 'Nova', scriptPath: "Sam's deck.script.md" }), /check 'Sam'\\''s deck\.script\.md' -->/, 'quoted for the shell')
  assert.match(skeleton(deck(['Plan #1']), { name: 'Nova', scriptPath: 'x.script.md' }), /^title: Plan 1$/m, 'no "#" to start a comment')
  assert.match(text, /## 1 · Q4 roadmap\ncheck: yes\n\nTODO\n<!-- On the slide: "Q4 roadmap \/ What ships" -->\n<!-- Your notes: "Say hello first\." -->/)
  assert.match(text, /## 2\ncheck: yes\n\nTODO\n<!-- On the slide: no text \(an image only\)\. -->/)
  assert.ok(!text.includes('Left out'), 'an excluded page leaves nothing')
  assert.equal(text.match(/-->/g)?.length, text.match(/<!--/g)?.length, 'every comment is closed exactly once')
  const parsed = parse(text)
  const checked = checkScript(parsed, manifest)
  assert.deepEqual([...new Set(messages(checked.errors))], ['TODO: write the narration, or add "exclude: yes"'])
  assert.equal(checked.errors.length, 3)
  assert.equal(parsed.script?.sections[2].heading, 'Arrows and tricks', 'a heading never holds a comment marker')
  assert.ok(!JSON.stringify(parsed.script).includes('<!--') && !JSON.stringify(parsed.script).includes('On the slide'))
})

const WRITTEN = `---
deck: ${ID}   # written by prepare
---

## 1 · Q4 roadmap

Hello everyone. I'll walk you through what ships this quarter
and what it costs.

## 2 · Agenda
check: yes

Here's the plan for today.

## 3 · What ships
hold: 3s

There's a lot on this slide.
<!-- my own note -->

## 4 · Adoption
exclude: yes

## 5 · Pricing

Team is twelve dollars per user per month.
`

test('the update merge: the new deck id, check: changed where a slide changed, exclude: yes where it went, a skeleton for a new page', () => {
  const before = deck(['Q4 roadmap', 'Agenda', 'What ships', 'Adoption', 'Pricing\nTeam 12'], { id: ID })
  const after = deck(['Q4 roadmap', 'Agenda (new)', 'What ships', 'Adoption', 'New slide'], { id: 'q4-roadmap-newid2', excluded: [5] })
  const grown = { ...after, pages: 6, slides: [...after.slides, { ...after.slides[0], n: 6, title: 'Thanks', text: 'Thanks', file: '006.webp', textHash: sha256('Thanks') }] }
  assert.deepEqual(structureProblems(WRITTEN), [])
  const merged = mergeScript(WRITTEN, before, grown)
  assert.deepEqual(merged.changed, [2])
  assert.deepEqual(merged.gone, [5])
  assert.deepEqual(merged.added, [6])
  assert.match(merged.text, /^---\ndeck: q4-roadmap-newid2   # written by prepare\n/)
  assert.match(merged.text, /## 2 · Agenda\ncheck: changed\n<!-- This slide changed since this section was written: read it against the slide, then delete "check: changed"\. -->\n\nHere's the plan for today\.\n\n<!-- On the slide now: "Agenda \(new\)" -->\n\n## 3/)
  assert.match(merged.text, /## 5 · Pricing\nexclude: yes\n<!-- Page 5 was left out when the deck was prepared, so this section is excluded\. -->\n\nTeam is twelve/)
  assert.match(merged.text, /\n\n## 6 · Thanks\ncheck: yes\n\nTODO\n<!-- On the slide: "Thanks" -->\n$/)
  // Every line of the old script is still there, in order: only lines were added (and "check: yes" became "check: changed").
  const old = WRITTEN.split('\n').map(l => (l === 'check: yes' ? 'check: changed' : l.replace(ID, 'q4-roadmap-newid2')))
  const lines = merged.text.split('\n')
  let at = 0
  for (const line of old) {
    at = lines.indexOf(line, at)
    assert.ok(at >= 0, `kept: ${line}`)
    at++
  }
  // The written paragraphs come out word for word.
  const paragraphs = (text: string) => parse(text).script!.sections.filter(s => s.page !== 6).map(s => s.paragraphs)
  assert.deepEqual(paragraphs(merged.text), paragraphs(WRITTEN))
  const checked = checkScript(parse(merged.text), grown)
  assert.deepEqual(messages(checked.errors), [
    'the slide changed after this was written: read it against the slide, then delete "check: changed"',
    'TODO: write the narration, or add "exclude: yes"',
  ])
})

test('the merge, when the old deck is gone: every section it could not compare is marked check: changed', () => {
  const after = deck(['Q4 roadmap', 'Agenda', 'What ships', 'Adoption', 'Pricing\nTeam 12'], { id: 'q4-roadmap-newid2' })
  const merged = mergeScript(WRITTEN, null, after)
  assert.deepEqual(merged.changed, [1, 2, 3, 5])
  assert.match(merged.text, /The deck this script was written for is gone, so prepare can't tell whether this slide changed/)
  assert.ok(!/## 4 · Adoption\nexclude: yes\ncheck: changed/.test(merged.text), 'an excluded section is left alone')
  const same = mergeScript(WRITTEN, deck(['Q4 roadmap', 'Agenda', 'What ships', 'Adoption', 'Pricing\nTeam 12']), deck(['Q4 roadmap', 'Agenda', 'What ships', 'Adoption', 'Pricing\nTeam 12'], { id: 'q4-roadmap-newid2' }))
  assert.deepEqual([same.changed, same.added, same.gone], [[], [], []])
  assert.equal(same.text, WRITTEN.replace(ID, 'q4-roadmap-newid2'), 'nothing changed but the deck line')
})

test('a script whose structure is unclear is never merged into: no front matter or deck line, an open comment, sections out of order', () => {
  assert.match(messages(structureProblems('## 1\n\nHi.\n'))[0], /must start with its front matter/)
  assert.match(messages(structureProblems('---\ntitle: x\n---\n## 1\n\nHi.\n'))[0], /no "deck:" line/)
  assert.match(messages(structureProblems(script('## 1\n\nHi. <!-- open\n')))[0], /never closed/)
  assert.match(messages(structureProblems(script('## 2\n\nHi.\n\n## 1\n\nHo.\n')))[0], /page order/)
  assert.deepEqual(structureProblems(script('## 1\nNote: hi\nTODO\n')), [], 'content problems are for check, not a reason to refuse an update')
})
