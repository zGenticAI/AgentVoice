// Recall.ai meeting bot: joins Zoom, Google Meet or Microsoft Teams as Alex and streams our agent page as its camera and microphone.
// Docs: https://docs.recall.ai/docs/meeting-agents-build-a-custom-meeting-agent,
// https://docs.recall.ai/docs/meeting-agents-share-and-control-an-agents-webpage-via-camera-or-screenshare,
// https://docs.recall.ai/docs/sending-chat-messages, https://docs.recall.ai/docs/zoom-overview,
// https://docs.recall.ai/docs/zero-data-retention, https://docs.recall.ai/docs/sub-codes
import { config, recallRegionProblem, required } from './config.ts'
import { joinChatMessage } from './consent.ts'

function base(): string {
  // The service refuses to start without a region; this keeps anything else from guessing one.
  const problem = recallRegionProblem(config.recallRegion)
  if (problem) throw new Error(problem)
  return `https://${config.recallRegion}.recall.ai/api/v1`
}

/** Recall answered, but not with success: status is its HTTP status. A network failure is a plain Error instead. */
export class RecallError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'RecallError'
  }
}

/**
 * Whether a failed call may work if made again: Recall could not be reached (the network, DNS, a timeout), had
 * trouble of its own (5xx), or asked us to slow down (429, 408). Any other answer, such as a 4xx saying the bot
 * is no longer in its call, will be the same next time.
 */
export function worthRetrying(err: unknown): boolean {
  if (!(err instanceof RecallError)) return true
  return err.status >= 500 || err.status === 429 || err.status === 408
}

function headers(): Record<string, string> {
  return {
    Authorization: required('RECALL_API_KEY'),
    accept: 'application/json',
    'content-type': 'application/json',
  }
}

async function call(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<any> {
  const res = await fetch(`${base()}${path}`, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })
  const text = await res.text()
  if (!res.ok) throw new RecallError(res.status, `Recall ${method} ${path} failed (${res.status}): ${text}`)
  return text ? JSON.parse(text) : null
}

export type Platform = 'zoom' | 'google_meet' | 'microsoft_teams'

export const PLATFORM_NAMES: Record<Platform, string> = { zoom: 'Zoom', google_meet: 'Google Meet', microsoft_teams: 'Microsoft Teams' }

/** Which meeting platform a join link belongs to, or null if it isn't one Alex supports. */
export function meetingPlatform(meetingUrl: string): Platform | null {
  let host: string
  try {
    const url = new URL(meetingUrl)
    if (url.protocol !== 'https:') return null
    host = url.hostname.toLowerCase()
  } catch {
    return null
  }
  if (host === 'zoom.us' || host.endsWith('.zoom.us')) return 'zoom'
  if (host === 'meet.google.com') return 'google_meet'
  if (host === 'teams.microsoft.com' || host === 'teams.live.com' || host.endsWith('.teams.microsoft.com')) return 'microsoft_teams'
  return null
}

export interface BotPlan {
  meetingUrl: string
  pageUrl: string
  /** Where Recall sends the meeting's participant events: only for a meeting with the speaker probe (recallEventsUrl). */
  eventsUrl?: string
}

/**
 * The participant events the speaker probe subscribes to: who joins, leaves or changes their details, and who starts
 * and stops speaking. https://docs.recall.ai/docs/real-time-websocket-endpoints (2026-11-09)
 */
export const PARTICIPANT_EVENTS = [
  'participant_events.join',
  'participant_events.leave',
  'participant_events.update',
  'participant_events.speech_on',
  'participant_events.speech_off',
] as const

/** The public path Recall's events connection comes to. The "/" before the query is required, or Recall answers 400. */
export const RECALL_EVENTS_PATH = '/recall/'

/** The address Recall sends a meeting's participant events to: the tunnel's, with the meeting's key and its own token. */
export function recallEventsUrl(publicUrl: string, key: string, token: string): string {
  const params = new URLSearchParams({ key, token })
  return `wss://${new URL(publicUrl).host}${RECALL_EVENTS_PATH}?${params}`
}

export function botRequest(plan: BotPlan): Record<string, unknown> {
  return {
    meeting_url: plan.meetingUrl,
    bot_name: config.botName,
    output_media: { camera: { kind: 'webpage', config: { url: plan.pageUrl } } },
    // Output audio can stutter on the default bot size.
    variant: { zoom: 'web_4_core', google_meet: 'web_4_core', microsoft_teams: 'web_4_core' },
    chat: { on_bot_join: { send_to: 'everyone', message: joinChatMessage() } },
    // Recall gets the bot out by itself (https://docs.recall.ai/docs/automatic-leaving-behavior, and bot_create for the
    // fields): after 10 minutes in a waiting room; 5 minutes after it got in if nobody else has joined (Recall's default
    // is 20); after 15 minutes in which nobody has said anything, counted once it has been in the call 10 minutes
    // (Recall's default is 60, counted after 20), so a meeting left open doesn't run up bot time and speech
    // recognition. As by default, it also leaves 2 seconds after everyone else has, and when only other bots
    // (note-takers) are left. Each is a normal end of the meeting, with minutes (timeout_exceeded_*, ENDED_SUB_CODES).
    automatic_leave: {
      waiting_room_timeout: 600,
      noone_joined_timeout: 300,
      silence_detection: { timeout: 900, activate_after: 600 },
    },
    // Zero Data Retention: Recall keeps no recording media (audio, video, transcript) for the bot, so
    // "I keep no recording of the meeting" holds from the start. Output media still works with it; leaving
    // recording_config out stores media indefinitely, and recording_config: null does not work with
    // output media. https://docs.recall.ai/docs/zero-data-retention
    // With the speaker probe, the meeting's participant events also come live to eventsUrl, beside retention: null in the
    // same object (BotRecordingConfigRequest in bot_create): Recall keeps none of them after the meeting
    // (zero-data-retention, 2026-11-12). Without it, the request is what it always was.
    recording_config: plan.eventsUrl
      ? { retention: null, realtime_endpoints: [{ type: 'websocket', url: plan.eventsUrl, events: [...PARTICIPANT_EVENTS] }] }
      : { retention: null },
  }
}

export async function createBot(plan: BotPlan): Promise<{ id: string }> {
  return call('POST', '/bot/', botRequest(plan))
}

export async function sendChat(botId: string, message: string): Promise<void> {
  // A refused post can quote the message back, and the message is meeting content (an answer's detail): the error,
  // which is logged, keeps only the status.
  await call('POST', `/bot/${botId}/send_chat_message/`, { message }).catch(err => {
    throw err instanceof RecallError ? new RecallError(err.status, `Recall could not post a chat message for bot ${botId} (${err.status})`) : err
  })
}

export async function leaveCall(botId: string): Promise<void> {
  await call('POST', `/bot/${botId}/leave_call/`)
}

// --- A screen share mid-call (only the screen-share test uses these: npm run join --share-test) ---------------------
// https://docs.recall.ai/docs/meeting-agents-share-and-control-an-agents-webpage-via-camera-or-screenshare (2026-11-18)

/**
 * Stops the screen share only. "Explicitly targeting screenshare keeps a separate camera session running." An empty
 * object would stop every output, and with it the camera page that carries Alex's voice: never send one.
 */
export const STOP_SCREENSHARE = Object.freeze({ screenshare: true })

/** How long a share call waits for Recall before it gives up (ms). */
export const SCREENSHARE_CALL_MS = 15_000

/**
 * A share call: its HTTP status once Recall accepts it. The reply is never read: Recall's answer to a POST is the bot,
 * whose output_media holds the page's address and its token. A refusal keeps only its status, for the same reason (as
 * sendChat's does), and so does a call Recall never answered.
 */
async function shareCall(method: 'POST' | 'DELETE', botId: string, body: object, what: string): Promise<number> {
  // A setting that is missing throws as it is: only the call itself is stripped.
  const url = `${base()}/bot/${botId}/output_media/`
  const init = { method, headers: headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(SCREENSHARE_CALL_MS) }
  let res: Response
  try {
    res = await fetch(url, init)
  } catch {
    throw new Error(`Recall could not be reached to ${what} for bot ${botId}`)
  }
  await res.body?.cancel().catch(() => {})
  if (!res.ok) throw new RecallError(res.status, `Recall could not ${what} for bot ${botId} (${res.status})`)
  return res.status
}

/** Shares a webpage as the bot's screen, beside its camera. A 2xx means Recall accepted it, not that it is shown yet. */
export async function startScreenshare(botId: string, url: string): Promise<number> {
  return shareCall('POST', botId, { screenshare: { kind: 'webpage', config: { url } } }, 'start a screen share')
}

/** Stops the bot's screen share, and nothing else: the camera page goes on. */
export async function stopScreenshare(botId: string): Promise<number> {
  return shareCall('DELETE', botId, STOP_SCREENSHARE, 'stop the screen share')
}

// Recall refuses to delete a bot's media while the bot is in progress
// ("cannot_delete_in_progress_bot_media"), which it still is just after leave_call (2026-10-25).
export const DELETE_TRIES = 20
export const DELETE_EVERY_MS = 15_000

/**
 * Asks Recall to delete any media it stored for the bot, trying again every 15 s for up to
 * 5 minutes while the bot is still finishing. Says true once deleted. Failures are logged, not fatal.
 */
export async function deleteMedia(
  botId: string,
  opts: { tries?: number; everyMs?: number; post?: (path: string) => Promise<unknown> } = {},
): Promise<boolean> {
  const { tries = DELETE_TRIES, everyMs = DELETE_EVERY_MS, post = (p: string) => call('POST', p) } = opts
  for (let attempt = 1; ; attempt++) {
    try {
      await post(`/bot/${botId}/delete_media/`)
      if (attempt > 1) console.log(`[recall] deleted media for ${botId} once the bot had finished (try ${attempt})`)
      return true
    } catch (err) {
      const message = (err as Error).message
      if (message.includes('cannot_delete_in_progress_bot_media') && attempt < tries) {
        await new Promise(r => setTimeout(r, everyMs))
        continue
      }
      console.warn(`[recall] could not delete media for ${botId}:`, message)
      return false
    }
  }
}

// --- How a bot left the call -----------------------------------------------------------------------
// Recall records each bot status in GET /bot/{id}/ as status_changes: [{ code, message, created_at,
// sub_code }] (https://docs.recall.ai/reference/bot_retrieve). "call_ended" means "The bot has left the
// call", and its sub_code says why (https://docs.recall.ai/docs/bot-status-change-events). The call
// ended sub codes are the same on Zoom, Google Meet and Microsoft Teams ("All" platforms; platform
// specific sub codes carry the platform's name as a prefix): https://docs.recall.ai/docs/sub-codes

/** "The bot was removed from the call by the host." / "...from the waiting room by the host." */
export const REMOVED_SUB_CODES: ReadonlySet<string> = new Set(['bot_kicked_from_call', 'bot_kicked_from_waiting_room'])

/** The other documented call_ended sub codes: the meeting ended, a timeout, or our own leave_call. */
export const ENDED_SUB_CODES: ReadonlySet<string> = new Set([
  'call_ended_by_host', // "The call has been ended by the meeting host."
  'call_ended_by_platform_idle', // "...ended by the meeting platform, because it was idle."
  'call_ended_by_platform_max_length',
  'call_ended_by_platform_waiting_room_timeout',
  'timeout_exceeded_waiting_room',
  'timeout_exceeded_noone_joined',
  'timeout_exceeded_everyone_left', // "The bot left the call because everyone else left."
  'timeout_exceeded_silence_detected',
  'timeout_exceeded_only_bots_detected_using_participant_names',
  'timeout_exceeded_only_bots_detected_using_participant_events',
  'timeout_exceeded_in_call_not_recording',
  'timeout_exceeded_in_call_recording',
  'timeout_exceeded_recording_permission_denied',
  'bot_received_leave_call', // the service asked it to leave (its page disconnected, or the service stopped)
  'meeting_not_started',
  'breakout_room_not_open',
])

/**
 * The documented fatal sub codes ("The bot has encountered an error that caused it to shut down"): the
 * bot could not join, or failed in the call, and nobody put it out of the call. Two documented fatal
 * codes are left out, because a removal cannot be ruled out with them, and so is any fatal code
 * Recall does not document (or none at all): those are unknown, never a normal end.
 * - google_meet_watermark_kicked: "The watermark feature in google meet was enabled mid-call and the bot was not signed in."
 * - zoom_account_blocked: "Someone previously removed the signed-in Zoom bot and selected the ... Once removed, BOT_NAME
 *   will not be able to rejoin the meeting."
 */
export const FATAL_SUB_CODES: ReadonlySet<string> = new Set([
  // All platforms
  'bot_errored',
  'meeting_not_found',
  'meeting_not_accessible',
  'meeting_not_started',
  'meeting_requires_registration',
  'meeting_requires_sign_in',
  'meeting_link_expired',
  'meeting_link_invalid',
  'meeting_password_incorrect',
  'meeting_locked',
  'meeting_full',
  'meeting_ended',
  'failed_to_launch_in_time',
  // Zoom
  'zoom_sdk_credentials_missing',
  'zoom_sdk_update_required',
  'zoom_sdk_app_not_published',
  'zoom_email_blocked_by_admin',
  'zoom_registration_required',
  'zoom_captcha_required',
  'zoom_invalid_join_token',
  'zoom_token_expired',
  'zoom_invalid_signature',
  'zoom_internal_error',
  'zoom_join_timeout',
  'zoom_email_required',
  'zoom_sso_login_required',
  'zoom_web_disallowed',
  'zoom_connection_failed',
  'zoom_error_multiple_device_join',
  'zoom_meeting_not_accessible',
  'zoom_meeting_host_inactive',
  'zoom_invalid_webinar_invite',
  'zoom_another_meeting_in_progress',
  'zoom_obf_user_not_in_meeting',
  'zoom_anonymous_join_not_allowed',
  'zoom_obf_or_zak_missing_or_invalid',
  'zoom_voice_recording_not_supported',
  'zoom_bot_blocked', // "The bot was disallowed from joining the meeting." (it never got in)
  'zoom_authorized_participants_only',
  'missing_webinar_license',
  // Google Meet
  'google_meet_internal_error',
  'google_meet_sign_in_failed',
  'google_meet_sign_in_captcha_failed',
  'google_meet_bot_blocked', // "The bot was disallowed from joining the meeting." (it never got in)
  'google_meet_sso_sign_in_failed',
  'google_meet_sign_in_missing_login_credentials',
  'google_meet_sign_in_missing_recovery_credentials',
  'google_meet_sso_sign_in_missing_login_credentials',
  'google_meet_sso_sign_in_missing_totp_secret',
  'google_meet_video_error',
  'google_meet_meeting_room_not_ready',
  'google_meet_login_not_available',
  'google_meet_permission_denied_breakout',
  'google_meet_knocking_disabled',
  'google_meet_organisation_restricted',
  'sso_login_account_disabled',
  'sso_login_invalid_recipient',
  'sso_not_configured',
  // Microsoft Teams
  'microsoft_teams_sign_in_credentials_missing',
  'microsoft_teams_call_dropped', // "Microsoft Teams disconnected and the bot was unable to reconnect."
  'microsoft_teams_sign_in_failed',
  'microsoft_teams_internal_error',
  'microsoft_teams_captcha_error',
  'microsoft_teams_bot_not_invited',
  'microsoft_teams_breakout_room_unsupported',
  'microsoft_teams_townhall_meeting_not_supported',
  'microsoft_teams_event_not_started_for_external',
  'microsoft_teams_2fa_required',
  'microsoft_teams_captions_failure',
  // Webex
  'webex_join_meeting_error',
  'webex_pin_required',
  'webex_password_required',
  'webex_user_has_excessive_device_registrations',
  'webex_service_app_unauthorized',
  // Zoom RTMS
  'rtms_signature_invalid',
  'zoom_rtms_duplicate_signal_request',
  'zoom_rtms_invalid_stream_id',
  'zoom_rtms_internal_exception',
  // Meet Media API
  'meet_media_space_not_found',
  'meet_media_unauthenticated',
  'meet_media_failed_precondition',
  'meet_media_sdp_negotiation_error',
  'meet_media_internal_error',
])

/** Documented fatal codes that may mean someone put the bot out of the call (see FATAL_SUB_CODES). */
const FATAL_REMOVAL_LIKE: ReadonlySet<string> = new Set(['google_meet_watermark_kicked', 'zoom_account_blocked'])

export interface StatusChange {
  code: string
  sub_code?: string | null
}

export type BotEnding =
  /** The host removed Alex: the same as "Alex, please leave". */
  | { kind: 'removed'; sub_code: string }
  /** The meeting ended, or the bot left or failed for a reason that is not a removal. */
  | { kind: 'ended'; sub_code: string }
  /** Whether Alex was removed cannot be ruled out: Recall could not be read, or gave no documented reason. */
  | { kind: 'unknown'; why: string }

// Recall says new codes may be added ("You should not treat the data.code and data.sub_code as an
// enum"), so a code is only quoted back as plain identifier characters.
const shown = (code: unknown) => `"${String(code ?? '').replace(/[^\w.-]/g, '').slice(0, 80)}"`

/**
 * Why the bot left the call, from its status changes, or null while Recall has not recorded that
 * it has (no call_ended, fatal or done yet). Only a documented removal code means removed; any
 * reason Recall does not document is unknown, never a removal and never a normal end.
 */
export function botEnding(changes: readonly StatusChange[]): BotEnding | null {
  const removed = changes.find(c => REMOVED_SUB_CODES.has(c.sub_code ?? ''))
  if (removed) return { kind: 'removed', sub_code: removed.sub_code! }
  const ended = changes.find(c => c.code === 'call_ended')
  if (ended) {
    if (ENDED_SUB_CODES.has(ended.sub_code ?? '')) return { kind: 'ended', sub_code: ended.sub_code! }
    return { kind: 'unknown', why: `Recall gave a reason it does not document for the end of the call, ${shown(ended.sub_code)}` }
  }
  // "The bot has encountered an error that caused it to shut down": a normal end only with a code
  // Recall documents for one that is not a removal. Any other (none, undocumented, or one that says
  // the bot was kicked or blocked) is unknown; the kick/remov/block test only words why.
  const fatal = changes.find(c => c.code === 'fatal')
  if (fatal) {
    const sub_code = fatal.sub_code ?? ''
    if (FATAL_SUB_CODES.has(sub_code)) return { kind: 'ended', sub_code: `fatal: ${sub_code}` }
    if (!sub_code) return { kind: 'unknown', why: 'Recall says the bot failed in the call, but not why' }
    if (FATAL_REMOVAL_LIKE.has(sub_code) || /kick|remov|block/i.test(sub_code)) {
      return { kind: 'unknown', why: `Recall says the bot was dropped from the call, ${shown(sub_code)}` }
    }
    return { kind: 'unknown', why: `Recall gave an error it does not document for the end of the call, ${shown(sub_code)}` }
  }
  if (changes.some(c => c.code === 'done')) return { kind: 'unknown', why: 'Recall says the bot has shut down, but not why it left the call' }
  return null
}

// The bot is usually still finishing when its page disconnects (and just after leave_call), so it
// may not have recorded call_ended yet: it is read again every 1.5 s, for 10 s at most.
export const ENDING_WAIT_MS = 10_000
export const ENDING_EVERY_MS = 1_500

type GetBot = (path: string, signal: AbortSignal) => Promise<unknown>

/** Resolves as `work` does, or rejects once `signal` aborts, whichever is first. */
function until<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('no answer in time'))
    if (signal.aborted) return abort()
    signal.addEventListener('abort', abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** Waits ms, or less if `stop` aborts. */
function pause(ms: number, stop?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (stop?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      stop?.removeEventListener('abort', done)
      resolve()
    }
    stop?.addEventListener('abort', done, { once: true })
  })
}

/**
 * Reads the bot from Recall every everyMs until it says how the bot left the call, for waitMs at most, or until `stop`
 * aborts: the ending, or why there is none.
 */
async function readEnding(botId: string, opts: { waitMs: number; everyMs: number; get: GetBot; stop?: AbortSignal }): Promise<BotEnding | string> {
  const { waitMs, everyMs, get, stop } = opts
  const deadline = Date.now() + waitMs
  let why = 'Recall had not said the bot left the call'
  for (;;) {
    const bound = AbortSignal.timeout(Math.max(1, deadline - Date.now()))
    const signal = stop ? AbortSignal.any([bound, stop]) : bound
    try {
      const bot = (await until(get(`/bot/${botId}/`, signal), signal)) as { status_changes?: unknown } | null
      const changes = Array.isArray(bot?.status_changes) ? (bot.status_changes as StatusChange[]) : []
      const ending = botEnding(changes)
      if (ending) return ending
      why = `Recall had not said the bot left the call within ${Math.round(waitMs / 1000)} s`
    } catch (err) {
      why = `Recall could not be read: ${((err as Error).message || String(err)).slice(0, 200)}`
    }
    if (Date.now() + everyMs >= deadline) return why
    await pause(everyMs, stop)
    // A read under way when it aborted has failed above.
    if (stop?.aborted) return why
  }
}

/**
 * How the bot left the call, read from Recall until it says (within waitMs). Never throws: if Recall
 * cannot be read, or has still not said by then, the answer is unknown, with why.
 */
export async function howBotEnded(
  botId: string,
  opts: { waitMs?: number; everyMs?: number; get?: GetBot } = {},
): Promise<BotEnding> {
  const { waitMs = ENDING_WAIT_MS, everyMs = ENDING_EVERY_MS, get = (p: string, signal: AbortSignal) => call('GET', p, undefined, signal) } = opts
  const ending = await readEnding(botId, { waitMs, everyMs, get })
  if (typeof ending !== 'string') return ending
  console.warn(`[recall] could not tell how bot ${botId} left the call: ${ending}`)
  return { kind: 'unknown', why: ending }
}

/**
 * Whether the bot has left the call, for a meeting whose page has just dropped: how it left once Recall says so (read
 * as howBotEnded reads it, within waitMs). Null while the bot is still in the call, when Recall can't be read, or once
 * `signal` aborts (the page came back). Never throws, and logs nothing: a page that drops is most often only the network,
 * and the bot still in its call.
 */
export async function botLeftCall(
  botId: string,
  opts: { signal?: AbortSignal; waitMs?: number; everyMs?: number; get?: GetBot } = {},
): Promise<BotEnding | null> {
  const { waitMs = ENDING_WAIT_MS, everyMs = ENDING_EVERY_MS, get = (p: string, signal: AbortSignal) => call('GET', p, undefined, signal) } = opts
  const ending = await readEnding(botId, { waitMs, everyMs, get, stop: opts.signal })
  return typeof ending === 'string' ? null : ending
}
