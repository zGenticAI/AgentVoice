// Deepgram Flux streaming speech-to-text with built-in end-of-turn detection.
// Docs: https://developers.deepgram.com/docs/flux/agent
import { EventEmitter } from 'node:events'
import type { ClientRequest, IncomingMessage } from 'node:http'
import WebSocket from 'ws'
import { config, required } from '../config.ts'

export const SAMPLE_RATE = 16000

// A stream that drops is opened again when the next audio comes in: at once, then after these waits, then every
// FLUX_SLOW_RETRY_MS for as long as audio comes in. Deepgram closes streams unexpectedly now and then (1011, 1006,
// 1005), and a fresh stream is its own advice. Nothing is tried while no audio comes, so a page that has gone
// costs nothing.
export const FLUX_RETRY_MS: readonly number[] = Object.freeze([0, 500, 1000, 2000, 5000, 10_000])
export const FLUX_SLOW_RETRY_MS = 30_000
// Hearing counts as lost once there has been no stream this long while audio came in: long enough that a blip
// doesn't show "can't hear the meeting" on the page.
export const FLUX_DEAF_AFTER_MS = 5000
// A stream that stayed open this long starts the waits again from the first. One that opens and dies again at
// once keeps backing off.
export const FLUX_STABLE_MS = 10_000
// While there is no stream, the newest 2 s of audio are kept and sent first when one opens: about one reconnect's
// worth of speech. Deepgram takes audio at most 1.25 times as fast as it plays, so more would only add lag.
export const FLUX_BACKLOG_BYTES = 64_000
// How long Deepgram has to answer a new stream's handshake before the try counts as failed.
export const FLUX_OPEN_TIMEOUT_MS = 5000
// After CloseStream, Deepgram sends what it still has, then closes the stream. It is cut if that takes longer.
export const FLUX_CLOSE_WAIT_MS = 1000
// Audio counts as coming in when some arrived this recently (the page sends a frame every 80 ms).
const AUDIO_FLOWING_MS = 1000
// A stream that drops with no audio for this long was probably closed for lack of it: no warning in the log.
const AUDIO_QUIET_MS = 2000
// Refusals that trying again cannot fix: a bad request, a wrong key, no credit left, a model the key can't use.
// Anything else (429 for too many streams at once, 5xx, a network error) is tried again.
const FINAL_STATUSES = new Set([400, 401, 402, 403, 404])
// Deepgram could not read what this client sent: a fault here, which another stream would only repeat.
const FINAL_ERROR_CODES = new Set(['UNPARSABLE_CLIENT_MESSAGE'])

/**
 * The Flux websocket address. Keyterms help Deepgram hear the assistant's name, the owner's and the
 * company's ("Alex" rather than "Ionics"). Each one is its own keyterm parameter:
 * https://developers.deepgram.com/reference/speech-to-text/listen-flux
 * mip_opt_out: without it Deepgram "stores fractional increments of data" (audio) for its Model
 * Improvement Program, and the chat notice says no recording of the meeting is kept. Opted-out audio "is retained only
 * for the duration necessary to process the request". The Console's Usage > Logs show it as true.
 * https://developers.deepgram.com/docs/the-deepgram-model-improvement-partnership-program
 */
export function fluxUrl(opts: { eotThreshold?: number; keyterms?: string[] } = {}): string {
  const params = new URLSearchParams({
    model: 'flux-general-en',
    encoding: 'linear16',
    sample_rate: String(SAMPLE_RATE),
    eot_threshold: String(opts.eotThreshold ?? 0.7),
    mip_opt_out: 'true',
  })
  for (const term of opts.keyterms ?? config.deepgramKeyterms) params.append('keyterm', term)
  return `wss://api.deepgram.com/v2/listen?${params}`
}

export type TurnEvent = 'Update' | 'StartOfTurn' | 'EagerEndOfTurn' | 'TurnResumed' | 'EndOfTurn'

export interface TurnInfo {
  type: 'TurnInfo'
  event: TurnEvent
  turn_index: number
  transcript: string
  end_of_turn_confidence?: number
  /**
   * Why an EndOfTurn came: 'model', 'manual' (ForceEndTurn) or 'timeout' from Deepgram, which may add others, or
   * 'dropped' for a turn whose stream ended before it did (FluxStream ends it with its last words).
   */
  trigger?: string
}

export interface FluxEvents {
  /** What Flux heard, as it comes, plus an EndOfTurn (trigger 'dropped') for a turn whose stream ended first. */
  turn: [TurnInfo]
  /** For the log only: the stream carries on, opening another if it must, and says 'lost' if hearing stops. */
  error: [Error]
  /** A stream opened: the first, and each one opened again after a drop. */
  open: []
  /**
   * Hearing has stopped: Deepgram refused the stream for good, or there has been no stream for FLUX_DEAF_AFTER_MS
   * while audio came in. Said once until a stream opens again. Only a refusal for good stops the tries.
   */
  lost: [why: string]
  /** Once, after close(): nothing more comes. Never for a drop, which is opened again. */
  close: [code: number, reason: string]
}

/** What FluxStream needs of a websocket: the real one is a ws WebSocket, the tests pass a fake. */
export interface FluxSocket {
  send(data: Buffer | string): void
  terminate(): void
  on(event: 'open', listener: () => void): unknown
  on(event: 'message', listener: (data: WebSocket.RawData, isBinary: boolean) => void): unknown
  on(event: 'unexpected-response', listener: (req: ClientRequest, res: IncomingMessage) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  on(event: 'close', listener: (code: number, reason: Buffer) => void): unknown
}

/** The waits and sizes above, which a test can shorten. */
export interface FluxTiming {
  retryMs: readonly number[]
  slowRetryMs: number
  deafAfterMs: number
  stableMs: number
  backlogBytes: number
  closeWaitMs: number
}

export interface FluxOptions {
  eotThreshold?: number
  keyterms?: string[]
  /** Opens a socket to Deepgram's address. By default a ws WebSocket with the key; a test passes a fake. */
  connect?: (url: string) => FluxSocket
  timing?: Partial<FluxTiming>
}

// connecting: a socket is being opened. open: it is streaming. down: no socket, and one is tried again when audio
// comes in. final: Deepgram refused for good, and nothing is tried again. closing: close() asked Deepgram to end
// the stream. closed: nothing more happens.
type State = 'connecting' | 'open' | 'down' | 'final' | 'closing' | 'closed'

/**
 * One meeting's speech recognition. It keeps a stream open for as long as audio comes in, opening another when one
 * drops, with only one socket at a time: Deepgram counts streams at once per project, and a secondary project
 * allows only one. Nothing it logs holds what was said, the address or the key: only states, codes, statuses and
 * Deepgram's own error text.
 */
export class FluxStream extends EventEmitter<FluxEvents> {
  private readonly url: string
  private readonly connect: (url: string) => FluxSocket
  private readonly timing: FluxTiming
  private state: State = 'connecting'
  // The one socket the stream listens to. Events from any other (one it gave up on) are ignored.
  private ws: FluxSocket | null = null
  // The newest audio that came in while there was no stream, at most timing.backlogBytes of it.
  private backlog: Buffer[] = []
  private backlogBytes = 0
  // Tries since a stream last stayed open: which wait comes next.
  private tries = 0
  private retryTimer: NodeJS.Timeout | null = null
  private deafTimer: NodeJS.Timeout | null = null
  private closeTimer: NodeJS.Timeout | null = null
  private lostSaid = false
  private closeSaid = false
  private openedAt = 0
  private audioAt = -Infinity
  // The turn someone is in the middle of, with its words so far: in memory only, never logged.
  private turn: { index: number; text: string } | null = null

  constructor(opts: FluxOptions = {}) {
    super()
    // Read here, so a key that is not set stops the meeting's session from starting.
    const key = required('DEEPGRAM_API_KEY')
    this.url = fluxUrl(opts)
    this.timing = {
      retryMs: FLUX_RETRY_MS,
      slowRetryMs: FLUX_SLOW_RETRY_MS,
      deafAfterMs: FLUX_DEAF_AFTER_MS,
      stableMs: FLUX_STABLE_MS,
      backlogBytes: FLUX_BACKLOG_BYTES,
      closeWaitMs: FLUX_CLOSE_WAIT_MS,
      ...opts.timing,
    }
    this.connect =
      opts.connect ??
      (url => new WebSocket(url, { headers: { Authorization: `Token ${key}` }, handshakeTimeout: FLUX_OPEN_TIMEOUT_MS }))
    this.dial()
  }

  /** Raw 16 kHz mono PCM16 little-endian audio, ideally in ~80 ms chunks. */
  send(chunk: Buffer): void {
    // Deepgram refuses audio after CloseStream, and the page keeps sending until the bot drops.
    if (this.state === 'closing' || this.state === 'closed' || this.state === 'final') return
    this.audioAt = Date.now()
    if (this.state === 'open') return this.ws?.send(chunk)
    // Whole chunks, so the samples stay aligned.
    this.backlog.push(chunk)
    this.backlogBytes += chunk.length
    while (this.backlogBytes > this.timing.backlogBytes) this.backlogBytes -= this.backlog.shift()!.length
    if (this.state === 'down' && !this.retryTimer) this.retryLater()
    this.deafTimer ??= setTimeout(() => this.checkHearing(), this.timing.deafAfterMs).unref()
  }

  /**
   * Ends the turn someone is in the middle of on the words heard so far: its EndOfTurn (trigger 'manual') comes as
   * usual. Nothing is sent without an open stream and a turn in progress.
   */
  forceEndTurn(): void {
    if (this.state === 'open' && this.turn) this.ws?.send(JSON.stringify({ type: 'ForceEndTurn' }))
  }

  /**
   * Ends speech recognition for good: nothing more of the meeting is sent, not even audio kept while there was no
   * stream, and nothing is tried again. 'close' follows once, after this call has returned. Calling it again does
   * nothing.
   */
  close(): void {
    const { state, ws } = this
    if (state === 'closing' || state === 'closed') return
    this.stopTimers()
    this.dropBacklog()
    if (state === 'open' && ws) {
      this.state = 'closing'
      // CloseStream alone drops the turn in progress. ForceEndTurn ends it on the words heard so far, and Deepgram
      // answers in order, so its EndOfTurn comes before the stream closes: the last words of a meeting are kept.
      if (this.turn) ws.send(JSON.stringify({ type: 'ForceEndTurn' }))
      ws.send(JSON.stringify({ type: 'CloseStream' }))
      this.closeTimer = setTimeout(() => {
        if (this.state !== 'closing') return
        this.ws = null
        ws.terminate()
        this.endTurn()
        this.closed(1006, '')
      }, this.timing.closeWaitMs).unref()
      return
    }
    this.state = 'closed'
    // A socket still being opened is given up on: nothing has been said on it.
    if (ws) {
      this.ws = null
      ws.terminate()
    }
    setImmediate(() => this.closed(1000, ''))
  }

  private dial(): void {
    const ws = this.connect(this.url)
    this.ws = ws
    this.state = 'connecting'
    // Set once Deepgram has refused the handshake: refused() deals with that socket from then on.
    let refusal = false
    const current = () => ws === this.ws && !refusal
    ws.on('open', () => {
      if (current()) this.opened(ws)
    })
    ws.on('message', (data, isBinary) => {
      if (current() && !isBinary) this.message(ws, data)
    })
    ws.on('error', err => {
      if (current()) this.emit('error', err)
    })
    ws.on('close', (code, reason) => {
      if (current()) this.dropped(code, String(reason))
    })
    // Deepgram refuses a stream (a wrong key, no credit, too many streams at once) by answering the handshake.
    ws.on('unexpected-response', (_req, res) => {
      if (!current()) return
      refusal = true
      this.refused(ws, res)
    })
  }

  private opened(ws: FluxSocket): void {
    this.state = 'open'
    this.openedAt = Date.now()
    console.log('[stt] connected to Deepgram')
    for (const chunk of this.backlog) ws.send(chunk)
    this.dropBacklog()
    if (this.deafTimer) clearTimeout(this.deafTimer)
    this.deafTimer = null
    this.lostSaid = false
    this.emit('open')
  }

  private message(ws: FluxSocket, data: WebSocket.RawData): void {
    let msg: { type?: unknown; code?: unknown; description?: unknown } | null
    try {
      msg = JSON.parse(data.toString())
    } catch {
      // Not the message itself in the log: it could hold what was said.
      return void this.emit('error', new Error('Deepgram sent a message that is not JSON'))
    }
    if (msg?.type === 'TurnInfo') return this.turnInfo(msg as TurnInfo)
    // Connected, Warning and Configure* change nothing here.
    if (msg?.type !== 'Error') return
    const code = typeof msg.code === 'string' ? msg.code : 'no code'
    const description = typeof msg.description === 'string' ? msg.description : 'an error'
    this.emit('error', new Error(`Deepgram: ${description} (${code})`))
    // While closing, the close goes on. Otherwise the stream is over: Deepgram closes it after an Error.
    if (ws !== this.ws || this.state !== 'open') return
    const final = FINAL_ERROR_CODES.has(code)
    this.gone(final ? 'final' : 'down')
    ws.terminate()
    if (final) this.fail(`Deepgram: ${code}`)
  }

  private turnInfo(turn: TurnInfo): void {
    if (turn.event === 'StartOfTurn') this.turn = { index: turn.turn_index, text: turn.transcript }
    else if (turn.event === 'EndOfTurn') this.turn = null
    // An Update outside a turn (Flux sends them with no words between turns) starts nothing.
    else if (this.turn) this.turn.text = turn.transcript
    this.emit('turn', turn)
  }

  /**
   * Reads why Deepgram refused the stream (at most 300 characters of its answer), then lets the socket go: ws would
   * otherwise wait on the handshake for ever, and the audio kept for it would grow.
   */
  private refused(ws: FluxSocket, res: IncomingMessage): void {
    const status = res.statusCode ?? 0
    let body = ''
    let done = false
    const finish = () => {
      if (done) return
      done = true
      ws.terminate()
      // close() has already let it go.
      if (ws !== this.ws) return
      this.gone(FINAL_STATUSES.has(status) ? 'final' : 'down')
      this.emit('error', new Error(`Deepgram refused the connection (${status})${body ? `: ${body.slice(0, 300)}` : ''}`))
      if (this.state === 'final') this.fail(`Deepgram refused the connection (${status})`)
    }
    res.on('data', (chunk: Buffer) => {
      body += chunk
      if (body.length >= 300) finish()
    })
    res.on('end', finish)
    res.on('error', finish)
    res.on('close', finish)
    // The handshake timed out while the answer was still coming.
    ws.on('close', finish)
  }

  /** The current socket closed. */
  private dropped(code: number, reason: string): void {
    const why = `${code}${reason ? `: ${reason}` : ''}`
    if (this.state === 'closing') {
      this.ws = null
      this.endTurn()
      return this.closed(code, reason)
    }
    // A try that never opened has already said why, as an 'error'.
    if (this.state === 'open') {
      const line = `[stt] Deepgram dropped the stream (${why})`
      if (Date.now() - this.audioAt >= AUDIO_QUIET_MS) console.log(line)
      else console.warn(line)
    }
    this.gone('down')
  }

  /** The current socket has closed or been let go: the stream is down until another opens, or over for good. */
  private gone(next: 'down' | 'final'): void {
    if (this.state === 'open' && Date.now() - this.openedAt >= this.timing.stableMs) this.tries = 0
    this.ws = null
    this.state = next
    if (next === 'final') {
      this.stopTimers()
      this.dropBacklog()
    }
    this.endTurn()
  }

  /**
   * A turn cut off by its stream ending never gets its EndOfTurn: it ends here, on its last words, so a question or
   * "please leave" said just before a drop is still heard.
   */
  private endTurn(): void {
    const turn = this.turn
    if (!turn) return
    this.turn = null
    this.emit('turn', { type: 'TurnInfo', event: 'EndOfTurn', turn_index: turn.index, transcript: turn.text, trigger: 'dropped' })
  }

  private retryLater(): void {
    const { retryMs, slowRetryMs } = this.timing
    const wait = this.tries < retryMs.length ? retryMs[this.tries] : slowRetryMs
    this.tries++
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.state !== 'down') return
      try {
        this.dial()
      } catch (err) {
        this.emit('error', err as Error)
      }
    }, wait).unref()
  }

  private checkHearing(): void {
    this.deafTimer = null
    if (this.state !== 'connecting' && this.state !== 'down') return
    // Only while audio comes in: with the page away, there is nothing to miss.
    if (Date.now() - this.audioAt <= AUDIO_FLOWING_MS) this.fail(`no stream to Deepgram for ${this.timing.deafAfterMs / 1000} s`)
  }

  private fail(why: string): void {
    if (this.lostSaid || this.state === 'closing' || this.state === 'closed') return
    this.lostSaid = true
    this.emit('lost', why)
  }

  private closed(code: number, reason: string): void {
    if (this.closeTimer) clearTimeout(this.closeTimer)
    this.closeTimer = null
    this.state = 'closed'
    if (this.closeSaid) return
    this.closeSaid = true
    this.emit('close', code, reason)
  }

  private stopTimers(): void {
    for (const timer of [this.retryTimer, this.deafTimer]) if (timer) clearTimeout(timer)
    this.retryTimer = null
    this.deafTimer = null
  }

  private dropBacklog(): void {
    this.backlog = []
    this.backlogBytes = 0
  }
}
