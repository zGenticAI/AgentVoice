import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { Transcript, TRANSCRIPTS_DIR } from '../src/transcript.ts'

test('a transcript is meeting content: its file is readable by this user only', () => {
  const t = new Transcript(`perm-test-${process.pid}`)
  t.add('Speaker', 'Alex, what is Acme?')
  assert.equal(fs.statSync(t.file).mode & 0o777, 0o600)
  assert.equal(fs.statSync(TRANSCRIPTS_DIR).mode & 0o077, 0)
  t.delete()
})
