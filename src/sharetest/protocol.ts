// The screen-share test (npm run join -- "<link>" --share-test, docs/share-test.md): what the join CLI and the voice
// service say to each other about it on the control socket, and what the test page and the service say on its link.
// Shared by both sides, so neither can drift from the other. Nothing here holds a token, a URL or a meeting's key.

/** The test page, served on the public listener while a share is on (with its token as ?t=). */
export const SHARE_TEST_PAGE_PATH = '/share-test'
/** The test page's websocket link to the service (with the same token as ?t=). */
export const SHARE_TEST_LINK_PATH = '/share-test-link'

/** What the join CLI may ask of a meeting joined with share_test, one at a time. */
export const SHARE_TEST_ACTIONS = ['share', 'unshare', 'say', 'flip', 'leave'] as const
export type ShareTestAction = (typeof SHARE_TEST_ACTIONS)[number]

/** The text sizes on the page's ladder (px), each line labelled with its size. */
export const LADDER_PX = [12, 14, 16, 18, 20, 24, 28, 32, 40, 48] as const

/** How long a new share's page has to say hello (ms). The token of a share it replaces stays valid as long at most. */
export const HELLO_WAIT_MS = 20_000
/** The most one message on the link may hold, and how many it may send a second: more closes it. */
export const LINK_MAX_BYTES = 4096
export const LINK_MESSAGES_PER_SECOND = 20
/** How long a test line may take to play before the service stops waiting for it (ms). */
export const SAY_WAIT_MS = 10_000

/** The line the assistant says for the test, through its normal speech path: one while the share is on, one after. */
export function testLine(name: string, sharing: boolean): string {
  return sharing
    ? `This is ${name}. I'm testing my voice while my screen is shared.`
    : `This is ${name}. I'm testing my voice now that my screen is no longer shared.`
}

/** off: no share. starting: Recall was asked, and its page has not said hello yet. live: it has. stopping: being stopped. */
export type ShareState = 'off' | 'starting' | 'live' | 'stopping'

/** What the page says when its link opens: what the bot's browser gives it. */
export interface PageHello {
  width: number
  height: number
  dpr: number
  visibility: string
  /** Chrome's major version, from the user agent; null when it says none. */
  chrome_major: number | null
}

/** What the page says every 2 s. */
export interface PageMetrics {
  at: number
  /** Frames per second, counted from requestAnimationFrame over the last 2 s. */
  fps: number
  /** How late a 100 ms timer ran at worst over the last 2 s (ms). */
  worst_timer_late_ms: number
  visibility: string
}

/** One share: a POST to Recall with a page address of its own (its epoch and token). Times are epoch ms. */
export interface ShareView {
  epoch: number
  posted_at: number | null
  /** Recall's HTTP status for the POST; 0 when it did not answer. */
  post_status: number | null
  post_ms: number | null
  /** When its page first said hello. */
  hello_at: number | null
  hello: PageHello | null
  /** How many connections its link has had. */
  links: number
  link_open: boolean
  link_closed_at: number | null
  link_close_code: number | null
  /** Who closed it: the page (or the bot's browser going), or the service (a share it stopped, gone quiet, or over). */
  link_closed_by: 'page' | 'service' | null
  /** The scheme and host of the Origin header on its first link, '' when there was none. */
  origin: string | null
  /** Whether that Origin is the page's own (the public address's). */
  origin_is_page: boolean | null
  metrics: PageMetrics[]
  /** Each frame number sent to it, and when the page said it had painted it. */
  frames: { frame: number; sent_at: number; shown_at: number | null }[]
  /** For the share that was stopped: Recall's HTTP status for the DELETE (0: no answer), and how long it took. */
  stop_status: number | null
  stop_ms: number | null
  stopped_at: number | null
}

/** GET /api/share-test/status: the meeting and its share test, as the service sees them now. */
export interface ShareTestStatus {
  /** The meeting's state on the service: waiting for its camera page, live, away (the page dropped) or leaving. */
  meeting: 'waiting' | 'live' | 'away' | 'leaving'
  /** Whether the consent line has been said in full; null while there is no session. */
  consent_done: boolean | null
  state: ShareState
  /** The newest share's number, and the one the actions are about now (null when none is on). */
  epoch: number
  current: number | null
  /** The camera page on /audio: each time it connected (the first included), dropped, or was refused (epoch ms). */
  camera: { attaches: number[]; drops: number[]; refused: number[] }
  shares: ShareView[]
  now: number
}

/** How a test line went: played to the end, cut off (talked over, or the page went), failed, or not said. */
export type TestLineOutcome = 'played' | 'cut_off' | 'failed' | 'no_page' | 'not_now' | 'timeout'

/** POST /api/share-test/action: what each action did. Statuses are Recall's (0: no answer). */
export type ShareTestResult =
  | { action: 'share'; epoch: number; status: number; ms: number; replacing: boolean }
  | { action: 'unshare'; status: number; ms: number }
  | { action: 'say'; said: TestLineOutcome; ms: number }
  | { action: 'flip'; frame: number; sent: boolean }
  | { action: 'leave'; leaving: true }
