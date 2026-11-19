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
import { runCheck, runDelete, runList, runPrepare, scriptFor, shown } from '../src/slides/actions.ts'
import { DeckStore } from '../src/slides/deck.ts'
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
  assert.match(sheet, /3 slides to present, about \d+ s; 3 errors/)
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

test("list says which decks can't be used, and unfinished prepares; delete --all empties the folder", () => {
  const decksDir = path.join(fs.mkdtempSync(path.join(DIR, 'list-')), 'decks')
  fs.mkdirSync(path.join(decksDir, 'bad-deck-abcdef'), { recursive: true, mode: 0o700 })
  fs.chmodSync(decksDir, 0o700)
  fs.mkdirSync(path.join(decksDir, '.tmp-x1'))
  const list = runList({ decksDir, retentionDays: 30, cwd: '/' })
  assert.deepEqual(list.lines, ["bad-deck-abcdef  can't be used: it has no manifest.", '1 unfinished prepare (.tmp-*): the voice service removes them once they are an hour old.'])
  assert.deepEqual(runDelete({ decksDir, ids: [], all: true }), { lines: ['Deleted bad-deck-abcdef.'], code: 0 })
  assert.deepEqual(runDelete({ decksDir, ids: [], all: true }), { lines: ['There were no decks to delete.'], code: 0 })
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
