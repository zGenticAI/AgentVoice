// The screen-share test's state for one meeting joined with share_test (npm run join --share-test, docs/share-test.md):
// its shares (each a POST to Recall with a page address of its own), the test page's link, what the page reported, and
// what happened to the camera page on /audio meanwhile, which is what the test is for. The server owns one per meeting
// and hands it what it notices; the join CLI drives it through the control socket, one action at a time.
//
// Each share has a token of its own (32 random bytes, never logged, never in the status), and the public routes open
// only while a share is starting or live with that token. A share that replaces a live one leaves the old token valid
// until the new page says hello or HELLO_WAIT_MS pass, so the old page can be seen closing. The link of a share that
// was stopped or replaced stays open a while, to see when the bot's browser closes it, then the service closes it.
//
// Nothing here may take the service down: every socket handler, timer and Recall call catches its own errors. The log
// has the bot's id, the step, Recall's HTTP status and timings only: never a token, a URL, an Origin or a reply.
import { randomBytes } from 'node:crypto'
import WebSocket from 'ws'
import { sameSecret } from '../network.ts'
import { RecallError } from '../recall.ts'
import {
  HELLO_WAIT_MS, LINK_MESSAGES_PER_SECOND, type PageHello, type PageMetrics, SAY_WAIT_MS, type ShareState, type ShareTestAction,
  type ShareTestResult, type ShareTestStatus, type ShareView, type TestLineOutcome, testLine,
} from './protocol.ts'

/** The service pings the link this often, and closes one it has not heard from for LINK_SILENCE_MS (ms). */
export const LINK_PING_MS = 5_000
export const LINK_SILENCE_MS = 15_000
/** How long the link of a share that was stopped or replaced is left for the bot's browser to close (ms). */
export const LINK_LINGER_MS = 30_000
/** How many of a share's metrics are kept: 2 s apart, a few minutes' worth. */
const METRICS_KEPT = 150
/** Close codes the page knows: the share is over (4000), or a newer connection took its place (4001). */
export const LINK_CLOSE = Object.freeze({ over: 4000, replaced: 4001, refused: 1008 })

/** What a share test needs from the server and Recall. */
export interface ShareTestDeps {
  botId: string
  /** The test page's address for a token: the public address's /share-test?t=<token>. Never logged. */
  pageUrl(token: string): string
  /** The public address's origin, to tell whether the link's Origin is the page's own. */
  pageOrigin: string
  /** Asks Recall to share the page (POST output_media), resolving with its HTTP status. */
  start(url: string): Promise<number>
  /** Asks Recall to stop the share only (DELETE output_media with {"screenshare":true}), resolving with its HTTP status. */
  stop(): Promise<number>
  now?: () => number
  timing?: Partial<{ helloWaitMs: number; lingerMs: number; pingMs: number; silenceMs: number; sayWaitMs: number; perSecond: number }>
}

/** What an action needs from the meeting it is for. */
export interface ActionContext {
  /** The step of the test it is for (S1 to S9), for the log. */
  step?: string
  /** The assistant's name, for the test line. */
  name: string
  /** Says a line through the meeting session's normal speech path, and says how it went. */
  say(text: string): Promise<TestLineOutcome>
  /** Takes the assistant out of the meeting by its normal leaving path. */
  leave(): void
}

/** One share: its token, its link, and what is known of it. */
interface Share {
  view: ShareView
  token: string
  /** Its token still opens the page and the link. */
  accepting: boolean
  link: WebSocket | null
  /** Closes its link if the bot's browser has not, once it was stopped or replaced. */
  linger?: NodeJS.Timeout
  /** Ends the old token's grace, for a share that was replaced. */
  grace?: NodeJS.Timeout
}

/** An action asked for once the meeting is over for the test (its bot is leaving, or out). */
export class ShareTestOver extends Error {}

/** The scheme and host of an Origin header, at most 200 characters: '' when there is none, and never its path. */
export function originOf(header: string | undefined): string {
  if (header === undefined) return ''
  const url = URL.parse(header)
  const shown = url && /^[a-z][a-z0-9+.-]*:$/i.test(url.protocol) && url.host ? `${url.protocol}//${url.host}` : header.replace(/[^\x21-\x7e]/g, '?')
  return shown.slice(0, 200)
}

const finite = (value: unknown, max: number): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : null
const VISIBILITY = new Set(['visible', 'hidden', 'prerender'])
const visibility = (value: unknown): string => (typeof value === 'string' && VISIBILITY.has(value) ? value : 'unknown')

/** The page's hello, as kept: numbers within reason, or nothing. */
function readHello(msg: Record<string, unknown>): PageHello | null {
  const viewport = (msg.viewport ?? {}) as Record<string, unknown>
  const width = finite(viewport.width, 100_000)
  const height = finite(viewport.height, 100_000)
  const dpr = finite(msg.dpr, 16)
  if (width === null || height === null || dpr === null) return null
  const major = finite(msg.chromeMajor, 9999)
  return { width: Math.round(width), height: Math.round(height), dpr, visibility: visibility(msg.visibility), chrome_major: major === null ? null : Math.round(major) }
}

function readMetrics(msg: Record<string, unknown>, at: number): PageMetrics | null {
  const fps = finite(msg.fps, 1000)
  const late = finite(msg.worstTimerLateMs, 3_600_000)
  if (fps === null || late === null) return null
  return { at, fps: Math.round(fps * 10) / 10, worst_timer_late_ms: Math.round(late), visibility: visibility(msg.visibility) }
}

/** Recall's HTTP status in a failed call, or 0 when it did not answer (the network, a timeout). */
function statusOf(err: unknown): number {
  return err instanceof RecallError ? err.status : 0
}

/** Resolves as `work` does, or with `late` after ms, whichever is first. */
function within<T>(work: Promise<T>, ms: number, late: T): Promise<T> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(late), ms)
    timer.unref()
    work.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(late)
      },
    )
  })
}

/** An error's name, short: never its message, which for a Recall call or a socket could carry the URL. */
const errorKind = (err: unknown): string => (err instanceof Error ? err.name : 'error')

export class ShareTest {
  state: ShareState = 'off'
  private epoch = 0
  private frame = 0
  private readonly shares: Share[] = []
  /** The share the actions are about: the newest one, while it is starting, live or stopping. */
  private current: Share | null = null
  /** A share the current one replaced, whose token stays valid until the new page says hello. */
  private previous: Share | null = null
  private readonly camera = { attaches: [] as number[], drops: [] as number[], refused: [] as number[] }
  private queue: Promise<unknown> = Promise.resolve()
  private over = false
  private readonly now: () => number
  private readonly timing: Required<NonNullable<ShareTestDeps['timing']>>

  constructor(private readonly deps: ShareTestDeps) {
    this.now = deps.now ?? Date.now
    this.timing = {
      helloWaitMs: HELLO_WAIT_MS,
      lingerMs: LINK_LINGER_MS,
      pingMs: LINK_PING_MS,
      silenceMs: LINK_SILENCE_MS,
      sayWaitMs: SAY_WAIT_MS,
      perSecond: LINK_MESSAGES_PER_SECOND,
      ...deps.timing,
    }
  }

  private log(text: string): void {
    console.log(`[share-test] bot ${this.deps.botId}: ${text}`)
  }

  // --- The camera page on /audio: the server says what it notices, and changes nothing about it ----------------

  /** The camera page connected: its first connection, or one that came back. */
  cameraAttached(): void {
    this.camera.attaches.push(this.now())
  }

  /** The camera page's connection dropped. */
  cameraDropped(): void {
    this.camera.drops.push(this.now())
  }

  /** A camera page was refused: one without the meeting's secret (a page loaded again), or an earlier try. */
  cameraRefused(): void {
    this.camera.refused.push(this.now())
  }

  // --- The public routes -----------------------------------------------------------------------------------

  /**
   * The share whose token this is, while it may open the page or the link: starting or live, or replaced and still in
   * its grace. Every token is compared, in constant time, so how long a refusal takes says nothing.
   */
  shareFor(token: string): Share | null {
    let found: Share | null = null
    for (const share of this.shares) if (share.accepting && sameSecret(token, share.token)) found = share
    return this.over ? null : found
  }

  /**
   * A link the server let in for this share (its token checked). The newest connection wins: the one before it is
   * closed, and anything still arriving on it is ignored. Messages: JSON only, LINK_MAX_BYTES each (ws closes a larger
   * one), at most perSecond a second; anything else closes the link. origin: the upgrade's Origin header, kept as its
   * scheme and host for the report, and never logged.
   */
  take(ws: WebSocket, share: Share, origin: string | undefined): void {
    // First, before any frame: an error nothing listens to would take the service down, and every meeting with it.
    ws.on('error', () => {})
    if (this.over || !share.accepting) return void ws.close(LINK_CLOSE.over, 'over')
    try {
      this.wire(ws, share, origin)
    } catch (err) {
      console.error(`[share-test] bot ${this.deps.botId}: a link could not be set up, so it was closed (${errorKind(err)})`)
      ws.terminate()
    }
  }

  private wire(ws: WebSocket, share: Share, origin: string | undefined): void {
    const old = share.link
    share.link = ws
    share.view.links++
    share.view.link_open = true
    share.view.link_closed_at = null
    share.view.link_close_code = null
    share.view.link_closed_by = null
    if (share.view.origin === null) {
      share.view.origin = originOf(origin)
      share.view.origin_is_page = share.view.origin === this.deps.pageOrigin
    }
    // A later connection for the same share: the page came back, or someone else holds its address.
    if (old) this.closeLink(share, old, LINK_CLOSE.replaced)
    ws.send(JSON.stringify({ type: 'session', epoch: share.view.epoch }))

    let heard = this.now()
    let second = 0
    let inSecond = 0
    ws.on('pong', () => void (heard = this.now()))
    ws.on('message', (data, isBinary) => {
      try {
        // A connection that was replaced: nothing of it counts.
        if (share.link !== ws) return
        heard = this.now()
        // A fixed window, checked before the message is read.
        const s = Math.floor(heard / 1000)
        if (s !== second) {
          second = s
          inSecond = 0
        }
        if (++inSecond > this.timing.perSecond) return this.refuseLink(share, ws, 'sent more than it may')
        if (isBinary) return this.refuseLink(share, ws, 'sent something that is not JSON')
        let msg: unknown
        try {
          msg = JSON.parse(String(data))
        } catch {
          return this.refuseLink(share, ws, 'sent something that is not JSON')
        }
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return this.refuseLink(share, ws, 'sent something that is not JSON')
        this.onPageMessage(share, msg as Record<string, unknown>)
      } catch (err) {
        console.error(`[share-test] bot ${this.deps.botId}: a message on the link failed, so it was closed (${errorKind(err)})`)
        ws.terminate()
      }
    })
    const beat = setInterval(() => {
      try {
        if (this.now() - heard > this.timing.silenceMs) {
          this.log(`share ${share.view.epoch}'s link went quiet, so it was closed`)
          return this.closeLink(share, ws, 0)
        }
        if (ws.readyState === WebSocket.OPEN) ws.ping()
      } catch {
        ws.terminate()
      }
    }, this.timing.pingMs)
    beat.unref()
    ws.once('close', code => {
      clearInterval(beat)
      try {
        if (share.link !== ws) return
        share.link = null
        share.view.link_open = false
        share.view.link_closed_at = this.now()
        share.view.link_close_code = code
        share.view.link_closed_by ??= 'page'
        clearTimeout(share.linger)
        const since = share.view.posted_at === null ? '' : ` ${this.now() - share.view.posted_at} ms after it was asked for`
        this.log(`share ${share.view.epoch}'s link closed (${code}),${since}`)
      } catch {
        // Only bookkeeping: nothing to undo.
      }
    })
  }

  /** Closes a link from the service's side: code 0 cuts it at once, as for one gone quiet. */
  private closeLink(share: Share, ws: WebSocket, code: number): void {
    if (share.link === ws) share.view.link_closed_by = 'service'
    if (code) ws.close(code, code === LINK_CLOSE.replaced ? 'replaced' : 'over')
    else ws.terminate()
  }

  private refuseLink(share: Share, ws: WebSocket, why: string): void {
    this.log(`share ${share.view.epoch}'s link ${why}, so it was closed`)
    this.closeLink(share, ws, LINK_CLOSE.refused)
  }

  /** hello, metrics and shown: anything else is ignored. */
  private onPageMessage(share: Share, msg: Record<string, unknown>): void {
    const at = this.now()
    if (msg.type === 'hello') {
      const hello = readHello(msg)
      if (!hello) return
      share.view.hello = hello
      if (share.view.hello_at !== null) return
      share.view.hello_at = at
      const after = share.view.posted_at === null ? '' : ` ${at - share.view.posted_at} ms after it was asked for`
      this.log(`share ${share.view.epoch}'s page said hello${after}`)
      if (share === this.current && this.state === 'starting') this.state = 'live'
      // The share it replaced is shown no more: its token opens nothing from now on.
      if (share === this.current && this.previous) this.retire(this.previous)
      return
    }
    if (msg.type === 'metrics') {
      const metrics = readMetrics(msg, at)
      if (!metrics) return
      share.view.metrics.push(metrics)
      if (share.view.metrics.length > METRICS_KEPT) share.view.metrics.shift()
      return
    }
    if (msg.type === 'shown') {
      const sent = share.view.frames.find(f => f.frame === msg.frame && f.shown_at === null)
      if (sent) sent.shown_at = at
    }
  }

  /** A share that was stopped or replaced: its token opens nothing, and its link is closed if the browser keeps it. */
  private retire(share: Share): void {
    share.accepting = false
    clearTimeout(share.grace)
    if (share === this.previous) this.previous = null
    if (!share.link || share.linger) return
    const ws = share.link
    share.linger = setTimeout(() => {
      try {
        if (share.link === ws) this.closeLink(share, ws, LINK_CLOSE.over)
      } catch {
        ws.terminate()
      }
    }, this.timing.lingerMs)
    share.linger.unref()
  }

  // --- The actions -------------------------------------------------------------------------------------------

  /** Runs an action once those asked before it are done: one at a time per meeting. Never rejects but for 'over'. */
  act(action: ShareTestAction, ctx: ActionContext): Promise<ShareTestResult> {
    const run = this.queue.then(() => this.run(action, ctx))
    this.queue = run.catch(() => {})
    return run
  }

  private async run(action: ShareTestAction, ctx: ActionContext): Promise<ShareTestResult> {
    if (this.over) throw new ShareTestOver('the meeting is over')
    const step = ctx.step ? `${ctx.step} ` : ''
    if (action === 'share') return this.share(step)
    if (action === 'unshare') return this.unshare(step)
    if (action === 'say') {
      const started = this.now()
      const said = await within(ctx.say(testLine(ctx.name, this.state === 'starting' || this.state === 'live')), this.timing.sayWaitMs, 'timeout')
      const ms = this.now() - started
      this.log(`${step}say: ${said} in ${ms} ms`)
      return { action, said, ms }
    }
    if (action === 'flip') {
      const frame = ++this.frame
      const share = this.current
      const ws = share?.link
      const sent = Boolean(share && ws && ws.readyState === WebSocket.OPEN)
      if (share && ws && sent) {
        share.view.frames.push({ frame, sent_at: this.now(), shown_at: null })
        ws.send(JSON.stringify({ type: 'frame', frame }))
      }
      return { action, frame, sent }
    }
    ctx.leave()
    this.log(`${step}leave: asked`)
    return { action: 'leave', leaving: true }
  }

  /** POSTs a new share. While one is on, this is the replace test: no DELETE first. */
  private async share(step: string): Promise<ShareTestResult> {
    const replaced = this.state === 'starting' || this.state === 'live' ? this.current : null
    const share: Share = {
      token: randomBytes(32).toString('base64url'),
      accepting: true,
      link: null,
      view: {
        epoch: ++this.epoch,
        posted_at: this.now(),
        post_status: null,
        post_ms: null,
        hello_at: null,
        hello: null,
        links: 0,
        link_open: false,
        link_closed_at: null,
        link_close_code: null,
        link_closed_by: null,
        origin: null,
        origin_is_page: null,
        metrics: [],
        frames: [],
        stop_status: null,
        stop_ms: null,
        stopped_at: null,
      },
    }
    this.shares.push(share)
    if (replaced) {
      // A share still in its grace from a replace before this one is done with at once.
      if (this.previous) this.retire(this.previous)
      this.previous = replaced
      replaced.grace = setTimeout(() => {
        try {
          if (this.previous === replaced) this.retire(replaced)
        } catch {
          replaced.accepting = false
        }
      }, this.timing.helloWaitMs)
      replaced.grace.unref()
    }
    this.current = share
    this.state = 'starting'
    let status: number
    try {
      status = await this.deps.start(this.deps.pageUrl(share.token))
    } catch (err) {
      status = statusOf(err)
    }
    const ms = this.now() - (share.view.posted_at ?? this.now())
    share.view.post_status = status
    share.view.post_ms = ms
    const what = `${step}share ${share.view.epoch}${replaced ? ` (replacing share ${replaced.view.epoch})` : ''}`
    if (this.over) return { action: 'share', epoch: share.view.epoch, status, ms, replacing: Boolean(replaced) }
    if (status >= 200 && status < 300) {
      this.log(`${what}: Recall answered ${status} in ${ms} ms`)
    } else {
      this.log(`${what}: ${status ? `Recall answered ${status}` : 'Recall did not answer'} in ${ms} ms`)
      // Refused: its token opens nothing, and the share it would have replaced (if any) is still the one on.
      this.retire(share)
      if (this.current === share) {
        if (replaced && this.previous === replaced) {
          clearTimeout(replaced.grace)
          this.previous = null
          this.current = replaced
          this.state = replaced.view.hello_at === null ? 'starting' : 'live'
        } else {
          this.current = null
          this.state = 'off'
        }
      }
    }
    return { action: 'share', epoch: share.view.epoch, status, ms, replacing: Boolean(replaced) }
  }

  /** Stops the share: DELETE with {"screenshare":true}, which leaves the camera page running. */
  private async unshare(step: string): Promise<ShareTestResult> {
    const share = this.current
    this.state = 'stopping'
    // From now on its page and link open nothing; the link stays a while, to see when the bot's browser closes it.
    for (const s of [share, this.previous]) if (s) this.retire(s)
    const started = this.now()
    let status: number
    try {
      status = await this.deps.stop()
    } catch (err) {
      status = statusOf(err)
    }
    const ms = this.now() - started
    if (share) {
      share.view.stop_status = status
      share.view.stop_ms = ms
      share.view.stopped_at = started
    }
    this.log(`${step}unshare${share ? ` ${share.view.epoch}` : ''}: ${status ? `Recall answered ${status}` : 'Recall did not answer'} in ${ms} ms`)
    if (!this.over) {
      if (share && !(status >= 200 && status < 300)) {
        // Recall did not say it stopped (a refusal, or no answer): the share may still be shown, so it is still the one
        // on, and a later share is a replace. Its token stays retired.
        this.current = share
        this.state = share.view.hello_at === null ? 'starting' : 'live'
      } else {
        this.current = null
        this.state = 'off'
      }
    }
    return { action: 'unshare', status, ms }
  }

  // --- The status, and the end ------------------------------------------------------------------------------

  status(meeting: ShareTestStatus['meeting'], consentDone: boolean | null): ShareTestStatus {
    return {
      meeting,
      consent_done: consentDone,
      state: this.state,
      epoch: this.epoch,
      current: this.current?.view.epoch ?? null,
      camera: { attaches: [...this.camera.attaches], drops: [...this.camera.drops], refused: [...this.camera.refused] },
      shares: this.shares.map(s => ({ ...s.view, metrics: [...s.view.metrics], frames: s.view.frames.map(f => ({ ...f })) })),
      now: this.now(),
    }
  }

  /** The meeting is over (its bot is leaving, or out, or the service is closing): every token dies, every link closes. */
  end(): void {
    if (this.over) return
    this.over = true
    this.state = 'off'
    for (const share of this.shares) {
      share.accepting = false
      clearTimeout(share.grace)
      clearTimeout(share.linger)
      const ws = share.link
      if (ws) {
        try {
          this.closeLink(share, ws, LINK_CLOSE.over)
        } catch {
          ws.terminate()
        }
      }
    }
    this.current = null
    this.previous = null
  }
}

export type { Share }
