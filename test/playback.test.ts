// What the meeting heard of the assistant: how much of a line the page had played when it stopped, as whole words.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CUT_OFF, MS_PER_CHAR, PAGE_LEAD_MS, Playback, heardText } from '../src/pipeline/playback.ts'

test('a line cut off keeps the whole words heard, rounded down, and says it was cut off', () => {
  const line = 'The pilot starts in March and ends in May.'
  // "The pilot starts in" ends at character 19 of 42, "March" at 25.
  assert.equal(heardText(line, 0.5), `The pilot starts in… ${CUT_OFF}`)
  assert.equal(heardText(line, 19 / 42), `The pilot starts in… ${CUT_OFF}`)
  assert.equal(heardText(line, 18 / 42), `The pilot starts… ${CUT_OFF}`, 'a word cut off partway was not heard')
  assert.equal(heardText(line, 25 / 42), `The pilot starts in March… ${CUT_OFF}`)
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

test('lines the page has played out stop being followed when the next line starts', () => {
  const { playback, at } = follow()
  const a = playback.begin('a', 'It ships in March.')
  playback.sent(a, 400)
  playback.close(a, true)
  at(300)
  playback.begin('b', 'Still playing a.')
  assert.deepEqual(playback.following.map(p => p.line), ['a', 'b'])
  at(PAGE_LEAD_MS + 400)
  playback.begin('c', 'a has played.')
  assert.deepEqual(playback.following.map(p => p.line), ['b', 'c'])
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
