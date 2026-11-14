import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MeetingSession, endSessions } from '../src/pipeline/session.ts'
import { SessionBridge, type ToSession } from '../src/bridge.ts'
import { writeMinutes } from '../src/minutes.ts'
import { howBotEnded, type StatusChange } from '../src/recall.ts'
import { CHECKING_LINE, JOIN_LINE, LEAVE_LINE, SESSION_OFFLINE_LINE } from '../src/consent.ts'
import type { BrainEvent } from '../src/brain/brain.ts'

class FakeSocket extends EventEmitter {
  readyState = 1
  sent: (Buffer | string)[] = []
  send(data: Buffer | string) { this.sent.push(data) }
  close() { this.readyState = 3 }
  controls() { return this.sent.filter(d => typeof d === 'string').map(d => JSON.parse(d as string)) }
  audio() { return this.sent.filter(d => typeof d !== 'string') as Buffer[] }
}

class FakeFlux extends EventEmitter {
  received: Buffer[] = []
  closed = false
  send(b: Buffer) { this.received.push(b) }
  // Like Deepgram: the stream closes a little after CloseStream, so last words can still come first.
  close() {
    if (this.closed) return
    this.closed = true
    setImmediate(() => this.emit('close', 1000, ''))
  }
  endTurn(text: string) { this.emit('turn', { type: 'TurnInfo', event: 'EndOfTurn', turn_index: 0, transcript: text }) }
}

let meetings = 0

/**
 * What a session needs besides its brain, bridge and voice: a meeting key of its own, fakes for Recall and
 * the minutes, and no consent line during the test.
 */
function meeting() {
  const meetingKey = `session-${process.pid}-${++meetings}`
  return {
    opts: { meetingKey, botId: `bot-${meetingKey}`, platform: 'Zoom' },
    deps: {
      recall: {
        sendChat: async () => {},
        leaveCall: async () => {},
        deleteMedia: async () => true,
        howBotEnded: async () => ({ kind: 'ended', sub_code: 'call_ended_by_host' }) as const,
      },
      writeMinutes: async () => Promise.reject(new Error('no minutes in these tests')),
      greetDelayMs: 60_000,
    },
  }
}

function setup(events: BrainEvent[], speak?: (text: string, signal?: AbortSignal) => AsyncGenerator<Buffer>) {
  const ws = new FakeSocket()
  const flux = new FakeFlux()
  const spoken: string[] = []
  const brain = { async *respond() { for (const e of events) yield e } }
  const { opts, deps } = meeting()
  const session = new MeetingSession(ws as any, opts, {
    ...deps,
    brain: brain as any,
    bridge: new SessionBridge({ transcript: () => '', postChat: async () => ({ ok: false }), setBrief: () => {}, joinMeeting: async () => ({ note: '' }) }),
    brief: () => '',
    flux: () => flux as any,
    speak: speak ?? (async function* (text: string) { spoken.push(text); yield Buffer.from([0, 1]) }),
  })
  return { ws, flux, spoken, session }
}

const settle = () => new Promise(r => setTimeout(r, 30))

test('meeting audio is forwarded to speech-to-text', () => {
  const { ws, flux, session } = setup([])
  ws.emit('message', Buffer.from([1, 2]), true)
  assert.equal(flux.received.length, 1)
  session.transcript.delete()
})

test('Alex stays quiet unless addressed, then speaks', async () => {
  const { flux, ws, spoken, session } = setup([{ kind: 'say', text: 'It ships in March.' }])
  flux.endTurn('we should ship soon')
  await settle()
  assert.deepEqual(spoken, [])
  flux.endTurn('Alex, when does it ship?')
  await settle()
  assert.deepEqual(spoken, ['It ships in March.'])
  assert.equal(ws.audio().length, 1)
  assert.match(session.transcript.recent(), /Alex: It ships in March\./)
  session.transcript.delete()
})

test('a question for the session falls back politely when no session is linked', async () => {
  const { flux, spoken, session } = setup([{ kind: 'ask_session', question: 'What is the status of PR 9?' }])
  flux.endTurn('Alex, what is the status of PR 9?')
  await settle()
  assert.deepEqual(spoken, [CHECKING_LINE, SESSION_OFFLINE_LINE])
  session.transcript.delete()
})

test('a question handed to the session carries the whole meeting so far, not just its last minutes', async () => {
  const asked: { context: string }[] = []
  const ws = new FakeSocket()
  const flux = new FakeFlux()
  const { opts, deps } = meeting()
  const session = new MeetingSession(ws as any, opts, {
    ...deps,
    brain: { async *respond() { yield { kind: 'ask_session', question: 'Go deeper on the rollout checks?' } } } as any,
    bridge: { ask: async (q: { context: string }) => (asked.push(q), { spoken: 'Here is more.' }), notify: () => {} } as any,
    brief: () => '',
    flux: () => flux as any,
    speak: async function* () { yield Buffer.from([0, 1]) },
  })
  session.transcript.add('Speaker', 'An early point about the change window, said first.')
  // Far more than the 3,000 characters a hand-off used to carry.
  for (let i = 0; i < 80; i++) session.transcript.add('Speaker', `Line ${i}: ${'detail '.repeat(10)}`)
  flux.endTurn('Alex, can you go deeper on that?')
  await settle()
  assert.equal(asked.length, 1)
  assert.match(asked[0].context, /An early point about the change window, said first\./)
  assert.match(asked[0].context, /Alex, can you go deeper on that\?/)
  session.transcript.delete()
})

test('someone talking over Alex stops the reply and clears playback', async () => {
  const slow = async function* (_t: string, signal?: AbortSignal) {
    for (let i = 0; i < 50 && !signal?.aborted; i++) {
      yield Buffer.from([0, 0])
      await new Promise(r => setTimeout(r, 10))
    }
  }
  const { flux, ws, session } = setup([{ kind: 'say', text: 'A long answer.' }], slow)
  flux.endTurn('Alex, explain everything')
  await settle()
  flux.emit('turn', { type: 'TurnInfo', event: 'StartOfTurn', turn_index: 1, transcript: '' })
  await settle()
  const sentBefore = ws.audio().length
  await new Promise(r => setTimeout(r, 60))
  assert.ok(ws.controls().some(c => c.type === 'clear'))
  assert.equal(ws.audio().length, sentBefore, 'no more audio after barge-in')
  session.transcript.delete()
})

// --- Bot sessions: the end of the meeting, minutes and Recall media ------------------------------

let bots = 0

/** GET /bot/{id}/ as Recall answers it once the bot has left the call, with this sub code. */
const botThatEnded = (sub_code: string | null, code = 'call_ended') => async () => ({
  status_changes: [
    { code: 'joining_call', sub_code: null },
    { code: 'in_call_not_recording', sub_code: null },
    { code: 'in_call_recording', sub_code: null },
    { code, sub_code },
  ] satisfies StatusChange[],
})

/** A bot session with fakes for Recall, Claude and the session bridge. */
function botSetup(
  opts: {
    writeMinutes?: (input: any) => Promise<string>
    botId?: string
    leaveDelayMs?: number
    greetDelayMs?: number
    onLeaveCall?: () => void
    speak?: (text: string, signal?: AbortSignal) => AsyncGenerator<Buffer>
    /** Recall's answer to GET /bot/{id}/ (by default: the host ended the meeting for everyone). */
    getBot?: (path: string, signal: AbortSignal) => Promise<unknown>
    /** How long the session waits for Recall to say how the bot left (ms). */
    endingWaitMs?: number
    /** The session is not told its bot (its page connected for a meeting the service no longer knows). */
    noBotId?: boolean
  } = {},
) {
  const ws = new FakeSocket()
  const flux = new FakeFlux()
  const botId = opts.botId ?? `bot-${process.pid}-${++bots}`
  const events: ToSession[] = []
  const recall = { deleted: [] as string[], left: [] as string[], reads: [] as string[] }
  const getBot = opts.getBot ?? botThatEnded('call_ended_by_host')
  const claudeCalls: any[] = []
  const spoken: string[] = []
  let answered = 0
  const minutesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alex-session-minutes-'))
  const client = {
    messages: {
      create: async (body: any) => {
        claudeCalls.push(body)
        return { content: [{ type: 'text', text: '## Attendees\nSpeaker\n## Summary\nThe pilot starts in March.' }], stop_reason: 'end_turn', stop_details: null } as any
      },
    },
  }
  // The meeting key is the bot's: a second session for the same bot is the same meeting, its page reconnected.
  const session = new MeetingSession(ws as any, { meetingKey: `key-${botId}`, botId: opts.noBotId ? undefined : botId, platform: 'Zoom' }, {
    brain: { async *respond() { answered++ } } as any,
    bridge: { notify: (m: ToSession) => void events.push(m), ask: async () => null } as any,
    brief: () => 'Meeting with Bob about the pilot.',
    flux: () => flux as any,
    speak: async function* (text: string, signal?: AbortSignal) {
      spoken.push(text)
      if (opts.speak) yield* opts.speak(text, signal)
      else yield Buffer.from([0, 1])
    },
    recall: {
      sendChat: async () => {},
      leaveCall: async (id: string) => {
        recall.left.push(id)
        opts.onLeaveCall?.()
      },
      deleteMedia: async (id: string) => (recall.deleted.push(id), true),
      // The real reading of the bot's status changes, retries included, over a fake Recall.
      howBotEnded: (id: string) =>
        howBotEnded(id, {
          get: (p, signal) => (recall.reads.push(p), getBot(p, signal)),
          everyMs: 5,
          waitMs: opts.endingWaitMs ?? 300,
        }),
    },
    writeMinutes: opts.writeMinutes ?? (input => writeMinutes(input, { dir: minutesDir, client })),
    leaveDelayMs: opts.leaveDelayMs ?? 0,
    greetDelayMs: opts.greetDelayMs,
  })
  const ended = () => events.find(e => e.type === 'meeting_ended') as Extract<ToSession, { type: 'meeting_ended' }> | undefined
  return { ws, flux, botId, events, ended, recall, claudeCalls, minutesDir, session, spoken, answered: () => answered }
}

async function until(ok: () => boolean, tries = 100): Promise<void> {
  for (let i = 0; i < tries && !ok(); i++) await new Promise(r => setTimeout(r, 10))
}

test('a meeting that ends normally keeps the transcript, gets minutes, and its Recall media is deleted', async () => {
  const { ws, flux, botId, ended, recall, claudeCalls, minutesDir, session } = botSetup()
  flux.endTurn('We agreed the pilot starts in March.')
  await settle()
  ws.emit('close') // the meeting is over: the bot's page disconnects
  await until(() => ended() !== undefined)
  const e = ended()!
  assert.equal(e.transcript_file, session.transcript.file)
  assert.ok(fs.existsSync(session.transcript.file), 'the transcript is kept')
  assert.equal(e.minutes_file, path.join(minutesDir, path.basename(session.transcript.file)))
  assert.match(fs.readFileSync(e.minutes_file, 'utf8'), /^# Minutes: .* UTC, Zoom\n[\s\S]*The pilot starts in March\./)
  assert.equal(e.no_minutes, undefined)
  assert.equal(e.minutes_error, undefined)
  assert.equal(claudeCalls.length, 1)
  assert.match(claudeCalls[0].messages[0].content, /Speaker: We agreed the pilot starts in March\./)
  assert.deepEqual(recall.deleted, [botId], 'media deleted once, though nobody asked Alex to leave')
  // Alex can't hear once its page has gone, so the bot is asked to leave (when the meeting is over, it has already).
  assert.deepEqual(recall.left, [botId])
  session.end() // ending again changes nothing
  await settle()
  assert.deepEqual(recall.deleted, [botId])
  session.transcript.delete()
})

test('after "Alex, please leave" there are no minutes, the transcript goes, and media is deleted once', async () => {
  let wrote = 0
  const { ws, flux, botId, ended, recall, session } = botSetup({ writeMinutes: async () => (wrote++, '/never') })
  flux.endTurn('We agreed the pilot starts in March.')
  flux.endTurn('Alex, please leave.')
  await until(() => ended() !== undefined)
  ws.emit('close') // the bot drops out of the call
  await settle()
  const e = ended()!
  assert.equal(e.transcript_file, '')
  assert.equal(e.minutes_file, '')
  assert.match(e.no_minutes ?? '', /asked to leave/)
  assert.deepEqual(e.questions, [])
  assert.equal(wrote, 0, 'no minutes are written')
  assert.equal(fs.existsSync(session.transcript.file), false, 'the transcript is deleted')
  assert.deepEqual(recall.left, [botId])
  assert.deepEqual(recall.deleted, [botId])
})

test('a meeting that ends while Alex is saying goodbye still gets no minutes, and the transcript still goes', async () => {
  let wrote = 0
  const { ws, flux, botId, ended, recall, session } = botSetup({ writeMinutes: async () => (wrote++, '/never'), leaveDelayMs: 300 })
  flux.endTurn('We agreed the pilot starts in March.')
  flux.endTurn('Alex, please leave.')
  await settle()
  ws.emit('close') // the meeting ends before the bot has left
  await until(() => ended() !== undefined)
  assert.equal(ended()!.transcript_file, '')
  assert.deepEqual(ended()!.questions, [])
  assert.match(ended()!.no_minutes ?? '', /asked to leave/)
  await until(() => !fs.existsSync(session.transcript.file))
  assert.equal(fs.existsSync(session.transcript.file), false)
  assert.equal(wrote, 0)
  assert.deepEqual(recall.deleted, [botId])
})

test('nobody said anything: no minutes, and meeting_ended says so', async () => {
  let wrote = 0
  const { ws, botId, ended, recall, session } = botSetup({ writeMinutes: async () => (wrote++, '/never') })
  ws.emit('close')
  await until(() => ended() !== undefined)
  assert.equal(ended()!.minutes_file, '')
  assert.match(ended()!.no_minutes ?? '', /Nobody said anything/)
  assert.equal(wrote, 0)
  assert.deepEqual(recall.deleted, [botId])
  session.transcript.delete()
})

test('a failure to write the minutes is reported in meeting_ended, and the transcript is kept', async () => {
  const { ws, flux, ended, session } = botSetup({ writeMinutes: async () => Promise.reject(new Error('Claude took longer than 240 s')) })
  flux.endTurn('We agreed the pilot starts in March.')
  await settle()
  ws.emit('close')
  await until(() => ended() !== undefined)
  const e = ended()!
  assert.equal(e.minutes_file, '')
  assert.equal(e.minutes_error, 'Claude took longer than 240 s')
  assert.equal(e.transcript_file, session.transcript.file)
  assert.ok(fs.existsSync(session.transcript.file))
  session.transcript.delete()
})

test("a bot's media is deleted once, even when a second session for it ends", async () => {
  const first = botSetup()
  const second = botSetup({ botId: first.botId })
  first.ws.emit('close')
  second.ws.emit('close')
  await until(() => first.ended() !== undefined && second.ended() !== undefined)
  assert.deepEqual([...first.recall.deleted, ...second.recall.deleted], [first.botId])
  first.session.transcript.delete()
  second.session.transcript.delete()
})

// --- Removed by the host, or a meeting that simply ends (Recall's call_ended sub code) -------------

test('the host removing Alex counts as "Alex, please leave": no minutes, the transcript goes, and media is deleted', async () => {
  const { ws, flux, botId, ended, recall, claudeCalls, minutesDir, session } = botSetup({ getBot: botThatEnded('bot_kicked_from_call') })
  flux.endTurn('We agreed the pilot starts in March.')
  flux.endTurn('Alex, when does it ship?')
  await settle()
  ws.emit('close') // the bot is out of the call, so its page disconnects
  await until(() => ended() !== undefined)
  const e = ended()!
  assert.equal(e.minutes_file, '')
  assert.equal(e.no_minutes, 'Alex was removed from the meeting, so it deleted the transcript and wrote no minutes.')
  assert.equal(e.minutes_error, undefined)
  assert.equal(e.transcript_file, '')
  assert.deepEqual(e.questions, [])
  assert.equal(claudeCalls.length, 0, 'no minutes are written')
  assert.deepEqual(fs.readdirSync(minutesDir), [])
  assert.equal(fs.existsSync(session.transcript.file), false, 'the transcript is deleted')
  assert.deepEqual(recall.reads, [`/bot/${botId}/`])
  assert.deepEqual(recall.deleted, [botId], 'Recall media deleted, as at every end')
})

test('removing Alex deletes the transcript and minutes of every session of the meeting', async () => {
  const kicked = botThatEnded('bot_kicked_from_call')
  // An earlier session of the meeting whose page dropped, and that reported its minutes...
  const first = botSetup({ getBot: botThatEnded('bot_received_leave_call') })
  first.flux.endTurn('We agreed the pilot starts in March.')
  await settle()
  first.ws.emit('close')
  await until(() => first.ended() !== undefined)
  const minutesFile = first.ended()!.minutes_file
  assert.ok(fs.existsSync(minutesFile))
  // ...then the page connected again, and the host removed Alex.
  const second = botSetup({ botId: first.botId, getBot: kicked })
  second.flux.endTurn('Second part.')
  await settle()
  second.ws.emit('close')
  await until(() => second.ended() !== undefined)
  assert.equal(fs.existsSync(first.session.transcript.file), false)
  assert.equal(fs.existsSync(minutesFile), false)
  assert.equal(fs.existsSync(second.session.transcript.file), false)
  assert.match(second.ended()!.no_minutes ?? '', /^Alex was removed from the meeting/)
  assert.match(second.ended()!.no_minutes ?? '', /earlier meeting_ended for this meeting were deleted too/)
})

test('removed from the waiting room: no minutes, nothing kept', async () => {
  let wrote = 0
  const { ws, ended, session } = botSetup({ getBot: botThatEnded('bot_kicked_from_waiting_room'), writeMinutes: async () => (wrote++, '/never') })
  await settle()
  ws.emit('close')
  await until(() => ended() !== undefined)
  assert.match(ended()!.no_minutes ?? '', /removed from the meeting/)
  assert.equal(wrote, 0)
  assert.equal(fs.existsSync(session.transcript.file), false)
})

for (const sub_code of ['call_ended_by_host', 'timeout_exceeded_everyone_left', 'call_ended_by_platform_idle', 'timeout_exceeded_noone_joined', 'bot_received_leave_call']) {
  test(`a meeting that simply ends (${sub_code}) keeps the transcript and gets minutes`, async () => {
    const { ws, flux, ended, claudeCalls, session } = botSetup({ getBot: botThatEnded(sub_code) })
    flux.endTurn('We agreed the pilot starts in March.')
    await settle()
    ws.emit('close')
    await until(() => ended() !== undefined)
    const e = ended()!
    assert.ok(e.minutes_file && fs.existsSync(e.minutes_file), 'minutes written')
    assert.equal(e.no_minutes, undefined)
    assert.equal(e.transcript_file, session.transcript.file)
    assert.ok(fs.existsSync(session.transcript.file), 'the transcript is kept')
    assert.equal(claudeCalls.length, 1)
    session.transcript.delete()
  })
}

test('Recall cannot be read: no minutes in case Alex was removed, but the transcript is kept and meeting_ended says why', async () => {
  let wrote = 0
  const { ws, flux, botId, ended, recall, session } = botSetup({
    getBot: async p => Promise.reject(new Error(`Recall GET ${p} failed (503): unavailable`)),
    writeMinutes: async () => (wrote++, '/never'),
  })
  flux.endTurn('We agreed the pilot starts in March.')
  flux.endTurn('Alex, when does it ship?')
  await settle()
  ws.emit('close')
  await until(() => ended() !== undefined)
  const e = ended()!
  assert.equal(e.minutes_file, '')
  assert.match(e.no_minutes ?? '', /^Could not confirm how the meeting ended \(Recall could not be read: Recall GET \/bot\/.*\/ failed \(503\)/)
  assert.match(e.no_minutes ?? '', /The transcript is kept\.$/)
  assert.equal(e.minutes_error, undefined)
  assert.equal(wrote, 0, 'no minutes are written')
  assert.equal(e.transcript_file, session.transcript.file)
  assert.ok(fs.existsSync(session.transcript.file), 'nothing is deleted on a guess')
  assert.deepEqual(e.questions, ['Alex, when does it ship?'])
  assert.ok(recall.reads.length > 1, 'read again within the bound')
  assert.deepEqual(recall.deleted, [botId])
  session.transcript.delete()
})

// The timeout makes a lost bound a failure, not a run that never ends (node:test has no default timeout).
test('Recall not answering at all is given up at the bound: no minutes, transcript kept', { timeout: 2000 }, async () => {
  const { ws, flux, ended, session } = botSetup({ getBot: () => new Promise(() => {}), endingWaitMs: 100 })
  flux.endTurn('We agreed the pilot starts in March.')
  await settle()
  const closedAt = Date.now()
  ws.emit('close')
  await until(() => ended() !== undefined)
  assert.ok(Date.now() - closedAt < 900, 'the wait is bounded')
  assert.match(ended()!.no_minutes ?? '', /^Could not confirm how the meeting ended \(Recall could not be read: no answer in time\)/)
  assert.ok(fs.existsSync(session.transcript.file))
  session.transcript.delete()
})

test('a bot still finishing is read again until Recall says how it left', async () => {
  let n = 0
  const kicked = botThatEnded('bot_kicked_from_call')
  const { ws, flux, botId, ended, recall, session } = botSetup({
    getBot: async () => (++n < 3 ? { status_changes: [{ code: 'in_call_recording', sub_code: null }] } : kicked()),
  })
  flux.endTurn('We agreed the pilot starts in March.')
  await settle()
  ws.emit('close')
  await until(() => ended() !== undefined)
  assert.deepEqual(recall.reads, [`/bot/${botId}/`, `/bot/${botId}/`, `/bot/${botId}/`])
  assert.match(ended()!.no_minutes ?? '', /removed from the meeting/)
  assert.equal(fs.existsSync(session.transcript.file), false)
})

test('a bot that has still not left the call by the bound: no minutes, transcript kept', async () => {
  const { ws, flux, ended, recall, session } = botSetup({ getBot: async () => ({ status_changes: [{ code: 'in_call_recording', sub_code: null }] }), endingWaitMs: 60 })
  flux.endTurn('We agreed the pilot starts in March.')
  await settle()
  ws.emit('close')
  await until(() => ended() !== undefined)
  assert.ok(recall.reads.length > 1)
  assert.match(ended()!.no_minutes ?? '', /^Could not confirm how the meeting ended \(Recall had not said the bot left the call within/)
  assert.ok(fs.existsSync(session.transcript.file))
  session.transcript.delete()
})

test('a reason Recall does not document: no minutes, and the transcript is kept (never deleted on a guess)', async () => {
  const { ws, flux, ended, session } = botSetup({ getBot: botThatEnded('bot_removed_by_new_feature') })
  flux.endTurn('We agreed the pilot starts in March.')
  await settle()
  ws.emit('close')
  await until(() => ended() !== undefined)
  assert.match(ended()!.no_minutes ?? '', /^Could not confirm how the meeting ended \(Recall gave a reason it does not document .*"bot_removed_by_new_feature"\)/)
  assert.equal(ended()!.transcript_file, session.transcript.file)
  assert.ok(fs.existsSync(session.transcript.file))
  session.transcript.delete()
})

for (const [sub_code, why] of [
  [null, /^Could not confirm how the meeting ended \(Recall says the bot failed in the call, but not why\)/],
  ['some_new_code', /^Could not confirm how the meeting ended \(Recall gave an error it does not document .*"some_new_code"\)/],
  ['microsoft_teams_bot_ejected', /^Could not confirm how the meeting ended \(Recall gave an error it does not document .*"microsoft_teams_bot_ejected"\)/],
] as const) {
  test(`a fatal error Recall does not document (${sub_code}): no minutes, and the transcript is kept`, async () => {
    let wrote = 0
    const { ws, flux, ended, session } = botSetup({ getBot: botThatEnded(sub_code, 'fatal'), writeMinutes: async () => (wrote++, '/never') })
    flux.endTurn('We agreed the pilot starts in March.')
    await settle()
    ws.emit('close')
    await until(() => ended() !== undefined)
    const e = ended()!
    assert.equal(e.minutes_file, '')
    assert.match(e.no_minutes ?? '', why)
    assert.equal(wrote, 0, 'no minutes are written')
    assert.equal(e.transcript_file, session.transcript.file)
    assert.ok(fs.existsSync(session.transcript.file), 'nothing is deleted on a guess')
    session.transcript.delete()
  })
}

test('a documented fatal error that is not a removal (bot_errored) is a normal end, with minutes', async () => {
  const { ws, flux, ended, session } = botSetup({ getBot: botThatEnded('bot_errored', 'fatal') })
  flux.endTurn('We agreed the pilot starts in March.')
  await settle()
  ws.emit('close')
  await until(() => ended() !== undefined)
  const e = ended()!
  assert.ok(e.minutes_file && fs.existsSync(e.minutes_file), 'minutes written')
  assert.equal(e.no_minutes, undefined)
  assert.ok(fs.existsSync(session.transcript.file))
  session.transcript.delete()
})

test('a bot session that does not know its bot: no minutes (a removal cannot be ruled out), and the transcript is kept', async () => {
  let wrote = 0
  const { ws, flux, ended, recall, session } = botSetup({ noBotId: true, writeMinutes: async () => (wrote++, '/never') })
  flux.endTurn('We agreed the pilot starts in March.')
  await settle()
  ws.emit('close')
  await until(() => ended() !== undefined)
  const e = ended()!
  assert.equal(wrote, 0, 'no minutes are written')
  assert.equal(e.minutes_file, '')
  assert.ok((e.no_minutes ?? '').startsWith('Could not confirm how the meeting ended (no Recall bot is known for this meeting)'), String(e.no_minutes))
  assert.equal(e.transcript_file, session.transcript.file)
  assert.ok(fs.existsSync(session.transcript.file), 'the transcript is kept')
  assert.deepEqual(recall.reads, [], 'there is no bot to read')
  assert.deepEqual(recall.left, [])
  assert.deepEqual(recall.deleted, [])
  session.transcript.delete()
})

test('after "Alex, please leave" Recall is not asked how the bot left', async () => {
  const { flux, ended, recall } = botSetup()
  flux.endTurn('Alex, please leave.')
  await until(() => ended() !== undefined)
  assert.match(ended()!.no_minutes ?? '', /asked to leave/)
  assert.deepEqual(recall.reads, [])
})

// --- Leave requests, wherever and whenever they are heard ------------------------------------------

test('a leave request heard after the page has gone still means no minutes, and the transcript goes', async () => {
  const { ws, flux, ended, claudeCalls, minutesDir, session, spoken } = botSetup()
  flux.endTurn('We agreed the pilot starts in March.')
  await settle()
  ws.emit('close') // the host ends the meeting...
  flux.endTurn('Alex, please leave.') // ...and Deepgram sends the last words it heard, after CloseStream
  await until(() => ended() !== undefined)
  const e = ended()!
  assert.equal(e.minutes_file, '')
  assert.match(e.no_minutes ?? '', /asked to leave/)
  assert.equal(e.transcript_file, '')
  assert.deepEqual(e.questions, [])
  assert.equal(claudeCalls.length, 0, 'no minutes are written')
  assert.deepEqual(fs.readdirSync(minutesDir), [])
  assert.equal(fs.existsSync(session.transcript.file), false, 'the transcript is deleted')
  assert.equal(spoken.includes(LEAVE_LINE), false, 'nobody is left to say goodbye to')
})

test('words heard after the page has gone go into the minutes, but Alex does not answer them', async () => {
  const { ws, flux, ended, claudeCalls, session, answered } = botSetup()
  flux.endTurn('We agreed the pilot starts in March.')
  await settle()
  ws.emit('close')
  flux.endTurn('Alex, what about the budget?')
  await until(() => ended() !== undefined)
  assert.ok(ended()!.minutes_file)
  assert.match(claudeCalls[0].messages[0].content, /Speaker: Alex, what about the budget\?/)
  assert.equal(answered(), 0)
  session.transcript.delete()
})

test('after "Alex, please leave" nothing more is recorded: words during the goodbye or the leave call never bring the transcript back', async () => {
  const s = botSetup({ onLeaveCall: () => s.flux.endTurn('Thanks, bye everyone.') })
  s.flux.endTurn('We agreed the pilot starts in March.')
  s.flux.endTurn('Alex, please leave.')
  s.flux.endTurn('Bye Alex, thanks.') // while Alex is saying goodbye
  await until(() => s.ended() !== undefined)
  await settle()
  assert.deepEqual(s.recall.left, [s.botId])
  assert.equal(fs.existsSync(s.session.transcript.file), false, 'the transcript stays deleted')
  assert.equal(s.ended()!.transcript_file, '')
  assert.equal(s.answered(), 0)
})

test('talking over the goodbye does not cut it off', async () => {
  const slow = async function* (_t: string, signal?: AbortSignal) {
    for (let i = 0; i < 10 && !signal?.aborted; i++) {
      yield Buffer.from([0, 0])
      await new Promise(r => setTimeout(r, 10))
    }
  }
  const { ws, flux, ended } = botSetup({ speak: slow })
  flux.endTurn('Alex, please leave.')
  await new Promise(r => setTimeout(r, 25))
  flux.emit('turn', { type: 'TurnInfo', event: 'StartOfTurn', turn_index: 1, transcript: '' }) // "Bye, Alex"
  await until(() => ended() !== undefined)
  // The page is told to clear once, as the request is heard, so the goodbye plays at once: never after it has started.
  const firstAudio = ws.sent.findIndex(d => typeof d !== 'string')
  assert.equal(ws.sent.slice(firstAudio).some(d => typeof d === 'string' && JSON.parse(d).type === 'clear'), false)
  assert.equal(ws.audio().length, 10, 'the whole goodbye was sent')
})

test('the consent greeting never cuts off the goodbye', async () => {
  const { flux, ended, spoken } = botSetup({ greetDelayMs: 20, leaveDelayMs: 100 })
  flux.endTurn('Alex, please leave.') // before the greeting is due
  await until(() => ended() !== undefined, 50)
  assert.deepEqual(spoken, [LEAVE_LINE])
  assert.equal(spoken.includes(JOIN_LINE), false)
})

// --- One meeting, two sessions (the bot page reconnected) -----------------------------------------

test('two sessions of one meeting in the same minute keep separate transcripts', () => {
  const first = botSetup()
  const second = botSetup({ botId: first.botId })
  assert.notEqual(second.session.transcript.file, first.session.transcript.file)
  first.flux.endTurn('First part.')
  second.flux.endTurn('Second part.')
  assert.doesNotMatch(fs.readFileSync(first.session.transcript.file, 'utf8'), /Second part/)
  first.session.transcript.delete()
  second.session.transcript.delete()
})

test("\"Alex, please leave\" in a later session of the meeting deletes the earlier session's transcript and minutes too", async () => {
  const first = botSetup()
  first.flux.endTurn('We agreed the pilot starts in March.')
  await settle()
  first.ws.emit('close') // the page's socket dropped: that session ends with minutes
  await until(() => first.ended() !== undefined)
  const minutesFile = first.ended()!.minutes_file
  assert.ok(fs.existsSync(minutesFile))
  // A copy of the first session's transcript that a correction left beside it (see Transcript.amend) goes too.
  fs.writeFileSync(`${first.session.transcript.file}.next`, 'We agreed the pilot', { mode: 0o600 })
  const second = botSetup({ botId: first.botId }) // and the page connected again
  second.flux.endTurn('Alex, please leave.')
  await until(() => second.ended() !== undefined)
  assert.equal(fs.existsSync(first.session.transcript.file), false, "the first session's transcript is deleted")
  assert.equal(fs.existsSync(`${first.session.transcript.file}.next`), false, 'and a copy left beside it')
  assert.equal(fs.existsSync(minutesFile), false, "the first session's minutes are deleted")
  assert.equal(fs.existsSync(second.session.transcript.file), false)
  const e = second.ended()!
  assert.equal(e.transcript_file, '')
  assert.match(e.no_minutes ?? '', /asked to leave/)
  assert.match(e.no_minutes ?? '', /earlier meeting_ended for this meeting were deleted too/, 'Sam is told the minutes Sam may have had are gone')
  // A session for the meeting that starts after the leave records nothing.
  const third = botSetup({ botId: first.botId })
  third.flux.endTurn('Is Alex still here?')
  assert.equal(fs.existsSync(third.session.transcript.file), false)
  third.ws.emit('close')
  await until(() => third.ended() !== undefined)
  assert.match(third.ended()!.no_minutes ?? '', /asked to leave/)
})

test('a leave request in another session while the minutes are being written: they are deleted, and meeting_ended has none', async () => {
  let release!: () => void
  const gate = new Promise<void>(r => (release = r))
  const minutesFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'alex-session-minutes-')), 'minutes.md')
  const first = botSetup({
    writeMinutes: async () => {
      await gate
      fs.writeFileSync(minutesFile, 'minutes')
      return minutesFile
    },
  })
  first.flux.endTurn('We agreed the pilot starts in March.')
  first.flux.endTurn('Alex, when does it ship?')
  await settle()
  first.ws.emit('close')
  await settle() // writing the minutes
  const second = botSetup({ botId: first.botId })
  second.flux.endTurn('Alex, please leave.')
  await until(() => second.ended() !== undefined)
  release()
  await until(() => first.ended() !== undefined)
  const e = first.ended()!
  assert.equal(e.minutes_file, '')
  assert.equal(e.transcript_file, '')
  assert.deepEqual(e.questions, [])
  assert.match(e.no_minutes ?? '', /asked to leave/)
  assert.equal(fs.existsSync(minutesFile), false)
  assert.equal(fs.existsSync(first.session.transcript.file), false)
})

// --- The service stopping --------------------------------------------------------------------------

test('when the service stops, each meeting ends at once: Alex leaves the call, and meeting_ended goes out even if the minutes are not ready', async () => {
  const slow = botSetup({ writeMinutes: () => new Promise<string>(() => {}) }) // never finishes
  const quick = botSetup()
  slow.flux.endTurn('We agreed the pilot starts in March.')
  quick.flux.endTurn('We agreed the pilot starts in April.')
  await settle()
  await endSessions([slow.session, quick.session], 300)
  const s = slow.ended()!
  assert.match(s.minutes_error ?? '', /stopped before the minutes were written/)
  assert.equal(s.transcript_file, slow.session.transcript.file, 'the transcript is kept')
  assert.ok(fs.existsSync(slow.session.transcript.file))
  assert.deepEqual(slow.recall.left, [slow.botId])
  assert.ok(quick.ended()!.minutes_file, 'minutes written in time are sent')
  assert.equal(slow.events.filter(e => e.type === 'meeting_ended').length, 1)
  slow.session.transcript.delete()
  quick.session.transcript.delete()
})
