// Recall.ai meeting bot: joins Zoom, Google Meet or Microsoft Teams as Alex and streams our agent page as its camera and microphone.
// Docs: https://docs.recall.ai/docs/stream-media, https://docs.recall.ai/docs/chat-messages, https://docs.recall.ai/docs/zoom-overview,
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

async function call(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<any> {
  const res = await fetch(`${base()}${path}`, {
    method,
    headers: {
      Authorization: required('RECALL_API_KEY'),
      accept: 'application/json',
      'content-type': 'application/json',
    },
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
}

export function botRequest(plan: BotPlan): Record<string, unknown> {
  return {
    meeting_url: plan.meetingUrl,
    bot_name: config.botName,
    output_media: { camera: { kind: 'webpage', config: { url: plan.pageUrl } } },
    // Output audio can stutter on the default bot size.
    variant: { zoom: 'web_4_core', google_meet: 'web_4_core', microsoft_teams: 'web_4_core' },
    chat: { on_bot_join: { send_to: 'everyone', message: joinChatMessage() } },
    automatic_leave: { waiting_room_timeout: 600 },
    // Zero Data Retention: Recall keeps no recording media (audio, video, transcript) for the bot, so
    // "I keep no recording of the meeting" holds from the start. Output media still works with it; leaving
    // recording_config out stores media indefinitely, and recording_config: null does not work with
    // output media. https://docs.recall.ai/docs/zero-data-retention
    recording_config: { retention: null },
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

/** Resolves as `work` does, or rejects once `signal` aborts, whichever is first. */
function until<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('no answer in time'))
    if (signal.aborted) return abort()
    signal.addEventListener('abort', abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/**
 * How the bot left the call, read from Recall until it says (within waitMs). Never throws: if Recall
 * cannot be read, or has still not said by then, the answer is unknown, with why.
 */
export async function howBotEnded(
  botId: string,
  opts: { waitMs?: number; everyMs?: number; get?: (path: string, signal: AbortSignal) => Promise<unknown> } = {},
): Promise<BotEnding> {
  const { waitMs = ENDING_WAIT_MS, everyMs = ENDING_EVERY_MS, get = (p: string, signal: AbortSignal) => call('GET', p, undefined, signal) } = opts
  const deadline = Date.now() + waitMs
  let why = 'Recall had not said the bot left the call'
  for (;;) {
    const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()))
    try {
      const bot = (await until(get(`/bot/${botId}/`, signal), signal)) as { status_changes?: unknown } | null
      const changes = Array.isArray(bot?.status_changes) ? (bot.status_changes as StatusChange[]) : []
      const ending = botEnding(changes)
      if (ending) return ending
      why = `Recall had not said the bot left the call within ${Math.round(waitMs / 1000)} s`
    } catch (err) {
      why = `Recall could not be read: ${((err as Error).message || String(err)).slice(0, 200)}`
    }
    if (Date.now() + everyMs >= deadline) {
      console.warn(`[recall] could not tell how bot ${botId} left the call: ${why}`)
      return { kind: 'unknown', why }
    }
    await new Promise(r => setTimeout(r, everyMs))
  }
}
