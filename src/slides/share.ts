// A meeting's slide share: ShareControl asks Recall to share the slides page as the bot's screen (POST output_media
// with a webpage, beside the camera page that carries the assistant's voice), feeds that page over its link
// (/slides-link), and stops the share with exactly {"screenshare":true}, which leaves the camera page running. The server
// owns one per meeting with slides; the session reaches it only through SlideSurface (src/slides/surface.ts).
//
// Each share has an id (16 random bytes) and a token (32), both new on every POST and never logged: the page and its
// link open only with them, only while that share is live. SlideShares answers the public routes for every meeting:
// while no share is live anywhere, /slides, /slides.js and /slides-link are not found, as any other path, so a meeting
// without slides sees no new answer on the public port.
//
// What goes to the page: the slide to show and its neighbours only, never the whole deck, in 64 KiB pieces paced at
// about 2 Mbit/s, since the images share the tunnel and the owner's upload with the assistant's voice. The page
// acknowledges each slide once it is on screen. The page blanks itself when its link is gone (public/slides.js).
//
// Nothing here may take the service down (an uncaught error stops every meeting): every socket handler, timer, the
// sender and the DELETE retry loop catch their own errors, and a fault degrades the share instead: before it is shown,
// to failed; after, to stopped, with the page blanked, the token revoked and one DELETE. The log has the bot's id, the
// share's number, states, slide numbers on problems, Recall's HTTP status and counts only: never a token, an id, a URL,
// an Origin, a title or Recall's reply.
import { randomBytes } from 'node:crypto'
import type http from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'
import { sameSecret } from '../network.ts'
import { RecallError, worthRetrying } from '../recall.ts'
import type { ShareEvent, SlideSurface, StartOutcome } from './surface.ts'

export const SLIDES_PAGE_PATH = '/slides'
export const SLIDES_SCRIPT_PATH = '/slides.js'
export const SLIDES_LINK_PATH = '/slides-link'
/** The most one message from the page may hold, and how many it may send a second. */
export const LINK_MAX_BYTES = 1024
export const LINK_MESSAGES_PER_SECOND = 20
/**
 * Close codes the page knows: the share is over (4000: show ended, don't come back), or a newer link took its place
 * (4001: the page links again and takes it back, so a holder of the address is caught as contested if it keeps taking it).
 */
export const LINK_CLOSE = Object.freeze({ over: 4000, replaced: 4001, refused: 1008 })
/** A binary piece of a slide: "AVSL", version, kind, slide index, the image's length and this piece's offset. */
export const CHUNK_HEADER_BYTES = 16
export const CHUNK_BYTES = 64 * 1024

export interface ShareTiming {
  heartbeatMs: number
  silenceMs: number
  loadMs: number
  ackMs: number
  stuckAfter: number
  postGapMs: number
  postsPerHour: number
  contestedReplacements: number
  contestedMs: number
  upgradeGapMs: number
  cameraSuspectMs: number
  sendKbps: number
  bufferedMax: number
  deleteBackoffMs: readonly number[]
  refusalsLogMs: number
}

export const TIMING: Readonly<ShareTiming> = Object.freeze({
  /** The page is sent a heartbeat and a ping this often, and a link not heard from for silenceMs is cut (ms). */
  heartbeatMs: 1000,
  silenceMs: 4000,
  /** How long a start waits for the page to link up and show the first slide (ms). */
  loadMs: 20_000,
  /** How long a show waits for the page to say the slide is on screen (ms). */
  ackMs: 3000,
  /** Shows not acknowledged in a row before the share is taken as stuck, and stopped. */
  stuckAfter: 3,
  /** Our own limit on POSTs per meeting: at least gapMs apart, and perHour in any hour. */
  postGapMs: 10_000,
  postsPerHour: 12,
  /** More than this many links replacing each other within contestedMs: someone else holds the share's address. */
  contestedReplacements: 2,
  contestedMs: 60_000,
  /** At most one link let in a second, for each share (ms). */
  upgradeGapMs: 1000,
  /** The camera page dropping this soon after a POST or a DELETE is suspected to be the share's doing (ms). */
  cameraSuspectMs: 15_000,
  /** The pace images go to the page at (kbit/s), and how much may wait in the socket before the sender waits too. */
  sendKbps: 2000,
  bufferedMax: 256 * 1024,
  /** The waits between tries of a DELETE Recall did not take, the last one again until it does or the meeting is gone. */
  deleteBackoffMs: [1000, 2000, 5000, 10_000, 30_000],
  /** Refusals of the link are logged as counts, at most this often (ms). */
  refusalsLogMs: 60_000,
})

/** What a share needs from the server and Recall. */
export interface ShareDeps {
  botId: string
  /** The slides the meeting shows, in page order: index i is the i-th. Only these ever go to the page. */
  images: readonly Buffer[]
  /** The page's address for a share, with its id and token: <public address>/slides?s=..&t=... Never logged. */
  pageUrl(id: string, token: string): string
  /** Asks Recall to share the page (POST output_media), resolving with its HTTP status, or throwing a RecallError. */
  start(url: string): Promise<number>
  /** Asks Recall to stop the share only (DELETE output_media with exactly {"screenshare":true}). */
  stop(): Promise<number>
  now?: () => number
  timing?: Partial<ShareTiming>
}

/** One POST: its id and token, and the page's link while it has one. */
export interface Share {
  epoch: number
  id: string
  token: string
  /** Its token still opens the page and the link. */
  accepting: boolean
  link: Link | null
  /** When a link was last let in for it, and when links replaced each other (for contested). */
  upgradedAt: number
  replacements: number[]
  postedAt: number
  /** What the log says it reached: posted, linked, hello, shown. */
  stage: 'posted' | 'linked' | 'hello' | 'shown'
}

/** The page's link, and what it holds. */
interface Link {
  ws: WebSocket
  share: Share
  /** The slides the page has (from its hello, and what was sent since). */
  have: Set<number>
  helloed: boolean
  diag: boolean
  /** The sender's queue, and whether it is running. */
  queue: number[]
  sending: boolean
}

/** What a show waits for. */
interface Pending {
  i: number
  seq: number
  resolve: (outcome: 'shown' | 'timeout') => void
  timer: NodeJS.Timeout
}

const errorKind = (err: unknown): string => (err instanceof Error ? err.name : 'error')
const statusOf = (err: unknown): number => (err instanceof RecallError ? err.status : 0)

/** Waits ms. */
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms).unref())

/** A slide's piece as it goes to the page. */
export function chunkFrame(i: number, image: Buffer, offset: number, size = CHUNK_BYTES): Buffer {
  const piece = image.subarray(offset, Math.min(image.length, offset + size))
  const header = Buffer.alloc(CHUNK_HEADER_BYTES)
  header.write('AVSL', 0, 'latin1')
  header.writeUInt8(1, 4) // version
  header.writeUInt8(1, 5) // kind: an image
  header.writeUInt16BE(i, 6)
  header.writeUInt32BE(image.length, 8)
  header.writeUInt32BE(offset, 12)
  return Buffer.concat([header, piece])
}

/** The slides a page says it has, from its hex bitmap (bit i of byte i >> 3): only indexes below count. */
export function readHave(hex: unknown, count: number): Set<number> {
  const have = new Set<number>()
  if (typeof hex !== 'string' || hex.length > 64 || !/^(?:[0-9a-f]{2})*$/i.test(hex)) return have
  const bytes = Buffer.from(hex, 'hex')
  for (let i = 0; i < count && i >> 3 < bytes.length; i++) if (bytes[i >> 3] & (1 << (i & 7))) have.add(i)
  return have
}

/** A meeting's slide share (see the top of this file). */
export class ShareControl implements SlideSurface {
  state: SlideSurface['state'] = 'off'
  readonly count: number
  /** The meeting set's revision: a page that held another one's images drops them. */
  readonly rev = randomBytes(4).toString('hex')
  private readonly timing: ShareTiming
  private readonly now: () => number
  private readonly listeners = new Map<ShareEvent, (() => void)[]>()
  private share: Share | null = null
  /** Shares stopped or replaced: their links may still be open for a moment, and their tokens open nothing. */
  private readonly retired: Share[] = []
  private epoch = 0
  private seq = 0
  /** What the page should show now: a slide (with the window to send for it), or a frame. */
  private view: { kind: 'slide'; i: number; seq: number; window: number[] } | { kind: 'frame'; frame: 'paused' | 'ended'; seq: number } | null = null
  private pending: Pending | null = null
  /** Shows not acknowledged in a row. */
  private misses = 0
  private restarting = false
  /** When the share last changed at Recall (a POST or a DELETE), for camera_suspect. */
  private changedAt = 0
  private posts: number[] = []
  /** No more POSTs for this meeting: the camera page dropped right after a share change, or the link was contested. */
  private disabled = false
  /** The meeting is over for the share: closed, never to start again. */
  private over = false
  private stopping: Promise<void> | null = null
  private startWaiter: ((outcome: StartOutcome) => void) | null = null
  /** Counts the stops: a start or a restart that a stop overtook gives up, and takes back a share Recall took meanwhile. */
  private generation = 0

  constructor(private readonly deps: ShareDeps) {
    this.count = deps.images.length
    this.now = deps.now ?? Date.now
    this.timing = { ...TIMING, ...deps.timing }
  }

  private log(text: string): void {
    console.log(`[slides] bot ${this.deps.botId}: ${text}`)
  }

  on(event: ShareEvent, fn: () => void): void {
    const list = this.listeners.get(event) ?? []
    list.push(fn)
    this.listeners.set(event, list)
  }

  private emit(event: ShareEvent): void {
    for (const fn of this.listeners.get(event) ?? []) {
      try {
        fn()
      } catch (err) {
        console.error(`[slides] bot ${this.deps.botId}: a listener for ${event} failed (${errorKind(err)})`)
      }
    }
  }

  // --- For the public routes (SlideShares) --------------------------------------------------------------------------

  /** The share whose id this is, live or retired, compared in constant time; null for none. */
  shareFor(id: string): Share | null {
    let found: Share | null = null
    for (const share of [this.share, ...this.retired]) if (share && sameSecret(id, share.id)) found = share
    return found
  }

  /** Whether a share of this meeting is live: its token opens the page and the link. */
  get live(): boolean {
    return !this.over && this.share !== null && this.share.accepting
  }

  /**
   * A link the routes let in for this share (its token checked). The newest link wins: the one before it is closed
   * (4001), and the bot's page links again and takes it back. More than contestedReplacements of them within
   * contestedMs, and someone else holds the address: the share is stopped, and no more are made.
   */
  take(ws: WebSocket, share: Share): void {
    // First, before any frame: an error nothing listens to would take the service down, and every meeting with it.
    ws.on('error', () => {})
    try {
      if (this.over || !share.accepting || share !== this.share) return void ws.close(LINK_CLOSE.over, 'over')
      const old = share.link
      const link: Link = { ws, share, have: new Set(), helloed: false, diag: false, queue: [], sending: false }
      share.link = link
      if (share.stage === 'posted') share.stage = 'linked'
      this.wire(link)
      if (old) {
        old.ws.close(LINK_CLOSE.replaced, 'replaced')
        const now = this.now()
        share.replacements = share.replacements.filter(t => now - t < this.timing.contestedMs)
        share.replacements.push(now)
        // A page that reloads or lost its link replaces it once; someone else with the address makes them take turns.
        this.log(`share ${share.epoch}'s link was taken over by a newer one (${share.replacements.length} in ${Math.round(this.timing.contestedMs / 1000)} s)`)
        if (share.replacements.length > this.timing.contestedReplacements) return this.contested()
      }
      this.sendJson(link, { type: 'deck', v: 1, count: this.count, rev: this.rev })
    } catch (err) {
      this.fault('a link could not be set up', err)
      ws.terminate()
    }
  }

  private wire(link: Link): void {
    const { ws, share } = link
    let heard = this.now()
    let second = 0
    let inSecond = 0
    ws.on('pong', () => void (heard = this.now()))
    ws.on('message', (data, isBinary) => {
      try {
        if (share.link !== link) return
        heard = this.now()
        const s = Math.floor(heard / 1000)
        if (s !== second) {
          second = s
          inSecond = 0
        }
        if (++inSecond > LINK_MESSAGES_PER_SECOND) return this.refuseLink(link, 'sent more than it may')
        if (isBinary) return this.refuseLink(link, 'sent something that is not JSON')
        let msg: unknown
        try {
          msg = JSON.parse(String(data))
        } catch {
          return this.refuseLink(link, 'sent something that is not JSON')
        }
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return this.refuseLink(link, 'sent something that is not JSON')
        this.onPageMessage(link, msg as Record<string, unknown>)
      } catch (err) {
        this.fault('a message on the link failed', err)
      }
    })
    const beat = setInterval(() => {
      try {
        if (share.link !== link) return clearInterval(beat)
        if (this.now() - heard > this.timing.silenceMs) {
          this.log(`share ${share.epoch}'s link went quiet, so it was cut`)
          return ws.terminate()
        }
        if (ws.readyState !== WebSocket.OPEN) return
        ws.send(JSON.stringify({ type: 'hb' }))
        ws.ping()
      } catch {
        ws.terminate()
      }
    }, this.timing.heartbeatMs)
    beat.unref()
    ws.once('close', code => {
      clearInterval(beat)
      try {
        if (share.link !== link) return
        share.link = null
        if (!this.over && share === this.share && share.accepting) this.log(`share ${share.epoch}'s link closed (${code})`)
      } catch {
        // Only bookkeeping.
      }
    })
  }

  private refuseLink(link: Link, why: string): void {
    this.log(`share ${link.share.epoch}'s link ${why}, so it was closed`)
    link.ws.close(LINK_CLOSE.refused, 'refused')
  }

  /** hello, shown, framed, diag and bad: anything else is ignored. */
  private onPageMessage(link: Link, msg: Record<string, unknown>): void {
    const { share } = link
    if (msg.type === 'hello') {
      if (msg.v !== 1) return
      link.have = msg.rev === this.rev ? readHave(msg.have, this.count) : new Set()
      if (!link.helloed && share.stage === 'linked') {
        share.stage = 'hello'
        this.log(`share ${share.epoch}'s page linked up ${this.now() - share.postedAt} ms after it was asked for`)
      }
      link.helloed = true
      return this.sendView(link)
    }
    if (msg.type === 'shown') {
      const i = msg.i
      const seq = msg.seq
      if (typeof i !== 'number' || typeof seq !== 'number' || !Number.isInteger(i) || i < 0 || i >= this.count) return
      link.have.add(i)
      const view = this.view
      if (!view || view.kind !== 'slide' || view.seq !== seq || view.i !== i) return
      this.misses = 0
      if (share.stage !== 'shown') {
        share.stage = 'shown'
        this.log(`share ${share.epoch} showed its first slide ${this.now() - share.postedAt} ms after it was asked for`)
      }
      if (this.state === 'requested' && share === this.share) {
        this.state = 'loaded'
        this.startWaiter?.('loaded')
      }
      const pending = this.pending
      if (pending && pending.seq === seq) {
        this.pending = null
        clearTimeout(pending.timer)
        pending.resolve('shown')
      }
      return
    }
    if (msg.type === 'diag') {
      if (link.diag) return
      link.diag = true
      const num = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? Math.round(v * 100) / 100 : null)
      const visibility = typeof msg.visibility === 'string' && ['visible', 'hidden', 'prerender'].includes(msg.visibility) ? msg.visibility : 'unknown'
      this.log(
        `share ${share.epoch}'s page: ${num(msg.w, 100_000)}x${num(msg.h, 100_000)}, dpr ${num(msg.dpr, 16)}, ${visibility}, ` +
          `browser ${num(msg.ua_major, 9999)}`,
      )
      return
    }
    if (msg.type === 'bad') {
      const i = msg.i
      if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= this.count) return
      link.have.delete(i)
      this.log(`share ${share.epoch}'s page could not show slide ${i + 1} of the meeting's ${this.count}`)
    }
    // framed: nothing to do, the frame is up.
  }

  /** Sends the page what it should show now: the frame, or the slide's window and the show. */
  private sendView(link: Link): void {
    const view = this.view
    if (!view || !link.helloed) return
    if (view.kind === 'frame') return this.sendJson(link, { type: 'frame', kind: view.frame, seq: view.seq })
    // The slide first, then its neighbours: never the rest.
    link.queue = view.window.filter(i => !link.have.has(i))
    this.sendJson(link, { type: 'show', i: view.i, seq: view.seq, keep: view.window })
    this.pump(link)
  }

  private sendJson(link: Link, msg: object): void {
    if (link.ws.readyState === WebSocket.OPEN) link.ws.send(JSON.stringify(msg))
  }

  /** Sends the queued slides, one after another, in pieces at the pace set. One sender per link. */
  private pump(link: Link): void {
    if (link.sending) return
    link.sending = true
    void this.send(link)
      .catch(err => this.fault('sending a slide failed', err))
      .finally(() => (link.sending = false))
  }

  private async send(link: Link): Promise<void> {
    const bytesPerMs = (this.timing.sendKbps * 1000) / 8 / 1000
    for (;;) {
      const i = link.queue.shift()
      if (i === undefined) return
      if (link.have.has(i)) continue
      const image = this.deps.images[i]
      if (!image) continue
      for (let offset = 0; offset < image.length; offset += CHUNK_BYTES) {
        if (this.over || link.share.link !== link || link.ws.readyState !== WebSocket.OPEN) return
        while (link.ws.bufferedAmount > this.timing.bufferedMax) {
          await sleep(50)
          if (this.over || link.share.link !== link || link.ws.readyState !== WebSocket.OPEN) return
        }
        const frame = chunkFrame(i, image, offset)
        link.ws.send(frame)
        await sleep(Math.ceil(frame.length / bytesPerMs))
      }
      link.have.add(i)
    }
  }

  // --- SlideSurface ---------------------------------------------------------------------------------------------

  /** The slides to send for a show: the slide, then the ones given (its neighbours), in range and once each. */
  private windowOf(i: number, also?: readonly number[]): number[] {
    const around = also ?? [i - 1, i + 1]
    return [...new Set([i, ...around])].filter(n => Number.isInteger(n) && n >= 0 && n < this.count)
  }

  /** Why a POST may not go now: disabled, or our own limit. */
  private postRefusal(): 'disabled' | 'rate_limited' | '' {
    if (this.over || this.disabled) return 'disabled'
    const now = this.now()
    this.posts = this.posts.filter(t => now - t < 3_600_000)
    const last = this.posts.at(-1)
    if (last !== undefined && now - last < this.timing.postGapMs) return 'rate_limited'
    if (this.posts.length >= this.timing.postsPerHour) return 'rate_limited'
    return ''
  }

  /** POSTs a new share, with a new id and token: one retry, the same request, when Recall may take it then. */
  private async post(): Promise<{ share: Share; status: number }> {
    const share: Share = {
      epoch: ++this.epoch,
      id: randomBytes(16).toString('base64url'),
      token: randomBytes(32).toString('base64url'),
      accepting: true,
      link: null,
      upgradedAt: 0,
      replacements: [],
      postedAt: this.now(),
      stage: 'posted',
    }
    this.share = share
    this.posts.push(this.now())
    this.changedAt = this.now()
    const url = this.deps.pageUrl(share.id, share.token)
    let status = 0
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        status = await this.deps.start(url)
        break
      } catch (err) {
        status = statusOf(err)
        if (attempt === 2 || !worthRetrying(err) || this.over) break
      }
    }
    this.changedAt = this.now()
    return { share, status }
  }

  async start(at: number, also?: readonly number[]): Promise<StartOutcome> {
    try {
      if (this.stopping) await this.stopping
      const refused = this.postRefusal()
      if (refused) {
        this.log(refused === 'disabled' ? 'a share was not asked for: sharing is off for this meeting' : 'a share was not asked for: too many in a short time')
        return refused
      }
      if (this.state !== 'off') {
        // Already up: only a show.
        const shown = await this.show(at, also)
        return shown === 'shown' ? 'loaded' : 'not_loading'
      }
      this.state = 'requested'
      this.misses = 0
      this.setView(at, also)
      const generation = this.generation
      const { share, status } = await this.post()
      const ok = status >= 200 && status < 300
      if (this.over || generation !== this.generation || share !== this.share) {
        // Stopped while Recall was asked: a share it took meanwhile is stopped too, unless the bot is leaving.
        if (ok && !this.over) await this.deleteShare()
        return 'failed'
      }
      if (!ok) {
        this.log(`share ${share.epoch}: ${status ? `Recall answered ${status}` : 'Recall did not answer'}`)
        this.retire(share)
        this.state = 'off'
        return 'failed'
      }
      this.log(`share ${share.epoch}: Recall answered ${status}`)
      const outcome = await this.loaded(share)
      if (outcome === 'loaded') return 'loaded'
      if (this.over || generation !== this.generation) return 'failed'
      this.log(`share ${share.epoch}: the page did not show its first slide in ${Math.round(this.timing.loadMs / 1000)} s (it reached ${share.stage})`)
      await this.stop()
      return 'not_loading'
    } catch (err) {
      this.fault('a start failed', err)
      return 'failed'
    }
  }

  /** Resolves once the share's page has shown the current slide, or after loadMs. */
  private loaded(share: Share): Promise<StartOutcome> {
    if (this.state === 'loaded') return Promise.resolve('loaded')
    return new Promise(resolve => {
      const timer = setTimeout(() => done('not_loading'), this.timing.loadMs)
      timer.unref()
      const done = (outcome: StartOutcome) => {
        clearTimeout(timer)
        if (this.startWaiter === done) this.startWaiter = null
        resolve(share === this.share || outcome !== 'loaded' ? outcome : 'not_loading')
      }
      this.startWaiter = done
    })
  }

  private setView(i: number, also?: readonly number[]): number {
    const seq = ++this.seq
    this.view = { kind: 'slide', i, seq, window: this.windowOf(i, also) }
    return seq
  }

  show(i: number, also?: readonly number[]): Promise<'shown' | 'timeout'> {
    try {
      if (this.over || !Number.isInteger(i) || i < 0 || i >= this.count) return Promise.resolve('timeout')
      const seq = this.setView(i, also)
      // A show that took its place resolves now: the newer one is what counts.
      const before = this.pending
      if (before) {
        this.pending = null
        clearTimeout(before.timer)
        before.resolve('timeout')
      }
      const link = this.share?.link
      if (link) this.sendView(link)
      return new Promise(resolve => {
        const timer = setTimeout(() => this.missed(seq), this.timing.ackMs)
        timer.unref()
        this.pending = { i, seq, resolve, timer }
      })
    } catch (err) {
      this.fault('a show failed', err)
      return Promise.resolve('timeout')
    }
  }

  /**
   * A show the page did not acknowledge in time. The first in a row, with the link up: DELETE, then a new POST with a
   * new token, if our limit allows (a link that is down mends by itself). stuckAfter in a row: the share is stopped.
   */
  private missed(seq: number): void {
    try {
      const pending = this.pending
      if (!pending || pending.seq !== seq) return
      this.pending = null
      pending.resolve('timeout')
      if (this.over || this.state !== 'loaded') return
      this.misses++
      this.log(`slide ${pending.i + 1} of ${this.count} was not shown in time (${this.misses} in a row)`)
      if (this.misses >= this.timing.stuckAfter) {
        void this.stop().then(() => this.emit('stuck'))
        return
      }
      if (this.misses === 1 && this.share?.link && !this.restarting && !this.postRefusal()) void this.restart()
    } catch (err) {
      this.fault('an unacknowledged slide could not be handled', err)
    }
  }

  /** DELETE, wait for Recall, then a fresh POST with a fresh id and token. Never a second POST over a live share. */
  private async restart(): Promise<void> {
    this.restarting = true
    const generation = this.generation
    try {
      const old = this.share
      if (old) {
        this.retire(old)
        this.state = 'stopping'
        await this.deleteShare()
      }
      if (this.over || generation !== this.generation) return
      this.state = 'requested'
      const { share, status } = await this.post()
      if (this.over || generation !== this.generation || share !== this.share) {
        if (status >= 200 && status < 300 && !this.over) await this.deleteShare()
        return
      }
      if (status < 200 || status >= 300) {
        this.log(`share ${share.epoch} (a restart): ${status ? `Recall answered ${status}` : 'Recall did not answer'}`)
        this.retire(share)
        this.state = 'off'
        this.emit('failed')
        return
      }
      this.log(`share ${share.epoch} (a restart): Recall answered ${status}`)
      // The page shows the current slide when it links up; acks count as they would.
      this.state = 'loaded'
    } catch (err) {
      this.fault('a restart failed', err)
    } finally {
      this.restarting = false
    }
  }

  frame(kind: 'paused' | 'ended'): void {
    try {
      this.view = { kind: 'frame', frame: kind, seq: ++this.seq }
      const link = this.share?.link
      if (link) this.sendView(link)
    } catch (err) {
      this.fault('a frame failed', err)
    }
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.generation++
    if (this.state === 'off' && !this.share?.accepting) return Promise.resolve()
    this.stopping = (async () => {
      try {
        this.blank()
        this.state = 'stopping'
        await this.deleteShare()
      } catch (err) {
        console.error(`[slides] bot ${this.deps.botId}: stopping the share failed (${errorKind(err)})`)
      } finally {
        this.state = 'off'
        this.stopping = null
      }
    })()
    return this.stopping
  }

  close(): void {
    if (this.over) return
    this.over = true
    this.generation++
    try {
      this.blank()
    } catch {
      // Nothing more can be done for a page whose link failed.
    }
    this.state = 'off'
    const pending = this.pending
    this.pending = null
    if (pending) {
      clearTimeout(pending.timer)
      pending.resolve('timeout')
    }
    this.startWaiter?.('failed')
  }

  /** The page shows the ended frame, then its token dies and its link closes (4000: don't come back). */
  private blank(): void {
    const share = this.share
    this.view = { kind: 'frame', frame: 'ended', seq: ++this.seq }
    if (share?.link) this.sendView(share.link)
    if (share) this.retire(share)
    this.startWaiter?.('failed')
    const pending = this.pending
    if (pending) {
      this.pending = null
      clearTimeout(pending.timer)
      pending.resolve('timeout')
    }
  }

  /** A share stopped or replaced: its token opens nothing from now on, and its link is closed after what was sent. */
  private retire(share: Share): void {
    share.accepting = false
    if (share.link) {
      share.link.ws.close(LINK_CLOSE.over, 'over')
      share.link = null
    }
    if (!this.retired.includes(share)) this.retired.push(share)
    if (this.retired.length > 20) this.retired.shift()
  }

  /** DELETE with exactly {"screenshare":true}, tried again until Recall takes it (or says there is none), or the meeting is gone. */
  private async deleteShare(): Promise<void> {
    this.changedAt = this.now()
    for (let attempt = 0; ; attempt++) {
      let status = 0
      try {
        status = await this.deps.stop()
      } catch (err) {
        status = statusOf(err)
      }
      this.changedAt = this.now()
      if ((status >= 200 && status < 300) || status === 400 || status === 404) {
        this.log(`the share was stopped: Recall answered ${status}`)
        return
      }
      if (this.over) {
        this.log(`the share could not be stopped (${status ? `Recall answered ${status}` : 'Recall did not answer'}), and the bot is leaving`)
        return
      }
      const backoff = this.timing.deleteBackoffMs
      const wait = backoff[Math.min(attempt, backoff.length - 1)]
      if (attempt === 0 || attempt === backoff.length - 1) {
        this.log(`the share could not be stopped (${status ? `Recall answered ${status}` : 'Recall did not answer'}): trying again in ${Math.round(wait / 1000)} s`)
      }
      await sleep(wait)
    }
  }

  /** Someone other than the bot holds the share's address: stopped, and no more shares for this meeting. */
  private contested(): void {
    this.log('the share was contested: its link was taken over again and again, so it was stopped')
    this.disabled = true
    void this.stop().then(() => this.emit('contested'))
  }

  /**
   * The meeting's camera page dropped. Soon after a POST or a DELETE, the share may have done it (the camera page
   * reloaded): no more POSTs for this meeting, and the owner hears of it.
   */
  cameraDropped(): void {
    try {
      if (this.disabled || this.over || !this.changedAt || this.now() - this.changedAt > this.timing.cameraSuspectMs) return
      this.disabled = true
      this.log(`the camera page dropped ${this.now() - this.changedAt} ms after a share change: no more shares for this meeting`)
      this.emit('camera_suspect')
    } catch (err) {
      this.fault('a camera drop could not be handled', err)
    }
  }

  /** A fault of our own, caught: before the share was shown, it failed; after, it is stopped. Never thrown on. */
  private fault(what: string, err: unknown): void {
    console.error(`[slides] bot ${this.deps.botId}: ${what} (${errorKind(err)})`)
    try {
      if (this.over) return
      if (this.state === 'requested') {
        this.startWaiter?.('failed')
        void this.stop()
      } else if (this.state === 'loaded') {
        void this.stop()
      }
      this.emit('failed')
    } catch {
      // The share is past helping; the meeting goes on.
    }
  }

  /** For SlideShares: the page's upgrade gap, per share. */
  allowUpgrade(share: Share): boolean {
    const now = this.now()
    if (now - share.upgradedAt < this.timing.upgradeGapMs) return false
    share.upgradedAt = now
    return true
  }

  /** For SlideShares: whether this share's token is this one, in constant time. */
  static tokenIs(share: Share, token: string): boolean {
    return sameSecret(token, share.token)
  }

  static accepting(share: Share): boolean {
    return share.accepting
  }
}

/** What the routes answer with: a status, a body, a type and headers. */
export interface RouteAnswer {
  status: number
  body: string
  type: string
  headers?: Record<string, string>
}

/** The slides page as the service serves it: filled in and checked once, at start (src/slides/page.ts). */
export interface SlidesPage {
  html: string
  script: string
  problem: string
}

type Refusal = 'origin' | 'token' | 'stopping' | 'revoked' | 'too_fast'

/**
 * The public routes of every meeting's slide share: /slides (the page, with a live share's id and token), /slides.js
 * (its script) and /slides-link (its link). While no share is live anywhere, none of them is found, as any other path.
 */
export class SlideShares {
  private readonly controls = new Set<ShareControl>()
  readonly wss = new WebSocketServer({ noServer: true, maxPayload: LINK_MAX_BYTES, perMessageDeflate: false })
  private readonly origin: string
  private readonly host: string
  private refusals: Partial<Record<Refusal, number>> = {}
  private refusalsLoggedAt = -Infinity

  constructor(
    private readonly opts: {
      publicUrl: string
      page: SlidesPage
      /** Whether the service is stopping. */
      stopping: () => boolean
      timing?: Partial<ShareTiming>
      now?: () => number
    },
  ) {
    const url = URL.parse(opts.publicUrl)
    this.origin = url?.origin ?? ''
    this.host = url?.host ?? ''
  }

  /** Why the slides page can't be served, or '': a meeting can't present until it is fixed. */
  get pageProblem(): string {
    return this.opts.page.problem
  }

  /** A meeting's share, answered for by these routes until it is closed (forget). */
  create(deps: Omit<ShareDeps, 'pageUrl'>): ShareControl {
    const base = this.opts.publicUrl
    const control = new ShareControl({
      timing: this.opts.timing,
      now: this.opts.now,
      ...deps,
      pageUrl: (id, token) => `${base}${SLIDES_PAGE_PATH}?${new URLSearchParams({ s: id, t: token })}`,
    })
    this.controls.add(control)
    return control
  }

  /** The meeting is over: its share is closed (no Recall call), and these routes answer nothing more for it. */
  forget(control: ShareControl): void {
    control.close()
    this.controls.delete(control)
  }

  /** Every share is closed, and every link with it: the service is stopping or closing. */
  closeAll(): void {
    for (const control of this.controls) control.close()
    this.controls.clear()
    for (const ws of this.wss.clients) ws.terminate()
  }

  /** Whether any meeting has a live share: only then are the routes found. */
  get live(): boolean {
    for (const control of this.controls) if (control.live) return true
    return false
  }

  /** The share with this id, and its meeting's control, in any meeting: live or retired. */
  private find(id: string): { control: ShareControl; share: Share } | null {
    if (!id) return null
    let found: { control: ShareControl; share: Share } | null = null
    for (const control of this.controls) {
      const share = control.shareFor(id)
      if (share) found = { control, share }
    }
    return found
  }

  /** The page's headers: its script from here only, images from its own blobs, and its link on the public address only. */
  headers(): Record<string, string> {
    const csp = [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'unsafe-inline'",
      'img-src blob:',
      `connect-src wss://${this.host}${SLIDES_LINK_PATH}`,
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; ')
    return { 'content-security-policy': csp, 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }
  }

  /**
   * GET /slides and /slides.js, or null for any other request (and for these while no share is live): the server then
   * answers it as it always has. The page needs a live share's id and token.
   */
  request(method: string | undefined, url: URL): RouteAnswer | null {
    if (method !== 'GET' || (url.pathname !== SLIDES_PAGE_PATH && url.pathname !== SLIDES_SCRIPT_PATH)) return null
    const page = this.opts.page
    if (!this.live || page.problem || !this.host || this.opts.stopping()) return null
    if (url.pathname === SLIDES_SCRIPT_PATH) return { status: 200, body: page.script, type: 'text/javascript', headers: { 'x-content-type-options': 'nosniff' } }
    const found = this.find(url.searchParams.get('s') ?? '')
    if (!found || !ShareControl.accepting(found.share) || !ShareControl.tokenIs(found.share, url.searchParams.get('t') ?? '')) return null
    return { status: 200, body: page.html, type: 'text/html; charset=utf-8', headers: this.headers() }
  }

  /** Counts a refusal, and logs the counts by reason at most once a minute. */
  private refused(reason: Refusal): void {
    this.refusals[reason] = (this.refusals[reason] ?? 0) + 1
    const now = (this.opts.now ?? Date.now)()
    if (now - this.refusalsLoggedAt < (this.opts.timing?.refusalsLogMs ?? TIMING.refusalsLogMs)) return
    const counts = Object.entries(this.refusals).map(([why, n]) => `${n} ${why}`).join(', ')
    console.warn(`[slides] refused slide page links: ${counts}`)
    this.refusals = {}
    this.refusalsLoggedAt = now
  }

  /**
   * The upgrade of /slides-link, or false when this is not one these routes answer (then the server refuses it as an
   * unknown path: nothing is live, or it is another path). In this order: the Origin is the public address's (a filter
   * for browsers, not a control), the share exists and the token is its own (in constant time), the service is not
   * stopping, the share is not revoked, and at most one link a second for it. The newest link wins.
   */
  upgrade(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    url: URL,
    io: { handOver: () => void; refuse: (socket: Duplex, status: number, reason: string) => void },
  ): boolean {
    if (url.pathname !== SLIDES_LINK_PATH || !this.live) return false
    const refuse = (status: number, reason: string, why: Refusal) => {
      this.refused(why)
      io.refuse(socket, status, reason)
      return true
    }
    if (!this.origin || req.headers.origin !== this.origin) return refuse(403, 'forbidden', 'origin')
    const found = this.find(url.searchParams.get('s') ?? '')
    if (!found || !ShareControl.tokenIs(found.share, url.searchParams.get('t') ?? '')) return refuse(403, 'forbidden', 'token')
    if (this.opts.stopping()) return refuse(503, 'the voice service is stopping', 'stopping')
    if (!ShareControl.accepting(found.share)) return refuse(403, 'forbidden', 'revoked')
    if (!found.control.allowUpgrade(found.share)) return refuse(429, 'too many connections', 'too_fast')
    io.handOver()
    // The callback runs before any other upgrade is handled. take() listens for errors before any frame can arrive.
    this.wss.handleUpgrade(req, socket, head, ws => found.control.take(ws, found.share))
    return true
  }
}
