import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer, WebSocket } from 'ws'
import { LATE_QUESTIONS_KEPT, LEFT_NOTE, SessionBridge, type SessionAnswer } from '../src/bridge.ts'

test('a question reaches the session and its reply comes back', async () => {
  const wss = new WebSocketServer({ port: 0 })
  const bridge = new SessionBridge({ transcript: () => 'Speaker: hi', postChat: async () => ({ ok: true }), setBrief: () => {}, joinMeeting: async () => ({ note: '' }) })
  wss.on('connection', ws => bridge.attach(ws))
  const port = (wss.address() as { port: number }).port

  const client = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise(r => client.on('open', r))
  client.on('message', raw => {
    const msg = JSON.parse(raw.toString())
    if (msg.type === 'question') client.send(JSON.stringify({ type: 'reply', id: msg.id, spoken: `Answer to: ${msg.question}`, detail: 'more' }))
    if (msg.type === 'transcript') client.emit('transcript', msg.text)
  })
  await new Promise(r => setTimeout(r, 50))

  const answer = await bridge.ask({ question: 'status?', asked_by: 'p', meeting: 'm', context: '' }, 2000)
  assert.deepEqual(answer, { spoken: 'Answer to: status?', detail: 'more' })

  const transcript = new Promise(r => client.once('transcript', r))
  client.send(JSON.stringify({ type: 'get_transcript', request_id: 'r1' }))
  assert.equal(await transcript, 'Speaker: hi')

  client.close()
  wss.close()
})

// --- Several linked sessions ----------------------------------------------------
const quiet = () => ({ transcript: () => 'Speaker: hi', postChat: async () => ({ ok: true }), setBrief: () => {}, joinMeeting: async () => ({ note: 'joining', meeting: 'k1' }) })
const settle = (ms = 50) => new Promise(r => setTimeout(r, ms))
const question = { question: 'status?', asked_by: 'p', meeting: 'm', context: '' }

function serve(bridge: SessionBridge) {
  const wss = new WebSocketServer({ port: 0 })
  wss.on('connection', ws => bridge.attach(ws))
  return { wss, port: (wss.address() as { port: number }).port }
}

/** A fake channel server: links, says hello, and keeps what it receives. */
async function link(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const got: any[] = []
  ws.on('message', raw => got.push(JSON.parse(raw.toString())))
  await new Promise(r => ws.on('open', r))
  ws.send(JSON.stringify({ type: 'hello' }))
  await settle()
  const send = (msg: object) => ws.send(JSON.stringify(msg))
  const questions = () => got.filter(m => m.type === 'question')
  return { ws, got, send, questions }
}

test('several sessions stay linked, and the one that claims gets the questions', async () => {
  const bridge = new SessionBridge(quiet())
  const { wss, port } = serve(bridge)
  const a = await link(port)
  const b = await link(port)
  assert.equal(a.ws.readyState, WebSocket.OPEN)
  assert.equal(b.ws.readyState, WebSocket.OPEN)
  assert.equal(bridge.connected, true)

  a.send({ type: 'claim' })
  await settle()
  const answer = bridge.ask(question, 2000)
  bridge.notify({ type: 'meeting_started', meeting: 'm' })
  await settle()
  assert.equal(a.questions().length, 1)
  assert.equal(b.got.length, 0, 'the idle session hears nothing')
  a.send({ type: 'reply', id: a.questions()[0].id, spoken: 'From a.' })
  assert.deepEqual(await answer, { spoken: 'From a.', detail: undefined })

  a.ws.close()
  b.ws.close()
  wss.close()
})

test('reading the transcript, saving the brief or posting in the chat does not take the questions', async () => {
  const bridge = new SessionBridge(quiet())
  const { wss, port } = serve(bridge)
  const a = await link(port)
  const b = await link(port)
  a.send({ type: 'claim', at: Date.now() - 60_000 }) // a used a tool a minute ago
  await settle()
  b.send({ type: 'get_transcript', request_id: 't1' })
  b.send({ type: 'set_brief', request_id: 's1', markdown: '# brief' })
  b.send({ type: 'post_chat', request_id: 'p1', message: 'hi' })
  await settle()
  void bridge.ask(question, 200)
  await settle()
  assert.deepEqual([a.questions().length, b.questions().length], [1, 0])

  // join_meeting and reply do: the session that sends Alex into a meeting gets its questions.
  b.send({ type: 'join_meeting', request_id: 'j1', meeting_url: 'https://zoom.us/j/1' })
  await settle()
  assert.deepEqual(b.got.find(m => m.type === 'ack' && m.request_id === 'j1'), { type: 'ack', request_id: 'j1', ok: true, note: 'joining', meeting: 'k1' })
  void bridge.ask(question, 200)
  await settle()
  assert.deepEqual([a.questions().length, b.questions().length], [1, 1])

  a.send({ type: 'reply', id: 'nothing-pending', spoken: 'x' })
  await settle()
  void bridge.ask(question, 200)
  await settle()
  assert.deepEqual([a.questions().length, b.questions().length], [2, 1])

  a.ws.close()
  b.ws.close()
  wss.close()
})

test('after a restart, the session that used the service last gets the questions, whichever order they relink in', async () => {
  for (const order of [['x', 'y'], ['y', 'x']] as const) {
    const bridge = new SessionBridge(quiet())
    const { wss, port } = serve(bridge)
    const now = Date.now()
    // y used next_question a minute ago; x only set the brief long before (an old claim).
    const at = { x: now - 600_000, y: now - 60_000 }
    const s: Record<string, Awaited<ReturnType<typeof link>>> = {}
    for (const name of order) {
      s[name] = await link(port)
      s[name].send({ type: 'claim', at: at[name] })
      await settle(20)
    }
    void bridge.ask(question, 200)
    await settle()
    assert.deepEqual([s.x.questions().length, s.y.questions().length], [0, 1], `relinked in the order ${order.join(', ')}`)
    s.x.ws.close()
    s.y.ws.close()
    wss.close()
  }
})

test('a claim cannot be dated in the future', async () => {
  const bridge = new SessionBridge(quiet())
  const { wss, port } = serve(bridge)
  const a = await link(port)
  const b = await link(port)
  a.send({ type: 'claim', at: Date.now() + 3_600_000 })
  await settle(20)
  b.send({ type: 'claim' }) // now, which is later than a's claim once capped at its arrival
  await settle()
  void bridge.ask(question, 200)
  await settle()
  assert.deepEqual([a.questions().length, b.questions().length], [0, 1])
  a.ws.close()
  b.ws.close()
  wss.close()
})

test("a session whose meeting-assistant is waiting keeps the questions until its hold ends", async () => {
  const bridge = new SessionBridge(quiet())
  const { wss, port } = serve(bridge)
  const y = await link(port)
  const x = await link(port)
  y.send({ type: 'claim', at: Date.now() - 1000, hold_until: Date.now() + 300 })
  await settle(20)
  x.send({ type: 'claim' }) // a later claim from another session, without an assistant
  await settle()
  void bridge.ask(question, 200)
  await settle()
  assert.deepEqual([y.questions().length, x.questions().length], [1, 0], 'the waiting assistant keeps them')

  await settle(300) // y's hold has ended
  void bridge.ask(question, 200)
  await settle()
  assert.deepEqual([y.questions().length, x.questions().length], [1, 1], 'then the latest claim wins')
  y.ws.close()
  x.ws.close()
  wss.close()
})

test('an answer to a request goes back to the session that made it', async () => {
  const bridge = new SessionBridge({ ...quiet(), postChat: async () => (await settle(100), { ok: true }) })
  const { wss, port } = serve(bridge)
  const a = await link(port)
  const b = await link(port)
  b.send({ type: 'post_chat', request_id: 'p1', message: 'hello' })
  await settle(20)
  a.send({ type: 'claim' }) // a becomes active before b's chat is acknowledged
  await settle(200)
  assert.deepEqual(b.got, [{ type: 'ack', request_id: 'p1', ok: true }])
  assert.deepEqual(a.got, [])
  a.ws.close()
  b.ws.close()
  wss.close()
})

test('a reply from another session than the one asked still answers the question', async () => {
  const bridge = new SessionBridge(quiet())
  const { wss, port } = serve(bridge)
  const a = await link(port)
  const b = await link(port)
  a.send({ type: 'claim' })
  await settle()
  const answer = bridge.ask(question, 2000)
  await settle()
  assert.equal(b.questions().length, 0)
  b.send({ type: 'reply', id: a.questions()[0].id, spoken: 'From b.' })
  assert.deepEqual(await answer, { spoken: 'From b.', detail: undefined })
  a.ws.close()
  b.ws.close()
  wss.close()
})

test("a session closing ends only the questions sent to it", async () => {
  const bridge = new SessionBridge(quiet())
  const { wss, port } = serve(bridge)
  const a = await link(port)
  const b = await link(port)
  a.send({ type: 'claim' })
  await settle()

  const first = bridge.ask(question, 2000)
  await settle()
  b.ws.close()
  await settle()
  a.send({ type: 'reply', id: a.questions()[0].id, spoken: 'Still answered.' })
  assert.deepEqual(await first, { spoken: 'Still answered.', detail: undefined })

  const second = bridge.ask(question, 2000)
  await settle()
  a.ws.close()
  assert.equal(await second, null)
  assert.equal(bridge.connected, false)
  wss.close()
})

test('with no claim, every linked session gets the question and the first reply wins', async () => {
  const bridge = new SessionBridge(quiet())
  const { wss, port } = serve(bridge)
  const a = await link(port)
  const b = await link(port)
  const c = await link(port) // an idle spare, linked last
  const answer = bridge.ask(question, 2000)
  bridge.notify({ type: 'meeting_started', meeting: 'm' })
  await settle()
  assert.deepEqual([a, b, c].map(s => s.questions().length), [1, 1, 1])
  assert.deepEqual([a, b, c].map(s => s.got.filter(m => m.type === 'meeting_started').length), [1, 1, 1])
  a.send({ type: 'reply', id: a.questions()[0].id, spoken: 'From a.' })
  assert.deepEqual(await answer, { spoken: 'From a.', detail: undefined })

  // Answering claimed the questions for a.
  void bridge.ask(question, 200)
  await settle()
  assert.deepEqual([a, b, c].map(s => s.questions().length), [2, 1, 1])
  for (const s of [a, b, c]) s.ws.close()
  wss.close()
})

test('a question sent to every session ends only once all of them have closed', async () => {
  const bridge = new SessionBridge(quiet())
  const { wss, port } = serve(bridge)
  const a = await link(port)
  const b = await link(port)
  let settled = false
  const answer = bridge.ask(question, 2000).then(r => ((settled = true), r))
  await settle()
  b.ws.close()
  await settle()
  assert.equal(settled, false, 'a can still answer')
  a.ws.close()
  assert.equal(await answer, null)
  wss.close()
})

test('once the claiming session closes, the questions go to every other session', async () => {
  const bridge = new SessionBridge(quiet())
  const { wss, port } = serve(bridge)
  const a = await link(port)
  const b = await link(port)
  const c = await link(port)
  a.send({ type: 'claim' })
  await settle()
  a.ws.close()
  await settle()
  void bridge.ask(question, 200)
  await settle()
  assert.deepEqual([b, c].map(s => s.questions().length), [1, 1])
  b.ws.close()
  c.ws.close()
  wss.close()
})

test('asking with no session linked returns null at once', async () => {
  const bridge = new SessionBridge({ transcript: () => '', postChat: async () => ({ ok: false }), setBrief: () => {}, joinMeeting: async () => ({ note: '' }) })
  assert.equal(await bridge.ask({ question: 'q', asked_by: 'p', meeting: 'm', context: '' }), null)
})

test('join_meeting from the session is acknowledged with the result or the reason it failed', async () => {
  const wss = new WebSocketServer({ port: 0 })
  const joined: string[] = []
  const bridge = new SessionBridge({
    transcript: () => '',
    postChat: async () => ({ ok: false }),
    setBrief: () => {},
    joinMeeting: async url => {
      if (!url.includes('zoom.us')) throw new Error('Pass a Zoom meeting link')
      joined.push(url)
      return { note: 'Alex is joining', meeting: 'k1' }
    },
  })
  wss.on('connection', ws => bridge.attach(ws))
  const port = (wss.address() as { port: number }).port
  const client = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise(r => client.on('open', r))
  const acks = new Map<string, any>()
  client.on('message', raw => {
    const msg = JSON.parse(raw.toString())
    if (msg.type === 'ack') acks.set(msg.request_id, msg)
  })

  client.send(JSON.stringify({ type: 'join_meeting', request_id: 'j1', meeting_url: 'https://us06web.zoom.us/j/123' }))
  client.send(JSON.stringify({ type: 'join_meeting', request_id: 'j2', meeting_url: 'https://example.com' }))
  for (let i = 0; i < 40 && acks.size < 2; i++) await new Promise(r => setTimeout(r, 25))

  assert.deepEqual(acks.get('j1'), { type: 'ack', request_id: 'j1', ok: true, note: 'Alex is joining', meeting: 'k1' })
  assert.equal(acks.get('j2').ok, false)
  assert.match(acks.get('j2').note, /Zoom meeting link/)
  assert.deepEqual(joined, ['https://us06web.zoom.us/j/123'])
  client.close()
  wss.close()
})

// --- Replies after Alex has stopped waiting ----------------------------------------------------------
const acked = async (s: Awaited<ReturnType<typeof link>>, requestId: string) => {
  for (let i = 0; i < 40 && !s.got.some(m => m.type === 'ack' && m.request_id === requestId); i++) await settle(10)
  return s.got.find(m => m.type === 'ack' && m.request_id === requestId)
}

/** A bridge whose late-answer handler keeps what it is given, or refuses with `refuse`. */
function keeping(refuse?: string, options?: { lateAnswerMs?: number }) {
  const kept: { meeting: string; question: string; answer: SessionAnswer }[] = []
  const bridge = new SessionBridge(
    {
      ...quiet(),
      lateAnswer: (meeting, question, answer) => {
        if (refuse) return { ok: false, note: refuse }
        kept.push({ meeting, question, answer })
        return { ok: true }
      },
    },
    options,
  )
  return { bridge, kept, ...serve(bridge) }
}

const pilot = { question: 'When does the pilot start?', asked_by: 'meeting participant', meeting: 'k1', context: '' }

test('a reply is acknowledged as said while Alex is still waiting for it', async () => {
  const { bridge, kept, wss, port } = keeping()
  const a = await link(port)
  a.send({ type: 'claim' })
  await settle()
  const answer = bridge.ask(pilot, 2000)
  await settle()
  a.send({ type: 'reply', id: a.questions()[0].id, spoken: 'On 3 March.', request_id: 'r1' })
  assert.deepEqual(await answer, { spoken: 'On 3 March.', detail: undefined })
  assert.deepEqual(await acked(a, 'r1'), { type: 'ack', request_id: 'r1', ok: true })
  assert.deepEqual(kept, [], 'said, so the session keeps it itself')
  a.ws.close()
  wss.close()
})

test("a reply after Alex stopped waiting is not said, but is kept with that meeting's additions", async () => {
  const { bridge, kept, wss, port } = keeping()
  const a = await link(port)
  a.send({ type: 'claim' })
  await settle()
  assert.equal(await bridge.ask(pilot, 50), null, "Alex has told the meeting he couldn't reach Sam's notes")
  const id = a.questions()[0].id
  a.send({ type: 'reply', id, spoken: 'On 3 March.', detail: 'Kick-off at 10.', request_id: 'r1' })
  assert.deepEqual(await acked(a, 'r1'), { type: 'ack', request_id: 'r1', ok: false, late: true, why: 'timeout', kept: true })
  assert.deepEqual(kept, [{ meeting: 'k1', question: 'When does the pilot start?', answer: { spoken: 'On 3 March.', detail: 'Kick-off at 10.' } }])

  // Kept once: a second reply to it finds nothing waiting.
  a.send({ type: 'reply', id, spoken: 'On 3 March, again.', request_id: 'r2' })
  const again = await acked(a, 'r2')
  assert.equal(again.ok, false)
  assert.equal(again.late, undefined)
  assert.match(again.note, /not waiting for that answer/)
  assert.equal(kept.length, 1)
  a.ws.close()
  wss.close()
})

test('a late answer the meeting refuses, after a leave or once it is over, is acknowledged as not kept, with why', async () => {
  const { bridge, kept, wss, port } = keeping('Alex has been asked to leave this meeting')
  const a = await link(port)
  a.send({ type: 'claim' })
  await settle()
  await bridge.ask(pilot, 50)
  a.send({ type: 'reply', id: a.questions()[0].id, spoken: 'On 3 March.', request_id: 'r1' })
  assert.deepEqual(await acked(a, 'r1'), {
    type: 'ack',
    request_id: 'r1',
    ok: false,
    late: true,
    why: 'timeout',
    kept: false,
    note: 'Alex has been asked to leave this meeting',
  })
  assert.deepEqual(kept, [])
  a.ws.close()
  wss.close()
})

test('a reply to a question nobody asked, or that another session answered first, is neither said nor kept', async () => {
  const { bridge, kept, wss, port } = keeping()
  const a = await link(port)
  const b = await link(port)

  // No claim: both get the question, and the first reply wins.
  const answer = bridge.ask(pilot, 2000)
  await settle()
  a.send({ type: 'reply', id: a.questions()[0].id, spoken: 'From a.', request_id: 'ra' })
  assert.deepEqual(await answer, { spoken: 'From a.', detail: undefined })
  b.send({ type: 'reply', id: b.questions()[0].id, spoken: 'From b.', request_id: 'rb' })
  assert.equal((await acked(a, 'ra')).ok, true)
  const second = await acked(b, 'rb')
  assert.equal(second.ok, false)
  assert.equal(second.late, undefined)

  a.send({ type: 'reply', id: 'never-asked', spoken: 'Hello.', request_id: 'r0' })
  const never = await acked(a, 'r0')
  assert.equal(never.ok, false)
  assert.equal(never.late, undefined)
  assert.deepEqual(kept, [])
  a.ws.close()
  b.ws.close()
  wss.close()
})

test('a reply without a request_id, from an older channel server, is not acknowledged', async () => {
  const { bridge, wss, port } = keeping()
  const a = await link(port)
  a.send({ type: 'claim' })
  await settle()
  const answer = bridge.ask(pilot, 2000)
  await settle()
  a.send({ type: 'reply', id: a.questions()[0].id, spoken: 'On 3 March.' })
  assert.deepEqual(await answer, { spoken: 'On 3 March.', detail: undefined })
  await settle()
  assert.equal(a.got.some(m => m.type === 'ack'), false)
  a.ws.close()
  wss.close()
})

test('a question is remembered for late answers for a while only, and only so many of them', async () => {
  const { bridge, kept, wss, port } = keeping(undefined, { lateAnswerMs: 150 })
  const a = await link(port)
  a.send({ type: 'claim' })
  await settle()
  await bridge.ask(pilot, 10)
  await settle(200) // longer than it is remembered
  a.send({ type: 'reply', id: a.questions()[0].id, spoken: 'On 3 March.', request_id: 'r1' })
  assert.equal((await acked(a, 'r1')).late, undefined, 'forgotten')

  await Promise.all(Array.from({ length: LATE_QUESTIONS_KEPT + 1 }, () => bridge.ask(pilot, 1)))
  await settle()
  const asked = a.questions().slice(1)
  assert.equal(asked.length, LATE_QUESTIONS_KEPT + 1)
  a.send({ type: 'reply', id: asked[0].id, spoken: 'The oldest.', request_id: 'r2' })
  a.send({ type: 'reply', id: asked.at(-1).id, spoken: 'The newest.', request_id: 'r3' })
  assert.equal((await acked(a, 'r2')).late, undefined, 'the oldest made way')
  assert.equal((await acked(a, 'r3')).kept, true)
  assert.deepEqual(kept.map(k => k.answer.spoken), ['The newest.'])
  a.ws.close()
  wss.close()
})

test('a question whose only session closed is remembered too, so a reply after it relinks is kept', async () => {
  const { bridge, kept, wss, port } = keeping()
  const a = await link(port)
  a.send({ type: 'claim' })
  await settle()
  const answer = bridge.ask(pilot, 2000)
  await settle()
  const id = a.questions()[0].id
  a.ws.close()
  assert.equal(await answer, null)
  const relinked = await link(port)
  relinked.send({ type: 'reply', id, spoken: 'On 3 March.', request_id: 'r1' })
  assert.equal((await acked(relinked, 'r1')).kept, true)
  assert.deepEqual(kept.map(k => k.meeting), ['k1'])
  relinked.ws.close()
  wss.close()
})

/** The words of the questions the bridge still holds in memory. Private on purpose: the tests look, to see what is kept. */
const held = (bridge: SessionBridge) => [...(bridge as any).expired.values()].map((e: { question: string }) => e.question)

test("once a meeting's end says its transcript was deleted (a leave or removal), its questions are forgotten at once", async () => {
  const { bridge, kept, wss, port } = keeping()
  const a = await link(port)
  a.send({ type: 'claim' })
  await settle()
  await bridge.ask(pilot, 10)
  await bridge.ask({ ...pilot, meeting: 'k2' }, 10)
  const [k1, k2] = a.questions().map(q => q.id)
  bridge.notify({ type: 'meeting_ended', meeting: 'k1', transcript_file: '', questions: [], minutes_file: '', no_minutes: 'Alex was asked to leave.' })
  // A page that dropped ends one session of a meeting that may go on in another: k2's question stays.
  bridge.notify({ type: 'meeting_ended', meeting: 'k2', transcript_file: '/data/k2.md', questions: [], minutes_file: '' })
  assert.deepEqual(held(bridge), ['', 'When does the pilot start?'], "no word of k1's question is left in memory")
  a.send({ type: 'reply', id: k1, spoken: 'On 3 March.', request_id: 'r1' })
  a.send({ type: 'reply', id: k2, spoken: 'On 4 March.', request_id: 'r2' })
  // Only that it was asked is remembered, so the reply hears why nothing is kept, rather than to try add_to_brief.
  assert.deepEqual(await acked(a, 'r1'), { type: 'ack', request_id: 'r1', ok: false, late: true, why: 'timeout', kept: false, note: LEFT_NOTE })
  assert.equal((await acked(a, 'r2')).late, true, 'the handler decides whether that meeting is still on')
  assert.deepEqual(kept.map(k => k.meeting), ['k2'])
  a.ws.close()
  wss.close()
})

test('a question still waiting when Alex is asked to leave is given up and forgotten with the meeting', async () => {
  const { bridge, kept, wss, port } = keeping()
  const a = await link(port)
  a.send({ type: 'claim' })
  await settle()
  const answer = bridge.ask(pilot, 2000) // no signal: as from a caller that cannot say its turn has stopped
  await settle()
  bridge.notify({ type: 'meeting_ended', meeting: 'k1', transcript_file: '', questions: [], minutes_file: '', no_minutes: 'Alex was asked to leave.' })
  assert.equal(await answer, null, 'given up at once, not after the 2 s wait')
  assert.deepEqual(held(bridge), [''], 'and its words are not put back into memory')
  a.send({ type: 'reply', id: a.questions()[0].id, spoken: 'On 3 March.', request_id: 'r1' })
  assert.deepEqual(await acked(a, 'r1'), { type: 'ack', request_id: 'r1', ok: false, late: true, why: 'stopped', kept: false, note: LEFT_NOTE })
  assert.deepEqual(kept, [])
  a.ws.close()
  wss.close()
})

test('questions given up on are forgotten after the late-answer time, even when nothing else happens on the bridge', async () => {
  const { bridge, wss, port } = keeping(undefined, { lateAnswerMs: 60 })
  const a = await link(port)
  a.send({ type: 'claim' })
  await settle()
  await bridge.ask(pilot, 5)
  bridge.notify({ type: 'meeting_ended', meeting: 'k1', transcript_file: '/data/k1.md', questions: [], minutes_file: '/data/minutes/k1.md' })
  assert.deepEqual(held(bridge), ['When does the pilot start?'])
  await settle(150)
  assert.deepEqual(held(bridge), [], 'no other question timed out and no late reply came, and it is gone all the same')
  a.ws.close()
  wss.close()
})

// --- The turn that asked stops (talked over, never mind, a new question, a leave, the page gone) -------------

test('when the turn that asked stops, Alex stops waiting at once, and a reply is acknowledged as late because the meeting moved on, and kept', async () => {
  const { bridge, kept, wss, port } = keeping()
  const a = await link(port)
  a.send({ type: 'claim' })
  await settle()
  const turn = new AbortController()
  const started = Date.now()
  const answer = bridge.ask(pilot, 2000, turn.signal)
  await settle()
  turn.abort()
  assert.equal(await answer, null)
  assert.ok(Date.now() - started < 1000, 'not after the 2 s wait')
  a.send({ type: 'reply', id: a.questions()[0].id, spoken: 'On 3 March.', request_id: 'r1' })
  assert.deepEqual(await acked(a, 'r1'), { type: 'ack', request_id: 'r1', ok: false, late: true, why: 'stopped', kept: true })
  assert.deepEqual(kept.map(k => k.answer.spoken), ['On 3 March.'], 'kept through the late path, once')
  a.ws.close()
  wss.close()
})

test('a turn that has already stopped asks nothing, and one that stops after its answer came changes nothing', async () => {
  const { bridge, kept, wss, port } = keeping()
  const a = await link(port)
  a.send({ type: 'claim' })
  await settle()
  const stopped = new AbortController()
  stopped.abort()
  assert.equal(await bridge.ask(pilot, 2000, stopped.signal), null)
  await settle()
  assert.equal(a.questions().length, 0, 'nothing went to the session')

  const turn = new AbortController()
  const answer = bridge.ask(pilot, 2000, turn.signal)
  await settle()
  a.send({ type: 'reply', id: a.questions()[0].id, spoken: 'On 3 March.', request_id: 'r1' })
  assert.deepEqual(await answer, { spoken: 'On 3 March.', detail: undefined })
  turn.abort()
  assert.deepEqual(await acked(a, 'r1'), { type: 'ack', request_id: 'r1', ok: true })
  assert.deepEqual(held(bridge), [], 'answered in time: nothing to remember')
  assert.deepEqual(kept, [])
  a.ws.close()
  wss.close()
})

test('a question that timed out stays a timeout when its turn stops afterwards', async () => {
  const { bridge, wss, port } = keeping()
  const a = await link(port)
  a.send({ type: 'claim' })
  await settle()
  const turn = new AbortController()
  assert.equal(await bridge.ask(pilot, 20, turn.signal), null)
  turn.abort() // Alex was talked over while saying he couldn't reach Sam's notes
  a.send({ type: 'reply', id: a.questions()[0].id, spoken: 'On 3 March.', request_id: 'r1' })
  assert.equal((await acked(a, 'r1')).why, 'timeout', "the meeting heard that Alex couldn't reach the notes")
  a.ws.close()
  wss.close()
})

// --- post_chat ---------------------------------------------------------------------------------------------

test("post_chat carries the meeting's key to the voice service, and its answer back to the session", async () => {
  const posted: { message: string; meeting?: string }[] = []
  const bridge = new SessionBridge({
    ...quiet(),
    postChat: async (message, meeting) => {
      posted.push({ message, meeting })
      return meeting === 'k9' ? { ok: false, note: 'Alex is not in that meeting right now' } : { ok: true }
    },
  })
  const { wss, port } = serve(bridge)
  const a = await link(port)
  a.send({ type: 'post_chat', request_id: 'p1', message: 'The deck is in the shared folder.', meeting: 'k1' })
  a.send({ type: 'post_chat', request_id: 'p2', message: 'Hello.', meeting: 'k9' })
  a.send({ type: 'post_chat', request_id: 'p3', message: 'Hi.' })
  a.send({ type: 'post_chat', request_id: 'p4', message: 'Hi.', meeting: 42 })
  for (const id of ['p1', 'p2', 'p3', 'p4']) await acked(a, id)
  assert.deepEqual(posted, [
    { message: 'The deck is in the shared folder.', meeting: 'k1' },
    { message: 'Hello.', meeting: 'k9' },
    { message: 'Hi.', meeting: undefined },
    { message: 'Hi.', meeting: undefined },
  ])
  assert.deepEqual(await acked(a, 'p1'), { type: 'ack', request_id: 'p1', ok: true })
  assert.deepEqual(await acked(a, 'p2'), { type: 'ack', request_id: 'p2', ok: false, note: 'Alex is not in that meeting right now' })
  a.ws.close()
  wss.close()
})
