// npm run join --share-test from the owner's side: the arguments, the driver against a fake voice service with scripted
// answers and a fake clock (the happy path, a share not seen and tried again, the camera page coming back mid-step,
// timeouts, Ctrl-C, a meeting that ends), the report and its verdict, and that nothing printed or written holds a token,
// an address, the meeting link, the bot's id or a key.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { joinArgs } from '../src/cli/join-args.ts'
import { type RunDeps, type ServiceReply, type ShareTestClient, runShareTest } from '../src/cli/share-test-run.ts'
import { writePrivate } from '../src/probe/flux-probe.ts'
import { platformHint, readEnterOrNo, readLadder, readYesNo } from '../src/sharetest/answers.ts'
import type { ShareTestAction, ShareTestStatus, ShareView, TestLineOutcome } from '../src/sharetest/protocol.ts'
import { REPORT_END, STEP_IDS, newStep, verdict } from '../src/sharetest/report.ts'
import { scrubber } from '../src/sharetest/scrub.ts'

const ZOOM = 'https://us06web.zoom.us/j/123456789?pwd=Secr3tPass'
const MEET = 'https://meet.google.com/abc-defg-hij'
const BOT = '6f1e2d3c-4b5a-4978-8a6b-5c4d3e2f1a0b'
const PUBLIC = 'https://assistant.example.com'
const LOCAL_TOKEN = 'a1b2c3d4'.repeat(8)
const RECALL_KEY = 'recall-key-0123456789'
const START = 1_795_000_000_000

interface Script {
  features?: string[]
  joinReply?: ServiceReply
  /** When the camera page connects, after the join (ms); null: never. */
  attachAfter?: number | null
  consentAfter?: number
  /** How long after its POST each share's page says hello; null: never. */
  helloAfter?: (epoch: number) => number | null
  shareStatus?: (epoch: number) => number
  stopStatus?: () => number
  /** How long after a stop, or after the share that replaced it was asked for, a page's link closes; null: never. */
  closeAfter?: number | null
  said?: TestLineOutcome
  /** The Origin the bot's browser sends on the link (the page's own unless given). */
  origin?: string
  /** Called before each action is answered, to make things happen meanwhile. */
  onAction?: (svc: FakeService, action: ShareTestAction, step: string) => void
}

/** The voice service as the driver meets it: a meeting with the test, its shares, its camera page, on a fake clock. */
class FakeService implements ShareTestClient {
  now = START
  readonly actions: string[] = []
  readonly joins: string[] = []
  joinedAt = 0
  left = false
  gone = false
  epoch = 0
  current: number | null = null
  frame = 0
  readonly views = new Map<number, ShareView & { replacedAt?: number }>()
  readonly camera = { attaches: [] as number[], drops: [] as number[], refused: [] as number[] }
  constructor(readonly script: Script = {}) {}

  async health(): Promise<ServiceReply> {
    return { status: 200, body: JSON.stringify({ ok: true, features: this.script.features ?? ['meeting_brief', 'why_not_answered', 'share_test'] }) }
  }

  async join(body: string): Promise<ServiceReply> {
    this.joins.push(body)
    this.joinedAt = this.now
    // The service's own words can hold the link, an address with a token, and the bot's id: the driver scrubs them.
    return (
      this.script.joinReply ?? {
        status: 200,
        body: JSON.stringify({
          bot_id: BOT,
          platform: 'zoom',
          brief: 'none',
          brief_note: `Bot ${BOT} answers from no brief; see ${PUBLIC}/share-test?t=TOKEN123456 and ${ZOOM}.`,
          speaker_probe: false,
          tip: 'Alex joins as a guest.',
          share_test: true,
        }),
      }
    )
  }

  private helloAt(v: ShareView): number | null {
    if (v.post_status !== 200 || v.posted_at === null) return null
    const after = (this.script.helloAfter ?? (() => 3000))(v.epoch)
    return after === null ? null : v.posted_at + after
  }

  private closedAt(v: ShareView & { replacedAt?: number }): number | null {
    const closeAfter = this.script.closeAfter === undefined ? 800 : this.script.closeAfter
    if (closeAfter === null) return null
    const from = v.stopped_at ?? v.replacedAt
    return from === undefined || from === null ? null : from + closeAfter
  }

  view(v: ShareView & { replacedAt?: number }): ShareView {
    const hello = this.helloAt(v)
    const said = hello !== null && hello <= this.now
    const closed = this.closedAt(v)
    const isClosed = closed !== null && closed <= this.now
    const metrics = []
    if (said) for (let at = hello + 2000; at <= this.now && (!isClosed || at < closed!); at += 2000) metrics.push({ at, fps: 15, worst_timer_late_ms: 40, visibility: 'visible' })
    const { replacedAt: _, ...rest } = v
    return {
      ...rest,
      hello_at: said ? hello : null,
      hello: said ? { width: 1280, height: 720, dpr: 1, visibility: 'visible', chrome_major: 126 } : null,
      links: said ? 1 : 0,
      link_open: said && !isClosed,
      link_closed_at: said && isClosed ? closed : null,
      link_close_code: said && isClosed ? 1001 : null,
      link_closed_by: said && isClosed ? 'page' : null,
      origin: said ? (this.script.origin ?? PUBLIC) : null,
      origin_is_page: said ? (this.script.origin ?? PUBLIC) === PUBLIC : null,
      metrics,
      frames: v.frames.map(f => ({ ...f, shown_at: f.sent_at + 120 <= this.now ? f.sent_at + 120 : null })),
    }
  }

  snapshot(): ShareTestStatus {
    const attachAfter = this.script.attachAfter === undefined ? 5000 : this.script.attachAfter
    const attached = attachAfter !== null && this.now >= this.joinedAt + attachAfter
    const current = this.current === null ? undefined : this.view(this.views.get(this.current)!)
    return {
      meeting: attached ? 'live' : 'waiting',
      consent_done: attached ? this.now >= this.joinedAt + (attachAfter ?? 0) + (this.script.consentAfter ?? 17_000) : null,
      state: current ? (current.hello_at === null ? 'starting' : 'live') : 'off',
      epoch: this.epoch,
      current: this.current,
      // Only what has happened by now: a drop the service notices late shows up late.
      camera: {
        attaches: attached ? [this.joinedAt + attachAfter!, ...this.camera.attaches.filter(at => at <= this.now)] : [],
        drops: this.camera.drops.filter(at => at <= this.now),
        refused: this.camera.refused.filter(at => at <= this.now),
      },
      shares: [...this.views.values()].map(v => this.view(v)),
      now: this.now,
    }
  }

  async status(botId: string): Promise<ServiceReply> {
    assert.equal(botId, BOT)
    if (this.gone || this.left) return { status: 404, body: 'No meeting with the screen-share test for that bot.' }
    return { status: 200, body: JSON.stringify(this.snapshot()) }
  }

  async action(botId: string, action: ShareTestAction, step: string): Promise<ServiceReply> {
    assert.equal(botId, BOT)
    this.actions.push(step ? `${action}:${step}` : action)
    this.script.onAction?.(this, action, step)
    if (this.gone || this.left) return { status: 404, body: 'No meeting with the screen-share test for that bot.' }
    const reply = (result: object) => ({ status: 200, body: JSON.stringify(result) })
    if (action === 'share') {
      const epoch = ++this.epoch
      const status = (this.script.shareStatus ?? (() => 200))(epoch)
      const replacing = this.current !== null
      this.views.set(epoch, {
        epoch, posted_at: this.now, post_status: status, post_ms: 400, hello_at: null, hello: null, links: 0, link_open: false,
        link_closed_at: null, link_close_code: null, link_closed_by: null, origin: null, origin_is_page: null, metrics: [], frames: [],
        stop_status: null, stop_ms: null, stopped_at: null,
      })
      if (status === 200) {
        if (this.current !== null) this.views.get(this.current)!.replacedAt = this.now
        this.current = epoch
      }
      this.now += 400
      return reply({ action, epoch, status, ms: 400, replacing })
    }
    if (action === 'unshare') {
      const status = (this.script.stopStatus ?? (() => 204))()
      if (this.current !== null) Object.assign(this.views.get(this.current)!, { stop_status: status, stop_ms: 200, stopped_at: this.now })
      if (status === 204) this.current = null
      this.now += 200
      return reply({ action, status, ms: 200 })
    }
    if (action === 'say') {
      this.now += 3500
      return reply({ action, said: this.script.said ?? 'played', ms: 3500 })
    }
    if (action === 'flip') {
      const frame = ++this.frame
      const v = this.current === null ? undefined : this.views.get(this.current)
      const sent = Boolean(v && this.view(v).link_open)
      if (v && sent) v.frames.push({ frame, sent_at: this.now, shown_at: null })
      return reply({ action, frame, sent })
    }
    this.left = true
    return reply({ action, leaving: true })
  }
}

/** Answers by what the question asks: the first rule whose text the prompt contains, used in turn. */
type Rules = [string, string | null | ((ctl: AbortController) => string | null)][]

function harness(script: Script = {}, rules: Rules = [], args: { keep?: boolean; jsonFile?: string; brief?: string; meetingUrl?: string } = {}) {
  const svc = new FakeService(script)
  const ctl = new AbortController()
  const out: string[] = []
  const log: string[] = []
  const prompts: string[] = []
  const written: { file: string; text: string }[] = []
  const used = new Set<number>()
  const deps: RunDeps = {
    client: svc,
    ask: async (prompt, signal) => {
      prompts.push(prompt)
      log.push(prompt)
      if (signal.aborted) throw new Error('stopped')
      const i = rules.findIndex(([match], n) => prompt.includes(match) && !used.has(n))
      let answer: string | null = 'y'
      if (prompt.includes('Press Enter to send')) answer = ''
      else if (prompt.includes('smallest text size')) answer = '16'
      else if (prompt.includes('Press Enter once it has answered')) answer = ''
      if (i >= 0) {
        used.add(i)
        const rule = rules[i][1]
        answer = typeof rule === 'function' ? rule(ctl) : rule
      }
      if (signal.aborted) throw new Error('stopped')
      return answer
    },
    out: text => void out.push(text),
    log: text => void log.push(text),
    now: () => svc.now,
    sleep: async (ms, signal) => {
      if (signal.aborted) throw new Error('stopped')
      svc.now += ms
    },
    signal: ctl.signal,
    writeJson: (file, text) => void written.push({ file, text }),
    name: 'Alex',
    app: 'agent-voice 0.1.0',
    node: 'v24.0.0',
    date: new Date('2026-11-19T14:05:33Z'),
    secrets: [LOCAL_TOKEN, RECALL_KEY],
    publicUrl: PUBLIC,
  }
  const run = () => runShareTest({ meetingUrl: args.meetingUrl ?? ZOOM, brief: args.brief, jsonFile: args.jsonFile, keep: args.keep }, deps)
  return { svc, ctl, out, log, prompts, written, deps, run }
}

/** Nothing that must stay private: no token, key, address, meeting link (nor its id or passcode) or bot id. */
function assertClean(text: string) {
  for (const never of [LOCAL_TOKEN, RECALL_KEY, BOT, ZOOM, '123456789', 'Secr3tPass', 'assistant.example.com', 'TOKEN123456', 't=', 'https://us06web', 'http://', 'wss://']) {
    assert.ok(!text.includes(never), `${never} in:\n${text}`)
  }
}

const reportOf = (h: ReturnType<typeof harness>) => {
  assert.equal(h.out.length, 1, 'one report, on stdout')
  return h.out[0]
}

// --- The arguments -------------------------------------------------------------------------------------------------

test('npm run join takes --share-test with --json and --keep, and refuses them in the wrong company', () => {
  const link = ZOOM
  assert.deepEqual(joinArgs([link, '--share-test']), { meetingUrl: link, shareTest: true })
  assert.deepEqual(joinArgs(['--share-test', link, '--json', 'out/st.json', '--keep', '--brief', 'b.md']), {
    meetingUrl: link,
    shareTest: true,
    jsonFile: 'out/st.json',
    keep: true,
    briefFile: 'b.md',
  })
  assert.deepEqual(joinArgs([link, '--share-test', '--json=st.json']), { meetingUrl: link, shareTest: true, jsonFile: 'st.json' })
  assert.deepEqual(joinArgs([link, '--json', 'st.json']), { problem: '--json goes with --share-test.' })
  assert.deepEqual(joinArgs([link, '--keep']), { problem: '--keep goes with --share-test.' })
  assert.deepEqual(joinArgs([link, '--share-test', '--speaker-probe']), { problem: 'Use --share-test or --speaker-probe, not both.' })
  assert.deepEqual(joinArgs([link, '--share-test', '--share-test']), { problem: 'Give --share-test once.' })
  assert.deepEqual(joinArgs([link, '--share-test=yes']), { problem: '--share-test takes no value.' })
  assert.deepEqual(joinArgs([link, '--keep=1', '--share-test']), { problem: '--keep takes no value.' })
  assert.deepEqual(joinArgs([link, '--share-test', '--json']), { problem: '--json needs a file after it.' })
  assert.deepEqual(joinArgs([link, '--share-test', '--json', '--keep']), { problem: '--json needs a file after it.' })
  assert.deepEqual(joinArgs(['--share-test']), { problem: 'Give the meeting link.' })
  // Without the new options, what it always was.
  assert.deepEqual(joinArgs([link, '--brief', 'b.md', '--speaker-probe']), { meetingUrl: link, briefFile: 'b.md', speakerProbe: true })
})

// --- The driver --------------------------------------------------------------------------------------------------------

test('the full run: every step passes, the verdict says safe, and the report goes to stdout with the progress on stderr', async () => {
  const h = harness()
  assert.equal(await h.run(), 0)
  assert.deepEqual(JSON.parse(h.svc.joins[0]), { meetingUrl: ZOOM, share_test: true })
  assert.deepEqual(h.svc.actions, [
    'share:S2', 'say:S3', 'flip:S5', 'flip:S5', 'flip:S5', 'flip:S5', 'flip:S5', 'share:S7', 'unshare:S8', 'say:S8', 'share:S9', 'unshare:S9', 'leave',
  ])
  const report = reportOf(h)
  assert.match(report, /^Screen-share test report\nApp: agent-voice 0\.1\.0, Node v24\.0\.0\nPlatform: Zoom\nDate: 2026-11-19 14:05 UTC\n\nVerdict: Slides look safe on Zoom\.\n/)
  for (const id of STEP_IDS) assert.match(report, new RegExp(`^${id} [a-z ]+: PASS`, 'm'), id)
  assert.match(report, /^ {2}S2 share: untouched$/m)
  assert.match(report, /Recall, share 1: answered 200 in 0\.4 s/)
  assert.match(report, /share 1's page said hello 3\.0 s after it was asked for/)
  assert.match(report, /5 of 5 frames shown, 0\.1 s after each change on average/)
  assert.match(report, /share 1's link closed 0\.8 s after share 2 was asked for \(1001, by the page\)/)
  assert.match(report, /Recall, stop: answered 204 in 0\.2 s/)
  assert.match(report, /Viewport 1280x720, devicePixelRatio 1, visibility visible, Chrome 126/)
  assert.match(report, /Frames per second \(requestAnimationFrame\): median 15, lowest 15/)
  assert.match(report, /Worst timer lateness: 40 ms/)
  assert.match(report, /Origin on the link: scheme https, host \[public-host\], the page's own/)
  assert.match(report, /Smallest readable text: 16 px/)
  assert.match(report, /At the end: Alex was asked to leave, as on "please leave"/)
  assert.ok(report.endsWith(REPORT_END))
  // The questions, in order.
  assert.deepEqual(
    h.prompts.map(p => p.split('?')[0].split('.')[0]),
    [
      'Press Enter to send Alex in, or Ctrl-C to stop',
      "Do you see a page titled 'Screen-share test' in the meeting",
      'What is the smallest text size you can read on the ladder (the number beside it), or \'none\'',
      'Did you hear Alex say the test sentence',
      'Press Enter once it has answered, or type n if it didn\'t',
      'Did the big number count up to 5',
      'Does the page now show session 2',
      'Has the screen share gone',
      'Did you hear Alex after the share stopped',
      'Press Enter once it has answered, or type n if it didn\'t',
    ],
  )
  const progress = h.log.join('\n')
  assert.match(progress, /First check that the meeting lets Alex share its screen\. In Zoom, "Who can share\?" must be "All participants"/)
  assert.match(progress, /Ask Alex a question now, by name \(for example: "Alex, can you hear me\?"\)\./)
  assert.match(progress, /Holding the share for 60 s\./)
  assert.ok(!progress.includes('Verdict:'), 'the report is not on stderr')
  assertClean(report)
  assertClean(progress)
})

test('a share that is not seen: the setting hint, one try again after stopping it, then the answers decide', async () => {
  const h = harness({}, [["Do you see a page titled 'Screen-share test'", 'n'], ['Change it, then press Enter', '']], { meetingUrl: MEET })
  assert.equal(await h.run(), 0)
  assert.deepEqual(h.svc.actions.slice(0, 4), ['share:S2', 'unshare:S2', 'share:S2', 'say:S3'])
  const progress = h.log.join('\n')
  assert.match(progress, /In Google Meet, open Host controls and turn on "Share their screen", or turn Host management off\./)
  const report = reportOf(h)
  assert.match(report, /^S2 share: PASS/m, 'seen on the second try')
  assert.match(report, /Verdict: Slides look safe on Google Meet\./)
  assert.match(report, /Does the page now show session 3\?/)
  assertClean(report)

  // Not seen twice: S2 fails, the steps go on, and the verdict says why.
  const twice = harness({}, [["Do you see a page titled 'Screen-share test'", 'n'], ['Change it, then press Enter', ''], ["Do you see a page titled 'Screen-share test'", 'n']])
  assert.equal(await twice.run(), 0)
  const again = reportOf(twice)
  assert.match(again, /^S2 share: FAIL/m)
  assert.match(again, /Why: you did not see the share\./)
  assert.match(again, /Verdict: Not safe yet on Zoom: you did not see the share in S2\./)
  assert.match(again, /Smallest readable text: not answered/)
  // Skipped instead of tried again.
  const skipped = harness({}, [["Do you see a page titled 'Screen-share test'", 'n'], ['Change it, then press Enter', 's']])
  await skipped.run()
  assert.deepEqual(skipped.svc.actions.slice(0, 2), ['share:S2', 'say:S3'])
})

test('the camera page connecting again during S2 fails it, and the verdict is "Not safe yet", however the answers went', async () => {
  const h = harness({
    onAction: (svc, action, step) => {
      if (action === 'share' && step === 'S2') {
        svc.camera.drops.push(svc.now + 100)
        svc.camera.attaches.push(svc.now + 900)
      }
    },
  })
  assert.equal(await h.run(), 0)
  const report = reportOf(h)
  assert.match(report, /^S2 share: FAIL/m)
  assert.match(report, /Why: the camera page dropped, connected again, or a page was refused\./)
  assert.match(report, /^ {2}S2 share: dropped 1 time, connected again 1 time$/m)
  assert.match(report, /^ {2}S3 voice while sharing: untouched$/m)
  assert.match(report, /Verdict: Not safe yet on Zoom: the camera page dropped 1 time, connected again 1 time in S2 \(share\)\./)
  // A page refused (one loaded again, without its secret) counts too.
  const refused = harness({ onAction: (svc, action, step) => void (action === 'unshare' && step === 'S8' && svc.camera.refused.push(svc.now)) })
  await refused.run()
  assert.match(reportOf(refused), /Verdict: Not safe yet on Zoom: the camera page 1 page refused \(loaded again without its secret\) in S8 \(stop\)\./)
})

test('waits that run out: no hello, no consent line, and a camera page that never connects', async () => {
  // The test page never links up: the owner's answers still count, and S9 can't tell.
  const quiet = harness({ helloAfter: () => null })
  assert.equal(await quiet.run(), 0)
  const report = reportOf(quiet)
  assert.match(report, /share 1's page did not say hello within 20 s/)
  assert.match(report, /^S6 hold: UNKNOWN/m, 'no link to hold')
  assert.match(report, /Why: the test page never linked up\./)
  assert.match(report, /^S9 restart: UNKNOWN/m)
  assert.match(report, /The page never said hello, so nothing is known of its browser\./)
  assert.match(report, /0 of 5 frames shown/)
  // The consent line never finishes: the test goes on after 90 s, and says so.
  const talky = harness({ consentAfter: 10 * 60_000 })
  assert.equal(await talky.run(), 0)
  assert.match(reportOf(talky), /Note: the consent line had not finished within 90 s, so the test went on/)
  // The camera page never connects: after about 11 minutes the test stops, takes the bot out, and reports.
  const lobby = harness({ attachAfter: null })
  const from = lobby.svc.now
  assert.equal(await lobby.run(), 1)
  assert.ok(lobby.svc.now - from >= 11 * 60_000)
  assert.deepEqual(lobby.svc.actions, ['leave'], 'no share was ever asked for, so none is stopped')
  const stopped = reportOf(lobby)
  assert.match(stopped, /The test stopped early: Alex's camera page did not connect within 11 minutes\./)
  assert.match(stopped, /^S1 baseline: UNKNOWN\. Not run\./m)
  assert.match(lobby.log.join('\n'), /Still waiting for Alex \(30 s so far, up to 11 minutes\)\./)
  // No answer to a question for 5 minutes: the share is stopped and the bot asked to leave.
  const away = harness({}, [['Did you hear Alex say the test sentence', null]])
  assert.equal(await away.run(), 1)
  assert.deepEqual(away.svc.actions.slice(-2), ['unshare', 'leave'])
  assert.match(reportOf(away), /The test stopped early: no answer came within 5 minutes\./)
})

test('Ctrl-C stops the share, takes the assistant out unless --keep, prints the partial report, and exits 130', async () => {
  const stopAt: Rules = [['Did the big number count up to 5', ctl => (ctl.abort(), 'y')]]
  const h = harness({}, stopAt)
  assert.equal(await h.run(), 130)
  assert.deepEqual(h.svc.actions.slice(-2), ['unshare', 'leave'])
  const report = reportOf(h)
  assert.match(report, /The test stopped early: you pressed Ctrl-C\./)
  assert.match(report, /^S5 slide changes: UNKNOWN/m)
  for (const id of ['S6', 'S7', 'S8', 'S9']) assert.match(report, new RegExp(`^${id} [a-z ]+: UNKNOWN\\. Not run\\.`, 'm'))
  assert.match(report, /Verdict: Not safe yet on Zoom: the test stopped before S6, S7, S8, S9 \(you pressed Ctrl-C\)\./)
  assert.match(report, /At the end: The share was stopped\. Alex was asked to leave/)
  assertClean(report)
  // With --keep, the share still stops, and the assistant stays.
  const kept = harness({}, stopAt, { keep: true })
  assert.equal(await kept.run(), 130)
  assert.deepEqual(kept.svc.actions.slice(-1), ['unshare'])
  assert.match(reportOf(kept), /Alex stays in the meeting \(--keep\)/)
  // During a wait, not a question: between the frame changes.
  const holding = harness()
  holding.svc.script.onAction = (svc, action, step) => void (action === 'flip' && step === 'S5' && svc.frame === 3 && holding.ctl.abort())
  assert.equal(await holding.run(), 130)
  assert.deepEqual(holding.svc.actions.slice(-2), ['unshare', 'leave'])
  // Before anything is sent: nothing to clean up, and no report.
  const early = harness({}, [['Press Enter to send', ctl => (ctl.abort(), '')]])
  assert.equal(await early.run(), 130)
  assert.equal(early.svc.joins.length, 0)
  assert.equal(early.out.length, 0)
  // A run that ends normally with --keep leaves the assistant in.
  const done = harness({}, [], { keep: true })
  assert.equal(await done.run(), 0)
  assert.equal(done.svc.actions.includes('leave'), false)
  assert.match(reportOf(done), /At the end: Alex stays in the meeting \(--keep\): say "Alex, please leave", or remove it, when you are done\./)
})

test('stopped partway through S9, or a stop Recall refused, or the assistant not answering: never "Slides look safe"', async () => {
  // Ctrl-C while S9's share waits for its page: every step started, but S9's end was never seen.
  const late = harness({ onAction: (svc, action, step) => void (action === 'share' && step === 'S9' && late.ctl.abort()) })
  assert.equal(await late.run(), 130)
  assert.match(reportOf(late), /^Verdict: Not safe yet on Zoom: the test stopped partway through S9 \(you pressed Ctrl-C\)\.$/m)
  // Every stop refused, and the share did not go: no stop was tested.
  const refused = harness({ stopStatus: () => 400 }, [['Has the screen share gone', 'n']])
  assert.equal(await refused.run(), 0)
  assert.match(reportOf(refused), /^Verdict: Not safe yet on Zoom: Recall answered 400 to the stop in S9 \(restart\); Recall did not stop the share in S8, so a stop was not tested; you said the share did not go in S8\.$/m)
  // The assistant does not answer while sharing, or after the stop.
  const deaf = harness({}, [['Press Enter once it has answered', 'n']])
  await deaf.run()
  assert.match(reportOf(deaf), /^Verdict: Not safe yet on Zoom: Alex did not answer you in S4\.$/m)
  const deafAfter = harness({}, [['Press Enter once it has answered', ''], ['Press Enter once it has answered', 'n']])
  await deafAfter.run()
  const report = reportOf(deafAfter)
  assert.match(report, /^S8 stop: FAIL/m)
  assert.match(report, /Why: Alex did not answer\./)
  assert.match(report, /^Verdict: Not safe yet on Zoom: Alex did not answer you in S8\.$/m)
})

test("S9 watches the camera page after its stop: a page that went quiet is counted as dropped seconds later, and in S9", async () => {
  // The service notices a page that went quiet only after 4 s without a word, checked each second.
  const h = harness({ onAction: (svc, action, step) => void (action === 'unshare' && step === 'S9' && svc.camera.drops.push(svc.now + 4500)) })
  assert.equal(await h.run(), 0)
  const report = reportOf(h)
  assert.match(report, /^ {2}S9 restart: dropped 1 time$/m)
  assert.match(report, /^Verdict: Not safe yet on Zoom: the camera page dropped 1 time in S9 \(restart\)\.$/m)
  assert.match(h.log.join('\n'), /Watching Alex's camera page for 6 s more\.\.\./)
})

test("S7 says how long the old link was really open, counted from when the new share was asked for, the hello wait included", async () => {
  const h = harness({ helloAfter: epoch => (epoch === 2 ? null : 3000), closeAfter: null })
  await h.run()
  assert.match(reportOf(h), /share 1's link was still open 30\.\d s after share 2 was asked for/)
  const quick = harness({ closeAfter: null })
  await quick.run()
  assert.match(reportOf(quick), /share 1's link was still open 13\.\d s after share 2 was asked for/)
})

test('a meeting that ends under the test stops it, with nothing to clean up', async () => {
  const h = harness({ onAction: (svc, action, step) => void (action === 'say' && step === 'S3' && (svc.gone = true)) })
  assert.equal(await h.run(), 1)
  assert.equal(h.svc.actions.at(-1), 'say:S3', 'no stop, no leave: the bot is gone')
  assert.match(reportOf(h), /The test stopped early: Alex is no longer in the meeting, or is leaving it\./)
})

test('a service without the test, or without briefs for one meeting, is refused before anything is sent', async () => {
  const old = harness({ features: ['meeting_brief', 'why_not_answered'] })
  assert.equal(await old.run(), 1)
  assert.match(old.log.join('\n'), /The voice service is older than this command and has no screen-share test: restart it, then try again\./)
  assert.equal(old.svc.joins.length, 0)
  const older = harness({ features: ['share_test'] }, [], { brief: '# Brief' })
  assert.equal(await older.run(), 1)
  assert.match(older.log.join('\n'), /cannot keep a brief for one meeting: restart it/)
  const refused = harness({ joinReply: { status: 400, body: `Already in 3 meetings. ${ZOOM}` } })
  assert.equal(await refused.run(), 1)
  assert.match(refused.log.join('\n'), /Could not start the bot: Already in 3 meetings\. \[meeting link\]/)
  assert.equal(refused.out.length, 0)
  const notLink = harness({}, [], { meetingUrl: 'https://example.com/j/1' })
  assert.equal(await notLink.run(), 1)
  const down = harness()
  down.deps.client.health = async () => {
    throw new Error('The voice service is not running (nothing is listening on /tmp/x/control.sock).')
  }
  assert.equal(await down.run(), 1)
  assert.match(down.log.join('\n'), /The voice service is not running/)
})

test('Recall refusing a share or a stop fails the step, and the cleanup still stops what may be on', async () => {
  const h = harness({ shareStatus: epoch => (epoch === 1 ? 403 : 200), stopStatus: () => 500 })
  assert.equal(await h.run(), 0)
  const report = reportOf(h)
  assert.match(report, /^S2 share: FAIL/m)
  assert.match(report, /Why: Recall did not accept the share\./)
  assert.match(report, /Recall, share 1: answered 403/)
  assert.match(report, /^S8 stop: FAIL/m)
  assert.match(report, /Why: Recall did not stop the share\./)
})

test('--json writes the raw step records, scrubbed, readable only by the owner', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-stj-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'made', 'share-test.json')
  const h = harness({}, [], { jsonFile: file })
  h.deps.writeJson = writePrivate
  assert.equal(await h.run(), 0)
  const text = fs.readFileSync(file, 'utf8')
  assertClean(text)
  const data = JSON.parse(text)
  assert.equal(data.test, 'share-test')
  assert.equal(data.platform, 'zoom')
  assert.equal(data.verdict.safe, true)
  assert.deepEqual(data.steps.map((s: { id: string; result: string }) => `${s.id} ${s.result}`), STEP_IDS.map(id => `${id} PASS`))
  assert.equal(data.steps[1].recall[0].status, 200)
  assert.equal(data.status.shares.length, 3)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700)
  assert.match(h.log.join('\n'), /Wrote the raw step records to .*share-test\.json \(readable only by you\)/)
})

test("the Origin another site's browser sent is kept as its scheme and host, in the report and the JSON, for DESIGN.md's G15", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-sto-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const cases: [string, string][] = [
    ['https://bot-browser.example.net', "Origin on the link: scheme https, host bot-browser.example.net, not the page's own"],
    ['http://assistant.example.com', "Origin on the link: scheme http, host [public-host], not the page's own"],
    ['https://assistant.example.com:8443', "Origin on the link: scheme https, host [public-host]:8443, not the page's own"],
    ['null', "Origin on the link: null, not the page's own"],
  ]
  for (const [origin, line] of cases) {
    const file = path.join(dir, `${cases.findIndex(c => c[0] === origin)}.json`)
    const h = harness({ origin }, [], { jsonFile: file })
    h.deps.writeJson = writePrivate
    assert.equal(await h.run(), 0)
    const report = reportOf(h)
    assert.ok(report.split('\n').includes(`  ${line}`), report)
    const json = fs.readFileSync(file, 'utf8')
    const page = JSON.parse(json).page.origin
    const host = origin === 'null' ? '' : new URL(origin).host.replace('assistant.example.com', '[public-host]')
    assert.deepEqual([page.scheme, page.host, page.isPage], [origin === 'null' ? '' : new URL(origin).protocol.slice(0, -1), host, false])
    assertClean(report)
    assertClean(json)
  }
})

test('--json stays JSON when a meeting link\'s query holds a value such as "true", and still holds none of the link', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-stt-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const teams = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abcdef%40thread.v2/0?context=%7b%7d&anon=true&directDl=true'
  const file = path.join(dir, 'teams.json')
  const h = harness({}, [], { jsonFile: file, meetingUrl: teams })
  h.deps.writeJson = writePrivate
  assert.equal(await h.run(), 0)
  const text = fs.readFileSync(file, 'utf8')
  const data = JSON.parse(text)
  assert.equal(data.keep, false)
  assert.equal(data.verdict.safe, true)
  assert.ok(data.steps.every((s: { ran: unknown }) => s.ran === true))
  for (const never of [teams, 'meetup-join', '19%3ameeting_abcdef%40thread.v2', LOCAL_TOKEN, BOT]) assert.ok(!text.includes(never), never)
})

// --- The pure parts ------------------------------------------------------------------------------------------------

test('answers: y, n and s spelt out or not, Enter as yes only where it says so, and ladder sizes only from the ladder', () => {
  assert.deepEqual(['y', 'Yes', ' n ', 'NO', 's', 'skip', '', 'maybe'].map(readYesNo), ['y', 'y', 'n', 'n', 's', 's', null, null])
  assert.deepEqual(['', 'y', 'n', 's', 'x'].map(readEnterOrNo), ['y', 'y', 'n', 's', null])
  assert.deepEqual(['16', '16px', '16 px', 'none', 'None', 's', '15', '0', '', 'big'].map(readLadder), ['16 px', '16 px', '16 px', 'none', 'none', 's', null, null, null, null])
  assert.match(platformHint('microsoft_teams', 'Nova'), /make Nova a presenter/)
  assert.match(platformHint('zoom', 'Nova'), /"Who can share\?" must be "All participants"/)
})

test('the verdict is safe only with the camera page untouched and known from S2 to S9, every share and stop accepted, the share seen and gone, and the assistant heard and answering in S3, S4 and S8', () => {
  const steps = () =>
    STEP_IDS.map(id => {
      const s = newStep(id)
      s.ran = true
      s.result = 'PASS'
      s.camera = { attaches: 0, drops: 0, refused: 0 }
      if (id === 'S2') s.answers.push({ key: 'seen', question: '', answer: 'y' })
      if (id === 'S3' || id === 'S8') s.answers.push({ key: 'heard', question: '', answer: 'y' })
      if (id === 'S4' || id === 'S8') s.answers.push({ key: 'answered', question: '', answer: 'y' })
      if (id === 'S8') s.answers.push({ key: 'gone', question: '', answer: 'y' })
      if (id === 'S2' || id === 'S7' || id === 'S9') s.recall.push({ call: 'share', epoch: 1, status: 200, ms: 400 })
      if (id === 'S8' || id === 'S9') s.recall.push({ call: 'unshare', epoch: 1, status: 204, ms: 200 })
      return s
    })
  const lineOf = (edit: (s: ReturnType<typeof steps>) => void, stopped: string | null = null) => {
    const s = steps()
    edit(s)
    return verdict({ name: 'Alex', platform: 'zoom', steps: s, stopped }).line
  }
  // Stopped partway through the last step, or the camera page not known at the end: never safe.
  assert.equal(lineOf(() => {}, 'you pressed Ctrl-C'), 'Not safe yet on Zoom: the test stopped partway through S9 (you pressed Ctrl-C).')
  assert.equal(lineOf(s => void (s[8].camera = null)), 'Not safe yet on Zoom: the camera page is not known in S9.')
  assert.equal(lineOf(s => void (s[4].camera = null)), 'Slides look safe on Zoom.', 'S5 not known, but S6 counted from S4 on')
  // Hearing while sharing and after the stop.
  assert.equal(lineOf(s => void (s[3].answers[0].answer = 'n')), 'Not safe yet on Zoom: Alex did not answer you in S4.')
  assert.equal(lineOf(s => void (s[7].answers[1].answer = 's')), 'Not safe yet on Zoom: Alex answering was not confirmed in S8.')
  // A replace or a stop that Recall refused, a share that did not go, and the other answers.
  assert.equal(lineOf(s => void (s[7].recall[0].status = 400)), 'Not safe yet on Zoom: Recall did not stop the share in S8, so a stop was not tested.')
  assert.equal(lineOf(s => void (s[7].recall[0].status = 0)), 'Not safe yet on Zoom: Recall did not stop the share in S8, so a stop was not tested.')
  assert.equal(lineOf(s => void (s[7].answers[2].answer = 'n')), 'Not safe yet on Zoom: you said the share did not go in S8.')
  assert.equal(lineOf(s => void (s[7].answers[2].answer = 's')), 'Not safe yet on Zoom: the share going was not confirmed in S8.')
  assert.equal(lineOf(s => void (s[6].recall[0].status = 400)), 'Not safe yet on Zoom: Recall did not accept the new share in S7, so a replace was not tested.')
  assert.equal(lineOf(s => void s[6].answers.push({ key: 'session', question: '', answer: 'n' })), 'Not safe yet on Zoom: the page did not show the new session in S7.')
  assert.equal(lineOf(s => void (s[8].recall[0].status = 403)), 'Not safe yet on Zoom: Recall answered 403 to the share in S9 (restart).')
  assert.equal(lineOf(s => void s[4].answers.push({ key: 'counted', question: '', answer: 'n' })), 'Not safe yet on Zoom: the number did not count up to 5 in S5.')
  assert.deepEqual(verdict({ name: 'Alex', platform: 'microsoft_teams', steps: steps(), stopped: null }), { safe: true, line: 'Slides look safe on Microsoft Teams.', reasons: [] })
  const s1Moved = steps()
  s1Moved[0].camera = { attaches: 1, drops: 1, refused: 0 }
  assert.equal(verdict({ name: 'Alex', platform: 'zoom', steps: s1Moved, stopped: null }).safe, true, 'S1 is before any share')
  const notHeard = steps()
  notHeard[7].answers[0].answer = 's'
  assert.match(verdict({ name: 'Alex', platform: 'zoom', steps: notHeard, stopped: null }).line, /^Not safe yet on Zoom: hearing Alex was not confirmed in S8\.$/)
  const dropped = steps()
  dropped[6].camera = { attaches: 0, drops: 1, refused: 0 }
  assert.match(verdict({ name: 'Alex', platform: 'zoom', steps: dropped, stopped: null }).line, /the camera page dropped 1 time in S7 \(replace\)/)
})

test('the scrub takes out keys, the meeting link and its parts, addresses with tokens, ids and the bot', () => {
  const { scrub, setBot } = scrubber({ secrets: [RECALL_KEY], meetingUrl: ZOOM, publicUrl: PUBLIC })
  setBot(BOT)
  const text = `bot ${BOT} at ${ZOOM} (id 123456789, pass Secr3tPass) loaded ${PUBLIC}/share-test?t=abc and wss://assistant.example.com/share-test-link?t=abc with ${RECALL_KEY}; Origin ${PUBLIC}; key 0f0e0d0c-0b0a-4909-8807-060504030201`
  assert.equal(
    scrub(text),
    'the bot at [meeting link] (id [meeting link], pass [meeting link]) loaded [link] and [link] with [key]; Origin https://[public-host]; key [id]',
  )
})
