import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { WebSocketServer, WebSocket } from 'ws'
import { BriefAdditions, MAX_ADDITIONS_CHARS } from '../src/brain/additions.ts'
import { ADDITIONS_HEADING, Brain, type BrainEvent } from '../src/brain/brain.ts'
import { LEFT_NOTE, SessionBridge, type BridgeHandlers, type SessionAnswer, type ToSession } from '../src/bridge.ts'
import { SESSION_OFFLINE_LINE } from '../src/consent.ts'
import { MeetingSession } from '../src/pipeline/session.ts'
import type { BotEnding } from '../src/recall.ts'
import { lateAnswerText, sessionHandlers } from '../src/sessions.ts'

// --- What the additions hold ------------------------------------------------------------------------

test('additions are kept in the order added, as a bullet list, and empty text is ignored', () => {
  const additions = new BriefAdditions()
  assert.equal(additions.text(), '')
  assert.deepEqual(additions.add('  The pilot starts on 3 March.  '), { added: true, dropped: 0 })
  assert.deepEqual(additions.add('   '), { added: false, dropped: 0 })
  assert.deepEqual(additions.add('Steps:\n1. Plan\n2. Ship'), { added: true, dropped: 0 })
  assert.equal(additions.size, 2)
  assert.equal(additions.text(), '- The pilot starts on 3 March.\n- Steps:\n  1. Plan\n  2. Ship')
})

test('past the cap the oldest additions go first, and the count of those dropped is reported', () => {
  const additions = new BriefAdditions()
  const quarter = (c: string) => c.repeat(MAX_ADDITIONS_CHARS / 4)
  for (const c of 'abcd') assert.deepEqual(additions.add(quarter(c)), { added: true, dropped: 0 })
  assert.deepEqual(additions.add('e'), { added: true, dropped: 1 }, 'the oldest goes to make room')
  assert.ok(!additions.text().includes('a'))
  assert.deepEqual(additions.add('f'.repeat(MAX_ADDITIONS_CHARS / 2)), { added: true, dropped: 2 })
  assert.equal(additions.size, 3)
  assert.match(additions.text(), /^- d+\n- e\n- f+$/)
})

test('an addition longer than the cap on its own is cut to it, and replaces everything before it', () => {
  const additions = new BriefAdditions()
  additions.add('The pilot starts on 3 March.')
  assert.deepEqual(additions.add('x'.repeat(MAX_ADDITIONS_CHARS + 500)), { added: true, dropped: 1 })
  assert.equal(additions.size, 1)
  assert.equal(additions.text(), `- ${'x'.repeat(MAX_ADDITIONS_CHARS)}`)
})

test('clearing the additions leaves nothing', () => {
  const additions = new BriefAdditions()
  additions.add('The pilot starts on 3 March.')
  additions.clear()
  assert.equal(additions.size, 0)
  assert.equal(additions.text(), '')
  assert.deepEqual(additions.add('Again.'), { added: true, dropped: 0 })
})

// --- The fast tier's request --------------------------------------------------------------------------

/** A stand-in for the Anthropic client: keeps each request and streams back one short answer. */
function fakeClaude(reply = 'It starts on 3 March.') {
  const requests: any[] = []
  const client = {
    messages: {
      stream: (body: any) => {
        requests.push(body)
        let onText: (delta: string) => void = () => {}
        return {
          on(event: string, listener: (delta: string) => void) {
            if (event === 'text') onText = listener
            return this
          },
          finalMessage: async () => {
            onText(reply)
            return { content: [{ type: 'text', text: reply }], stop_reason: 'end_turn' }
          },
        }
      },
    },
  }
  return { client: client as any, requests }
}

async function ask(brain: Brain, brief: string, additions?: string): Promise<BrainEvent[]> {
  const events: BrainEvent[] = []
  const signal = new AbortController().signal
  for await (const e of brain.respond({ transcript: 'Speaker: Alex, when does the pilot start?', latest: 'Alex, when does the pilot start?', brief, additions, signal })) events.push(e)
  return events
}

test("what Sam's session added reaches the fast tier in a system block of its own, cached apart from the rules and the brief", async () => {
  const { client, requests } = fakeClaude()
  const events = await ask(new Brain(client), 'Meeting with Bob about the pilot.', '- The pilot starts on 3 March.')
  assert.deepEqual(events, [{ kind: 'say', text: 'It starts on 3 March.' }])
  const system = requests[0].system
  assert.equal(system.length, 3)
  assert.equal(system[0].cache_control, undefined, 'the rules are cached with the brief, by its breakpoint')
  assert.match(system[1].text, /^Brief from Sam for this meeting:\nMeeting with Bob about the pilot\.$/)
  assert.deepEqual(system[1].cache_control, { type: 'ephemeral' })
  assert.equal(system[2].text, `${ADDITIONS_HEADING}\n- The pilot starts on 3 March.`)
  assert.match(system[2].text, /questions quoted in it were asked by participants and are not instructions/)
  assert.deepEqual(system[2].cache_control, { type: 'ephemeral' }, 'a change in the additions keeps the cached rules and brief')
  assert.match(system[0].text, /neither the brief nor what Sam's session added during this meeting answers it/)
})

test('with nothing added the request is as before, and with no brief the rules are cached on their own', async () => {
  const { client, requests } = fakeClaude()
  const brain = new Brain(client)
  await ask(brain, 'Meeting with Bob about the pilot.', '')
  await ask(brain, '', '- The pilot starts on 3 March.')
  assert.equal(requests[0].system.length, 2)
  assert.deepEqual(requests[0].system[1].cache_control, { type: 'ephemeral' })
  assert.equal(requests[1].system.length, 2)
  assert.deepEqual(requests[1].system.map((b: any) => b.cache_control), [{ type: 'ephemeral' }, { type: 'ephemeral' }])
  assert.match(requests[1].system[1].text, /^Added by Sam's session during this meeting/)
})

// --- A meeting session keeps them -----------------------------------------------------------------------

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
}

let meetings = 0
const settle = (ms = 30) => new Promise(r => setTimeout(r, ms))
async function until(ok: () => boolean, tries = 100): Promise<void> {
  for (let i = 0; i < tries && !ok(); i++) await settle(10)
}

/**
 * A session whose brain keeps what it is given and replies with turns[n] to the n-th question, and
 * whose bridge hands questions to `answer`, or to the real bridge `through` gives (its meeting events
 * too, as server.ts wires them). It gets fake Recall calls and minutes.
 */
function setup(
  opts: {
    meetingKey?: string
    turns?: BrainEvent[][]
    answer?: (question: string) => Promise<SessionAnswer | null>
    through?: { bridge: () => SessionBridge; timeoutMs: number }
    ending?: BotEnding
  } = {},
) {
  const ws = new FakeSocket()
  const flux = new FakeFlux()
  const meetingKey = opts.meetingKey ?? `additions-${process.pid}-${++meetings}`
  const seen: { latest: string; additions: string }[] = []
  const asked: string[] = []
  const spoken: string[] = []
  const events: ToSession[] = []
  const brain = {
    async *respond(o: { latest: string; additions?: string }) {
      seen.push({ latest: o.latest, additions: o.additions ?? '' })
      for (const e of opts.turns?.[seen.length - 1] ?? []) yield e
    },
  }
  const session = new MeetingSession(ws as any, { meetingKey, botId: `bot-${meetingKey}`, platform: 'Zoom' }, {
    brain: brain as any,
    bridge: {
      notify: (m: ToSession) => {
        events.push(m)
        opts.through?.bridge().notify(m)
      },
      ask: async (q: Parameters<SessionBridge['ask']>[0], _timeoutMs?: number, signal?: AbortSignal) => {
        asked.push(q.question)
        if (opts.through) return opts.through.bridge().ask(q, opts.through.timeoutMs, signal)
        return opts.answer ? opts.answer(q.question) : null
      },
    } as any,
    brief: () => 'Meeting with Bob about the pilot.',
    flux: () => flux as any,
    speak: async function* (text: string) {
      spoken.push(text)
      yield Buffer.from([0, 1])
    },
    recall: {
      sendChat: async () => {},
      leaveCall: async () => {},
      deleteMedia: async () => true,
      howBotEnded: async () => opts.ending ?? { kind: 'ended', sub_code: 'call_ended_by_host' },
    },
    writeMinutes: async () => Promise.reject(new Error('no minutes in these tests')),
    leaveDelayMs: 0,
    greetDelayMs: 60_000,
    sttFlushMs: 20,
  })
  const ended = () => events.find(e => e.type === 'meeting_ended')
  // Private on purpose: nothing outside the session reads them. The tests look, to see they are gone.
  const additions = () => (session as any).additions as BriefAdditions
  const done = () => {
    ws.emit('close')
    session.transcript.delete()
  }
  return { ws, flux, meetingKey, session, seen, asked, spoken, ended, additions, done }
}

const STEPS: SessionAnswer = { spoken: 'There are three steps; the list is in the chat.', detail: '1. Plan\n2. Build\n3. Ship' }

test("an answer from Sam's session is kept, chat detail included, and the next question is answered from it", async () => {
  const s = setup({
    turns: [[{ kind: 'ask_session', question: 'What are the rollout steps?' }], [{ kind: 'say', text: 'The third step is to ship.' }]],
    answer: async () => STEPS,
  })
  s.flux.endTurn('Alex, what are the rollout steps?')
  await until(() => s.spoken.includes(STEPS.spoken))
  s.flux.endTurn('Alex, what was the third step again?')
  await until(() => s.spoken.includes('The third step is to ship.'))
  assert.equal(s.seen[0].additions, '')
  assert.equal(
    s.seen[1].additions,
    "- Sam's session answered \"What are the rollout steps?\": There are three steps; the list is in the chat. (with this detail for the meeting chat: 1. Plan\n  2. Build\n  3. Ship)",
  )
  assert.deepEqual(s.asked, ['What are the rollout steps?'], 'the follow-up is not handed off again')
  assert.doesNotMatch(s.session.transcript.recent(), /3\. Ship/, 'only the spoken part is in the transcript')
  s.done()
})

test('an answer that arrives after a new question cut off the hand-off is still kept, once, though it was never said', async () => {
  const sessions = new Set<MeetingSession>()
  const w = await wired(sessions)
  const s = meetingThrough(
    () => w.bridge,
    [[{ kind: 'ask_session', question: 'What are the rollout steps?' }], [{ kind: 'say', text: 'It is ten past three.' }], []],
    60_000,
  )
  sessions.add(s.session)
  s.flux.endTurn('Alex, what are the rollout steps?')
  await until(() => w.questions().length === 1)
  s.flux.endTurn('Alex, never mind, what time is it?') // cuts off the reply still waiting for the session
  await until(() => s.spoken.includes('It is ten past three.'))
  // The bridge stopped waiting with the turn, so Sam's session hears that Alex won't say it.
  assert.deepEqual(await w.reply('r1', w.questions()[0].id, STEPS), { type: 'ack', request_id: 'r1', ok: false, late: true, why: 'stopped', kept: true })
  await settle()
  assert.equal(s.spoken.includes(STEPS.spoken), false, 'the cut-off reply is not said')
  s.flux.endTurn('Alex, so what were the steps?')
  await until(() => s.seen.length === 3)
  assert.equal(s.seen[2].additions, `- ${lateAnswerText('What are the rollout steps?', STEPS).replace(/\n/g, '\n  ')}`, 'kept once, as unheard')
  w.close()
  s.done()
})

test("what Sam's session adds with add_to_brief reaches the fast tier from the next question", async () => {
  const s = setup()
  assert.deepEqual(s.session.addToBrief('  The pilot starts on 3 March.  '), { ok: true })
  assert.deepEqual(s.session.addToBrief('   '), { ok: false, note: 'there was nothing to add' })
  s.flux.endTurn('Alex, when does the pilot start?')
  await until(() => s.seen.length === 1)
  assert.equal(s.seen[0].additions, '- The pilot starts on 3 March.')
  // Past the cap, the session hears that older additions were dropped.
  const r = s.session.addToBrief('x'.repeat(MAX_ADDITIONS_CHARS))
  assert.equal(r.ok, true)
  assert.match(r.note ?? '', /^1 older addition was dropped/)
  s.done()
  assert.deepEqual(s.session.addToBrief('Too late.'), { ok: false, note: 'Alex is no longer in this meeting' })
})

test('after "Alex, please leave" nothing is added, what was added is gone, and an answer arriving later is not kept', async () => {
  let release!: (a: SessionAnswer) => void
  const s = setup({ turns: [[{ kind: 'ask_session', question: 'What are the rollout steps?' }]], answer: () => new Promise(r => (release = r)) })
  s.session.addToBrief('The pilot starts on 3 March.')
  s.flux.endTurn('Alex, what are the rollout steps?')
  await until(() => s.asked.length === 1)
  s.flux.endTurn('Alex, please leave.')
  assert.equal(s.additions().size, 0, 'nothing of the meeting is kept, in memory either, from the moment of the request')
  await until(() => s.ended() !== undefined)
  release(STEPS)
  await settle()
  assert.equal(s.additions().size, 0)
  assert.deepEqual(s.session.addToBrief('More facts.'), { ok: false, note: 'Alex has been asked to leave this meeting' })
  assert.equal(s.additions().size, 0)
})

test('removed by the host: the additions go too, and nothing more is added', async () => {
  const s = setup({ ending: { kind: 'removed', sub_code: 'bot_kicked_from_call' } })
  s.flux.endTurn('We agreed the pilot starts in March.')
  s.session.addToBrief('The pilot starts on 3 March.')
  s.ws.emit('close')
  await until(() => s.ended() !== undefined)
  assert.equal(s.additions().size, 0)
  assert.deepEqual(s.session.addToBrief('More facts.'), { ok: false, note: 'Alex has been removed from this meeting' })
})

test('two sessions of one meeting share the additions, and a leave in either clears them for both', async () => {
  const first = setup()
  const second = setup({ meetingKey: first.meetingKey }) // the page reconnected
  assert.deepEqual(first.session.addToBrief('The pilot starts on 3 March.'), { ok: true })
  second.flux.endTurn('Alex, when does the pilot start?')
  await until(() => second.seen.length === 1)
  assert.equal(second.seen[0].additions, '- The pilot starts on 3 March.')

  second.flux.endTurn('Alex, please leave.')
  await until(() => second.ended() !== undefined)
  assert.equal(first.additions().size, 0)
  assert.deepEqual(first.session.addToBrief('More facts.'), { ok: false, note: 'Alex has been asked to leave this meeting' })
  first.done()
})

test("a page that reconnects keeps the additions, and they go with the meeting's last session", async () => {
  const first = setup()
  first.session.addToBrief('The pilot starts on 3 March.')
  const second = setup({ meetingKey: first.meetingKey })
  first.ws.emit('close') // the first page dropped; the second is still in the meeting
  await until(() => first.ended() !== undefined)
  second.flux.endTurn('Alex, when does the pilot start?')
  await until(() => second.seen.length === 1)
  assert.equal(second.seen[0].additions, '- The pilot starts on 3 March.')
  second.ws.emit('close') // the meeting is over
  await until(() => second.ended() !== undefined)
  assert.equal(second.additions().size, 0)
  first.session.transcript.delete()
  second.session.transcript.delete()
})

// --- The bridge ------------------------------------------------------------------------------------------

function serve(handlers: Partial<BridgeHandlers>) {
  const bridge = new SessionBridge({ transcript: () => 'Speaker: hi', postChat: async () => ({ ok: true }), setBrief: () => {}, joinMeeting: async () => ({ note: '' }), ...handlers })
  const wss = new WebSocketServer({ port: 0 })
  wss.on('connection', ws => bridge.attach(ws))
  return { bridge, wss, port: (wss.address() as { port: number }).port }
}

/** A fake channel server: links and keeps what it receives. */
async function link(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const got: any[] = []
  ws.on('message', raw => got.push(JSON.parse(raw.toString())))
  await new Promise(r => ws.on('open', r))
  const send = (msg: object) => ws.send(JSON.stringify(msg))
  return { ws, got, send }
}

test('add_to_brief is acknowledged with the result, to the session that sent it, and does not take the questions', async () => {
  const added: { text: string; meeting?: string }[] = []
  const { bridge, wss, port } = serve({
    addToBrief: (text, meeting) => {
      added.push({ text, meeting })
      return text === 'refuse' ? { ok: false, note: 'Alex has been asked to leave this meeting' } : { ok: true, note: '1 older addition was dropped.' }
    },
  })
  const a = await link(port)
  const b = await link(port)
  a.send({ type: 'claim', at: Date.now() - 60_000 })
  await settle(50)
  b.send({ type: 'add_to_brief', request_id: 'b1', text: 'The pilot starts on 3 March.', meeting: 'k1' })
  b.send({ type: 'add_to_brief', request_id: 'b2', text: 'refuse' })
  await settle(50)
  assert.deepEqual(added, [{ text: 'The pilot starts on 3 March.', meeting: 'k1' }, { text: 'refuse', meeting: undefined }])
  assert.deepEqual(b.got, [
    { type: 'ack', request_id: 'b1', ok: true, note: '1 older addition was dropped.' },
    { type: 'ack', request_id: 'b2', ok: false, note: 'Alex has been asked to leave this meeting' },
  ])
  void bridge.ask({ question: 'status?', asked_by: 'p', meeting: 'm', context: '' }, 200)
  await settle(50)
  assert.equal(a.got.filter(m => m.type === 'question').length, 1, 'the questions stay with the session that claimed them')
  assert.equal(b.got.filter(m => m.type === 'question').length, 0)
  a.ws.close()
  b.ws.close()
  wss.close()
})

// The voice service's own handler, with no meeting to add to, is tested in sessions.test.ts.
test('add_to_brief is refused when the bridge was given no way to add to the brief', async () => {
  const { wss, port } = serve({})
  const a = await link(port)
  a.send({ type: 'add_to_brief', request_id: 'a1', text: 'The pilot starts on 3 March.' })
  await until(() => a.got.length > 0)
  assert.deepEqual(a.got, [{ type: 'ack', request_id: 'a1', ok: false, note: 'Alex is not in a meeting right now' }])
  a.ws.close()
  wss.close()
})

test("get_transcript's max_chars is passed on, kept between 500 and 60,000", async () => {
  const asked: (number | undefined)[] = []
  const { wss, port } = serve({ transcript: maxChars => (asked.push(maxChars), 'Speaker: hi') })
  const a = await link(port)
  const requests: unknown[] = [undefined, 3000, 10, 1e9, 'lots', 2500.4]
  requests.forEach((max_chars, i) => a.send({ type: 'get_transcript', request_id: `t${i}`, max_chars }))
  await until(() => a.got.length === requests.length)
  assert.deepEqual(asked, [undefined, 3000, 500, 60_000, undefined, 2500])
  assert.deepEqual(a.got[1], { type: 'transcript', request_id: 't1', text: 'Speaker: hi' })
  a.ws.close()
  wss.close()
})

test("get_transcript's meeting key is passed on, and left out when none is given", async () => {
  const asked: (string | undefined)[] = []
  const { wss, port } = serve({ transcript: (_maxChars, meeting) => (asked.push(meeting), 'Speaker: hi') })
  const a = await link(port)
  a.send({ type: 'get_transcript', request_id: 't0', max_chars: 3000, meeting: 'k1' })
  a.send({ type: 'get_transcript', request_id: 't1' })
  a.send({ type: 'get_transcript', request_id: 't2', meeting: 42 })
  await until(() => a.got.length === 3)
  assert.deepEqual(asked, ['k1', undefined, undefined])
  a.ws.close()
  wss.close()
})

// --- From the bridge to the meeting, as the voice service wires them (src/sessions.ts) ---------------------

/** A real bridge over these sessions, as server.ts makes it, and a fake channel server linked to it. */
async function wired(sessions: Set<MeetingSession>) {
  const bridge = new SessionBridge({ ...sessionHandlers(sessions), setBrief: () => {}, joinMeeting: async () => ({ note: '' }) })
  const wss = new WebSocketServer({ port: 0 })
  wss.on('connection', ws => bridge.attach(ws))
  const channel = await link((wss.address() as { port: number }).port)
  channel.send({ type: 'claim' })
  await settle()
  const reply = async (requestId: string, id: string, answer: SessionAnswer) => {
    channel.send({ type: 'reply', request_id: requestId, id, ...answer })
    await until(() => channel.got.some(m => m.type === 'ack' && m.request_id === requestId))
    return channel.got.find(m => m.type === 'ack' && m.request_id === requestId)
  }
  const questions = () => channel.got.filter(m => m.type === 'question')
  return { bridge, reply, questions, close: () => (channel.ws.close(), wss.close()) }
}

/**
 * A bot meeting whose hand-offs and events go through `bridge`, which gives up after timeoutMs (100 ms by
 * default) as the real one does after 60 s.
 */
function meetingThrough(bridge: () => SessionBridge, turns: BrainEvent[][], timeoutMs = 100) {
  const meetingKey = `wired-${process.pid}-${++meetings}`
  return setup({ meetingKey, turns, through: { bridge, timeoutMs } })
}

test("an answer after Alex stopped waiting is kept with the meeting's additions, and the next question is answered from it", async () => {
  const sessions = new Set<MeetingSession>()
  const w = await wired(sessions)
  const s = meetingThrough(() => w.bridge, [[{ kind: 'ask_session', question: 'What are the rollout steps?' }], []])
  sessions.add(s.session)
  s.flux.endTurn('Alex, what are the rollout steps?')
  await until(() => s.spoken.includes(SESSION_OFFLINE_LINE))
  assert.deepEqual(await w.reply('r1', w.questions()[0].id, STEPS), { type: 'ack', request_id: 'r1', ok: false, late: true, why: 'timeout', kept: true })
  assert.equal(s.spoken.includes(STEPS.spoken), false, 'not said: the meeting has moved on')
  s.flux.endTurn('Alex, so what were the steps?')
  await until(() => s.seen.length === 2)
  assert.equal(s.seen[1].additions, `- ${lateAnswerText('What are the rollout steps?', STEPS).replace(/\n/g, '\n  ')}`)
  w.close()
  s.done()
})

test('a late answer is not kept after "Alex, please leave", nor once the meeting has ended', async () => {
  const sessions = new Set<MeetingSession>()
  const w = await wired(sessions)
  const left = meetingThrough(() => w.bridge, [[{ kind: 'ask_session', question: 'What are the rollout steps?' }]])
  const over = meetingThrough(() => w.bridge, [[{ kind: 'ask_session', question: 'What does it cost?' }]])
  sessions.add(left.session)
  sessions.add(over.session)

  left.flux.endTurn('Alex, what are the rollout steps?')
  over.flux.endTurn('Alex, what does it cost?')
  await until(() => left.spoken.includes(SESSION_OFFLINE_LINE) && over.spoken.includes(SESSION_OFFLINE_LINE))
  const [forLeft, forOver] = w.questions().map(q => q.id)

  left.flux.endTurn('Alex, please leave.')
  await until(() => left.ended() !== undefined)
  // Its meeting_ended (transcript deleted) has reached the bridge, which forgot the question's words.
  assert.deepEqual(await w.reply('r1', forLeft, STEPS), {
    type: 'ack',
    request_id: 'r1',
    ok: false,
    late: true,
    why: 'timeout',
    kept: false,
    note: LEFT_NOTE,
  })
  assert.equal(left.additions().size, 0, 'nothing of the meeting is kept')

  // The meeting ends: its page closes, and the voice service drops the session (server.ts does it on close).
  over.ws.emit('close')
  sessions.delete(over.session)
  await until(() => over.ended() !== undefined)
  const late = await w.reply('r2', forOver, { spoken: 'It is free.' })
  assert.equal(late.kept, false)
  assert.equal(late.note, 'Alex is no longer in that meeting')
  assert.equal(over.additions().size, 0)
  w.close()
  over.session.transcript.delete()
})
