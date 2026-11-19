// The screen-share test's report, made to be pasted back to a Claude Code session: the verdict, the camera page in each
// step (the decisive result), each step with its timings and answers, and what the test page measured in the bot's
// browser. Pure: the driver (src/cli/share-test-run.ts) gathers the records, and scrubs everything before it is printed.
import { PLATFORM_NAMES, type Platform } from '../recall.ts'
import type { PageHello } from './protocol.ts'

export const REPORT_END = 'Paste this whole report back to your Claude Code session.'

export const STEP_IDS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9'] as const
export type StepId = (typeof STEP_IDS)[number]
export type StepResult = 'PASS' | 'FAIL' | 'SKIPPED' | 'UNKNOWN'

export const STEP_TITLES: Record<StepId, string> = {
  S1: 'baseline',
  S2: 'share',
  S3: 'voice while sharing',
  S4: 'listening while sharing',
  S5: 'slide changes',
  S6: 'hold',
  S7: 'replace',
  S8: 'stop',
  S9: 'restart',
}

/** An answer the owner gave: y, n, s (skipped), a ladder size or none, or '' when none came in time. */
export interface Answer {
  /** What the question was for: seen, retry, ladder, heard, answered, counted, session or gone. */
  key: string
  question: string
  answer: string
}

/** What one step did. Times are ms; the timings are named for what they measure. */
export interface StepRecord {
  id: StepId
  title: string
  ran: boolean
  result: StepResult
  /** Why it is not a plain pass, in a few words each. */
  why: string[]
  started_ms: number | null
  took_ms: number | null
  /** Recall's answer to each share call in the step: its HTTP status (0: no answer) and how long it took. */
  recall: { call: 'share' | 'unshare'; epoch: number | null; status: number; ms: number }[]
  /** The camera page during the step: connections let in again, drops, and refused pages. */
  camera: { attaches: number; drops: number; refused: number } | null
  /** What the test page's link did, in words. */
  link: string[]
  timings: Record<string, number | null>
  answers: Answer[]
  notes: string[]
}

export function newStep(id: StepId): StepRecord {
  return {
    id,
    title: STEP_TITLES[id],
    ran: false,
    result: 'UNKNOWN',
    why: [],
    started_ms: null,
    took_ms: null,
    recall: [],
    camera: null,
    link: [],
    timings: {},
    answers: [],
    notes: [],
  }
}

/** What the test page measured in the bot's browser, over every share. */
export interface PageSummary {
  hello: PageHello | null
  /** Frames per second from requestAnimationFrame: the median and the lowest of the 2-second reports. */
  fps: { median: number; lowest: number; reports: number } | null
  worstTimerLateMs: number | null
  visibility: string[]
  /** The Origin header on the page's first link: scheme and host ('' for none), and whether it is the page's own. */
  origin: { value: string; isPage: boolean } | null
}

export interface ReportInput {
  name: string
  app: string
  node: string
  platform: Platform
  /** The date and time the test started, UTC, to the minute. */
  date: string
  keep: boolean
  steps: StepRecord[]
  page: PageSummary
  /** The smallest ladder size the owner could read ('16 px', 'none'), or null if not asked or skipped. */
  smallestText: string | null
  /** Why the test stopped before the end, if it did. */
  stopped: string | null
  /** What was done at the end: the share stopped, the assistant asked to leave, or kept in. */
  ending: string[]
}

export interface Verdict {
  safe: boolean
  line: string
  reasons: string[]
}

const s1 = (ms: number | null | undefined) => (ms === null || ms === undefined ? '?' : `${(ms / 1000).toFixed(1)} s`)
/** The last answer in a step to the question for this key, or '' when there is none. */
export const answerOf = (step: StepRecord | undefined, key: string) => step?.answers.findLast(a => a.key === key)?.answer ?? ''

/** What the camera page did in a step, in words: 'untouched' when nothing. */
export function cameraWords(camera: StepRecord['camera']): string {
  if (!camera) return 'not known'
  const parts = [
    camera.drops ? `dropped ${camera.drops} time${camera.drops === 1 ? '' : 's'}` : '',
    camera.attaches ? `connected again ${camera.attaches} time${camera.attaches === 1 ? '' : 's'}` : '',
    camera.refused ? `${camera.refused} page${camera.refused === 1 ? '' : 's'} refused (loaded again without its secret)` : '',
  ].filter(Boolean)
  return parts.length ? parts.join(', ') : 'untouched'
}

const cameraMoved = (camera: StepRecord['camera']) => Boolean(camera && (camera.drops || camera.attaches || camera.refused))

/**
 * "Slides look safe" only when the camera page never dropped or came back from S2 to S9 (every one of them run), the
 * owner saw the share (S2), and heard the assistant while sharing (S3) and after it stopped (S8).
 */
export function verdict(input: Pick<ReportInput, 'name' | 'platform' | 'steps' | 'stopped'>): Verdict {
  const platform = PLATFORM_NAMES[input.platform]
  const byId = new Map(input.steps.map(s => [s.id, s]))
  const reasons: string[] = []
  for (const step of input.steps) {
    if (step.id === 'S1') continue
    if (cameraMoved(step.camera)) reasons.push(`the camera page ${cameraWords(step.camera)} in ${step.id} (${step.title})`)
  }
  const notRun = input.steps.filter(s => s.id !== 'S1' && !s.ran).map(s => s.id)
  if (notRun.length) reasons.push(`the test stopped before ${notRun.join(', ')}${input.stopped ? ` (${input.stopped})` : ''}`)
  const seen = answerOf(byId.get('S2'), 'seen')
  if (byId.get('S2')?.ran && seen !== 'y') reasons.push(seen === 'n' ? 'you did not see the share in S2' : 'the share was not confirmed seen in S2')
  for (const id of ['S3', 'S8'] as const) {
    const step = byId.get(id)
    if (!step?.ran) continue
    const heard = answerOf(step, 'heard')
    if (heard !== 'y') reasons.push(heard === 'n' ? `you did not hear ${input.name} in ${id}` : `hearing ${input.name} was not confirmed in ${id}`)
  }
  if (!reasons.length) return { safe: true, line: `Slides look safe on ${platform}.`, reasons }
  return { safe: false, line: `Not safe yet on ${platform}: ${reasons.join('; ')}.`, reasons }
}

function stepLines(step: StepRecord): string[] {
  const head = `${step.id} ${step.title}: ${step.result}${step.ran && step.took_ms !== null ? ` (${s1(step.took_ms)})` : ''}`
  if (!step.ran) return [`${head}. Not run.`]
  const lines = [head]
  if (step.why.length) lines.push(`  Why: ${step.why.join('; ')}.`)
  for (const call of step.recall) {
    const what = call.call === 'share' ? `share ${call.epoch ?? '?'}` : 'stop'
    lines.push(`  Recall, ${what}: ${call.status ? `answered ${call.status}` : 'no answer'} in ${s1(call.ms)}`)
  }
  const timings = Object.entries(step.timings).filter(([, v]) => v !== null && v !== undefined)
  if (timings.length) lines.push(`  Timings: ${timings.map(([k, v]) => `${k.replaceAll('_', ' ')} ${s1(v)}`).join(', ')}`)
  for (const event of step.link) lines.push(`  Link: ${event}`)
  lines.push(`  Camera page: ${cameraWords(step.camera)}`)
  for (const a of step.answers) lines.push(`  Asked: ${a.question} Answer: ${a.answer || '(none)'}`)
  for (const note of step.notes) lines.push(`  Note: ${note}`)
  return lines
}

function pageLines(page: PageSummary): string[] {
  const lines: string[] = []
  const h = page.hello
  lines.push(
    h
      ? `Viewport ${h.width}x${h.height}, devicePixelRatio ${h.dpr}, visibility ${h.visibility}, Chrome ${h.chrome_major ?? 'not named in the user agent'}`
      : 'The page never said hello, so nothing is known of its browser.',
  )
  if (page.fps) lines.push(`Frames per second (requestAnimationFrame): median ${page.fps.median}, lowest ${page.fps.lowest}, over ${page.fps.reports} reports`)
  else lines.push('Frames per second: no reports')
  lines.push(`Worst timer lateness: ${page.worstTimerLateMs === null ? 'no reports' : `${page.worstTimerLateMs} ms`}`)
  if (page.visibility.length) lines.push(`Visibility reported: ${page.visibility.join(', ')}`)
  const o = page.origin
  lines.push(
    !o ? 'Origin on the link: not seen' : !o.value ? 'Origin on the link: none sent' : `Origin on the link: ${o.value}${o.isPage ? ", the page's own" : ", not the page's own"}`,
  )
  return lines
}

/** The report, as plain text. */
export function formatReport(input: ReportInput): string {
  const v = verdict(input)
  const lines = [
    'Screen-share test report',
    `App: ${input.app}, Node ${input.node}`,
    `Platform: ${PLATFORM_NAMES[input.platform]}`,
    `Date: ${input.date}`,
    '',
    `Verdict: ${v.line}`,
  ]
  if (input.stopped) lines.push(`The test stopped early: ${input.stopped}.`)
  lines.push('', 'Camera page (it carries the voice and the hearing), step by step:')
  for (const step of input.steps) lines.push(`  ${step.id} ${step.title}: ${step.ran ? cameraWords(step.camera) : 'not run'}`)
  lines.push('', 'Steps:')
  for (const step of input.steps) lines.push(...stepLines(step))
  lines.push('', 'The test page in the bot\'s browser:', ...pageLines(input.page).map(l => `  ${l}`))
  lines.push('', `Smallest readable text: ${input.smallestText ?? 'not answered'}`)
  if (input.ending.length) lines.push('', `At the end: ${input.ending.join(' ')}`)
  lines.push('', REPORT_END)
  return lines.join('\n')
}

/** Every 2-second report's frame rate and lateness, over every share: a summary for the report. */
export function summarizePage(shares: { hello: PageHello | null; origin: string | null; origin_is_page: boolean | null; metrics: { fps: number; worst_timer_late_ms: number; visibility: string }[] }[]): PageSummary {
  const hello = shares.find(s => s.hello)?.hello ?? null
  const metrics = shares.flatMap(s => s.metrics)
  const fps = metrics.map(m => m.fps).sort((a, b) => a - b)
  const withOrigin = shares.find(s => s.origin !== null)
  return {
    hello,
    fps: fps.length ? { median: fps[Math.floor((fps.length - 1) / 2)], lowest: fps[0], reports: fps.length } : null,
    worstTimerLateMs: metrics.length ? Math.max(...metrics.map(m => m.worst_timer_late_ms)) : null,
    visibility: [...new Set([hello?.visibility, ...metrics.map(m => m.visibility)].filter((v): v is string => Boolean(v)))],
    origin: withOrigin ? { value: withOrigin.origin ?? '', isPage: withOrigin.origin_is_page === true } : null,
  }
}

/** The date and time for the report: UTC, to the minute. */
export function reportDate(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}
