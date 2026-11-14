import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Transcript, TRANSCRIPTS_DIR } from '../src/transcript.ts'

test('a transcript is meeting content: its file is readable by this user only', () => {
  const t = new Transcript(`perm-test-${process.pid}`)
  t.add('Speaker', 'Alex, what is Acme?')
  assert.equal(fs.statSync(t.file).mode & 0o777, 0o600)
  assert.equal(fs.statSync(TRANSCRIPTS_DIR).mode & 0o077, 0)
  t.delete()
})

test('a line can be changed or taken out, in memory and in the file, which is replaced whole and stays private', () => {
  const t = new Transcript(`amend-test-${process.pid}`)
  t.add('Speaker', 'Alex, when does the pilot start?')
  const said = t.add('Alex', 'The pilot starts in March and ends in May.')
  const next = t.add('Alex', 'The budget is set.')
  t.add('Speaker', 'Thanks.')
  assert.ok(said && next)
  t.amend(said, 'The pilot starts in\u2026 (cut off)')
  t.amend(next, '')
  assert.deepEqual(t.lines.map(l => `${l.speaker}: ${l.text}`), [
    'Speaker: Alex, when does the pilot start?',
    'Alex: The pilot starts in\u2026 (cut off)',
    'Speaker: Thanks.',
  ])
  const file = fs.readFileSync(t.file, 'utf8')
  assert.equal(file, `${t.text()}\n`)
  assert.match(file, /^\[\d\d:\d\d:\d\d\] Speaker: Alex, when does the pilot start\?\n\[\d\d:\d\d:\d\d\] Alex: The pilot starts in\u2026 \(cut off\)\n/)
  assert.equal(fs.statSync(t.file).mode & 0o777, 0o600)
  // Nothing is left beside it.
  assert.deepEqual(fs.readdirSync(TRANSCRIPTS_DIR).filter(name => name.startsWith(path.basename(t.file))), [path.basename(t.file)])
  // A line added after an amend goes after the others, in the file too.
  t.add('Speaker', 'One more thing.')
  assert.match(fs.readFileSync(t.file, 'utf8'), /Thanks\.\n\[[\d:]+\] Speaker: One more thing\.\n$/)
  t.delete()
})

test('once deleted, a transcript is not written again: an amend does nothing, and add says so', () => {
  const t = new Transcript(`amend-deleted-${process.pid}`)
  const line = t.add('Alex', 'It ships in March.')
  assert.ok(line)
  t.delete()
  t.amend(line, 'It ships\u2026 (cut off)')
  assert.equal(fs.existsSync(t.file), false)
  assert.equal(fs.existsSync(`${t.file}.next`), false)
  assert.equal(t.add('Speaker', 'Late words.'), null)
  assert.equal(fs.existsSync(t.file), false)
})

test('an amend of a line that is not in the transcript changes nothing', () => {
  const t = new Transcript(`amend-other-${process.pid}`)
  t.add('Speaker', 'Hello.')
  const before = fs.readFileSync(t.file, 'utf8')
  t.amend({ at: new Date(), speaker: 'Alex', text: 'Not in it.', role: 'agent' }, '')
  assert.equal(fs.readFileSync(t.file, 'utf8'), before)
  assert.equal(t.lines.length, 1)
  t.delete()
})

test('a correction that cannot be written leaves the file as it was and no copy beside it, and memory has it right', t => {
  const tr = new Transcript(`amend-full-${process.pid}`)
  tr.add('Speaker', 'When does the pilot start?')
  const said = tr.add('Alex', 'The pilot starts in March and ends in May.', 'agent')!
  const before = fs.readFileSync(tr.file, 'utf8')
  const write = fs.writeFileSync
  // A full disk: part of the copy is written, then the write fails.
  t.mock.method(fs, 'writeFileSync', function (file: fs.PathOrFileDescriptor, ...rest: unknown[]) {
    if (!String(file).endsWith('.next')) return (write as Function).call(fs, file, ...rest)
    ;(write as Function).call(fs, file, '[00:00:00] Speaker: When does')
    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
  })
  const errors: string[] = []
  t.mock.method(console, 'error', (...args: unknown[]) => void errors.push(args.map(String).join(' ')))
  tr.amend(said, 'The pilot starts in… (cut off)') // does not throw
  assert.equal(fs.readFileSync(tr.file, 'utf8'), before)
  assert.equal(fs.existsSync(`${tr.file}.next`), false)
  assert.equal(tr.lines[1].text, 'The pilot starts in… (cut off)')
  assert.deepEqual(errors, ['[transcript] could not correct a line in the transcript file: ENOSPC'])
  tr.delete()
})

test('a delete takes a copy left beside the transcript with it', () => {
  const tr = new Transcript(`amend-left-${process.pid}`)
  tr.add('Speaker', 'When does the pilot start?')
  fs.writeFileSync(`${tr.file}.next`, '[00:00:00] Speaker: When does', { mode: 0o600 }) // left by a crash mid-write
  tr.delete()
  assert.equal(fs.existsSync(tr.file), false)
  assert.equal(fs.existsSync(`${tr.file}.next`), false)
})
