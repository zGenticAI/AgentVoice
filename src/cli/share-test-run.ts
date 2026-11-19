// npm run join -- "<link>" --share-test: the screen-share test, driven from the terminal (docs/share-test.md). It sends
// the assistant into a test meeting with the share test on, then, step by step, has the voice service share a test page
// as the bot's screen, speak, change the page, replace the share and stop it, asking the owner what they saw and heard.
// What it is for: whether the camera page, which carries the assistant's voice and hearing, ever drops or loads again
// meanwhile. It prints a report to paste back to a Claude Code session.
//
// Everything outside (the voice service, the terminal, the clock) comes in through RunDeps, so the tests drive it all
// against fakes. Every wait has a timeout. Ctrl-C, or any failure once the assistant has joined, stops the share if one
// may be on, takes the assistant out (unless --keep), and prints what the test found so far. Nothing printed or written
// holds a key, a token, an address, the meeting link or the bot's id (src/sharetest/scrub.ts).
import { type Platform, meetingPlatform } from '../recall.ts'
import { platformHint, readEnterOrNo, readLadder, readYesNo, type YesNo } from '../sharetest/answers.ts'
import { HELLO_WAIT_MS, LADDER_PX, type ShareTestAction, type ShareTestResult, type ShareTestStatus, type ShareView, type TestLineOutcome } from '../sharetest/protocol.ts'
import { STEP_IDS, type StepId, type StepRecord, formatReport, newStep, reportDate, summarizePage, verdict } from '../sharetest/report.ts'
import { scrubber } from '../sharetest/scrub.ts'

/** How long the test waits for the camera page: Recall's waiting room gives up after 10 minutes, then a minute to load. */
export const JOIN_WAIT_MS = 11 * 60_000
/** How long it then waits for the consent line to have been said in full (about 17 s, longer if the page drops). */
export const CONSENT_WAIT_MS = 90_000
/** How long the share is held in S6. */
export const HOLD_MS = 60_000
/** How long it waits for the test page's link to close once the share is stopped or replaced. */
export const CLOSE_WAIT_MS = 10_000
/** The time between frame changes in S5. */
export const FLIP_GAP_MS = 2_000
/** How long the owner has to answer a question before the test stops (the terminal's ask counts it). */
export const QUESTION_WAIT_MS = 5 * 60_000

/** The voice service's answer: its HTTP status and body. A call that gets none rejects (with words to show). */
export interface ServiceReply {
  status: number
  body: string
}

/** The voice service on the control socket, as the join CLI reaches it. */
export interface ShareTestClient {
  health(): Promise<ServiceReply>
  join(body: string): Promise<ServiceReply>
  status(botId: string): Promise<ServiceReply>
  action(botId: string, action: ShareTestAction, step: string): Promise<ServiceReply>
}

export interface RunTiming {
  joinWaitMs: number
  consentWaitMs: number
  helloWaitMs: number
  holdMs: number
  closeWaitMs: number
  flipGapMs: number
  pollMs: number
}

const TIMING: RunTiming = {
  joinWaitMs: JOIN_WAIT_MS,
  consentWaitMs: CONSENT_WAIT_MS,
  helloWaitMs: HELLO_WAIT_MS,
  holdMs: HOLD_MS,
  closeWaitMs: CLOSE_WAIT_MS,
  flipGapMs: FLIP_GAP_MS,
  pollMs: 500,
}

export interface RunArgs {
  meetingUrl: string
  /** The meeting's own brief, read and checked already. */
  brief?: string
  jsonFile?: string
  keep?: boolean
}

export interface RunDeps {
  client: ShareTestClient
  /**
   * Asks the owner in the terminal: their line. Null when no answer came within QUESTION_WAIT_MS. Rejects when the run
   * is stopped meanwhile (Ctrl-C) or the terminal closes.
   */
  ask(prompt: string, signal: AbortSignal): Promise<string | null>
  /** The report (stdout). */
  out(text: string): void
  /** Progress and questions (stderr). */
  log(text: string): void
  now(): number
  /** Waits ms; rejects once the run is stopped. */
  sleep(ms: number, signal: AbortSignal): Promise<void>
  /** Ctrl-C. */
  signal: AbortSignal
  /** Writes a file only its owner can read. */
  writeJson(file: string, text: string): void
  name: string
  app: string
  node: string
  date: Date
  /** Every key and token known here, the local token included: none is ever printed. */
  secrets: string[]
  publicUrl: string
  timing?: Partial<RunTiming>
}

/** The run was stopped: Ctrl-C, or the terminal closed. */
class Stopped extends Error {}
/** The meeting is over for the bot: it left, was removed, or is leaving. */
class Over extends Error {}
/** The owner gave no answer within QUESTION_WAIT_MS. */
class NoAnswer extends Error {}

const ok = (status: number) => status >= 200 && status < 300
const s1 = (ms: number) => `${(ms / 1000).toFixed(1)} s`
const viewOf = (st: ShareTestStatus | null, epoch: number | null) => (epoch === null ? undefined : st?.shares.find(s => s.epoch === epoch))

const SAID: Record<TestLineOutcome, string> = {
  played: 'played to the end',
  cut_off: 'cut off before the end',
  failed: 'failed (see the service log)',
  no_page: 'not said: the camera page was not connected',
  not_now: 'not said: the assistant was leaving, or its session was over',
  timeout: 'still playing after 10 s',
}

/** The words for how the voice service answered when it was not a plain success. */
function serviceAnswer(reply: ServiceReply): string {
  return `the voice service answered ${reply.status}${reply.body ? `: ${reply.body.slice(0, 300)}` : ''}`
}

function parse<T>(reply: ServiceReply): T {
  try {
    return JSON.parse(reply.body) as T
  } catch {
    throw new Error(`the voice service answered something that is not JSON (${reply.status})`)
  }
}

/** The whole test. Resolves with the exit code: 0 once it ran to the end, whatever it found; 130 for Ctrl-C; else 1. */
export async function runShareTest(args: RunArgs, deps: RunDeps): Promise<number> {
  const t: RunTiming = { ...TIMING, ...deps.timing }
  const { scrub, setBot } = scrubber({ secrets: deps.secrets, meetingUrl: args.meetingUrl, publicUrl: deps.publicUrl })
  const log = (text: string) => deps.log(scrub(text))
  const { name } = deps
  const platform = meetingPlatform(args.meetingUrl)
  if (!platform) {
    log('Pass a Zoom, Google Meet or Microsoft Teams meeting link.')
    return 1
  }

  const stopError = (err: unknown) => (deps.signal.aborted ? new Stopped() : err)
  const check = () => {
    if (deps.signal.aborted) throw new Stopped()
  }
  const sleep = (ms: number) =>
    deps.sleep(Math.max(0, ms), deps.signal).then(check, err => {
      throw stopError(err)
    })
  const ask = async (prompt: string): Promise<string> => {
    check()
    let line: string | null
    try {
      line = await deps.ask(scrub(prompt), deps.signal)
    } catch {
      throw deps.signal.aborted ? new Stopped() : new Stopped('the terminal closed')
    }
    check()
    if (line === null) throw new NoAnswer()
    return line
  }

  // --- 1. Preflight: a service that can run the test, and the owner ready -------------------------------------
  let health: ServiceReply
  try {
    health = await deps.client.health()
  } catch (err) {
    log((err as Error).message)
    return 1
  }
  let features: string[] = []
  try {
    const said = JSON.parse(health.body) as { features?: unknown }
    features = Array.isArray(said?.features) ? said.features.map(String) : []
  } catch {
    // An answer that isn't JSON lists nothing.
  }
  if (args.brief !== undefined && !features.includes('meeting_brief')) {
    log(
      'The voice service is older than this command and cannot keep a brief for one meeting: restart it, then try again ' +
        '(or leave out --brief to use the shared brief).',
    )
    return 1
  }
  if (!features.includes('share_test')) {
    log('The voice service is older than this command and has no screen-share test: restart it, then try again.')
    return 1
  }
  log(intro(name, platform, Boolean(args.keep)))
  try {
    const go = (await ask(`Press Enter to send ${name} in, or Ctrl-C to stop.`)).trim().toLowerCase()
    if (go === 'n' || go === 'no' || go === 'q') {
      log('Stopped: nothing was sent.')
      return 1
    }
  } catch (err) {
    if (err instanceof Stopped) return 130
    log('No answer: nothing was sent.')
    return 1
  }

  // --- 2. Join -----------------------------------------------------------------------------------------------
  let joinReply: ServiceReply
  try {
    joinReply = await deps.client.join(JSON.stringify({ meetingUrl: args.meetingUrl, brief: args.brief, share_test: true }))
  } catch (err) {
    log((err as Error).message)
    return 1
  }
  if (joinReply.status !== 200) {
    log(`Could not start the bot: ${joinReply.body}`)
    return 1
  }
  let joined: { bot_id?: unknown; share_test?: unknown; brief_note?: unknown; tip?: unknown } = {}
  try {
    joined = JSON.parse(joinReply.body) ?? {}
  } catch {
    // Checked below.
  }
  if (typeof joined.bot_id !== 'string' || joined.share_test !== true) {
    log(`The voice service did not turn the screen-share test on for this meeting. Say "${name}, please leave" in the meeting, restart the service, then try again.`)
    return 1
  }
  const botId = joined.bot_id
  setBot(botId)
  log(`${name} is joining (the bot).`)
  if (typeof joined.brief_note === 'string') log(joined.brief_note)
  if (typeof joined.tip === 'string') log(joined.tip)

  // --- From here on, any way out stops the share, takes the assistant out unless --keep, and reports ----------
  const begun = deps.now()
  const steps = STEP_IDS.map(newStep)
  const byId = (id: StepId) => steps.find(s => s.id === id) as StepRecord
  let last = null as ShareTestStatus | null
  let shareMayBeOn = false
  let smallestText = null as string | null
  let stopped: string | null = null
  let exitCode = 0
  // The bot is gone already: nothing to stop, nobody to ask to leave.
  let over = false
  const ending: string[] = []
  const consentNotes: string[] = []

  const status = async (): Promise<ShareTestStatus> => {
    const reply = await deps.client.status(botId)
    if (reply.status === 404) throw new Over(`${name} is no longer in the meeting (it left, or was removed)`)
    if (reply.status !== 200) throw new Error(serviceAnswer(reply))
    last = parse<ShareTestStatus>(reply)
    return last
  }

  const act = async <A extends ShareTestAction>(action: A, step: string): Promise<Extract<ShareTestResult, { action: A }>> => {
    if (action === 'share') shareMayBeOn = true
    const reply = await deps.client.action(botId, action, step)
    if (reply.status === 404 || reply.status === 409) throw new Over(`${name} is no longer in the meeting, or is leaving it`)
    if (reply.status !== 200) throw new Error(serviceAnswer(reply))
    const result = parse<Extract<ShareTestResult, { action: A }>>(reply)
    if (result.action === 'unshare' && ok((result as { status: number }).status)) shareMayBeOn = false
    return result
  }

  /** Asks the status every `every` ms until ok, for ms at most: the status that passed, or null. */
  const waitFor = async (pass: (st: ShareTestStatus) => boolean, ms: number, every = t.pollMs, tick?: (elapsed: number) => void) => {
    const from = deps.now()
    for (;;) {
      const st = await status()
      if (pass(st)) return st
      const elapsed = deps.now() - from
      if (elapsed >= ms) return null
      tick?.(elapsed)
      await sleep(Math.min(every, ms - elapsed))
    }
  }

  const question = async (rec: StepRecord, key: string, text: string, read: (line: string) => string | null = readYesNo, again = 'Type y or n (or s to skip).') => {
    for (;;) {
      const line = await ask(text)
      const answer = read(line)
      if (answer !== null) {
        rec.answers.push({ key, question: text, answer })
        return answer
      }
      if (line.trim()) log(again)
    }
  }

  // The camera page's counts at the end of the step before: each step gets what happened since.
  let cameraMark: ShareTestStatus['camera'] | null = null

  /** A step: what the camera page did since the step before, its time, and what it found. */
  const step = async (id: StepId, run: (rec: StepRecord) => Promise<void>) => {
    check()
    const rec = byId(id)
    cameraMark ??= (await status()).camera
    const before = cameraMark
    rec.ran = true
    const from = deps.now()
    rec.started_ms = from - begun
    log(`\n${id} ${rec.title}`)
    try {
      await run(rec)
    } catch (err) {
      rec.notes.push('stopped partway')
      if (rec.result === 'PASS') rec.result = 'UNKNOWN'
      throw err
    } finally {
      rec.took_ms = deps.now() - from
      const after = await status().catch(() => null)
      if (after) {
        cameraMark = after.camera
        rec.camera = {
          attaches: after.camera.attaches.length - before.attaches.length,
          drops: after.camera.drops.length - before.drops.length,
          refused: after.camera.refused.length - before.refused.length,
        }
        if (rec.camera.attaches || rec.camera.drops || rec.camera.refused) {
          rec.result = 'FAIL'
          rec.why.unshift('the camera page dropped, connected again, or a page was refused')
          log(`The camera page did not stay as it was in ${id}: see the report.`)
        }
      }
      log(`${id} ${rec.title}: ${rec.result}`)
    }
  }

  /** POSTs a share and waits for its page's hello: whether Recall accepted it, its number, and whether the page said hello. */
  const share = async (rec: StepRecord) => {
    const r = await act('share', rec.id)
    rec.recall.push({ call: 'share', epoch: r.epoch, status: r.status, ms: r.ms })
    if (!ok(r.status)) {
      log(`Recall ${r.status ? `refused the share (${r.status})` : 'did not answer'}.`)
      return { accepted: false, epoch: r.epoch, hello: false }
    }
    log(`Recall accepted share ${r.epoch} in ${s1(r.ms)}. Waiting for the test page (up to ${Math.round(t.helloWaitMs / 1000)} s)...`)
    const st = await waitFor(s => viewOf(s, r.epoch)?.hello_at != null, t.helloWaitMs)
    const view = viewOf(st ?? last, r.epoch)
    if (view?.hello_at != null && view.posted_at != null) {
      const after = view.hello_at - view.posted_at
      rec.timings[`share ${r.epoch} hello`] = after
      rec.link.push(`share ${r.epoch}'s page said hello ${s1(after)} after it was asked for`)
      log(`The test page is up, ${s1(after)} after it was asked for.`)
      return { accepted: true, epoch: r.epoch, hello: true }
    }
    rec.link.push(`share ${r.epoch}'s page did not say hello within ${Math.round(t.helloWaitMs / 1000)} s`)
    log(`The test page did not link up within ${Math.round(t.helloWaitMs / 1000)} s.`)
    return { accepted: true, epoch: r.epoch, hello: false }
  }

  /** How a share's link closed, if it did, counted from `from` (epoch ms). */
  const closing = (view: ShareView | undefined, from: number | null, what: string) => {
    if (!view) return
    if (view.link_closed_at !== null && from !== null) {
      const by = view.link_closed_by === 'service' ? 'by the service' : 'by the page'
      return `share ${view.epoch}'s link closed ${s1(view.link_closed_at - from)} after ${what} (${view.link_close_code}, ${by})`
    }
    if (view.link_open) return `share ${view.epoch}'s link was still open ${Math.round(t.closeWaitMs / 1000)} s after ${what}`
    return `share ${view.epoch}'s link was not open`
  }

  /** Stops the share and waits for its link to close: whether Recall stopped it. */
  const unshare = async (rec: StepRecord, epoch: number | null) => {
    const r = await act('unshare', rec.id)
    rec.recall.push({ call: 'unshare', epoch, status: r.status, ms: r.ms })
    if (!ok(r.status)) {
      log(`Recall ${r.status ? `refused to stop the share (${r.status})` : 'did not answer'}.`)
      return false
    }
    log(`Recall stopped the share in ${s1(r.ms)}.`)
    if (epoch !== null) {
      const st = await waitFor(s => !viewOf(s, epoch)?.link_open, t.closeWaitMs)
      const view = viewOf(st ?? last, epoch)
      if (view?.link_closed_at != null && view.stopped_at != null) rec.timings['link closed after the stop'] = view.link_closed_at - view.stopped_at
      const words = closing(view, view?.stopped_at ?? null, 'the stop')
      if (words) rec.link.push(words)
    }
    return true
  }

  const fromAnswer = (rec: StepRecord, answer: string, what: string) => {
    if (answer === 'y') rec.result = 'PASS'
    else if (answer === 'n') {
      rec.result = 'FAIL'
      rec.why.push(what)
    } else rec.result = 'SKIPPED'
  }

  try {
    // Waiting for the camera page: as long as a waiting room can take, then the consent line.
    log(`Waiting for ${name}'s camera page to connect. If the meeting has a waiting room or lobby, let ${name} in.`)
    let told = 0
    const live = await waitFor(s => s.meeting === 'live', t.joinWaitMs, 1000, elapsed => {
      if (elapsed - told < 30_000) return
      told = elapsed
      log(`Still waiting for ${name} (${Math.round(elapsed / 1000)} s so far, up to ${Math.round(t.joinWaitMs / 60_000)} minutes).`)
    })
    if (!live) throw new Error(`${name}'s camera page did not connect within ${Math.round(t.joinWaitMs / 60_000)} minutes`)
    log(`${name} is in. Waiting for its consent line to finish...`)
    const consent = await waitFor(s => s.consent_done === true, t.consentWaitMs, 1000)
    if (!consent) consentNotes.push(`the consent line had not finished within ${Math.round(t.consentWaitMs / 1000)} s, so the test went on`)
    log('Starting the test.')

    await step('S1', async rec => {
      const st = last ?? (await status())
      const connected = st.meeting === 'live'
      rec.notes.push(
        `the camera page ${connected ? 'is connected' : 'is not connected'}: ${st.camera.attaches.length} connection(s), ` +
          `${st.camera.drops.length} drop(s) and ${st.camera.refused.length} refused page(s) since ${name} joined`,
        ...consentNotes,
      )
      rec.result = connected ? 'PASS' : 'FAIL'
      if (!connected) rec.why.push('the camera page is not connected')
    })

    await step('S2', async rec => {
      let seen: string = 's'
      let accepted = false
      for (let tries = 1; ; tries++) {
        const shared = await share(rec)
        accepted = shared.accepted
        if (!accepted) break
        seen = await question(rec, 'seen', "Do you see a page titled 'Screen-share test' in the meeting? (y/n, s to skip)")
        if (seen !== 'n' || tries > 1) break
        log(platformHint(platform, name))
        const again = await question(rec, 'retry', 'Change it, then press Enter to try again, or type s to skip.', line => (line.trim() === '' ? 'again' : readYesNo(line) === 's' ? 's' : null), 'Press Enter, or type s.')
        if (again !== 'again') break
        await unshare(rec, shared.epoch)
      }
      if (!accepted) {
        rec.result = 'FAIL'
        rec.why.push('Recall did not accept the share')
        return
      }
      fromAnswer(rec, seen, 'you did not see the share')
      if (seen !== 'y') return
      const ladder = await question(
        rec,
        'ladder',
        "What is the smallest text size you can read on the ladder (the number beside it), or 'none'?",
        readLadder,
        `Type one of ${LADDER_PX.join(', ')}, or none (s to skip).`,
      )
      smallestText = ladder === 's' ? null : ladder
    })

    await step('S3', async rec => {
      log(`${name} says a test sentence now...`)
      const said = await act('say', 'S3')
      rec.timings['test line'] = said.ms
      rec.notes.push(`the test line: ${SAID[said.said]}`)
      const heard = await question(rec, 'heard', `Did you hear ${name} say the test sentence? (y/n, s to skip)`)
      fromAnswer(rec, heard, `you did not hear ${name}`)
    })

    await step('S4', async rec => {
      log(`Ask ${name} a question now, by name (for example: "${name}, can you hear me?").`)
      const answered = await question(rec, 'answered', "Press Enter once it has answered, or type n if it didn't.", readEnterOrNo, 'Press Enter, or type n (s to skip).')
      fromAnswer(rec, answered, `${name} did not answer`)
    })

    await step('S5', async rec => {
      log('The big number on the page counts up to 5 now, every 2 s.')
      const epoch = (await status()).current
      for (let i = 1; i <= 5; i++) {
        const flipped = await act('flip', 'S5')
        if (!flipped.sent) rec.notes.push(`frame ${flipped.frame} could not be sent: the page's link was not open`)
        if (i < 5) await sleep(t.flipGapMs)
      }
      const st = await waitFor(s => (viewOf(s, epoch)?.frames ?? []).every(f => f.shown_at !== null), 3000)
      const frames = viewOf(st ?? last, epoch)?.frames ?? []
      const shown = frames.filter(f => f.shown_at !== null).map(f => (f.shown_at as number) - f.sent_at)
      rec.link.push(`${shown.length} of 5 frames shown${shown.length ? `, ${s1(shown.reduce((a, b) => a + b, 0) / shown.length)} after each change on average (worst ${s1(Math.max(...shown))})` : ''}`)
      if (shown.length) rec.timings['worst frame shown'] = Math.max(...shown)
      const counted = await question(rec, 'counted', 'Did the big number count up to 5? (y/n, s to skip)')
      fromAnswer(rec, counted, 'the number did not count up to 5')
    })

    await step('S6', async rec => {
      const first = await status()
      const epoch = first.current
      log(`Holding the share for ${Math.round(t.holdMs / 1000)} s.`)
      const from = deps.now()
      let told = 0
      let st = first
      while (deps.now() - from < t.holdMs) {
        await sleep(Math.min(2000, t.holdMs - (deps.now() - from)))
        st = await status()
        const left = t.holdMs - (deps.now() - from)
        if (deps.now() - from - told >= 10_000 && left > 0) {
          told = deps.now() - from
          log(`${Math.ceil(left / 1000)} s left.`)
        }
      }
      const view = viewOf(st, epoch)
      if (!view || view.hello_at === null) {
        rec.result = 'UNKNOWN'
        rec.why.push(view ? 'the test page never linked up' : 'no share was on')
        return
      }
      const metrics = view.metrics.filter(m => m.at >= first.now && m.at <= st.now)
      rec.link.push(`${metrics.length} reports from the page during the hold`)
      if (!view.link_open) {
        rec.result = 'FAIL'
        rec.why.push("the test page's link closed during the hold")
        const words = closing(view, first.now, 'the hold started')
        if (words) rec.link.push(words)
      } else if (!metrics.length) {
        rec.result = 'UNKNOWN'
        rec.why.push('the page sent no reports')
      } else rec.result = 'PASS'
    })

    await step('S7', async rec => {
      const old = (await status()).current
      if (old === null) rec.notes.push('no share was on, so this was a share, not a replace')
      const shared = await share(rec)
      if (!shared.accepted) {
        rec.result = 'FAIL'
        rec.why.push('Recall did not accept the second share')
        return
      }
      if (old !== null) {
        const st = await waitFor(s => !viewOf(s, old)?.link_open, t.closeWaitMs)
        const newer = viewOf(st ?? last, shared.epoch)
        const words = closing(viewOf(st ?? last, old), newer?.posted_at ?? null, `share ${shared.epoch} was asked for`)
        if (words) rec.link.push(words)
      }
      const session = await question(rec, 'session', `Does the page now show session ${shared.epoch}? (y/n, s to skip)`)
      fromAnswer(rec, session, `the page did not show session ${shared.epoch}`)
    })

    await step('S8', async rec => {
      const epoch = (await status()).current
      const stoppedShare = await unshare(rec, epoch)
      const gone = await question(rec, 'gone', 'Has the screen share gone? (y/n, s to skip)')
      log(`${name} says a test sentence now...`)
      const said = await act('say', 'S8')
      rec.timings['test line'] = said.ms
      rec.notes.push(`the test line: ${SAID[said.said]}`)
      const heard = await question(rec, 'heard', `Did you hear ${name} after the share stopped? (y/n, s to skip)`)
      // Hearing after the stop, as in S4: the camera page's hearing can break while its voice still works.
      log(`Ask ${name} a question now, by name (for example: "${name}, can you hear me?").`)
      const answered = await question(rec, 'answered', "Press Enter once it has answered, or type n if it didn't.", readEnterOrNo, 'Press Enter, or type n (s to skip).')
      if (!stoppedShare) {
        rec.result = 'FAIL'
        rec.why.push('Recall did not stop the share')
      } else if (gone === 'n' || heard === 'n' || answered === 'n') {
        rec.result = 'FAIL'
        if (gone === 'n') rec.why.push('the share did not go')
        if (heard === 'n') rec.why.push(`you did not hear ${name}`)
        if (answered === 'n') rec.why.push(`${name} did not answer`)
      } else rec.result = gone === 'y' && heard === 'y' && answered === 'y' ? 'PASS' : 'SKIPPED'
    })

    await step('S9', async rec => {
      const shared = await share(rec)
      if (!shared.accepted) {
        rec.result = 'FAIL'
        rec.why.push('Recall did not accept the share')
        return
      }
      const stoppedShare = await unshare(rec, shared.epoch)
      if (!stoppedShare) {
        rec.result = 'FAIL'
        rec.why.push('Recall did not stop the share')
      } else if (!shared.hello) {
        rec.result = 'UNKNOWN'
        rec.why.push('the test page did not link up')
      } else rec.result = 'PASS'
    })

  } catch (err) {
    over = err instanceof Over
    if (err instanceof Stopped) {
      stopped = err.message || 'you pressed Ctrl-C'
      exitCode = 130
    } else {
      stopped = err instanceof NoAnswer ? `no answer came within ${Math.round(QUESTION_WAIT_MS / 60_000)} minutes` : (err as Error).message || String(err)
      exitCode = 1
    }
    log(`\nThe test stopped: ${stopped}.`)
  }
  // However it ended (but for a bot already gone): the share stopped if one may still be on, and the assistant out.
  await cleanUp()

  /** Stops the share if one may be on, and takes the assistant out unless --keep. Never throws. */
  async function cleanUp(): Promise<void> {
    if (over) return
    if (shareMayBeOn) {
      try {
        const r = await act('unshare', '')
        ending.push(ok(r.status) ? 'The share was stopped.' : `Stopping the share failed (${r.status || 'no answer'}): it goes when the bot leaves.`)
      } catch (err) {
        if (err instanceof Over) return void ending.push(`${name} had already left the meeting.`)
        ending.push(`Stopping the share failed (${(err as Error).message}): it goes when the bot leaves.`)
      }
    }
    if (args.keep) return void ending.push(`${name} stays in the meeting (--keep): say "${name}, please leave", or remove it, when you are done.`)
    try {
      await act('leave', '')
      ending.push(`${name} was asked to leave, as on "please leave": its transcript is deleted, and there are no minutes.`)
    } catch (err) {
      ending.push(
        err instanceof Over
          ? `${name} had already left the meeting.`
          : `Asking ${name} to leave failed (${(err as Error).message}): say "${name}, please leave", or remove it.`,
      )
    }
  }

  const page = summarizePage(last?.shares ?? [])
  const input = {
    name,
    app: deps.app,
    node: deps.node,
    platform,
    date: reportDate(deps.date),
    keep: Boolean(args.keep),
    steps,
    page,
    smallestText,
    stopped,
    ending,
  }
  deps.out(scrub(formatReport(input)))
  if (args.jsonFile) {
    const data = {
      test: 'share-test',
      version: 1,
      app: deps.app,
      node: deps.node,
      platform,
      date: input.date,
      keep: input.keep,
      stopped,
      verdict: verdict(input),
      steps,
      page,
      smallest_text: smallestText,
      ending,
      status: last,
    }
    try {
      deps.writeJson(args.jsonFile, scrub(`${JSON.stringify(data, null, 2)}\n`))
      log(`Wrote the raw step records to ${args.jsonFile} (readable only by you).`)
    } catch (err) {
      log(`Could not write ${args.jsonFile}: ${(err as NodeJS.ErrnoException).code ?? 'error'}`)
      if (!exitCode) exitCode = 1
    }
  }
  return exitCode
}

/** What the owner is told before anything is sent. */
export function intro(name: string, platform: Platform, keep: boolean): string {
  return [
    `The screen-share test checks the one thing the slides feature depends on: whether ${name}'s camera page, which carries its voice and its hearing, keeps running while ${name} shares a screen, changes it, replaces the share and stops it.`,
    '',
    `What happens: ${name} joins the meeting as usual, consent line included. Then, step by step, it shares a test page as its screen, speaks, listens, changes a number on the page, keeps the share up for a minute, replaces it, stops it, and starts and stops it once more. Some steps ask you a question here: answer y or n (s skips it). It takes about 10 minutes.`,
    '',
    `Use a test meeting that you host, with only you in it, and if you can, a second device or a phone joined too, to look at the share. Nothing is recorded: Recall keeps no recording, and ${keep ? `with --keep, ${name} stays in the meeting at the end, as in any meeting.` : `at the end ${name} leaves as on "please leave", which deletes its transcript and writes no minutes.`}`,
    '',
    `First check that the meeting lets ${name} share its screen. ${platformHint(platform, name)}`,
    '',
    `Ctrl-C at any time stops the share and ${keep ? `leaves ${name} in the meeting` : `takes ${name} out of the meeting`}, and prints what the test found so far.`,
    '',
  ].join('\n')
}
