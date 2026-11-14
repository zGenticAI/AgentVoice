// What a meeting can count on from Alex, whatever else is going on: "Alex, never mind" stops him, the
// consent line is heard in full, leaving is quick and keeps nothing, and a slow or failing step never
// loses an answer or a reply.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import type { BriefAdditions } from '../src/brain/additions.ts'
import { Brain, type BrainEvent } from '../src/brain/brain.ts'
import { LEFT_NOTE, SessionBridge, type SessionAnswer, type ToSession } from '../src/bridge.ts'
import { CHECKING_LINES, JOIN_LINE, LEAVE_LINE, PROGRESS_LINE } from '../src/consent.ts'
import { MeetingSession, PAGE_ERRORS } from '../src/pipeline/session.ts'
import { sessionHandlers } from '../src/sessions.ts'

class FakeSocket extends EventEmitter {
  readyState = 1
  sent: (Buffer | string)[] = []
  send(data: Buffer | string) { this.sent.push(data) }
  close() { this.readyState = 3 }
  controls() { return this.sent.filter(d => typeof d === 'string').map(d => JSON.parse(d as string)) }
  audio() { return this.sent.filter(d => typeof d !== 'string') as Buffer[] }
  cleared() { return this.controls().some(c => c.type === 'clear') }
}

class FakeFlux extends EventEmitter {
  received: Buffer[] = []
  closed = false
  send(b: Buffer) { this.received.push(b) }
  // Like Deepgram: the stream closes a little after CloseStream.
  close() {
    if (this.closed) return
    this.closed = true
    setImmediate(() => this.emit('close', 1000, ''))
  }
  endTurn(text: string) { this.emit('turn', { type: 'TurnInfo', event: 'EndOfTurn', turn_index: 0, transcript: text }) }
  // Like Flux: a turn starts once its first words are heard, and each event carries the turn so far.
  startTurn(text = 'Wait, what about') { this.emit('turn', { type: 'TurnInfo', event: 'StartOfTurn', turn_index: 1, transcript: text }) }
  update(text: string) { this.emit('turn', { type: 'TurnInfo', event: 'Update', turn_index: 1, transcript: text }) }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const settle = () => sleep(30)
async function until(ok: () => boolean, tries = 100): Promise<void> {
  for (let i = 0; i < tries && !ok(); i++) await sleep(10)
}

let meetings = 0

interface Options {
  meetingKey?: string
  /** What the fast tier says to each line it is given. By default it hands every question to Sam's session. */
  reply?: (latest: string) => BrainEvent[]
  /** Sam's session. By default it answers at once. */
  ask?: (question: string) => Promise<SessionAnswer | null>
  /** Or Sam's session through the real bridge, as the voice service wires it (see linked below). */
  owner?: ReturnType<typeof linked>
  speak?: (text: string, signal?: AbortSignal) => AsyncGenerator<Buffer>
  sendChat?: (botId: string, message: string) => Promise<void>
  progressAfterMs?: number
  calledWindowMs?: number
  /** By default no greeting during the test. */
  greetDelayMs?: number
  /** By default 0. Passed as undefined, the session's own wait. */
  leaveDelayMs?: number
}

/**
 * A session with fakes for Claude, Sam's session, ElevenLabs and Recall. answered lists the lines the
 * fast tier was given, asked the questions handed to Sam's session, spoken what Alex started to say.
 */
function setup(opts: Options = {}) {
  const ws = new FakeSocket()
  const flux = new FakeFlux()
  const meetingKey = opts.meetingKey ?? `safety-${process.pid}-${++meetings}`
  const botId = `bot-${meetingKey}`
  const answered: string[] = []
  const asked: string[] = []
  const spoken: string[] = []
  const events: ToSession[] = []
  const recall = { left: [] as string[], leftAt: 0 }
  const reply = opts.reply ?? (latest => [{ kind: 'ask_session', question: latest }])
  const owner = opts.owner
  const session = new MeetingSession(ws as any, { meetingKey, botId, platform: 'Zoom' }, {
    brain: {
      async *respond({ latest }: { latest: string }) {
        answered.push(latest)
        yield* reply(latest)
      },
    } as any,
    bridge: {
      notify: (m: ToSession) => {
        events.push(m)
        owner?.bridge.notify(m)
      },
      ask: async (q: Parameters<SessionBridge['ask']>[0], timeoutMs?: number, signal?: AbortSignal) => {
        asked.push(q.question)
        if (owner) return owner.bridge.ask(q, timeoutMs, signal)
        return opts.ask ? opts.ask(q.question) : { spoken: 'Here is the answer.' }
      },
    } as any,
    brief: () => 'Meeting with Bob about the pilot.',
    flux: () => flux as any,
    speak: async function* (text: string, signal?: AbortSignal) {
      spoken.push(text)
      if (opts.speak) yield* opts.speak(text, signal)
      else yield Buffer.from([0, 1])
    },
    recall: {
      sendChat: opts.sendChat ?? (async () => {}),
      leaveCall: async (id: string) => {
        recall.left.push(id)
        recall.leftAt ||= Date.now()
      },
      deleteMedia: async () => true,
      howBotEnded: async () => ({ kind: 'ended', sub_code: 'call_ended_by_host' }),
    },
    writeMinutes: async () => Promise.reject(new Error('no minutes in these tests')),
    progressAfterMs: opts.progressAfterMs,
    calledWindowMs: opts.calledWindowMs,
    greetDelayMs: opts.greetDelayMs ?? 60_000,
    leaveDelayMs: 'leaveDelayMs' in opts ? opts.leaveDelayMs : 0,
    sttFlushMs: 20,
  })
  if (owner) {
    // As server.ts does: a session is live from its page connecting until its page closes.
    owner.sessions.add(session)
    ws.on('close', () => owner.sessions.delete(session))
  }
  const ended = () => events.find(e => e.type === 'meeting_ended') as Extract<ToSession, { type: 'meeting_ended' }> | undefined
  // Private on purpose: nothing outside the session reads them. The tests look, to see what is kept.
  const additions = () => (session as any).additions as BriefAdditions
  const done = () => {
    ws.emit('close')
    session.transcript.delete()
  }
  return { ws, flux, botId, meetingKey, session, answered, asked, spoken, events, ended, recall, additions, done }
}

/**
 * Sam's session through the real bridge, wired to the live sessions as server.ts wires it (src/sessions.ts):
 * questions reach a linked channel server, and reply() answers one and resolves with the bridge's
 * acknowledgement, which is what the reply tool tells the session.
 */
function linked() {
  const sessions = new Set<MeetingSession>()
  const bridge = new SessionBridge({ ...sessionHandlers(sessions), setBrief: () => {}, joinMeeting: async () => ({ note: '' }) })
  const channel = new FakeSocket()
  bridge.attach(channel as any)
  channel.emit('message', Buffer.from(JSON.stringify({ type: 'claim' })))
  const questions = () => channel.controls().filter(m => m.type === 'question')
  let replies = 0
  const reply = async (id: string, answer: SessionAnswer) => {
    const request_id = `r${++replies}`
    channel.emit('message', Buffer.from(JSON.stringify({ type: 'reply', id, request_id, ...answer })))
    await until(() => channel.controls().some(m => m.request_id === request_id))
    const { type: _type, request_id: _id, ...ack } = channel.controls().find(m => m.request_id === request_id)
    return ack
  }
  return { bridge, sessions, questions, reply }
}

/** Sam's session, answering when the test says so. */
function later() {
  let answer!: (a: SessionAnswer | null) => void
  return {
    ask: () => new Promise<SessionAnswer | null>(resolve => (answer = resolve)),
    answer: (a: SessionAnswer | null) => answer(a),
  }
}

/** Alex's voice, sent a piece at a time while he talks, as from ElevenLabs or the kept lines. */
function talking(pieces: number, gapMs = 10) {
  return async function* (_text: string, signal?: AbortSignal) {
    for (let i = 0; i < pieces && !signal?.aborted; i++) {
      yield Buffer.from([0, 0])
      await sleep(gapMs)
    }
  }
}

// --- "Alex, never mind" --------------------------------------------------------------------------------

for (const cancel of [
  'Alex, never mind.',
  "Actually Alex, never mind, we'll ask Sam later.",
  'Never mind, Alex.',
  'Alex, stop.',
  'Alex, scratch that.',
  'Alex, hold on, never mind.',
  'Alex, stop, OK?', // a tag, not a new question
  'Alex, stop, what do you think Sarah?', // a question for Sarah
]) {
  test(`"${cancel}" stops a question waiting for Sam's session: no "still checking", the answer is not said, and it is kept`, async () => {
    const owner = linked()
    const s = setup({ owner, progressAfterMs: 50 })
    s.flux.endTurn('Alex, what is the status of PR 9?')
    await until(() => owner.questions().length === 1)
    s.flux.endTurn(cancel)
    await sleep(150) // several times progressAfterMs
    assert.deepEqual(s.spoken, [CHECKING_LINES[0]], 'no "still checking" line')
    assert.deepEqual(s.answered, ['Alex, what is the status of PR 9?'], 'the cancel is not a question for the fast tier')
    const ack = await owner.reply(owner.questions()[0].id, { spoken: 'PR 9 was merged this morning.' })
    assert.deepEqual(ack, { ok: false, late: true, why: 'stopped', kept: true }, "Sam's session hears Alex will not say it, and that it is kept")
    await settle()
    assert.deepEqual(s.spoken, [CHECKING_LINES[0]], 'the answer the meeting called off is not said')
    assert.match(s.additions().text(), /the meeting has not heard this answer: PR 9 was merged this morning\./, 'but it is kept, so asking again is answered at once')
    assert.equal(s.additions().size, 1, 'kept once')
    s.done()
  })
}

test('telling Alex to stop while he is talking stops him and clears what the page still has to play', async () => {
  const s = setup({ reply: () => [{ kind: 'say', text: 'A long answer about everything.' }], speak: talking(50) })
  s.flux.endTurn('Alex, explain everything.')
  await sleep(40)
  // No StartOfTurn: the stop has to stop him by itself.
  s.flux.endTurn('Alex, please stop.')
  await settle()
  const sent = s.ws.audio().length
  await sleep(60)
  assert.ok(s.ws.cleared(), 'the page is told to clear')
  assert.equal(s.ws.audio().length, sent, 'no more audio after the stop')
  assert.ok(sent < 50)
  assert.deepEqual(s.answered, ['Alex, explain everything.'])
  s.done()
})

test('"never mind" in a reply window closes it, and Alex says nothing', async () => {
  const s = setup({ reply: latest => [{ kind: 'say', text: latest.startsWith('Alex') ? 'Shall I go through the steps?' : 'Sure.' }] })
  s.flux.endTurn('Alex, how did the pilot go?')
  await settle()
  s.flux.endTurn('No need.')
  s.flux.endTurn('What about the budget?') // to the room: the window has closed
  await settle()
  assert.deepEqual(s.answered, ['Alex, how did the pilot go?'])
  assert.deepEqual(s.spoken, ['Shall I go through the steps?'])
  assert.ok(s.ws.cleared(), 'the page is told to clear in case it is still playing the answer (nothing happens if not)')
  s.done()
})

test('telling Alex to stop after his answer has all gone out, while the page is still playing it, stops it on the page', async () => {
  // Two seconds of answer, sent at once, as ElevenLabs can stream it faster than it plays.
  const s = setup({ reply: () => [{ kind: 'say', text: 'A long answer about everything.' }], speak: async function* () { yield Buffer.alloc(2000 * 32) } })
  s.flux.endTurn('Alex, explain everything.')
  await settle() // all of it has gone out: Alex's turn is over, but the page plays on
  assert.equal(s.ws.cleared(), false)
  s.flux.endTurn('Alex, stop.')
  await settle()
  assert.ok(s.ws.cleared(), 'the page is told to clear')
  s.done()
})

test('a cancel while the page still plays the end of the consent line leaves it be, and one after it clears', async () => {
  // The consent line goes out in 4 pieces of 100 ms at once, so the page plays it for 400 ms after it has all gone.
  const s = setup({
    greetDelayMs: 0,
    speak: async function* (text: string) {
      for (let i = 0; i < (text === JOIN_LINE ? 4 : 1); i++) yield Buffer.alloc(100 * 32)
    },
  })
  await until(() => s.ws.audio().length === 4)
  await settle()
  s.flux.endTurn('Alex, never mind.')
  await settle()
  assert.equal(s.ws.cleared(), false, 'the consent line is heard in full')
  await sleep(450)
  s.flux.endTurn('Alex, never mind.')
  await settle()
  assert.ok(s.ws.cleared())
  s.done()
})

test('a request with a stop word in it is answered, and a new question replaces the one still waiting', async () => {
  const owner = later()
  const s = setup({
    ask: owner.ask,
    reply: latest => (/PR 9/.test(latest) ? [{ kind: 'ask_session', question: latest }] : [{ kind: 'say', text: 'Sure.' }]),
    progressAfterMs: 50,
  })
  s.flux.endTurn('Alex, can you stop the recording?')
  await settle()
  s.flux.endTurn('Alex, what is the status of PR 9?')
  await until(() => s.asked.length === 1)
  s.flux.endTurn('Alex, never mind, what time is it?')
  await sleep(150)
  assert.deepEqual(s.answered, [
    'Alex, can you stop the recording?',
    'Alex, what is the status of PR 9?',
    'Alex, never mind, what time is it?',
  ])
  assert.deepEqual(s.spoken, ['Sure.', CHECKING_LINES[0], 'Sure.'], 'and no "still checking" for the question it replaced')
  assert.equal(s.spoken.includes(PROGRESS_LINE), false)
  s.done()
})

// --- The consent line is heard in full ------------------------------------------------------------------

const JOIN_PIECES = 20
/** The consent line goes out in 20 pieces of 1s, 10 ms apart; anything else in one piece of 2s. */
const greeting = async function* (text: string, signal?: AbortSignal) {
  const pieces = text === JOIN_LINE ? JOIN_PIECES : 1
  for (let i = 0; i < pieces && !signal?.aborted; i++) {
    await sleep(10)
    yield Buffer.alloc(320, text === JOIN_LINE ? 1 : 2)
  }
}
const joinPieces = (ws: FakeSocket) => ws.audio().filter(b => b[0] === 1).length

test('someone talking during the consent line does not cut it off: all of it goes out', async () => {
  const s = setup({ greetDelayMs: 0, speak: greeting })
  await sleep(60)
  s.flux.startTurn() // "Hi Alex", a cough, or the meeting carrying on
  await sleep(20)
  s.flux.startTurn()
  await until(() => joinPieces(s.ws) === JOIN_PIECES)
  await settle()
  assert.equal(s.ws.cleared(), false, 'the page is never told to clear')
  assert.equal(joinPieces(s.ws), JOIN_PIECES)
  s.done()
})

// The consent line sent all at once, as a kept line's last second is: the page still has 400 ms of it to play.
const consentInOneGo = async function* (text: string) {
  yield Buffer.alloc(text === JOIN_LINE ? 32 * 400 : 320, 1)
}

test('a question asked while the page still plays the end of the consent line is answered after it, not over it', async () => {
  const s = setup({ greetDelayMs: 0, speak: consentInOneGo, reply: () => [{ kind: 'say', text: 'Yes, we can hear you.' }] })
  await until(() => s.spoken.includes(JOIN_LINE))
  const sentAt = Date.now()
  s.flux.endTurn('Alex, can you hear us?')
  await sleep(100)
  assert.deepEqual(s.spoken, [JOIN_LINE], 'the answer waits for the page to finish the line')
  await until(() => s.spoken.includes('Yes, we can hear you.'))
  assert.ok(Date.now() - sentAt >= 300, 'answered once the line has played')
  s.done()
})

test('talking over the first answer cannot clear the end of the consent line: the answer only starts once it has played', async () => {
  // The consent line all at once (400 ms left to play), then an answer that takes a while to send.
  const speak = async function* (text: string, signal?: AbortSignal) {
    if (text === JOIN_LINE) {
      yield Buffer.alloc(32 * 400, 1)
      return
    }
    for (let i = 0; i < 10 && !signal?.aborted; i++) {
      await sleep(20)
      yield Buffer.alloc(320, 2)
    }
  }
  const s = setup({ greetDelayMs: 0, speak, reply: () => [{ kind: 'say', text: 'Yes, we can hear you.' }] })
  await until(() => s.spoken.includes(JOIN_LINE))
  s.flux.endTurn('Alex, can you hear us?')
  await sleep(40)
  s.flux.startTurn() // someone talks while the page still plays the consent line
  await sleep(40)
  assert.equal(s.ws.cleared(), false, 'the end of the consent line is heard')
  s.done()
})

test('a question asked during the consent line is answered once it is over', async () => {
  const s = setup({ greetDelayMs: 0, speak: greeting, reply: () => [{ kind: 'say', text: 'Acme builds AI agents.' }] })
  await sleep(60)
  s.flux.startTurn()
  s.flux.endTurn('Alex, what does Acme do?')
  await until(() => s.spoken.includes('Acme builds AI agents.'))
  await settle()
  assert.deepEqual(s.spoken, [JOIN_LINE, 'Acme builds AI agents.'])
  const audio = s.ws.audio()
  assert.equal(joinPieces(s.ws), JOIN_PIECES, 'the whole consent line went out')
  assert.equal(audio.findIndex(b => b[0] === 2), JOIN_PIECES, '...before any of the answer')
  assert.equal(s.ws.cleared(), false)
  s.done()
})

test('"Alex, never mind" during the consent line does not stop it, and drops the question asked before it', async () => {
  const s = setup({ greetDelayMs: 0, speak: greeting, reply: () => [{ kind: 'say', text: 'Sure.' }] })
  await sleep(50)
  s.flux.endTurn('Alex, what does Acme do?')
  s.flux.endTurn('Alex, never mind.')
  await until(() => joinPieces(s.ws) === JOIN_PIECES)
  await sleep(60)
  assert.equal(joinPieces(s.ws), JOIN_PIECES)
  assert.deepEqual(s.spoken, [JOIN_LINE])
  assert.deepEqual(s.answered, [])
  assert.equal(s.ws.cleared(), false)
  s.done()
})

test('"Alex, please leave" during the consent line stops it at once, and Alex leaves', async () => {
  const s = setup({ greetDelayMs: 0, speak: greeting, reply: () => [{ kind: 'say', text: 'Sure.' }] })
  await sleep(50)
  s.flux.endTurn('Alex, what does Acme do?') // waiting for the consent line to end
  await sleep(20)
  const before = joinPieces(s.ws)
  s.flux.endTurn('Alex, please leave.')
  await until(() => s.ended() !== undefined)
  await settle()
  assert.ok(joinPieces(s.ws) <= before + 1, 'no more of the consent line after the request')
  assert.ok(joinPieces(s.ws) < JOIN_PIECES)
  assert.deepEqual(s.spoken, [JOIN_LINE, LEAVE_LINE])
  assert.deepEqual(s.answered, [], 'the question that was waiting is not answered')
  assert.deepEqual(s.recall.left, [s.botId])
  assert.match(s.ended()!.no_minutes ?? '', /asked to leave/)
  assert.equal(fs.existsSync(s.session.transcript.file), false)
})

test('"Alex, please leave" during the consent line clears what the page still holds of it, so the goodbye is heard in full before the bot drops', async () => {
  // A kept consent line goes out up to a second ahead of what has played: here 20 pieces of a second each.
  const s = setup({
    greetDelayMs: 0,
    leaveDelayMs: undefined,
    speak: async function* (text: string, signal?: AbortSignal) {
      if (text === LEAVE_LINE) return yield Buffer.alloc(400 * 32, 7) // 400 ms of goodbye
      for (let i = 0; i < JOIN_PIECES && !signal?.aborted; i++) {
        await sleep(10)
        yield Buffer.alloc(1000 * 32, 1)
      }
    },
  })
  await sleep(50)
  const asked = Date.now()
  s.flux.endTurn('Alex, please leave.')
  await until(() => s.recall.left.length > 0, 300)
  const sent = s.ws.sent.map(d => (typeof d === 'string' ? JSON.parse(d).type : d[0] === 7 ? 'goodbye' : 'consent'))
  const clear = sent.indexOf('clear')
  assert.ok(clear > sent.lastIndexOf('consent'), 'cleared after the last of the consent line...')
  assert.ok(clear < sent.indexOf('goodbye'), '...and before the goodbye, which then plays from when it arrives')
  const took = s.recall.leftAt - asked
  assert.ok(took >= 880 && took < 2500, `left after ${took} ms: once the 400 ms goodbye has played, and half a second more`)
})

test('"Alex?" during the consent line opens the called window once the line is over, so the question that follows is answered', async () => {
  // The consent line takes about 200 ms here, and the window 150 ms: counted from "Alex?", it would run out first.
  const s = setup({ greetDelayMs: 0, speak: greeting, calledWindowMs: 150, reply: () => [{ kind: 'say', text: 'There are three tiers.' }] })
  await sleep(20)
  const called = Date.now()
  s.flux.endTurn('Alex?')
  await until(() => joinPieces(s.ws) === JOIN_PIECES)
  // People wait for Alex to finish before they ask: the page plays the last piece from 50 ms after it arrives.
  await sleep(120)
  assert.ok(Date.now() - called > 150, 'past the window as counted from "Alex?"')
  s.flux.endTurn('What are the tiers?')
  await until(() => s.answered.length === 1)
  assert.deepEqual(s.answered, ['What are the tiers?'])
  s.done()
})

test('the called window opened during the consent line still runs out, counted from the end of the line', async () => {
  const s = setup({ greetDelayMs: 0, speak: greeting, calledWindowMs: 60, reply: () => [{ kind: 'say', text: 'There are three tiers.' }] })
  await sleep(20)
  s.flux.endTurn('Alex?')
  await until(() => joinPieces(s.ws) === JOIN_PIECES)
  await sleep(150)
  s.flux.endTurn('What are the tiers?') // to the room, long after
  await settle()
  assert.deepEqual(s.answered, [])
  s.done()
})

test('the end of the session stops the consent line at once', async () => {
  const s = setup({ greetDelayMs: 0, speak: greeting })
  await sleep(60)
  s.ws.emit('close')
  const at = joinPieces(s.ws)
  await sleep(100)
  assert.ok(joinPieces(s.ws) <= at + 1)
  s.session.transcript.delete()
})

// --- Answers from Sam's session that arrive late -----------------------------------------------------

const STEPS: SessionAnswer = { spoken: 'There are three steps; the list is in the chat.', detail: '1. Plan\n2. Build\n3. Ship' }

test('an answer that arrives after the meeting has ended is not kept', async () => {
  const owner = linked()
  const s = setup({ owner })
  s.flux.endTurn('Alex, what are the rollout steps?')
  await until(() => owner.questions().length === 1)
  s.ws.emit('close') // the meeting is over: this was its only session
  await until(() => s.ended() !== undefined)
  const ack = await owner.reply(owner.questions()[0].id, STEPS)
  assert.deepEqual(ack, { ok: false, late: true, why: 'stopped', kept: false, note: 'Alex is no longer in that meeting' })
  assert.equal(s.additions().size, 0, 'the additions went with the meeting, and stay gone')
  s.session.transcript.delete()
})

test('an answer that arrives after "Alex, please leave" in a later session of the meeting is not kept', async () => {
  const owner = linked()
  const first = setup({ owner })
  first.flux.endTurn('Alex, what are the rollout steps?')
  await until(() => owner.questions().length === 1)
  const second = setup({ meetingKey: first.meetingKey, owner }) // the page reconnected
  first.ws.emit('close') // and the first page's session ended, its question still with Sam's session
  await until(() => first.ended() !== undefined)
  second.flux.endTurn('Alex, please leave.')
  await until(() => second.ended() !== undefined)
  const ack = await owner.reply(owner.questions()[0].id, STEPS)
  assert.deepEqual(ack, { ok: false, late: true, why: 'stopped', kept: false, note: LEFT_NOTE })
  assert.equal(second.additions().size, 0, 'nothing of the meeting is kept')
  assert.equal(first.additions().size, 0)
})

test('an answer that arrives after its session ended is kept while a reconnected page is still in the meeting', async () => {
  const owner = linked()
  const first = setup({ owner })
  first.flux.endTurn('Alex, what are the rollout steps?')
  await until(() => owner.questions().length === 1)
  const second = setup({ meetingKey: first.meetingKey, owner })
  first.ws.emit('close')
  await until(() => first.ended() !== undefined)
  const ack = await owner.reply(owner.questions()[0].id, STEPS)
  assert.deepEqual(ack, { ok: false, late: true, why: 'stopped', kept: true })
  assert.match(second.additions().text(), /the meeting has not heard this answer: There are three steps/)
  first.session.transcript.delete()
  second.done()
})

// --- A step that fails or is slow ----------------------------------------------------------------------

test('the bot page shows fixed words when something fails, never the error: the meeting reads the page, the log gets the error', async t => {
  const errors: string[] = []
  t.mock.method(console, 'error', (...args: unknown[]) => void errors.push(args.map(String).join(' ')))
  const secret = 'ElevenLabs 401: {"detail":{"status":"invalid_api_key","message":"key sk_live_abc for Sam\'s account"}}'
  const s = setup({
    reply: () => [{ kind: 'say', text: 'The pilot starts in May.' }],
    speak: async function* (text: string) {
      if (text === 'The pilot starts in May.') throw new Error(secret)
      yield Buffer.from([0, 1])
    },
  })
  const pageErrors = () => s.ws.controls().filter(c => c.type === 'error')
  s.flux.endTurn('Alex, when does the pilot start?')
  await until(() => pageErrors().length === 1)
  assert.deepEqual(pageErrors(), [{ type: 'error', message: PAGE_ERRORS.answer }])
  assert.ok(errors.some(line => line.includes(secret)), 'the error itself is in the log')

  s.flux.emit('error', new Error('Deepgram refused the connection: 401 {"err_msg":"Invalid credentials","request_id":"r-1"}'))
  s.flux.emit('close', 1011, 'internal error: req r-2')
  await until(() => pageErrors().length === 3)
  assert.deepEqual(pageErrors().slice(1), [{ type: 'error', message: PAGE_ERRORS.hearing }, { type: 'error', message: PAGE_ERRORS.hearing }])
  for (const c of s.ws.controls()) assert.doesNotMatch(JSON.stringify(c), /401|sk_live|request_id|req r-2|Invalid credentials/, JSON.stringify(c))
  assert.ok(errors.some(line => line.includes('Invalid credentials')) && errors.some(line => line.includes('req r-2')))
  s.done()
})

test('a checking line that fails to play does not lose the answer', async () => {
  const s = setup({
    ask: async () => ({ spoken: 'PR 9 was merged this morning.' }),
    speak: async function* (text: string) {
      if (CHECKING_LINES.includes(text)) throw new Error('ElevenLabs 429: too many requests')
      yield Buffer.from([0, 1])
    },
  })
  s.flux.endTurn('Alex, what is the status of PR 9?')
  await until(() => s.spoken.includes('PR 9 was merged this morning.'))
  assert.deepEqual(s.spoken, [CHECKING_LINES[0], 'PR 9 was merged this morning.'])
  assert.match(s.additions().text(), /PR 9 was merged this morning\./)
  assert.equal(s.ws.controls().some(c => c.type === 'error'), false)
  s.done()
})

test('the reply window opens as soon as the answer is said, even while its chat detail is still being posted', async () => {
  const chats: string[] = []
  const s = setup({
    reply: latest =>
      latest.startsWith('Alex') ? [{ kind: 'ask_session', question: latest }] : [{ kind: 'say', text: 'Step one is the plan.' }],
    ask: async () => ({ spoken: 'There are three steps; the list is in the chat. Shall I walk through them?', detail: STEPS.detail }),
    // Recall never answers.
    sendChat: async (_botId, message) => {
      chats.push(message)
      await new Promise(() => {})
    },
  })
  s.flux.endTurn('Alex, what are the rollout steps?')
  await until(() => s.spoken.length === 2)
  await settle()
  s.flux.endTurn('Yes please.')
  await until(() => s.answered.length === 2)
  assert.deepEqual(s.answered, ['Alex, what are the rollout steps?', 'Yes please.'])
  assert.deepEqual(chats, [STEPS.detail])
  s.done()
})

// --- Leaving ---------------------------------------------------------------------------------------------

/** 400 ms of goodbye: all at once, as ElevenLabs can stream it, or in 100 ms pieces in real time, as a kept line goes. */
const goodbye = (paced: boolean) =>
  async function* (text: string): AsyncGenerator<Buffer> {
    if (text !== LEAVE_LINE) yield Buffer.alloc(2)
    else if (!paced) yield Buffer.alloc(400 * 32)
    else {
      for (let i = 0; i < 4; i++) {
        yield Buffer.alloc(100 * 32)
        await sleep(100)
      }
    }
  }

for (const paced of [false, true]) {
  test(`the bot drops once the goodbye has played, not seconds later (${paced ? 'sent as it plays' : 'sent at once'})`, async () => {
    const s = setup({ leaveDelayMs: undefined, speak: goodbye(paced) })
    const asked = Date.now()
    s.flux.endTurn('Alex, please leave.')
    await until(() => s.recall.left.length > 0, 300)
    const took = s.recall.leftAt - asked
    // 400 ms of goodbye and 500 ms more, give or take the timers.
    assert.ok(took >= 880, `left after ${took} ms`)
    assert.ok(took < 2500, `left after ${took} ms`) // it used to be 6 s after the goodbye had gone out
  })
}

test('"Alex, please leave" after an answer has all gone out, while the page still plays it, clears the rest before the goodbye', async () => {
  const s = setup({
    leaveDelayMs: undefined,
    reply: () => [{ kind: 'say', text: 'Here is a three second answer.' }],
    speak: async function* (text: string) {
      yield text === LEAVE_LINE ? Buffer.alloc(400 * 32, 7) : Buffer.alloc(3000 * 32, 3) // sent at once, as ElevenLabs can
    },
  })
  s.flux.endTurn('Alex, tell us about the pilot.')
  await settle() // the whole answer has gone out, and Alex's turn is over
  const asked = Date.now()
  s.flux.endTurn('Alex, please leave.')
  await until(() => s.recall.left.length > 0, 300)
  const sent = s.ws.sent.map(d => (typeof d === 'string' ? JSON.parse(d).type : d[0] === 7 ? 'goodbye' : 'answer'))
  const clear = sent.indexOf('clear')
  assert.ok(clear > sent.indexOf('answer') && clear < sent.indexOf('goodbye'), 'the rest of the answer is cleared before the goodbye')
  const took = s.recall.leftAt - asked
  assert.ok(took >= 880 && took < 2500, `left after ${took} ms: the goodbye plays at once, and is heard in full`)
})

test('when none of the goodbye could be sent, the bot drops after the short margin, whatever Alex said before', async () => {
  const s = setup({
    leaveDelayMs: undefined,
    reply: () => [{ kind: 'say', text: 'Here is a ten second answer.' }],
    speak: async function* (text: string) {
      if (text === LEAVE_LINE) throw new Error('ElevenLabs 503')
      yield Buffer.alloc(10_000 * 32)
    },
  })
  s.flux.endTurn('Alex, tell us about the pilot.')
  await settle()
  const asked = Date.now()
  s.flux.endTurn('Alex, please leave.')
  await until(() => s.recall.left.length > 0, 300)
  const took = s.recall.leftAt - asked
  assert.ok(took >= 480 && took < 2500, `left after ${took} ms`) // not the 10 s the answer before it lasted
})

test('a malformed frame from the bot page is an error on its socket, not a crash: the session ends as on a close', async () => {
  const s = setup()
  // With no 'error' listener, EventEmitter throws here, and in the service that would end every meeting.
  assert.doesNotThrow(() => s.ws.emit('error', new Error('Invalid WebSocket frame: invalid opcode 7')))
  s.ws.emit('close') // as ws does after an error
  await until(() => s.ended() !== undefined)
  assert.ok(s.ended(), 'the meeting ended as usual')
})

test('once Alex is asked to leave, the meeting audio no longer goes to speech recognition', async () => {
  const s = setup({ leaveDelayMs: 100 })
  s.ws.emit('message', Buffer.from([1, 2]), true)
  assert.equal(s.flux.received.length, 1)
  s.flux.endTurn('Alex, please leave.')
  s.ws.emit('message', Buffer.from([3, 4]), true) // while Alex says goodbye
  await sleep(50)
  s.ws.emit('message', Buffer.from([5, 6]), true)
  assert.equal(s.flux.received.length, 1)
  await until(() => s.ended() !== undefined)
})

test('a leave heard in another session of the meeting stops this session sending audio too', async () => {
  const first = setup()
  const second = setup({ meetingKey: first.meetingKey })
  second.flux.endTurn('Alex, please leave.')
  first.ws.emit('message', Buffer.from([1, 2]), true)
  assert.equal(first.flux.received.length, 0)
  await until(() => second.ended() !== undefined)
  first.ws.emit('close')
})

test('a polite leave request after an opener ("No, Alex, could you please leave the meeting?") leaves, and never reaches the fast tier', async () => {
  const s = setup({ leaveDelayMs: 50 })
  s.flux.endTurn('We agreed the pilot starts in March.')
  s.flux.endTurn('No, Alex, could you please leave the meeting?')
  await until(() => s.ended() !== undefined)
  assert.deepEqual(s.answered, [])
  assert.equal(fs.existsSync(s.session.transcript.file), false)
  assert.match(s.ended()?.no_minutes ?? '', /asked to leave/)
})

test('a reassurance that mentions leaving ("Alex, I don\'t think you should leave.") is not a leave request', async () => {
  const s = setup({ reply: () => [{ kind: 'say', text: 'Thanks, I will stay.' }] })
  s.flux.endTurn('Should we ask Alex to leave the meeting?')
  s.flux.endTurn("Alex, I don't think you should leave.")
  await sleep(50)
  assert.equal(s.ended(), undefined)
  assert.equal(fs.existsSync(s.session.transcript.file), true)
  s.done()
})

test('once Alex is asked to leave, nothing more is posted in the meeting chat, from Sam\'s session or anywhere', async () => {
  const posted: string[] = []
  const s = setup({ leaveDelayMs: 100, sendChat: async (_bot, message) => void posted.push(message) })
  assert.equal(await s.session.postChat('Before: the deck is in the shared folder.'), true)
  s.flux.endTurn('Alex, please leave.')
  await sleep(10)
  assert.equal(await s.session.postChat('After: here are the details you asked for.'), false)
  assert.deepEqual(posted, ['Before: the deck is in the shared folder.'])
  await until(() => s.ended() !== undefined)
})

// --- Leave requests in an open window ------------------------------------------------------------------

test('"Alex?" and then "Please leave the meeting." makes Alex leave', async () => {
  const s = setup()
  s.flux.endTurn('Alex?')
  await settle()
  s.flux.endTurn('Please leave the meeting.')
  await until(() => s.ended() !== undefined)
  assert.deepEqual(s.spoken, [LEAVE_LINE])
  assert.deepEqual(s.answered, [], 'the fast tier, which cannot leave, never sees it')
  assert.deepEqual(s.recall.left, [s.botId])
  assert.match(s.ended()!.no_minutes ?? '', /asked to leave/)
  assert.equal(fs.existsSync(s.session.transcript.file), false)
})

test('"No, please leave." in reply to a question from Alex makes him leave', async () => {
  const s = setup({ reply: () => [{ kind: 'say', text: 'Shall I go on?' }] })
  s.flux.endTurn('Alex, how did the pilot go?')
  await settle()
  s.flux.endTurn('No, please leave.')
  await until(() => s.ended() !== undefined)
  assert.deepEqual(s.answered, ['Alex, how did the pilot go?'])
  assert.deepEqual(s.spoken, ['Shall I go on?', LEAVE_LINE])
  assert.match(s.ended()!.no_minutes ?? '', /asked to leave/)
})

test('"Alex? Please leave." in one breath makes Alex leave', async () => {
  const s = setup()
  s.flux.endTurn('Alex? Please leave.')
  await until(() => s.ended() !== undefined)
  assert.deepEqual(s.spoken, [LEAVE_LINE])
  assert.match(s.ended()!.no_minutes ?? '', /asked to leave/)
})

test('without the name, only a plain request said in a window counts: other talk of leaving does not', async () => {
  const s = setup({ reply: () => [{ kind: 'say', text: 'Shall I go on?' }] })
  s.flux.endTurn('Please leave the meeting.') // no window open: said to someone else
  s.flux.endTurn('Alex, how did the pilot go?')
  await settle()
  s.flux.endTurn('Sorry, I have to leave the call now.') // in the window, but not a request to Alex
  await settle()
  assert.deepEqual(s.recall.left, [])
  assert.equal(s.ended(), undefined)
  assert.deepEqual(s.answered, ['Alex, how did the pilot go?', 'Sorry, I have to leave the call now.'])
  assert.ok(fs.existsSync(s.session.transcript.file), 'nothing is deleted')
  s.done()
})

test('the fast tier is told it cannot leave by itself, and how to ask it to', async () => {
  const requests: any[] = []
  const client = {
    messages: {
      stream: (body: any) => {
        requests.push(body)
        return { on() { return this }, finalMessage: async () => ({ content: [], stop_reason: 'end_turn' }) }
      },
    },
  }
  const signal = new AbortController().signal
  for await (const _ of new Brain(client as any).respond({ transcript: '', latest: 'Alex? Can you go?', brief: '', signal })) {
    // Nothing to say: only the request matters here.
  }
  const rules = requests[0].system[0].text as string
  assert.match(rules, /You can't leave the meeting yourself\. If someone wants you gone, tell them to say "Alex, please leave"\./)
  assert.match(rules, /Never say you are leaving\./)
})
