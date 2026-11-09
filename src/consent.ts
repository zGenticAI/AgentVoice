// The consent wording: what the assistant says and posts word for word. It tells the meeting the assistant is an
// AI, that it is transcribing, that it can agree to nothing, and how to make it leave, and that never changes.
// Only the names in it are settings: the assistant's and its owner's (src/identity.ts), filled in once, at start-up.
// The company is never in it. Whoever runs the assistant is responsible for the wording being right where they and
// the people they meet are: review it against the recording and consent rules that apply there before use.
import { config } from './config.ts'
import { type Names, defaultBotName, identity } from './identity.ts'

/** Everything the assistant says word for word, for one assistant and owner. */
export interface ConsentLines {
  /** Said on joining, always in full. */
  join: string
  /** The goodbye after a request to leave. */
  leave: string
  /** Said, in turn, while a question goes to the owner's session. */
  checking: readonly string[]
  /** Said once when the owner's session is slow to answer. */
  progress: string
  /** Said when the owner's session can't be reached. */
  offline: string
  /** Said when Claude declines to answer. */
  refusal: string
}

/** The fixed lines for this assistant and owner. They name the owner, never with a pronoun, so none needs setting. */
export function consentLines(id: Pick<Names, 'name' | 'owner'>): ConsentLines {
  const { name, owner } = id
  return {
    // Said when the assistant joins, and always in full, since it tells the meeting how to make it leave: talking
    // over it or "<name>, never mind" doesn't stop it. A leave request, its removal or the end of the session do
    // (src/pipeline/session.ts). The phrase it teaches is checked at start-up to be a leave request (src/name-check.ts).
    join:
      `Hello, I'm ${name}, ${owner}'s AI assistant. I'm transcribing this meeting so I can answer questions ` +
      `when you say my name. I'll only speak when asked, and I can't agree to anything for ${owner}. ` +
      `If you'd like me to leave, say "${name}, please leave", or remove me from the participant list.`,
    leave: "Of course. I'm leaving now, and I'll delete my transcript of this meeting.",
    // Said while a question goes to the owner's session: the question is sent first, so the session is already on it
    // as the assistant says this. They are taken in turn, so several hand-offs in one meeting don't all sound the
    // same.
    checking: [`Let me check that with ${owner}'s notes.`, `One moment, I'll check ${owner}'s notes.`, `Let me look that up in ${owner}'s notes.`],
    // Said once when the owner's session takes a while to answer, so the meeting knows the assistant is still on it.
    progress: 'Still checking. One moment.',
    offline: `I can't reach ${owner}'s notes right now, so I'll pass that question on to ${owner}.`,
    refusal: `Sorry, I can't help with that one. I'll leave it for ${owner}.`,
  }
}

/** The notice posted in the meeting chat when the assistant joins. */
export function joinChatMessage(id: Pick<Names, 'name' | 'owner'> = identity, retentionDays = config.retentionDays): string {
  const { name, owner } = id
  return (
    `${defaultBotName(name, owner)} has joined. I transcribe this meeting to answer questions when asked by name, ` +
    `and afterwards I send ${owner} a summary to keep. I keep no recording of the meeting, and I delete my own ` +
    `transcripts and summaries after ${retentionDays} days. To stop me, say "${name}, please leave" or remove me.`
    // A link to your own privacy notice could follow here (the README's "Responsible use" says what it should cover).
  )
}

/**
 * Every line the assistant says word for word. Their audio is made once per voice and kept on disk
 * (src/pipeline/line-cache.ts), so they play at once. Nothing else it says is ever kept that way. A new name
 * makes new lines, so their audio is made again at the next start, and the old files are removed.
 */
export function fixedLines(lines: ConsentLines): readonly string[] {
  return [lines.join, lines.leave, ...lines.checking, lines.progress, lines.offline, lines.refusal]
}

// The lines for the assistant this process is.
const LINES = consentLines(identity)

export const JOIN_LINE = LINES.join
export const LEAVE_LINE = LINES.leave
export const CHECKING_LINES: readonly string[] = LINES.checking
export const CHECKING_LINE = CHECKING_LINES[0]
export const PROGRESS_LINE = LINES.progress
export const SESSION_OFFLINE_LINE = LINES.offline
export const REFUSAL_LINE = LINES.refusal
export const FIXED_LINES: readonly string[] = fixedLines(LINES)
