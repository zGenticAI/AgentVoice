// What npm run slides -- status and control print: the voice service's answer from /api/slides, in plain lines. Kept
// apart from the command so it can be tested without a voice service. Slide titles come from the deck: they are your own
// content, printed in your own terminal.
import { HOLD_WORDS, type PresenterStatus, STATE_WORDS } from '../slides/presenter.ts'

/** One line for a presentation's status. */
export function statusLine(status: PresenterStatus, bot?: string): string {
  const on = status.slide === null ? 'no slide on screen' : `slide ${status.slide} on screen${status.title ? ` ("${status.title}")` : ''}`
  const held = status.state === 'held' && status.held ? ` (${HOLD_WORDS[status.held]})` : ''
  const where = bot ? `Bot ${bot}: ` : ''
  // Slide numbers are PDF page numbers, so the count of slides in the meeting is put apart from them.
  const count = `${status.of} slide${status.of === 1 ? ' is' : 's are'} in this meeting`
  return `${where}${STATE_WORDS[status.state] ?? status.state}${held}, ${on}; it carries on from slide ${status.bookmark}; ${count}. The share is ${status.share}.`
}

/** The lines to print, and the exit code, for the voice service's answer to /api/slides. */
export function presentationLines(reply: { status: number; body: string }, name: string): { lines: string[]; code: number } {
  if (reply.status !== 200) return { lines: [`The voice service refused it: ${reply.body.slice(0, 300)}`], code: 1 }
  let answer: { ok?: unknown; note?: unknown; bot?: unknown; status?: PresenterStatus }
  try {
    answer = JSON.parse(reply.body)
  } catch {
    return { lines: ['The voice service gave an answer that is not JSON: is it older than this command? Restart it.'], code: 1 }
  }
  const lines: string[] = []
  // A note is a sentence with its own full stop: never doubled, and no "Not done:" before one that refuses already.
  const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`)
  const note = typeof answer.note === 'string' ? answer.note.trim() : ''
  if (answer.ok !== true) lines.push(/^Not (?:now|yet):/.test(note) ? sentence(note) : `Not done: ${sentence(note || `${name} gave no reason`)}`)
  else if (note) lines.push(sentence(note))
  if (answer.status && typeof answer.status === 'object') lines.push(statusLine(answer.status, typeof answer.bot === 'string' ? answer.bot : undefined))
  return { lines, code: answer.ok === true ? 0 : 1 }
}
