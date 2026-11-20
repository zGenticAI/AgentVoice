// What Alex did with each of the latest lines of a meeting, and why, for the owner's session when the owner asks
// why Alex didn't answer something (the channel's why_not_answered). The reasons are the attention rules' own
// verdicts (attention() in src/brain/attention.ts) and the checks the session makes around them (onUtterance in
// src/pipeline/session.ts): nothing here decides anything, it only remembers what was decided.
// In memory only, for one session: never written to disk or logged. It goes when the session ends, and at once,
// with the transcript, when Alex is asked to leave or removed.
import type { Attention } from '../brain/attention.ts'
import { type LineVerdict, WHY_MAX_LINES } from '../bridge.ts'
import { identity } from '../identity.ts'

const NAME = identity.name
const OWNER = identity.owner

// The most of a line why_not_answered gives, in characters: enough to know the line, without a monologue filling the
// owner's session. The transcript keeps the whole line.
export const WHY_LINE_CHARS = 500
// A window that closed longer ago than this is not why a line went unanswered: the meeting had moved on. Only a window
// that closed within it is reported.
export const CLOSED_WINDOW_SHOWN_MS = 60_000

/**
 * How Alex read a line: the attention rules' verdict (asked, called, nothing_asked, mentioned, no_name), or what the
 * session decided before asking them. reply and after_call: taken without the name, in the window an answer that
 * ended on a question, or a call ("Alex?"), opened. filler: only "um" or "uh". cancel: "Alex, never mind".
 * page_away: heard while the bot page was reconnecting. slides: a slide command, in a meeting with slides to present.
 */
export type Reading = Attention | 'reply' | 'after_call' | 'filler' | 'cancel' | 'page_away' | 'slides'

/** What Alex did with a line. Those taken change as the answer goes on (waiting, answering, handed, then the end). */
export type Outcome =
  | 'nothing'
  | 'stopped'
  | 'waiting'
  | 'answering'
  | 'answered'
  | 'refused'
  | 'handed'
  | 'session_answered'
  | 'no_session_answer'
  | 'no_taker'
  | 'cut_off'
  | 'replaced'
  | 'failed'
  | 'slide_command'

/** A window Alex had opened (see Reading) that closed before a line it would have taken: which, and how long before (ms). */
export interface ClosedWindow {
  kind: 'reply' | 'called'
  closedMs: number
}

/** One line, as the session heard it. The session changes outcome and handed as the answer goes on. */
export interface Verdict {
  /** When it was heard (epoch ms). */
  readonly at: number
  readonly text: string
  readonly reading: Reading
  outcome: Outcome
  /** Heard while Alex said the consent line. */
  readonly duringConsent: boolean
  /** It went to the owner's session. */
  handed: boolean
  /** Its answer was stopped by the consent line coming due: it was asked just before the line. */
  byConsent?: boolean
  /** For a line not taken: a window that had closed less than CLOSED_WINDOW_SHOWN_MS before it. */
  readonly window?: ClosedWindow
  /** For a slide command: which one ("next", "go to slide 5"), and what came of it. */
  readonly command?: string
  /** It talked over the slides Alex was presenting, and held them at the sentence the meeting stopped hearing. */
  readonly heldDeck?: boolean
}

const READINGS: Record<Reading, (v: Verdict) => string> = {
  asked: () => `Said to ${NAME} by name, with a question or a request.`,
  reply: () => `Taken as the reply to the question ${NAME} had just ended its answer on: that window takes the next line, without the name.`,
  after_call: () => `Taken as the line after a call: someone had just said only "${NAME}?" or announced a question, so the next line went to ${NAME} without the name.`,
  called: v =>
    `Only called ${NAME}: the name alone, or a question announced ("${NAME}, quick question."). ${NAME} says nothing, and takes the next line said within 10 seconds` +
    `${v.duringConsent ? ', counted from the end of the consent line' : ''}.`,
  nothing_asked: () =>
    `Said to ${NAME}, but read as asking nothing: thanks, praise or a goodbye; asking ${NAME} to wait, or putting it off; the host moving on ("Thanks ${NAME}, who's next?") ` +
    'or a question for someone else; or a question the rules cannot tell from a remark without its question mark ("is the API ready.").',
  mentioned: () =>
    `Read as talk about ${NAME}, not to it: the name inside or at the end of a sentence without a comma before it ("I asked ${NAME} yesterday"), ` +
    `introduced between commas ("${NAME}, the AI, is listening."), or with no comma after it before "is", "did", "has" and the like ("${NAME} is great at this"). ` +
    `Said to ${NAME}, the name starts the sentence or is set off by commas.`,
  no_name: v => `${NAME}'s name was not in it, as speech recognition wrote it${v.window ? '.' : `, and ${NAME} was not waiting for a reply.`}`,
  filler: () => `Only "um", "uh" or the like: someone thinking. It changes nothing, and leaves a reply window open.`,
  cancel: () => `Told never mind, or to stop.`,
  page_away: () => `Heard while ${NAME}'s bot page was reconnecting: kept in the transcript, but not answered, since ${NAME} could not have said the answer.`,
  slides: v =>
    `Read as a command for the slides ${NAME} is presenting (${v.command ?? 'a slide command'}): said to ${NAME} by name, or in a window it had opened, ` +
    'so it was not a question to answer.',
}

const HANDED = `${NAME} handed it to ${OWNER}'s session`
const OUTCOMES: Record<Outcome, (v: Verdict) => string> = {
  nothing: () => `${NAME} said nothing.`,
  stopped: v => `${NAME} stopped what it was doing and said nothing.${v.duringConsent ? ' The consent line went on: it is always said in full.' : ''}`,
  waiting: () => `${NAME} answers once the consent line is over.`,
  answering: () => `${NAME} is answering.`,
  answered: () => `${NAME} answered it.`,
  refused: () => `${NAME} declined it, and left it for ${OWNER}.`,
  handed: () => `${HANDED}, and is waiting for its answer.`,
  session_answered: () => `${HANDED}, and said its answer.`,
  no_session_answer: () => `${HANDED}, but no answer came in time (or no session was linked), so ${NAME} said it couldn't reach ${OWNER}'s notes.`,
  no_taker: () =>
    `${HANDED}, but no session could take it: ${OWNER}'s session can't be sent questions without its meeting-assistant running, and none was ` +
    `taking them, so ${NAME} said at once that it couldn't reach ${OWNER}'s notes. Start the meeting-assistant in ${OWNER}'s session, ` +
    'with the meeting key, so the next questions reach it.',
  cut_off: v =>
    (v.byConsent
      ? `${NAME} stopped before it finished: the consent line came due as it answered, and took its place. The line was not answered after it.`
      : `${NAME} stopped before it finished: it was talked over, told never mind, asked something else, or its page went.`) +
    (v.handed ? ` It had handed the question to ${OWNER}'s session: an answer that came after is kept, so asking again gets it at once.` : ''),
  replaced: () =>
    'Asked during the consent line, and dropped before the line was over: something said after it took its place (another question, or never mind), ' +
    `or ${NAME}'s bot page went.`,
  failed: () => `${NAME} could not answer: Claude or ElevenLabs failed (the service log has the error).`,
  slide_command: () => `${NAME} did what the command asked of the slides, if it could then.`,
}

/** Why the slides stopped: a line that talked over the narration. */
const HELD_DECK =
  `It talked over the slides ${NAME} was presenting, so ${NAME} stopped at that sentence and held them. ` +
  `They carry on from that sentence: after an answer, with "Back to" the slide's title; after other talk, once the room is quiet and ${NAME} has asked "Shall I carry on?".`

/** A window that had closed before the line came, which would otherwise have taken it without the name. */
const windowText = (w: ClosedWindow) =>
  `${NAME} had been waiting for ${w.kind === 'reply' ? 'a reply to its question' : 'the line after a call'}, ` +
  `but that closed ${Math.round(w.closedMs / 1000)} seconds before this line.`

/** "hh:mm:ss" (UTC), as the transcript file has it. */
const clock = (ms: number) => new Date(ms).toISOString().slice(11, 19)

/** A line cut to WHY_LINE_CHARS with "…", never between the two halves of a character outside the BMP. */
function capped(text: string): string {
  if (text.length <= WHY_LINE_CHARS) return text
  let end = WHY_LINE_CHARS - 1
  if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--
  return `${text.slice(0, end)}…`
}

/** The latest lines of one session and what Alex did with each: at most WHY_MAX_LINES, the oldest going first. */
export class Verdicts {
  private entries: Verdict[] = []

  /** Remembers a line. The verdict returned is the one the session updates as the answer goes on. */
  add(line: Omit<Verdict, 'at' | 'handed'> & { at?: number }): Verdict {
    const { window, ...rest } = line
    const shown = window && window.closedMs <= CLOSED_WINDOW_SHOWN_MS ? { window } : {}
    const verdict: Verdict = { at: Date.now(), handed: false, ...rest, ...shown }
    this.entries.push(verdict)
    if (this.entries.length > WHY_MAX_LINES) this.entries.shift()
    return verdict
  }

  /** The latest `count` lines (all those kept if not given), newest last, with why in plain words. */
  latest(count = WHY_MAX_LINES, now = Date.now()): LineVerdict[] {
    return this.entries.slice(-Math.max(1, count)).map(v => ({
      at: clock(v.at),
      seconds_ago: Math.max(0, Math.round((now - v.at) / 1000)),
      line: capped(v.text),
      did: v.outcome,
      read: v.reading,
      why: [READINGS[v.reading](v), v.window && windowText(v.window), OUTCOMES[v.outcome](v), v.heldDeck && HELD_DECK].filter(Boolean).join(' '),
    }))
  }

  clear(): void {
    this.entries = []
  }
}
