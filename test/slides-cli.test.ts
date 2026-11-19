// npm run slides: its arguments (src/cli/slides-args.ts), what prepare, check, list and delete do and print
// (src/slides/actions.ts), from a new deck to a written script, a changed deck and a deleted one, and the command
// itself, run as npm runs it, with no key in its environment.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT } from '../src/config.ts'
import { pageList, slidesArgs } from '../src/cli/slides-args.ts'
import { ranges, runCheck, runDelete, runList, runPrepare, scriptFor, shown } from '../src/slides/actions.ts'
import { DeckStore } from '../src/slides/deck.ts'
import { parseScript } from '../src/slides/script.ts'
import { makePdf } from './fixtures/slides/make-pdf.ts'
import { makeZip } from './fixtures/slides/make-zip.ts'

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'av-slides-cli-'))
process.on('exit', () => fs.rmSync(DIR, { recursive: true, force: true }))

test('the arguments: each command, its options, and what is refused', () => {
  assert.deepEqual(slidesArgs(['prepare', 'deck.pdf']), { command: 'prepare', file: 'deck.pdf', exclude: [] })
  assert.deepEqual(slidesArgs(['prepare', '--exclude', '3,9', 'deck.pdf', '--exclude=4-5', '--label', 'Q4 plan']), {
    command: 'prepare', file: 'deck.pdf', exclude: [3, 4, 5, 9], label: 'Q4 plan',
  })
  assert.deepEqual(slidesArgs(['check', 'deck.script.md']), { command: 'check', file: 'deck.script.md' })
  assert.deepEqual(slidesArgs(['list']), { command: 'list' })
  assert.deepEqual(slidesArgs(['delete', 'q4-roadmap-k7m2qa']), { command: 'delete', ids: ['q4-roadmap-k7m2qa'], all: false })
  assert.deepEqual(slidesArgs(['delete', '--all']), { command: 'delete', ids: [], all: true })
  for (const help of [[], ['help'], ['--help'], ['-h']]) assert.deepEqual(slidesArgs(help), { command: 'help' })
  const problem = (argv: string[]) => (slidesArgs(argv) as { problem: string }).problem
  assert.equal(problem(['present', 'x']), 'Unknown command present.')
  assert.equal(problem(['prepare']), 'Give one PDF.')
  assert.equal(problem(['prepare', 'a.pdf', 'b.pdf']), 'Give one PDF.')
  assert.equal(problem(['prepare', 'a.pdf', '--exclude']), '--exclude needs a value after it.')
  assert.match(problem(['prepare', 'a.pdf', '--exclude', 'three']), /--exclude takes page numbers from 1 to 100/)
  assert.equal(problem(['prepare', 'a.pdf', '--label', 'a', '--label', 'b']), 'Give --label once.')
  assert.equal(problem(['prepare', 'a.pdf', '--draft']), 'Unknown option --draft.')
  assert.equal(problem(['check', 'a.md', '--exclude', '3']), 'check takes no --exclude.')
  assert.equal(problem(['check']), 'Give one script (<deck>.script.md).')
  assert.equal(problem(['list', 'x']), 'list takes nothing more.')
  assert.equal(problem(['delete']), 'Give the deck ids to delete, or --all.')
  assert.equal(problem(['delete', 'x', '--all']), 'Give the deck ids to delete, or --all.')
  assert.deepEqual(pageList('3, 9,4-6'), [3, 4, 5, 6, 9])
  for (const bad of ['0', '101', '5-3', '3-', 'a', '']) assert.equal(pageList(bad), null, bad)
})

test('paths: the script beside the PDF, shown from where the command ran', () => {
  assert.equal(scriptFor('/x/decks/Q4 plan.PDF'), '/x/decks/Q4 plan.script.md')
  assert.equal(scriptFor('/x/deck'), '/x/deck.script.md')
  assert.equal(shown('/x/decks/a.md', '/x'), 'decks/a.md')
  assert.equal(shown('/y/a.md', '/x'), '/y/a.md')
})

const pages = (pricing: string) => [
  { texts: [{ text: 'Q4 roadmap', size: 40 }, { text: 'What ships this quarter', size: 24 }] },
  { texts: [{ text: 'Pricing', size: 40 }, { text: pricing, size: 24 }] },
  { size: [720, 540] as [number, number], texts: [{ text: 'An old 4:3 slide', size: 36 }] },
]

test('from a PDF to a checked script: prepare, write, check; prepare again after a change; list and delete', async () => {
  const work = fs.mkdtempSync(path.join(DIR, 'work-'))
  const decksDir = path.join(work, 'data', 'decks')
  const pdf = path.join(work, 'Q4 roadmap.pdf')
  const scriptFile = path.join(work, 'Q4 roadmap.script.md')
  fs.writeFileSync(pdf, makePdf([...pages('Team 12, Business 29'), { texts: [{ text: 'Customer list', size: 40 }] }]))

  // prepare: a deck, a new skeleton script, and the contact sheet.
  const first = await runPrepare({ input: pdf, exclude: [4], decksDir, name: 'Alex', cwd: work })
  assert.equal(first.code, 0, first.lines.join('\n'))
  const id = /^Prepared (q4-roadmap-[a-z2-7]{6}): 3 pages rendered \(1 excluded\) from Q4 roadmap\.pdf\.$/.exec(first.lines[0])?.[1] ?? ''
  assert.ok(id, first.lines[0])
  assert.deepEqual(first.lines.slice(1), [
    'Script: Q4 roadmap.script.md (new): 3 sections to write (TODO).',
    '  page 3 is not 16:9, so it is shown with bars at its sides or above and below.',
    `Contact sheet: data/decks/${id}/sheet.html`,
    'Next: write the sections (or ask your Claude Code session to draft them), then',
    "  npm run slides -- check 'Q4 roadmap.script.md'",
  ])
  assert.equal(fs.statSync(scriptFile).mode & 0o777, 0o600)
  const sheet = fs.readFileSync(path.join(decksDir, id, 'sheet.html'), 'utf8')
  assert.match(sheet, /0 slides to present \(3 to write\); 3 errors/, 'TODO is not narration: nothing to time yet')
  assert.match(sheet, /To write \(TODO\): not narrated yet\./)
  assert.ok(!sheet.includes('Narrated'), sheet)
  assert.ok(!sheet.includes('Customer list'), 'the excluded page is nowhere')

  // check on the skeleton: TODO everywhere, so errors, and exit 1.
  const todo = runCheck({ file: scriptFile, decksDir, retentionDays: 30, cwd: work })
  assert.equal(todo.code, 1)
  assert.equal(todo.lines.filter(l => l.includes('TODO: write the narration')).length, 3)

  // The owner writes the sections.
  const skeleton = fs.readFileSync(scriptFile, 'utf8')
  const written = skeleton
    .replace(/## 1 · Q4 roadmap\ncheck: yes\n\nTODO/, "## 1 · Q4 roadmap\n\nHello everyone. I'll walk you through what ships this quarter.")
    .replace(/## 2 · Pricing\ncheck: yes\n\nTODO/, '## 2 · Pricing\npause: 3s\n\nTeam is twelve dollars per user per month, and Business is twenty-nine. Any questions?')
    .replace(/## 3 · An old 4:3 slide\ncheck: yes\n\nTODO/, '## 3 · An old 4:3 slide\non-request: yes\n\nThis is our older plan, for reference.')
  fs.writeFileSync(scriptFile, written)
  const past = new Date('2026-01-01T00:00:00Z')
  fs.utimesSync(path.join(decksDir, id, 'manifest.json'), past, past)
  const ok = runCheck({ file: scriptFile, decksDir, retentionDays: 30, cwd: work, now: new Date('2026-11-19T12:00:00Z') })
  assert.equal(ok.code, 0, ok.lines.join('\n'))
  assert.match(ok.lines[0], new RegExp(`^Q4 roadmap\\.script\\.md \\(deck ${id}\\): 2 slides to present \\(1 on request\\), about \\d+ s\\.$`))
  assert.ok(ok.lines.includes("No errors. The estimate comes from the script's length: the real timing is known only in a meeting."))
  assert.ok(ok.lines.includes('  page 3: the slide is not 16:9, so it is shown with bars at its sides or above and below.'))
  assert.equal(new DeckStore(decksDir).load(id).usedAt.toISOString(), '2026-11-19T12:00:00.000Z', 'check counts as a use')
  const checkedSheet = fs.readFileSync(path.join(decksDir, id, 'sheet.html'), 'utf8')
  assert.match(checkedSheet, /<h1>Q4 roadmap<\/h1>/)
  assert.match(checkedSheet, /Hello everyone\. I&#39;ll walk you through what ships this quarter\./)
  assert.match(checkedSheet, /On request: shown only when someone asks for it/)

  // The slide changes: prepare again updates the script, never a written paragraph, and deletes the old deck.
  fs.writeFileSync(pdf, makePdf([...pages('Team 14, Business 29'), { texts: [{ text: 'Thanks', size: 40 }] }]))
  const again = await runPrepare({ input: pdf, exclude: [], decksDir, name: 'Alex', cwd: work })
  assert.equal(again.code, 0, again.lines.join('\n'))
  const newId = /^Prepared (q4-roadmap-[a-z2-7]{6}):/.exec(again.lines[0])?.[1] ?? ''
  assert.notEqual(newId, id)
  assert.equal(again.lines[1], 'Script: Q4 roadmap.script.md (updated for the new deck): page 2 changed (check: changed); page 4 new (TODO). Your written paragraphs are unchanged.')
  assert.equal(again.lines[2], `  Deleted the deck it was written for (${id}).`)
  assert.deepEqual(new DeckStore(decksDir).ids(), [newId])
  const updated = fs.readFileSync(scriptFile, 'utf8')
  for (const paragraph of ["Hello everyone. I'll walk you through what ships this quarter.", 'Team is twelve dollars per user per month, and Business is twenty-nine. Any questions?']) {
    assert.ok(updated.includes(paragraph), paragraph)
  }
  const stale = runCheck({ file: scriptFile, decksDir, retentionDays: 30, cwd: work })
  assert.equal(stale.code, 1)
  assert.ok(stale.lines.some(l => /page 2, line \d+: the slide changed after this was written/.test(l)), stale.lines.join('\n'))

  // list and delete.
  const list = runList({ decksDir, retentionDays: 30, cwd: work })
  assert.equal(list.lines.length, 1)
  assert.match(list.lines[0], new RegExp(`^${newId}  "Q4 roadmap": 4 slides, prepared \\d{4}-\\d{2}-\\d{2}, last used \\d{4}-\\d{2}-\\d{2} \\(deleted after \\d{4}-\\d{2}-\\d{2} unless used\\)$`))
  assert.deepEqual(runDelete({ decksDir, ids: [newId], all: false }), { lines: [`Deleted ${newId}.`], code: 0 })
  assert.deepEqual(runDelete({ decksDir, ids: [newId, '../etc'], all: false }), {
    lines: [`There is no deck ${newId}.`, '"../etc" is not a deck id (npm run slides -- list shows them).'],
    code: 1,
  })
  assert.deepEqual(runList({ decksDir, retentionDays: 30, cwd: work }).lines, ['No prepared decks in data/decks.'])

  // The deck is gone, but the script stays: check says how to get it back.
  const gone = runCheck({ file: scriptFile, decksDir, retentionDays: 30, cwd: work })
  assert.equal(gone.code, 1)
  assert.ok(gone.lines.includes(`  the prepared deck ${newId} is gone (decks are deleted 30 days after they were last used, or by slides delete). Run npm run slides -- prepare <your PDF> again: your script is kept, and updated for the new deck.`))
})

test('prepare again: a slide inserted renumbers the sections after it; --exclude takes the slide text out; a page back is read again', async () => {
  const work = fs.mkdtempSync(path.join(DIR, 'again-'))
  const decksDir = path.join(work, 'data', 'decks')
  const pdf = path.join(work, 'talk.pdf')
  const slides = (titles: string[]) => makePdf(titles.map(t => ({ texts: [{ text: t, size: 40 }, { text: `About ${t.toLowerCase()}`, size: 24 }] })))
  const prepare = async (exclude: number[] = []) => {
    const out = await runPrepare({ input: pdf, exclude, decksDir, name: 'Alex', cwd: work })
    assert.equal(out.code, 0, out.lines.join('\n'))
    return out.lines
  }
  const scriptFile = path.join(work, 'talk.script.md')
  fs.writeFileSync(pdf, slides(['Intro', 'Problem', 'Solution']))
  await prepare()
  fs.writeFileSync(scriptFile, fs.readFileSync(scriptFile, 'utf8').replace(/check: yes\n\nTODO/g, '\nWe talk about it here.').replace('## 3 · Solution\n', '## 3 · Solution\nhold: 3s\n'))
  // A slide inserted as page 2: the sections after it are renumbered, and only it gets a TODO.
  fs.writeFileSync(pdf, slides(['Intro', 'Customer story', 'Problem', 'Solution']))
  assert.equal((await prepare())[1], 'Script: talk.script.md (updated for the new deck): pages 2, 3 moved to 3, 4 (headings renumbered); page 2 new (TODO). Your written paragraphs are unchanged.')
  assert.deepEqual(parseScript(fs.readFileSync(scriptFile, 'utf8')).script?.sections.map(s => [s.page, s.heading, s.hold]), [[1, 'Intro', null], [2, 'Customer story', null], [3, 'Problem', null], [4, 'Solution', 3]])
  fs.writeFileSync(scriptFile, fs.readFileSync(scriptFile, 'utf8').replace(/check: yes\n\nTODO/, '\nA customer story.'))
  assert.equal(runCheck({ file: scriptFile, decksDir, retentionDays: 30, cwd: work }).code, 0)

  // --exclude 3 on a deck prepared before: the slide's text and title leave the script; the owner's words stay.
  const left = await prepare([3])
  assert.equal(left[1], 'Script: talk.script.md (updated for the new deck): page 3 no longer in the deck (exclude: yes). Your written paragraphs are unchanged.')
  assert.equal(left[2], "  page 3 left out: prepare's notes of its slide text are gone from the script, but your heading and paragraphs for it are kept. Delete them if they must not appear anywhere.")
  assert.ok(!/Problem|about problem/i.test(fs.readFileSync(scriptFile, 'utf8')), 'the left-out slide is nowhere in the script')

  // Prepared again without --exclude: the page is back, and its section must be read again before it is shown.
  const back = await prepare()
  assert.equal(back[1], 'Script: talk.script.md (updated for the new deck): page 3 back in the deck (check: changed). Your written paragraphs are unchanged.')
  const stale = runCheck({ file: scriptFile, decksDir, retentionDays: 30, cwd: work })
  assert.equal(stale.code, 1)
  assert.ok(stale.lines.some(l => /page 3, line \d+: the slide changed after this was written/.test(l)), stale.lines.join('\n'))

  // A section the owner excluded, whose page is rendered: prepare says its text is in the deck.
  fs.writeFileSync(scriptFile, fs.readFileSync(scriptFile, 'utf8').replace('## 4 · Solution\n', '## 4 · Solution\nexclude: yes\n').replace('hold: 3s\n', ''))
  assert.ok((await prepare()).includes('  page 4 is rendered, though its section says exclude: yes. If its text must not be kept at all, prepare with --exclude 4.'))
})

test('prepare again: an insert with a delete, and a new page on the number of a section that must move, are each said; a key above the deck line is no bar', async () => {
  const work = fs.mkdtempSync(path.join(DIR, 'mixed-'))
  const decksDir = path.join(work, 'data', 'decks')
  const pdf = path.join(work, 'talk.pdf')
  const slides = (titles: string[]) => makePdf(titles.map(t => ({ texts: [{ text: t, size: 40 }, { text: `About ${t.toLowerCase()}`, size: 24 }] })))
  const prepare = async () => {
    const out = await runPrepare({ input: pdf, exclude: [], decksDir, name: 'Alex', cwd: work })
    assert.equal(out.code, 0, out.lines.join('\n'))
    return out.lines
  }
  const scriptFile = path.join(work, 'talk.script.md')
  fs.writeFileSync(pdf, slides(['Intro', 'Problem', 'Solution', 'Pricing']))
  await prepare()
  // Every section written, and an "author:" line at the top, as YAML front matter often has: an error for check, but
  // it hides nothing, so prepare can still update the script.
  fs.writeFileSync(scriptFile, fs.readFileSync(scriptFile, 'utf8').replace(/^---\n/, '---\nauthor: Sam\n').replace(/check: yes\n\nTODO/g, '\nWe talk about it here.'))
  // A slide inserted as page 2, and the last one deleted.
  fs.writeFileSync(pdf, slides(['Intro', 'Customer story', 'Problem', 'Solution']))
  const both = await prepare()
  assert.equal(both[1], 'Script: talk.script.md (updated for the new deck): pages 2, 3 moved to 3, 4 (headings renumbered); page 2 new (TODO); page 4 no longer in the deck (exclude: yes). Your written paragraphs are unchanged.')
  assert.equal(both[2], '  page 4: its section has no slide in the new deck, so its heading is now 5, to keep the sections in page order.')
  assert.deepEqual(parseScript(fs.readFileSync(scriptFile, 'utf8')).script?.sections.map(s => [s.page, s.heading, s.exclude]), [
    [1, 'Intro', false], [2, 'Customer story', false], [3, 'Problem', false], [4, 'Solution', false], [5, 'Pricing', true],
  ])
  fs.writeFileSync(scriptFile, fs.readFileSync(scriptFile, 'utf8').replace(/check: yes\n\nTODO/, '\nA customer story.'))
  assert.deepEqual(runCheck({ file: scriptFile, decksDir, retentionDays: 30, cwd: work }).lines.slice(1, 3), [
    '1 error: the script can\'t be used until it is fixed.',
    '  line 2: this is not a front matter key: they are deck, title and minutes.',
  ])

  // A slide inserted at the front and the second deleted: the Intro section can't be renumbered past Customer story's,
  // so it is told to move, and the new page 1 is said, and quoted in it. Customer story is gone: excluded, never
  // compared with Intro.
  fs.writeFileSync(pdf, slides(['Welcome', 'Intro', 'Problem', 'Solution']))
  const stuck = await prepare()
  assert.equal(stuck[1], 'Script: talk.script.md (updated for the new deck): page 1 is now page 2 (check: changed: move each section to its page); page 1 new, with no section yet (the section on it must move first); page 2 no longer in the deck (exclude: yes). Your written paragraphs are unchanged.')
  assert.match(fs.readFileSync(scriptFile, 'utf8'), /## 1 · Intro\ncheck: changed\n<!-- This slide is now page 2: .*\n\nWe talk about it here\.\n<!-- On the slide: "Intro \/ About intro" -->\n\n<!-- On page 1 now, with no section yet: "Welcome \/ About welcome" -->\n\n## 2 · Customer story\nexclude: yes\n/)
})

test('repro, prepare again: an excluded slide that moved while the headings stay, and a new slide on a deleted one\'s retired number, are each said', async () => {
  const work = fs.mkdtempSync(path.join(DIR, 'repro-'))
  const decksDir = path.join(work, 'data', 'decks')
  const pdf = path.join(work, 'talk.pdf')
  const scriptFile = path.join(work, 'talk.script.md')
  const slides = (titles: string[]) => makePdf(titles.map(t => ({ texts: [{ text: t, size: 40 }, { text: `About ${t.toLowerCase()}`, size: 24 }] })))
  const prepare = async () => {
    const out = await runPrepare({ input: pdf, exclude: [], decksDir, name: 'Alex', cwd: work })
    assert.equal(out.code, 0, out.lines.join('\n'))
    return out.lines
  }
  const write = () => fs.writeFileSync(scriptFile, fs.readFileSync(scriptFile, 'utf8').replace(/check: yes\n\nTODO/g, '\nWe talk about it here.'))

  // Alpha, Bravo, Charlie, with exclude: yes on Bravo, re-exported as Alpha, New, Charlie, Bravo. Before: "no slide
  // changed", New had no section, check passed, and the advice was --exclude 2, which would drop New.
  fs.writeFileSync(pdf, slides(['Alpha', 'Bravo', 'Charlie']))
  await prepare()
  write()
  fs.writeFileSync(scriptFile, fs.readFileSync(scriptFile, 'utf8').replace('## 2 · Bravo\n', '## 2 · Bravo\nexclude: yes\n'))
  fs.writeFileSync(pdf, slides(['Alpha', 'New', 'Charlie', 'Bravo']))
  const moved = await prepare()
  assert.equal(moved[1], 'Script: talk.script.md (updated for the new deck): page 2 is now page 4 (check: changed: move each section to its page); page 2 new, with no section yet (the section on it must move first). Your written paragraphs are unchanged.')
  assert.ok(moved.includes('  page 4 is rendered, though its section says exclude: yes. If its text must not be kept at all, prepare with --exclude 4.'), moved.join('\n'))
  const refused = runCheck({ file: scriptFile, decksDir, retentionDays: 30, cwd: work })
  assert.equal(refused.code, 1)
  assert.ok(refused.lines.some(l => /page 2, line \d+: the slide on this page changed after the section was excluded/.test(l)), refused.lines.join('\n'))

  // Alpha to Echo, then Alpha, New, Bravo, Charlie, Delta: Echo's section is retired to 6. Then Foxtrot comes as page 6.
  // Before: "page 6 back in the deck", Echo's narration over Foxtrot, and no TODO for Foxtrot.
  fs.rmSync(scriptFile)
  fs.writeFileSync(pdf, slides(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']))
  await prepare()
  write()
  fs.writeFileSync(pdf, slides(['Alpha', 'New', 'Bravo', 'Charlie', 'Delta']))
  assert.equal((await prepare())[2], '  page 5: its section has no slide in the new deck, so its heading is now 6, to keep the sections in page order.')
  write()
  fs.writeFileSync(pdf, slides(['Alpha', 'New', 'Bravo', 'Charlie', 'Delta', 'Foxtrot']))
  const grown = await prepare()
  assert.equal(grown[1], 'Script: talk.script.md (updated for the new deck): page 6 new (TODO). Your written paragraphs are unchanged.')
  assert.equal(grown[2], '  page 6: its section has no slide in the new deck, so its heading is now 7, to keep the sections in page order.')
  assert.deepEqual(parseScript(fs.readFileSync(scriptFile, 'utf8')).script?.sections.slice(5).map(s => [s.page, s.heading, s.exclude, s.todo]), [[6, 'Foxtrot', false, true], [7, 'Echo', true, false]])
})

test('prepare again from a deck the earlier build made, with no script mark, compares its slides; one that cannot be used is deleted, never called gone', async () => {
  const work = fs.mkdtempSync(path.join(DIR, 'older-'))
  const decksDir = path.join(work, 'data', 'decks')
  const pdf = path.join(work, 'talk.pdf')
  const scriptFile = path.join(work, 'talk.script.md')
  fs.writeFileSync(pdf, makePdf([{ texts: [{ text: 'Intro', size: 40 }] }, { texts: [{ text: 'Problem', size: 40 }] }]))
  const prepare = async () => {
    const out = await runPrepare({ input: pdf, exclude: [], decksDir, name: 'Alex', cwd: work })
    assert.equal(out.code, 0, out.lines.join('\n'))
    return out.lines
  }
  const editManifest = (id: string, edit: (m: Record<string, unknown>) => void) => {
    const file = path.join(decksDir, id, 'manifest.json')
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    edit(manifest)
    fs.writeFileSync(file, JSON.stringify(manifest), { mode: 0o600 })
  }
  const id = /^Prepared (talk-[a-z2-7]{6}):/.exec((await prepare())[0])?.[1] ?? ''
  fs.writeFileSync(scriptFile, fs.readFileSync(scriptFile, 'utf8').replace(/check: yes\n\nTODO/g, '\nWe talk about it here.'))
  editManifest(id, m => delete m.script)
  const older = await prepare()
  const second = /^Prepared (talk-[a-z2-7]{6}):/.exec(older[0])?.[1] ?? ''
  assert.deepEqual(older.slice(1, 3), ['Script: talk.script.md (updated for the new deck): no slide changed. Your written paragraphs are unchanged.', `  Deleted the deck it was written for (${id}).`])

  // A deck that is there but can't be used: every section is read again, and the deck goes, as it would never be used.
  editManifest(second, m => Object.assign(m, { source: 'talk.pdf' }))
  const invalid = await prepare()
  const third = /^Prepared (talk-[a-z2-7]{6}):/.exec(invalid[0])?.[1] ?? ''
  assert.ok(invalid.includes(`  The prepared deck ${second} can't be used: its manifest has missing or unknown fields. So every section is marked check: changed, and that deck is deleted.`), invalid.join('\n'))
  assert.ok(!invalid.some(l => /is gone/.test(l)), invalid.join('\n'))
  assert.deepEqual(new DeckStore(decksDir).ids(), [third])
  assert.match(fs.readFileSync(scriptFile, 'utf8'), /The deck this script was written for is gone or can't be used/)
})

test('prepare never renders, nor rewrites, when the script beside the PDF has a structure it cannot follow', async () => {
  const work = fs.mkdtempSync(path.join(DIR, 'work-'))
  const decksDir = path.join(work, 'decks')
  const pdf = path.join(work, 'deck.pdf')
  fs.writeFileSync(pdf, makePdf([{}]))
  const broken = '# My notes\n\n## 2 · B\n\nHi.\n'
  fs.writeFileSync(path.join(work, 'deck.script.md'), broken)
  const outcome = await runPrepare({ input: pdf, exclude: [], decksDir, name: 'Alex', cwd: work })
  assert.equal(outcome.code, 1)
  assert.match(outcome.lines[0], /^deck\.script\.md can't be updated until these are fixed \(or move it aside, and prepare writes a new one\):$/)
  assert.match(outcome.lines[1], /must start with its front matter/)
  assert.equal(fs.readFileSync(path.join(work, 'deck.script.md'), 'utf8'), broken)
  assert.ok(!fs.existsSync(decksDir), 'nothing rendered')
  fs.rmSync(path.join(work, 'deck.script.md'))
  fs.mkdirSync(path.join(work, 'deck.script.md'))
  assert.match((await runPrepare({ input: pdf, exclude: [], decksDir, name: 'Alex', cwd: work })).lines[0], /deck\.script\.md is not a plain file\. .* move it aside/)
  // An error with no script there is said by its code, never Node's message with the path, nor advice that doesn't fit.
  const long = `${'d'.repeat(248)}.pdf`
  fs.writeFileSync(path.join(work, long), makePdf([{}]))
  const tooLong = await runPrepare({ input: path.join(work, long), exclude: [], decksDir, name: 'Alex', cwd: work })
  assert.deepEqual(tooLong, { lines: [`${long}'s name is too long to put a script beside it: give the PDF a shorter name, then prepare again.`], code: 1 })
  fs.writeFileSync(path.join(work, 'afile'), 'x')
  assert.deepEqual(await runPrepare({ input: path.join(work, 'afile', 'deck.pdf'), exclude: [], decksDir, name: 'Alex', cwd: work }), { lines: ['deck.pdf was not found.'], code: 1 })
  assert.ok(!fs.existsSync(decksDir), 'still nothing rendered')
})

test("prepare renders nothing when the PDF's folder can't be written to; a script that can't be written late still leaves the warnings and the sheet", async t => {
  const work = fs.mkdtempSync(path.join(DIR, 'ro-'))
  const decksDir = path.join(work, 'decks')
  const pdf = path.join(work, 'talk.pdf')
  fs.writeFileSync(pdf, makePdf([{ texts: [{ text: 'Hello', size: 40 }] }, { size: [720, 540], texts: [{ text: 'Old', size: 40 }] }]))
  const erofs = () => Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' })

  // Found out first: a read-only folder (as root, a chmod would not do).
  const access = t.mock.method(fs, 'accessSync', () => {
    throw erofs()
  })
  const early = await runPrepare({ input: pdf, exclude: [], decksDir, name: 'Alex', cwd: work })
  assert.deepEqual(early, { lines: ["Prepare writes the script beside the PDF, and that folder can't be written to (EROFS). Copy the PDF to a folder you can write to, then prepare it there."], code: 1 })
  assert.ok(!fs.existsSync(decksDir), 'nothing rendered')
  access.mock.restore()

  // Late (a full disk, a race): the warnings, the sheet, and advice for a script that isn't there.
  const write = fs.writeFileSync
  const writes = t.mock.method(fs, 'writeFileSync', (file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (String(file).includes('.script.md')) throw erofs()
    return (write as (...a: unknown[]) => void)(file, ...rest)
  })
  const late = await runPrepare({ input: pdf, exclude: [], decksDir, name: 'Alex', cwd: work })
  assert.equal(late.code, 1)
  const id = /^Prepared (talk-[a-z2-7]{6}):/.exec(late.lines[0])?.[1] ?? ''
  assert.deepEqual(late.lines.slice(1), [
    'Could not write talk.script.md (EROFS), so there is no script yet: copy the PDF to a folder you can write to, and prepare it there.',
    '  page 2 is not 16:9, so it is shown with bars at its sides or above and below.',
    `Contact sheet: decks/${id}/sheet.html`,
  ])
  assert.match(fs.readFileSync(path.join(decksDir, id, 'sheet.html'), 'utf8'), /2 slides to present|to write/)
  assert.ok(!fs.existsSync(path.join(work, 'talk.script.md')))
  writes.mock.restore()

  // An existing script that can't be updated is left as it was, still for its deck, and the advice says so.
  const first = await runPrepare({ input: pdf, exclude: [], decksDir, name: 'Alex', cwd: work })
  assert.equal(first.code, 0, first.lines.join('\n'))
  const firstId = /^Prepared (talk-[a-z2-7]{6}):/.exec(first.lines[0])?.[1] ?? ''
  const script = fs.readFileSync(path.join(work, 'talk.script.md'), 'utf8')
  const rename = fs.renameSync
  t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to).includes('.script.md')) throw erofs()
    rename(from, to)
  })
  const update = await runPrepare({ input: pdf, exclude: [], decksDir, name: 'Alex', cwd: work })
  assert.equal(update.code, 1)
  assert.equal(update.lines[1], `Could not write talk.script.md (EROFS): it is unchanged, and still uses deck ${firstId}. Prepare again from a folder you can write to, so the changed and new pages are marked.`)
  assert.equal(fs.readFileSync(path.join(work, 'talk.script.md'), 'utf8'), script)
  assert.ok(new DeckStore(decksDir).ids().includes(firstId), 'the deck it uses is kept')
})

test("check reads only a <deck>.script.md file, and only the deck's own script is compared with its slides or changes the deck", async () => {
  const work = fs.mkdtempSync(path.join(DIR, 'own-'))
  const decksDir = path.join(work, 'data', 'decks')
  // A file of any other name is refused unread: nothing of it is quoted.
  const yaml = path.join(work, 'k8s-secret.yaml')
  fs.writeFileSync(yaml, '---\napiVersion: v1\nkind: Secret\nstringData:\n  db_password: Example-Secret-Value-42\n')
  const refused = runCheck({ file: yaml, decksDir, retentionDays: 30, cwd: work })
  assert.deepEqual(refused, { lines: ['k8s-secret.yaml is not a script: check takes the <deck>.script.md file prepare wrote.'], code: 1 })

  // A deck prepared from a PDF in its own folder, and its own script.
  const own = path.join(work, 'private')
  fs.mkdirSync(own)
  fs.writeFileSync(path.join(own, 'offer.pdf'), makePdf([{ texts: [{ text: 'Offer', size: 40 }] }, { texts: [{ text: 'Offer price 4,250,000', size: 30 }] }]))
  const prepared = await runPrepare({ input: path.join(own, 'offer.pdf'), exclude: [], decksDir, name: 'Alex', cwd: work })
  assert.equal(prepared.code, 0, prepared.lines.join('\n'))
  const id = /^Prepared (offer-[a-z2-7]{6}):/.exec(prepared.lines[0])?.[1] ?? ''
  const manifest = path.join(decksDir, id, 'manifest.json')
  const sheet = path.join(decksDir, id, 'sheet.html')
  assert.match(JSON.parse(fs.readFileSync(manifest, 'utf8')).script, /^[0-9a-f]{64}$/, 'a keyed mark, not a path')
  assert.ok(!fs.readFileSync(manifest, 'utf8').includes(own), "the manifest holds no path")

  // Another file that names the deck: no figure is named, and the deck and its sheet are left as they were.
  const probe = path.join(work, 'probe.script.md')
  fs.writeFileSync(probe, `---\ndeck: ${id}\n---\n\n## 1\n\nHello.\n\n## 2\n\nIt is 3900000 or 4250000 or 5100000.\n`)
  const past = new Date('2026-01-01T00:00:00Z')
  fs.utimesSync(manifest, past, past)
  const before = fs.readFileSync(sheet)
  const other = runCheck({ file: probe, decksDir, retentionDays: 30, cwd: work, now: new Date('2026-11-19T12:00:00Z') })
  const said = other.lines.join('\n')
  assert.ok(!said.includes('not on the slide'), said)
  assert.ok(other.lines.includes(`This is not the script prepare wrote for ${id}, so its figures were not compared with the slides, and the deck and its contact sheet were left as they were. Prepare the deck again from the PDF beside this script.`), said)
  assert.deepEqual(fs.readFileSync(sheet), before, 'the sheet is unchanged')
  assert.equal(fs.statSync(manifest).mtime.toISOString(), past.toISOString(), 'the deck is not touched')

  // The same narration in the deck's own script is compared, and refreshes the sheet.
  const ownScript = path.join(own, 'offer.script.md')
  fs.writeFileSync(ownScript, fs.readFileSync(probe, 'utf8'))
  const checked = runCheck({ file: ownScript, decksDir, retentionDays: 30, cwd: work, now: new Date('2026-11-19T12:00:00Z') })
  assert.ok(checked.lines.includes('  page 2, line 9: 3900000, 5100000 are not on the slide: check the figures.'), checked.lines.join('\n'))
  assert.notDeepEqual(fs.readFileSync(sheet), before)
  assert.equal(fs.statSync(manifest).mtime.toISOString(), '2026-11-19T12:00:00.000Z')

  // Its own script, with two sections for one page: no figures, and no sheet, until its structure is clear.
  fs.writeFileSync(ownScript, `---\ndeck: ${id}\n---\n\n## 2\n\nIt is 3900000.\n\n## 2\n\nOr 4250000.\n`)
  const shown = fs.readFileSync(sheet)
  const unclear = runCheck({ file: ownScript, decksDir, retentionDays: 30, cwd: work })
  assert.ok(!unclear.lines.join('\n').includes('not on the slide'), unclear.lines.join('\n'))
  assert.deepEqual(fs.readFileSync(sheet), shown)
})

test("prepare and check give the deck's warnings one line per kind, with its pages; the estimate names its unit beside your minutes", async () => {
  const work = fs.mkdtempSync(path.join(DIR, 'kinds-'))
  const decksDir = path.join(work, 'data', 'decks')
  const pdf = path.join(work, 'old.pdf')
  // Six 4:3 pages, each with a 12 pt footer: before, twelve lines at prepare and again at check.
  const page = (title: string) => ({ size: [720, 540] as [number, number], texts: [{ text: title, size: 40 }, { text: 'Example Corp - Internal', size: 12 }] })
  fs.writeFileSync(pdf, makePdf(['One', 'Two', 'Three', 'Four', 'Five', 'Six'].map(page)))
  const prepared = await runPrepare({ input: pdf, exclude: [], decksDir, name: 'Alex', cwd: work })
  assert.equal(prepared.code, 0, prepared.lines.join('\n'))
  assert.deepEqual(prepared.lines.filter(l => l.startsWith('  ') && !l.includes('npm run')), [
    '  pages 1-6: the slide has text under 20 px, which may be hard to read in a small share window.',
    '  pages 1-6: the slide is not 16:9, so it is shown with bars at its sides or above and below.',
  ])
  const scriptFile = path.join(work, 'old.script.md')
  // Written, but for page 4, which is left with no section; minutes: 3, and well under a minute of narration.
  const id = /^Prepared (old-[a-z2-7]{6}):/.exec(prepared.lines[0])?.[1] ?? ''
  const sections = [1, 2, 3, 5, 6].map(n => `## ${n}\nhold: 3s\n\nThis is slide ${['one', 'two', 'three', '', 'five', 'six'][n - 1]}.\n`).join('\n')
  fs.writeFileSync(scriptFile, `---\ndeck: ${id}\nminutes: 3\n---\n\n${sections}`)
  const checked = runCheck({ file: scriptFile, decksDir, retentionDays: 30, cwd: work })
  assert.equal(checked.code, 0, checked.lines.join('\n'))
  assert.match(checked.lines[0], /^old\.script\.md \(deck old-[a-z2-7]{6}\): 5 slides to present, about \d+ s of your 3 min\.$/)
  assert.deepEqual(checked.lines.slice(1, 5), [
    '3 warnings:',
    "  page 4: no section, so it won't be shown.",
    '  pages 1-3, 5-6: the slide has text under 20 px, which may be hard to read in a small share window.',
    '  pages 1-3, 5-6: the slide is not 16:9, so it is shown with bars at its sides or above and below.',
  ])
  // The sheet counts the warnings as the terminal does: a line per kind, not one per slide.
  assert.match(fs.readFileSync(path.join(decksDir, id, 'sheet.html'), 'utf8'), /5 slides to present, about \d+ s of your 3 min; 0 errors, 3 warnings\./)
  assert.equal(ranges([6, 1, 2, 3, 10]), 'pages 1-3, 6, 10')
  assert.equal(ranges([4]), 'page 4')
})

test("the new script's own help names the check command as it works from where prepare ran, as its Next line does", async () => {
  const work = fs.mkdtempSync(path.join(DIR, 'help-'))
  const project = path.join(work, 'project')
  const downloads = path.join(work, 'downloads')
  fs.mkdirSync(project)
  fs.mkdirSync(downloads)
  const dataDir = path.join(work, 'data')
  fs.writeFileSync(path.join(downloads, 'Big deck.pdf'), makePdf([{ texts: [{ text: 'Hello', size: 40 }] }]))
  const prepared = await runPrepare({ input: path.join(downloads, 'Big deck.pdf'), exclude: [], decksDir: path.join(dataDir, 'decks'), name: 'Alex', cwd: project })
  assert.equal(prepared.code, 0, prepared.lines.join('\n'))
  const next = prepared.lines.at(-1) ?? ''
  const help = /Then run, from where you ran prepare: (npm run slides -- check .*) -->/.exec(fs.readFileSync(path.join(downloads, 'Big deck.script.md'), 'utf8'))?.[1]
  assert.equal(help, next.trim())
  assert.equal(help, `npm run slides -- check '${path.join(downloads, 'Big deck.script.md')}'`)
  // Run as it says, from the project folder: the script is found (its TODO is the only error).
  const run = cli(['check', path.join(downloads, 'Big deck.script.md')], project, dataDir)
  assert.ok(!run.stderr.includes('was not found'), run.stderr)
  assert.match(run.stderr, /TODO: write the narration/)
})

test("list says which decks can't be used, and unfinished prepares; delete --all empties the folder, a killed prepare's copy of the PDF included", () => {
  const decksDir = path.join(fs.mkdtempSync(path.join(DIR, 'list-')), 'decks')
  fs.mkdirSync(path.join(decksDir, 'bad-deck-abcdef'), { recursive: true, mode: 0o700 })
  fs.chmodSync(decksDir, 0o700)
  fs.mkdirSync(path.join(decksDir, '.tmp-x1'))
  const list = runList({ decksDir, retentionDays: 30, cwd: '/' })
  assert.deepEqual(list.lines, [
    "bad-deck-abcdef  can't be used: it has no manifest.",
    '1 unfinished prepare (.tmp-*, with a copy of its PDF): the next prepare or delete --all removes it once it is 10 minutes old, and the voice service once an hour old.',
  ])
  // A killed prepare's folder holds a copy of the PDF: --all removes an old one, and leaves one that may be running.
  fs.writeFileSync(path.join(decksDir, '.tmp-x1', 'input.pdf'), 'a copy of the PDF')
  fs.mkdirSync(path.join(decksDir, '.tmp-old'))
  fs.writeFileSync(path.join(decksDir, '.tmp-old', 'input.pdf'), 'a copy of the PDF')
  const old = new Date(Date.now() - 11 * 60_000)
  fs.utimesSync(path.join(decksDir, '.tmp-old'), old, old)
  assert.deepEqual(runDelete({ decksDir, ids: [], all: true }), {
    lines: [
      'Deleted bad-deck-abcdef.',
      'Deleted 1 unfinished prepare, with the copy of its PDF.',
      '1 unfinished prepare from the last 10 minutes was left: if no prepare is running, run delete --all again later.',
    ],
    code: 0,
  })
  assert.deepEqual(fs.readdirSync(decksDir), ['.tmp-x1'])
  fs.utimesSync(path.join(decksDir, '.tmp-x1'), old, old)
  assert.deepEqual(runDelete({ decksDir, ids: [], all: true }), { lines: ['Deleted 1 unfinished prepare, with the copy of its PDF.'], code: 0 })
  assert.deepEqual(runDelete({ decksDir, ids: [], all: true }), { lines: ['There were no decks to delete.'], code: 0 })
})

test('your decks and their scripts are never committed: decks/, and a PDF or script prepared at the top of this folder, are gitignored', () => {
  const files = ['deck.pdf', 'deck.script.md', 'Q4 Plan.pdf', 'Q4 Plan.script.md', 'decks/q4.pdf', 'decks/q4.script.md', 'src/slides/x.ts', 'test/fixtures/slides/red.jp2']
  const ignored = spawnSync('git', ['check-ignore', '--no-index', ...files], { cwd: ROOT, encoding: 'utf8' })
  assert.deepEqual(ignored.stdout.trim().split('\n'), files.slice(0, 6))
})

/** npm run slides, as npm runs it, from `cwd`, with no key at all in its environment. */
function cli(args: string[], cwd: string, dataDir: string) {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, AGENT_NAME: 'Alex', OWNER_NAME: 'Sam', ALEX_DATA_DIR: dataDir, INIT_CWD: cwd }
  return spawnSync(process.execPath, ['--import', 'tsx', path.join(ROOT, 'src/cli/slides.ts'), ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 })
}

test('the command: help, a refusal on stderr with exit 1, and check with no key and no service, files found from where npm was run', () => {
  const work = fs.mkdtempSync(path.join(DIR, 'cmd-'))
  const dataDir = path.join(work, 'data')
  const help = cli(['--help'], work, dataDir)
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /^Usage:\n {2}npm run slides -- prepare <deck\.pdf> \[--exclude <pages>\] \[--label <name>\]/)
  fs.writeFileSync(path.join(work, 'deck.pdf'), makeZip([{ name: '[Content_Types].xml', data: '<Types/>' }, { name: 'ppt/presentation.xml', data: '<p/>' }]))
  const pptx = cli(['prepare', 'deck.pdf'], work, dataDir)
  assert.equal(pptx.status, 1)
  assert.equal(pptx.stderr.trim(), 'deck.pdf is a PowerPoint file. Export it as PDF: File > Export > PDF (or Save As > PDF), with hidden slides included.')
  assert.equal(pptx.stdout, '')
  // A link is refused as a link: never made into a path first, which would only be "not found".
  const google = cli(['prepare', 'https://docs.google.com/presentation/d/abc/edit'], work, dataDir)
  assert.equal(google.status, 1)
  assert.equal(google.stderr.trim(), 'https://docs.google.com/presentation/d/abc/edit is a Google Slides link. Google Slides: File > Download > PDF document.')
  const link = cli(['prepare', 'https://example.com/deck.pdf'], work, dataDir)
  assert.equal(link.status, 1)
  assert.equal(link.stderr.trim(), 'https://example.com/deck.pdf is a link, not a file. Download the deck as a PDF, and give that file.')
  const bad = cli(['check'], work, dataDir)
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /^Give one script \(<deck>\.script\.md\)\.\nUsage:/)
  fs.writeFileSync(path.join(work, 'talk.script.md'), '---\ndeck: talk-abcdef\n---\n\n## 1 · Hello\n\nHello everyone.\n')
  const check = cli(['check', 'talk.script.md'], work, dataDir)
  assert.equal(check.status, 1)
  assert.match(check.stderr, /^talk\.script\.md: 1 slide to present, about \d+ s\.\n1 error: the script can't be used until it is fixed\.\n {2}the prepared deck talk-abcdef is gone/)
  const list = cli(['list'], work, dataDir)
  assert.equal(list.status, 0, list.stderr)
  assert.equal(list.stdout, 'No prepared decks in data/decks.\n')
})
