// The meeting brief: what Alex answers from by itself, and what it must not say. There is the shared brief,
// data/brief.md (set_brief), which every meeting without a brief of its own uses, read again at every answer; and a
// meeting's own brief, given when Alex is sent in (join_meeting's brief, npm run join --brief), which that meeting uses
// instead, and no other. A meeting's own brief is the owner's text, not the meeting's, but it holds that client's
// facts, so it is kept in the service's memory only, for that meeting, until its session is over: never in a file,
// never in the log.
import fs from 'node:fs'
import { WORDS } from './commands.ts'

/**
 * The most a brief may hold, in characters (UTF-16 code units), wherever it comes from. It goes with every spoken
 * answer, so a longer one would make each one slower. A longer brief is refused, never cut: its end often says what
 * must not be shared.
 */
export const MAX_BRIEF_CHARS = 16_000

/** The shared brief's file name, in the data folder. */
export const SHARED_BRIEF_FILE = 'brief.md'

/** Which brief a meeting uses: its own, the shared one, or none (the shared one was empty or refused when it joined). */
export type BriefInUse = 'meeting' | 'shared' | 'none'

/** A brief's text, or '' when there is none. */
export function readBrief(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/**
 * The shared brief as meetings use it: its text, or none and why (tooLong) when it is longer than a brief may be.
 * set_brief refuses a longer one, but data/brief.md can be edited by hand, so it is checked as it is read: refused,
 * never cut, like any other brief.
 */
export function readSharedBrief(file: string): { text: string; tooLong: string } {
  const text = readBrief(file)
  const tooLong = briefTooLong(text)
  return tooLong ? { text: '', tooLong } : { text, tooLong: '' }
}

/** Why this can't be a meeting's brief, or '' if it can. */
export function briefProblem(text: unknown): string {
  if (typeof text !== 'string') return 'The brief has to be text.'
  if (!text.trim()) return `The brief is empty. Leave it out to use the shared brief (${WORDS.ownerPath('data/brief.md')}).`
  return briefTooLong(text)
}

/** Why this brief is too long, or '' if it is not. For set_brief too, which may clear the shared brief with ''. */
export function briefTooLong(text: string): string {
  if (text.length <= MAX_BRIEF_CHARS) return ''
  return `The brief is ${text.length} characters, more than the ${MAX_BRIEF_CHARS} a brief may have: shorten it (it is never cut, since its end often says what must not be shared).`
}
