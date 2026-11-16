// A stand-in for Deepgram Flux on 127.0.0.1, for the flux probe's tests: it hears audio as a real stream would (a turn
// starts a little after loud audio, and ends a little after it stops), answers ForceEndTurn and CloseStream, can close a
// stream that gets no audio, and can refuse the handshake. It keeps what it was sent, with when, for the tests to check.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { performance } from 'node:perf_hooks'
import { WebSocket, WebSocketServer } from 'ws'

export interface FluxScript {
  /** The turn's transcript, from how much loud audio has come in (ms). */
  text?: (loudMs: number) => string
  /** StartOfTurn this long after the first loud audio arrives (ms). */
  startAfterMs?: number
  /** EndOfTurn (trigger model) this long after the last loud audio (ms). Infinity: only ForceEndTurn ends it. */
  endAfterQuietMs?: number
  /** False: loud audio never starts a turn (noise Flux makes no words of). */
  turns?: boolean
  /** Closes the stream (1011) once no audio has come for this long (ms). */
  idleCloseMs?: number
  /** Ignores CloseStream: the probe has to cut the stream itself. */
  ignoreClose?: boolean
  /** How long after CloseStream it closes the stream (ms). */
  closeDelayMs?: number
  /** Refuses the handshake with this status and body. */
  refuse?: { status: number; body: string; dgError?: string }
}

export type Received = { at: number; kind: 'audio'; ms: number; loud: boolean } | { at: number; kind: 'text'; msg: { type?: string } }

export interface Connection {
  url: string
  headers: http.IncomingHttpHeaders
  received: Received[]
  /** What it sent, with when. */
  sent: { at: number; msg: Record<string, unknown> }[]
  closedAt: number | null
}

const isLoud = (chunk: Buffer) => {
  for (let i = 0; i + 1 < chunk.length; i += 2) if (Math.abs(chunk.readInt16LE(i)) > 1000) return true
  return false
}

export async function fakeFlux(script: FluxScript = {}): Promise<{ origin: string; connections: Connection[]; close: () => Promise<void> }> {
  const server = http.createServer()
  const wss = new WebSocketServer({ noServer: true })
  const connections: Connection[] = []
  const sockets = new Set<WebSocket>()
  server.on('upgrade', (req, socket, head) => {
    if (script.refuse) {
      const { status, body, dgError } = script.refuse
      const extra = dgError ? `dg-error: ${dgError}\r\n` : ''
      socket.end(`HTTP/1.1 ${status} Refused\r\nContent-Type: application/json\r\n${extra}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
      connections.push({ url: req.url ?? '', headers: req.headers, received: [], sent: [], closedAt: null })
      return
    }
    wss.handleUpgrade(req, socket, head, ws => {
      const conn: Connection = { url: req.url ?? '', headers: req.headers, received: [], sent: [], closedAt: null }
      connections.push(conn)
      sockets.add(ws)
      serve(ws, conn, script)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    origin: `ws://127.0.0.1:${port}`,
    connections,
    close: async () => {
      for (const ws of sockets) ws.terminate()
      wss.close()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

function serve(ws: WebSocket, conn: Connection, script: FluxScript): void {
  const startAfter = script.startAfterMs ?? 100
  const endAfter = script.endAfterQuietMs ?? 200
  const text = script.text ?? (() => 'Mm-hmm.')
  let streamMs = 0
  let loudMs = 0
  let firstLoudAt: number | null = null
  let firstLoudStream = 0
  let lastLoudAt = 0
  let turnIndex = 0
  let turn: 'none' | 'starting' | 'open' = 'none'
  let chunks = 0
  let idleTimer: NodeJS.Timeout | null = null
  const timers: NodeJS.Timeout[] = []
  const send = (msg: Record<string, unknown>) => {
    if (ws.readyState !== WebSocket.OPEN) return
    conn.sent.push({ at: performance.now(), msg })
    ws.send(JSON.stringify(msg))
  }
  const info = (event: string, extra: Record<string, unknown> = {}) =>
    send({
      type: 'TurnInfo',
      event,
      turn_index: turnIndex,
      audio_window_start: 0,
      audio_window_end: streamMs / 1000,
      transcript: turn === 'open' || event === 'StartOfTurn' || event === 'EndOfTurn' ? text(loudMs) : '',
      words: turn === 'open' || event === 'StartOfTurn' ? [{ word: 'w', confidence: 0.9, start: firstLoudStream / 1000, end: streamMs / 1000 }] : [],
      end_of_turn_confidence: event === 'EndOfTurn' ? 0.8 : 0.1,
      ...extra,
    })
  const endTurn = (trigger: string) => {
    info('EndOfTurn', { trigger })
    turn = 'none'
    turnIndex++
    firstLoudAt = null
    loudMs = 0
  }
  const armIdle = () => {
    if (script.idleCloseMs === undefined) return
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => ws.close(1011, 'NET-0001'), script.idleCloseMs)
  }
  send({ type: 'Connected', request_id: 'fake-request', sequence_id: 0 })
  armIdle()
  ws.on('message', (data, isBinary) => {
    const at = performance.now()
    if (!isBinary) {
      const msg = JSON.parse(data.toString()) as { type?: string }
      conn.received.push({ at, kind: 'text', msg })
      if (msg.type === 'ForceEndTurn') {
        if (turn === 'open') endTurn('manual')
        else send({ type: 'Warning', code: 'FORCE_END_TURN_NO_ACTIVE_TURN', description: 'no turn' })
      } else if (msg.type === 'CloseStream' && !script.ignoreClose) {
        // Flux sends what it still has, then closes with no status (1005 at the client).
        setTimeout(() => ws.close(), script.closeDelayMs ?? 20)
      }
      return
    }
    const chunk = data as Buffer
    const ms = chunk.length / 32
    const loud = isLoud(chunk)
    conn.received.push({ at, kind: 'audio', ms, loud })
    armIdle()
    if (loud && script.turns !== false) {
      if (firstLoudAt === null) {
        firstLoudAt = at
        firstLoudStream = streamMs
        if (turn === 'none') {
          turn = 'starting'
          timers.push(setTimeout(() => {
            if (turn !== 'starting') return
            turn = 'open'
            info('StartOfTurn')
          }, startAfter))
        }
      }
      loudMs += ms
      lastLoudAt = at
    }
    streamMs += ms
    if (++chunks % 3 === 0 && turn !== 'starting') info('Update')
    if (turn === 'open' && !loud && at - lastLoudAt >= endAfter) endTurn('model')
  })
  ws.on('close', () => {
    conn.closedAt = performance.now()
    if (idleTimer) clearTimeout(idleTimer)
    for (const t of timers) clearTimeout(t)
  })
}

/** A tone at a speaking level, as PCM16 16 kHz mono: what the fake hears as speech. */
export function tone(ms: number, hz = 220): Buffer {
  const n = Math.round(ms * 16)
  const out = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / 16000) * 8000), i * 2)
  return out
}
