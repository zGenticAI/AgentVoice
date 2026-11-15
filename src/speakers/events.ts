// Recall's live participant events (join, leave, update, speech_on, speech_off), read strictly: a field it reads must be
// what Recall documents, or the message is dropped, and anything else in it (fields Recall adds later, its envelope
// objects) is ignored, never a reason to drop it. Never throws, and logs nothing: a message holds names.
// Docs: https://docs.recall.ai/docs/real-time-event-payloads (2026-04-17),
// https://docs.recall.ai/docs/identify-meeting-participants-uniquely
import { Buffer } from 'node:buffer'

export const EVENT_KINDS = ['join', 'leave', 'update', 'speech_on', 'speech_off'] as const
export type EventKind = (typeof EVENT_KINDS)[number]

/** Where Recall says a participant is: its own words, or 'other' for one it may add. */
export const PLATFORM_KINDS = ['desktop', 'dial_in', 'unknown', 'other'] as const
export type PlatformKind = (typeof PLATFORM_KINDS)[number]

/** Which platform's extra_data a participant has: 'none' without any. */
export const EXTRA_KEYS = ['zoom', 'microsoft_teams', 'google_meet', 'webex', 'other', 'none'] as const
export type ExtraKey = (typeof EXTRA_KEYS)[number]

// The id that stays the same across meetings, per platform: only whether there is one is kept, never its value.
const STABLE_IDS: Record<string, string> = {
  zoom: 'conf_user_id',
  microsoft_teams: 'user_id',
  google_meet: 'static_participant_id',
  webex: 'webex_id',
}

// The longest name kept for the moment it is read (in code points): longer ones are cut.
const MAX_NAME = 256

export interface RecallParticipantEvent {
  kind: EventKind
  /** Recall's id for the participant in this meeting. */
  pid: number
  /**
   * The display name, NFC, without control or format characters (bidi marks included), trimmed and cut to 256 code
   * points. Only nameFacts() in src/speakers/probe.ts reads it: it is never kept, logged or written.
   */
  name: string | null
  isHost: boolean | null
  platform: PlatformKind | null
  extra: { key: ExtraKey; stableId: boolean }
  /** Whether Recall gave an email address (never the address). */
  emailPresent: boolean
  /** Recall's own time for it (epoch ms). */
  at: number
  /** Seconds since the bot's recording started, by Recall. */
  rel: number
  botId: string
}

export type ParsedEvent = { event: RecallParticipantEvent } | { dropped: 'malformed' | 'unknown_event' }

const MALFORMED = { dropped: 'malformed' } as const

type Obj = Record<string, unknown>
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
/** A field that may be left out or null: undefined for "wrong type", null for "not given". */
function optional<T>(v: unknown, is: (x: unknown) => x is T): T | null | undefined {
  if (v === undefined || v === null) return null
  return is(v) ? v : undefined
}
const isString = (v: unknown): v is string => typeof v === 'string'
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean'

/** A display name as it is read: never kept beyond the event. */
export function cleanName(name: string): string {
  const clean = name.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, '').trim()
  return [...clean].slice(0, MAX_NAME).join('')
}

function extraOf(extra: Obj | null): { key: ExtraKey; stableId: boolean } {
  if (!extra) return { key: 'none', stableId: false }
  const keys = Object.keys(extra).filter(k => isObject(extra[k]))
  const key = (['zoom', 'microsoft_teams', 'google_meet', 'webex'] as const).find(k => keys.includes(k))
  if (!key) return { key: keys.length ? 'other' : 'none', stableId: false }
  const id = (extra[key] as Obj)[STABLE_IDS[key]]
  return { key, stableId: typeof id === 'string' && id.length > 0 }
}

/** One message from Recall's events connection: the event, or why it was dropped. */
export function parseParticipantEvent(raw: Buffer | string): ParsedEvent {
  let msg: unknown
  try {
    msg = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw)
  } catch {
    return MALFORMED
  }
  if (!isObject(msg) || typeof msg.event !== 'string') return MALFORMED
  const m = /^participant_events\.([a-z_]{1,40})$/.exec(msg.event)
  if (!m) return /^[a-z_]{1,40}\.[a-z_.]{1,40}$/.test(msg.event) ? { dropped: 'unknown_event' } : MALFORMED
  const kind = m[1] as EventKind
  if (!EVENT_KINDS.includes(kind)) return { dropped: 'unknown_event' }

  const data = msg.data
  if (!isObject(data) || !isObject(data.data) || !isObject(data.bot)) return MALFORMED
  const { participant, timestamp } = data.data
  if (!isObject(participant) || !isObject(timestamp)) return MALFORMED
  const botId = data.bot.id
  if (typeof botId !== 'string' || !/^[\w-]{1,100}$/.test(botId)) return MALFORMED

  const pid = participant.id
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 0) return MALFORMED
  const name = optional(participant.name, isString)
  const isHost = optional(participant.is_host, isBoolean)
  const platform = optional(participant.platform, isString)
  const extra = optional(participant.extra_data, isObject)
  const email = optional(participant.email, isString)
  if (name === undefined || isHost === undefined || platform === undefined || extra === undefined || email === undefined) return MALFORMED

  const { absolute, relative } = timestamp
  if (typeof absolute !== 'string' || absolute.length > 40) return MALFORMED
  const at = Date.parse(absolute)
  if (!Number.isFinite(at)) return MALFORMED
  if (typeof relative !== 'number' || !Number.isFinite(relative) || relative < 0) return MALFORMED

  return {
    event: {
      kind,
      pid,
      name: name === null ? null : cleanName(name),
      isHost,
      platform: platform === null ? null : (PLATFORM_KINDS as readonly string[]).includes(platform) ? (platform as PlatformKind) : 'other',
      extra: extraOf(extra),
      emailPresent: Boolean(email),
      at,
      rel: relative,
      botId,
    },
  }
}
