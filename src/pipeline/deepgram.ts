// Deepgram Flux streaming speech-to-text with built-in end-of-turn detection.
// Docs: https://developers.deepgram.com/docs/flux/agent
import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { config, required } from '../config.ts'

export const SAMPLE_RATE = 16000

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
}

export interface FluxEvents {
  turn: [TurnInfo]
  error: [Error]
  close: [code: number, reason: string]
}

export class FluxStream extends EventEmitter<FluxEvents> {
  private ws: WebSocket
  private pending: Buffer[] = []
  private open = false
  private closing = false

  constructor(opts: { eotThreshold?: number; keyterms?: string[] } = {}) {
    super()
    this.ws = new WebSocket(fluxUrl(opts), {
      headers: { Authorization: `Token ${required('DEEPGRAM_API_KEY')}` },
    })
    this.ws.on('open', () => {
      console.log('[stt] connected to Deepgram')
      this.open = true
      for (const chunk of this.pending) this.ws.send(chunk)
      this.pending = []
    })
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) return
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'TurnInfo') this.emit('turn', msg as TurnInfo)
        else if (msg.type === 'Error') this.emit('error', new Error(`Deepgram: ${msg.description ?? data}`))
      } catch (err) {
        this.emit('error', err as Error)
      }
    })
    // A refused connection (wrong key, no credit) shows up here with Deepgram's explanation.
    this.ws.on('unexpected-response', (_req, res) => {
      let body = ''
      res.on('data', (c: Buffer) => (body += c))
      res.on('end', () => this.emit('error', new Error(`Deepgram refused the connection (${res.statusCode}): ${body.slice(0, 300)}`)))
    })
    this.ws.on('error', err => this.emit('error', err))
    this.ws.on('close', (code, reason) => {
      this.open = false
      this.emit('close', code, reason.toString())
    })
  }

  /** Raw 16 kHz mono PCM16 little-endian audio, ideally in ~80 ms chunks. */
  send(chunk: Buffer): void {
    // Deepgram refuses audio after CloseStream, and the page keeps sending until the bot drops.
    if (this.closing) return
    if (this.open) this.ws.send(chunk)
    else if (this.ws.readyState === WebSocket.CONNECTING) this.pending.push(chunk)
  }

  close(): void {
    this.closing = true
    if (this.open) this.ws.send(JSON.stringify({ type: 'CloseStream' }))
    setTimeout(() => this.ws.terminate(), 1000).unref()
  }
}
