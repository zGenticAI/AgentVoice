// Streams one clip of npm run flux-probe to Deepgram Flux the way the service does (the same address and key header,
// 80 ms chunks in real time) and keeps every message Flux sends, with when it came. It talks to the websocket itself,
// not through FluxStream, which hides the raw events. The connect seam lets the tests use a fake server.
import type { ClientRequest, IncomingMessage } from 'node:http'
import { performance } from 'node:perf_hooks'
import WebSocket from 'ws'
import { FLUX_OPEN_TIMEOUT_MS, fluxHeaders } from '../pipeline/deepgram.ts'
import { BYTES_PER_MS, CHUNK_MS, chunks, msOf, silence } from './flux-audio.ts'

/** What the probe needs of a websocket: a ws WebSocket, or a test's. */
export interface ProbeSocket {
  send(data: Buffer | string): void
  terminate(): void
  on(event: 'open', listener: () => void): unknown
  on(event: 'message', listener: (data: WebSocket.RawData, isBinary: boolean) => void): unknown
  on(event: 'unexpected-response', listener: (req: ClientRequest, res: IncomingMessage) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  on(event: 'close', listener: (code: number, reason: Buffer) => void): unknown
}

export type Connect = (url: string, headers: Record<string, string>) => ProbeSocket

/** A real socket to Deepgram, opened as FluxStream opens one. */
export const connectFlux: Connect = (url, headers) => new WebSocket(url, { headers, handshakeTimeout: FLUX_OPEN_TIMEOUT_MS })

/** The waits around each clip (ms). The tests shorten them. */
export interface StreamTiming {
  /** Silence before the clip, so Flux has settled and any Update it sends for nothing shows. */
  leadMs: number
  /** After the clip, silence goes on until the turn has ended, or this long. Flux's own timeout is 5 s. */
  tailMaxMs: number
  /** At least this much silence after the clip, so a turn the clip's last sound starts is not missed. */
  minTailMs: number
  /** How long Deepgram has to close the stream after CloseStream before the probe cuts it. */
  closeWaitMs: number
  /** How long Deepgram has to accept the stream. */
  openTimeoutMs: number
}

export const STREAM_TIMING: StreamTiming = Object.freeze({
  leadMs: 500,
  tailMaxMs: 7000,
  minTailMs: 1000,
  closeWaitMs: 5000,
  openTimeoutMs: FLUX_OPEN_TIMEOUT_MS + 1000,
})

export interface StreamOptions {
  url: string
  key: string
  /** The clip: 16 kHz mono PCM16. */
  audio: Buffer
  connect?: Connect
  timing?: Partial<StreamTiming>
  /**
   * The force checks: ForceEndTurn this long after the first StartOfTurn arrives (or as the clip ends, when none came),
   * with CloseStream straight after it when `close`, and then no more audio.
   */
  force?: { afterStartMs: number; close: boolean }
  /** The idle check: only the first audioMs of the clip go, then nothing at all until Flux closes, or maxMs pass. */
  idle?: { audioMs: number; maxMs: number }
}

/** One message from Flux: t is ms from when the clip's audio began (negative during the lead silence). */
export interface ProbeEvent {
  t: number
  msg: Record<string, unknown>
}

export interface StreamRun {
  /** Whether Deepgram accepted the stream. */
  opened: boolean
  /** How long the clip is (ms): t = clipMs is where its audio ends. For the idle check, the part sent. */
  clipMs: number
  events: ProbeEvent[]
  /** When the last audio went out (t), silence included; null when none did. */
  lastAudioT: number | null
  /** All the audio sent (ms), silence included: what Deepgram bills. */
  audioMs: number
  forceT?: number
  /** ForceEndTurn went as the clip ended, since no StartOfTurn had come. */
  forceNoTurn?: boolean
  closeStreamT?: number
  /** How the stream closed: by Deepgram ('server'), or cut by the probe once its wait ran out ('probe'). */
  close?: { t: number; code: number; reason: string; by: 'server' | 'probe' }
  /** The idle check only: still open this long after the last audio, when its wait ran out. */
  stillOpenAfterMs?: number
  /** Deepgram refused the handshake: its status, and its short error text. */
  refused?: { status: number; text: string }
  error?: string
  /** The most any chunk went out after its time (ms): the run's pacing, never ahead of real time. */
  lateMs: number
}

/**
 * Deepgram's short reason for refusing a stream, from its JSON answer ({"err_code":..,"err_msg":..}) or its dg-error
 * header: never the rest of the answer.
 */
export function refusalText(body: string, header?: string | string[]): string {
  let text = ''
  try {
    const answer = JSON.parse(body) as { err_code?: unknown; err_msg?: unknown }
    text = [answer.err_code, answer.err_msg].filter(v => typeof v === 'string' && v).join(': ')
  } catch {
    // Not JSON: the header, if any, says it.
  }
  if (!text && header) text = Array.isArray(header) ? header.join(' ') : header
  return text.replace(/\s+/g, ' ').trim().slice(0, 160)
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, Math.max(0, ms)))

/** Waits for the promise, or ms at most, and leaves no timer behind: one would keep the CLI from exiting. */
function within(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const wait = new Promise<void>(resolve => (timer = setTimeout(resolve, Math.max(0, ms))))
  return Promise.race([promise, wait]).finally(() => clearTimeout(timer))
}

/**
 * Streams one clip and records what Flux says. The lead silence, then the clip, then silence until the turn has ended
 * (or tailMaxMs), then CloseStream: each 80 ms chunk goes once its 80 ms have passed, as a live page sends it, so the
 * audio never goes faster than real time (Deepgram takes at most 1.25 times). Never throws: what went wrong is in the run.
 */
export async function streamClip(opts: StreamOptions): Promise<StreamRun> {
  const timing = { ...STREAM_TIMING, ...opts.timing }
  const idle = opts.idle
  const clip = idle ? opts.audio.subarray(0, Math.round(idle.audioMs * BYTES_PER_MS) & ~1) : opts.audio
  const run: StreamRun = { opened: false, clipMs: msOf(clip), events: [], lastAudioT: null, audioMs: 0, lateMs: 0 }
  // Times are kept as performance.now() until the end, then made relative to where the clip's audio begins.
  const got: { at: number; msg: Record<string, unknown> }[] = []
  // Set from the socket's callbacks: the casts keep TypeScript from taking them as never changing.
  let start = 0
  let lastAudioAt = null as number | null
  let forceAt = null as number | null
  let closeStreamAt = null as number | null
  let closed = null as { at: number; code: number; reason: string; by: 'server' | 'probe' } | null
  let cutByProbe = false as boolean
  let stopAudio = false as boolean
  let turnOpen = false as boolean
  let turnEnded = false as boolean
  let forceTimer = null as NodeJS.Timeout | null
  let ws: ProbeSocket
  try {
    ws = (opts.connect ?? connectFlux)(opts.url, fluxHeaders(opts.key))
  } catch (err) {
    run.error = (err as Error).message
    return run
  }
  const cut = () => {
    cutByProbe = true
    ws.terminate()
  }
  const force = () => {
    if (forceAt !== null || closed) return
    ws.send(JSON.stringify({ type: 'ForceEndTurn' }))
    forceAt = performance.now()
    if (!opts.force?.close) return
    ws.send(JSON.stringify({ type: 'CloseStream' }))
    closeStreamAt = forceAt
    // Deepgram takes no audio after CloseStream.
    stopAudio = true
  }

  let settle: (outcome: 'open' | 'failed') => void = () => {}
  const opened = new Promise<'open' | 'failed'>(resolve => (settle = resolve))
  let onClose: () => void = () => {}
  const closedPromise = new Promise<void>(resolve => (onClose = resolve))
  ws.on('open', () => settle('open'))
  ws.on('error', err => {
    // Once the probe has cut the socket (a refusal, a wait run out), ws's own complaint about it says nothing new.
    if (!cutByProbe) run.error ??= err.message
    settle('failed')
  })
  ws.on('unexpected-response', (_req, res) => {
    let body = ''
    const done = () => {
      if (run.refused) return
      run.refused = { status: res.statusCode ?? 0, text: refusalText(body, res.headers['dg-error']) }
      cut()
      settle('failed')
    }
    res.on('data', (piece: Buffer) => {
      body += piece
      if (body.length > 2000) done()
    })
    res.on('end', done)
    res.on('error', done)
    res.on('close', done)
  })
  ws.on('close', (code, reason) => {
    closed ??= { at: performance.now(), code, reason: String(reason), by: cutByProbe ? 'probe' : 'server' }
    settle('failed')
    onClose()
  })
  ws.on('message', (data, isBinary) => {
    const at = performance.now()
    let msg: Record<string, unknown>
    if (isBinary) msg = { type: '(binary)', bytes: (data as Buffer).length }
    else {
      try {
        const parsed: unknown = JSON.parse(data.toString())
        msg = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : { type: '(not an object)' }
      } catch {
        msg = { type: '(not JSON)', bytes: data.toString().length }
      }
    }
    got.push({ at, msg })
    if (msg.type !== 'TurnInfo') return
    if (msg.event === 'StartOfTurn') {
      turnOpen = true
      if (opts.force && forceAt === null && !forceTimer) forceTimer = setTimeout(force, opts.force.afterStartMs)
    } else if (msg.event === 'EndOfTurn') {
      turnOpen = false
      turnEnded = true
    }
  })

  const openTimer = setTimeout(() => {
    run.error ??= `no answer from Deepgram within ${timing.openTimeoutMs / 1000} s`
    cut()
    settle('failed')
  }, timing.openTimeoutMs)
  const outcome = await opened
  clearTimeout(openTimer)
  if (outcome !== 'open') {
    // A refusal's socket is cut as soon as its answer is read; wait for that, so nothing is left open.
    if (!closed) await within(closedPromise, 1000)
    return run
  }

  run.opened = true
  start = performance.now()
  let offset = 0 // ms of audio sent so far: the next chunk is due when this much more time has passed
  const send = async (piece: Buffer): Promise<boolean> => {
    const due = start + offset + msOf(piece)
    await sleep(due - performance.now())
    run.lateMs = Math.max(run.lateMs, Math.round(performance.now() - due))
    if (stopAudio || closed) return false
    ws.send(piece)
    offset += msOf(piece)
    run.audioMs += msOf(piece)
    lastAudioAt = performance.now()
    return true
  }

  const audio = [...chunks(silence(timing.leadMs)), ...chunks(clip)]
  for (const piece of audio) if (!(await send(piece))) break
  if (opts.force && !stopAudio && !closed && forceAt === null && !forceTimer) {
    // No StartOfTurn during the clip: the commands still go, to see what Flux does with them. (One that came late in
    // the clip has its timer running: the silence after the clip goes on until it fires.)
    run.forceNoTurn = true
    force()
  }

  if (idle) {
    // Nothing more at all: when, and how, does Flux close a stream that gets no audio?
    const until = (lastAudioAt ?? performance.now()) + idle.maxMs
    await within(closedPromise, until - performance.now())
    if (!closed) run.stillOpenAfterMs = Math.round(performance.now() - (lastAudioAt ?? start))
  } else {
    const tail = silence(CHUNK_MS)
    const clipEnd = timing.leadMs + run.clipMs
    while (!stopAudio && !closed) {
      const after = offset - clipEnd
      if (after >= timing.tailMaxMs) break
      if (turnEnded && !turnOpen && after >= timing.minTailMs) break
      if (!(await send(tail))) break
    }
  }

  if (!closed) {
    if (closeStreamAt === null) {
      ws.send(JSON.stringify({ type: 'CloseStream' }))
      closeStreamAt = performance.now()
    }
    await within(closedPromise, closeStreamAt + timing.closeWaitMs - performance.now())
    if (!closed) {
      cut()
      await within(closedPromise, 1000)
    }
  }
  if (forceTimer) clearTimeout(forceTimer)

  const origin = start + timing.leadMs
  const t = (at: number) => Math.round(at - origin)
  run.events = got.map(e => ({ t: t(e.at), msg: e.msg }))
  if (lastAudioAt !== null) run.lastAudioT = t(lastAudioAt)
  if (forceAt !== null) run.forceT = t(forceAt)
  if (closeStreamAt !== null) run.closeStreamT = t(closeStreamAt)
  if (closed) run.close = { t: t(closed.at), code: closed.code, reason: closed.reason, by: closed.by }
  return run
}
