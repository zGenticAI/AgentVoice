import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { MeetingSession } from '../src/pipeline/session.ts'
import type { BrainEvent } from '../src/brain/brain.ts'
import type { SessionAnswer } from '../src/bridge.ts'

class FakeSocket extends EventEmitter {
  readyState = 1
  sent: (Buffer | string)[] = []
  send(data: Buffer | string) { this.sent.push(data) }
  close() { this.readyState = 3 }
  controls() { return this.sent.filter(d => typeof d === 'string').map(d => JSON.parse(d as string)) }
}

class FakeFlux extends EventEmitter {
  closed = false
  send() {}
  close() {
    if (this.closed) return
    this.closed = true
    setImmediate(() => this.emit('close', 1000, ''))
  }
  // Like Flux: a turn starts once its first words are heard, and each event carries the turn so far.
  startTurn(text = 'Wait, what about') { this.emit('turn', { type: 'TurnInfo', event: 'StartOfTurn', turn_index: 1, transcript: text }) }
  update(text: string) { this.emit('turn', { type: 'TurnInfo', event: 'Update', turn_index: 1, transcript: text }) }
  endTurn(text: string) { this.emit('turn', { type: 'TurnInfo', event: 'EndOfTurn', turn_index: 0, transcript: text }) }
}

let meetings = 0

/**
 * What a session needs besides its brain and bridge: a meeting key of its own, fakes for Recall and the
 * minutes, and no consent line during the test.
 */
function meeting() {
  const meetingKey = `attention-${process.pid}-${++meetings}`
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

/** A session whose Claude answers each line it is given with reply(line). `answered` lists those lines. */
function setup(
  reply: (line: string) => string,
  opts: { replyWindowMs?: number; calledWindowMs?: number; speak?: (text: string, signal?: AbortSignal) => AsyncGenerator<Buffer> } = {},
) {
  const ws = new FakeSocket()
  const flux = new FakeFlux()
  const answered: string[] = []
  const brain = {
    async *respond({ latest }: { latest: string }): AsyncGenerator<BrainEvent> {
      answered.push(latest)
      yield { kind: 'say', text: reply(latest) }
    },
  }
  const { opts: sessionOpts, deps } = meeting()
  const session = new MeetingSession(ws as any, sessionOpts, {
    ...deps,
    brain: brain as any,
    bridge: { notify: () => {}, ask: async () => null } as any,
    brief: () => '',
    flux: () => flux as any,
    speak: opts.speak ?? (async function* () { yield Buffer.from([0, 1]) }),
    replyWindowMs: opts.replyWindowMs,
    calledWindowMs: opts.calledWindowMs,
  })
  return { ws, flux, answered, session }
}

const settle = () => new Promise(r => setTimeout(r, 30))
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * A session whose Claude hands a line to Sam's session when handOff(line) is true, and otherwise
 * answers "Answer to: <line>" itself. Sam's session answers when the test calls answer(). spoken lists what
 * Alex started to say.
 */
function setupHandoff(handOff: (line: string) => boolean) {
  const ws = new FakeSocket()
  const flux = new FakeFlux()
  const answered: string[] = []
  const spoken: string[] = []
  let answer!: (a: SessionAnswer | null) => void
  const brain = {
    async *respond({ latest }: { latest: string }): AsyncGenerator<BrainEvent> {
      answered.push(latest)
      yield handOff(latest) ? { kind: 'ask_session', question: latest } : { kind: 'say', text: `Answer to: ${latest}` }
    },
  }
  const { opts, deps } = meeting()
  const session = new MeetingSession(ws as any, opts, {
    ...deps,
    brain: brain as any,
    bridge: { notify: () => {}, ask: () => new Promise<SessionAnswer | null>(r => (answer = r)) } as any,
    brief: () => '',
    flux: () => flux as any,
    speak: async function* (text: string) {
      spoken.push(text)
      yield Buffer.from([0, 1])
    },
  })
  return { flux, answered, spoken, session, answer: (a: SessionAnswer | null) => answer(a) }
}

test('after Alex ends an answer on a question, the next thing said is taken as the reply, but only that line', async () => {
  const { flux, answered, session } = setup(line => (line.startsWith('Alex') ? 'Do you want the short version?' : 'It was a bad deploy.'))
  flux.endTurn('Alex, what happened with the outage?')
  await settle()
  flux.endTurn('Yes, the short one.')
  flux.endTurn('And we need the budget by Friday.') // the window is used up already
  await settle()
  assert.deepEqual(answered, ['Alex, what happened with the outage?', 'Yes, the short one.'])
  session.transcript.delete()
})

test('once the reply window has passed, a line without the name is not answered', async () => {
  const { flux, answered, session } = setup(() => 'Shall I go on?', { replyWindowMs: 60 })
  flux.endTurn('Alex, tell us about the pilot.')
  await settle()
  await wait(80)
  flux.endTurn('Yes, go on.')
  await settle()
  assert.deepEqual(answered, ['Alex, tell us about the pilot.'])
  session.transcript.delete()
})

test('after an answer that ends on a statement, a follow-up without the name is not answered', async () => {
  // Alex used to answer anything said in the 10 seconds after it spoke. Now only a question hands the turn back.
  const { flux, answered, session } = setup(() => 'It ships in March.')
  flux.endTurn('Alex, when does it ship?')
  await settle()
  flux.endTurn('And what about the budget?')
  flux.endTurn('Great, thanks.')
  await settle()
  assert.deepEqual(answered, ['Alex, when does it ship?'])
  session.transcript.delete()
})

test('"Alex?" on its own gets no answer, but the next line within the called window goes to Alex', async () => {
  const { flux, ws, answered, session } = setup(() => 'It ships in March.', { calledWindowMs: 200 })
  flux.endTurn('Alex?')
  await settle()
  assert.deepEqual(answered, [])
  assert.equal(ws.controls().some(c => c.type === 'speaking'), false, 'Alex says nothing to a call')
  flux.endTurn('When does it ship?')
  await settle()
  assert.deepEqual(answered, ['When does it ship?'])
  session.transcript.delete()
})

test('a line that only announces a question opens the called window, so the question in the next turn is answered', async () => {
  const { flux, ws, answered, session } = setup(() => 'There are three tiers.', { calledWindowMs: 200 })
  flux.endTurn('Alex, I have a question about pricing.')
  await settle()
  assert.deepEqual(answered, [])
  assert.equal(ws.controls().some(c => c.type === 'speaking'), false, 'Alex says nothing to the announcement')
  flux.endTurn('What are the tiers?')
  await settle()
  assert.deepEqual(answered, ['What are the tiers?'])
  session.transcript.delete()
})

test('an announcement in other words also opens the called window: "Alex, I have two questions."', async () => {
  const { flux, answered, session } = setup(() => 'It ships in March.', { calledWindowMs: 200 })
  flux.endTurn('Alex, I have two questions.')
  await settle()
  assert.deepEqual(answered, [])
  flux.endTurn("First, what's the timeline?")
  await settle()
  assert.deepEqual(answered, ["First, what's the timeline?"])
  session.transcript.delete()
})

test('"Alex, please wait." while Sam\'s session is checking is not a new question: its answer is still said', async () => {
  const { flux, answered, spoken, session, answer } = setupHandoff(line => line.includes('PR 9'))
  flux.endTurn('Alex, what is the status of PR 9?')
  await settle()
  flux.endTurn('Alex, please wait.')
  await settle()
  answer({ spoken: 'PR 9 was merged this morning.' })
  await settle()
  assert.deepEqual(answered, ['Alex, what is the status of PR 9?'])
  assert.equal(spoken[spoken.length - 1], 'PR 9 was merged this morning.')
  session.transcript.delete()
})

test('"Alex, can you hold on a second?" while Sam\'s session is checking is a wait, not a new question', async () => {
  const { flux, answered, spoken, session, answer } = setupHandoff(line => line.includes('PR 9'))
  flux.endTurn('Alex, what is the status of PR 9?')
  await settle()
  flux.endTurn('Alex, can you hold on a second?')
  await settle()
  answer({ spoken: 'PR 9 was merged this morning.' })
  await settle()
  assert.deepEqual(answered, ['Alex, what is the status of PR 9?'])
  assert.equal(spoken[spoken.length - 1], 'PR 9 was merged this morning.')
  session.transcript.delete()
})

test('"Alex, stop, OK?" while Alex is checking is not a new question to answer', async () => {
  const { flux, answered, session, answer } = setupHandoff(line => line.includes('PR 9'))
  flux.endTurn('Alex, what is the status of PR 9?')
  await settle()
  flux.endTurn('Alex, stop, OK?')
  await settle()
  // Whether the hand-off is called off is the cancel rule's call (text.ts); here, Alex starts no new answer.
  answer({ spoken: 'PR 9 was merged this morning.' })
  await settle()
  assert.deepEqual(answered, ['Alex, what is the status of PR 9?'])
  session.transcript.delete()
})

test('"Alex, forget that, what\'s the launch date?" while Sam\'s session is checking answers the new question instead', async () => {
  const { flux, answered, spoken, session, answer } = setupHandoff(line => line.includes('PR 9'))
  flux.endTurn('Alex, what is the status of PR 9?')
  await settle()
  flux.endTurn("Alex, forget that, what's the launch date?")
  await settle()
  answer({ spoken: 'PR 9 was merged this morning.' })
  await settle()
  assert.deepEqual(answered, ['Alex, what is the status of PR 9?', "Alex, forget that, what's the launch date?"])
  assert.ok(spoken.includes("Answer to: Alex, forget that, what's the launch date?"), 'the new question is answered')
  assert.ok(!spoken.includes('PR 9 was merged this morning.'), 'the called-off answer is not said')
  session.transcript.delete()
})

test('thanks, goodbyes and "stop" are not answered', async () => {
  const { flux, answered, session } = setup(() => 'It ships in March.')
  const lines = ["Thanks Alex, you've been very helpful.", 'Thanks Alex, take care.', 'Alex, please stop.', "Alex, don't answer that."]
  for (const line of lines) {
    flux.endTurn(line)
    await settle()
  }
  assert.deepEqual(answered, [])
  session.transcript.delete()
})

test('a line after the called window has passed is not answered', async () => {
  const { flux, answered, session } = setup(() => 'It ships in March.', { calledWindowMs: 60 })
  flux.endTurn('Alex?')
  await wait(100)
  flux.endTurn('When does it ship?')
  await settle()
  assert.deepEqual(answered, [])
  session.transcript.delete()
})

test('an answer that ends on a question but is talked over opens no window', async () => {
  // About 100 ms of speech, so the reply would have finished long before the next line.
  const slow = async function* (_text: string, signal?: AbortSignal) {
    for (let i = 0; i < 10 && !signal?.aborted; i++) {
      yield Buffer.from([0, 0])
      await wait(10)
    }
  }
  const { flux, ws, answered, session } = setup(() => 'There is a lot to it. Shall I go through all of it?', { speak: slow })
  flux.endTurn('Alex, explain everything')
  await settle()
  flux.startTurn() // someone talks over Alex
  await wait(150)
  assert.ok(ws.controls().some(c => c.type === 'clear'), 'the reply was cut off')
  flux.endTurn('No, we need to move on.')
  await settle()
  assert.deepEqual(answered, ['Alex, explain everything'])
  session.transcript.delete()
})

test('"um" does not use up an open window, though it is in the transcript', async () => {
  const { flux, answered, session } = setup(line => (line.startsWith('Alex') ? 'Do you want the details?' : 'Here they are.'))
  flux.endTurn('Alex, how did the pilot go?')
  await settle()
  flux.endTurn('um')
  flux.endTurn('Yes, the details please.')
  await settle()
  assert.deepEqual(answered, ['Alex, how did the pilot go?', 'Yes, the details please.'])
  assert.match(session.transcript.recent(), /Speaker: um\n/)
  session.transcript.delete()
})

test('talking about Alex, or thanking it, is not answered', async () => {
  const { flux, answered, session } = setup(() => 'It ships in March.')
  flux.endTurn('I asked Alex yesterday.')
  flux.endTurn('Alex, when does it ship?')
  await settle()
  flux.endTurn('Thanks, Alex.')
  await settle()
  assert.deepEqual(answered, ['Alex, when does it ship?'])
  session.transcript.delete()
})

test('of a run of lines, only those asked of Alex, and the replies in a window he opened, are answered', async () => {
  const { flux, answered, session } = setup(line => (line.startsWith('Alex,') ? 'Shall I go on?' : 'Fine.'))
  for (const line of ['we should ship soon', 'I asked Alex yesterday.', 'Thanks, Alex.', 'Alex?', 'When does it ship?', 'Alex, what is the plan?', 'Yes, go on.']) {
    flux.endTurn(line)
    await settle()
  }
  // No name, talked about, thanked: ignored. "Alex?" opens a window for the next line, and "Shall I go on?" another.
  assert.deepEqual(answered, ['When does it ship?', 'Alex, what is the plan?', 'Yes, go on.'])
  session.transcript.delete()
})
