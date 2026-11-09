// Link between the voice service and the owner's live Claude Code session.
// The zoom-meeting channel server (src/channel/server.ts) runs inside that session
// and connects here over a localhost-only websocket.
//
// Every Claude Code process with the channel loaded links here, including idle pre-started
// ones, so several can be linked at once. All of them stay linked. Questions and meeting events
// go to the ACTIVE one:
// 1. a session whose meeting-assistant is taking questions (its claim holds until hold_until);
// 2. else the session that claimed last: the latest `at`, which is when that session last used
//    join_meeting, reply or next_question. Sessions send it again when they relink, so which one
//    wins does not depend on the order they reconnect in after the voice service restarts.
//    get_transcript, set_brief, add_to_brief and post_chat never move the questions.
// 3. else, when no session has claimed, every linked session: the first reply wins.
//
// Alex waits 60 seconds for a reply, then tells the meeting it couldn't reach the owner's notes. It also stops
// waiting at once when the meeting moves on first: it was talked over, told never mind, asked something
// else or asked to leave, or its page went (the session passes its turn's signal to ask). A reply that
// comes after either is not said, but the bridge remembers recent questions for a while, so it can still
// be kept with that meeting's additions (see lateReply), and the session is told which happened.
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { identity } from './identity.ts'

export type ToSession =
  | { type: 'question'; id: string; question: string; asked_by: string; meeting: string; context: string }
  | { type: 'meeting_started'; meeting: string }
  // transcript_file: '' once deleted at a participant's request. minutes_file: '' when there are no
  // minutes, with why in no_minutes (asked to leave or removed, how it ended not confirmed, nobody
  // spoke) or minutes_error (writing them failed).
  | {
      type: 'meeting_ended'
      meeting: string
      transcript_file: string
      questions: string[]
      minutes_file: string
      no_minutes?: string
      minutes_error?: string
    }
  | { type: 'transcript'; request_id: string; text: string }
  // meeting: for join_meeting, the key Alex's questions from that meeting will carry.
  // For a reply, ok is true when Alex was still waiting for it and will say it. late: Alex had stopped
  // waiting, and why says why: 'timeout' (it told the meeting it couldn't reach the owner's notes) or
  // 'stopped' (the meeting moved on first, so it said nothing about it). kept: the answer went into that
  // meeting's additions all the same (note says why not, when it did not).
  | { type: 'ack'; request_id: string; ok: boolean; note?: string; meeting?: string; late?: boolean; why?: GaveUp; kept?: boolean }

export type FromSession =
  | { type: 'hello' }
  // "Send the questions to me". at: when this session last used join_meeting, reply or next_question
  // (epoch ms; now if left out). hold_until: until when its meeting-assistant is taking questions.
  | { type: 'claim'; at?: number; hold_until?: number }
  // request_id: acknowledged with whether Alex will say it (older channel servers leave it out: no ack).
  | { type: 'reply'; id: string; spoken: string; detail?: string; request_id?: string }
  // meeting: that meeting's key; without it, the latest meeting Alex is in (refused while it is in several).
  | { type: 'post_chat'; request_id: string; message: string; meeting?: string }
  // max_chars: only the latest lines, up to that many characters (500 to 60,000; 12,000 if left out).
  // meeting: that meeting's key; without it, the latest meeting Alex is in.
  | { type: 'get_transcript'; request_id: string; max_chars?: number; meeting?: string }
  | { type: 'set_brief'; request_id: string; markdown: string }
  // Adds to what Alex answers from by itself, for one meeting (its key; the latest meeting if left out).
  | { type: 'add_to_brief'; request_id: string; text: string; meeting?: string }
  | { type: 'join_meeting'; request_id: string; meeting_url: string }

export interface SessionAnswer {
  spoken: string
  detail?: string
}

export type Ack = Extract<ToSession, { type: 'ack' }>

/**
 * Why Alex stopped waiting for a question. 'timeout': no answer came in time (or the only session it went
 * to unlinked), and it told the meeting it couldn't reach the owner's notes. 'stopped': the meeting moved on
 * first (it was talked over, told never mind, asked something else or asked to leave, or its page went),
 * so it never said anything about it.
 */
export type GaveUp = 'timeout' | 'stopped'

export interface BridgeHandlers {
  /** A meeting's transcript (the one with this key, else the latest): its latest lines, up to maxChars characters if given. */
  transcript(maxChars?: number, meeting?: string): string
  /** Posts in the chat of the meeting with this key (else the latest), or refuses with a note. */
  postChat(message: string, meeting?: string): Promise<{ ok: boolean; note?: string }>
  setBrief(markdown: string): void
  /**
   * Adds to what Alex answers from by itself in the meeting with this key (the latest meeting if none),
   * for that meeting only. Without it, add_to_brief is refused as if Alex were in no meeting.
   */
  addToBrief?(text: string, meeting?: string): { ok: boolean; note?: string }
  /**
   * Keeps an answer that came after Alex stopped waiting for it with the additions of the meeting it was
   * asked in, as add_to_brief would, and refused as add_to_brief is (after a leave, or once the meeting
   * is over). Without it, late answers are not kept.
   */
  lateAnswer?(meeting: string, question: string, answer: SessionAnswer): { ok: boolean; note?: string }
  /** Sends Alex into a meeting. Resolves with a note for the session and the meeting's key, or throws with the reason. */
  joinMeeting(meetingUrl: string): Promise<{ note: string; meeting?: string }>
}

// The longest a claim can hold: next_question's longest wait (600 s) plus the assistant's grace period.
export const MAX_HOLD_MS = 11 * 60_000
// What get_transcript's max_chars may ask for: enough to follow the talk, at most a hand-off's worth.
export const TRANSCRIPT_MIN_CHARS = 500
export const TRANSCRIPT_MAX_CHARS = 60_000
// How long, and how many, questions Alex stopped waiting for are remembered, so a late answer can still be
// kept. In memory only, and a meeting's words go at once when it ends with its transcript deleted (a leave
// or removal).
export const LATE_ANSWER_MS = 10 * 60_000
export const LATE_QUESTIONS_KEPT = 50
// Why a late reply to a question from a meeting Alex was asked to leave, or removed from, is not kept.
export const LEFT_NOTE = `${identity.name} was asked to leave that meeting, or removed from it`

/** A question Alex is waiting for an answer to. */
interface Waiting {
  /** The sessions it went to. */
  links: Set<Link>
  meeting: string
  question: string
  resolve: (answer: SessionAnswer | null) => void
}

/**
 * A question Alex stopped waiting for: when, why, and what a late answer needs to be kept. Once Alex is out
 * of its meeting (asked to leave, or removed), left is set and question is '': no word of it stays, only
 * that it was asked, so a late reply hears that nothing of that meeting is kept.
 */
interface Expired {
  at: number
  meeting: string
  question: string
  why: GaveUp
  left?: boolean
}

/** One linked session. n numbers them in the order they linked, for the log. */
interface Link {
  ws: WebSocket
  n: number
  /** When it last claimed the questions (epoch ms); 0 if it never has. */
  at: number
  /** Until when its meeting-assistant is taking questions (epoch ms). */
  holdUntil: number
  /** Orders claims made in the same millisecond. */
  seq: number
}

const isOpen = (link: Link) => link.ws.readyState === WebSocket.OPEN
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export class SessionBridge {
  private links: Link[] = []
  private linked = 0
  private claims = 0
  private logged: string | null = null
  private waiting = new Map<string, Waiting>()
  private expired = new Map<string, Expired>()
  private readonly lateAnswerMs: number

  /** options.lateAnswerMs: how long a late answer can still be kept (tests make it short). */
  constructor(
    private handlers: BridgeHandlers,
    options: { lateAnswerMs?: number } = {},
  ) {
    this.lateAnswerMs = options.lateAnswerMs ?? LATE_ANSWER_MS
  }

  get connected(): boolean {
    return this.links.some(isOpen)
  }

  /** The session questions go to, or null when no linked session has claimed them. */
  private get active(): Link | null {
    const now = Date.now()
    const open = this.links.filter(isOpen)
    const holding = open.filter(l => l.holdUntil > now)
    const pool = holding.length ? holding : open.filter(l => l.at > 0)
    let best: Link | null = null
    for (const l of pool) if (!best || l.at > best.at || (l.at === best.at && l.seq > best.seq)) best = l
    return best
  }

  /** The active session, or every open one when none has claimed. */
  private targets(): Link[] {
    const active = this.active
    this.logActive(active)
    return active ? [active] : this.links.filter(isOpen)
  }

  attach(ws: WebSocket): void {
    const link: Link = { ws, n: ++this.linked, at: 0, holdUntil: 0, seq: 0 }
    this.links.push(link)
    console.log(`[bridge] Claude Code session linked (${this.links.length} linked)`)
    ws.on('message', data => void this.onMessage(link, data.toString()))
    ws.on('error', () => {}) // close follows
    ws.on('close', () => {
      this.links = this.links.filter(l => l !== link)
      // Questions sent only to this session can't be answered now, and Alex says it couldn't reach the owner's
      // notes, as on a timeout. Questions sent to others still can be.
      for (const [id, w] of this.waiting) {
        if (!w.links.delete(link) || w.links.size) continue
        this.giveUp(id, w, 'timeout')
      }
      console.log(`[bridge] Claude Code session unlinked (${this.links.length} linked)`)
      this.logActive(this.active)
    })
    this.logActive(this.active)
  }

  /** Sends a meeting event to the active session (every session if none has claimed). */
  notify(msg: ToSession): void {
    if (msg.type === 'meeting_ended' && !msg.transcript_file) this.forgetMeeting(msg.meeting)
    for (const link of this.targets()) this.send(link, msg)
  }

  /**
   * A meeting that ends with its transcript deleted is one where someone asked Alex to leave, or removed
   * it: nothing of it is kept, so the words of its questions go too, those still waiting included (a late
   * answer to them would be refused anyway). Only that they were asked stays, until they would have been
   * forgotten in any case, so a reply to one hears that nothing is kept rather than to try add_to_brief.
   */
  private forgetMeeting(meeting: string): void {
    for (const [id, w] of this.waiting) if (w.meeting === meeting) this.giveUp(id, w, 'stopped')
    for (const [id, e] of this.expired) if (e.meeting === meeting) this.expired.set(id, { ...e, question: '', left: true })
  }

  /**
   * Sends a question to the active session (every session if none has claimed); resolves with the first
   * answer, or null on timeout or no session. signal: the turn that asked. When it aborts (the meeting has
   * moved on), Alex stops waiting at once and resolves null, and a reply that comes later goes the late way.
   */
  ask(
    q: { question: string; asked_by: string; meeting: string; context: string },
    timeoutMs = 60_000,
    signal?: AbortSignal,
  ): Promise<SessionAnswer | null> {
    // A turn that has already stopped asks nothing.
    if (signal?.aborted) return Promise.resolve(null)
    const targets = this.targets()
    if (!targets.length) return Promise.resolve(null)
    if (targets.length > 1) {
      console.warn(`[bridge] No Claude Code session has claimed the questions, so this one goes to all ${targets.length} linked sessions. Use a zoom-meeting tool in ${identity.owner}'s session (join_meeting, reply or next_question) to claim them.`)
    }
    const id = randomUUID().slice(0, 8)
    return new Promise(resolve => {
      const stopped = () => this.giveUp(id, w, 'stopped')
      const w: Waiting = {
        links: new Set(targets),
        meeting: q.meeting,
        question: q.question,
        resolve: answer => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', stopped)
          resolve(answer)
        },
      }
      const timer = setTimeout(() => this.giveUp(id, w, 'timeout'), timeoutMs)
      timer.unref()
      signal?.addEventListener('abort', stopped, { once: true })
      this.waiting.set(id, w)
      for (const link of targets) this.send(link, { type: 'question', id, ...q })
    })
  }

  /** Alex stops waiting for the question, but it is remembered, with why, for a late answer. */
  private giveUp(id: string, w: Waiting, why: GaveUp): void {
    // Once only: whichever comes first of an answer, the timeout, the session unlinking or the turn stopping.
    if (this.waiting.get(id) !== w) return
    this.waiting.delete(id)
    this.expired.set(id, { at: Date.now(), meeting: w.meeting, question: w.question, why })
    // Forgotten on time even when nothing else happens on the bridge for hours: the words are the meeting's.
    setTimeout(() => this.expired.delete(id), this.lateAnswerMs).unref()
    this.forgetOldQuestions()
    w.resolve(null)
  }

  /** Forgets the questions given up on more than lateAnswerMs ago, and the oldest past LATE_QUESTIONS_KEPT. */
  private forgetOldQuestions(): void {
    const since = Date.now() - this.lateAnswerMs
    // Oldest first: a Map keeps the order they were given up in.
    for (const [id, e] of this.expired) {
      if (e.at >= since && this.expired.size <= LATE_QUESTIONS_KEPT) break
      this.expired.delete(id)
    }
  }

  /**
   * A reply to a question Alex is no longer waiting for. It is never said. If Alex gave up on it lately (it
   * timed out, or the meeting moved on), it is kept with that meeting's additions, unless the meeting is
   * over or Alex was asked to leave it, so Alex answers from it if it comes up again. Each question is kept once.
   */
  private lateReply(id: string, answer: SessionAnswer): Omit<Ack, 'type' | 'request_id'> {
    this.forgetOldQuestions()
    const asked = this.expired.get(id)
    if (!asked) {
      const why = 'another session answered it first, or it was asked too long ago'
      return { ok: false, note: `${identity.name} is not waiting for that answer: ${why}` }
    }
    this.expired.delete(id)
    if (asked.left) {
      console.log(`[bridge] An answer came for a meeting ${identity.name} was asked to leave or removed from: not kept`)
      return { ok: false, late: true, why: asked.why, kept: false, note: LEFT_NOTE }
    }
    let kept: { ok: boolean; note?: string }
    try {
      kept = this.handlers.lateAnswer?.(asked.meeting, asked.question, answer) ?? { ok: false, note: 'this voice service does not keep late answers' }
    } catch (err) {
      kept = { ok: false, note: (err as Error).message }
    }
    // What happened, never what was said: no meeting content in the log.
    const outcome = kept.ok ? "kept with its meeting's additions" : `not kept (${kept.note})`
    console.log(`[bridge] An answer came after ${identity.name} had stopped waiting for it (${asked.why}): ${outcome}`)
    return { ok: false, late: true, why: asked.why, kept: kept.ok, ...(kept.note ? { note: kept.note } : {}) }
  }

  private send(link: Link, msg: ToSession): void {
    if (isOpen(link)) link.ws.send(JSON.stringify(msg))
  }

  /** One line when questions start going to a different session. */
  private logActive(active: Link | null): void {
    const now = active ? `#${active.n}` : this.connected ? 'all' : 'none'
    if (now === this.logged) return
    this.logged = now
    if (active) console.log(`[bridge] Questions now go to Claude Code session #${active.n}`)
    else if (this.connected) console.log('[bridge] No session has claimed the questions: they go to every linked session')
  }

  /** Makes this link the one that claimed last, as of `at` (never later than now). */
  private claim(link: Link, at: number, holdUntil: number): void {
    const now = Date.now()
    link.at = Math.min(at > 0 ? at : now, now)
    link.holdUntil = Math.min(Math.max(0, holdUntil), now + MAX_HOLD_MS)
    link.seq = ++this.claims
    this.logActive(this.active)
  }

  private async onMessage(link: Link, raw: string): Promise<void> {
    let msg: FromSession
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof msg?.type !== 'string') return
    switch (msg.type) {
      case 'claim':
        this.claim(link, num(msg.at), num(msg.hold_until))
        break
      case 'reply': {
        // Answering a question claims the next ones, keeping any hold its assistant has.
        this.claim(link, Date.now(), link.holdUntil)
        const id = String(msg.id ?? '')
        const answer: SessionAnswer = { spoken: String(msg.spoken ?? ''), detail: msg.detail ? String(msg.detail) : undefined }
        // The first reply wins, whichever session sends it.
        const w = this.waiting.get(id)
        let result: Omit<Ack, 'type' | 'request_id'>
        if (w) {
          this.waiting.delete(id)
          w.resolve(answer)
          result = { ok: true }
        } else {
          result = this.lateReply(id, answer)
        }
        // The session hears whether Alex will say it, so it never takes an answer as given when it wasn't.
        if (typeof msg.request_id === 'string' && msg.request_id) this.send(link, { type: 'ack', request_id: msg.request_id, ...result })
        break
      }
      // Answers to requests go back to the session that asked, active or not.
      case 'get_transcript': {
        const asked = typeof msg.max_chars === 'number' && Number.isFinite(msg.max_chars) ? Math.round(msg.max_chars) : undefined
        const maxChars = asked === undefined ? undefined : Math.min(TRANSCRIPT_MAX_CHARS, Math.max(TRANSCRIPT_MIN_CHARS, asked))
        const meeting = typeof msg.meeting === 'string' && msg.meeting ? msg.meeting : undefined
        this.send(link, { type: 'transcript', request_id: msg.request_id, text: this.handlers.transcript(maxChars, meeting) })
        break
      }
      case 'post_chat': {
        // Keyed like get_transcript, so a meeting's follow-up never lands in another meeting's chat.
        const meeting = typeof msg.meeting === 'string' && msg.meeting ? msg.meeting : undefined
        let result: { ok: boolean; note?: string }
        try {
          result = await this.handlers.postChat(String(msg.message ?? ''), meeting)
        } catch (err) {
          result = { ok: false, note: (err as Error).message }
        }
        this.send(link, { type: 'ack', request_id: msg.request_id, ok: result.ok, note: result.note })
        break
      }
      case 'set_brief':
        this.handlers.setBrief(String(msg.markdown ?? ''))
        this.send(link, { type: 'ack', request_id: msg.request_id, ok: true })
        break
      case 'add_to_brief': {
        // Like set_brief, it does not take the questions: a session getting ahead of them is not answering them.
        const meeting = typeof msg.meeting === 'string' && msg.meeting ? msg.meeting : undefined
        let result: { ok: boolean; note?: string }
        try {
          const none = { ok: false, note: `${identity.name} is not in a meeting right now` }
          result = this.handlers.addToBrief?.(String(msg.text ?? ''), meeting) ?? none
        } catch (err) {
          result = { ok: false, note: (err as Error).message }
        }
        this.send(link, { type: 'ack', request_id: msg.request_id, ok: result.ok, note: result.note })
        break
      }
      case 'join_meeting': {
        // The session that sends Alex into a meeting gets its questions.
        this.claim(link, Date.now(), link.holdUntil)
        try {
          const { note, meeting } = await this.handlers.joinMeeting(String(msg.meeting_url ?? ''))
          this.send(link, { type: 'ack', request_id: msg.request_id, ok: true, note, meeting })
        } catch (err) {
          this.send(link, { type: 'ack', request_id: msg.request_id, ok: false, note: (err as Error).message })
        }
        break
      }
    }
  }
}
