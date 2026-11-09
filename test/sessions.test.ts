import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findSession, lateAnswerText, sessionHandlers, type LiveSession } from '../src/sessions.ts'

/** A stand-in for a MeetingSession: what it was asked to add and post, and whether it refuses. */
function fake(meetingKey: string, opts: { bot?: boolean; refuse?: string; chatFails?: boolean } = {}) {
  const added: string[] = []
  const posted: string[] = []
  const session: LiveSession = {
    opts: { meetingKey },
    botId: opts.bot ? `bot-${meetingKey}` : undefined,
    transcript: { recent: (maxChars?: number) => `transcript of ${meetingKey}${maxChars ? ` (${maxChars})` : ''}` },
    addToBrief: (text: string) => {
      if (opts.refuse) return { ok: false, note: opts.refuse }
      added.push(text)
      return { ok: true }
    },
    postChat: async (message: string) => {
      if (!opts.bot || opts.chatFails) return false
      posted.push(message)
      return true
    },
  }
  return { session, added, posted }
}

test('a meeting key finds that meeting\'s newest session, and nothing else', () => {
  const first = fake('m1', { bot: true })
  const reconnected = fake('m1', { bot: true })
  const other = fake('m2', { bot: true })
  const sessions = [first.session, reconnected.session, other.session]
  assert.equal(findSession(sessions, 'm1'), reconnected.session, 'its page reconnected: the newest session')
  assert.equal(findSession(sessions, 'm3'), undefined, 'no other meeting stands in for one that is gone')
})

test('without a key, the newest meeting Alex is in', () => {
  const older = fake('m1', { bot: true })
  const meeting = fake('m2', { bot: true })
  assert.equal(findSession([older.session, meeting.session]), meeting.session)
  assert.equal(findSession([]), undefined)
})

test('get_transcript reads the meeting named, else the newest meeting, and says so when there is none', () => {
  const older = fake('m1', { bot: true })
  const newer = fake('m2', { bot: true })
  const sessions = new Set([older.session, newer.session])
  const { transcript } = sessionHandlers(sessions)
  assert.equal(transcript(3000, 'm1'), 'transcript of m1 (3000)', 'the meeting named, though another started since')
  assert.equal(transcript(3000), 'transcript of m2 (3000)')
  assert.equal(transcript(undefined, 'm9'), '(Alex is not in that meeting right now)')
  sessions.clear()
  assert.equal(transcript(), '(no meeting in progress)')
})

test('add_to_brief goes to the meeting named, else the newest meeting, and is refused with a note when there is none', () => {
  const older = fake('m1', { bot: true })
  const newer = fake('m2', { bot: true })
  const sessions = new Set([older.session, newer.session])
  const { addToBrief } = sessionHandlers(sessions)
  assert.deepEqual(addToBrief('The pilot starts on 3 March.'), { ok: true })
  assert.deepEqual(newer.added, ['The pilot starts on 3 March.'])
  assert.deepEqual(older.added, [], 'not the meeting that started earlier')
  assert.deepEqual(addToBrief('Testing.', 'm1'), { ok: true })
  assert.deepEqual(older.added, ['Testing.'])
  assert.deepEqual(newer.added, ['The pilot starts on 3 March.'], 'nor the newer one, when the older is named')
  assert.deepEqual(addToBrief('More.', 'm9'), { ok: false, note: 'Alex is not in that meeting right now' })
  sessions.clear()
  assert.deepEqual(addToBrief('More.'), { ok: false, note: 'Alex is not in a meeting right now' })
})

test('add_to_brief passes on what the session says when it refuses, such as after a leave', () => {
  const left = fake('m1', { bot: true, refuse: 'Alex has been asked to leave this meeting' })
  const { addToBrief } = sessionHandlers(new Set([left.session]))
  assert.deepEqual(addToBrief('More.', 'm1'), { ok: false, note: 'Alex has been asked to leave this meeting' })
})

test('a message posted in the meeting chat is kept with the meeting\'s additions, and one that failed is not', async () => {
  const meeting = fake('m1', { bot: true })
  const { postChat } = sessionHandlers(new Set([meeting.session]))
  assert.deepEqual(await postChat('The slides are at the usual place.'), { ok: true })
  assert.deepEqual(meeting.posted, ['The slides are at the usual place.'])
  assert.deepEqual(meeting.added, ['Alex posted in the meeting chat: The slides are at the usual place.'])

  const failing = fake('m2', { bot: true, chatFails: true })
  assert.equal((await sessionHandlers(new Set([failing.session])).postChat('Hello.')).ok, false)
  assert.deepEqual(failing.added, [], 'not posted, so not kept')
  assert.deepEqual(await sessionHandlers(new Set()).postChat('Hello.'), { ok: false, note: 'Alex is not in a meeting with a chat right now' })
  // A session that does not know its bot has no chat to post in.
  const noBot = fake('m3')
  assert.deepEqual(await sessionHandlers(new Set([noBot.session])).postChat('Hello.'), { ok: false, note: 'Alex is not in a meeting with a chat right now' })
  assert.deepEqual(await sessionHandlers(new Set([noBot.session])).postChat('Hello.', 'm3'), { ok: false, note: 'Alex is not in a meeting with a chat right now' })
  assert.deepEqual(noBot.added, [])
})

test("with two meetings live, a chat message goes to the meeting named, and only there", async () => {
  const a = fake('m1', { bot: true })
  const b = fake('m2', { bot: true }) // the newer meeting
  const { postChat } = sessionHandlers(new Set([a.session, b.session]))
  assert.deepEqual(await postChat('The steps are: plan, build, ship.', 'm1'), { ok: true })
  assert.deepEqual(a.posted, ['The steps are: plan, build, ship.'])
  assert.deepEqual(a.added, ['Alex posted in the meeting chat: The steps are: plan, build, ship.'])
  assert.deepEqual([b.posted, b.added], [[], []], "nothing of meeting 1 reaches meeting 2's chat or additions")
  assert.deepEqual(await postChat('Hello.', 'm9'), { ok: false, note: 'Alex is not in that meeting right now' })
})

test('without a key, a chat message is refused while Alex is in more than one meeting, rather than guessed', async () => {
  const a = fake('m1', { bot: true })
  const b = fake('m2', { bot: true })
  const both = sessionHandlers(new Set([a.session, b.session]))
  const refused = await both.postChat('The steps are: plan, build, ship.')
  assert.equal(refused.ok, false)
  assert.match(refused.note ?? '', /more than one meeting/)
  assert.deepEqual([a.posted, b.posted, a.added, b.added], [[], [], [], []])

  // One meeting whose page reconnected is still one meeting: the post goes to its newest session.
  const reconnected = fake('m1', { bot: true })
  assert.deepEqual(await sessionHandlers(new Set([a.session, reconnected.session])).postChat('Hello.'), { ok: true })
  assert.deepEqual(reconnected.posted, ['Hello.'])
  assert.deepEqual(a.posted, [])
})

test("a late answer is kept with its own meeting's additions, saying the meeting has not heard it", () => {
  const meeting = fake('m1', { bot: true })
  const newer = fake('m2', { bot: true })
  const { lateAnswer } = sessionHandlers(new Set([meeting.session, newer.session]))
  const answer = { spoken: 'There are three steps.', detail: '1. Plan\n2. Build\n3. Ship' }
  assert.deepEqual(lateAnswer('m1', 'What are the rollout steps?', answer), { ok: true })
  assert.deepEqual(meeting.added, [lateAnswerText('What are the rollout steps?', answer)])
  assert.deepEqual(newer.added, [], 'never another meeting')
  assert.equal(
    meeting.added[0],
    'Sam\'s session answered "What are the rollout steps?" after Alex had stopped waiting for it, ' +
      'so the meeting has not heard this answer: There are three steps. (More detail: 1. Plan\n2. Build\n3. Ship)',
  )
})

test('a late answer is refused once the meeting is over, and after a leave as add_to_brief is', () => {
  const answer = { spoken: 'In March.' }
  assert.deepEqual(sessionHandlers(new Set()).lateAnswer('m1', 'When?', answer), { ok: false, note: 'Alex is no longer in that meeting' })
  const left = fake('m1', { bot: true, refuse: 'Alex has been asked to leave this meeting' })
  assert.deepEqual(sessionHandlers(new Set([left.session])).lateAnswer('m1', 'When?', answer), {
    ok: false,
    note: 'Alex has been asked to leave this meeting',
  })
})
