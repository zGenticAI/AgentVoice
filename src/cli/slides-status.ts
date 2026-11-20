// What npm run slides -- status and control print: the voice service's answer from /api/slides, in plain lines. Kept
// apart from the command so it can be tested without a voice service. Slide titles come from the deck: they are your own
// content, printed in your own terminal.
import type { PresenterStatus } from '../slides/presenter.ts'

const STATES: Record<PresenterStatus['state'], string> = {
  ready: 'ready to start',
  starting: 'starting to share',
  checking: 'asking whether everyone can see the slides',
  narrating: 'presenting',
  held: 'held',
  qa: 'taking questions on the last slide',
  stopped: 'stopped (it can be started again)',
  ended: 'ended for this meeting',
  disposed: 'over: the meeting has ended',
}

const HOLDS: Record<NonNullable<PresenterStatus['held']>, string> = {
  question: 'answering a question',
  talk: 'someone talked over it',
  asked: 'someone said pause, or never mind',
  owner: 'you paused it: only you can resume it',
  page_away: 'its camera page is reconnecting',
  deaf: "it can't hear the meeting",
  voice: 'its voice failed',
  detour: 'showing a slide out of order',
}

/** One line for a presentation's status. */
export function statusLine(status: PresenterStatus, bot?: string): string {
  const on = status.slide === null ? 'no slide on screen' : `slide ${status.slide} on screen${status.title ? ` ("${status.title}")` : ''}`
  const held = status.state === 'held' && status.held ? ` (${HOLDS[status.held]})` : ''
  const where = bot ? `Bot ${bot}: ` : ''
  // Slide numbers are PDF page numbers, so the count of slides in the meeting is put apart from them.
  const count = `${status.of} slide${status.of === 1 ? ' is' : 's are'} in this meeting`
  return `${where}${STATES[status.state] ?? status.state}${held}, ${on}; it carries on from slide ${status.bookmark}; ${count}. The share is ${status.share}.`
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
  const note = typeof answer.note === 'string' ? answer.note : ''
  if (answer.ok !== true) lines.push(`Not done: ${note || `${name} gave no reason`}.`)
  else if (note) lines.push(note)
  if (answer.status && typeof answer.status === 'object') lines.push(statusLine(answer.status, typeof answer.bot === 'string' ? answer.bot : undefined))
  return { lines, code: answer.ok === true ? 0 : 1 }
}
