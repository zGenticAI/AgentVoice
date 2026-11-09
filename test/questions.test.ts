import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type Question, QuestionDesk } from '../src/channel/questions.ts'

const q = (id: string, meeting = 'm1'): Question => ({ question_id: id, asked_by: 'meeting participant', question: `question ${id}`, context: '', meeting })
const endOf = (meeting: string) => ({ meeting, transcript_file: `/data/${meeting}.txt`, questions: ['question q1'], minutes_file: `/data/minutes/${meeting}.md` })
const end = endOf('m1')
const settle = (ms = 20) => new Promise(r => setTimeout(r, ms))

function desk(graceMs = 1000) {
  const pushed: string[] = []
  return { desk: new QuestionDesk(question => pushed.push(question.question_id), graceMs), pushed }
}

test('with no assistant, a question goes to the session as before', () => {
  const { desk: d, pushed } = desk()
  d.offer(q('q1'))
  assert.deepEqual(pushed, ['q1'])
})

test('a waiting next_question call gets the question, and the session does not', async () => {
  const { desk: d, pushed } = desk()
  const call = d.next(1000)
  d.offer(q('q1'))
  assert.deepEqual(await call, { question: q('q1') })
  assert.deepEqual(pushed, [])
})

test('while the assistant answers one question, the next one waits for it', async () => {
  const { desk: d, pushed } = desk()
  const first = d.next(1000)
  d.offer(q('q1'))
  await first
  d.offer(q('q2')) // the assistant is busy replying to q1
  d.offer(q('q3'))
  assert.deepEqual(pushed, [])
  assert.deepEqual(await d.next(1000), { question: q('q2') })
  assert.deepEqual(await d.next(1000), { question: q('q3') })
})

test('a call that times out returns none, and the assistant stays attached for its next call', async () => {
  const { desk: d, pushed } = desk()
  assert.deepEqual(await d.next(10), { none: true })
  d.offer(q('q1'))
  assert.deepEqual(pushed, [])
  assert.deepEqual(await d.next(1000), { question: q('q1') })
})

test('a queued question nobody takes goes to the session after the grace period, once', async () => {
  const { desk: d, pushed } = desk(60)
  const first = d.next(1000)
  d.offer(q('q1'))
  await first
  d.offer(q('q2')) // and the assistant never calls again
  await settle(100)
  assert.deepEqual(pushed, ['q2'])
  assert.deepEqual(await d.next(10), { none: true }, 'not handed out a second time')
  assert.deepEqual(pushed, ['q2'])
})

test('a question taken from the queue is not pushed to the session later', async () => {
  const { desk: d, pushed } = desk(60)
  const first = d.next(1000)
  d.offer(q('q1'))
  await first
  d.offer(q('q2'))
  assert.deepEqual(await d.next(1000), { question: q('q2') })
  await settle(100)
  assert.deepEqual(pushed, [])
})

test('once the grace period has passed, questions go to the session again', async () => {
  const { desk: d, pushed } = desk(40)
  const first = d.next(1000)
  d.offer(q('q1'))
  await first
  await settle(60)
  d.offer(q('q2'))
  assert.deepEqual(pushed, ['q2'])
})

test('a cancelled call does not swallow a later question', async () => {
  const { desk: d, pushed } = desk()
  const cancel = new AbortController()
  const call = d.next(1000, cancel.signal)
  cancel.abort()
  assert.deepEqual(await call, { none: true })
  d.offer(q('q1'))
  assert.deepEqual(pushed, ['q1'])
  assert.deepEqual(await d.next(10), { none: true })
})

test('a call cancelled before it starts does not take a queued question', async () => {
  const { desk: d, pushed } = desk(60)
  const first = d.next(1000)
  d.offer(q('q1'))
  await first
  d.offer(q('q2')) // queued while the assistant answers q1
  const cancel = new AbortController()
  cancel.abort()
  assert.deepEqual(await d.next(1000, cancel.signal), { none: true })
  assert.deepEqual(await d.next(1000), { question: q('q2') }, 'still there for the next call')
  assert.deepEqual(pushed, [])
})

test('two waiting calls get one question each', async () => {
  const { desk: d, pushed } = desk()
  const a = d.next(1000)
  const b = d.next(1000)
  d.offer(q('q1'))
  d.offer(q('q2'))
  assert.deepEqual([await a, await b], [{ question: q('q1') }, { question: q('q2') }])
  assert.deepEqual(pushed, [])
})

// --- The end of the meeting -------------------------------------------------------
test('a waiting assistant hears that the meeting ended, and hears it again if it asks again', async () => {
  const { desk: d } = desk()
  const call = d.next(1000)
  d.meetingEnded(end)
  assert.deepEqual(await call, { meeting_ended: end })
  assert.deepEqual(await d.next(1000), { meeting_ended: end })
})

test('an assistant still answering when the meeting ends hears the end on its next call', async () => {
  const { desk: d } = desk(50)
  const first = d.next(1000)
  d.offer(q('q1'))
  await first
  d.meetingEnded(end) // while it is still within the grace period
  await settle(80) // and it calls again after the grace period
  assert.deepEqual(await d.next(1000), { meeting_ended: end })
})

test('an assistant busy for longer than the grace period when the meeting ends still hears the end', async () => {
  const { desk: d } = desk(30)
  const first = d.next(1000)
  d.offer(q('q1'))
  await first
  await settle(60) // no longer counts as attached
  d.meetingEnded(end)
  await settle(60)
  const started = Date.now()
  assert.deepEqual(await d.next(5000), { meeting_ended: end })
  assert.ok(Date.now() - started < 1000, 'at once, not after wait_seconds')
})

test('a call made after the meeting ended returns the end at once, with no assistant attached before', async () => {
  const { desk: d } = desk()
  d.meetingEnded(end)
  assert.equal(d.ready(), true)
  const started = Date.now()
  assert.deepEqual(await d.next(5000), { meeting_ended: end })
  assert.ok(Date.now() - started < 1000)
})

test('when the meeting ends, its queued questions are dropped and the assistant hears the end next', async () => {
  const { desk: d, pushed } = desk(60)
  const first = d.next(1000)
  d.offer(q('q1'))
  await first
  d.offer(q('q2')) // nobody can hear an answer to it any more
  d.meetingEnded(end)
  assert.deepEqual(await d.next(1000), { meeting_ended: end })
  await settle(100)
  assert.deepEqual(pushed, [], 'not pushed to the session after the meeting either')
})

test('after the end of the meeting, the assistant is no longer attached', async () => {
  const { desk: d, pushed } = desk()
  const call = d.next(1000)
  d.meetingEnded(end)
  await call
  d.offer(q('q9', 'm2')) // a question in the next meeting, before a new assistant starts
  assert.deepEqual(pushed, ['q9'])
})

test('the end of a meeting no longer applies once the next one starts or is joined', async () => {
  const { desk: d } = desk()
  d.meetingEnded(end)
  d.meetingStarted('m2')
  assert.equal(d.ready(), false)
  assert.deepEqual(await d.next(10), { none: true })

  const { desk: e } = desk()
  e.meetingEnded(end)
  e.joining()
  assert.equal(e.ready(), false)
  assert.deepEqual(await e.next(10), { none: true }, "the next meeting's assistant does not finish at once")
})

test("an assistant started for the next meeting never acts on the previous meeting's end", async () => {
  const { desk: d } = desk()
  d.meetingStarted('m1')
  d.joining('m2') // Sam sends Alex into m2 while m1 is still going
  const call = d.next(100) // m2's assistant, which does not know its key yet
  d.meetingEnded(end) // m1 ends
  assert.deepEqual(await call, { none: true })
  assert.deepEqual(await d.next(10, undefined, 'm1'), { meeting_ended: end }, "m1's own assistant still hears it")
})

test("an assistant that names its meeting hears that meeting's end even after the next one started", async () => {
  const { desk: d, pushed } = desk()
  d.meetingStarted('m1')
  const first = d.next(1000, undefined, 'm1')
  d.offer(q('q1', 'm1'))
  await first // and it answers q1 for a long time
  d.meetingEnded(end)
  d.joining('m2')
  d.meetingStarted('m2')
  d.offer(q('q2', 'm2')) // not for the m1 assistant: straight to the session
  assert.deepEqual(pushed, ['q2'])
  assert.deepEqual(await d.next(1000, undefined, 'm1'), { meeting_ended: end })
})

test("an assistant that names its meeting takes only that meeting's questions", async () => {
  const { desk: d, pushed } = desk()
  const call = d.next(1000, undefined, 'm2')
  d.offer(q('q1', 'm1'))
  d.offer(q('q2', 'm2'))
  assert.deepEqual(await call, { question: q('q2', 'm2') })
  assert.deepEqual(pushed, ['q1'])
})

test('attachedUntil covers a waiting call plus the grace period, and is 0 once the meeting ended', async () => {
  const { desk: d } = desk(1000)
  assert.equal(d.attachedUntil, 0)
  const call = d.next(2000)
  assert.ok(d.attachedUntil >= Date.now() + 2900)
  d.meetingEnded(end)
  await call
  assert.equal(d.attachedUntil, 0)
})
