// The update merge (mergeScript in src/slides/script.ts), tried on random decks: single merges, and runs of merges
// where the owner does what each merge says before the deck changes again (and, in the last test, sometimes prepares
// again first). Seeded, so a failure names a case that reproduces. What must hold after every merge:
// (a) no written narration is lost;
// (b) no narration is on a slide with other content unless its section says "check: changed";
// (c) every page of the new deck has a section for that same slide, or the merge reports it (new, unsectioned,
//     changed or back);
// (d) an excluded section never covers another slide unless it is marked, or is in the way of the section that must
//     move there and says so; and check refuses a marked one until it is read;
// (e) "back in the deck" only for a page that was left out with --exclude, never for a deleted slide's section. When
//     only the left-out pages changed, it is the very slide left out. When the same export also moved or replaced
//     slides, prepare never saw the left-out one, so it goes by the slides around it: never onto a copy of a slide the
//     old deck showed;
// (f) the script parses, its headings are in order, the report matches what changed in the file, and preparing the
//     same deck again after the owner's fixes changes nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sha256 } from '../src/slides/deck.ts'
import type { Manifest } from '../src/slides/manifest.ts'
import { type Merged, mergeScript, parseScript, skeleton, structureProblems } from '../src/slides/script.ts'

/** A slide as the generator knows it: `key` is what it shows, so two slides with one key look the same. */
interface Slide {
  key: string
  text: string
  picture: string
}

/** A deck as exported: its slides in order, and the pages prepare leaves out with --exclude. */
interface Deck {
  slides: Slide[]
  out: Set<number>
}

/** A small seeded generator (an LCG), so each case is the same on every run. */
function random(seed: number) {
  let state = seed >>> 0
  const next = () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0
    return state / 2 ** 32
  }
  return { next, int: (n: number) => Math.floor(next() * n) }
}
type Random = ReturnType<typeof random>

/**
 * Slides of the kinds that make a merge hard: text of its own, a picture only, the same picture as others, the same
 * text and picture as others, and the same text with a picture of its own.
 */
function slideMaker(rnd: Random) {
  let count = 0
  return (): Slide => {
    const k = ++count
    const r = rnd.next()
    if (r < 0.12) return { key: `img${k}`, text: '', picture: `picture ${k}` }
    if (r < 0.18) return { key: 'blank', text: '', picture: 'blank' }
    if (r < 0.25) return { key: 'same', text: 'Same words', picture: 'same picture' }
    if (r < 0.31) return { key: `samet${k}`, text: 'Same words', picture: `picture ${k}` }
    return { key: `t${k}`, text: `Slide word${k}`, picture: `picture ${k}` }
  }
}

let ids = 0
/** The manifest prepare would write for this deck, with a new id each time. */
function manifestOf(deck: Deck): Manifest {
  const letters = 'abcdefghijklmnopqrstuvwxyz234567'
  let n = ids++
  const id = `talk-${Array.from({ length: 6 }, () => {
    const c = letters[n % 32]
    n = Math.floor(n / 32)
    return c
  }).join('')}`
  const slides = deck.slides.map((s, i) => ({ s, n: i + 1 })).filter(({ n: page }) => !deck.out.has(page)).map(({ s, n: page }) => ({
    n: page, title: s.text, pageLabel: null, text: s.text, file: `${String(page).padStart(3, '0')}.webp`, bytes: 10, sha256: sha256(s.picture), textHash: sha256(s.text), warnings: [],
  }))
  return { format: 1, id, label: 'talk', created: '2026-11-19T00:00:00Z', pages: deck.slides.length, excluded: deck.out.size, script: null, slides }
}

const rendered = (deck: Deck, page: number) => page >= 1 && page <= deck.slides.length && !deck.out.has(page)

/** The owner's edits to a deck: one to three inserts, deletes, swaps, edits in place, moves and appends. */
function edit(deck: Deck, rnd: Random, newSlide: () => Slide): { slides: Slide[]; ops: string[] } {
  const d = [...deck.slides]
  const ops: string[] = []
  for (let j = 1 + rnd.int(3); j > 0; j--) {
    const op = rnd.int(7)
    if (op === 0 && d.length < 12) {
      const at = rnd.int(d.length + 1)
      d.splice(at, 0, newSlide())
      ops.push(`insert@${at + 1}`)
    } else if (op === 1 && d.length > 2) {
      const at = rnd.int(d.length)
      d.splice(at, 1)
      ops.push(`delete@${at + 1}`)
    } else if (op === 2 && d.length > 2) {
      const a = rnd.int(d.length)
      const b = rnd.int(d.length)
      ;[d[a], d[b]] = [d[b], d[a]]
      ops.push(`swap${a + 1},${b + 1}`)
    } else if (op === 3) {
      const at = rnd.int(d.length)
      d[at] = newSlide()
      ops.push(`edit@${at + 1}`)
    } else if (op === 4 && d.length > 2) {
      const a = rnd.int(d.length)
      const [s] = d.splice(a, 1)
      const b = rnd.int(d.length + 1)
      d.splice(b, 0, s)
      ops.push(`move${a + 1}->${b + 1}`)
    } else if (op === 5 && d.length < 12) {
      d.push(newSlide())
      ops.push('append')
    }
  }
  return { slides: d, ops }
}

/** The pages to leave out on this prepare: usually none, sometimes one, given by number as an owner types them. */
function leaveOut(count: number, rnd: Random): Set<number> {
  const out = new Set<number>()
  if (count > 1 && rnd.next() < 0.25) out.add(1 + rnd.int(count))
  return out
}

/** A section as the test reads it back: its keys, its narration's id, and the merge's own comments in it. */
interface Sec {
  page: number
  excluded: boolean
  changed: boolean
  todo: boolean
  narration: string | null
  moveTo: number | null
  leftOut: number | null
  gone: boolean
  taken: number | null
  here: number | null
  text: string
}

const number = (re: RegExp, text: string) => {
  const m = re.exec(text)
  return m ? Number(m[1]) : null
}

function split(text: string): { head: string; secs: Sec[] } {
  const [head, ...parts] = text.split(/\n(?=## \d)/)
  const secs = parts.map(s => ({
    page: Number(/^## (\d+)/.exec(s)?.[1]),
    excluded: /^exclude:[ \t]*yes[ \t]*$/m.test(s),
    changed: /^check:[ \t]*changed[ \t]*$/m.test(s),
    todo: /^TODO$/m.test(s),
    narration: /Narration (n\d+) for/.exec(s)?.[1] ?? null,
    moveTo: number(/<!-- This slide is now page (\d+):/, s),
    leftOut: number(/<!-- Page (\d+) was left out when the deck was prepared/, s),
    gone: /^<!-- .*not in the deck any more/m.test(s),
    taken: number(/<!-- Page (\d+) is another slide now:/, s),
    here: number(/<!-- On page (\d+) now, with no section yet/, s),
    text: s,
  }))
  return { head, secs }
}

const join = (head: string, secs: { text: string }[]) => [head, ...secs.map(s => s.text)].join('\n')

/** What the owner has written so far: each narration's id and the slide (by key) it is for. */
type Written = Map<string, string>

let narrations = 0
/**
 * The owner writes every TODO section: narration for the slide on its page, check: yes taken out, and now and then an
 * "exclude: yes", "on-request: yes" or "exclude: no" in its place.
 */
function writeTodos(text: string, deck: Deck, written: Written, rnd: Random): string {
  const { head, secs } = split(text)
  for (const sec of secs) {
    if (!sec.todo) continue
    const id = `n${++narrations}`
    const key = deck.slides[sec.page - 1]?.key ?? '?'
    const r = rnd.next()
    const keyLine = r < 0.1 ? 'exclude: yes\n' : r < 0.15 ? 'on-request: yes\n' : r < 0.2 ? 'exclude: no\n' : ''
    sec.text = sec.text.replace(/^check: yes\n/m, keyLine).replace(/^TODO$/m, `Narration ${id} for ${key}.`)
    written.set(id, key)
  }
  return join(head, secs)
}

/** The merge's comments the owner deletes once they have done what they say. */
const DONE_WITH = /^<!-- (?:This slide|The deck this|Page \d+ is back|On the slide now|On page \d+ now|Page \d+ is another slide now).*-->\n/gm

/**
 * The owner follows what the merge said: moves each section told to move, moves a section with no slide out of
 * another slide's way (to the end, numbered after the last slide), and reads each "check: changed" section against
 * its slide, which makes the narration that slide's. Two sections are never left on one page.
 */
function ownerFixes(text: string, deck: Deck, written: Written, where: string): string {
  const { head, secs } = split(text)
  let last = Math.max(deck.slides.length, ...secs.map(s => s.page))
  for (const sec of secs) {
    if (sec.moveTo !== null) sec.page = sec.moveTo
    else if (sec.taken !== null) sec.page = ++last
    sec.text = sec.text.replace(/^## \d+/, `## ${sec.page}`)
    if (sec.changed) {
      sec.text = sec.text.replace(/^check:[ \t]*changed[ \t]*\n/m, '').replace(DONE_WITH, '')
      if (sec.narration && rendered(deck, sec.page)) written.set(sec.narration, deck.slides[sec.page - 1].key)
    }
  }
  secs.sort((a, b) => a.page - b.page)
  for (let i = 1; i < secs.length; i++) assert.notEqual(secs[i].page, secs[i - 1].page, `${where}: the owner did what the merge said, yet two sections are on page ${secs[i].page}\n${text}`)
  return join(head, secs)
}

/** The checks (a) to (f) on one merge, from `before` (for `oldDeck`) to `merged` (for `deck`). */
function checkMerge(before: string, merged: Merged, oldDeck: Deck, deck: Deck, written: Written, where: string) {
  const at = (what: string) => `${where}: ${what}\n--- before:\n${before}\n--- after:\n${merged.text}\n--- report: ${JSON.stringify({ ...merged, text: undefined })}`
  const was = split(before).secs
  const now = split(merged.text).secs
  const keyOn = (page: number) => (rendered(deck, page) ? deck.slides[page - 1].key : null)
  const slideOf = (s: Sec) => (s.narration ? written.get(s.narration) : undefined)
  const reported = new Set([...merged.added, ...merged.unsectioned, ...merged.changed, ...merged.back])

  // (a) Every narration is still there, once.
  for (const s of was) if (s.narration) assert.equal(now.filter(n => n.narration === s.narration).length, 1, at(`(a) narration ${s.narration} lost or doubled`))

  // (b) Narration shown unmarked is on its own slide.
  for (const s of now) {
    if (!s.narration || s.excluded || s.changed) continue
    assert.equal(keyOn(s.page), slideOf(s), at(`(b) ## ${s.page} (${s.narration}, for ${slideOf(s)}) is unmarked over ${keyOn(s.page) ?? 'no slide'}`))
  }

  // (c) Every page has a section for its slide, or is reported.
  for (let page = 1; page <= deck.slides.length; page++) {
    const key = keyOn(page)
    if (key === null || reported.has(page)) continue
    // A TODO section prepare wrote for this page, not yet written, is that slide's too. So is one an earlier merge
    // marked, which the owner has not read yet: that merge reported it, and check still refuses it.
    const marked = (s: Sec) => s.changed && was.some(w => w.narration === s.narration && w.changed)
    const own = now.some(s => ((slideOf(s) === key || marked(s)) && (s.page === page || s.moveTo === page)) || (s.todo && !s.narration && !s.changed && s.page === page))
    assert.ok(own, at(`(c) page ${page} (${key}) has no section for it, and is not reported`))
  }

  // (d) An excluded section over another slide is marked, or is in the way of the section that must move there; and
  // check refuses a marked one until it is read.
  const errors = parseScript(merged.text).errors
  for (const s of now) {
    if (!s.excluded) continue
    if (s.changed) assert.ok(errors.some(e => e.page === s.page && /changed after the section was excluded/.test(e.message)), at(`(d) check accepts the marked excluded ## ${s.page}`))
    const key = keyOn(s.page)
    if (key === null || key === slideOf(s) || s.changed) continue
    const inTheWay = s.taken === s.page && now.some(o => o.moveTo === s.page && o.changed)
    assert.ok(inTheWay, at(`(d) excluded ## ${s.page} (${s.narration}, for ${slideOf(s)}) hides ${key}, unmarked`))
  }

  // (e) Back only for a page left out with --exclude, whose section the merge excluded for that.
  for (const page of merged.back) {
    const s = now.find(n => (n.page === page || n.moveTo === page) && !n.excluded && was.some(w => w.narration === n.narration && w.excluded))
    assert.ok(s, at(`(e) page ${page} is back, but no excluded section came back for it`))
    const w = was.find(x => x.narration === s.narration) as Sec
    assert.ok(w.leftOut !== null && !w.gone, at(`(e) page ${page} is back for a section that was not left out`))
    const left = w.leftOut as number
    assert.ok(left <= oldDeck.slides.length && oldDeck.out.has(left), at(`(e) page ${page} is back, but page ${left} was not left out of the old deck`))
    const sameSlides = oldDeck.slides.map(x => x.key).join() === deck.slides.map(x => x.key).join()
    const leftKey = oldDeck.slides[left - 1].key
    if (sameSlides) assert.equal(keyOn(page), leftKey, at(`(e) only the left-out pages changed, yet page ${page} is back over another slide`))
    else {
      // The merge never saw the left-out slide, so when the same export moved or replaced it, the slide that took its
      // place is all it can go by. That is never a slide the old deck showed: there must be more copies of that look
      // in the new deck than the old one showed.
      const key = keyOn(page) as string
      const shown = oldDeck.slides.filter((x, i) => x.key === key && !oldDeck.out.has(i + 1)).length
      assert.ok(key === leftKey || deck.slides.filter(x => x.key === key).length > shown, at(`(e) page ${page} is back over ${key}, a slide the old deck showed`))
    }
  }
  // A section the merge excluded comes back only that way: never one whose slide was deleted, nor the owner's.
  for (const s of now) {
    const w = was.find(x => x.narration && x.narration === s.narration)
    if (w?.excluded && !s.excluded) assert.ok(w.leftOut !== null && merged.back.includes(s.moveTo ?? s.page), at(`(e) ## ${w.page} was excluded, and is not now`))
  }

  // (f) The file parses, its headings are in order, and the report says what changed in it.
  assert.deepEqual(structureProblems(merged.text), [], at('(f) structure'))
  const keyErrors = errors.filter(e => /given twice|not both|is not a key|put a blank line|never closed/.test(e.message))
  assert.deepEqual(keyErrors, [], at('(f) the merge made a key error'))
  const todo = (s: Sec) => s.todo && !s.narration
  const added = now.filter(s => todo(s) && !was.some(w => todo(w) && w.page === s.page)).map(s => s.page)
  assert.deepEqual(added, merged.added, at('(f) the new TODO sections are the pages reported new'))
  const moved = new Map(merged.moved.map(m => [m.from, m.to]))
  const retired = new Map(merged.retired.map(r => [r.from, r.to]))
  for (const s of now) {
    const w = was.find(x => x.narration && x.narration === s.narration)
    if (!w) continue
    if (s.page !== w.page) {
      assert.ok(merged.renumbered, at(`(f) ## ${w.page} became ${s.page}, but the report says the headings stay`))
      assert.ok(moved.get(w.page) === s.page || retired.get(w.page) === s.page || merged.back.includes(s.page), at(`(f) ## ${w.page} became ${s.page}, unreported`))
    }
    if (s.changed && !w.changed) {
      const slide = s.moveTo ?? s.page
      const why = merged.changed.includes(slide) || merged.back.includes(slide) || moved.get(w.page) === slide || merged.unsectioned.includes(s.page)
      assert.ok(why, at(`(f) ## ${s.page} got check: changed, unreported`))
    }
    if (s.excluded && !w.excluded) assert.ok(merged.gone.includes(w.page), at(`(f) ## ${w.page} was excluded, unreported`))
    if (s.moveTo !== null) assert.equal(moved.get(w.page), s.moveTo, at(`(f) ## ${w.page} is told to move to ${s.moveTo}, unreported`))
  }
  for (const m of merged.moved) {
    const s = now.find(x => x.narration && x.narration === was.find(w => w.page === m.from)?.narration)
    assert.ok(s && (merged.renumbered ? s.page === m.to : s.moveTo === m.to && s.changed), at(`(f) page ${m.from} reported moved to ${m.to}, but its section says otherwise`))
  }
  for (const page of merged.unsectioned) assert.ok(now.some(s => s.page === page && s.here === page && s.changed), at(`(f) page ${page} reported unsectioned, but no section quotes it`))
  for (const page of merged.changed) assert.ok(now.some(s => (s.moveTo ?? s.page) === page && s.changed), at(`(f) page ${page} reported changed, but no section for it is marked`))
  // (When the owner has not yet read what an earlier merge marked, its comments about where a slide is may go
  // unreported once the slide is back on the section's page.)
  const quiet = ![merged.added, merged.changed, merged.gone, merged.moved, merged.retired, merged.unsectioned, merged.back, merged.scrubbed].some(l => l.length)
  if (quiet && !was.some(w => w.changed)) {
    const deckLine = (t: string) => t.replace(/^deck: \S+/m, 'deck:')
    assert.equal(deckLine(merged.text), deckLine(before), at('(f) nothing reported, yet the script changed beyond its deck line'))
  }
}

/** Preparing the same deck again after the owner's fixes: nothing moves or changes, and only pages with no section are new. */
function checkSteady(text: string, deck: Deck, written: Written, where: string): { text: string; manifest: Manifest } {
  const before = manifestOf(deck)
  const again = manifestOf(deck)
  const merged = mergeScript(text, before, again)
  const at = (what: string) => `${where}: ${what}\n--- script:\n${text}\n--- after:\n${merged.text}\n--- report: ${JSON.stringify({ ...merged, text: undefined })}`
  assert.deepEqual([merged.moved, merged.changed, merged.back, merged.gone, merged.unsectioned], [[], [], [], [], []], at('(f) prepared again unchanged, yet the report has news'))
  const secs = split(text).secs
  for (const r of merged.retired) assert.ok(secs.find(s => s.page === r.from)?.gone, at(`(f) prepared again unchanged, yet ## ${r.from} was renumbered`))
  const missing = deck.slides.map((_, i) => i + 1).filter(p => rendered(deck, p) && !secs.some(s => s.page === p))
  assert.deepEqual(merged.added, missing, at('(f) prepared again unchanged: only the pages with no section are new'))
  checkMerge(text, merged, deck, deck, written, `${where}, prepared again`)
  return { text: merged.text, manifest: again }
}

test('the merge, on 1,200 random single changes to a deck: no narration lost or unmarked on another slide, every page accounted for', () => {
  for (let run = 0; run < 1200; run++) {
    const rnd = random(1000 + run)
    const newSlide = slideMaker(rnd)
    const deck: Deck = { slides: Array.from({ length: 2 + rnd.int(8) }, newSlide), out: new Set() }
    deck.out = leaveOut(deck.slides.length, rnd)
    const written: Written = new Map()
    const manifest = manifestOf(deck)
    const text = writeTodos(skeleton(manifest, { name: 'Alex', scriptPath: 'talk.script.md' }), deck, written, rnd)
    const { slides, ops } = edit(deck, rnd, newSlide)
    const next: Deck = { slides, out: rnd.next() < 0.5 ? new Set(deck.out) : leaveOut(slides.length, rnd) }
    const where = `seed ${1000 + run}: [${deck.slides.map(s => s.key)}] out [${[...deck.out]}], ${ops.join(' ')} -> [${slides.map(s => s.key)}] out [${[...next.out]}]`
    checkMerge(text, mergeScript(text, manifest, manifestOf(next)), deck, next, written, where)
  }
})

/**
 * Runs of four changes to a deck, each merged, with the checks on every merge. `skip` is how often the owner prepares
 * again without doing what the merge said: each section then still says where its slide is, and is still marked.
 */
function sequences(runs: number, firstSeed: number, skip: number) {
  for (let run = 0; run < runs; run++) {
    const rnd = random(firstSeed + run)
    const newSlide = slideMaker(rnd)
    let deck: Deck = { slides: Array.from({ length: 2 + rnd.int(8) }, newSlide), out: new Set() }
    deck.out = leaveOut(deck.slides.length, rnd)
    const written: Written = new Map()
    let manifest = manifestOf(deck)
    let text = writeTodos(skeleton(manifest, { name: 'Alex', scriptPath: 'talk.script.md' }), deck, written, rnd)
    const trail = [`seed ${firstSeed + run}: [${deck.slides.map(s => s.key)}] out [${[...deck.out]}]`]
    for (let step = 0; step < 4; step++) {
      // Now and then only the pages left out change: a page left out comes back, or another is left out.
      const onlyOut = rnd.next() < 0.2
      const { slides, ops } = onlyOut ? { slides: deck.slides, ops: ['(slides unchanged)'] } : edit(deck, rnd, newSlide)
      const next: Deck = { slides, out: !onlyOut && rnd.next() < 0.5 ? new Set(deck.out) : leaveOut(slides.length, rnd) }
      trail.push(`${ops.join(' ')} -> [${slides.map(s => s.key)}] out [${[...next.out]}]`)
      const where = trail.join(' | ')
      const nextManifest = manifestOf(next)
      const merged = mergeScript(text, manifest, nextManifest)
      checkMerge(text, merged, deck, next, written, where)
      deck = next
      if (rnd.next() < skip) {
        text = merged.text
        manifest = nextManifest
        trail.push('(not done yet)')
      } else {
        text = ownerFixes(merged.text, deck, written, where)
        ;({ text, manifest } = checkSteady(text, deck, written, where))
      }
      text = writeTodos(text, deck, written, rnd)
    }
  }
}

test('the merge, on 300 random runs of four changes, the owner doing what each merge says in between: the same, and preparing again changes nothing', () => {
  sequences(300, 5000, 0)
})

test('the merge, on 200 random runs of four changes, the owner sometimes preparing again before doing what the merge said: the same', () => {
  sequences(200, 9000, 0.35)
})
