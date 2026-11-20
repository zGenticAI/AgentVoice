// What the owner's Claude Code session reaches in the voice service's live sessions through the bridge:
// a meeting's transcript, its brief additions, its chat, an answer that came too late to be said, what
// Alex did with its latest lines (why_not_answered), and the slides it presents (slides_status, slides_control, and
// npm run slides -- status and control through the control socket).
// Kept apart from server.ts so it can be tested without starting the service.
import type { BridgeHandlers, LineVerdict, SessionAnswer } from './bridge.ts'
import { identity } from './identity.ts'
import { OWNER_ACTIONS, type OwnerAction, type PresenterStatus } from './slides/presenter.ts'

const NAME = identity.name
const OWNER = identity.owner

/** What these handlers use of a MeetingSession. */
export interface LiveSession {
  readonly opts: { readonly meetingKey: string }
  /** The meeting's Recall bot: a session without one has no chat to post in. */
  readonly botId?: string
  readonly transcript: { recent(maxChars?: number): string }
  /** Refused, with a note, once Alex was asked to leave or removed, or the session has ended. */
  addToBrief(text: string): { ok: boolean; note?: string }
  postChat(message: string): Promise<boolean>
  /** What Alex did with the latest lines, and why. Refused, with a note, once Alex was asked to leave or removed, or the session has ended. */
  whyNotAnswered(lines: number): { ok: boolean; lines?: LineVerdict[]; note?: string }
  /** A meeting joined with slides presents them: the owner's controls. Null or absent in any other meeting. */
  readonly presenter?: PresenterControls | null
}

/** What the owner's controls use of a meeting's Presenter (src/slides/presenter.ts). */
export interface PresenterControls {
  owner(action: OwnerAction, slide?: number): { ok: boolean; note: string }
  status(): PresenterStatus
}

/** What the owner's slide controls answer: the meeting (its key and bot), how it went, and the presentation now. */
export interface SlidesAnswer {
  ok: boolean
  note?: string
  meeting?: string
  bot?: string
  status?: PresenterStatus
}

/**
 * The session a request is for. With a meeting key: that meeting's newest session (its page may have
 * reconnected), or none, never another meeting. Without one: the newest session, of whichever meeting's
 * page connected last.
 */
export function findSession<S extends LiveSession>(sessions: Iterable<S>, meeting?: string): S | undefined {
  const newestFirst = [...sessions].reverse()
  if (meeting) return newestFirst.find(s => s.opts.meetingKey === meeting)
  return newestFirst[0]
}

/** How many meetings Alex is in: a meeting whose page reconnected counts once. */
function meetingCount(sessions: Iterable<LiveSession>): number {
  return new Set([...sessions].map(s => s.opts.meetingKey)).size
}

/**
 * How an answer that came after Alex had given up on it is kept. Unlike one that came in time, the meeting
 * has not heard it, nor seen its detail in the chat, so it says so: Alex then gives it if it comes up again.
 * (After a timeout Alex said it couldn't reach the owner's notes; when the meeting moved on first, it said
 * nothing about it: the transcript shows which.)
 */
export function lateAnswerText(question: string, answer: SessionAnswer): string {
  const detail = answer.detail?.trim()
  return (
    `${OWNER}'s session answered "${question}" after ${NAME} had stopped waiting for it, ` +
    `so the meeting has not heard this answer: ${answer.spoken.trim()}${detail ? ` (More detail: ${detail})` : ''}`
  )
}

type SessionHandlers = Required<Pick<BridgeHandlers, 'transcript' | 'postChat' | 'addToBrief' | 'lateAnswer' | 'whyNotAnswered'>>

/** The bridge handlers that act on the live sessions (server.ts adds setBrief and joinMeeting). */
export function sessionHandlers(sessions: Iterable<LiveSession>): SessionHandlers {
  return {
    transcript: (maxChars, meeting) => {
      const session = findSession(sessions, meeting)
      if (session) return session.transcript.recent(maxChars)
      return meeting ? `(${NAME} is not in that meeting right now)` : '(no meeting in progress)'
    },
    postChat: async (message, meeting) => {
      // Everyone in the meeting sees a post, and it can't be taken back: without a key, when Alex is in more
      // than one meeting, it is refused rather than sent to whichever started last.
      if (!meeting && meetingCount(sessions) > 1) {
        return { ok: false, note: `${NAME} is in more than one meeting right now: pass the meeting key as "meeting"` }
      }
      const session = findSession(sessions, meeting)
      if (meeting && !session) return { ok: false, note: `${NAME} is not in that meeting right now` }
      // Only a session that knows its bot can post in the meeting chat.
      if (!session?.botId) return { ok: false, note: `${NAME} is not in a meeting with a chat right now` }
      if (!(await session.postChat(message))) {
        return { ok: false, note: `${NAME} was asked to leave that meeting, or removed from it, so nothing more is posted there` }
      }
      // Kept with the meeting's additions once it is posted, so Alex can answer about what was posted.
      session.addToBrief(`${NAME} posted in the meeting chat: ${message}`)
      return { ok: true }
    },
    addToBrief: (text, meeting) => {
      const session = findSession(sessions, meeting)
      if (!session) return { ok: false, note: `${NAME} is not in ${meeting ? 'that meeting' : 'a meeting'} right now` }
      return session.addToBrief(text)
    },
    whyNotAnswered: (lines, meeting) => {
      const session = findSession(sessions, meeting)
      if (!session) return { ok: false, note: `${NAME} is not in ${meeting ? 'that meeting' : 'a meeting'} right now` }
      return { ...session.whyNotAnswered(lines), meeting: session.opts.meetingKey }
    },
    lateAnswer: (meeting, question, answer) => {
      // Only the meeting it was asked in, through the same path as add_to_brief, so it is refused as that
      // is: after a leave or removal, and once the meeting has ended.
      const session = findSession(sessions, meeting)
      if (!session) return { ok: false, note: `${NAME} is no longer in that meeting` }
      return session.addToBrief(lateAnswerText(question, answer))
    },
  }
}

/**
 * The meeting the owner's slide controls are for: with a key (a meeting's key, or its bot's id, which npm run join
 * prints), that meeting's newest session, never another; without one, the only meeting with slides, and refused while
 * there are several, as post_chat is.
 */
function presenting<S extends LiveSession>(sessions: Iterable<S>, meeting?: string): { session: S; presenter: PresenterControls } | { note: string } {
  const newestFirst = [...sessions].reverse()
  if (meeting) {
    const session = newestFirst.find(s => s.opts.meetingKey === meeting || s.botId === meeting)
    if (!session) return { note: `${NAME} is not in that meeting right now` }
    if (!session.presenter) return { note: `that meeting has no slides: send ${NAME} in with slides to present them` }
    return { session, presenter: session.presenter }
  }
  const withSlides = newestFirst.filter(s => s.presenter)
  const keys = new Set(withSlides.map(s => s.opts.meetingKey))
  if (!keys.size) return { note: `${NAME} has no slides to present in any meeting right now` }
  if (keys.size > 1) return { note: `${NAME} has slides in more than one meeting right now: pass the meeting key as "meeting"` }
  return { session: withSlides[0], presenter: withSlides[0].presenter! }
}

/** The owner's controls of the slides Alex presents: slides_status and slides_control, and /api/slides. */
export function slidesHandlers(sessions: Iterable<LiveSession>): {
  slidesStatus(meeting?: string): SlidesAnswer
  slidesControl(action: unknown, slide: unknown, meeting?: string): SlidesAnswer
} {
  const which = (session: LiveSession) => ({ meeting: session.opts.meetingKey, ...(session.botId ? { bot: session.botId } : {}) })
  return {
    slidesStatus: meeting => {
      const found = presenting(sessions, meeting)
      if ('note' in found) return { ok: false, note: found.note }
      return { ok: true, ...which(found.session), status: found.presenter.status() }
    },
    slidesControl: (action, slide, meeting) => {
      if (typeof action !== 'string' || !(OWNER_ACTIONS as readonly string[]).includes(action)) {
        return { ok: false, note: `action has to be one of ${OWNER_ACTIONS.join(', ')}` }
      }
      if (slide !== undefined && slide !== null && (typeof slide !== 'number' || !Number.isInteger(slide) || slide < 1 || slide > 100)) {
        return { ok: false, note: 'slide has to be a slide number from 1 to 100' }
      }
      const found = presenting(sessions, meeting)
      if ('note' in found) return { ok: false, note: found.note }
      const done = found.presenter.owner(action as OwnerAction, typeof slide === 'number' ? slide : undefined)
      return { ...done, ...which(found.session), status: found.presenter.status() }
    },
  }
}
