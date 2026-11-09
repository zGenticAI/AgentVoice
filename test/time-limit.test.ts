import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { MeetingSession, timeLimitLine } from '../src/pipeline/session.ts'
import type { ToSession } from '../src/bridge.ts'

class FakeSocket extends EventEmitter {
  readyState = 1
  send() {}
  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit('close')
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

let bots = 0

/** A bot session with fakes for Recall, Claude and the session bridge, as one in a real meeting. */
function botSession() {
  const ws = new FakeSocket()
  const flux = new FakeFlux()
  const botId = `limit-bot-${process.pid}-${++bots}`
  const calls: string[] = []
  const chat: string[] = []
  const events: ToSession[] = []
  let minutes = 0
  const session = new MeetingSession(ws as any, { meetingKey: `key-${botId}`, botId, platform: 'Zoom' }, {
    brain: { async *respond() {} } as any,
    bridge: { notify: (m: ToSession) => void events.push(m), ask: async () => null } as any,
    brief: () => '',
    flux: () => flux as any,
    speak: async function* () {
      yield Buffer.from([0, 1])
    },
    recall: {
      sendChat: async (_id: string, message: string) => void (calls.push('chat'), chat.push(message)),
      leaveCall: async () => void calls.push('leave'),
      deleteMedia: async () => true,
      // Recall's word when the service asked the bot to leave: a normal end.
      howBotEnded: async () => ({ kind: 'ended', sub_code: 'bot_received_leave_call' }) as const,
    },
    writeMinutes: async () => (minutes++, '/tmp/minutes-of-the-limit-test.md'),
    greetDelayMs: 60_000,
    leaveDelayMs: 0,
    sttFlushMs: 10,
  })
  const ended = () => events.find(e => e.type === 'meeting_ended') as Extract<ToSession, { type: 'meeting_ended' }> | undefined
  return { ws, flux, botId, calls, chat, ended, minutes: () => minutes, session }
}

async function until(ok: () => boolean, tries = 100): Promise<void> {
  for (let i = 0; i < tries && !ok(); i++) await new Promise(r => setTimeout(r, 10))
}

test('at the time limit the bot posts one chat line, then leaves the call, and the meeting gets its minutes', async () => {
  const { flux, calls, chat, ended, minutes, session } = botSession()
  flux.endTurn('We agreed the pilot starts in March.')
  await session.reachedTimeLimit(180)
  assert.deepEqual(chat, [timeLimitLine(180)])
  assert.match(chat[0], /time limit for one meeting \(180 minutes\)/)
  assert.deepEqual(calls, ['chat', 'leave'], 'the line goes out first, then the bot leaves the call')
  await until(() => ended() !== undefined)
  assert.equal(ended()!.minutes_file, '/tmp/minutes-of-the-limit-test.md', 'a normal end: the meeting gets its minutes')
  assert.equal(minutes(), 1)
  assert.ok(fs.existsSync(session.transcript.file), 'and the transcript is kept')
  await session.reachedTimeLimit(180)
  assert.equal(chat.length, 1, 'only once')
  session.transcript.delete()
})

test('after "please leave" the time limit posts nothing more in the meeting', async () => {
  const { flux, chat, ended, minutes, session } = botSession()
  flux.endTurn('We agreed the pilot starts in March.')
  flux.endTurn('Alex, please leave.')
  await session.reachedTimeLimit(180)
  assert.deepEqual(chat, [], 'nothing is posted once someone has asked the bot to leave')
  await until(() => ended() !== undefined)
  assert.equal(ended()!.transcript_file, '')
  assert.equal(minutes(), 0)
})
