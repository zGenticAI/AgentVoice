// What the meeting heard of the assistant: how much of a line the page had played when it stopped, as whole words.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CUT_OFF, KEEP_MS, MS_PER_CHAR, PAGE_LEAD_MS, Playback, heardText, spokenLength } from '../src/pipeline/playback.ts'

test('a line cut off keeps the whole words heard, rounded down, and says it was cut off', () => {
  const line = 'The pilot starts in March and ends in May.'
  // "The pilot starts in" ends at character 19 of 42, "March" at 25.
  assert.equal(heardText(line, 0.5), `The pilot starts in… ${CUT_OFF}`)
  assert.equal(heardText(line, 19 / 42), `The pilot starts in… ${CUT_OFF}`)
  assert.equal(heardText(line, 18 / 42), `The pilot starts… ${CUT_OFF}`, 'a word cut off partway was not heard')
  assert.equal(heardText(line, 25 / 42), `The pilot starts in March… ${CUT_OFF}`)
  // Rounded down: half of the "n" of "in" was said, so "in" was not.
  assert.equal(heardText(line, 18.5 / 42), `The pilot starts… ${CUT_OFF}`)
})

test('figures and signs take longer to say than to write, so a line goes by how long it takes to say', () => {
  const line = 'Revenue rose 18% to $4.2M in March.'
  // 35 characters, said as about 57 letters: "eighteen percent", "four point two million dollars".
  assert.equal(spokenLength(line), 57)
  assert.equal(spokenLength('The pilot starts in March and ends in May.'), 42)
  // Three quarters of the way through, by its letters, "$4.2M" was over; it is still being said.
  assert.equal(heardText(line, 0.75), `Revenue rose 18% to… ${CUT_OFF}`)
  assert.equal(heardText(line, 0.83), `Revenue rose 18% to $4.2M… ${CUT_OFF}`)
})

test('a line none of whose words was heard is empty, so it goes from the transcript', () => {
  assert.equal(heardText('Sure, the numbers are in.', 0), '')
  assert.equal(heardText('Sure, the numbers are in.', 0.1), '', 'not even "Sure," was heard to its end')
  assert.equal(heardText('Sure, the numbers are in.', -1), '')
  assert.equal(heardText('', 0.5), '')
})

test('a cut-off line drops the comma or dash it stopped on, and a full stop needs no dots', () => {
  assert.equal(heardText('Sure, the numbers are in.', 6 / 25), `Sure… ${CUT_OFF}`)
  assert.equal(heardText('It ships in March — or April.', 19 / 30), `It ships in March… ${CUT_OFF}`)
  assert.equal(heardText('It ships in March. The pilot starts in May.', 20 / 44), `It ships in March. ${CUT_OFF}`)
  assert.equal(heardText('Is that right? Then yes.', 15 / 24), `Is that right? ${CUT_OFF}`)
  // All of its words, but not all of the line: still marked as cut off.
  assert.equal(heardText('It ships in March.', 1), `It ships in March. ${CUT_OFF}`)
  assert.equal(heardText('It ships in March.', 7), `It ships in March. ${CUT_OFF}`)
})

/** A playback with a clock the test moves, and the transcript changes it asks for. */
function follow() {
  let now = 1_000_000
  const amended: [string, string][] = []
  const playback = new Playback<string>((line, text) => amended.push([line, text]), () => now)
  return { playback, amended, at: (ms: number) => (now = 1_000_000 + ms) }
}

test('pieces play back to back from 50 ms after the first arrives; a line the page stopped partway keeps what it played', () => {
  const { playback, amended, at } = follow()
  const a = playback.begin('a', 'The pilot starts in March and ends in May.')
  // ElevenLabs is faster than the page plays: four 500 ms pieces arrive within 30 ms, and play one after another.
  for (const t of [0, 10, 20, 30]) {
    at(t)
    playback.sent(a, 500)
  }
  playback.close(a, true)
  assert.deepEqual(a.runs, [[1_000_000 + PAGE_LEAD_MS, 1_000_000 + PAGE_LEAD_MS + 2000]])
  // Talked over 1050 ms in: 1000 of its 2000 ms played.
  at(PAGE_LEAD_MS + 1000)
  playback.stop()
  assert.deepEqual(amended, [['a', `The pilot starts in… ${CUT_OFF}`]])
  assert.equal(playback.following.length, 0)
})

test('a line played to the end is left as it is, and a line queued behind the cut goes', () => {
  const { playback, amended, at } = follow()
  const a = playback.begin('a', 'It ships in March.')
  playback.sent(a, 400)
  playback.close(a, true)
  const b = playback.begin('b', 'The pilot starts in May.')
  playback.sent(b, 600)
  // a played from 50 to 450 ms, b is queued from 450 to 1050: cut at 450.
  at(PAGE_LEAD_MS + 400)
  playback.stop()
  assert.deepEqual(amended, [['b', '']])
})

test('a piece that arrives after the page has run dry plays from when it arrives, so the gap is not counted as heard', () => {
  const { playback, amended, at } = follow()
  const a = playback.begin('a', 'The pilot starts in March and ends in May.')
  playback.sent(a, 500) // plays 50-550
  at(1000)
  playback.sent(a, 1500) // arrives at 1000, after the first piece ended: plays 1050-2550
  playback.close(a, true)
  assert.deepEqual(a.runs, [
    [1_000_050, 1_000_550],
    [1_001_050, 1_002_550],
  ])
  // At 1550: 500 + 500 of the 2000 ms played, so half the line.
  at(1550)
  playback.stop()
  assert.deepEqual(amended, [['a', `The pilot starts in… ${CUT_OFF}`]])
})

test('a line whose audio did not all go out keeps, at once, the words its audio got to, and a later stop cuts it further', () => {
  const { playback, amended, at } = follow()
  const text = 'We expect the first results in the second week of April.' // 56 characters
  const a = playback.begin('a', text)
  playback.sent(a, 1960) // half of the 56 x 70 ms the line is reckoned to take
  playback.close(a, false) // ElevenLabs failed, or the turn was stopped without clearing the page
  assert.equal(MS_PER_CHAR * text.length, 3920)
  assert.deepEqual(amended, [['a', `We expect the first results… ${CUT_OFF}`]])
  // Then the page is told to clear 1 s into it.
  at(PAGE_LEAD_MS + 980)
  playback.stop()
  assert.deepEqual(amended.at(-1), ['a', `We expect the… ${CUT_OFF}`])
})

test('a line that failed before any audio went out goes at once', () => {
  const { playback, amended } = follow()
  const a = playback.begin('a', 'It ships in March.')
  playback.close(a, false)
  assert.deepEqual(amended, [['a', '']])
})

test('a stop with the page played out changes nothing, and nothing is asked twice', () => {
  const { playback, amended, at } = follow()
  const a = playback.begin('a', 'It ships in March.')
  playback.sent(a, 400)
  playback.close(a, true)
  at(5000)
  playback.stop()
  playback.stop()
  assert.deepEqual(amended, [])
})

test('lines the page has played out stop being followed KEEP_MS after, so what a page that dropped got can still correct them', () => {
  const { playback, at } = follow()
  const a = playback.begin('a', 'It ships in March.')
  playback.sent(a, 400)
  playback.close(a, true)
  at(300)
  playback.begin('b', 'Still playing a.')
  assert.deepEqual(playback.following.map(p => p.line), ['a', 'b'])
  at(PAGE_LEAD_MS + 400 + KEEP_MS - 1)
  playback.begin('c', 'a has played, a moment less than KEEP_MS ago.')
  assert.deepEqual(playback.following.map(p => p.line), ['a', 'b', 'c'])
  at(PAGE_LEAD_MS + 400 + KEEP_MS)
  playback.begin('d', 'a has played, KEEP_MS ago.')
  assert.deepEqual(playback.following.map(p => p.line), ['b', 'c', 'd'], 'b and c have nothing sent, and are still going out')
})

test('a stop starts the page afresh: the next piece plays 50 ms after it arrives', () => {
  const { playback, at } = follow()
  const a = playback.begin('a', 'A long answer.')
  playback.sent(a, 60_000)
  at(100)
  playback.stop()
  const b = playback.begin('b', 'Next.')
  playback.sent(b, 100)
  assert.deepEqual(b.runs, [[1_000_100 + PAGE_LEAD_MS, 1_000_100 + PAGE_LEAD_MS + 100]])
})

test('audio for no line (the goodbye, once the transcript is gone) still holds the page, and a reset forgets every line', () => {
  const { playback, amended } = follow()
  playback.sent(null, 1000) // plays 50-1050
  const a = playback.begin('a', 'Queued.')
  playback.sent(a, 100)
  assert.deepEqual(a.runs, [[1_001_050, 1_001_150]])
  playback.reset()
  assert.equal(playback.following.length, 0)
  playback.stop()
  playback.close(a, false) // its turn ends after the reset: nothing is asked of a transcript that is gone
  assert.deepEqual(amended, [])
})

test('a line stopped while its audio is still going out goes by how long the whole line takes, not by what was sent', () => {
  const { playback, amended, at } = follow()
  const text = 'We expect the first results in the second week of April.' // reckoned at 3920 ms
  const a = playback.begin('a', text)
  playback.sent(a, 1960) // half the line has gone out, and ElevenLabs is still making the rest
  at(PAGE_LEAD_MS + 980) // a quarter of it has played: talked over
  playback.stop()
  assert.deepEqual(amended, [['a', `We expect the… ${CUT_OFF}`]])
  // The turn then stops, and say() closes the line: it was settled already.
  playback.close(a, false)
  assert.equal(amended.length, 1)
})

test('a line whose audio did not all go out is reckoned by how long it takes to say, figures included', () => {
  const { playback, amended } = follow()
  const a = playback.begin('a', 'Revenue rose 18% to $4.2M in March.') // 57 letters' worth: 3990 ms
  playback.sent(a, 3000) // by its 35 characters (2450 ms) all of it, but three quarters by what it says
  playback.close(a, false)
  assert.deepEqual(amended, [['a', `Revenue rose 18% to… ${CUT_OFF}`]])
})

test('a line played to all but its last moment loses its last word', () => {
  const { playback, amended, at } = follow()
  const a = playback.begin('a', 'It ships in March.')
  playback.sent(a, 400)
  playback.close(a, true)
  at(PAGE_LEAD_MS + 390)
  playback.stop()
  assert.deepEqual(amended, [['a', `It ships in… ${CUT_OFF}`]])
})

test('a line is closed once: closing it again, as say() does after the turn stopped, changes nothing', () => {
  const { playback, amended, at } = follow()
  const a = playback.begin('a', 'It ships in March.')
  playback.sent(a, 400)
  playback.close(a, true) // all of it went out, and the page is playing it
  playback.close(a, false)
  assert.equal(a.complete, true)
  at(PAGE_LEAD_MS + 400)
  playback.stop()
  assert.deepEqual(amended, [])
})

test('the page plays until the end of everything sent to it, gaps and the 50 ms lead included, and nothing after a stop', () => {
  const { playback, at } = follow()
  assert.equal(playback.playsUntil, 0)
  playback.sent(null, 1000) // 50-1050
  at(2000)
  playback.sent(null, 500) // after a gap: 2050-2550
  assert.equal(playback.playsUntil, 1_002_550)
  playback.stop()
  assert.equal(playback.playsUntil, 0)
})

// --- Pausing: someone talks over the assistant, and the page holds the rest until it resumes or is cleared --------

// Where the clock of follow() starts, and a line of 42 letters.
const T = 1_000_000
const A = 'The pilot starts in March and ends in May.'

test('a pause holds what the page had not played; resume plays it 50 ms after, back to back; a later stop counts both runs', () => {
  const { playback, amended, at } = follow()
  const a = playback.begin('a', A)
  playback.sent(a, 2000) // 50-2050
  playback.close(a, true)
  at(550)
  playback.pause() // 500 played, 1500 held
  assert.deepEqual(a.runs, [[T + 50, T + 550]])
  assert.equal(playback.paused, true)
  at(1550)
  assert.equal(playback.playsUntil, T + 1550 + PAGE_LEAD_MS + 1500)
  playback.resume() // 1600-3100
  assert.deepEqual(a.runs, [[T + 50, T + 550], [T + 1600, T + 3100]])
  assert.equal(playback.playsUntil, T + 3100)
  at(2100) // 500 + 500 = 1000 of 2000
  playback.stop()
  assert.deepEqual(amended, [['a', `The pilot starts in… ${CUT_OFF}`]])
})

test('a stop while paused cuts at the pause, however long the pause, and the page starts afresh', () => {
  const { playback, amended, at } = follow()
  const a = playback.begin('a', A)
  playback.sent(a, 2000)
  playback.close(a, true)
  at(1050)
  playback.pause() // 1000 played
  at(9000)
  playback.stop()
  assert.deepEqual(amended, [['a', `The pilot starts in… ${CUT_OFF}`]])
  assert.equal(playback.paused, false)
  const b = playback.begin('b', 'Next.')
  playback.sent(b, 100)
  assert.deepEqual(b.runs, [[T + 9000 + PAGE_LEAD_MS, T + 9150]])
})

test('audio sent while paused queues behind what was held', () => {
  const { playback, at } = follow()
  const a = playback.begin('a', A)
  playback.sent(a, 1000) // 50-1050
  at(300)
  playback.pause() // 250 played, 750 held
  playback.sent(a, 500)
  playback.close(a, true)
  const b = playback.begin('b', 'Next.')
  playback.sent(b, 400)
  at(1000)
  playback.resume()
  assert.deepEqual(a.runs, [[T + 50, T + 300], [T + 1050, T + 2300]])
  assert.deepEqual(b.runs, [[T + 2300, T + 2700]])
})

test('gaps are not kept: pieces held play back to back', () => {
  const { playback, at } = follow()
  const a = playback.begin('a', A)
  playback.sent(a, 200) // 50-250
  at(1000)
  playback.sent(a, 200) // 1050-1250
  at(1020)
  playback.pause() // the second piece had not started
  at(2000)
  playback.resume()
  assert.deepEqual(a.runs, [[T + 50, T + 250], [T + 2050, T + 2250]])
})

test('a line closed short while paused counts what the page holds of it, which plays on resume', () => {
  const { playback, amended, at } = follow()
  const text = 'We expect the first results in the second week of April.' // 3920
  const a = playback.begin('a', text)
  playback.sent(a, 1960) // 50-2010
  at(50 + 980)
  playback.pause()
  playback.close(a, false) // ElevenLabs failed while paused: the page plays all 1960 ms
  assert.deepEqual(amended, [['a', `We expect the first results… ${CUT_OFF}`]])
})

test('a closed line whose audio is held is still followed when the next line begins', () => {
  // All of it went out while the page was paused (a sentence streamed during a talk-over pause): it has played none of
  // it yet, so no run of it is recent.
  const held = follow()
  held.playback.pause()
  const a = held.playback.begin('a', A)
  held.playback.sent(a, 400)
  held.playback.close(a, true)
  held.at(100)
  held.playback.begin('b', 'Next.')
  assert.deepEqual(held.playback.following.map(p => p.line), ['a', 'b'])
  // Part of it played, then the page paused, and the next line begins longer than KEEP_MS after that part.
  const played = follow()
  const c = played.playback.begin('c', A)
  played.playback.sent(c, 400) // 50-450
  played.playback.close(c, true)
  played.at(100)
  played.playback.pause()
  played.at(100 + KEEP_MS + 1000)
  played.playback.begin('d', 'Next.')
  assert.deepEqual(played.playback.following.map(p => p.line), ['c', 'd'])
})

test('audio of no line (the goodbye) is held and resumed too', () => {
  const { playback, at } = follow()
  playback.sent(null, 1000) // 50-1050
  at(550)
  playback.pause()
  const a = playback.begin('a', 'Queued.')
  playback.sent(a, 100)
  at(600)
  playback.resume()
  assert.deepEqual(a.runs, [[T + 650 + 500, T + 650 + 600]])
  assert.equal(playback.playsUntil, T + 1250)
})

test('pausing or resuming twice changes nothing more, a resume with nothing held plays nothing, and a reset unpauses', () => {
  const { playback, at } = follow()
  const a = playback.begin('a', A)
  playback.sent(a, 1000) // 50-1050
  at(300)
  playback.pause() // 250 played, 750 held
  at(600)
  playback.pause()
  at(1000)
  playback.resume() // 1050-1800
  at(1200)
  playback.resume()
  assert.deepEqual(a.runs, [[T + 50, T + 300], [T + 1050, T + 1800]])
  const { playback: empty } = follow()
  empty.pause()
  assert.equal(empty.playsUntil, 0)
  empty.resume()
  assert.equal(empty.paused, false)
  assert.equal(empty.playsUntil, 0)
  empty.pause()
  empty.reset()
  assert.equal(empty.paused, false)
})

// --- A page that dropped: it played on what it had, and says when it comes back how much it got ---------------------

test('lost(ms) takes the last ms off the newest lines: a line none of whose audio arrived goes, and the one before it is cut', () => {
  const { playback, amended, at } = follow()
  const a = playback.begin('a', A)
  playback.sent(a, 2000) // 50-2050
  playback.close(a, true)
  const b = playback.begin('b', 'Next.')
  playback.sent(b, 600) // 2050-2650
  playback.close(b, true)
  at(5000) // the page came back: it never got the last 1600 ms
  playback.lost(1600)
  assert.deepEqual(amended, [['a', `The pilot starts in… ${CUT_OFF}`], ['b', '']])
  assert.deepEqual(a.runs, [[T + 50, T + 1050]])
  assert.deepEqual(b.runs, [])
  // What goes out next plays from when it arrives: the page has nothing left.
  const c = playback.begin('c', 'Next again.')
  playback.sent(c, 100)
  assert.deepEqual(c.runs, [[T + 5000 + PAGE_LEAD_MS, T + 5150]])
})

test('lost(ms) takes audio no line is kept for first when it is the newest, and the line before it keeps the rest', () => {
  const { playback, amended } = follow()
  const a = playback.begin('a', A)
  playback.sent(a, 2000) // 50-2050
  playback.close(a, true)
  playback.sent(null, 500) // 2050-2550: audio of no line
  playback.lost(500)
  assert.deepEqual(amended, [], 'only the audio of no line was lost')
  assert.equal(playback.playsUntil, T + 2050)
  playback.lost(1000)
  assert.deepEqual(amended, [['a', `The pilot starts in… ${CUT_OFF}`]])
  assert.equal(playback.playsUntil, T + 1050)
})

test('lost(ms) corrects a line closed short too, and changes nothing once nothing is lost', () => {
  const { playback, amended } = follow()
  const text = 'We expect the first results in the second week of April.' // 3920
  const a = playback.begin('a', text)
  playback.sent(a, 1960) // 50-2010
  playback.close(a, false) // the turn stopped as the page dropped
  assert.deepEqual(amended, [['a', `We expect the first results… ${CUT_OFF}`]])
  playback.lost(980)
  assert.deepEqual(amended.at(-1), ['a', `We expect the… ${CUT_OFF}`])
  playback.lost(0)
  assert.equal(amended.length, 2)
})

test('lost(ms) on a paused page takes what it holds first, the newest audio of all', () => {
  const { playback, amended, at } = follow()
  const a = playback.begin('a', A)
  playback.sent(a, 2000) // 50-2050
  playback.close(a, true)
  at(1050)
  playback.pause() // 1000 played, 1000 held
  playback.lost(500) // the page never got the last 500 ms of what it holds
  assert.deepEqual(amended, [['a', `The pilot starts in March and… ${CUT_OFF}`]])
  assert.deepEqual(a.runs, [[T + 50, T + 1050]], 'what it played is untouched')
  assert.equal(playback.playsUntil, T + 1050 + PAGE_LEAD_MS + 500)
  playback.lost(1000) // the rest of what it held, and 500 of what it played
  assert.deepEqual(amended.at(-1), ['a', `The pilot… ${CUT_OFF}`])
  assert.equal(playback.playsUntil, 0)
})

test('stop(at) settles as of a past time: a page last heard at t is credited only with what it played by t', () => {
  const { playback, amended, at } = follow()
  const a = playback.begin('a', A)
  playback.sent(a, 2000) // 50-2050
  playback.close(a, true)
  at(9000) // the page has been away a while; it was last heard 1000 ms into the line
  playback.stop(T + PAGE_LEAD_MS + 1000)
  assert.deepEqual(amended, [['a', `The pilot starts in… ${CUT_OFF}`]])
  assert.equal(playback.following.length, 0)
})

test('audio of no line is kept KEEP_MS too, so a loss after it never takes the line before it instead', () => {
  const { playback, amended, at } = follow()
  const a = playback.begin('a', 'It ships in March.')
  playback.sent(a, 500) // 50-550
  playback.close(a, true)
  playback.sent(null, 500) // 550-1050: audio of no line
  at(1100)
  const b = playback.begin('b', 'Next.')
  playback.sent(b, 500) // 1150-1650
  playback.close(b, true)
  playback.lost(1000)
  assert.deepEqual(amended, [['b', '']], 'b and the audio of no line went; a was played in full')
})
