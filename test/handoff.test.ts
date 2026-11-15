import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { MeetingSession } from '../src/pipeline/session.ts'
import { SessionBridge, type SessionAnswer } from '../src/bridge.ts'
import { CHECKING_LINE, CHECKING_LINES, PROGRESS_LINE, SESSION_OFFLINE_LINE } from '../src/consent.ts'
import type { BrainEvent } from '../src/brain/brain.ts'
import { sessionHandlers } from '../src/sessions.ts'

class FakeSocket extends EventEmitter {
  readyState = 1
  sent: (Buffer | string)[] = []
  send(data: Buffer | string) { this.sent.push(data) }
  close() { this.readyState = 3 }
}

class FakeFlux extends EventEmitter {
  closed = false
  send() {}
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

type Ask = (q: { question: string; context: string }) => Promise<SessionAnswer | null>

let meetings = 0

/**
 * A session whose brain hands every question to Sam's session, unless reply says otherwise. It has a
 * meeting key of its own, fakes for Recall and the minutes, and no consent line during the test.
 * spoken lists what Alex started to say, in order.
 */
function setup(opts: {
  ask?: Ask
  reply?: (latest: string) => BrainEvent[]
  speak?: (text: string, signal?: AbortSignal) => AsyncGenerator<Buffer>
  progressAfterMs?: number
  bridge?: SessionBridge
}) {
  const ws = new FakeSocket()
  const flux = new FakeFlux()
  const spoken: string[] = []
  const reply = opts.reply ?? (latest => [{ kind: 'ask_session', question: latest }])
  const meetingKey = `handoff-${process.pid}-${++meetings}`
  const session = new MeetingSession(ws as any, { meetingKey, botId: `bot-${meetingKey}`, platform: 'Zoom' }, {
    brain: { async *respond({ latest }: { latest: string }) { yield* reply(latest) } } as any,
    bridge: opts.bridge ?? ({ ask: opts.ask ?? (async () => ({ spoken: 'Here is the answer.' })), notify: () => {} } as any),
    brief: () => '',
    flux: () => flux as any,
    speak: async function* (text: string, signal?: AbortSignal) {
      spoken.push(text)
      if (opts.speak) yield* opts.speak(text, signal)
      else yield Buffer.from([0, 1])
    },
    recall: {
      sendChat: async () => {},
      leaveCall: async () => {},
      deleteMedia: async () => true,
      howBotEnded: async () => ({ kind: 'ended', sub_code: 'call_ended_by_host' }) as const,
    },
    writeMinutes: async () => Promise.reject(new Error('no minutes in these tests')),
    greetDelayMs: 60_000,
    progressAfterMs: opts.progressAfterMs,
  })
  return { ws, flux, spoken, session }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const settle = () => sleep(30)

/** An answer from Sam's session that comes when the test says so. */
function later() {
  let answer!: (a: SessionAnswer | null) => void
  const asked: string[] = []
  const ask: Ask = q => {
    asked.push(q.question)
    return new Promise(resolve => (answer = resolve))
  }
  return { ask, asked, answer: (a: SessionAnswer | null) => answer(a) }
}

test("the question reaches Sam's session before Alex has finished saying he is checking", async () => {
  let finish!: () => void
  const checking = new Promise<void>(r => (finish = r))
  const asked: string[] = []
  const { flux, spoken, session } = setup({
    ask: async q => (asked.push(q.question), { spoken: 'PR 9 was merged this morning.' }),
    speak: async function* (text) {
      if (text === CHECKING_LINES[0]) await checking
      yield Buffer.from([0, 1])
    },
  })
  flux.endTurn('Alex, what is the status of PR 9?')
  await settle()
  assert.deepEqual(spoken, [CHECKING_LINES[0]], 'Alex is still saying he is checking...')
  assert.deepEqual(asked, ['Alex, what is the status of PR 9?'], '...and the question has already gone')
  finish()
  await settle()
  assert.deepEqual(spoken, [CHECKING_LINES[0], 'PR 9 was merged this morning.'])
  session.transcript.delete()
})

test('Alex takes the checking lines in turn, starting with the first in every session', async () => {
  const first = setup({})
  for (let i = 0; i < CHECKING_LINES.length + 1; i++) {
    first.flux.endTurn(`Alex, can you check item ${i}?`)
    await settle()
  }
  assert.equal(new Set(CHECKING_LINES).size, CHECKING_LINES.length)
  assert.deepEqual(first.spoken.filter(t => CHECKING_LINES.includes(t)), [...CHECKING_LINES, CHECKING_LINES[0]])
  assert.equal(CHECKING_LINE, CHECKING_LINES[0])

  const second = setup({})
  second.flux.endTurn('Alex, can you check the rollout rules?')
  await settle()
  assert.deepEqual(second.spoken, [CHECKING_LINES[0], 'Here is the answer.'])
  first.session.transcript.delete()
  second.session.transcript.delete()
})

test('a slow answer gets one "still checking" line, then the answer', async () => {
  const session = later()
  const { flux, spoken, session: s } = setup({ ask: session.ask, progressAfterMs: 20 })
  flux.endTurn('Alex, can you go deeper on the rollout checks?')
  await sleep(120) // several times progressAfterMs
  assert.deepEqual(spoken, [CHECKING_LINES[0], PROGRESS_LINE], 'said once')
  session.answer({ spoken: 'Here is more on the rollout checks.' })
  await settle()
  assert.deepEqual(spoken, [CHECKING_LINES[0], PROGRESS_LINE, 'Here is more on the rollout checks.'])
  s.transcript.delete()
})

test('a quick answer gets no "still checking" line', async () => {
  const { flux, spoken, session } = setup({
    ask: async () => (await sleep(5), { spoken: 'PR 9 was merged.' }),
    progressAfterMs: 60,
  })
  flux.endTurn('Alex, is PR 9 merged?')
  await sleep(150)
  assert.deepEqual(spoken, [CHECKING_LINES[0], 'PR 9 was merged.'])
  session.transcript.delete()
})

test('no "still checking" line once a new question has stopped the turn that was waiting', async () => {
  const session = later()
  const { flux, spoken, session: s } = setup({
    ask: session.ask,
    reply: latest => (/skip that/.test(latest) ? [{ kind: 'say', text: 'Sure.' }] : [{ kind: 'ask_session', question: latest }]),
    progressAfterMs: 50,
  })
  flux.endTurn('Alex, can you go deeper on the rollout checks?')
  await sleep(10)
  // A new question stops the turn that was waiting, as "Alex, never mind." does (see session-safety.test.ts).
  flux.endTurn('Alex, can you skip that and tell us the timeline?')
  await sleep(150)
  assert.deepEqual(spoken, [CHECKING_LINES[0], 'Sure.'])
  session.answer({ spoken: 'Here is more on the rollout checks.' })
  await settle()
  assert.deepEqual(spoken, [CHECKING_LINES[0], 'Sure.'], 'a late answer to a stopped turn is not spoken either')
  s.transcript.delete()
})

test('no "still checking" line when Alex was talked over while saying he is checking', async () => {
  const session = later()
  const slow = async function* (_text: string, signal?: AbortSignal) {
    for (let i = 0; i < 20 && !signal?.aborted; i++) {
      yield Buffer.from([0, 0])
      await sleep(10)
    }
  }
  const { flux, ws, spoken, session: s } = setup({ ask: session.ask, speak: slow, progressAfterMs: 40 })
  flux.endTurn('Alex, can you go deeper on the rollout checks?')
  await sleep(25)
  flux.startTurn()
  await sleep(150)
  assert.equal(session.asked.length, 1, 'the question had already gone')
  assert.ok(ws.sent.some(d => typeof d === 'string' && JSON.parse(d).type === 'clear'))
  assert.deepEqual(spoken, [CHECKING_LINES[0]])
  session.answer({ spoken: 'Here is more on the rollout checks.' })
  await settle()
  assert.deepEqual(spoken, [CHECKING_LINES[0]])
  s.transcript.delete()
})

test('no "still checking" line once the page has gone', async () => {
  const session = later()
  const { flux, spoken, session: s } = setup({ ask: session.ask, progressAfterMs: 40 })
  flux.endTurn('Alex, can you go deeper on the rollout checks?')
  await sleep(10)
  s.end()
  await sleep(120)
  session.answer({ spoken: 'Here is more on the rollout checks.' })
  await settle()
  assert.deepEqual(spoken, [CHECKING_LINES[0]])
  s.transcript.delete()
})

test('with no session linked, Alex still says he is checking, then that he cannot reach the notes', async () => {
  const bridge = new SessionBridge({ transcript: () => '', postChat: async () => ({ ok: false }), setBrief: () => {}, joinMeeting: async () => ({ note: '' }) })
  const { flux, spoken, session } = setup({ bridge, progressAfterMs: 20 })
  flux.endTurn('Alex, what is the status of PR 9?')
  await sleep(80)
  assert.deepEqual(spoken, [CHECKING_LINE, SESSION_OFFLINE_LINE])
  session.transcript.delete()
})

// --- The meeting moves on before Sam's session answers -----------------------------------------------

/**
 * The real bridge, wired to the live sessions as server.ts wires them (src/sessions.ts), with a linked
 * channel server. reply() answers the question it was sent and resolves with the bridge's acknowledgement,
 * which is what the reply tool tells Sam's session.
 */
function linkedBridge() {
  const sessions = new Set<MeetingSession>()
  const bridge = new SessionBridge({ ...sessionHandlers(sessions), setBrief: () => {}, joinMeeting: async () => ({ note: '' }) })
  const channel = new FakeSocket()
  bridge.attach(channel as any)
  channel.emit('message', Buffer.from(JSON.stringify({ type: 'claim' })))
  const fromBridge = () => channel.sent.map(d => JSON.parse(String(d)))
  const reply = async (answer: SessionAnswer) => {
    const question = fromBridge().find(m => m.type === 'question')
    channel.emit('message', Buffer.from(JSON.stringify({ type: 'reply', id: question.id, request_id: 'r1', ...answer })))
    await settle()
    const { type: _type, request_id: _id, ...ack } = fromBridge().find(m => m.type === 'ack')
    return ack
  }
  return { bridge, sessions, reply }
}

/** Alex's voice, a piece every 10 ms for 200 ms, so he is still saying he is checking when the meeting moves on. */
const slowly = async function* (_text: string, signal?: AbortSignal) {
  for (let i = 0; i < 20 && !signal?.aborted; i++) {
    yield Buffer.from([0, 0])
    await sleep(10)
  }
}

const movedOn: [string, (s: ReturnType<typeof setup>, sessions: Set<MeetingSession>) => void, { kept: boolean; note?: string }][] = [
  ['Alex is talked over', s => s.flux.startTurn(), { kept: true }],
  ['someone says "Alex, never mind"', s => s.flux.endTurn('Alex, never mind.'), { kept: true }],
  ['someone asks Alex something else', s => s.flux.endTurn('Alex, what time is it?'), { kept: true }],
  ['someone asks Alex to leave', s => s.flux.endTurn('Alex, please leave.'), { kept: false, note: 'Alex has been asked to leave this meeting' }],
  [
    'the page goes',
    (s, sessions) => {
      s.ws.emit('close')
      sessions.delete(s.session) // as server.ts does when a page closes
    },
    { kept: false, note: 'Alex is no longer in that meeting' },
  ],
]

for (const [what, moveOn, outcome] of movedOn) {
  test(`when ${what} before Sam's session answers, Alex stops waiting at once, and the reply hears he will not say it`, async () => {
    const owner = linkedBridge()
    const s = setup({
      bridge: owner.bridge,
      speak: slowly,
      progressAfterMs: 60_000,
      reply: latest => (/time/.test(latest) ? [{ kind: 'say', text: 'It is ten past three.' }] : [{ kind: 'ask_session', question: latest }]),
    })
    owner.sessions.add(s.session)
    s.flux.endTurn('Alex, can you go deeper on the rollout checks?')
    await sleep(25) // the question has gone, and Alex is still saying he is checking
    moveOn(s, owner.sessions)
    await settle()
    const ack = await owner.reply({ spoken: 'Here is more on the rollout checks.' })
    assert.deepEqual(ack, { ok: false, late: true, why: 'stopped', ...outcome })
    await settle()
    assert.equal(s.spoken.includes('Here is more on the rollout checks.'), false, 'not said')
    s.session.transcript.delete()
  })
}
