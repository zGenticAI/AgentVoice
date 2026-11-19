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

/**
 * A deck's manifest with these pages' texts ('' for an image-only page); the pages in `excluded` left out. Each image
 * is "image <page>" unless `images` names them, as a real render's bytes follow the slide, not its page.
 */
function deck(texts: string[], opts: { id?: string; excluded?: number[]; warnings?: Record<number, ManifestSlide['warnings']>; images?: string[] } = {}): Manifest {
  const excluded = opts.excluded ?? []
  const slides = texts
    .map((text, i) => ({ text, n: i + 1 }))
    .filter(({ n }) => !excluded.includes(n))
    .map(({ text, n }) => ({
      n, title: text.split('\n')[0], pageLabel: null, text, file: `${String(n).padStart(3, '0')}.webp`, bytes: 1000, sha256: sha256(opts.images?.[n - 1] ?? `image ${n}`),
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

test('every script check accepts has a canonical text that parses back to the same script: a paragraph, heading or title that would not is refused', () => {
  // Taking out emphasis, code and links would leave a list, a key, a quote, a table, a rule, a heading, a URL, HTML or a
  // comment where the file had none, or text that changes again on a second pass.
  const refused: [string, RegExp][] = [
    ['**1.** We ship in December.', /a list is not speech/],
    ['`-` is how we start.', /a list is not speech/],
    ['[- one](x) two.', /a list is not speech/],
    ['*hold: 5s* is what I said.', /"hold:" looks like a key/],
    ['**---**', /a rule/],
    ['*> quoted*', /a quote block/],
    ['`|` a pipe.', /a table/],
    ['_## 2 · B_ is a heading.', /a heading must be/],
    ['Visit **www**.example.com today.', /a URL is not speech/],
    ['`<`b> bold.', /HTML is not speech/],
    ['a **<**!-**-** b.', /HTML is not speech/],
    ['``a`` is code.', /marks inside emphasis or code are not speech/],
  ]
  for (const [paragraph, why] of refused) {
    const errors = parse(script(`## 1 · Intro\n\n${paragraph}\n\n## 2 · B\n\nHi.\n`)).errors
    assert.ok(errors.some(e => e.line === 7 && why.test(e.message)), `${paragraph}: ${JSON.stringify(errors)}`)
  }
  // A comment marker left in a heading or the title by joining what was around a comment.
  assert.deepEqual(parse(script('## 1 · A <!<!-- x -->-- B\n\nHello everyone.\n')).errors, [{ line: 5, page: 1, message: "the heading's title has a broken comment: a comment must be whole, <!-- like this -->" }])
  assert.deepEqual(parse(script('## 1 · A\n\nHello everyone.\n', 'title: A <!<!-- x -->-- B\n')).errors, [{ line: 3, message: 'title: a comment must be whole: <!-- like this -->' }])
  // What is accepted reads back the same, with no comment marker in it.
  for (const paragraph of ['We ship in **December**.', 'Say `*hi*` now.', 'a *b **c** d* e.', 'See [the plan](x) today.']) {
    const first = parse(script(`## 1 · Intro\n\n${paragraph}\n`, 'title: Plan <!-- for us --> B\n'))
    assert.deepEqual(first.errors, [], paragraph)
    const canonical = canonicalText(first.script!)
    assert.ok(!canonical.includes('<!--'))
    const again = parse(canonical)
    assert.deepEqual(again.errors, [], paragraph)
    assert.deepEqual(again.script?.sections.map(s => [s.paragraphs, s.sentences]), first.script?.sections.map(s => [s.paragraphs, s.sentences]))
    assert.equal(canonicalText(again.script!), canonical)
  }
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

test('an unknown front matter key above the deck line is named once, and the deck line under it is still read', () => {
  const text = `---\nauthor: Sam\ndeck: ${ID}\ntitle: Q4 plan\nspeaker: Sam\n---\n\n## 1 · Intro\n\nHello.\n`
  const parsed = parse(text)
  assert.equal(parsed.script?.deck, ID)
  assert.equal(parsed.script?.title, 'Q4 plan')
  assert.deepEqual(parsed.errors, [{ line: 2, message: 'this is not a front matter key: they are deck, title and minutes' }])
  assert.deepEqual(structureProblems(text), [], 'prepare can update it')
  const merged = mergeScript(text, null, deck(['Intro'], { id: 'q4-roadmap-newid2' }))
  assert.equal(parse(merged.text).script?.deck, 'q4-roadmap-newid2')
  assert.match(merged.text, /^---\nauthor: Sam\ndeck: q4-roadmap-newid2\n/)
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
  // Left out with --exclude: its heading loses the slide's title, which prepare wrote.
  assert.match(merged.text, /\n## 5\nexclude: yes\n<!-- Page 5 was left out when the deck was prepared, so this section is excluded\. -->\n\nTeam is twelve/)
  assert.deepEqual(merged.scrubbed, [5])
  assert.match(merged.text, /\n\n## 6 · Thanks\ncheck: yes\n\nTODO\n<!-- On the slide: "Thanks" -->\n$/)
  // Every line of the old script is still there, in order: only lines were added (and "check: yes" became "check:
  // changed", and the left-out page's heading lost the slide's title).
  const old = WRITTEN.split('\n').map(l => (l === 'check: yes' ? 'check: changed' : l === '## 5 · Pricing' ? '## 5' : l.replace(ID, 'q4-roadmap-newid2')))
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
  assert.match(merged.text, /The deck this script was written for is gone or can't be used, so prepare can't tell whether this slide changed/)
  assert.ok(!/## 4 · Adoption\nexclude: yes\ncheck: changed/.test(merged.text), 'an excluded section is left alone')
  const same = mergeScript(WRITTEN, deck(['Q4 roadmap', 'Agenda', 'What ships', 'Adoption', 'Pricing\nTeam 12']), deck(['Q4 roadmap', 'Agenda', 'What ships', 'Adoption', 'Pricing\nTeam 12'], { id: 'q4-roadmap-newid2' }))
  assert.deepEqual([same.changed, same.added, same.gone], [[], [], []])
  assert.equal(same.text, WRITTEN.replace(ID, 'q4-roadmap-newid2'), 'nothing changed but the deck line')
})

/** A deck whose images follow their slides, as a real render's do: moving a slide moves its image. */
const real = (texts: string[], opts: { id?: string; excluded?: number[]; images?: string[] } = {}) => deck(texts, { images: texts.map((t, i) => opts.images?.[i] ?? `picture of ${t}`), ...opts })
const sectionsOf = (pages: [number, string, string][]) => pages.map(([n, title, body]) => `## ${n} · ${title}\n\n${body}\n`).join('\n')

test('the merge finds a slide that moved by its text: an insert renumbers the headings after it, and only the new page gets a skeleton', () => {
  const before = real(['Intro', 'Problem', 'Solution', 'Pricing', 'Backup'])
  const after = real(['Intro', 'Customer story', 'Problem', 'Solution', 'Pricing', 'Backup'], { id: 'q4-roadmap-newid2' })
  const text = script(`${sectionsOf([[1, 'Intro', 'Hello.'], [2, 'Problem', 'Here is the problem.'], [3, 'Solution', 'Here is the fix.']])}\n## 4 · Pricing\npause: 3s\n\nIt costs twelve dollars.\n\n## 5 · Backup\non-request: yes\n\nThe backup.\n`)
  const merged = mergeScript(text, before, after)
  assert.deepEqual(merged.moved, [{ from: 2, to: 3 }, { from: 3, to: 4 }, { from: 4, to: 5 }, { from: 5, to: 6 }])
  assert.equal(merged.renumbered, true)
  assert.deepEqual([merged.changed, merged.added, merged.gone], [[], [2], []])
  const parsed = parse(merged.text).script!
  assert.deepEqual(parsed.sections.map(s => [s.page, s.paragraphs.join(' ')]), [
    [1, 'Hello.'], [2, 'TODO'], [3, 'Here is the problem.'], [4, 'Here is the fix.'], [5, 'It costs twelve dollars.'], [6, 'The backup.'],
  ])
  assert.equal(parsed.sections[4].pause, 3)
  assert.equal(parsed.sections[5].onRequest, true, 'the backup is still the backup slide')
  assert.match(merged.text, /## 3 · Problem\n<!-- Was page 2: the slide moved to page 3\. -->\n\nHere is the problem\./)
  assert.deepEqual(messages(checkScript(parse(merged.text), after).errors), ['TODO: write the narration, or add "exclude: yes"'])
})

test('the merge, for a slide deleted or two swapped: no false "gone", and headings left alone with check: changed saying where each slide is now', () => {
  const before = real(['Intro', 'Agenda', 'Problem', 'Solution', 'Pricing'])
  const text = script(sectionsOf([[1, 'Intro', 'Hello.'], [2, 'Agenda', 'The plan.'], [3, 'Problem', 'The problem.'], [4, 'Solution', 'The fix.'], [5, 'Pricing', 'The price.']]))
  const deleted = mergeScript(text, before, real(['Intro', 'Problem', 'Solution', 'Pricing'], { id: 'q4-roadmap-newid2' }))
  assert.deepEqual(deleted.gone, [2], 'only Agenda is gone: Pricing is still in the deck, as page 4')
  assert.equal(deleted.renumbered, false)
  assert.deepEqual(deleted.moved, [{ from: 3, to: 2 }, { from: 4, to: 3 }, { from: 5, to: 4 }])
  assert.deepEqual(deleted.changed, [], 'the Agenda section is compared with no other slide')
  // Its section is excluded, as the docs say, and keeps its number, which is Problem's page now: it says so.
  assert.match(deleted.text, /## 2 · Agenda\nexclude: yes\n<!-- The slide on page 2 is not in the deck any more, so this section is excluded\. -->\n<!-- Page 2 is another slide now: delete this section, or move it to the end and number it after the last slide\. -->\n\nThe plan\./)
  assert.match(deleted.text, /## 5 · Pricing\ncheck: changed\n<!-- This slide is now page 4: move this section there and renumber its heading, then delete "check: changed"\. -->/)
  assert.deepEqual(structureProblems(deleted.text), [], 'no heading was renumbered into another')
  const swapped = mergeScript(text, before, real(['Intro', 'Problem', 'Agenda', 'Solution', 'Pricing'], { id: 'q4-roadmap-newid2' }))
  assert.deepEqual(swapped.moved, [{ from: 2, to: 3 }, { from: 3, to: 2 }])
  assert.equal(swapped.renumbered, false)
  assert.match(swapped.text, /## 2 · Agenda\ncheck: changed\n<!-- This slide is now page 3: move this section there/)
  assert.deepEqual(checkScript(parse(swapped.text), null).errors.filter(e => /changed after/.test(e.message)).map(e => e.page), [2, 3])
  // Repeated slides, the same text and picture, are matched in order: the two "Thanks" slides follow theirs past the
  // new page, and only it gets a TODO.
  const repeated = mergeScript(script(sectionsOf([[1, 'Thanks', 'Thank you.'], [2, 'Thanks', 'Thanks again.']])), real(['Thanks', 'Thanks']), real(['New', 'Thanks', 'Thanks'], { id: 'q4-roadmap-newid2' }))
  assert.deepEqual([repeated.moved, repeated.changed, repeated.added], [[{ from: 1, to: 2 }, { from: 2, to: 3 }], [], [1]])
  // The same text with another picture is another slide: compared where it is.
  const redrawn = mergeScript(script(sectionsOf([[1, 'Thanks', 'Thank you.'], [2, 'Thanks', 'Thanks again.']])), real(['Thanks', 'Thanks']), deck(['Thanks', 'Thanks'], { id: 'q4-roadmap-newid2', images: ['picture of Thanks', 'new picture'] }))
  assert.deepEqual([redrawn.moved, redrawn.changed, redrawn.added], [[], [2], []])
})

test("the merge compares each slide's picture too, and finds a slide with no text by it: swapped, changed under the same title, or shifted by an insert", () => {
  const text = script(sectionsOf([[1, 'Results', 'Here are the results.'], [2, 'Red', 'This red chart shows revenue going up.'], [3, 'Blue', 'The blue one shows costs.']]))
  const before = deck(['Results', '', ''], { images: ['results', 'red', 'blue'] })
  // Two image-only slides swapped: each is found by its picture, so it is a reorder, and each section is told where its
  // slide is now.
  const swapped = mergeScript(text, before, deck(['Results', '', ''], { id: 'q4-roadmap-newid2', images: ['results', 'blue', 'red'] }))
  assert.deepEqual([swapped.moved, swapped.renumbered, swapped.changed], [[{ from: 2, to: 3 }, { from: 3, to: 2 }], false, []])
  assert.match(swapped.text, /## 2 · Red\ncheck: changed\n<!-- This slide is now page 3: move this section there/)
  // A new photo in the same place: compared where it is.
  const replaced = mergeScript(text, before, deck(['Results', '', ''], { id: 'q4-roadmap-newid2', images: ['results', 'green', 'blue'] }))
  assert.deepEqual([replaced.changed, replaced.moved], [[2], []])
  assert.match(replaced.text, /This slide's picture changed since this section was written, though its text did not/)
  const chart = mergeScript(script(sectionsOf([[1, 'Revenue', 'Revenue went up.']])), deck(['Revenue'], { images: ['bar 50'] }), deck(['Revenue'], { id: 'q4-roadmap-newid2', images: ['bar 300'] }))
  assert.deepEqual(chart.changed, [1])
  assert.match(chart.text, /This slide's picture changed since this section was written, though its text did not/)
  const same = mergeScript(text, before, deck(['Results', '', ''], { id: 'q4-roadmap-newid2', images: ['results', 'red', 'blue'] }))
  assert.deepEqual([same.changed, same.moved, same.added, same.gone], [[], [], [], []], 'a re-export renders the same bytes: quiet')
  // Two photos shifted by an inserted slide: found by their pictures, so every heading after it follows its slide.
  const photos = script(sectionsOf([[1, 'Intro', 'Hello.'], [2, 'Team', 'Our team.'], [3, 'Office', 'And this is the new office.'], [4, 'Pricing', 'The price.']]))
  const shifted = mergeScript(photos, real(['Intro', '', '', 'Pricing'], { images: ['intro', 'team', 'office', 'pricing'] }), real(['Intro', 'Customer story', '', '', 'Pricing'], { id: 'q4-roadmap-newid2', images: ['intro', 'story', 'team', 'office', 'pricing'] }))
  assert.deepEqual([shifted.changed, shifted.added, shifted.renumbered], [[], [2], true])
  assert.deepEqual(shifted.moved, [{ from: 2, to: 3 }, { from: 3, to: 4 }, { from: 4, to: 5 }])
})

test('the merge, for a slide inserted before an image-only one: the photo is found by its picture, and the new page gets its section', () => {
  const text = script(sectionsOf([[1, 'Intro', 'Hello.'], [2, 'Photo', 'This is our new office.'], [3, 'Pricing', 'The price.']]))
  const before = real(['Intro', '', 'Pricing'], { images: ['intro', 'office', 'pricing'] })
  const after = real(['Customer story', 'Intro', '', 'Pricing'], { id: 'q4-roadmap-newid2', images: ['story', 'intro', 'office', 'pricing'] })
  const merged = mergeScript(text, before, after)
  assert.deepEqual([merged.moved, merged.renumbered], [[{ from: 1, to: 2 }, { from: 2, to: 3 }, { from: 3, to: 4 }], true])
  assert.deepEqual([merged.added, merged.changed, merged.gone, merged.unsectioned], [[1], [], [], []])
  assert.match(merged.text, /## 3 · Photo\n<!-- Was page 2: the slide moved to page 3\. -->\n\nThis is our new office\./)
  assert.ok(!merged.text.includes('On the slide now'), 'no section is told about another slide')
  const checked = checkScript(parse(merged.text), after)
  assert.deepEqual(messages(checked.errors), ['TODO: write the narration, or add "exclude: yes"'])
  assert.deepEqual(checked.errors.map(e => e.page), [1])
})

test('the merge, for an insert and a delete together: the headings follow their slides, the new page gets a section, and the deleted slide\'s section is excluded after them', () => {
  const before = real(['Intro', 'Problem', 'Fix', 'Pricing'])
  const text = script(sectionsOf([[1, 'Intro', 'Hello.'], [2, 'Problem', 'Here is the problem.'], [3, 'Fix', 'Here is the fix.'], [4, 'Pricing', 'It costs twelve dollars.']]))
  const after = real(['Intro', 'Customer story', 'Problem', 'Fix'], { id: 'q4-roadmap-newid2' })
  const merged = mergeScript(text, before, after)
  assert.equal(merged.renumbered, true)
  assert.deepEqual(merged.moved, [{ from: 2, to: 3 }, { from: 3, to: 4 }])
  assert.deepEqual([merged.added, merged.gone, merged.retired, merged.changed, merged.unsectioned], [[2], [4], [{ from: 4, to: 5 }], [], []])
  assert.match(merged.text, /\n## 5 · Pricing\nexclude: yes\n<!-- Was page 4: that slide is not in the deck any more, so this section is excluded\. -->\n\nIt costs twelve dollars\.\n$/)
  assert.deepEqual(structureProblems(merged.text), [])
  assert.deepEqual(parse(merged.text).script?.sections.map(s => [s.page, s.exclude, s.paragraphs.join(' ')]), [
    [1, false, 'Hello.'], [2, false, 'TODO'], [3, false, 'Here is the problem.'], [4, false, 'Here is the fix.'], [5, true, 'It costs twelve dollars.'],
  ])
  const checked = checkScript(parse(merged.text), after)
  assert.deepEqual(messages(checked.errors), ['TODO: write the narration, or add "exclude: yes"'])
  assert.ok(!messages(checked.warnings).some(m => /no section/.test(m)), 'every page has its section')
  // Its slide was deleted, so it never comes back: a new page 5 gets a section of its own, and the excluded one moves
  // past it.
  const grown = mergeScript(merged.text, after, real(['Intro', 'Customer story', 'Problem', 'Fix', 'Appendix'], { id: 'q4-roadmap-newid3' }))
  assert.deepEqual([grown.back, grown.added, grown.retired], [[], [5], [{ from: 5, to: 6 }]])
  assert.match(grown.text, /\n## 5 · Appendix\ncheck: yes\n\nTODO\n<!-- On the slide: "Appendix" -->\n\n## 6 · Pricing\nexclude: yes\n<!-- Was page 4: that slide is not in the deck any more, so this section is excluded\. -->\n/)
})

test('the merge, when the headings must stay (an insert, and a delete between two slides): a new page on a section\'s number is said, and quoted in that section', () => {
  const before = real(['Intro', 'Agenda', 'Problem', 'Fix'])
  const text = script(sectionsOf([[1, 'Intro', 'Hello.'], [2, 'Agenda', 'The plan.'], [3, 'Problem', 'Here is the problem.'], [4, 'Fix', 'Here is the fix.']]))
  const after = real(['Customer story', 'Intro', 'Problem', 'Fix'], { id: 'q4-roadmap-newid2' })
  const merged = mergeScript(text, before, after)
  assert.equal(merged.renumbered, false, 'the Agenda section has no number left between Intro and Problem')
  assert.deepEqual(merged.moved, [{ from: 1, to: 2 }])
  assert.deepEqual([merged.changed, merged.added, merged.unsectioned, merged.gone], [[], [], [1], [2]])
  // The Intro section is told to move, and what its page shows now: the new slide, which has no section yet.
  assert.match(merged.text, /## 1 · Intro\ncheck: changed\n<!-- This slide is now page 2: move this section there and renumber its heading, then delete "check: changed"\. -->\n\nHello\.\n\n<!-- On page 1 now, with no section yet: "Customer story" -->\n\n## 2 · Agenda/)
  // The Agenda slide is gone: its section is excluded, never compared with Intro, and says it is in Intro's way.
  assert.match(merged.text, /## 2 · Agenda\nexclude: yes\n<!-- The slide on page 2 is not in the deck any more, so this section is excluded\. -->\n<!-- Page 2 is another slide now: .* -->\n\nThe plan\.\n\n## 3 · Problem/)
  assert.deepEqual(structureProblems(merged.text), [])
  assert.deepEqual(checkScript(parse(merged.text), after).errors.map(e => e.page), [1], 'the Intro section must move before check passes')
  // A reorder with an insert: the new page has a section's number too.
  const reordered = mergeScript(script(sectionsOf([[1, 'Intro', 'Hello.'], [2, 'Problem', 'The problem.'], [3, 'Fix', 'The fix.']])), real(['Intro', 'Problem', 'Fix']), real(['Problem', 'Customer story', 'Intro', 'Fix'], { id: 'q4-roadmap-newid2' }))
  assert.deepEqual([reordered.renumbered, reordered.unsectioned, reordered.added], [false, [2], []])
  assert.match(reordered.text, /## 2 · Problem\ncheck: changed\n<!-- This slide is now page 1: move this section there.*\n\nThe problem\.\n\n<!-- On page 2 now, with no section yet: "Customer story" -->/)
})

test('the merge, for a page that went and came back: its own exclude is undone with check: changed; the owner\'s is kept', () => {
  const text = script(sectionsOf([[1, 'Intro', 'Hello.'], [2, 'Problem', 'Here is the problem.'], [3, 'Fix', 'Here is the fix.']]))
  const full = real(['Intro', 'Problem', 'Fix'])
  const left = mergeScript(text, full, real(['Intro', 'Problem', 'Fix'], { id: 'q4-roadmap-newid2', excluded: [2] }))
  assert.deepEqual(left.gone, [2])
  const back = mergeScript(left.text, real(['Intro', 'Problem', 'Fix'], { id: 'q4-roadmap-newid2', excluded: [2] }), real(['Intro', 'Problem', 'Fix'], { id: 'q4-roadmap-newid3' }))
  assert.deepEqual(back.back, [2])
  assert.ok(!/exclude: yes|was left out/.test(back.text), back.text)
  assert.deepEqual(messages(checkScript(parse(back.text), real(['Intro', 'Problem', 'Fix'])).errors), ['the slide changed after this was written: read it against the slide, then delete "check: changed"'])
  assert.deepEqual(parse(back.text).script?.sections.map(s => s.paragraphs), parse(text).script?.sections.map(s => s.paragraphs))
  // The deck shrank, then a new, different slide 3 came: the deleted slide's section never comes back over it. The new
  // slide gets a section of its own, and the old one moves past it, still excluded.
  const shrunk = mergeScript(text, full, real(['Intro', 'Problem'], { id: 'q4-roadmap-newid2' }))
  const grown = mergeScript(shrunk.text, real(['Intro', 'Problem'], { id: 'q4-roadmap-newid2' }), real(['Intro', 'Problem', 'Appendix'], { id: 'q4-roadmap-newid3' }))
  assert.deepEqual([grown.back, grown.added, grown.retired], [[], [3], [{ from: 3, to: 4 }]])
  assert.match(grown.text, /\n## 3 · Appendix\ncheck: yes\n\nTODO\n<!-- On the slide: "Appendix" -->\n\n## 4 · Fix\nexclude: yes\n<!-- Was page 3: that slide is not in the deck any more, so this section is excluded\. -->\n/)
  // An exclude the owner wrote is never touched.
  const owner = script(sectionsOf([[1, 'Intro', 'Hello.']]) + '\n## 2 · Problem\nexclude: yes\n\nHere is the problem.\n')
  const kept = mergeScript(owner, full, real(['Intro', 'Problem', 'Fix'], { id: 'q4-roadmap-newid2' }))
  assert.deepEqual([kept.back, kept.excludedRendered], [[], [2]])
  assert.match(kept.text, /## 2 · Problem\nexclude: yes\n\nHere is the problem\./)
})

test('the merge, for a page that went whose section had "on-request: yes" or "exclude: no": one exclude: yes each, and a script check accepts', () => {
  const text = script(`${sectionsOf([[1, 'Intro', 'Hello.'], [2, 'Main', 'The main part.'], [3, 'More', 'More of it.']])}\n## 4 · Spare\nexclude: no\n\nA spare slide.\n\n## 5 · Backup details\non-request: yes\n\nThe backup details.\n`)
  const five = real(['Intro', 'Main', 'More', 'Spare', 'Backup details'])
  assert.deepEqual(checkScript(parse(text), five).errors, [])
  const three = real(['Intro', 'Main', 'More'], { id: 'q4-roadmap-newid2' })
  const merged = mergeScript(text, five, three)
  assert.deepEqual(merged.gone, [4, 5])
  assert.equal(merged.text.match(/^exclude: yes$/gm)?.length, 2)
  assert.ok(!/^exclude: no|^on-request: yes/m.test(merged.text), merged.text)
  const checked = checkScript(parse(merged.text), three)
  assert.deepEqual(checked.errors, [])
  assert.deepEqual(messages(checked.warnings).filter(m => !m.startsWith('on screen')), ['not in the deck: it has 3 pages; its section is excluded, so it is ignored', 'not in the deck: it has 3 pages; its section is excluded, so it is ignored'])
  assert.deepEqual(parse(merged.text).script?.sections.slice(0, 3).map(s => s.paragraphs), parse(text).script?.sections.slice(0, 3).map(s => s.paragraphs))
  // Slides deleted never come back: added again, they get new sections, and the excluded ones move past them.
  const again = mergeScript(merged.text, three, real(['Intro', 'Main', 'More', 'Spare', 'Backup details'], { id: 'q4-roadmap-newid3' }))
  assert.deepEqual([again.back, again.added, again.retired], [[], [4, 5], [{ from: 4, to: 6 }, { from: 5, to: 7 }]])
  // A page left out with --exclude is the one that comes back: on request again.
  const left = mergeScript(text, five, real(['Intro', 'Main', 'More', 'Spare', 'Backup details'], { id: 'q4-roadmap-newid2', excluded: [5] }))
  assert.match(left.text, /## 5\n<!-- on-request: yes \(put it back if the page returns\) -->\nexclude: yes\n<!-- Page 5 was left out when the deck was prepared, so this section is excluded\. -->\n/)
  const back = mergeScript(left.text, real(['Intro', 'Main', 'More', 'Spare', 'Backup details'], { excluded: [5] }), real(['Intro', 'Main', 'More', 'Spare', 'Backup details'], { id: 'q4-roadmap-newid3' }))
  assert.deepEqual(back.back, [5])
  assert.equal(parse(back.text).script?.sections[4].onRequest, true)
})

test('the merge puts the new id on any deck line, keeping its comment and spacing', () => {
  const deckLine = (line: string) => mergeScript(`---\n${line}\n---\n\n## 1 · Intro\n\nHello.\n`, null, real(['Intro'], { id: 'talk-3ha3xs' })).text.split('\n')[1]
  assert.equal(deckLine('deck:      # fill in'), 'deck: talk-3ha3xs      # fill in')
  assert.equal(deckLine('deck:# x'), 'deck: talk-3ha3xs # x')
  assert.equal(deckLine('deck: fill me in'), 'deck: talk-3ha3xs')
  assert.equal(deckLine('deck: q4-roadmap-k7m2qa      # written by prepare: don\'t change it'), 'deck: talk-3ha3xs      # written by prepare: don\'t change it')
  assert.equal(deckLine('deck: x <!-- mine -->'), 'deck: talk-3ha3xs <!-- mine -->')
  for (const line of ['deck:      # fill in', 'deck:# x', 'deck: fill me in']) {
    const merged = mergeScript(`---\n${line}\n---\n\n## 1 · Intro\n\nHello.\n`, null, real(['Intro'], { id: 'talk-3ha3xs' }))
    assert.equal(parse(merged.text).script?.deck, 'talk-3ha3xs', line)
  }
})

test("the merge, for a page left out with --exclude: prepare's own comments quoting it go, and its heading's title if it is the slide's", () => {
  const before = real(['Intro', 'Project Zebracorn', 'Fix'])
  const skeletonText = skeleton(before, { name: 'Alex', scriptPath: 'q4.script.md', notes: new Map([[2, 'Zebracorn pays 40k']]) })
  const written = skeletonText.replace(/## 2 · Project Zebracorn\ncheck: yes\n\nTODO/, '## 2 · Project Zebracorn\n\nWe signed a big customer.')
  const merged = mergeScript(written, before, real(['Intro', 'Project Zebracorn', 'Fix'], { id: 'q4-roadmap-newid2', excluded: [2] }))
  assert.deepEqual(merged.scrubbed, [2])
  assert.ok(!merged.text.includes('Zebracorn'), merged.text)
  assert.match(merged.text, /\n## 2\nexclude: yes\n<!-- Page 2 was left out when the deck was prepared, so this section is excluded\. -->\n\nWe signed a big customer\.\n/)
  // A section already excluded is cleaned the same way.
  const owner = skeletonText.replace(/## 2 · Project Zebracorn\ncheck: yes\n/, '## 2 · Project Zebracorn\nexclude: yes\n')
  const again = mergeScript(owner, before, real(['Intro', 'Project Zebracorn', 'Fix'], { id: 'q4-roadmap-newid2', excluded: [2] }))
  assert.deepEqual(again.scrubbed, [2])
  assert.ok(!again.text.includes('Zebracorn'), again.text)
})

/** Alpha, Bravo, Charlie and so on, each narrated, with "exclude: yes" on the pages in `excluded`. */
const narrated = (titles: string[], excluded: number[] = []) =>
  script(titles.map((t, i) => `## ${i + 1} · ${t}\n${excluded.includes(i + 1) ? 'exclude: yes\n' : ''}\nAbout ${t.toLowerCase()}.\n`).join('\n'))

test('repro: an excluded slide that moved, when the headings must stay, is told to move, and the new slide on its number is said', () => {
  // Alpha, Bravo, Charlie, with exclude: yes on Bravo, re-exported as Alpha, New, Charlie, Bravo. Before, prepare said
  // "no slide changed", New got no section, check passed, and the advice was --exclude 2, which would drop New.
  const merged = mergeScript(narrated(['Alpha', 'Bravo', 'Charlie'], [2]), real(['Alpha', 'Bravo', 'Charlie']), real(['Alpha', 'New', 'Charlie', 'Bravo'], { id: 'q4-roadmap-newid2' }))
  assert.equal(merged.renumbered, false)
  assert.deepEqual([merged.moved, merged.unsectioned, merged.added, merged.changed, merged.excludedRendered], [[{ from: 2, to: 4 }], [2], [], [], [4]])
  assert.match(merged.text, /## 2 · Bravo\nexclude: yes\ncheck: changed\n<!-- This slide is now page 4: move this section there and renumber its heading, then delete "check: changed"\. -->\n\nAbout bravo\.\n\n<!-- On page 2 now, with no section yet: "New" -->\n\n## 3 · Charlie/)
  const checked = checkScript(parse(merged.text), real(['Alpha', 'New', 'Charlie', 'Bravo']))
  assert.deepEqual(checked.errors.map(e => [e.page, e.message]), [[2, 'the slide on this page changed after the section was excluded: read its comments, then delete "check: changed"']])
  // Two slides, Alpha excluded: Bravo re-exported as New, Bravo, Alpha.
  const two = mergeScript(narrated(['Alpha', 'Bravo'], [1]), real(['Alpha', 'Bravo']), real(['New', 'Bravo', 'Alpha'], { id: 'q4-roadmap-newid2' }))
  assert.deepEqual([two.moved, two.unsectioned, two.added, two.excludedRendered], [[{ from: 1, to: 3 }], [1], [], [3]])
  assert.match(two.text, /## 1 · Alpha\nexclude: yes\ncheck: changed\n<!-- This slide is now page 3: .*\n\nAbout alpha\.\n\n<!-- On page 1 now, with no section yet: "New" -->/)
  // Alpha, Bravo excluded, Charlie, Delta, re-exported as Alpha, New, Delta, Charlie, Bravo.
  const four = mergeScript(narrated(['Alpha', 'Bravo', 'Charlie', 'Delta'], [2]), real(['Alpha', 'Bravo', 'Charlie', 'Delta']), real(['Alpha', 'New', 'Delta', 'Charlie', 'Bravo'], { id: 'q4-roadmap-newid2' }))
  assert.deepEqual([four.moved, four.unsectioned, four.added, four.excludedRendered], [[{ from: 2, to: 5 }, { from: 3, to: 4 }, { from: 4, to: 3 }], [2], [], [5]])
  assert.match(four.text, /## 2 · Bravo\nexclude: yes\ncheck: changed\n<!-- This slide is now page 5: .*\n\nAbout bravo\.\n\n<!-- On page 2 now, with no section yet: "New" -->/)
  // When the headings can follow their slides, the excluded section is renumbered with its slide, as before.
  const renumbered = mergeScript(narrated(['Alpha', 'Bravo', 'Charlie'], [2]), real(['Alpha', 'Bravo', 'Charlie']), real(['New', 'Alpha', 'Bravo', 'Charlie'], { id: 'q4-roadmap-newid2' }))
  assert.deepEqual([renumbered.moved, renumbered.added, renumbered.excludedRendered], [[{ from: 1, to: 2 }, { from: 2, to: 3 }, { from: 3, to: 4 }], [1], [3]])
})

test('repro: a deleted slide\'s section, retired past the deck\'s end, never comes back over a new slide that takes that number', () => {
  // Alpha to Echo, then Alpha, New, Bravo, Charlie, Delta: Echo's section is retired to 6. Then Foxtrot is added as page
  // 6. Before, page 6 was "back in the deck", Echo's narration lost its exclude over Foxtrot, and Foxtrot got no TODO.
  const a = real(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'])
  const b = real(['Alpha', 'New', 'Bravo', 'Charlie', 'Delta'], { id: 'q4-roadmap-newid2' })
  const c = real(['Alpha', 'New', 'Bravo', 'Charlie', 'Delta', 'Foxtrot'], { id: 'q4-roadmap-newid3' })
  const first = mergeScript(narrated(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']), a, b)
  assert.deepEqual([first.added, first.gone, first.retired], [[2], [5], [{ from: 5, to: 6 }]])
  const written = first.text.replace(/check: yes\n\nTODO/, '\nAbout new.')
  const second = mergeScript(written, b, c)
  assert.deepEqual([second.back, second.added, second.retired, second.changed, second.moved], [[], [6], [{ from: 6, to: 7 }], [], []])
  assert.match(second.text, /\n## 6 · Foxtrot\ncheck: yes\n\nTODO\n<!-- On the slide: "Foxtrot" -->\n\n## 7 · Echo\nexclude: yes\n<!-- Was page 5: that slide is not in the deck any more, so this section is excluded\. -->\n\nAbout echo\.\n$/)
  assert.deepEqual(messages(checkScript(parse(second.text), c).errors), ['TODO: write the narration, or add "exclude: yes"'])
})

test('repro: a slide deleted first or between two others gets exclude: yes, as the docs say, never check: changed over the next slide', () => {
  const text = narrated(['Alpha', 'Bravo', 'Charlie'])
  const abc = real(['Alpha', 'Bravo', 'Charlie'])
  for (const [left, page] of [[['Bravo', 'Charlie'], 1], [['Alpha', 'Charlie'], 2]] as [string[], number][]) {
    const merged = mergeScript(text, abc, real(left, { id: 'q4-roadmap-newid2' }))
    const title = ['Alpha', 'Bravo'][page - 1]
    assert.deepEqual([merged.gone, merged.changed, merged.renumbered], [[page], [], false], left.join())
    // Its number is the next slide's page now, whose section is told to move there: the comment says what to do.
    assert.match(merged.text, new RegExp(`## ${page} · ${title}\\nexclude: yes\\n<!-- The slide on page ${page} is not in the deck any more, so this section is excluded\\. -->\\n<!-- Page ${page} is another slide now: delete this section, or move it to the end and number it after the last slide\\. -->\\n\\nAbout ${title.toLowerCase()}\\.\\n\\n## ${page + 1}`))
    assert.ok(!merged.text.includes('On the slide now'), 'the next slide is quoted nowhere')
  }
})

test('repro: a "This slide is now page N" comment goes once a later merge renumbers the section to N', () => {
  // Agenda deleted between two slides: the headings stay, and Problem and Fix are told to move. The owner deletes the
  // Agenda section, as its comment says, and prepares again before moving the others: they are renumbered now.
  const before = real(['Intro', 'Agenda', 'Problem', 'Fix'])
  const after = real(['Intro', 'Problem', 'Fix'], { id: 'q4-roadmap-newid2' })
  const stuck = mergeScript(narrated(['Intro', 'Agenda', 'Problem', 'Fix']), before, after)
  assert.deepEqual([stuck.renumbered, stuck.moved], [false, [{ from: 3, to: 2 }, { from: 4, to: 3 }]])
  const cleared = stuck.text.replace(/## 2 · Agenda\n[\s\S]*?(?=## 3)/, '')
  const again = mergeScript(cleared, after, real(['Intro', 'Problem', 'Fix'], { id: 'q4-roadmap-newid3' }))
  assert.deepEqual([again.renumbered, again.moved], [true, [{ from: 3, to: 2 }, { from: 4, to: 3 }]])
  assert.ok(!again.text.includes('This slide is now page'), again.text)
  assert.match(again.text, /## 2 · Problem\ncheck: changed\n<!-- Was page 3: the slide moved to page 2\. -->\n\nAbout problem\./)
  // Prepared again with the sections still where they were, a section's slide is the one its comment names.
  const same = mergeScript(stuck.text, after, real(['Intro', 'Problem', 'Fix'], { id: 'q4-roadmap-newid3' }))
  assert.equal(same.text.replace(/q4-roadmap-newid3/, 'q4-roadmap-newid2'), stuck.text, 'nothing changes but the deck line')
  // Two slides swapped, the sections not moved yet, then a slide inserted at the front. Before, the sections were
  // renumbered by their numbers, each over the other's slide, and "now page 3" pointed at its own new heading.
  const swapped = mergeScript(narrated(['Intro', 'Problem', 'Fix']), real(['Intro', 'Problem', 'Fix']), real(['Intro', 'Fix', 'Problem'], { id: 'q4-roadmap-newid2' }))
  assert.deepEqual(swapped.moved, [{ from: 2, to: 3 }, { from: 3, to: 2 }])
  const grown = mergeScript(swapped.text, real(['Intro', 'Fix', 'Problem']), real(['Welcome', 'Intro', 'Fix', 'Problem'], { id: 'q4-roadmap-newid3' }))
  assert.deepEqual([grown.renumbered, grown.moved, grown.unsectioned], [false, [{ from: 1, to: 2 }, { from: 2, to: 4 }, { from: 3, to: 3 }].filter(m => m.from !== m.to), [1]])
  for (const [, page, to] of grown.text.matchAll(/## (\d+)[^\n]*\n(?:[^\n]+\n)*?<!-- This slide is now page (\d+):/g)) assert.notEqual(page, to, `## ${page} is told to move to itself`)
  assert.match(grown.text, /## 2 · Problem\ncheck: changed\n<!-- This slide is now page 4: .*\n\nAbout problem\./)
  assert.match(grown.text, /## 3 · Fix\ncheck: changed\n\nAbout fix\./)
})

test('repro: a section whose slide moved and changed quotes its own slide, not the one on its old number', () => {
  const text = narrated(['Intro', 'Revenue', 'Fix'])
  const before = real(['Intro', 'Revenue', 'Fix'], { images: ['intro', 'bars of 50', 'fix'] })
  const after = real(['Intro', 'Fix', 'Revenue'], { id: 'q4-roadmap-newid2', images: ['intro', 'fix', 'bars of 300'] })
  const merged = mergeScript(text, before, after)
  assert.deepEqual([merged.renumbered, merged.moved, merged.changed], [false, [{ from: 2, to: 3 }, { from: 3, to: 2 }], [3]])
  assert.match(merged.text, /## 2 · Revenue\ncheck: changed\n<!-- This slide's picture changed since this section was written, though its text did not: .* -->\n<!-- This slide is now page 3: .* -->\n\nAbout revenue\.\n\n<!-- On the slide now: "Revenue" -->\n\n## 3/)
})

test('repro: an excluded slide replaced where it was is marked, and check refuses it until it is read', () => {
  const merged = mergeScript(narrated(['Intro', 'Customer list', 'Fix'], [2]), real(['Intro', 'Customer list', 'Fix']), real(['Intro', 'Roadmap', 'Fix'], { id: 'q4-roadmap-newid2' }))
  assert.deepEqual([merged.changed, merged.excludedRendered, merged.moved], [[2], [2], []])
  assert.match(merged.text, /## 2 · Customer list\nexclude: yes\ncheck: changed\n<!-- This slide changed since this section was excluded: make sure it should still be left out, then delete "check: changed"\. -->\n\nAbout customer list\.\n\n<!-- On the slide now: "Roadmap" -->/)
  assert.deepEqual(checkScript(parse(merged.text), real(['Intro', 'Roadmap', 'Fix'])).errors.map(e => e.page), [2])
  // The same slide again, or no old deck to compare with: left alone.
  const same = mergeScript(narrated(['Intro', 'Customer list', 'Fix'], [2]), real(['Intro', 'Customer list', 'Fix']), real(['Intro', 'Customer list', 'Fix'], { id: 'q4-roadmap-newid2' }))
  assert.deepEqual([same.changed, same.excludedRendered], [[], [2]])
  assert.ok(!mergeScript(narrated(['Intro', 'Customer list', 'Fix'], [2]), null, real(['Intro', 'Roadmap', 'Fix'])).text.includes('exclude: yes\ncheck: changed'))
})

test('a script whose structure is unclear is never merged into: no front matter or deck line, an open comment, sections out of order', () => {
  assert.match(messages(structureProblems('## 1\n\nHi.\n'))[0], /must start with its front matter/)
  assert.match(messages(structureProblems('---\ntitle: x\n---\n## 1\n\nHi.\n'))[0], /no "deck:" line/)
  assert.match(messages(structureProblems(script('## 1\n\nHi. <!-- open\n')))[0], /never closed/)
  assert.match(messages(structureProblems(script('## 2\n\nHi.\n\n## 1\n\nHo.\n')))[0], /page order/)
  assert.deepEqual(structureProblems(script('## 1\nNote: hi\nTODO\n')), [], 'content problems are for check, not a reason to refuse an update')
})
