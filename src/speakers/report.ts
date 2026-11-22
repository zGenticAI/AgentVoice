// npm run speaker-report: pools the speaker probe's files (data/speaker-probe/*.json) by platform, and says what they
// measured. It only reads: regular files with the probe's kind and version, nothing else (no links). How to read it is
// in docs/speaker-probe.md.
import fs from 'node:fs'
import path from 'node:path'
import { WORDS } from '../commands.ts'
import { identity } from '../identity.ts'
import { type Platform, PLATFORM_NAMES } from '../recall.ts'
import { GRID, gridConfigs, gridKey, quantile } from './probe.ts'

// A file larger than this is not one the probe wrote (a meeting's is about 30 KB at most).
const MAX_FILE_BYTES = 4 * 1024 * 1024
/** How many scored normal turns a platform needs before its settings say anything. */
export const ENOUGH_TURNS = 40
/** The least share right that a setting must have to be listed. */
export const MIN_PRECISION = 0.98
const PLATFORMS = Object.keys(PLATFORM_NAMES) as Platform[]

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {})
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const nums = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)) : [])

/** The probe's files in dir: those it can read as the probe's, and how many it skipped. Reads only regular files. */
export function readProbeFiles(dir: string): { files: Obj[]; skipped: number } {
  const files: Obj[] = []
  let skipped = 0
  let names: string[]
  try {
    names = fs.readdirSync(dir).filter(name => name.endsWith('.json')).sort()
  } catch {
    return { files, skipped }
  }
  for (const name of names) {
    const file = path.join(dir, name)
    try {
      // Not a link, whatever it points to, nor anything but a file.
      const stat = fs.lstatSync(file)
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('not a file of the probe')
      const data = obj(JSON.parse(fs.readFileSync(file, 'utf8')))
      if (data.kind !== 'speaker-probe' || data.v !== 1 || !PLATFORMS.includes(data.platform as Platform)) throw new Error('not the probe')
      files.push(data)
    } catch {
      skipped++
    }
  }
  return { files, skipped }
}

/** Timings pooled from every meeting: how many, the 10th, 50th and 90th percentiles, and the spread between 25th and 75th. */
export interface Spread {
  n: number
  p10: number | null
  p50: number | null
  p90: number | null
  iqr: number | null
}

function spread(values: number[]): Spread {
  const sorted = [...values].sort((a, b) => a - b)
  const q = (p: number) => {
    const v = quantile(sorted, p)
    return v === null ? null : Math.round(v)
  }
  const q1 = quantile(sorted, 0.25)
  const q3 = quantile(sorted, 0.75)
  return { n: sorted.length, p10: q(0.1), p50: q(0.5), p90: q(0.9), iqr: q1 === null || q3 === null ? null : Math.round(q3 - q1) }
}

/** The timings the report shows, by where they are in a file, and what each says. */
export const METRICS: { key: string; at: (f: Obj) => unknown; label: string }[] = [
  { key: 'on_minus_fw_rx_ms', at: f => obj(f.turns).on_minus_fw_rx_ms, label: "speech_on's arrival, from the first word's" },
  { key: 'on_at_minus_fw_rx_ms', at: f => obj(f.turns).on_at_minus_fw_rx_ms, label: "speech_on by Recall's clock, from the first word's arrival" },
  { key: 'on_minus_sot_rx_ms', at: f => obj(f.turns).on_minus_sot_rx_ms, label: "speech_on's arrival, from Flux's StartOfTurn" },
  { key: 'off_minus_lw_rx_ms', at: f => obj(f.turns).off_minus_lw_rx_ms, label: "speech_off's arrival, from the last word's" },
  { key: 'on_after_eot_ms', at: f => obj(f.turns).on_after_eot_ms, label: 'speech_on that came after the turn ended, by how much' },
  { key: 'same_turn_gap_ms', at: f => obj(f.turns).same_turn_gap_ms, label: "gaps in one speaker's speaking within a turn" },
  { key: 'delay_speech_on_ms', at: f => obj(f.delay_ms).speech_on, label: "speech_on's arrival, from Recall's time for it" },
  { key: 'delay_speech_off_ms', at: f => obj(f.delay_ms).speech_off, label: "speech_off's arrival, from Recall's time for it" },
  { key: 'flux_lag_ms', at: f => obj(f.flux).lag_ms, label: "audio sent to Flux, ahead of its turn's audio window" },
]

/** Adds up the numbers in objects of counts (one level). */
function addCounts(into: Record<string, number>, from: unknown): void {
  for (const [k, v] of Object.entries(obj(from))) into[k] = (into[k] ?? 0) + num(v)
}

const sum = (files: Obj[], at: (f: Obj) => unknown) => files.reduce((n, f) => n + num(at(f)), 0)

/** One setting of the grid, by how it did on the end-of-turn view, for normal turns. */
export interface RankedSetting {
  setting: string
  correct: number
  wrong: number
  abstain: number
  precision: number
  coverage: number
  /** The same setting on short turns, and with what Recall had sent 10 s later. */
  short_precision: number | null
  settled_coverage: number | null
}

/** What one platform's files say, pooled. */
export function poolPlatform(files: Obj[]) {
  const timings = Object.fromEntries(METRICS.map(m => [m.key, spread(files.flatMap(f => nums(m.at(f))))]))
  // Each meeting's median: whether the timing stays put from one meeting to the next.
  const medians = files.map(f => quantile([...nums(obj(f.turns).on_minus_fw_rx_ms)].sort((a, b) => a - b), 0.5)).filter((v): v is number => v !== null)
  const turnKeys = ['with_words', 'single', 'crowded', 'no_event', 'while_agent', 'already_open', 'short', 'on_after_eot', 'events_without_words']
  const turns = Object.fromEntries(turnKeys.map(k => [k, sum(files, f => obj(f.turns)[k])]))
  const counts = (at: (f: Obj) => unknown) => {
    const into: Record<string, number> = {}
    for (const f of files) addCounts(into, at(f))
    return into
  }
  const added = (k: string) => sum(files, f => obj(f.participants)[k])
  const participants = {
    total: added('total'),
    joins_first_5s: added('joins_first_5s'),
    present_without_join: added('present_without_join'),
    rejoin_same_id: added('rejoin_same_id'),
    rejoin_new_id: added('rejoin_new_id'),
    renames: added('renames'),
    host_changes: added('host_changes'),
    stable_id: added('stable_id'),
    email_present: added('email_present'),
    probe_labels: added('probe_labels'),
    max_present: Math.max(0, ...files.map(f => num(obj(f.participants).max_present))),
    first_seen_by: counts(f => obj(f.participants).first_seen_by),
    platform: counts(f => obj(f.participants).platform),
    name_shape: counts(f => obj(f.participants).name_shape),
    extra_data: counts(f => obj(f.participants).extra_data),
    dial_in: {
      count: sum(files, f => obj(obj(f.participants).dial_in).count),
      spoke: sum(files, f => obj(obj(f.participants).dial_in).spoke),
      name_shape: counts(f => obj(obj(f.participants).dial_in).name_shape),
    },
  }
  const bot = {
    meetings_seen: files.filter(f => obj(f.bot).seen === true).length,
    name_match: Object.fromEntries(['exact', 'prefix', 'unseen'].map(k => [k, files.filter(f => obj(f.bot).name_match === k).length])),
    speech_on: sum(files, f => obj(f.bot).speech_on),
    speech_on_while_agent: sum(files, f => obj(f.bot).speech_on_while_agent),
    self_candidates: sum(files, f => obj(f.bot).self_candidates),
    self_candidate_name_match: counts(f => obj(f.bot).self_candidate_name_match),
  }
  const endpoint = {
    connections: sum(files, f => obj(f.endpoint).connections),
    replaced: sum(files, f => obj(f.endpoint).replaced),
    ping_timeouts: sum(files, f => obj(f.endpoint).ping_timeouts),
    meetings_without_events: files.filter(f => num(obj(f.endpoint).connections) === 0 || !Object.values(obj(f.events)).some(v => num(v) > 0)).length,
    closes: counts(f => obj(f.endpoint).closes),
    dropped: counts(f => obj(f.endpoint).dropped),
    events_before_page: sum(files, f => obj(f.endpoint).events_before_page),
    first_event_after_page_ms: spread(files.map(f => obj(f.endpoint).first_event_after_page_ms).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))),
    longest_quiet_s: Math.max(0, ...files.map(f => num(obj(f.endpoint).longest_quiet_s))),
  }
  const grid: Record<string, [number, number, number]> = {}
  for (const f of files) {
    for (const [key, cell] of Object.entries(obj(obj(f.scored).grid))) {
      const [c, w, a] = Array.isArray(cell) ? cell.map(num) : [0, 0, 0]
      const into = (grid[key] ??= [0, 0, 0])
      into[0] += c
      into[1] += w
      into[2] += a
    }
  }
  const tally = (key: string) => grid[key] ?? [0, 0, 0]
  // Every setting sees the same scored turns, so any one says how many there were.
  const [c0, w0, a0] = tally(gridKey(gridConfigs()[0], 'eot', 'normal'))
  const scoredNormal = c0 + w0 + a0
  const ranked: RankedSetting[] = gridConfigs()
    .map(c => {
      const [correct, wrong, abstain] = tally(gridKey(c, 'eot', 'normal'))
      const [sc, sw] = tally(gridKey(c, 'eot', 'short'))
      const [tc, tw, ta] = tally(gridKey(c, 'settled', 'normal'))
      const all = correct + wrong + abstain
      return {
        setting: gridKey(c, 'eot', 'normal').split('|').slice(0, 5).join('|'),
        tolerance: c.startTol + c.endTol,
        correct,
        wrong,
        abstain,
        precision: correct + wrong ? correct / (correct + wrong) : 0,
        coverage: all ? correct / all : 0,
        short_precision: sc + sw ? sc / (sc + sw) : null,
        settled_coverage: tc + tw + ta ? tc / (tc + tw + ta) : null,
      }
    })
    .filter(r => r.correct + r.wrong > 0 && r.precision >= MIN_PRECISION)
    .sort((a, b) => b.coverage - a.coverage || a.tolerance - b.tolerance)
    .map(({ tolerance: _, ...r }) => r)
  return {
    meetings: files.length,
    minutes: sum(files, f => f.minutes),
    endings: Object.fromEntries(['ended', 'unconfirmed', 'stopped'].map(k => [k, files.filter(f => f.ending === k).length])),
    flux: {
      turns: sum(files, f => obj(f.flux).turns),
      timed: sum(files, f => obj(f.flux).timed),
      word_times: sum(files, f => obj(f.flux).word_times),
    },
    turns,
    scored: { turns: sum(files, f => obj(f.scored).turns), unmapped: sum(files, f => obj(f.scored).unmapped), normal: scoredNormal },
    timings,
    on_minus_fw_rx_median_per_meeting: medians.length ? { min: Math.round(Math.min(...medians)), max: Math.round(Math.max(...medians)) } : null,
    recall_clock_spread_ms: spread(files.map(f => f.recall_clock_spread_ms).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))),
    participants,
    bot,
    endpoint,
    enough: scoredNormal >= ENOUGH_TURNS,
    settings: ranked,
    grid,
  }
}

export type PooledPlatform = ReturnType<typeof poolPlatform>

/** Every platform's pooled numbers, for the platforms that have files. */
export function pool(files: Obj[]): Partial<Record<Platform, PooledPlatform>> {
  const out: Partial<Record<Platform, PooledPlatform>> = {}
  for (const platform of PLATFORMS) {
    const mine = files.filter(f => f.platform === platform)
    if (mine.length) out[platform] = poolPlatform(mine)
  }
  return out
}

const pct = (v: number | null) => (v === null ? '-' : `${Math.round(v * 1000) / 10}%`)
const counted = (counts: Record<string, number>) =>
  Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k.replace(/_/g, ' ')} ${n}`)
    .join(', ') || 'none'

/** The report as text. */
export function formatReport(pooled: Partial<Record<Platform, PooledPlatform>>, o: { dir: string; files: number; skipped: number }): string {
  const lines: string[] = []
  lines.push(`Speaker probe: ${o.files} meeting file(s) in ${o.dir}${o.skipped ? ` (${o.skipped} skipped: not the probe's)` : ''}.`)
  if (!o.files) {
    lines.push(`Nothing measured yet. See ${WORDS.doc('speaker-probe')} for how to run a test meeting.`)
    return lines.join('\n')
  }
  for (const [platform, p] of Object.entries(pooled) as [Platform, PooledPlatform][]) {
    lines.push('', `${PLATFORM_NAMES[platform]}: ${p.meetings} meeting(s), ${p.minutes} minutes (${counted(p.endings)})`)
    lines.push(`  Turns: ${p.flux.turns}, ${p.flux.timed} timed (${p.flux.word_times} by word times). ${counted(p.turns)}`)
    lines.push(`  Scored turns: ${p.scored.turns} (${p.scored.normal} normal), ${p.scored.unmapped} with a code word nobody had`)
    lines.push('  Timings (ms)                                                          n     p10     p50     p90     IQR')
    for (const m of METRICS) {
      const t = p.timings[m.key]
      const cell = (v: number | null) => String(v ?? '-').padStart(8)
      lines.push(`    ${m.label.padEnd(64)}${String(t.n).padStart(5)}${cell(t.p10)}${cell(t.p50)}${cell(t.p90)}${cell(t.iqr)}`)
    }
    if (p.on_minus_fw_rx_median_per_meeting) {
      lines.push(`  speech_on from the first word, each meeting's median: ${p.on_minus_fw_rx_median_per_meeting.min} to ${p.on_minus_fw_rx_median_per_meeting.max} ms`)
    }
    if (p.recall_clock_spread_ms.n) lines.push(`  Recall's clock against its own relative time, p90 - p10, per meeting: median ${p.recall_clock_spread_ms.p50} ms`)
    const r = p.participants
    lines.push(
      `  Participants: ${r.total} (at most ${r.max_present} at once). First seen by: ${counted(r.first_seen_by)}. ` +
        `Joins in the first 5 s: ${r.joins_first_5s}; present without a join: ${r.present_without_join}; ` +
        `re-joins with the same id: ${r.rejoin_same_id}, with a new id: ${r.rejoin_new_id}; renames: ${r.renames}; host changes: ${r.host_changes}`,
    )
    lines.push(`    Platform: ${counted(r.platform)}. Names: ${counted(r.name_shape)}. Extra data: ${counted(r.extra_data)}; a stable id: ${r.stable_id}; an email: ${r.email_present}`)
    lines.push(`    Dial-in: ${r.dial_in.count}, of whom ${r.dial_in.spoke} spoke. Their names: ${counted(r.dial_in.name_shape)}`)
    const b = p.bot
    lines.push(
      `  The bot: seen in ${b.meetings_seen} of ${p.meetings} meeting(s) (by name: ${counted(b.name_match)}); its speech_on: ${b.speech_on}, ` +
        `${b.speech_on_while_agent} during ${identity.name}'s audio; others speaking mostly then: ${b.self_candidates} (${counted(b.self_candidate_name_match)})`,
    )
    const e = p.endpoint
    lines.push(
      `  Events connection: ${e.connections} connection(s), ${e.replaced} replaced, ${e.ping_timeouts} silent; closes: ${counted(e.closes)}; ` +
        `dropped: ${counted(e.dropped)}; meetings with no events: ${e.meetings_without_events}`,
    )
    lines.push(
      `    First event after the page connected: p50 ${e.first_event_after_page_ms.p50 ?? '-'} ms, p90 ${e.first_event_after_page_ms.p90 ?? '-'} ms; ` +
        `events before the page: ${e.events_before_page}; longest quiet: ${e.longest_quiet_s} s`,
    )
    if (!p.enough) {
      lines.push(`  Settings: not enough data (${p.scored.normal} scored normal turns; ${ENOUGH_TURNS} needed).`)
      continue
    }
    lines.push(`  Settings right at least ${MIN_PRECISION * 100}% of the time (end of turn, normal turns), by coverage:`)
    lines.push(`    (clock|before ms|after ms|least share|ratio)`)
    if (!p.settings.length) lines.push('    none')
    for (const s of p.settings.slice(0, 10)) {
      lines.push(
        `    ${s.setting.padEnd(26)} coverage ${pct(s.coverage).padStart(6)}, right ${pct(s.precision).padStart(6)} ` +
          `(${s.correct} right, ${s.wrong} wrong, ${s.abstain} none); short turns right ${pct(s.short_precision)}; 10 s later coverage ${pct(s.settled_coverage)}`,
      )
    }
  }
  lines.push('', `How to read this: ${WORDS.doc('speaker-probe')}. Grid: clocks ${GRID.clock.join(', ')}.`)
  return lines.join('\n')
}
