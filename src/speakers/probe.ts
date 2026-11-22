// The speaker probe: with SPEAKER_PROBE on, a meeting joined with npm run join -- "<link>" --speaker-probe measures how
// Recall's participant events (who joined, who is speaking) line up with the turns the assistant hears, so that naming
// speakers can be built on numbers rather than guesses (docs/speaker-probe.md). One per meeting, in memory.
//
// Nothing it keeps names anyone or holds words. A display name is read once, as an event arrives, and only categories
// are kept of it (looks like a phone number, matches the bot's name, a test label) with a hash under a salt that never
// leaves memory, to tell a rename from a re-join. No participant id's value, email or text of the meeting is kept: of a
// turn, only its times, its word count and the index of the test code word it starts with. When the meeting ends, it
// writes one file of counts and sorted timings (numbers, fixed keys and the date: no timeline, no names) to
// data/speaker-probe/, named as the transcript is, which goes with it: never written for a meeting Alex was asked to
// leave or removed from, deleted by a later "please leave" and by the retention sweep.
import { createHmac, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { WORDS } from '../commands.ts'
import type { Platform } from '../recall.ts'
import { PROBE_DIR } from '../transcript.ts'
import { type Interval, attributeMerged, mergeIntervals } from './attribute.ts'
import { EVENT_KINDS, EXTRA_KEYS, type EventKind, type ExtraKey, PLATFORM_KINDS, type PlatformKind, type RecallParticipantEvent } from './events.ts'

/** What the service says at every start while SPEAKER_PROBE is on, and npm run check too. */
export const PROBE_ON =
  `SPEAKER_PROBE is on: a meeting joined with ${WORDS.run('join', '"<link>" --speaker-probe')} subscribes to Recall's ` +
  'participant events (names and who is speaking reach this computer through the tunnel) and keeps measurements, numbers ' +
  `only, in ${WORDS.ownerPath('data/speaker-probe/')}. Use it only in test meetings whose participants have agreed (${WORDS.doc('speaker-probe')}), and ` +
  `remove it from ${WORDS.envFile} when the tests are done.`

/** Why a join that asks for the speaker probe is refused while SPEAKER_PROBE is off. */
export const PROBE_OFF =
  `SPEAKER_PROBE is not set in ${WORDS.envFile}, so this meeting cannot have the speaker probe, which is for test meetings only ` +
  `(${WORDS.doc('speaker-probe')}). Set SPEAKER_PROBE=1 and restart the service, or join without --speaker-probe.`

// Memory caps, for a meeting of hours or a connection that sends too much: what is over is counted, not kept.
export const MAX_EVENTS = 50_000
export const MAX_TURNS = 5_000
// Scoring a turn tries every setting in GRID on it: past this many, turns are counted but not scored, so writing the
// file at the end of a meeting never holds up the other meetings' audio for long.
export const MAX_SCORED = 1_000
export const MAX_PARTICIPANTS = 500
const MAX_LAGS = 10_000
const MAX_ALEX = 10_000
// The most values a list of timings keeps in the file: past it, evenly spaced ones of the sorted list.
export const MAX_SAMPLES = 2_000

// A turn's wide window: its first word less this, to its last word plus this (ms).
const WIDE_MS = 3000
// Another turn this close to a turn makes it crowded (ms).
const CLOSE_MS = 1500
// A turn shorter than this, first word to last, is short (ms).
const SHORT_MS = 1000
// The settled view: what Recall had sent this long after the turn ended (ms).
const SETTLE_MS = 10_000
// A speech_on this soon after Alex's audio stops is still its own (ms), and this soon after a turn ends still the turn's.
const ALEX_TAIL_MS = 1500
const TURN_TAIL_MS = 500
// A speech_on with no turn this close to it is noise: a cough, a clap (ms).
const NO_WORDS_MS = 3000
// A participant whose speech_on comes during Alex's audio, at least this many times and mostly then, is Alex's own bot.
const SELF_MIN = 3
const SELF_SHARE = 0.8
// Zoom sends a burst of speech_on and speech_off for one turn: stretches this close together count as one (ms).
const ZOOM_MERGE_MS = 700
// Recall's own clock, corrected by how far it was from the turns before: not until this many are known.
const ADJ_MIN = 3
// How far a participant's speaking is looked for around a turn, beyond the widest window, for the corrected clock (ms).
const ADJ_MARGIN_MS = 5000

/** The settings tried on each scored turn: which clock, how far around the turn, how much of it, and how clearly. */
export const GRID = {
  clock: ['rx', 'abs_adj'],
  startTol: [200, 400, 800],
  endTol: [150, 300, 600],
  minShare: [0.25, 0.4, 0.6],
  ratio: [1.5, 2],
} as const
export const VIEWS = ['eot', 'settled'] as const
export const LENGTHS = ['short', 'normal'] as const

export const DROP_REASONS = ['binary', 'too_big', 'malformed', 'unknown_event', 'wrong_bot', 'rate', 'overflow'] as const
export type DropReason = (typeof DROP_REASONS)[number]
export const NAME_SHAPES = ['null', 'empty', 'phone_like', 'phone_masked', 'placeholder', 'letters', 'letters_digits', 'other'] as const
export type NameShape = (typeof NAME_SHAPES)[number]
export type BotMatch = 'exact' | 'prefix' | 'none'
export const ENDINGS = ['ended', 'unconfirmed', 'stopped'] as const
export type Ending = (typeof ENDINGS)[number]
const CLOSE_KEYS = ['1000', '1006', '1009', 'other'] as const

/** The test code words, as testers start each turn with one and are named "Probe <word>": alfa counts as alpha. */
export const CODEWORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'] as const
const ECHO = CODEWORDS.indexOf('echo')

function codewordIndex(word: string): number | null {
  const w = word.toLowerCase()
  const i = (CODEWORDS as readonly string[]).indexOf(w === 'alfa' ? 'alpha' : w)
  return i < 0 ? null : i
}

/** Which test code word a turn starts with (its index in CODEWORDS), or null. The probe gets only this of a turn's words. */
export function probeCodeword(text: string): number | null {
  const m = /^[^\p{L}\p{N}]*(\p{L}+)/u.exec(text)
  return m ? codewordIndex(m[1]) : null
}

const PLACEHOLDER = /^(?:unknown|guest|anonymous|caller|participant|user|phone|telephone|(?:dial|call)[\s-]?in(?:[\s_-]+(?:user|caller|participant))?)(?:[\s_#-]*\d+)?$/i
const LABEL = /^probe[\s_-]+(alpha|alfa|bravo|charlie|delta|echo|foxtrot)$/i

/** What kind of name it is, never the name: how phone callers and guests show up on each platform. */
export function nameShape(name: string | null): NameShape {
  if (name === null) return 'null'
  const n = name.trim()
  if (!n) return 'empty'
  const bare = n.replace(/[\s\-.()/+_]/g, '').replace(/^[^\p{L}\p{N}*•]+/u, '')
  if (/^\d{7,15}$/.test(bare)) return 'phone_like'
  if (/^[\d*xX•]{7,18}$/.test(bare) && (bare.match(/\d/g)?.length ?? 0) >= 3 && /[*xX•]/.test(bare)) return 'phone_masked'
  if (PLACEHOLDER.test(n)) return 'placeholder'
  if (/^[\p{L}\p{M}][\p{L}\p{M}\s'’.-]*$/u.test(n)) return 'letters'
  if (/\p{L}/u.test(n) && /\p{N}/u.test(n) && /^[\p{L}\p{M}\p{N}\s'’.()#_-]+$/u.test(n)) return 'letters_digits'
  return 'other'
}

/** Whether a name is the bot's own: exactly, or with something after it (Teams adds "(Unverified)"). */
export function botMatch(name: string | null, botName: string): BotMatch {
  const n = name?.normalize('NFC').trim()
  const b = botName.normalize('NFC').trim()
  if (!n || !b) return 'none'
  if (n === b) return 'exact'
  return n.toLowerCase().startsWith(b.toLowerCase()) ? 'prefix' : 'none'
}

export interface NameFacts {
  shape: NameShape
  botMatch: BotMatch
  /** The test label ("Probe Bravo" is 1), or null. */
  label: number | null
  /** An HMAC of the name under the meeting's own salt, to tell a rename or a re-join: null without a name. */
  hash: string | null
}

/** All that is kept of a display name. */
export function nameFacts(name: string | null, salt: Buffer, botName: string): NameFacts {
  const n = name?.normalize('NFC').trim()
  const label = n ? LABEL.exec(n) : null
  return {
    shape: nameShape(name),
    botMatch: botMatch(name, botName),
    label: label ? codewordIndex(label[1]) : null,
    hash: n ? createHmac('sha256', salt).update(n.toLowerCase()).digest('hex').slice(0, 32) : null,
  }
}

interface Person {
  firstSeenBy: EventKind
  hash: string | null
  shape: NameShape
  botMatch: BotMatch
  /** The test label from each time on (rx), for scoring: a rename changes it. */
  labels: { rx: number; label: number | null }[]
  platform: PlatformKind | null
  isHost: boolean | null
  extra: ExtraKey
  stableId: boolean
  email: boolean
  present: boolean
  left: boolean
}

interface ProbeEvent {
  pid: number
  kind: EventKind
  /** When the service received it (epoch ms). */
  rx: number
  /** Recall's own time for it (epoch ms), and seconds since its recording started. */
  at: number
  rel: number
}

/** What the session says of a turn as it ends. first, last: when its first and last word arrived here (epoch ms). */
export interface ProbeTurn {
  rx: number
  first: number | null
  last: number | null
  words: number
  /** Whether first and last came from Flux's word times, rather than the turn's own audio window. */
  wordTimes: boolean
  codeword: number | null
}

interface TurnRecord {
  sot: number | null
  eot: number
  fw: number | null
  lw: number | null
  words: number
  wordTimes: boolean
  codeword: number | null
}

const zeros = <K extends string>(keys: readonly K[]): Record<K, number> => Object.fromEntries(keys.map(k => [k, 0])) as Record<K, number>

/** Everything the probe collects for one meeting: categories, counts and times only. */
export interface ProbeState {
  platform: Platform
  createdAt: number
  pageAt: number | null
  connections: number
  replaced: number
  closes: Record<(typeof CLOSE_KEYS)[number], number>
  pingTimeouts: number
  dropped: Record<DropReason, number>
  firstEventAt: number | null
  lastEventAt: number | null
  longestQuietMs: number
  events: ProbeEvent[]
  people: Map<number, Person>
  roster: {
    joinsFirst5s: number
    presentWithoutJoin: number
    rejoinSameId: number
    rejoinNewId: number
    renames: number
    hostChanges: number
    maxPresent: number
    firstSeenBy: Record<EventKind, number>
  }
  present: number
  hashesLeft: Set<string>
  turns: TurnRecord[]
  turnsDropped: number
  lags: number[]
  alex: { start: number; end: number }[]
}

export function emptyState(platform: Platform, createdAt: number): ProbeState {
  return {
    platform,
    createdAt,
    pageAt: null,
    connections: 0,
    replaced: 0,
    closes: zeros(CLOSE_KEYS),
    pingTimeouts: 0,
    dropped: zeros(DROP_REASONS),
    firstEventAt: null,
    lastEventAt: null,
    longestQuietMs: 0,
    events: [],
    people: new Map(),
    roster: { joinsFirst5s: 0, presentWithoutJoin: 0, rejoinSameId: 0, rejoinNewId: 0, renames: 0, hostChanges: 0, maxPresent: 0, firstSeenBy: zeros(EVENT_KINDS) },
    present: 0,
    hashesLeft: new Set(),
    turns: [],
    turnsDropped: 0,
    lags: [],
    alex: [],
  }
}

export interface ProbeOptions {
  platform: Platform
  /** The bot's name in the participant list, to tell its own participant. */
  botName: string
  /** data/speaker-probe unless a test passes a folder. */
  dir?: string
  /** The secret the names are hashed under: a new random one per meeting, never written. */
  salt?: Buffer
  now?: () => number
  /** Called once when the meeting's record goes ("please leave", a removal): the server closes Recall's connection. */
  onDiscard?: () => void
}

/** One meeting's measurements. Every method does nothing once discarded, and the events stop once stopEvents is called. */
export class SpeakerProbe {
  private state: ProbeState
  private readonly salt: Buffer
  private readonly botName: string
  private readonly dir: string
  private readonly now: () => number
  private readonly onDiscard?: () => void
  private pendingStart: number | null = null
  private stopped = false
  private discarded = false
  private file: string | null = null

  constructor(o: ProbeOptions) {
    this.now = o.now ?? Date.now
    this.state = emptyState(o.platform, this.now())
    this.salt = o.salt ?? randomBytes(32)
    this.botName = o.botName
    this.dir = o.dir ?? PROBE_DIR
    this.onDiscard = o.onDiscard
  }

  /** Whether Recall's connection may still bring events: not once the meeting is over or its record gone. */
  get accepting(): boolean {
    return !this.stopped && !this.discarded
  }

  // --- The connection (src/speakers/connection.ts) ---

  connected(replaced: boolean): void {
    if (this.discarded) return
    this.state.connections++
    if (replaced) this.state.replaced++
  }

  closed(code: number): void {
    if (this.discarded) return
    const key = String(code)
    this.state.closes[(CLOSE_KEYS as readonly string[]).includes(key) ? (key as (typeof CLOSE_KEYS)[number]) : 'other']++
  }

  dropped(reason: DropReason): void {
    if (!this.discarded) this.state.dropped[reason]++
  }

  pingTimeout(): void {
    if (!this.discarded) this.state.pingTimeouts++
  }

  /** One of Recall's events, received at rx. The name in it goes to nameFacts, and nowhere else. */
  event(ev: RecallParticipantEvent, rx: number): void {
    if (!this.accepting) return
    const s = this.state
    if (s.events.length >= MAX_EVENTS) return this.dropped('overflow')
    let person = s.people.get(ev.pid)
    const facts = nameFacts(ev.name, this.salt, this.botName)
    if (!person) {
      if (s.people.size >= MAX_PARTICIPANTS) return this.dropped('overflow')
      person = {
        firstSeenBy: ev.kind,
        hash: facts.hash,
        shape: facts.shape,
        botMatch: facts.botMatch,
        labels: [{ rx, label: facts.label }],
        platform: ev.platform,
        isHost: ev.isHost,
        extra: ev.extra.key,
        stableId: ev.extra.stableId,
        email: ev.emailPresent,
        present: false,
        left: false,
      }
      s.people.set(ev.pid, person)
      s.roster.firstSeenBy[ev.kind]++
      if (ev.kind !== 'join') s.roster.presentWithoutJoin++
      // A new participant with the name of one who left: the platform gave the same person a new id.
      if (ev.kind === 'join' && facts.hash && s.hashesLeft.has(facts.hash)) s.roster.rejoinNewId++
    } else {
      if (ev.kind === 'join' && person.left) s.roster.rejoinSameId++
      if (ev.kind === 'update' && person.hash && facts.hash && person.hash !== facts.hash) s.roster.renames++
      if (ev.kind === 'update' && person.isHost !== null && ev.isHost !== null && person.isHost !== ev.isHost) s.roster.hostChanges++
      // An event without a name says nothing new about it.
      if (ev.name !== null) {
        person.hash = facts.hash
        person.shape = facts.shape
        person.botMatch = facts.botMatch
        if (person.labels.at(-1)!.label !== facts.label) person.labels.push({ rx, label: facts.label })
      }
      if (ev.platform !== null) person.platform = ev.platform
      if (ev.isHost !== null) person.isHost = ev.isHost
      if (ev.extra.key !== 'none') {
        person.extra = ev.extra.key
        person.stableId = ev.extra.stableId
      }
      person.email ||= ev.emailPresent
    }
    if (ev.kind === 'join' && ev.rel <= 5) s.roster.joinsFirst5s++
    const wasPresent = person.present
    person.present = ev.kind !== 'leave'
    s.present += Number(person.present) - Number(wasPresent)
    s.roster.maxPresent = Math.max(s.roster.maxPresent, s.present)
    if (ev.kind === 'leave') {
      person.left = true
      if (person.hash) s.hashesLeft.add(person.hash)
    }
    if (s.lastEventAt !== null) s.longestQuietMs = Math.max(s.longestQuietMs, rx - s.lastEventAt)
    s.firstEventAt ??= rx
    s.lastEventAt = rx
    s.events.push({ pid: ev.pid, kind: ev.kind, rx, at: ev.at, rel: ev.rel })
  }

  // --- The server and the session (src/server.ts, src/pipeline/session.ts) ---

  /** The meeting's page first connected: Recall's events are timed from then. */
  pageConnected(rx: number): void {
    if (!this.discarded) this.state.pageAt ??= rx
  }

  turnStarted(rx: number): void {
    if (!this.discarded) this.pendingStart = rx
  }

  /** How far Flux's word timings ran behind the audio sent to it (ms), on an Update. */
  fluxLag(ms: number): void {
    if (this.discarded || !Number.isFinite(ms) || this.state.lags.length >= MAX_LAGS) return
    this.state.lags.push(ms)
  }

  turnEnded(t: ProbeTurn): void {
    if (this.discarded) return
    const sot = this.pendingStart
    this.pendingStart = null
    if (this.state.turns.length >= MAX_TURNS) {
      this.state.turnsDropped++
      return
    }
    const finite = (v: number | null) => (v !== null && Number.isFinite(v) ? v : null)
    this.state.turns.push({ sot, eot: t.rx, fw: finite(t.first), lw: finite(t.last), words: t.words, wordTimes: t.wordTimes, codeword: t.codeword })
  }

  /** Alex's voice will play here from `from` until `until` (epoch ms). */
  agentAudio(from: number, until: number): void {
    if (this.discarded || !(until > from)) return
    const alex = this.state.alex
    const last = alex.at(-1)
    if (last && from <= last.end + 50) last.end = Math.max(last.end, until)
    else if (alex.length < MAX_ALEX) alex.push({ start: from, end: until })
  }

  /** Alex's voice stopped at `at`: the page was paused or cleared. */
  agentStopped(at: number): void {
    const last = this.state.alex.at(-1)
    if (!this.discarded && last && at < last.end) last.end = Math.max(last.start, at)
  }

  // --- Its life ---

  /** The meeting is over for Recall's events: no more are taken, and what was measured waits for write(). */
  stopEvents(): void {
    this.stopped = true
  }

  /**
   * "Please leave", or a removal: everything measured goes, a file already written is deleted, Recall's connection is
   * closed (onDiscard), and nothing is taken or written from now on.
   */
  discard(): void {
    if (this.discarded) return
    this.discarded = true
    this.stopped = true
    this.state = emptyState(this.state.platform, this.state.createdAt)
    if (this.file) {
      fs.rmSync(this.file, { force: true })
      fs.rmSync(`${this.file}.next`, { force: true })
    }
    this.onDiscard?.()
  }

  /**
   * Writes the meeting's measurements, once, to <dir>/<stem>.json (stem: the transcript's file name), readable by you
   * only, and says which file, or null if nothing was written. Its memory is let go then. Never for a discarded probe.
   */
  write(m: { stem: string; startedAt: Date; endedAt: Date; ending: Ending }): string | null {
    if (this.discarded || this.file || !/^[\w-]{1,200}$/.test(m.stem)) return null
    this.stopped = true
    const summary = summarize(this.state, m)
    const file = path.join(this.dir, `${m.stem}.json`)
    const next = `${file}.next`
    try {
      // Every time: mkdir's mode applies only to a folder it makes.
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      fs.chmodSync(this.dir, 0o700)
      fs.writeFileSync(next, `${JSON.stringify(summary)}\n`, { mode: 0o600 })
      fs.chmodSync(next, 0o600)
      fs.renameSync(next, file)
    } catch (err) {
      try {
        fs.rmSync(next, { force: true })
      } catch {
        // Nothing was written, or the retention sweep takes it.
      }
      // Its code only: the file's name holds the meeting's key.
      const code = (err as NodeJS.ErrnoException).code
      console.error(`[probe] could not keep the speaker measurements (${typeof code === 'string' ? code : 'error'})`)
      return null
    }
    this.file = file
    this.state = emptyState(this.state.platform, this.state.createdAt)
    return file
  }
}

// --- What is measured -------------------------------------------------------------------------------------------------

type Counts<K extends string> = Record<K, number>
/** [correct, wrong, abstain] */
export type Tally = [number, number, number]

/** The file, version 1. Only these keys, numbers, the enum values and the date. */
export interface ProbeSummary {
  kind: 'speaker-probe'
  v: 1
  platform: Platform
  date: string
  minutes: number
  ending: Ending
  endpoint: {
    connections: number
    replaced: number
    closes: Counts<(typeof CLOSE_KEYS)[number]>
    ping_timeouts: number
    first_event_after_page_ms: number | null
    events_before_page: number
    longest_quiet_s: number
    dropped: Counts<DropReason>
  }
  events: Counts<EventKind>
  delay_ms: Record<EventKind, number[]>
  recall_clock_spread_ms: number | null
  flux: { turns: number; timed: number; word_times: number; dropped: number; lag_ms: number[] }
  agent: { audio_s: number }
  participants: {
    total: number
    max_present: number
    first_seen_by: Counts<EventKind>
    joins_first_5s: number
    present_without_join: number
    rejoin_same_id: number
    rejoin_new_id: number
    renames: number
    host_changes: number
    host: Counts<'true' | 'false' | 'null'>
    platform: Counts<PlatformKind | 'null'>
    name_shape: Counts<NameShape>
    extra_data: Counts<ExtraKey>
    stable_id: number
    email_present: number
    dial_in: { count: number; name_shape: Counts<NameShape>; spoke: number }
    probe_labels: number
  }
  bot: {
    seen: boolean
    name_match: 'exact' | 'prefix' | 'unseen'
    is_host: 'true' | 'false' | 'null' | 'unseen'
    speech_on: number
    speech_on_while_agent: number
    self_candidates: number
    self_candidate_name_match: Counts<BotMatch>
  }
  turns: {
    with_words: number
    single: number
    crowded: number
    no_event: number
    while_agent: number
    already_open: number
    short: number
    on_minus_sot_rx_ms: number[]
    on_minus_fw_rx_ms: number[]
    on_at_minus_fw_rx_ms: number[]
    off_minus_lw_rx_ms: number[]
    on_after_eot: number
    on_after_eot_ms: number[]
    same_turn_gap_ms: number[]
    events_without_words: number
  }
  scored: { turns: number; unmapped: number; over_cap: number; grid: Record<string, Tally> }
}

/** Rounded to 10 ms and sorted, so no order of events is left; at most MAX_SAMPLES, evenly spaced. */
export function samples(values: readonly number[]): number[] {
  const sorted = values.filter(Number.isFinite).map(v => Math.round(v / 10) * 10 + 0).sort((a, b) => a - b)
  if (sorted.length <= MAX_SAMPLES) return sorted
  return Array.from({ length: MAX_SAMPLES }, (_, i) => sorted[Math.round((i * (sorted.length - 1)) / (MAX_SAMPLES - 1))])
}

/** The q quantile of sorted values (0 ≤ q ≤ 1), interpolated, or null with none. */
export function quantile(sorted: readonly number[], q: number): number | null {
  if (!sorted.length) return null
  const at = (sorted.length - 1) * q
  const lo = Math.floor(at)
  const hi = Math.ceil(at)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo)
}

/** The grid's key for one setting, view and length: "rx|400|300|0.4|2|eot|normal". */
export function gridKey(c: { clock: string; startTol: number; endTol: number; minShare: number; ratio: number }, view: string, length: string): string {
  return [c.clock, c.startTol, c.endTol, c.minShare, c.ratio, view, length].join('|')
}

/** Every setting in GRID. */
export function gridConfigs(): { clock: (typeof GRID.clock)[number]; startTol: number; endTol: number; minShare: number; ratio: number }[] {
  const out = []
  for (const clock of GRID.clock)
    for (const startTol of GRID.startTol)
      for (const endTol of GRID.endTol)
        for (const minShare of GRID.minShare) for (const ratio of GRID.ratio) out.push({ clock, startTol, endTol, minShare, ratio })
  return out
}

/** The last index in sorted (by key) whose key is ≤ x, or -1. */
function lastAtMost<T>(sorted: readonly T[], x: number, key: (t: T) => number): number {
  let lo = 0
  let hi = sorted.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (key(sorted[mid]) <= x) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return found
}

/** One participant's stretch of speaking, on both clocks: by when its events arrived here, and by Recall's own time. */
interface Stretch {
  pid: number
  start: number
  /** When its speech_off (or leave) arrived, or null: never ended. */
  end: number | null
  startAt: number
  endAt: number | null
}

function insertSorted(list: number[], v: number): void {
  list.splice(lastAtMost(list, v, x => x) + 1, 0, v)
}

/** What the file holds, worked out from the state once, as the meeting ends. Pure. */
export function summarize(s: ProbeState, m: { startedAt: Date; endedAt: Date; ending: Ending }): ProbeSummary {
  const events = [...s.events].sort((a, b) => a.rx - b.rx)
  const people = s.people

  // Each participant's speech_on and speech_off, and stretches of speaking (one open at a time).
  const ons = new Map<number, ProbeEvent[]>()
  const offs = new Map<number, ProbeEvent[]>()
  const stretches = new Map<number, Stretch[]>()
  const open = new Map<number, ProbeEvent>()
  const push = <T>(map: Map<number, T[]>, pid: number, v: T) => (map.get(pid) ?? map.set(pid, []).get(pid)!).push(v)
  for (const e of events) {
    if (e.kind === 'speech_on') {
      push(ons, e.pid, e)
      if (!open.has(e.pid)) open.set(e.pid, e)
    } else if (e.kind === 'speech_off' || e.kind === 'leave') {
      if (e.kind === 'speech_off') push(offs, e.pid, e)
      const on = open.get(e.pid)
      if (on) {
        push(stretches, e.pid, { pid: e.pid, start: on.rx, end: e.rx, startAt: on.at, endAt: e.at })
        open.delete(e.pid)
      }
    }
  }
  for (const [pid, on] of open) push(stretches, pid, { pid, start: on.rx, end: null, startAt: on.at, endAt: null })
  // Stretches of one participant follow each other, so their ends are in order too.
  const stretchesNear = (pid: number, from: number, to: number): Stretch[] => {
    const list = stretches.get(pid)
    if (!list || list[0].start > to || (list.at(-1)!.end ?? Infinity) < from) return []
    let lo = 0
    let hi = list.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((list[mid].end ?? Infinity) < from) lo = mid + 1
      else hi = mid
    }
    const out: Stretch[] = []
    for (let i = lo; i < list.length && list[i].start <= to; i++) out.push(list[i])
    return out
  }

  const alex = s.alex
  const inAlex = (rx: number) => {
    const i = lastAtMost(alex, rx, a => a.start)
    return [i, i - 1].some(j => j >= 0 && rx <= alex[j].end + ALEX_TAIL_MS)
  }
  const overlapsAlex = (from: number, to: number) => {
    const i = lastAtMost(alex, to, a => a.start)
    return i >= 0 && alex[i].end >= from
  }

  // Turns, by when each started: its first word, or its StartOfTurn, or its end.
  const turns = [...s.turns]
    .map(t => {
      const timed = t.fw !== null && t.lw !== null && t.lw >= t.fw
      const start = timed ? t.fw! : (t.sot ?? t.eot)
      const end = timed ? t.lw! : t.eot
      return { ...t, timed, start, end }
    })
    .sort((a, b) => a.start - b.start)
  const turnOpenAt = (rx: number) => {
    const i = lastAtMost(turns, rx, t => t.start)
    return [i, i - 1].some(j => j >= 0 && rx <= turns[j].eot + TURN_TAIL_MS)
  }
  const turnNear = (rx: number) => {
    const i = lastAtMost(turns, rx + NO_WORDS_MS, t => t.start)
    return [i, i - 1].some(j => j >= 0 && rx >= turns[j].start - NO_WORDS_MS && rx <= turns[j].eot + NO_WORDS_MS)
  }

  // Alex's own bot: by its name, or by speaking mostly while Alex does.
  const selfCandidates = new Set<number>()
  for (const [pid, list] of ons) {
    const during = list.filter(e => inAlex(e.rx) && !turnOpenAt(e.rx)).length
    if (list.length >= SELF_MIN && during / list.length >= SELF_SHARE) selfCandidates.add(pid)
  }
  const excluded = new Set<number>(selfCandidates)
  for (const [pid, p] of people) if (p.botMatch !== 'none') excluded.add(pid)
  const humans = [...people.keys()].filter(pid => !excluded.has(pid))
  // Who ever had each test label, and the phone callers: whom a code word can name.
  const byLabel = new Map<number, number[]>()
  for (const [pid, p] of people) for (const label of new Set(p.labels.map(l => l.label))) if (label !== null) push(byLabel, label, pid)
  const isDialIn = (p: Person) => p.platform === 'dial_in' || p.shape === 'phone_like' || p.shape === 'phone_masked'
  const callers = humans.filter(pid => isDialIn(people.get(pid)!))

  // The test label each participant had at a time.
  const labelAt = (p: Person, rx: number) => {
    const i = lastAtMost(p.labels, rx, l => l.rx)
    return i >= 0 ? p.labels[i].label : null
  }

  const t = {
    with_words: 0,
    single: 0,
    crowded: 0,
    no_event: 0,
    while_agent: 0,
    already_open: 0,
    short: 0,
    on_after_eot: 0,
    events_without_words: 0,
  }
  const onSot: number[] = []
  const onFw: number[] = []
  const onAtFw: number[] = []
  const offLw: number[] = []
  const afterEot: number[] = []
  const gaps: number[] = []
  const offsets: number[] = []
  const scored = { turns: 0, unmapped: 0, over_cap: 0 }
  const configs = gridConfigs()
  // Each setting's tallies by view and length, made into the grid's keys once, at the end.
  const tallies = configs.map(() => VIEWS.map(() => LENGTHS.map((): Tally => [0, 0, 0])))
  const mergeGap = s.platform === 'zoom' ? ZOOM_MERGE_MS : 0
  const maxStart = Math.max(...GRID.startTol)
  const maxEnd = Math.max(...GRID.endTol)
  // The humans' stretches around each turn, found by one sweep through them in order (turns are in order of start): so
  // the work grows with what is near each turn, not with everyone in the meeting.
  const reach = Math.max(WIDE_MS, maxStart + ADJ_MARGIN_MS, maxEnd + ADJ_MARGIN_MS)
  const sweep = humans.flatMap(pid => stretches.get(pid) ?? []).sort((a, b) => a.start - b.start)
  let swept = 0
  const live: Stretch[] = []
  const overlapping = (from: number, to: number) => live.filter(st => st.start <= to && (st.end ?? Infinity) >= from)

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]
    if (turn.words > 0) t.with_words++
    const short = turn.timed && turn.end - turn.start < SHORT_MS
    if (short) t.short++
    const wide = { from: turn.start - WIDE_MS, to: turn.end + WIDE_MS }
    while (swept < sweep.length && sweep[swept].start <= turn.end + reach) live.push(sweep[swept++])
    // Ended before this turn's reach: before every later one's too.
    let kept = 0
    for (const st of live) if ((st.end ?? Infinity) >= turn.start - reach) live[kept++] = st
    live.length = kept
    const active = [...new Set(overlapping(wide.from, wide.to).map(st => st.pid))]
    const close =
      (i > 0 && turns[i - 1].end >= turn.start - CLOSE_MS) || (i + 1 < turns.length && turns[i + 1].start <= turn.end + CLOSE_MS)
    let single = false
    if (overlapsAlex(turn.start, turn.end)) t.while_agent++
    else if (active.length >= 2 || close) t.crowded++
    else if (!active.length) t.no_event++
    else {
      t.single++
      single = true
    }

    // Timings, from the speaker's speech_on nearest the turn's first word.
    let offset: number | null = null
    if (single && turn.timed) {
      const speaker = active[0]
      const own = (ons.get(speaker) ?? []).filter(e => e.rx >= wide.from && e.rx <= wide.to)
      if (!own.length) t.already_open++
      else {
        const on = own.reduce((a, b) => (Math.abs(b.rx - turn.start) < Math.abs(a.rx - turn.start) ? b : a))
        if (turn.sot !== null) onSot.push(on.rx - turn.sot)
        onFw.push(on.rx - turn.start)
        onAtFw.push(on.at - turn.start)
        offset = on.at - turn.start
        const offList = offs.get(speaker) ?? []
        const next = offList[lastAtMost(offList, on.rx, e => e.rx) + 1]
        if (next) offLw.push(next.rx - turn.end)
        if (on.rx > turn.eot) {
          t.on_after_eot++
          afterEot.push(on.rx - turn.eot)
        }
      }
      const within = stretchesNear(speaker, turn.start, turn.end)
      for (let j = 1; j < within.length; j++) {
        const gapStart = within[j - 1].end
        if (gapStart !== null && gapStart >= turn.start && within[j].start <= turn.end) gaps.push(within[j].start - gapStart)
      }
    }

    // Scored: a timed turn that starts with a code word, against who had that label then.
    if (turn.timed && turn.codeword !== null) {
      let truth = (byLabel.get(turn.codeword) ?? []).filter(pid => labelAt(people.get(pid)!, turn.eot) === turn.codeword)
      if (!truth.length && turn.codeword === ECHO) truth = callers
      if (!truth.length) scored.unmapped++
      else if (scored.turns >= MAX_SCORED) scored.over_cap++
      else {
        scored.turns++
        const length = LENGTHS.indexOf(short ? 'short' : 'normal')
        const truthSet = new Set(truth)
        const span = { start: turn.start, end: turn.end }
        const near = overlapping(turn.start - maxStart - ADJ_MARGIN_MS, turn.end + maxEnd + ADJ_MARGIN_MS)
        const adj = offsets.length >= ADJ_MIN ? quantile(offsets, 0.5)! : null
        for (const [v, view] of VIEWS.entries()) {
          const cutoff = view === 'eot' ? turn.eot : turn.eot + SETTLE_MS
          const seen = near.filter(st => st.start <= cutoff)
          const ended = (st: Stretch) => st.end !== null && st.end <= cutoff
          const byClock: Record<string, ReturnType<typeof mergeIntervals> | null> = {
            rx: mergeIntervals(
              seen.map((st): Interval => ({ pid: st.pid, start: st.start, end: ended(st) ? st.end : null })),
              cutoff,
              mergeGap,
            ),
            abs_adj:
              adj === null
                ? null
                : mergeIntervals(
                    seen.map((st): Interval => ({ pid: st.pid, start: st.startAt - adj, end: ended(st) ? st.endAt! - adj : null })),
                    cutoff,
                    mergeGap,
                  ),
          }
          for (const [k, c] of configs.entries()) {
            const merged = byClock[c.clock]
            const got = merged ? attributeMerged(merged, span, c) : null
            tallies[k][v][length][got === null ? 2 : truthSet.has(got.pid) ? 0 : 1]++
          }
        }
      }
    }
    // Known only after the turn is scored: the corrected clock uses the turns before it.
    if (offset !== null) insertSorted(offsets, offset)
  }

  const grid: Record<string, Tally> = {}
  for (const [k, c] of configs.entries()) {
    for (const [v, view] of VIEWS.entries()) {
      for (const [l, length] of LENGTHS.entries()) {
        const cell = tallies[k][v][l]
        if (cell[0] + cell[1] + cell[2]) grid[gridKey(c, view, length)] = cell
      }
    }
  }

  for (const pid of humans) for (const e of ons.get(pid) ?? []) if (!turnNear(e.rx)) t.events_without_words++

  // The bot, and participants that speak mostly while Alex does.
  const botPids = [...people].filter(([, p]) => p.botMatch !== 'none')
  const botOns = botPids.flatMap(([pid]) => ons.get(pid) ?? [])
  const selfMatch = zeros<BotMatch>(['exact', 'prefix', 'none'])
  for (const pid of selfCandidates) selfMatch[people.get(pid)?.botMatch ?? 'none']++

  // The roster.
  const host = zeros<'true' | 'false' | 'null'>(['true', 'false', 'null'])
  const platform = zeros<PlatformKind | 'null'>([...PLATFORM_KINDS, 'null'])
  const shape = zeros(NAME_SHAPES)
  const extra = zeros(EXTRA_KEYS)
  const dialShape = zeros(NAME_SHAPES)
  let stableId = 0
  let email = 0
  let dialIns = 0
  let dialSpoke = 0
  let labelled = 0
  for (const [pid, p] of people) {
    host[String(p.isHost) as 'true' | 'false' | 'null']++
    platform[p.platform ?? 'null']++
    shape[p.shape]++
    extra[p.extra]++
    if (p.stableId) stableId++
    if (p.email) email++
    if (p.labels.some(l => l.label !== null)) labelled++
    if (isDialIn(p)) {
      dialIns++
      dialShape[p.shape]++
      if (ons.get(pid)?.length) dialSpoke++
    }
  }

  const delay = Object.fromEntries(EVENT_KINDS.map(k => [k, samples(events.filter(e => e.kind === k).map(e => e.rx - e.at))])) as Record<EventKind, number[]>
  const spread = samples(events.map(e => e.at - e.rel * 1000))
  const countOf = zeros(EVENT_KINDS)
  for (const e of events) countOf[e.kind]++
  const firstBot = botPids[0]?.[1]

  return {
    kind: 'speaker-probe',
    v: 1,
    platform: s.platform,
    date: m.startedAt.toISOString().slice(0, 10),
    minutes: Math.max(0, Math.round((m.endedAt.getTime() - m.startedAt.getTime()) / 60_000)),
    ending: m.ending,
    endpoint: {
      connections: s.connections,
      replaced: s.replaced,
      closes: { ...s.closes },
      ping_timeouts: s.pingTimeouts,
      first_event_after_page_ms: s.firstEventAt !== null && s.pageAt !== null ? Math.round(s.firstEventAt - s.pageAt) : null,
      events_before_page: s.pageAt === null ? 0 : events.filter(e => e.rx < s.pageAt!).length,
      longest_quiet_s: Math.round(s.longestQuietMs / 1000),
      dropped: { ...s.dropped },
    },
    events: countOf,
    delay_ms: delay,
    recall_clock_spread_ms: spread.length ? Math.round(quantile(spread, 0.9)! - quantile(spread, 0.1)!) : null,
    flux: {
      turns: s.turns.length,
      timed: turns.filter(x => x.timed).length,
      word_times: s.turns.filter(x => x.wordTimes).length,
      dropped: s.turnsDropped,
      lag_ms: samples(s.lags),
    },
    agent: { audio_s: Math.round(alex.reduce((sum, a) => sum + (a.end - a.start), 0) / 100) / 10 },
    participants: {
      total: people.size,
      max_present: s.roster.maxPresent,
      first_seen_by: { ...s.roster.firstSeenBy },
      joins_first_5s: s.roster.joinsFirst5s,
      present_without_join: s.roster.presentWithoutJoin,
      rejoin_same_id: s.roster.rejoinSameId,
      rejoin_new_id: s.roster.rejoinNewId,
      renames: s.roster.renames,
      host_changes: s.roster.hostChanges,
      host,
      platform,
      name_shape: shape,
      extra_data: extra,
      stable_id: stableId,
      email_present: email,
      dial_in: { count: dialIns, name_shape: dialShape, spoke: dialSpoke },
      probe_labels: labelled,
    },
    bot: {
      seen: botPids.length > 0,
      name_match: botPids.some(([, p]) => p.botMatch === 'exact') ? 'exact' : botPids.length ? 'prefix' : 'unseen',
      is_host: firstBot ? (String(firstBot.isHost) as 'true' | 'false' | 'null') : 'unseen',
      speech_on: botOns.length,
      speech_on_while_agent: botOns.filter(e => inAlex(e.rx)).length,
      self_candidates: selfCandidates.size,
      self_candidate_name_match: selfMatch,
    },
    turns: {
      ...t,
      on_minus_sot_rx_ms: samples(onSot),
      on_minus_fw_rx_ms: samples(onFw),
      on_at_minus_fw_rx_ms: samples(onAtFw),
      off_minus_lw_rx_ms: samples(offLw),
      on_after_eot_ms: samples(afterEot),
      same_turn_gap_ms: samples(gaps),
    },
    scored: { ...scored, grid },
  }
}
