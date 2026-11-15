// The types of public/agent.js, which the bot page loads as it is. For the tests, which import it under tsc: the
// service doesn't serve this file.

/** The assistant's voice on the bot page (see createPlayer in agent.js). */
export interface Player {
  /** A piece of the voice arrived: PCM16, 16 kHz, mono. */
  play(pcm: ArrayBuffer): void
  /** Stops where it is, and holds the rest and whatever arrives, until resume or clear. Again: nothing. */
  pause(): void
  /** Plays what it held, back to back, 50 ms from now. Not paused: nothing. */
  resume(): void
  /**
   * Drops everything not yet played, and what it held: a clear ends a pause. Returns how much it dropped, in bytes of
   * PCM16 (32 a millisecond).
   */
  clear(): number
  readonly paused: boolean
}

/** A connection, as createLink uses it: the browser's WebSocket, or a test's. */
export interface LinkSocket {
  binaryType: string
  readonly readyState: number
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number }) => void) | null
  send(data: ArrayBufferLike | ArrayBufferView): void
  close(): void
}

/** What a test swaps in for the browser's (createLink). */
export interface LinkEnv {
  WebSocket?: new (url: string) => LinkSocket
  /** Milliseconds, from any start. */
  now?: () => number
  setTimeout?: (run: () => void, ms: number) => unknown
  clearTimeout?: (timer: unknown) => void
  random?: () => number
}

/** A message from the service other than audio and the heartbeat. */
export interface Control {
  type: string
  [field: string]: unknown
}

export interface Link {
  /** Sends a frame of the meeting's audio: false, and dropped, while the link is not ready. */
  send(frame: ArrayBufferLike | ArrayBufferView): boolean
  /** The page threw away this many bytes of the voice it had, unplayed: the next try's got leaves them out. */
  discard(bytes: number): void
  /** Closes the link for good, and says nothing more. */
  close(): void
}

/** A connection that has said nothing for this long (ms) since 'ready' is taken as dead. */
export const PAGE_SILENCE_MS: number
/** A try that hasn't said 'ready' by then (ms) is given up on. */
export const CONNECT_TIMEOUT_MS: number
/** The wait before each try after the link is lost (ms), the last one again and again, with equal jitter. */
export const RETRY_MS: readonly number[]
/** The page stops trying this long after the link was lost (ms). */
export const GIVE_UP_MS: number
/** The close codes that mean don't come back: 4000 (the meeting's session is over) and 4003 (it could not start). */
export const FINAL_CODES: ReadonlySet<number>

/** Streams the meeting's audio to the service and plays the assistant's voice. Resolves with a function that stops both. */
export function startAgent(options: {
  onState?: (state: string) => void
  onOutput?: (output: AnalyserNode) => void
}): Promise<() => void>

/**
 * Joins the link to the player, and tells onState what the page is doing: 'speaking', 'reconnecting', 'disconnected',
 * 'error: <the service's fixed words>' or 'listening', in that order of precedence.
 */
export function connectVoice(
  url: string,
  options: { ctx: BaseAudioContext; output: AudioNode; onState?: (state: string) => void },
  env?: LinkEnv,
): { send(frame: Int16Array): boolean; close(): void }

/**
 * The page's link to the service, at url (/audio with the key and the token): one connection at a time, opened again
 * when it drops, with n, and rejoin and got once the service has said 'ready'. onState: 'reconnecting' or
 * 'disconnected'.
 */
export function createLink(
  url: string,
  handlers: {
    onAudio: (data: ArrayBuffer) => void
    onControl: (msg: Control) => void
    onState: (state: 'reconnecting' | 'disconnected') => void
  },
  env?: LinkEnv,
): Link

/** The wait before try `tries` after the link was lost (ms; 0 is the first): between half and all of RETRY_MS's. */
export function retryDelay(tries: number, random?: () => number): number

/** Turns the capture worklet's blocks of samples into frames of 1280 PCM16 samples, each given to send once full. */
export function createFramer(send: (frame: Int16Array) => void): (samples: Float32Array) => void

/** Plays the voice on ctx through output. onChange(true) as a piece is scheduled, onChange(false) once none plays. */
export function createPlayer(ctx: BaseAudioContext, output: AudioNode, onChange: (speaking: boolean) => void): Player
