// The types of public/slides.js, which the bot's browser loads as it is. For the tests, which import it under tsc: the
// service serves only the .js file.

/** What the page shows: decodes a slide into the hidden image, swaps it in, or shows a frame instead of the slides. */
export interface SlidesView {
  /** Loads and decodes the image at this URL into the hidden image. Rejects when it can't be decoded. */
  load(url: string): Promise<void>
  /** Shows the image just loaded, and hides the other one and every frame. */
  swap(): void
  /** Shows a frame (no slide content, only who presents and that it is an AI), and hides the images. */
  frame(kind: 'starting' | 'paused' | 'ended'): void
  /** Drops both images. */
  clear(): void
  /** The page's numbers for the service's log, sent once: no content. */
  diag(): { w: number; h: number; dpr: number; visibility: string; ua_major: number }
}

/** A connection, as createSlides uses it: the browser's WebSocket, or a test's. */
export interface SlidesSocket {
  binaryType: string
  readonly readyState: number
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number }) => void) | null
  send(data: string): void
  close(): void
}

/** What a test swaps in for the browser's (createSlides). */
export interface SlidesEnv {
  WebSocket?: new (url: string) => SlidesSocket
  Blob?: typeof Blob
  createObjectURL?: (blob: Blob) => string
  revokeObjectURL?: (url: string) => void
  now?: () => number
  setTimeout?: (run: () => void, ms: number) => unknown
  clearTimeout?: (timer: unknown) => void
  random?: () => number
}

export const SILENCE_MS: number
export const CONNECT_TIMEOUT_MS: number
export const RETRY_MS: readonly number[]
export const BLANK_AFTER_MS: number
export const GIVE_UP_MS: number
export const FINAL_CODES: ReadonlySet<number>
export function retryDelay(tries: number, random?: () => number): number
export function createSlides(url: string, view: SlidesView, env?: SlidesEnv): { close(): void }
export function domView(doc: Document): SlidesView
