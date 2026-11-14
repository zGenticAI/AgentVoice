// One live conversation: the agent page streams meeting audio in, and the assistant's voice streams back out.
// The notes use the default name, Alex; the assistant's name comes from src/identity.ts.
import fs from 'node:fs'
import WebSocket from 'ws'
import { BriefAdditions } from '../brain/additions.ts'
import type { Brain } from '../brain/brain.ts'
import { attention, endsOnQuestion, isFillerOnly, wordsThatCount } from '../brain/attention.ts'
import { isCancelRequest, isLeaveReply, isLeaveRequest } from '../brain/text.ts'
import type { SessionAnswer, SessionBridge, ToSession } from '../bridge.ts'
import { CHECKING_LINES, JOIN_LINE, LEAVE_LINE, PROGRESS_LINE, REFUSAL_LINE, SESSION_OFFLINE_LINE } from '../consent.ts'
import { PARTICIPANT_LABEL, identity } from '../identity.ts'
import { type MinutesInput, writeMinutes } from '../minutes.ts'
import * as recall from '../recall.ts'
import { type Line, Transcript } from '../transcript.ts'
import { FluxStream, SAMPLE_RATE } from './deepgram.ts'
import { Playback } from './playback.ts'
import { synthesize } from './tts.ts'

export interface SessionOptions {
  /** The random key in the bot page's URL, for the meeting this session is part of. */
  meetingKey: string
  /** The meeting's Recall bot. Without it nothing is posted in the meeting and there are no minutes. */
  botId?: string
  /** The meeting platform's name (Zoom, Google Meet, Microsoft Teams), for the minutes. */
  platform?: string
}

export interface SessionDeps {
  brain: Brain
  bridge: SessionBridge
  brief: () => string
  speak?: typeof synthesize
  flux?: () => Pick<FluxStream, 'send' | 'close' | 'on'>
  /** The Recall calls a bot session makes (the real ones unless a test passes fakes). */
  recall?: Pick<typeof recall, 'sendChat' | 'leaveCall' | 'deleteMedia' | 'howBotEnded'>
  /** Writes the minutes and resolves with their file, or throws why not (writeMinutes unless a test passes one). */
  writeMinutes?: (input: MinutesInput) => Promise<string>
  /** How long the bot waits after the goodbye has gone out before it drops (ms). By default, until it has played. */
  leaveDelayMs?: number
  /** How long the end of a meeting waits for speech recognition's last words (ms). */
  sttFlushMs?: number
  /** How long after the page connects Alex says the consent line (ms). */
  greetDelayMs?: number
  /** How long after Alex ends an answer on a question the next line is taken as the reply (ms). */
  replyWindowMs?: number
  /** How long after someone says just "Alex?" the next line goes to Alex (ms). */
  calledWindowMs?: number
  /** How long Alex waits for the owner's session before saying, once, that it is still checking (ms). */
  progressAfterMs?: number
  /** The time (epoch ms) for following what the page has played of Alex's voice: Date.now unless a test passes one. */
  clock?: () => number
  /** How long the page stays paused for someone who started talking over Alex, with no words yet that stop it (ms). */
  pauseMaxMs?: number
}

type MeetingEnded = Extract<ToSession, { type: 'meeting_ended' }>

// When Alex ends an answer on a question, it has handed the turn back: the next thing anyone says within
// this time is taken as the reply, without the name. An answer that ends on a statement opens nothing,
// so "great, thanks" or the conversation carrying on around Alex is not answered.
const REPLY_WINDOW_MS = 30_000
// When someone says just "Alex?", Alex says nothing, but the next thing said within this time goes to it.
const CALLED_WINDOW_MS = 10_000
// When the owner's session takes longer than this to answer, Alex says it is still checking, so the meeting
// doesn't think it forgot the question.
const PROGRESS_AFTER_MS = 15_000
// A question handed to the owner's session carries the meeting so far, not just its last minutes, so the
// meeting-assistant has the full context for a deep dive: about an hour of speech.
export const HANDOFF_CONTEXT_CHARS = 60_000
// Deepgram can still send what it heard last after the page has gone: it closes the stream about
// a second after CloseStream. The end of the meeting waits this long at most for those words.
const STT_FLUSH_MS = 1500
// Alex's voice goes to the page as 16 kHz mono 16-bit audio: 32 bytes for each millisecond it plays.
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000
// After the goodbye has played, the bot waits this much longer before it drops, so its last word isn't cut.
const LEAVE_MARGIN_MS = 500
// Someone who starts talking over Alex pauses it at once (see turnStarted). With no words yet that stop it, the page
// resumes after this long, so a cough Deepgram is slow to end the turn on doesn't leave the meeting in silence. The
// turn is still watched after that: words that come later still stop Alex.
const PAUSE_MAX_MS = 1500
// Speech that starts with no more than this much of the line left to play, and nothing more going out, neither pauses
// nor stops Alex: it is someone answering as a question ends. Pausing would cut the last word, and lose the reply.
const TAIL_MS = 400
// How many words that count (wordsThatCount: not a filler, not "mm-hm", "yeah" or "I see", and the name always) stop
// Alex: 2 while the turn goes on, since Deepgram may still be partway through it, and 1 once it has ended. A single
// stray word is often noise.
const STOP_WORDS_PARTIAL = 2
const STOP_WORDS_FINAL = 1
/**
 * What the bot page shows when something fails. The page is the assistant's camera, so the whole meeting reads it: it
 * gets these fixed words, never the error itself (a provider's reply can hold account details or request ids, and a
 * setting's error names files on this computer). The error goes to the service's log.
 */
export const PAGE_ERRORS = Object.freeze({
  /** A turn failed: Claude or ElevenLabs. The assistant goes on listening. */
  answer: "couldn't answer that",
  /** Speech recognition failed or stopped: the assistant can't hear the meeting. */
  hearing: "can't hear the meeting",
  /** The meeting's session could not start (a key not set, a data folder it can't write to). The page is closed. */
  start: "can't start",
})

// How Alex came to leave a meeting with nothing kept: asked to ("Alex, please leave"), or removed
// from the meeting by the host (Recall's bot_kicked_from_call), which counts the same.
type Left = 'asked' | 'removed'
const LEFT_NOTES: Record<Left, string> = {
  asked: `${identity.name} was asked to leave, so it deleted the transcript and wrote no minutes.`,
  removed: `${identity.name} was removed from the meeting, so it deleted the transcript and wrote no minutes.`,
}
// When Recall cannot say whether Alex was removed: no minutes, in case it was, but nothing is deleted on a guess.
const unconfirmedNote = (why: string) =>
  `Could not confirm how the meeting ended (${why}), so there are no minutes, in case ${identity.name} was removed from it. ` +
  'The transcript is kept.'
// When an earlier session of the meeting (its page reconnected) had already reported its files.
const LEFT_EARLIER_NOTE =
  ` The transcript and minutes named in the earlier meeting_ended for this meeting were deleted too, at a participant's request: tell ${identity.owner}, and do not pass them on again.`
const STOPPED_NOTE = 'The voice service stopped before the minutes were written. The transcript is kept.'
// Posted in the meeting chat when a meeting reaches MAX_MEETING_MINUTES, just before the bot leaves the call.
export const timeLimitLine = (minutes: number) =>
  `I've reached the time limit for one meeting (${minutes} minutes), so I'm leaving the call now.`
// How long the bot waits for Recall to post that line before it leaves all the same (ms).
const TIME_LIMIT_CHAT_WAIT_MS = 10_000

// Bots whose media Recall has been asked to delete (the request is still trying, or it worked), so
// each bot is asked once however its sessions end. One that gave up may be asked again by a later session.
const mediaDeletions = new Set<string>()

/** Asks Recall to delete the bot's media, once per bot. Not awaited: it keeps trying until the bot has finished. */
function deleteMediaOnce(botId: string, deleteMedia: (botId: string) => Promise<boolean>): void {
  if (mediaDeletions.has(botId)) return
  mediaDeletions.add(botId)
  deleteMedia(botId)
    .then(deleted => {
      if (!deleted) mediaDeletions.delete(botId)
    })
    .catch(() => mediaDeletions.delete(botId))
}

/**
 * What a meeting has on record, across its sessions (a page that reconnects starts another session
 * for the same meeting key). When anyone asks Alex to leave, or removes it, in any of them, all of it
 * goes and no session of that meeting records anything or writes minutes again.
 */
interface MeetingRecords {
  /** Its sessions whose meeting_ended has not been sent yet. */
  sessions: Set<MeetingSession>
  /** Every transcript and minutes file its sessions have written. */
  files: Set<string>
  /** Set once Alex was asked to leave the meeting, or removed from it. */
  left: Left | null
  /** A meeting_ended naming a transcript or minutes file has been sent for it. */
  reported: boolean
  /** What the owner's session added to the brief during the meeting, so a page that reconnects keeps it. */
  additions: BriefAdditions
}

const MEETINGS_KEPT = 100
const meetingRecords = new Map<string, MeetingRecords>()

function recordsFor(meetingKey: string): MeetingRecords {
  let records = meetingRecords.get(meetingKey)
  if (!records) {
    records = { sessions: new Set(), files: new Set(), left: null, reported: false, additions: new BriefAdditions() }
    meetingRecords.set(meetingKey, records)
    const finished = [...meetingRecords].filter(([, r]) => r.sessions.size === 0).map(([key]) => key)
    for (const key of finished.slice(0, Math.max(0, meetingRecords.size - MEETINGS_KEPT))) meetingRecords.delete(key)
  }
  return records
}

// Sessions whose meeting_ended is still waiting (for the last words, or for the minutes), each with
// a way to send it at once, so a shutdown never loses the end of a meeting.
const finishing = new Map<MeetingSession, () => void>()

/** Resolves when `done` does, or after ms, whichever is first. */
function within(done: Promise<void>, ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    void done.then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/**
 * For a shutdown: ends these sessions, then waits up to waitMs for their meeting_ended events (which
 * wait for the minutes). Any still waiting are sent at once, saying no minutes were written, so
 * the owner's session and its meeting-assistant always hear that the meeting ended.
 */
export async function endSessions(sessions: Iterable<MeetingSession>, waitMs = 10_000): Promise<void> {
  for (const session of sessions) session.end()
  const deadline = Date.now() + waitMs
  while (finishing.size && Date.now() < deadline) await new Promise(r => setTimeout(r, 50))
  for (const send of [...finishing.values()]) send()
}

export class MeetingSession {
  readonly transcript: Transcript
  private flux: Pick<FluxStream, 'send' | 'close' | 'on'>
  private turn: AbortController | null = null
  private speaking = false
  // Someone started talking over Alex, and their turn has not ended yet: what they say decides whether Alex stops
  // (see turnStarted). Only whether, never the words.
  private watching = false
  // While the page is paused for someone talking over Alex: resumes it after PAUSE_MAX_MS. Null when not paused.
  private pauseTimer: NodeJS.Timeout | null = null
  // What Alex said last in this answer, to see whether it ended on a question. Only in memory.
  private lastSaid = ''
  // Until when (epoch ms) the next thing said goes to Alex without the name: after Alex ended an answer
  // on a question, or someone said just "Alex?". 0 when no window is open.
  private awaitingUntil = 0
  // While Alex says the consent line: it is said in full, whoever talks meanwhile, and a question asked
  // during it is answered once it is over. Only leaving, removal or the end of the session stop it. Null
  // once it has all gone out to the page.
  private greeting: Promise<void> | null = null
  // When the page will have played the consent line to the end (epoch ms): it holds up to a second of it
  // after the line has all gone out, and "Alex, never mind" must not clear that either.
  private consentPlaysUntil = 0
  // Someone said just "Alex?" (or announced a question) during the consent line: the window it opened would
  // run out before people could speak (the line takes about 17 s), so it opens again, in full, once the
  // line has played.
  private calledDuringConsent = false
  // Counts the lines that asked Alex something or told it to stop, so a question that waited for the
  // consent line is dropped when something said after it has taken its place.
  private lineCount = 0
  // How the page plays Alex's voice: when it will have played what went out to it (for the consent line and the
  // goodbye, which are heard in full), and how much of a line it had played when the line stopped short, so that the
  // transcript keeps only the words the meeting heard. Only timings, and the lines while they may still play.
  private readonly playback: Playback<Line>
  // The time for following the page's playback: Date.now unless a test passes a clock.
  private readonly clock: () => number
  private questions: string[] = []
  private ended = false
  // How many questions this session has handed to the owner's session: Alex takes the checking lines in turn.
  private handoffs = 0
  // Set once someone has asked Alex to leave (or removed it), in this session or another one for the
  // same meeting: nothing more is recorded or answered, the transcript is gone, and there are no minutes.
  private leaving = false
  // Why the bot is asked to leave the call when the session ends without a leave request, for the log.
  private endReason = 'its page had disconnected'
  private readonly startedAt = new Date()
  private readonly recall: NonNullable<SessionDeps['recall']>
  private readonly records: MeetingRecords
  // What the owner's session added to the brief during this meeting: shared by every session of the meeting.
  // In memory only.
  private readonly additions: BriefAdditions
  // Resolves once speech recognition has closed: no more words can arrive after that.
  private readonly sttClosed: Promise<void>

  constructor(
    private ws: WebSocket,
    readonly opts: SessionOptions,
    private deps: SessionDeps,
  ) {
    this.transcript = new Transcript(opts.meetingKey)
    this.clock = deps.clock ?? Date.now
    this.playback = new Playback((line, text) => this.transcript.amend(line, text), this.clock)
    this.recall = deps.recall ?? recall
    this.flux = deps.flux ? deps.flux() : new FluxStream()
    this.records = recordsFor(opts.meetingKey)
    this.additions = this.records.additions
    this.records.sessions.add(this)
    this.records.files.add(this.transcript.file)
    // A meeting someone asked Alex to leave (or removed it from) stays left, whichever session hears it next.
    if (this.records.left) this.stopRecording()

    this.sttClosed = new Promise(resolve => this.flux.on('close', () => resolve()))
    this.flux.on('turn', turn => {
      // Talking over Alex pauses it at once, then stops it for words, or lets it carry on for a cough, a laugh or
      // "mm-hm" (see turnStarted). Not the consent line (the meeting has to hear all of it) nor the goodbye (it
      // promises the transcript is deleted). Each event carries the turn so far: an Update (or an EagerEndOfTurn or
      // TurnResumed, which are not asked for) goes on with it.
      const text = (turn.transcript ?? '').trim()
      if (turn.event === 'StartOfTurn') return this.turnStarted(text)
      if (turn.event !== 'EndOfTurn') return this.turnGoesOn(text)
      // The verdict first: a stop clears the page and stops the turn before the line can start an answer.
      this.turnEnded(text)
      if (text) void this.onUtterance(text)
    })
    this.flux.on('error', err => {
      console.error('[stt]', err.message)
      this.control({ type: 'error', message: PAGE_ERRORS.hearing })
    })
    this.flux.on('close', (code, reason) => {
      // Once Alex is leaving, Deepgram gets no more audio and may close the stream for want of it: expected.
      if (this.ended || this.leaving) return
      console.error(`[stt] Deepgram closed the stream (${code}${reason ? `: ${reason}` : ''})`)
      this.control({ type: 'error', message: PAGE_ERRORS.hearing })
    })

    ws.on('message', (data, isBinary) => {
      // Once someone has asked Alex to leave (or removed it), the meeting's audio goes nowhere: nothing
      // more of it is sent out to be transcribed while Alex says goodbye.
      if (isBinary && !this.leaving) this.flux.send(data as Buffer)
    })
    // A malformed frame from the page (or a reset) is an 'error' on the socket: with nothing listening, it would take the
    // whole service down, and every meeting with it. 'close' follows, which ends this session as usual.
    ws.on('error', err => console.error('[audio] the page connection failed:', err.message))
    ws.on('close', () => this.end())

    this.control({ type: 'ready', sampleRate: SAMPLE_RATE })
    deps.bridge.notify({ type: 'meeting_started', meeting: opts.meetingKey })
    setTimeout(() => {
      // Not into a session that has ended (its transcript may be gone), nor over the goodbye.
      if (!this.ended && !this.leaving) this.greet()
    }, deps.greetDelayMs ?? 2500).unref()
  }

  /**
   * Someone asked Alex to leave this meeting, or removed him from it, in this session or another of the same
   * meeting. The server then lets no page in for the meeting again, and gets the bot out of the call at once.
   */
  get leftMeeting(): boolean {
    return this.records.left !== null
  }

  /**
   * Says the consent line. It tells the meeting what Alex does and how to make it leave, so it is said
   * in full: talking over it doesn't stop it, and a question waits for it (see onUtterance). Leaving,
   * removal and the end of the session still stop it at once, since they stop the turn it is said in.
   */
  private greet(): void {
    // A pause under way ends first (the page plays what it held), so the consent line never waits behind a paused page.
    this.endWatch()
    const greeting = this.runTurn(async signal => {
      await this.say(JOIN_LINE, signal)
      // Not when it was stopped: by then the timings may already be the goodbye's.
      if (signal.aborted) return
      this.consentPlaysUntil = Date.now() + Math.max(0, this.playback.playsUntil - this.clock())
      // The page is still playing the last of the line (about a second when it was kept, longer when it streamed,
      // or when an answer to a question asked before it was still playing ahead of it). The greeting lasts until the
      // page has played it, so neither talking over Alex's first answer nor "Alex, never mind" can clear the end of
      // it, and a question asked meanwhile is answered after.
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, Math.max(0, this.consentPlaysUntil - Date.now()))
        timer.unref()
        signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
      })
    }).finally(() => {
      if (this.greeting === greeting) this.greeting = null
      if (this.calledDuringConsent) {
        this.calledDuringConsent = false
        this.awaitingUntil = Math.max(Date.now(), this.consentPlaysUntil) + (this.deps.calledWindowMs ?? CALLED_WINDOW_MS)
      }
    })
    this.greeting = greeting
  }

  get botId(): string | undefined {
    return this.opts.botId
  }

  async postChat(message: string): Promise<boolean> {
    // Once someone has asked Alex to leave (or removed it), nothing more goes into the meeting, chat included.
    if (!this.opts.botId || this.leaving) return false
    await this.recall.sendChat(this.opts.botId, message)
    return true
  }

  /**
   * Adds facts from the owner's session to what Alex answers from by itself, for this meeting only (in
   * memory: the brief file is unchanged). Refused once Alex was asked to leave or removed, since
   * nothing of that meeting is kept, and once this session has ended.
   */
  addToBrief(text: string): { ok: boolean; note?: string } {
    if (this.leaving) {
      const removed = this.records.left === 'removed'
      return { ok: false, note: `${identity.name} has been ${removed ? 'removed from' : 'asked to leave'} this meeting` }
    }
    if (this.ended) return { ok: false, note: `${identity.name} is no longer in this meeting` }
    const { added, dropped } = this.additions.add(text)
    if (!added) return { ok: false, note: 'there was nothing to add' }
    if (!dropped) return { ok: true }
    const older = `${dropped} older addition${dropped === 1 ? ' was' : 's were'}`
    return { ok: true, note: `${older} dropped, to keep ${identity.name}'s answers quick.` }
  }

  /**
   * Keeps an answer from the owner's session with the additions, chat detail included (only the spoken part
   * reaches the transcript), so a follow-up such as "what was the third step again?" is answered at once
   * instead of being handed to the session again.
   */
  private keepAnswer(question: string, answer: SessionAnswer): void {
    // An answer that arrives after Alex was asked to leave (in any session of the meeting, even one that
    // started after this one ended) is not kept: nothing of the meeting is. Nor one that arrives once this
    // session has ended and the meeting has no live session left: its additions went with the last one.
    if (this.leaving || this.records.left || (this.ended && !this.records.sessions.size)) return
    const detail = answer.detail?.trim()
    const said = [answer.spoken.trim(), detail ? `(with this detail for the meeting chat: ${detail})` : ''].filter(Boolean).join(' ')
    if (said) this.additions.add(`${identity.owner}'s session answered "${question}": ${said}`)
  }

  private control(msg: object): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  private async onUtterance(text: string): Promise<void> {
    // Once someone has asked Alex to leave, nothing more is recorded or answered.
    if (this.leaving) return
    // "Um" on its own is someone thinking, not talking: it doesn't answer, open or use up anything.
    const filler = isFillerOnly(text)
    // An open window takes the next real thing anyone says, and only that: whoever it was for, it closes
    // (below, once the line is known not to be a leave request).
    const awaiting = !filler && Date.now() < this.awaitingUntil
    // A request to leave, by name; or in an open window, where a line goes to Alex without it, a plain
    // "Please leave the meeting."
    if (isLeaveRequest(text) || (awaiting && isLeaveReply(text))) {
      // Speech recognition's last words can arrive after the page has gone. There is nobody left to
      // say goodbye to then, but the request still holds: the records go, and there are no minutes.
      if (this.ended) return this.forget()
      return this.leave()
    }
    this.transcript.add(PARTICIPANT_LABEL, text, 'participant')
    // Words that arrive after the session ended are recorded, but never answered.
    if (this.ended) return
    if (!filler) {
      this.awaitingUntil = 0
      this.calledDuringConsent = false
    }
    // "Alex, never mind" stops what Alex is doing, and is not a question for it. In an open window the name may
    // be left out ("Never mind."), so the line is also read as if it had been said with the name.
    if (isCancelRequest(text) || (awaiting && isCancelRequest(`${identity.name}, ${text}`))) return this.cancel()
    const how = attention(text)
    const addressed = how === 'asked' || awaiting
    if (!addressed && how === 'called') {
      this.awaitingUntil = Date.now() + (this.deps.calledWindowMs ?? CALLED_WINDOW_MS)
      this.calledDuringConsent = this.greeting !== null
    }
    if (!addressed) return
    this.questions.push(text)
    const line = ++this.lineCount
    if (this.greeting) {
      // The consent line is said in full: a question asked during it is answered once it is over, unless
      // Alex was asked to leave meanwhile, or something said since has taken its place.
      await this.greeting
      if (line !== this.lineCount || this.leaving || this.ended) return
    }
    await this.runTurn(async signal => {
      this.lastSaid = ''
      await this.answer(text, signal)
      // An answer that ends on a question hands the turn back, so the reply needn't say "Alex". Not when
      // someone talked over it: they have moved on.
      if (!signal.aborted && endsOnQuestion(this.lastSaid)) this.awaitingUntil = Date.now() + (this.deps.replyWindowMs ?? REPLY_WINDOW_MS)
    })
  }

  /**
   * Someone told Alex never mind, or to stop. Whatever it is doing stops: an answer it is saying or the page
   * is still playing, or a question still waiting for the owner's session (the bridge stops waiting for it with
   * the turn, and keeps its answer when it comes, as a late one). It says nothing, and no window stays open.
   * Not the consent line, which is always said in full.
   */
  private cancel(): void {
    // A question waiting for the consent line to end is dropped too.
    this.lineCount++
    this.awaitingUntil = 0
    this.calledDuringConsent = false
    // The log says what happened, never what was said: meeting content stays out of the log.
    if (this.greeting) return console.log('[turn] told to stop during the consent line, which is said in full')
    // The page can still be playing an answer that has all gone out (ElevenLabs sends it faster than it
    // plays), so it is told to clear whether or not Alex is still sending: a clear with nothing playing does
    // nothing. Not while the page still plays the end of the consent line, which is heard in full.
    if (Date.now() >= this.consentPlaysUntil) this.clearPage()
    if (!this.turn) return console.log('[turn] told to stop, with nothing left to send')
    this.turn.abort()
    console.log(`[turn] told to stop: ${identity.name} stopped`)
  }

  /** Runs one reply, cancelling any reply still in progress. */
  private async runTurn(work: (signal: AbortSignal) => Promise<void>): Promise<void> {
    this.turn?.abort()
    const turn = new AbortController()
    this.turn = turn
    try {
      await work(turn.signal)
    } catch (err) {
      if (!turn.signal.aborted) {
        console.error('[turn]', (err as Error).message)
        this.control({ type: 'error', message: PAGE_ERRORS.answer })
      }
    } finally {
      if (this.turn === turn) this.turn = null
    }
  }

  private async answer(latest: string, signal: AbortSignal): Promise<void> {
    const events = this.deps.brain.respond({ transcript: this.transcript.recent(), latest, brief: this.deps.brief(), additions: this.additions.text(), signal })
    for await (const event of events) {
      if (signal.aborted) return
      if (event.kind === 'say') await this.say(event.text, signal)
      else if (event.kind === 'refused') await this.say(REFUSAL_LINE, signal)
      else if (event.kind === 'ask_session') {
        // The question goes first, so the owner's session is already on it while Alex says it is checking. The
        // turn's signal goes with it: when the meeting moves on (Alex is talked over, told never mind, asked
        // something else or to leave, or its page goes), the bridge stops waiting at once, tells the owner's
        // session that Alex won't say its answer, and keeps the answer with the meeting's additions as a
        // late one (see SessionBridge.lateReply), so asking again still gets it at once.
        const asking = this.deps.bridge.ask(
          {
            question: event.question,
            asked_by: 'meeting participant',
            meeting: this.opts.meetingKey,
            context: this.transcript.recent(HANDOFF_CONTEXT_CHARS),
          },
          undefined,
          signal,
        )
        // A checking line that fails to play (ElevenLabs busy, the line not kept yet) must not lose the answer
        // already on its way: Alex goes on waiting for it.
        await this.say(CHECKING_LINES[this.handoffs++ % CHECKING_LINES.length], signal).catch(err => {
          if (!signal.aborted) console.error('[turn] could not say the checking line:', (err as Error).message)
        })
        const answer = await this.waitForAnswer(asking, signal)
        // An answer that came before the turn stopped (it was cut off while saying "still checking", say) is
        // kept here, though it is not said. One that comes after never reaches here: the bridge gave the
        // question up with the turn, so it is kept the late way instead, once.
        if (answer) this.keepAnswer(event.question, answer)
        if (signal.aborted) return
        if (!answer) {
          await this.say(SESSION_OFFLINE_LINE, signal)
          continue
        }
        // The detail goes to the chat as Alex starts saying the answer, and the turn doesn't wait for Recall
        // to post it: an answer that ends on a question opens the reply window as soon as it has been said,
        // so a prompt "yes please" is not missed while the chat message is on its way.
        if (answer.detail) void this.postChat(answer.detail).catch(err => console.error('[chat]', err.message))
        await this.say(answer.spoken, signal)
      }
    }
  }

  /**
   * Says a line: into the transcript, then out to the page as ElevenLabs makes it. The transcript has the whole line
   * from the start, and keeps only what the meeting heard of it if it is cut off (see Playback).
   */
  private async say(text: string, signal: AbortSignal): Promise<void> {
    if (!text.trim()) return
    const line = this.transcript.add(identity.name, text, 'agent')
    // Not once the transcript is gone (the goodbye): there is nothing to correct.
    const playing = line ? this.playback.begin(line, text) : null
    // Whether every piece of the line went out to the page.
    let complete = false
    // When the turn stops (a new question, say), the line keeps the words its audio got to at once, before the next
    // answer is asked for with the transcript: not later, as this ends. Only while this line is still going out.
    const stopped = () => playing && this.playback.close(playing, false)
    signal.addEventListener('abort', stopped, { once: true })
    this.lastSaid = text
    this.speaking = true
    this.control({ type: 'speaking', on: true })
    try {
      let skipped = false
      for await (const chunk of (this.deps.speak ?? synthesize)(text, signal)) {
        if (signal.aborted) break
        if (this.ws.readyState !== WebSocket.OPEN) {
          skipped = true
          continue
        }
        this.ws.send(chunk)
        this.playback.sent(playing, chunk.length / BYTES_PER_MS)
      }
      complete = !signal.aborted && !skipped
    } finally {
      signal.removeEventListener('abort', stopped)
      // A line that did not all go out (Alex was stopped, or ElevenLabs failed partway) keeps only the words its audio
      // got to: the page plays what it was sent, and nothing more.
      if (playing) this.playback.close(playing, complete)
      this.speaking = false
      this.control({ type: 'speaking', on: false })
    }
  }

  /** Whether the page is there to play Alex's voice, and to be paused or told to clear: while its socket is open. */
  private attached(): boolean {
    return this.ws.readyState === WebSocket.OPEN
  }

  /**
   * Whether the meeting can still hear Alex, so that talking over it pauses it: it is still sending a line, the page is
   * paused, or the page has more than the last TAIL_MS of a line left to play. Never the consent line or the goodbye,
   * which are heard in full, and never once the page has gone (a pause it never gets would leave the model of what it
   * played out of step with it).
   */
  private audible(): boolean {
    if (!this.attached() || this.leaving || this.ended || this.greeting) return false
    return this.speaking || this.playback.paused || this.playback.playsUntil - this.clock() > TAIL_MS
  }

  /**
   * Someone started talking. Over Alex, the page pauses at once, and their turn is watched until it ends: two words
   * that count stop Alex at once. Fewer leave it paused, to see what comes next.
   */
  private turnStarted(text: string): void {
    if (!this.watching && !this.audible()) return
    this.watching = true
    if (wordsThatCount(text, true) >= STOP_WORDS_PARTIAL) return this.talkedOver()
    this.pausePage()
  }

  /** A watched turn goes on: two words that count stop Alex, even after the page has resumed. */
  private turnGoesOn(text: string): void {
    if (this.watching && wordsThatCount(text, true) >= STOP_WORDS_PARTIAL) this.talkedOver()
  }

  /**
   * A watched turn ended. One word that counts stops Alex. With none (a cough, a laugh, "mm-hm", "yeah, sure") the page
   * resumes where it paused. The line is then heard as any other (onUtterance): this only decides about Alex's voice.
   */
  private turnEnded(text: string): void {
    if (!this.watching) return
    if (wordsThatCount(text) >= STOP_WORDS_FINAL) return this.talkedOver()
    this.endWatch()
  }

  /**
   * Someone took the floor: Alex stops as it always has (the page clears, the turn stops). Paused, the lines keep the
   * words the page had played when it paused. Nothing to stop once Alex has finished (the watch outlasted the
   * answer). An open reply window stays open: the speech may well be the reply to the question Alex just asked.
   */
  private talkedOver(): void {
    this.watching = false
    if (!this.audible() && !this.turn) return this.dropPause()
    this.bargeIn()
  }

  /** Pauses the page, and the model of what it plays, until resumePage or a clear: at most PAUSE_MAX_MS. */
  private pausePage(): void {
    if (this.pauseTimer) return
    this.control({ type: 'pause' })
    this.playback.pause()
    this.pauseTimer = setTimeout(() => this.resumePage(), this.deps.pauseMaxMs ?? PAUSE_MAX_MS)
    this.pauseTimer.unref()
  }

  /** The page plays what it held, from where it paused. Nothing when it is not paused. The watch goes on. */
  private resumePage(): void {
    if (!this.pauseTimer) return
    this.dropPause()
    this.control({ type: 'resume' })
    this.playback.resume()
  }

  /** Stops watching the turn, and resumes the page if it is paused. */
  private endWatch(): void {
    this.watching = false
    this.resumePage()
  }

  /** Forgets the pause timer, for a page that is cleared or gone: a clear ends the page's pause too. */
  private dropPause(): void {
    if (this.pauseTimer) clearTimeout(this.pauseTimer)
    this.pauseTimer = null
  }

  private bargeIn(): void {
    // The page first, so the line stops where the page was, not where its audio had got to.
    this.clearPage()
    this.turn?.abort()
  }

  /**
   * Tells the page to stop playing what it still has of Alex's voice, and what it held if paused (a clear ends a pause).
   * The lines it had not played to the end keep, in the transcript, only the words the meeting heard. (When Alex
   * leaves, stopRecording clears the page itself: the transcript is gone by then.)
   */
  private clearPage(): void {
    this.dropPause()
    this.control({ type: 'clear' })
    this.playback.stop()
  }

  /**
   * Waits for the owner's session to answer. If that takes longer than progressAfterMs, Alex says once that
   * it is still checking, then keeps waiting. Once the turn has stopped (Alex was talked over, asked
   * something else, or asked to leave) it says nothing more, and the bridge, which has the turn's signal,
   * resolves at once with no answer.
   */
  private async waitForAnswer(asking: Promise<SessionAnswer | null>, signal: AbortSignal): Promise<SessionAnswer | null> {
    if (signal.aborted) return asking
    let timer: NodeJS.Timeout | undefined
    const slow = new Promise<'slow'>(resolve => {
      timer = setTimeout(() => resolve('slow'), this.deps.progressAfterMs ?? PROGRESS_AFTER_MS)
    })
    const stop = () => clearTimeout(timer)
    signal.addEventListener('abort', stop, { once: true })
    try {
      const first = await Promise.race([asking, slow])
      if (first !== 'slow') return first
      if (!signal.aborted) {
        // A progress line that fails must not lose the answer that follows it.
        await this.say(PROGRESS_LINE, signal).catch(err => {
          if (!signal.aborted) console.error('[turn] could not say the progress line:', (err as Error).message)
        })
      }
      return await asking
    } finally {
      stop()
      signal.removeEventListener('abort', stop)
    }
  }

  /**
   * This session records and answers nothing more: its reply stops, on the page too, and its transcript,
   * questions and the meeting's additions to the brief go (they can hold answers given in the meeting).
   */
  private stopRecording(): void {
    const first = !this.leaving
    this.leaving = true
    // No pause or resume goes to the page after this: the clear below ends a pause, and the goodbye is never paused.
    this.watching = false
    this.dropPause()
    // Nothing of the transcript is corrected as the turn stops: it goes.
    this.playback.reset()
    this.turn?.abort()
    // The page may still hold audio that has gone out: about a second of a kept line such as the consent
    // line, or the rest of an answer ElevenLabs sent faster than it plays. It is cleared, so nothing more
    // of it is heard, and the goodbye (see leave) plays from when it arrives instead of queueing behind it.
    if (first) this.control({ type: 'clear' })
    this.questions = []
    this.transcript.delete()
    this.additions.clear()
  }

  /**
   * Someone asked Alex to leave, or removed it from the meeting. Everything the meeting has on record
   * goes: the transcript and minutes of every session of it, even one that has already ended. None of
   * them records anything more or writes minutes, including a session for it that starts later.
   */
  private forget(how: Left = 'asked'): void {
    this.records.left ??= how
    for (const session of this.records.sessions) session.stopRecording()
    this.stopRecording()
    // With the copy a correction of the transcript leaves if it fails (see Transcript.amend).
    for (const file of this.records.files) {
      fs.rmSync(file, { force: true })
      fs.rmSync(`${file}.next`, { force: true })
    }
  }

  private async leave(): Promise<void> {
    // At once, before the goodbye: if the meeting ends before the bot has left, nothing is kept. This also
    // stops whatever Alex was saying and clears what the page still had to play (see stopRecording), so the
    // goodbye starts playing as soon as it arrives.
    this.forget()
    await this.runTurn(signal => this.say(LEAVE_LINE, signal))
    // The goodbye has gone out to the page, but has not all played yet: a kept line goes out about a second
    // ahead of what has played, a streamed one as fast as ElevenLabs makes it. The page plays it from when
    // its first piece arrived, nothing queued ahead of it, so wait for the rest of it, and a little more,
    // but no longer: until the bot drops, the meeting is in a call with a bot that has said it is leaving.
    const playing = Math.max(0, this.playback.playsUntil - this.clock())
    await new Promise(r => setTimeout(r, this.deps.leaveDelayMs ?? playing + LEAVE_MARGIN_MS))
    if (this.opts.botId) {
      await this.recall.leaveCall(this.opts.botId).catch(err => console.error('[leave]', err.message))
    }
    this.end() // which asks Recall to delete the media
  }

  /**
   * The meeting has lasted as long as MAX_MEETING_MINUTES allows, a cap on what one meeting can cost (the
   * server counts it from when the bot's page first connected). The bot posts one line in the chat saying so,
   * then leaves the call as at any normal end, so the meeting gets its minutes. Nothing is posted once
   * someone has asked it to leave or removed it, nor once the session is over.
   */
  async reachedTimeLimit(minutes: number): Promise<void> {
    if (this.ended || this.leaving || !this.opts.botId) return
    console.log(`[leave] bot ${this.opts.botId} reached the ${minutes}-minute limit for one meeting (MAX_MEETING_MINUTES)`)
    // The bot leaves even if Recall is slow to post the line: the limit is there to stop the cost.
    const posted = this.postChat(timeLimitLine(minutes)).catch(err => console.error('[chat]', (err as Error).message))
    await within(posted.then(() => {}), TIME_LIMIT_CHAT_WAIT_MS)
    // Asked to leave while the line was on its way: the leave is in charge, and keeps nothing.
    if (this.ended || this.leaving) return
    this.endReason = 'it reached the time limit for one meeting'
    this.end()
  }

  /** The session is over: the meeting ended, the bot was removed or left, or the page disconnected. */
  end(): void {
    if (this.ended) return
    this.ended = true
    // Nothing more goes to the page, a resume included.
    this.watching = false
    this.dropPause()
    // The page has gone, or goes now: what it had not played of Alex's voice was not heard (a paused page, nothing
    // after the pause). Before the turn stops, so the line stops where the page was.
    this.playback.stop()
    this.turn?.abort()
    this.flux.close()
    const botId = this.opts.botId
    if (botId) {
      // Alex can't hear once its page has gone, so it never stays in the call. When the meeting is
      // over or Alex was removed, the bot has left already and Recall just says so.
      if (!this.leaving) {
        this.recall
          .leaveCall(botId)
          .then(() => console.log(`[leave] bot ${botId} left the call: ${this.endReason}`))
          .catch(err => console.log(`[leave] bot ${botId} not asked to leave (it has probably left already): ${err.message}`))
      }
      // No recording of the meeting is kept: whatever Recall stored for this bot goes, however the session ended.
      deleteMediaOnce(botId, id => this.recall.deleteMedia(id))
    }
    this.finish().catch(err => console.error('[meeting_ended]', err))
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close()
  }

  /** meeting_ended as things stand, before any minutes. */
  private endedEvent(): MeetingEnded {
    const meeting = this.opts.meetingKey
    if (this.leaving) {
      const no_minutes = LEFT_NOTES[this.records.left ?? 'asked'] + (this.records.reported ? LEFT_EARLIER_NOTE : '')
      return { type: 'meeting_ended', meeting, transcript_file: '', questions: [], minutes_file: '', no_minutes }
    }
    return { type: 'meeting_ended', meeting, transcript_file: this.transcript.file, questions: this.questions, minutes_file: '' }
  }

  /**
   * How the bot left the call, as Recall tells it (never rejects). A removal by the host is the
   * leave path; anything Recall cannot confirm means no minutes, but the transcript is kept.
   */
  private howEnded(): Promise<recall.BotEnding> {
    const botId = this.opts.botId
    if (!botId) return Promise.resolve({ kind: 'unknown', why: 'no Recall bot is known for this meeting' })
    return this.recall
      .howBotEnded(botId)
      .catch((err: Error): recall.BotEnding => ({ kind: 'unknown', why: `Recall could not be read: ${err.message}` }))
  }

  /**
   * Writes the minutes if the meeting should have them, then tells the owner's session the meeting has
   * ended. One event with everything, so the meeting-assistant (which finishes on it) gets the minutes
   * too; it waits for them at most MINUTES_TIMEOUT_MS. Never throws: a failure is reported in the event.
   */
  private async finish(): Promise<void> {
    let sent = false
    const send = (ended: MeetingEnded): void => {
      if (sent) return
      sent = true
      finishing.delete(this)
      this.records.sessions.delete(this)
      if (ended.transcript_file || ended.minutes_file) this.records.reported = true
      // The additions are for the meeting while it lasts: they go with its last session, rather than
      // staying in memory with the records of finished meetings.
      if (!this.records.sessions.size) this.records.additions.clear()
      this.deps.bridge.notify(ended)
    }
    finishing.set(this, () => {
      const ended = this.endedEvent()
      if (!ended.no_minutes) ended.minutes_error = STOPPED_NOTE
      send(ended)
    })

    // Recall is asked how the bot left (removed, or the meeting ended) while the last words, a leave
    // request perhaps among them, are still on their way: both are waited for before any minutes.
    const ending = this.leaving ? null : this.howEnded()
    await within(this.sttClosed, this.deps.sttFlushMs ?? STT_FLUSH_MS)
    const how = ending && !this.leaving ? await ending : null
    let unconfirmed = ''
    if (how?.kind === 'removed' && !this.leaving) {
      // Removing Alex from the meeting counts as "Alex, please leave": nothing of it is kept.
      console.log(`[leave] bot ${this.opts.botId} was removed from the meeting (${how.sub_code}): its transcript and minutes are deleted`)
      this.forget('removed')
    } else if (how?.kind === 'unknown') {
      unconfirmed = how.why
    } else if (how?.kind === 'ended') {
      console.log(`[meeting] bot ${this.opts.botId} left the call: ${how.sub_code}`)
    }
    const ended = this.endedEvent()
    if (!ended.no_minutes && !this.transcript.participantsSpoke()) ended.no_minutes = 'Nobody said anything, so there are no minutes.'
    if (!ended.no_minutes && unconfirmed) ended.no_minutes = unconfirmedNote(unconfirmed)
    if (ended.no_minutes) return send(ended)
    try {
      const file = await (this.deps.writeMinutes ?? writeMinutes)({
        transcript: this.transcript.text(),
        transcriptFile: this.transcript.file,
        brief: this.deps.brief(),
        questions: this.questions,
        platform: this.opts.platform,
        startedAt: this.startedAt,
        endedAt: new Date(),
      })
      this.records.files.add(file)
      if (this.leaving) {
        // Someone asked Alex to leave (in another session of this meeting) while they were written.
        fs.rmSync(file, { force: true })
        return send(this.endedEvent())
      }
      ended.minutes_file = file
      console.log(`[minutes] wrote ${file}`)
    } catch (err) {
      if (this.leaving) return send(this.endedEvent())
      ended.minutes_error = (err as Error).message || String(err)
      console.error('[minutes] could not write the minutes (the transcript is kept):', ended.minutes_error)
    }
    send(ended)
  }
}
