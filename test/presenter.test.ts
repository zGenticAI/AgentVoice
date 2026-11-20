// The Presenter in a real MeetingSession, with the session tests' fakes (the page's socket, Flux, the brain and the
// voice), a fake SlideSurface, and short timings: the consent line first, the start and its check question, the script
// in order and word for word, holds and how each resumes, commands and who may give them, the share's own problems,
// the ending, and that a meeting without slides is exactly as it was.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { BrainEvent } from '../src/brain/brain.ts'
import type { ToSession } from '../src/bridge.ts'
import { JOIN_LINE, LEAVE_LINE, SLIDES_LINES } from '../src/consent.ts'
import { SLIDES_LABEL } from '../src/identity.ts'
import { MeetingSession, type SessionSlides } from '../src/pipeline/session.ts'
import type { OwnerAction, PresentationEvent, PresenterSlide, PresenterTiming } from '../src/slides/presenter.ts'
import { presenterSlides } from '../src/slides/presenter.ts'
import { parseScript } from '../src/slides/script.ts'
import type { ShareEvent, SlideSurface, StartOutcome } from '../src/slides/surface.ts'

class FakeSocket extends EventEmitter {
  readyState = 1
  sent: (Buffer | string)[] = []
  /** The page's controls, and when each was sent. */
  controls: { type: string; at: number }[] = []
  send(data: Buffer | string) {
    this.sent.push(data)
    if (typeof data === 'string') this.controls.push({ type: JSON.parse(data).type, at: Date.now() })
  }
  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit('close', 1005, Buffer.from(''))
  }
  terminate() {
    this.close()
  }
  drop() {
    this.readyState = 3
    this.emit('close', 1006, Buffer.from(''))
  }
}

class FakeFlux extends EventEmitter {
  closed = false
  send() {}
  close() {
    if (this.closed) return
    this.closed = true
    setImmediate(() => this.emit('close', 1005, ''))
  }
  forceEndTurn() {}
  turn(event: string, transcript: string) {
    this.emit('turn', { type: 'TurnInfo', event, turn_index: 0, transcript })
  }
}

/** Stands in for the share: what was asked of it, in order, and what it answers. */
class FakeSurface implements SlideSurface {
  state: SlideSurface['state'] = 'off'
  readonly calls: string[] = []
  startOutcome: StartOutcome = 'loaded'
  showOutcome: 'shown' | 'timeout' = 'shown'
  /** Throws or rejects on each call when set. */
  broken: 'throw' | 'reject' | null = null
  private readonly listeners = new Map<ShareEvent, (() => void)[]>()
  constructor(readonly count: number) {}
  start(at: number) {
    this.calls.push(`start ${at}`)
    return this.answer(() => {
      if (this.startOutcome === 'loaded') this.state = 'loaded'
      return this.startOutcome
    })
  }
  show(i: number) {
    this.calls.push(`show ${i}`)
    return this.answer(() => this.showOutcome)
  }
  frame(kind: string) {
    this.calls.push(`frame ${kind}`)
  }
  stop() {
    this.calls.push('stop')
    return this.answer(() => void (this.state = 'off'))
  }
  close() {
    this.calls.push('close')
    if (this.broken === 'throw') throw new Error('surface broke')
    this.state = 'off'
  }
  on(event: ShareEvent, fn: () => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn])
  }
  fire(event: ShareEvent) {
    for (const fn of this.listeners.get(event) ?? []) fn()
  }
  /** The answer, or a throw as the call is made, or a rejection, as the test says. */
  private answer<T>(value: () => T): Promise<T> {
    if (this.broken === 'throw') throw new Error('surface broke')
    if (this.broken === 'reject') return Promise.reject(new Error('surface rejected'))
    return Promise.resolve(value())
  }
}

// The test deck: five pages, page 3 excluded (not in the meeting), page 4 a backup slide.
const SCRIPT = `---
deck: test-deck-abcdef
title: Q4 plan
---

## 1 · Welcome

Hello everyone. This is the plan.

## 2 · Pricing

Team is twelve dollars. Business is twenty-nine. Any questions so far?

## 3 · Customers
exclude: yes

## 4 · Security
on-request: yes

Here are the security details.

## 5 · Next steps

We ship in March. Thank you.
`

const MANIFEST = {
  format: 1 as const,
  id: 'test-deck-abcdef',
  label: 'test',
  created: '2026-11-19T10:00:00Z',
  pages: 5,
  excluded: 0,
  script: null,
  slides: [1, 2, 3, 4, 5].map(n => ({
    n,
    title: ['Welcome', 'Pricing', 'Customers', 'Security', 'Next steps'][n - 1],
    pageLabel: null,
    text: '',
    file: `00${n}.webp`,
    bytes: 1,
    sha256: '0'.repeat(64),
    textHash: '0'.repeat(64),
    warnings: [],
  })),
}

const SLIDES: PresenterSlide[] = presenterSlides(parseScript(SCRIPT).script!, MANIFEST)

const FAST: Partial<PresenterTiming> = {
  tickMs: 5,
  leadMs: 10,
  slideQuietMs: 20,
  questionQuietMs: 40,
  talkQuietMs: 40,
  carryOnWindowMs: 150,
  canSeeDelayMs: 10,
  canSeeWindowMs: 200,
  canSeeQuietMs: 40,
  pageBackMs: 20,
  voiceRetryMs: 10,
  longHoldMs: 20_000,
  heldLongMs: 400,
  qaIdleMs: 300,
}

let meetings = 0

interface Options {
  answers?: BrainEvent[][]
  /** Lines whose voice fails, every time. */
  failing?: Set<string>
  /** ms of voice for a line: 20 unless given. */
  voice?: Record<string, number>
  slides?: false
  timing?: Partial<PresenterTiming>
  from?: number
  /** ms before a line's voice comes back from ElevenLabs: none unless given. */
  latency?: number
}

function start(opts: Options = {}) {
  const ws = new FakeSocket()
  const flux = new FakeFlux()
  const surface = new FakeSurface(SLIDES.length)
  const answers = [...(opts.answers ?? [])]
  const answered: string[] = []
  // What the brain was given for each answer, and what went to the owner's session.
  const inputs: any[] = []
  const asked: any[] = []
  const minutes: any[] = []
  const spoken: string[] = []
  const notified: ToSession[] = []
  const events: PresentationEvent[] = []
  const slides: SessionSlides | undefined =
    opts.slides === false ? undefined : { surface, slides: SLIDES, platform: 'zoom', from: opts.from, title: 'Q4 plan', timing: { ...FAST, ...opts.timing } }
  const session = new MeetingSession(ws as any, { meetingKey: `presenter-${process.pid}-${++meetings}`, botId: `bot-${meetings}` }, {
    brain: {
      async *respond(i: { latest: string }) {
        answered.push(i.latest)
        inputs.push(i)
        for (const e of answers.shift() ?? []) yield e
      },
    } as any,
    bridge: {
      ask: async (q: unknown) => {
        asked.push(q)
        return null
      },
      notify: (m: ToSession) => void notified.push(m),
    } as any,
    brief: () => '',
    flux: () => flux as any,
    speak: async function* (text: string) {
      spoken.push(text)
      if (opts.failing?.has(text)) throw new Error('voice failed')
      if (opts.latency) await wait(opts.latency)
      yield Buffer.alloc((opts.voice?.[text] ?? 20) * 32)
    },
    recall: {
      sendChat: async () => {},
      leaveCall: async () => {},
      deleteMedia: async () => true,
      howBotEnded: async () => ({ kind: 'ended', sub_code: 'bot_received_leave_call' }) as const,
    },
    writeMinutes: async (input: unknown) => {
      minutes.push(input)
      return '/tmp/minutes.md'
    },
    greetDelayMs: 5,
    sttFlushMs: 0,
    leaveDelayMs: 0,
    pauseMaxMs: 60_000,
    reconnectMs: 60_000,
    slides,
  })
  session.presenter?.onEvent(e => void events.push(e))
  /** A line said in a quiet room: its turn starts and ends. */
  const said = (text: string) => {
    flux.turn('StartOfTurn', '')
    flux.turn('EndOfTurn', text)
  }
  const alex = () => session.transcript.lines.filter(l => l.role === 'agent' && l.speaker !== SLIDES_LABEL).map(l => l.text)
  const markers = () => session.transcript.lines.filter(l => l.speaker === SLIDES_LABEL).map(l => l.text)
  const after = (line: string) => spoken.slice(spoken.lastIndexOf(line) + 1)
  /** The line said after `line`, once both have been said. */
  const next = (line: string): string | undefined => (spoken.includes(line) ? after(line)[0] : undefined)
  return { ws, flux, surface, session, answered, inputs, asked, minutes, spoken, notified, events, said, alex, markers, after, next, presenter: session.presenter! }
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(ok: () => boolean, what = 'the condition', ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await wait(5)
  }
}
const done = (s: ReturnType<typeof start>) => {
  s.session.end()
  s.session.transcript.delete()
}

/** The consent line said, then the presentation started by the room, checked, and narrating. */
async function narrating(s: ReturnType<typeof start>) {
  await until(() => s.session.consentDone, 'the consent line')
  s.said('Alex, start the presentation.')
  await until(() => s.spoken.includes(SLIDES_LINES.canSee), 'the check question')
  await until(() => s.presenter.current === 'narrating', 'narration')
}

// --- A meeting without slides ---------------------------------------------------------------------------------------

test('a meeting without slides has no presenter, today\'s consent line, and reads slide commands as it always did', async () => {
  const s = start({ slides: false, answers: [[{ kind: 'say', text: 'Slide five is pricing.' }]] })
  assert.equal(s.session.presenter, null)
  await until(() => s.session.consentDone)
  assert.deepEqual(s.spoken, [JOIN_LINE])
  s.said('Alex, next slide.')
  s.said('Alex, go to slide 5.')
  await until(() => s.answered.length === 1)
  assert.deepEqual(s.answered, ['Alex, go to slide 5.'], '"next slide" is nothing asked, "go to slide 5" a question: as before')
  const why = s.session.whyNotAnswered(5).lines!
  assert.deepEqual(why.map(l => l.read), ['nothing_asked', 'asked'])
  assert.equal(s.markers().length, 0)
  done(s)
})

// --- Starting --------------------------------------------------------------------------------------------------------

test('the consent line comes first: a start said during it waits for it, then the line, the share, the check, the script', async () => {
  const s = start()
  // Said as the consent line starts.
  await until(() => s.spoken.length === 1)
  s.said('Alex, start the presentation.')
  await until(() => s.presenter.current === 'qa', 'the end of the deck', 5000)
  assert.equal(s.spoken[0], SLIDES_LINES.join, 'the consent line of a meeting with slides')
  assert.deepEqual(s.spoken.slice(1, 3), [SLIDES_LINES.sharing, SLIDES_LINES.canSee])
  assert.deepEqual(s.after(SLIDES_LINES.canSee), [
    'Hello everyone.',
    'This is the plan.',
    'Team is twelve dollars.',
    'Business is twenty-nine.',
    'Any questions so far?',
    'We ship in March.',
    'Thank you.',
  ], 'the script word for word, in order: the backup slide skipped, the excluded one not in the meeting')
  assert.deepEqual(s.surface.calls, ['start 0', 'show 1', 'show 3'])
  assert.deepEqual(s.markers(), ['showing slide 1: Welcome', 'showing slide 2: Pricing', 'showing slide 5: Next steps'])
  assert.deepEqual(s.events.map(e => e.event), ['started', 'finished'])
  assert.deepEqual(s.events[0], { event: 'started', of: 4, note: 'The presentation started.', slide: 1, title: 'Welcome' })
  // The command is not a question: never in the questions the meeting asked.
  s.session.end()
  await until(() => s.notified.some(n => n.type === 'meeting_ended'))
  const ended = s.notified.find(n => n.type === 'meeting_ended') as Extract<ToSession, { type: 'meeting_ended' }>
  assert.deepEqual(ended.questions, [])
  assert.ok(s.surface.calls.includes('close'), 'the session ending closes the share, with no stop')
  assert.ok(!s.surface.calls.includes('stop'))
  s.session.transcript.delete()
})

test('a "no" to "Can everyone see my slides?" gives the platform hint, stops the share and keeps the bookmark', async () => {
  const s = start({ timing: { canSeeQuietMs: 3000, canSeeWindowMs: 5000 } })
  await until(() => s.session.consentDone)
  s.said('Alex, start the presentation.')
  await until(() => s.spoken.includes(SLIDES_LINES.canSee))
  await wait(30)
  s.said("No, we can't see anything.")
  await until(() => s.events.some(e => e.event === 'not_seen'))
  assert.deepEqual(s.after(SLIDES_LINES.canSee), [SLIDES_LINES.hints.zoom])
  assert.deepEqual(s.surface.calls, ['start 0', 'stop'])
  assert.equal(s.presenter.current, 'ready')
  assert.equal(s.answered.length, 0, 'the answer to its own question is not a question')
  // Started again: no second check question.
  s.said('Alex, start the presentation.')
  await until(() => s.presenter.current === 'narrating')
  assert.equal(s.spoken.filter(l => l === SLIDES_LINES.canSee).length, 1)
  done(s)
})

test('a share Recall refused, or that never loaded: the line, back to ready, and the event', async () => {
  for (const [outcome, line, event] of [
    ['failed', SLIDES_LINES.shareFailed, 'share_failed'],
    ['not_loading', SLIDES_LINES.notLoading, 'not_loading'],
    ['rate_limited', SLIDES_LINES.rateLimited, 'rate_limited'],
  ] as const) {
    const s = start()
    s.surface.startOutcome = outcome
    await until(() => s.session.consentDone)
    s.said('Alex, start the presentation.')
    await until(() => s.events.some(e => e.event === event), event)
    await until(() => s.spoken.includes(line), line)
    assert.equal(s.presenter.current, 'ready')
    assert.ok(!s.spoken.includes(SLIDES_LINES.canSee))
    done(s)
  }
})

// --- Holds -------------------------------------------------------------------------------------------------------

test('the next slide comes only once the last sentence has played and the room is quiet: never while someone talks', async () => {
  const s = start({ voice: { 'This is the plan.': 300 } })
  await narrating(s)
  await until(() => s.spoken.includes('This is the plan.'))
  // Someone starts talking as the slide's last sentence ends, and goes on.
  await wait(150)
  s.flux.turn('StartOfTurn', '')
  await wait(200)
  assert.deepEqual(s.surface.calls, ['start 0'], 'slide 2 waits')
  s.flux.turn('EndOfTurn', 'Mm-hm.')
  await until(() => s.surface.calls.includes('show 1'))
  await until(() => s.spoken.includes('Team is twelve dollars.'), 'the next slide talked about only once it is up')
  done(s)
})

// The sentence talked over plays for 1.5 s, so someone talking pauses it, and words stop it there.
const LONG = { 'Team is twelve dollars.': 1500 }

// The deck's narration, every sentence: none of it may be said while it may not narrate.
const NARRATION = ['Hello everyone.', 'This is the plan.', 'Team is twelve dollars.', 'Business is twenty-nine.', 'Any questions so far?', 'Here are the security details.', 'We ship in March.', 'Thank you.']

test('talked over: it stops at that sentence, asks "Shall I carry on?" once the room is quiet, and silence carries on there', async () => {
  const s = start({ voice: LONG })
  await narrating(s)
  await until(() => s.spoken.includes('Team is twelve dollars.'))
  await wait(300)
  s.flux.turn('StartOfTurn', '')
  s.flux.turn('EndOfTurn', "That's interesting.")
  assert.equal(s.presenter.status().held, 'talk')
  assert.ok(!s.alex().includes('Team is twelve dollars.'), 'the transcript keeps only what was heard of it')
  await until(() => s.spoken.includes(SLIDES_LINES.shallCarryOn), 'the question')
  await until(() => s.spoken.includes(SLIDES_LINES.carryOn), 'silence is a yes')
  await until(() => s.after(SLIDES_LINES.carryOn).length > 0)
  assert.equal(s.after(SLIDES_LINES.carryOn)[0], 'Team is twelve dollars.', 'the sentence it stopped at, said again in full')
  assert.equal(s.spoken.filter(l => l === SLIDES_LINES.shallCarryOn).length, 1, 'asked once')
  assert.equal(s.answered.length, 0)
  done(s)
})

test('"no" to "Shall I carry on?" holds until "carry on"; "yes" carries on at once', async () => {
  const s = start({ voice: LONG, timing: { carryOnWindowMs: 2000 } })
  await narrating(s)
  await until(() => s.spoken.includes('Team is twelve dollars.'))
  await wait(300)
  s.flux.turn('StartOfTurn', '')
  s.flux.turn('EndOfTurn', 'Sorry, one thing first.')
  await until(() => s.spoken.includes(SLIDES_LINES.shallCarryOn))
  await wait(30)
  s.said('Not yet.')
  await until(() => s.presenter.status().held === 'asked')
  await wait(100)
  assert.ok(!s.spoken.includes(SLIDES_LINES.carryOn))
  s.said('Alex, carry on.')
  await until(() => s.after(SLIDES_LINES.shallCarryOn).includes('Team is twelve dollars.'))
  done(s)
})

test('a question mid-narration is answered, then "Back to <title>." and the sentence it stopped at', async () => {
  const s = start({ voice: LONG, answers: [[{ kind: 'say', text: 'It is per user, per month.' }]] })
  await narrating(s)
  await until(() => s.spoken.includes('Team is twelve dollars.'))
  await wait(300)
  s.flux.turn('StartOfTurn', '')
  s.flux.turn('EndOfTurn', 'Alex, is that per month?')
  await until(() => s.spoken.includes('Back to Pricing.'), 'back to the slide')
  assert.deepEqual(s.answered, ['Alex, is that per month?'])
  const after = s.spoken.slice(s.spoken.indexOf('It is per user, per month.'))
  assert.equal(after[1], 'Back to Pricing.')
  await until(() => s.after('Back to Pricing.').length > 0)
  assert.equal(s.after('Back to Pricing.')[0], 'Team is twelve dollars.')
  assert.ok(!s.spoken.includes(SLIDES_LINES.shallCarryOn), 'a question is not side talk')
  done(s)
})

test('a question asked in a quiet moment, after a slide was heard in full, goes on to the next slide with no "Back to"', async () => {
  const s = start({ answers: [[{ kind: 'say', text: 'Yes.' }]], timing: { slideQuietMs: 400 } })
  await narrating(s)
  await until(() => s.spoken.includes('This is the plan.'))
  await wait(150)
  s.said('Alex, is this recorded?')
  await until(() => s.spoken.includes('Team is twelve dollars.'))
  assert.ok(!s.spoken.some(l => l.startsWith('Back to')))
  done(s)
})

test('"Alex, pause" holds until "Alex, carry on"; the owner\'s pause is sticky: only the owner resumes it', async () => {
  const s = start()
  await narrating(s)
  s.said('Alex, pause.')
  await until(() => s.presenter.status().held === 'asked')
  const count = s.spoken.length
  await wait(200)
  assert.equal(s.spoken.length, count, 'nothing more while paused')
  s.said('Alex, carry on.')
  await until(() => s.presenter.current === 'narrating')
  await until(() => s.spoken.length > count)
  // The owner's pause.
  assert.deepEqual(s.presenter.owner('pause'), { ok: true, note: 'Paused. Only you can resume it.' })
  assert.equal(s.presenter.status().held, 'owner')
  s.said('Alex, carry on.')
  await until(() => s.spoken.includes(SLIDES_LINES.waitForOwner))
  assert.equal(s.presenter.status().held, 'owner')
  s.said('Alex, pause.')
  assert.equal(s.presenter.status().held, 'owner')
  assert.equal(s.presenter.owner('resume').ok, true)
  await until(() => s.presenter.current === 'narrating')
  done(s)
})

test('a detour keeps the bookmark: "go back" shows the slide before, "carry on" returns to the bookmark with "Back to"', async () => {
  const s = start()
  await narrating(s)
  await until(() => s.spoken.includes('Team is twelve dollars.'))
  s.said('Alex, go back.')
  await until(() => s.spoken.includes("Here's slide 1."))
  assert.equal(s.presenter.status().detour, true)
  assert.equal(s.presenter.status().slide, 1)
  assert.equal(s.presenter.status().bookmark, 2)
  s.said('Alex, carry on.')
  await until(() => s.spoken.includes('Back to Pricing.'))
  assert.equal(s.presenter.status().slide, 2)
  done(s)
})

test('go to slide N: an excluded one is refused, a backup slide is a detour, one ahead is a move', async () => {
  const s = start()
  await narrating(s)
  s.said('Alex, go to slide 3.')
  await until(() => s.spoken.includes("I don't have slide 3 to show."))
  s.said('Alex, go to slide 4.')
  await until(() => s.spoken.includes("Here's slide 4."))
  assert.equal(s.presenter.status().slide, 4)
  assert.equal(s.presenter.status().detour, true)
  s.said('Alex, go to slide 5.')
  await until(() => s.spoken.includes('We ship in March.'))
  assert.equal(s.presenter.status().bookmark, 5)
  const why = s.session.whyNotAnswered(10).lines!
  assert.ok(why.some(l => l.read === 'slides' && l.did === 'slide_command' && /go to slide 3/.test(l.why)))
  assert.equal(s.answered.length, 0)
  done(s)
})

test('the camera page away holds the slides; 2 s after it is back, "Back to <title>." and the sentence', async () => {
  const s = start()
  await narrating(s)
  await until(() => s.spoken.includes('Team is twelve dollars.'))
  s.ws.drop()
  assert.equal(s.presenter.status().held, 'page_away')
  const page = new FakeSocket()
  s.session.attach(page as any, {})
  await until(() => s.spoken.includes('Back to Pricing.'))
  done(s)
})

test('speech recognition lost: the sentence ends, the fixed line is said, and nothing more until hearing is back', async () => {
  const s = start()
  await narrating(s)
  s.flux.emit('lost', 'test')
  await until(() => s.spoken.includes(SLIDES_LINES.deaf))
  assert.equal(s.presenter.status().held, 'deaf')
  const count = s.spoken.length
  await wait(150)
  assert.equal(s.spoken.length, count, 'it never talks on when it cannot hear')
  s.flux.emit('open')
  await until(() => s.spoken.includes(SLIDES_LINES.shallCarryOn))
  await until(() => s.spoken.includes(SLIDES_LINES.carryOn))
  assert.ok(s.events.some(e => e.event === 'deaf'))
  done(s)
})

// Slide 2's sentences play for 600 ms each, and all three go out to the page at once, well ahead of what it plays.
const QUEUED = { 'Team is twelve dollars.': 600, 'Business is twenty-nine.': 600, 'Any questions so far?': 600 }

test('speech recognition lost: the page stops at the end of the sentence it plays, not of what went out, and carries on from there', async () => {
  const s = start({ voice: QUEUED })
  await narrating(s)
  const playback = (s.session as any).playback
  const line = (text: string) => playback.following.find((p: any) => p.text === text)
  await until(() => s.spoken.includes('Any questions so far?') && line('Team is twelve dollars.')?.runs[0]?.[0] < Date.now() - 50, 'slide 2 sent, and playing')
  const ends = line('Team is twelve dollars.').runs.at(-1)[1]
  assert.ok(ends > Date.now() && playback.playsUntil - ends > 1000, 'the next two sentences are queued at the page')
  const from = s.ws.controls.length
  s.flux.emit('lost', 'test')
  assert.equal(s.presenter.status().held, 'deaf', 'held at once: nothing more goes out')
  await until(() => s.spoken.includes(SLIDES_LINES.deaf), 'the fixed line')
  const clear = s.ws.controls.slice(from).find(c => c.type === 'clear')
  assert.ok(clear, 'the page is told to clear what it still has')
  assert.ok(clear.at >= ends - 20 && clear.at <= ends + 100, `at the end of the sentence it was playing (${clear.at - ends} ms)`)
  assert.ok(line(SLIDES_LINES.deaf).runs[0][0] - ends < 200, 'the fixed line plays straight after that sentence')
  assert.ok(playback.playsUntil - ends < 1000, 'and nothing of the narration after it')
  // What the meeting did not hear is not in the transcript, and narration carries on from it.
  assert.ok(s.alex().includes('Team is twelve dollars.'))
  assert.ok(!s.alex().includes('Business is twenty-nine.') && !s.alex().includes('Any questions so far?'))
  s.flux.emit('open')
  await until(() => s.next(SLIDES_LINES.carryOn) !== undefined, 'carried on once it hears again')
  assert.equal(s.next(SLIDES_LINES.carryOn), 'Business is twenty-nine.')
  done(s)
})

test("while it can't hear, the owner's resume and moves say nothing: the slide is shown, and it carries on once it hears again", async () => {
  const cant = "it can't hear the meeting right now"
  // The action, the slide on screen after it, its note, and the sentence it carries on with once it hears (null: a detour, which waits for "carry on").
  const cases: [OwnerAction, number | undefined, number, { ok: boolean; note: string }, string | null][] = [
    ['resume', undefined, 2, { ok: false, note: `Not yet: ${cant}, so it carries on once it can.` }, 'Team is twelve dollars.'],
    ['next', undefined, 5, { ok: true, note: `Slide 5 is on screen, but ${cant}, so it carries on once it can.` }, 'We ship in March.'],
    ['goto', 5, 5, { ok: true, note: `Slide 5 is on screen, but ${cant}, so it carries on once it can.` }, 'We ship in March.'],
    ['restart', undefined, 2, { ok: true, note: `Slide 2 is on screen, but ${cant}, so it carries on once it can.` }, 'Team is twelve dollars.'],
    ['wrap_up', undefined, 5, { ok: true, note: `Slide 5 is on screen, but ${cant}, so it carries on once it can.` }, 'We ship in March.'],
    ['back', undefined, 1, { ok: true, note: `Slide 1 is on screen, but ${cant}, so it said nothing.` }, null],
  ]
  for (const [action, slide, page, note, first] of cases) {
    // From slide 2, lost before its first sentence has played.
    const s = start({ from: 2, latency: 30 })
    await narrating(s)
    s.flux.emit('lost', 'test')
    await until(() => s.spoken.includes(SLIDES_LINES.deaf), 'the fixed line')
    await wait(50)
    const count = s.spoken.length
    assert.deepEqual(s.presenter.owner(action, slide), note, action)
    await wait(200)
    assert.deepEqual(s.spoken.slice(count), [], `${action}: nothing said while it can't hear`)
    assert.equal(s.presenter.status().slide, page, `${action}: the slide is shown`)
    assert.ok(!s.events.some(e => e.event === 'finished'), action)
    s.flux.emit('open')
    if (first) {
      await until(() => s.next(SLIDES_LINES.shallCarryOn) === SLIDES_LINES.carryOn, `${action}: "Shall I carry on?", and silence carries on`)
      await until(() => s.next(SLIDES_LINES.carryOn) !== undefined)
      assert.equal(s.next(SLIDES_LINES.carryOn), first, action)
    } else {
      await wait(200)
      assert.deepEqual(s.spoken.slice(count), [], 'a detour waits for "carry on"')
      assert.equal(s.presenter.status().held, 'detour')
    }
    done(s)
  }
})

test('"Alex, pause" or the owner\'s pause, then hearing lost: the owner\'s resume waits for hearing; so does a start whose share loads meanwhile', async () => {
  for (const by of ['room', 'owner'] as const) {
    const s = start()
    await narrating(s)
    if (by === 'room') s.said('Alex, pause.')
    else s.presenter.owner('pause')
    await until(() => s.presenter.status().held === (by === 'room' ? 'asked' : 'owner'))
    s.flux.emit('lost', 'test')
    await wait(30)
    const count = s.spoken.length
    assert.deepEqual(s.presenter.owner('resume'), { ok: false, note: "Not yet: it can't hear the meeting right now, so it carries on once it can." })
    await wait(200)
    assert.deepEqual(s.spoken.slice(count), [], `${by}: nothing said while it can't hear`)
    assert.equal(s.presenter.status().held, 'deaf')
    s.flux.emit('open')
    await until(() => s.next(SLIDES_LINES.shallCarryOn) === SLIDES_LINES.carryOn, 'carried on once it hears again')
    done(s)
  }
  // Started again after a stop: hearing is lost while the share loads, so narration waits for it.
  const s = start()
  await narrating(s)
  s.said('Alex, stop presenting.')
  await until(() => s.surface.calls.includes('stop'))
  const load = s.surface.start.bind(s.surface)
  let loaded!: () => void
  const loading = new Promise<void>(resolve => (loaded = resolve))
  s.surface.start = (at: number) => loading.then(() => load(at))
  s.said('Alex, start the presentation.')
  await until(() => s.spoken.filter(l => l === SLIDES_LINES.sharing).length === 2, 'the second start')
  s.flux.emit('lost', 'test')
  const count = s.spoken.length
  loaded()
  await until(() => s.presenter.status().held === 'deaf', 'held: it cannot hear')
  await wait(200)
  assert.deepEqual(s.spoken.slice(count), [], "nothing narrated while it can't hear")
  s.flux.emit('open')
  await until(() => s.next(SLIDES_LINES.shallCarryOn) === SLIDES_LINES.carryOn)
  await until(() => NARRATION.includes(s.next(SLIDES_LINES.carryOn)!), 'narration')
  done(s)
})

test('hearing lost while a detour slide is narrated again: it stops there, held as deaf, and goes back to the bookmark once it hears', async () => {
  const s = start({ latency: 40 })
  await narrating(s)
  await until(() => s.spoken.includes('Team is twelve dollars.'))
  s.said('Alex, go back.')
  await until(() => s.presenter.status().held === 'detour' && s.spoken.includes("Here's slide 1."), 'the detour')
  const said = s.spoken.filter(l => l === 'Hello everyone.').length
  s.said('Alex, start this slide again.')
  await until(() => s.spoken.filter(l => l === 'Hello everyone.').length === said + 1, 'the detour slide narrated again')
  s.flux.emit('lost', 'test')
  const count = s.spoken.length
  await until(() => s.spoken.includes(SLIDES_LINES.deaf), 'the fixed line')
  await wait(100)
  assert.deepEqual(s.spoken.slice(count), [SLIDES_LINES.deaf], 'nothing more of the slide')
  assert.equal(s.presenter.status().held, 'deaf')
  s.flux.emit('open')
  await until(() => s.spoken.includes(`${SLIDES_LINES.carryOn} Back to Pricing.`), 'back to the bookmark')
  assert.equal(s.presenter.status().slide, 2)
  done(s)

  // Held on a detour when hearing goes: the owner's restart of that slide says nothing either.
  const h = start()
  await narrating(h)
  await until(() => h.spoken.includes('Team is twelve dollars.'))
  h.said('Alex, go back.')
  await until(() => h.presenter.status().held === 'detour' && h.spoken.includes("Here's slide 1."), 'the detour')
  h.flux.emit('lost', 'test')
  await wait(30)
  const before = h.spoken.length
  assert.equal(h.presenter.owner('restart').ok, true)
  await wait(200)
  assert.deepEqual(h.spoken.slice(before), [], "nothing said while it can't hear")
  assert.equal(h.presenter.status().held, 'deaf')
  done(h)
})

test('while the camera page is away, the owner\'s resume and moves send nothing to the voice: the slide is shown, and it carries on once the page is back', async () => {
  const away = 'its camera page is away'
  // The action, the slide on screen after it, its note, and what it says 2 s after the page is back.
  const cases: [OwnerAction, number, { ok: boolean; note: string }, string][] = [
    ['resume', 1, { ok: false, note: `Not yet: ${away}, so it carries on once the page is back.` }, 'Back to Welcome.'],
    ['next', 2, { ok: true, note: `Slide 2 is on screen, but ${away}, so it carries on once the page is back.` }, 'Back to Pricing.'],
    ['wrap_up', 5, { ok: true, note: `Slide 5 is on screen, but ${away}, so it carries on once the page is back.` }, 'Back to Next steps.'],
  ]
  for (const [action, page, note, back] of cases) {
    // The page goes while the first sentence is made: none of it went out.
    const s = start({ latency: 30 })
    await narrating(s)
    await until(() => s.spoken.includes('Hello everyone.'))
    s.ws.drop()
    assert.equal(s.presenter.status().held, 'page_away')
    const count = s.spoken.length
    assert.deepEqual(s.presenter.owner(action), note, action)
    await wait(200)
    assert.deepEqual(s.spoken.slice(count), [], `${action}: nothing goes to the voice with no page`)
    assert.equal(s.presenter.status().held, 'page_away')
    assert.equal(s.presenter.status().slide, page, `${action}: the slide is shown`)
    assert.equal(s.presenter.status().bookmark, page, `${action}: narration carries on there`)
    assert.ok(!s.events.some(e => e.event === 'finished'), action)
    s.session.attach(new FakeSocket() as any, {})
    await until(() => s.next(back) !== undefined, 'carried on once the page is back')
    // The consent line again first (the page did not say what it had heard), then the slide.
    assert.ok(!s.spoken.slice(count, s.spoken.indexOf(back, count)).some(l => NARRATION.includes(l)), 'no narration before it')
    assert.ok(NARRATION.includes(s.next(back)!))
    done(s)
  }
})

test('a sentence that could not go out to the page is not counted as heard: once the page is back, narration carries on at it', async () => {
  const s = start({ latency: 30 })
  await narrating(s)
  await until(() => s.spoken.includes('Team is twelve dollars.'))
  // The page's connection starts to close while the sentence is made: none of it reaches the page.
  s.ws.readyState = 2
  await until(() => s.presenter.status().held === 'page_away', 'held: no page')
  assert.equal(s.presenter.status().slide, 2)
  s.session.attach(new FakeSocket() as any, {})
  await until(() => s.next('Back to Pricing.') !== undefined, 'carried on once the page is back')
  assert.equal(s.next('Back to Pricing.'), 'Team is twelve dollars.')
  done(s)
})

test('hearing lost in the middle of someone\'s turn: once it hears again the room counts as quiet, so silence after "Shall I carry on?" carries on', async () => {
  // Held for talk, then a turn starts, and hearing goes before it ends.
  const s = start({ voice: LONG })
  await narrating(s)
  await until(() => s.spoken.includes('Team is twelve dollars.'))
  await wait(300)
  s.said("That's interesting.")
  await until(() => s.presenter.status().held === 'talk')
  s.flux.turn('StartOfTurn', '')
  s.flux.emit('lost', 'test')
  await wait(30)
  s.flux.emit('open')
  await until(() => s.spoken.includes(SLIDES_LINES.shallCarryOn))
  await until(() => s.spoken.includes(SLIDES_LINES.carryOn), 'silence is a yes', 1000)
  done(s)

  // A turn that talks over the narration (the page paused while it is watched), and hearing goes before it ends.
  const w = start({ voice: { 'Team is twelve dollars.': 600 } })
  await narrating(w)
  await until(() => w.spoken.includes('Team is twelve dollars.'))
  await wait(100)
  w.flux.turn('StartOfTurn', '')
  w.flux.emit('lost', 'test')
  await until(() => w.spoken.includes(SLIDES_LINES.deaf), 'the fixed line')
  w.flux.emit('open')
  await until(() => w.spoken.includes(SLIDES_LINES.shallCarryOn))
  await until(() => w.spoken.includes(SLIDES_LINES.carryOn), 'silence is a yes', 1000)
  done(w)
})

test('a voice that fails twice: the kept line, voice_failed, and a hold until someone says carry on', async () => {
  const s = start({ failing: new Set(['Team is twelve dollars.']) })
  await narrating(s)
  await until(() => s.spoken.includes(SLIDES_LINES.voice))
  assert.equal(s.spoken.filter(l => l === 'Team is twelve dollars.').length, 2, 'one retry')
  assert.equal(s.presenter.status().held, 'voice')
  assert.ok(s.events.some(e => e.event === 'voice_failed'))
  assert.ok(!s.ws.sent.some(m => typeof m === 'string' && m.includes("couldn't answer")), 'never the page error')
  done(s)
})

test('stuck, contested and a fault of the share: the line, stopped, the event; camera_suspect is told to the owner', async () => {
  for (const [event, line, told] of [
    ['stuck', SLIDES_LINES.stuck, 'stuck'],
    ['contested', SLIDES_LINES.problem, 'contested'],
    ['failed', SLIDES_LINES.problem, 'share_failed'],
  ] as const) {
    const s = start()
    await narrating(s)
    s.surface.fire(event)
    await until(() => s.spoken.includes(line), line)
    assert.equal(s.presenter.current, 'stopped')
    assert.ok(s.events.some(e => e.event === told))
    done(s)
  }
  const s = start()
  await narrating(s)
  s.surface.fire('camera_suspect')
  assert.ok(s.events.some(e => e.event === 'camera_suspect'))
  done(s)
})

test('"stop presenting": the line, the share stopped, the bookmark kept; "start the presentation" picks it up again', async () => {
  const s = start()
  await narrating(s)
  await until(() => s.spoken.includes('Team is twelve dollars.'))
  s.said('Alex, stop presenting.')
  await until(() => s.surface.calls.includes('stop'))
  assert.ok(s.spoken.includes(SLIDES_LINES.stopped))
  assert.equal(s.presenter.current, 'stopped')
  assert.ok(s.markers().includes('stopped sharing the slides'))
  const bookmark = s.presenter.status().bookmark
  assert.ok(bookmark === 2 || bookmark === 5, String(bookmark))
  s.said('Alex, start the presentation.')
  await until(() => s.surface.calls.filter(c => c.startsWith('start')).length === 2)
  const index = [1, 2, 4, 5].indexOf(bookmark)
  assert.equal(s.surface.calls.filter(c => c.startsWith('start')).at(-1), `start ${index}`, 'from the bookmark')
  done(s)
})

test('the owner\'s end is for good: the room can no longer restart it; the owner can', async () => {
  const s = start()
  await narrating(s)
  assert.equal(s.presenter.owner('end').ok, true)
  await until(() => s.surface.calls.includes('stop'))
  assert.equal(s.presenter.current, 'ended')
  s.said('Alex, start the presentation.')
  await until(() => s.spoken.includes(SLIDES_LINES.waitForOwner))
  assert.equal(s.presenter.current, 'ended')
  assert.equal(s.presenter.owner('start').ok, true)
  await until(() => s.surface.calls.filter(c => c.startsWith('start')).length === 2)
  done(s)
})

test('owner moves are said aloud; wrap_up jumps to the last slide', async () => {
  const s = start()
  await narrating(s)
  assert.equal(s.presenter.owner('goto', 5).ok, true)
  await until(() => s.spoken.includes('Moving to slide 5.'))
  assert.equal(s.presenter.owner('goto', 3).ok, false)
  assert.equal(s.presenter.owner('goto').ok, false)
  assert.equal(s.presenter.owner('wrap_up').ok, true)
  await until(() => s.spoken.includes(SLIDES_LINES.wrapUp))
  done(s)
})

test('after the last slide, questions; two quiet minutes (short here) stop the share quietly, with a marker', async () => {
  const s = start()
  await narrating(s)
  await until(() => s.presenter.current === 'qa', 'questions', 5000)
  const lines = s.spoken.length
  await until(() => s.surface.calls.includes('stop'), 'the quiet stop')
  assert.equal(s.spoken.length, lines, 'quiet: nothing said')
  assert.equal(s.presenter.current, 'stopped')
  assert.ok(s.markers().includes('stopped sharing the slides'))
  assert.deepEqual(s.presenter.summary(), { reached: 5, of: 4, finished: true })
  done(s)
})

test('after the last slide, the quiet stop needs no hearing: with speech recognition lost, the share still stops', async () => {
  const s = start()
  await narrating(s)
  await until(() => s.presenter.current === 'qa', 'questions', 5000)
  s.flux.emit('lost', 'test')
  await until(() => s.surface.calls.includes('stop'), 'the quiet stop', 1500)
  assert.equal(s.presenter.current, 'stopped')
  done(s)
})

test('"please leave" mid-deck: the share closes at once (no stop), then the goodbye; nothing is kept', async () => {
  const s = start()
  await narrating(s)
  s.said('Alex, please leave.')
  await until(() => s.spoken.includes(LEAVE_LINE))
  assert.ok(s.surface.calls.includes('close'))
  assert.ok(!s.surface.calls.includes('stop'))
  assert.equal(s.presenter.current, 'disposed')
  await until(() => s.notified.some(n => n.type === 'meeting_ended'))
  const ended = s.notified.find(n => n.type === 'meeting_ended') as any
  assert.equal(ended.transcript_file, '')
  assert.equal('presentation' in ended, false)
})

test('a deck presented to a silent room gets no minutes: markers and narration are the assistant\'s lines', async () => {
  const s = start()
  await until(() => s.session.consentDone)
  assert.equal(s.presenter.owner('start').ok, true)
  await until(() => s.presenter.current === 'qa', 'questions', 5000)
  assert.ok(s.markers().length >= 3)
  assert.ok(s.session.transcript.lines.every(l => l.role === 'agent'))
  assert.equal(s.session.transcript.participantsSpoke(), false)
  s.session.end()
  await until(() => s.notified.some(n => n.type === 'meeting_ended'))
  const ended = s.notified.find(n => n.type === 'meeting_ended') as any
  assert.equal(ended.no_minutes, 'Nobody said anything, so there are no minutes.')
  s.session.transcript.delete()
})

test('narration never opens a reply window by itself: a rhetorical "?" without pause is not answered', async () => {
  const s = start()
  await narrating(s)
  await until(() => s.spoken.includes('Any questions so far?'))
  await wait(30)
  s.said('What about the enterprise plan?')
  await wait(100)
  assert.deepEqual(s.answered, [])
  done(s)
})

test('a share that throws or rejects at every step never reaches uncaughtException or unhandledRejection', async () => {
  const caught: unknown[] = []
  const onError = (err: unknown) => void caught.push(err)
  process.on('uncaughtException', onError)
  process.on('unhandledRejection', onError)
  try {
    for (const broken of ['throw', 'reject'] as const) {
      const s = start()
      s.surface.broken = broken
      await until(() => s.session.consentDone)
      s.said('Alex, start the presentation.')
      await wait(200)
      s.said('Alex, next slide.')
      s.said('Alex, stop presenting.')
      s.presenter.owner('start')
      await wait(200)
      done(s)
    }
    await wait(50)
    assert.deepEqual(caught, [])
  } finally {
    process.off('uncaughtException', onError)
    process.off('unhandledRejection', onError)
  }
})

test('the meeting\'s slides come from the script and the deck: excluded and unknown pages left out, in page order', () => {
  assert.deepEqual(
    SLIDES.map(s => [s.page, s.title, s.sentences.length, s.onRequest]),
    [[1, 'Welcome', 2, false], [2, 'Pricing', 3, false], [4, 'Security', 1, true], [5, 'Next steps', 2, false]],
  )
})

test("the presentation's events go to the owner's session, and meeting_ended says how far it got, never after \"please leave\"", async () => {
  const s = start()
  await narrating(s)
  await until(() => s.notified.some(n => n.type === 'presentation'))
  const started = s.notified.find(n => n.type === 'presentation') as Extract<ToSession, { type: 'presentation' }>
  assert.deepEqual(started, { type: 'presentation', meeting: s.session.opts.meetingKey, event: 'started', of: 4, note: 'The presentation started.', slide: 1, title: 'Welcome' })
  await until(() => s.markers().includes('showing slide 2: Pricing'))
  s.session.end()
  await until(() => s.notified.some(n => n.type === 'meeting_ended'))
  const ended = s.notified.find(n => n.type === 'meeting_ended') as Extract<ToSession, { type: 'meeting_ended' }>
  assert.deepEqual(ended.presentation, { reached: 2, of: 4, finished: false })
  s.session.transcript.delete()

  // Never started: reached 0.
  const idle = start()
  await until(() => idle.session.consentDone)
  idle.session.end()
  await until(() => idle.notified.some(n => n.type === 'meeting_ended'))
  assert.deepEqual((idle.notified.find(n => n.type === 'meeting_ended') as any).presentation, { reached: 0, of: 4, finished: false })
  idle.session.transcript.delete()

  // "Please leave": nothing of the meeting is kept, so no presentation in meeting_ended, and no event after it.
  const left = start()
  await narrating(left)
  left.said('Alex, please leave.')
  await until(() => left.notified.some(n => n.type === 'meeting_ended'))
  const after = left.notified.findIndex(n => n.type === 'meeting_ended')
  assert.equal((left.notified[after] as any).presentation, undefined)
  left.surface.fire('stuck')
  await wait(30)
  assert.ok(!left.notified.slice(after).some(n => n.type === 'presentation'))

  // A meeting without slides: meeting_ended is what it always was.
  const plain = start({ slides: false })
  await until(() => plain.session.consentDone)
  plain.session.end()
  await until(() => plain.notified.some(n => n.type === 'meeting_ended'))
  assert.ok(!('presentation' in (plain.notified.find(n => n.type === 'meeting_ended') as object)))
  plain.session.transcript.delete()
})

test('a question mid-deck: the brain gets the outline and the slide on screen, and the earlier narration folded into one line', async () => {
  const s = start({ voice: LONG, answers: [[{ kind: 'say', text: 'It is per user.' }]] })
  await narrating(s)
  await until(() => s.spoken.includes('Team is twelve dollars.'))
  await wait(300)
  s.flux.turn('StartOfTurn', '')
  s.flux.turn('EndOfTurn', 'Alex, is that per month?')
  await until(() => s.inputs.length === 1)
  const { slides, transcript } = s.inputs[0]
  assert.deepEqual(
    slides.outline.map((o: any) => [o.page, o.title, o.first, o.onRequest]),
    [[1, 'Welcome', 'Hello everyone.', false], [2, 'Pricing', 'Team is twelve dollars.', false], [4, 'Security', 'Here are the security details.', true], [5, 'Next steps', 'We ship in March.', false]],
  )
  assert.deepEqual(slides.current, {
    page: 2,
    of: 4,
    title: 'Pricing',
    script: 'Team is twelve dollars. Business is twenty-nine. Any questions so far?',
    text: '',
    saying: '',
    before: 'slide 1, Welcome',
    after: 'slide 4, Security',
  })
  // Slide 1's narration is one line; the slide on screen is as it was.
  assert.match(transcript, /^\(Alex presented slide 1 from the script: Welcome\)$/m)
  assert.doesNotMatch(transcript, /Hello everyone|This is the plan/)
  assert.match(transcript, /^Slides: showing slide 2: Pricing$/m)
  assert.match(transcript, /^Speaker: Alex, is that per month\?$/m)
  // The transcript itself keeps every line.
  assert.ok(s.alex().includes('Hello everyone.'))
  done(s)
})

test('a question handed to the owner mid-deck carries the slide on screen; a meeting without slides hands off as before', async () => {
  const s = start({ voice: LONG, answers: [[{ kind: 'ask_session', question: 'What does the enterprise plan cost?' }]] })
  await narrating(s)
  await until(() => s.spoken.includes('Team is twelve dollars.'))
  await wait(300)
  s.flux.turn('StartOfTurn', '')
  s.flux.turn('EndOfTurn', 'Alex, what does the enterprise plan cost?')
  await until(() => s.asked.length === 1)
  assert.match(s.asked[0].context, /^On screen: slide 2 of 4, Pricing\.\n\n/)
  done(s)
  const plain = start({ slides: false, answers: [[{ kind: 'ask_session', question: 'Is the pilot on track?' }]] })
  await until(() => plain.session.consentDone)
  plain.said('Alex, is the pilot on track?')
  await until(() => plain.asked.length === 1)
  assert.doesNotMatch(plain.asked[0].context, /On screen/)
  assert.equal(plain.inputs[0].slides, undefined, 'no slides for the brain in a meeting without them')
  assert.ok(!('slides' in plain.inputs[0]))
  done(plain)
})

test('why_not_answered says when a line talked over the slides and held them', async () => {
  const s = start({ voice: LONG })
  await narrating(s)
  await until(() => s.spoken.includes('Team is twelve dollars.'))
  await wait(300)
  s.flux.turn('StartOfTurn', '')
  s.flux.turn('EndOfTurn', "That's interesting.")
  await until(() => s.session.whyNotAnswered(5).lines!.length > 1)
  const lines = s.session.whyNotAnswered(5).lines!
  const held = lines.find(l => l.line === "That's interesting.")!
  assert.match(held.why, /It talked over the slides Alex was presenting, so Alex stopped at that sentence and held them/)
  // A line that didn't stop the narration says nothing of it.
  assert.ok(lines.filter(l => l !== held).every(l => !/talked over the slides/.test(l.why)))
  done(s)
})

test('the minutes of a meeting whose slides were presented are told so; a deck never started, or no deck, changes nothing', async () => {
  const s = start()
  await narrating(s)
  await until(() => s.spoken.includes('Team is twelve dollars.'))
  s.said('Thanks, that was clear.')
  await wait(30)
  s.session.end()
  await until(() => s.minutes.length === 1)
  assert.deepEqual(s.minutes[0].presented, { title: 'Q4 plan', slides: 4 })
  s.session.transcript.delete()
  const idle = start()
  await until(() => idle.session.consentDone)
  idle.said('Hello everyone.')
  await wait(30)
  idle.session.end()
  await until(() => idle.minutes.length === 1)
  assert.ok(!('presented' in idle.minutes[0]))
  idle.session.transcript.delete()
})
