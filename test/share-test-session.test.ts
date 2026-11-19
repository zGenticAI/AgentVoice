// The meeting session's part in the screen-share test: when the consent line is done, the test line through the normal
// speech path (after the consent line, cut off by "never mind", failing, or with no page), and leaving as on "please
// leave". Deepgram, ElevenLabs, Claude and Recall are fakes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import type { ToSession } from '../src/bridge.ts'
import { JOIN_LINE, LEAVE_LINE } from '../src/consent.ts'
import { MeetingSession } from '../src/pipeline/session.ts'
import { testLine } from '../src/sharetest/protocol.ts'

class FakeSocket extends EventEmitter {
  readyState = 1
  sent: (Buffer | string)[] = []
  send(data: Buffer | string) {
    this.sent.push(data)
  }
  close() {
    this.readyState = 3
  }
  terminate() {
    this.readyState = 3
  }
  controls() {
    return this.sent.filter(d => typeof d === 'string').map(d => JSON.parse(d as string))
  }
}

class FakeFlux extends EventEmitter {
  closed = false
  send() {}
  close() {
    if (this.closed) return
    this.closed = true
    setImmediate(() => this.emit('close', 1000, ''))
  }
  endTurn(text: string) {
    this.emit('turn', { type: 'TurnInfo', event: 'EndOfTurn', turn_index: 0, transcript: text })
  }
}

let meetings = 0
const settle = (ms = 20) => new Promise(r => setTimeout(r, ms))
async function until(ok: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries && !ok(); i++) await settle(10)
}

type Speak = (text: string, signal?: AbortSignal) => AsyncGenerator<Buffer>

function setup(opts: { speak?: Speak; greetDelayMs?: number; reconnectMs?: number } = {}) {
  const ws = new FakeSocket()
  const flux = new FakeFlux()
  const spoken: string[] = []
  const events: ToSession[] = []
  const left: string[] = []
  const meetingKey = `share-test-${process.pid}-${++meetings}`
  const botId = `bot-${meetingKey}`
  const session = new MeetingSession(ws as any, { meetingKey, botId, platform: 'Zoom' }, {
    brain: { async *respond() {} } as any,
    bridge: { ask: async () => null, notify: (m: ToSession) => void events.push(m) } as any,
    brief: () => '',
    flux: () => flux as any,
    // A tenth of a second of voice for each line.
    speak:
      opts.speak ??
      async function* (text: string) {
        spoken.push(text)
        yield Buffer.alloc(3200)
      },
    recall: {
      sendChat: async () => {},
      leaveCall: async (id: string) => void left.push(id),
      deleteMedia: async () => true,
      howBotEnded: async () => ({ kind: 'ended', sub_code: 'bot_received_leave_call' }) as const,
    },
    writeMinutes: async () => Promise.reject(new Error('no minutes in these tests')),
    greetDelayMs: opts.greetDelayMs ?? 0,
    sttFlushMs: 0,
    leaveDelayMs: 0,
    reconnectMs: opts.reconnectMs ?? 0,
  })
  const ended = () => events.find(e => e.type === 'meeting_ended') as Extract<ToSession, { type: 'meeting_ended' }> | undefined
  return { ws, flux, spoken, events, left, botId, session, ended }
}

test('the test line waits for the consent line, goes through the transcript and the page, and says when it has played', async () => {
  const s = setup()
  assert.equal(s.session.consentDone, false)
  await until(() => s.spoken.includes(JOIN_LINE))
  const line = testLine('Alex', true)
  const said = await s.session.sayTestLine(line)
  assert.equal(said, 'played')
  assert.equal(s.session.consentDone, true)
  assert.deepEqual(s.spoken, [JOIN_LINE, line], 'after the consent line, never over it')
  assert.match(s.session.transcript.recent(), /Alex: This is Alex\. I'm testing my voice while my screen is shared\./)
  const speaking = s.ws.controls().filter(c => c.type === 'speaking').map(c => c.on)
  assert.deepEqual(speaking, [true, false, true, false])
  s.session.transcript.delete()
  s.session.end()
})

test('"never mind" stops the test line as it stops an answer; a voice that fails, or no page, says so', async () => {
  // A line that goes out slowly, until it is stopped.
  const slow = setup({
    speak: async function* (text: string, signal?: AbortSignal) {
      yield Buffer.alloc(3200)
      if (text === JOIN_LINE) return
      await new Promise(resolve => (signal?.aborted ? resolve(null) : signal?.addEventListener('abort', resolve, { once: true })))
    },
  })
  await until(() => slow.session.consentDone)
  const saying = slow.session.sayTestLine(testLine('Alex', true))
  await settle()
  slow.flux.endTurn('Alex, never mind.')
  assert.equal(await saying, 'cut_off')
  assert.ok(slow.ws.controls().some(c => c.type === 'clear'))
  slow.session.transcript.delete()
  slow.session.end()

  const failing = setup({
    speak: async function* (text: string) {
      if (text !== JOIN_LINE) throw new Error('ElevenLabs refused')
      yield Buffer.alloc(3200)
    },
  })
  await until(() => failing.session.consentDone)
  assert.equal(await failing.session.sayTestLine(testLine('Alex', false)), 'failed')
  failing.session.transcript.delete()
  failing.session.end()

  // The page is away: nothing is said into it.
  const away = setup({ reconnectMs: 60_000 })
  await until(() => away.session.consentDone)
  away.ws.emit('close')
  assert.equal(await away.session.sayTestLine(testLine('Alex', true)), 'no_page')
  away.session.end()
  assert.equal(await away.session.sayTestLine(testLine('Alex', true)), 'not_now')
  away.session.transcript.delete()
})

test('the test line stopped after its turn is over, while the page still plays it ("never mind"), is cut off, not played to the end', async () => {
  // All of it goes out at once: about a second of voice in one piece, so the turn ends before the page has played it.
  const s = setup({
    speak: async function* (text: string) {
      yield Buffer.alloc(text === JOIN_LINE ? 3200 : 32_000)
    },
  })
  await until(() => s.session.consentDone)
  const saying = s.session.sayTestLine(testLine('Alex', true))
  await settle(200)
  const clearsBefore = s.ws.controls().filter(c => c.type === 'clear').length
  s.flux.endTurn('Alex, never mind.')
  assert.equal(await saying, 'cut_off')
  assert.ok(s.ws.controls().filter(c => c.type === 'clear').length > clearsBefore, 'the page was cleared')
  s.session.transcript.delete()
  s.session.end()
})

test('leaving at the end of the test is "please leave": the goodbye, the transcript deleted, no minutes, the bot out', async () => {
  const s = setup()
  await until(() => s.session.consentDone)
  s.flux.endTurn('We agreed the pilot starts in March.')
  await settle()
  s.session.leaveAsAsked()
  s.session.leaveAsAsked() // a second time changes nothing
  await until(() => s.ended() !== undefined)
  assert.deepEqual(s.spoken, [JOIN_LINE, LEAVE_LINE])
  assert.deepEqual(s.left, [s.botId])
  assert.equal(s.session.leftMeeting, true)
  assert.equal(fs.existsSync(s.session.transcript.file), false, 'the transcript is deleted')
  const e = s.ended()!
  assert.equal(e.transcript_file, '')
  assert.equal(e.minutes_file, '')
  assert.match(e.no_minutes ?? '', /asked to leave/)
  assert.equal(await s.session.sayTestLine(testLine('Alex', false)), 'not_now')
})
