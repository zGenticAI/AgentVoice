// What the meeting session sees of a meeting's slide share: SlideSurface. The share itself (ShareControl in
// src/slides/share.ts) belongs to the server's meeting, which has the bot, the public listener and the tokens; the
// session never sees a token and never calls Recall for slides. Tests pass a fake.

/** How a start went: shown and acknowledged, refused by Recall, never shown, refused by our own limit, or not allowed. */
export type StartOutcome = 'loaded' | 'failed' | 'not_loading' | 'rate_limited' | 'disabled'

/** What the share says by itself: the page stopped acknowledging, someone else holds its link, the camera page dropped
 * right after a share change, or a fault of its own. Each has stopped or degraded the share already. */
export type ShareEvent = 'stuck' | 'contested' | 'camera_suspect' | 'failed'

export interface SlideSurface {
  /** How many slides the meeting has: indexes 0 to count - 1, in page order. */
  readonly count: number
  /**
   * Shares the page with slide `at` on it, and resolves once the page has shown it (loaded), or with why not. `also`:
   * the slides to send after it, so the next change is quick. Never rejects.
   */
  start(at: number, also?: readonly number[]): Promise<StartOutcome>
  /** Shows slide i, and resolves once the page has shown it, or after a few seconds without. Never rejects. */
  show(i: number, also?: readonly number[]): Promise<'shown' | 'timeout'>
  /** Shows a frame instead of the slides: no slide content, only the AI disclosure. */
  frame(kind: 'paused' | 'ended'): void
  /**
   * Blanks the page and revokes its link at once, and asks Recall to stop the share (only the share) until it does, in
   * the background: resolves once Recall has, or once its first try has not. Never rejects.
   */
  stop(): Promise<void>
  /** Blanks the page and revokes its link, without calling Recall: the bot is leaving, and the share goes with it. */
  close(): void
  /** stopping: stopped for the meeting, and Recall has not taken the stop yet (a start waits for it, for a while). */
  readonly state: 'off' | 'requested' | 'loaded' | 'stopping'
  on(event: ShareEvent, fn: () => void): void
}
