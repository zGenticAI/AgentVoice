// Recall's live participant events for one meeting with the speaker probe: the per-meeting token its connection has to
// bring, and the one connection that may feed the meeting's probe. The server checks an upgrade (src/server.ts) and
// hands the connection here. The newest connection wins (Recall tries again 30 times, 3 s apart, then gives up for good,
// so a new one must always get in), and what arrives on one it replaced is ignored. A ping every 30 s keeps an idle
// tunnel open, and a connection heard from neither way for 60 s is cut off, for Recall to open another. Each connection
// takes at most 100 messages a second (the rest are dropped and counted, before they are read). The log has the bot's
// id, connection states and codes only: never a name, a count of participants, a message, the URL or the token.
import WebSocket from 'ws'
import { parseParticipantEvent } from './events.ts'
import type { SpeakerProbe } from './probe.ts'

export const RECALL_PING_MS = 30_000
export const RECALL_SILENCE_MS = 60_000
export const RECALL_MESSAGES_PER_SECOND = 100
/** The most one message from Recall may hold: a participant event is well under 2 KB. */
export const MAX_RECALL_MESSAGE_BYTES = 64 * 1024

export interface RecallEventsTiming {
  pingMs: number
  silenceMs: number
  perSecond: number
}

/** What the server keeps of a meeting's participant events, on its meeting. */
export class RecallEvents {
  readonly token: string
  readonly probe: SpeakerProbe
  /** When a connection was last let in (epoch ms): the server lets in at most one a second. */
  lastAcceptedAt = 0
  private readonly botId: string
  private readonly timing: RecallEventsTiming
  private socket: WebSocket | null = null
  private stopped = false

  constructor(o: { botId: string; token: string; probe: SpeakerProbe; timing?: Partial<RecallEventsTiming> }) {
    this.botId = o.botId
    this.token = o.token
    this.probe = o.probe
    this.timing = { pingMs: RECALL_PING_MS, silenceMs: RECALL_SILENCE_MS, perSecond: RECALL_MESSAGES_PER_SECOND, ...o.timing }
  }

  /** The connection that feeds the probe now, if any. */
  get current(): WebSocket | null {
    return this.socket
  }

  /** A connection Recall opened, which the server has let in: it takes the place of any before it. */
  take(ws: WebSocket): void {
    const { botId, probe } = this
    // First, before any frame: an error nothing listens to (a message over MAX_RECALL_MESSAGE_BYTES) would take the
    // service down, and every meeting with it. Its code only: never what it was about.
    ws.on('error', err => {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') probe.dropped('too_big')
      console.warn(`[events] bot ${botId}: Recall's connection failed (${typeof code === 'string' ? code : 'error'})`)
    })
    if (this.stopped) return ws.close(1000, 'over')
    const old = this.socket
    this.socket = ws
    probe.connected(old !== null)
    // Let go at once: Recall has moved to the new one, and anything still arriving on the old one is ignored below.
    old?.terminate()
    console.log(`[events] bot ${botId}: Recall connected its participant events${old ? ', replacing an earlier connection' : ''}`)

    let heard = Date.now()
    let second = 0
    let inSecond = 0
    ws.on('pong', () => void (heard = Date.now()))
    ws.on('message', (data, isBinary) => {
      // A connection that was replaced, or a message after the meeting is over: nothing of it counts.
      if (this.socket !== ws || !probe.accepting) return
      const now = Date.now()
      heard = now
      // A fixed window, checked before the message is read.
      if (Math.floor(now / 1000) !== second) {
        second = Math.floor(now / 1000)
        inSecond = 0
      }
      if (++inSecond > this.timing.perSecond) return probe.dropped('rate')
      if (isBinary) return probe.dropped('binary')
      const parsed = parseParticipantEvent(data as Buffer)
      if ('dropped' in parsed) return probe.dropped(parsed.dropped)
      // Another bot's events, sent here by mistake or on purpose, say nothing about this meeting.
      if (parsed.event.botId !== botId) return probe.dropped('wrong_bot')
      probe.event(parsed.event, now)
    })
    const beat = setInterval(() => {
      if (Date.now() - heard > this.timing.silenceMs) {
        probe.pingTimeout()
        console.warn(`[events] bot ${botId}: Recall's connection went silent, so it is dropped (Recall opens another)`)
        return ws.terminate()
      }
      if (ws.readyState === WebSocket.OPEN) ws.ping()
    }, this.timing.pingMs)
    beat.unref()
    ws.once('close', code => {
      clearInterval(beat)
      if (this.socket === ws) this.socket = null
      probe.closed(code)
      console.log(`[events] bot ${botId}: Recall's connection closed (${code})`)
    })
  }

  /**
   * The meeting is over for its events (its bot is leaving, its session is over, or its bot is out): the connection is
   * closed, Recall's later tries are refused, and what the probe measured waits for its session to write it.
   */
  stop(): void {
    this.stopped = true
    this.probe.stopEvents()
    this.socket?.close(1000, 'over')
  }

  /** Cuts the connection at once: the meeting's record is gone ("please leave", a removal), or the service closes. */
  terminate(): void {
    this.stopped = true
    this.probe.stopEvents()
    this.socket?.terminate()
  }
}
