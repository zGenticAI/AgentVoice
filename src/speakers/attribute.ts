// Who spoke a turn, from when each participant was speaking (their speech_on to speech_off): the one whose speaking
// covers most of the turn, if it covers enough of it and clearly more than anyone else's; otherwise nobody. Pure, so the
// speaker probe (src/speakers/probe.ts) can try it with many settings, and speaker names can later use it as it is.

/** One stretch of a participant speaking (ms, on one clock). end null: still speaking. */
export interface Interval {
  pid: number
  start: number
  end: number | null
}

export interface AttributeOptions {
  /** How far before the turn's first word and after its last a participant's speaking still counts (ms). */
  startTol: number
  endTol: number
  /** The least share of that window the winner's speaking must cover. */
  minShare: number
  /** How many times the runner-up's overlap the winner's must be. */
  ratio: number
  /** Where a stretch still going ends (ms). */
  now: number
  /** Stretches of one participant this close together count as one (Zoom sends a burst of them for one turn). */
  mergeGapMs?: number
  /** Participants never chosen: the assistant's own bot. */
  exclude?: ReadonlySet<number>
}

/** Each participant's stretches, sorted and merged when they are within mergeGapMs of each other. */
export function mergeIntervals(intervals: readonly Interval[], now: number, mergeGapMs = 0, exclude?: ReadonlySet<number>): Map<number, [number, number][]> {
  const byPid = new Map<number, [number, number][]>()
  for (const i of intervals) {
    if (exclude?.has(i.pid)) continue
    const end = i.end ?? now
    if (end < i.start) continue
    let list = byPid.get(i.pid)
    if (!list) byPid.set(i.pid, (list = []))
    list.push([i.start, end])
  }
  for (const [pid, list] of byPid) {
    list.sort((a, b) => a[0] - b[0])
    const merged: [number, number][] = []
    for (const [start, end] of list) {
      const last = merged.at(-1)
      if (last && start - last[1] <= mergeGapMs) last[1] = Math.max(last[1], end)
      else merged.push([start, end])
    }
    byPid.set(pid, merged)
  }
  return byPid
}

/** The participant who spoke the turn (span: its first and last word), with the share of the window they cover, or null. */
export function attribute(intervals: readonly Interval[], span: { start: number; end: number }, o: AttributeOptions): { pid: number; share: number } | null {
  return attributeMerged(mergeIntervals(intervals, o.now, o.mergeGapMs ?? 0, o.exclude), span, o)
}

/** attribute(), for stretches already merged (mergeIntervals), so many settings can be tried on one turn cheaply. */
export function attributeMerged(
  merged: ReadonlyMap<number, readonly (readonly [number, number])[]>,
  span: { start: number; end: number },
  o: Pick<AttributeOptions, 'startTol' | 'endTol' | 'minShare' | 'ratio'>,
): { pid: number; share: number } | null {
  const from = span.start - o.startTol
  const to = span.end + o.endTol
  const width = to - from
  if (!(width > 0)) return null
  let best = { pid: -1, overlap: 0 }
  let second = 0
  for (const [pid, list] of merged) {
    let overlap = 0
    for (const [start, end] of list) overlap += Math.max(0, Math.min(end, to) - Math.max(start, from))
    if (overlap > best.overlap) {
      second = best.overlap
      best = { pid, overlap }
    } else if (overlap > second) {
      second = overlap
    }
  }
  if (best.pid < 0) return null
  const share = best.overlap / width
  if (share < o.minShare || best.overlap < o.ratio * second) return null
  return { pid: best.pid, share }
}
