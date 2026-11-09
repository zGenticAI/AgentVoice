// What the owner's Claude Code session reaches in the voice service's live sessions through the bridge:
// a meeting's transcript, its brief additions, its chat, and an answer that came too late to be said.
// Kept apart from server.ts so it can be tested without starting the service.
import type { BridgeHandlers, SessionAnswer } from './bridge.ts'
import { identity } from './identity.ts'

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

type SessionHandlers = Required<Pick<BridgeHandlers, 'transcript' | 'postChat' | 'addToBrief' | 'lateAnswer'>>

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
    lateAnswer: (meeting, question, answer) => {
      // Only the meeting it was asked in, through the same path as add_to_brief, so it is refused as that
      // is: after a leave or removal, and once the meeting has ended.
      const session = findSession(sessions, meeting)
      if (!session) return { ok: false, note: `${NAME} is no longer in that meeting` }
      return session.addToBrief(lateAnswerText(question, answer))
    },
  }
}
