// Text-only meeting transcripts, kept on this computer and deleted after the retention period,
// as are the minutes written from them (src/minutes.ts).
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.ts'

export const TRANSCRIPTS_DIR = path.join(config.dataDir, 'transcripts')
export const MINUTES_DIR = path.join(config.dataDir, 'minutes')
// What the retention sweep deletes from: the chat notice promises both go after the retention period.
export const RECORD_DIRS: readonly string[] = [TRANSCRIPTS_DIR, MINUTES_DIR]

// Transcript files taken by this process, so two sessions started in the same minute for one
// meeting (the page reconnected) never share a file, nor the minutes named after it.
const taken = new Set<string>()

/** data/transcripts/<yyyy-mm-dd-hh-mm>-<key>.md, or with -2, -3 ... when that name is taken. */
function freeFile(meetingKey: string): string {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
  const base = `${stamp}-${meetingKey.replace(/[^a-zA-Z0-9_-]/g, '')}`
  for (let n = 1; ; n++) {
    const file = path.join(TRANSCRIPTS_DIR, `${base}${n > 1 ? `-${n}` : ''}.md`)
    if (!taken.has(file) && !fs.existsSync(file)) {
      taken.add(file)
      return file
    }
  }
}

/** Who said a line: the assistant, or anyone else in the meeting. Minutes depend on it, not on the label. */
export type Role = 'agent' | 'participant'

export interface Line {
  at: Date
  /** The label in the transcript: the assistant's name, or "Speaker" for everyone else. */
  speaker: string
  text: string
  role: Role
}

export class Transcript {
  readonly lines: Line[] = []
  readonly file: string
  // Set by delete(): nothing is written again, so a late line cannot bring the file back.
  private deleted = false

  constructor(readonly meetingKey: string) {
    // Transcripts are meeting content: readable by this user only.
    fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true, mode: 0o700 })
    this.file = freeFile(meetingKey)
  }

  get isDeleted(): boolean {
    return this.deleted
  }

  add(speaker: string, text: string, role: Role = 'participant'): void {
    if (this.deleted) return
    const line = { at: new Date(), speaker, text, role }
    this.lines.push(line)
    fs.appendFileSync(this.file, `[${line.at.toISOString().slice(11, 19)}] ${speaker}: ${text}\n`, { mode: 0o600 })
  }

  /** Every line, as the transcript file has it: "[hh:mm:ss] Speaker: text" (UTC). */
  text(): string {
    return this.lines.map(l => `[${l.at.toISOString().slice(11, 19)}] ${l.speaker}: ${l.text}`).join('\n')
  }

  /** True once anyone but the assistant has said something. */
  participantsSpoke(): boolean {
    return this.lines.some(l => l.role === 'participant')
  }

  /** The most recent lines, newest last, capped by character count. */
  recent(maxChars = 12000): string {
    const out: string[] = []
    let size = 0
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const l = this.lines[i]
      const s = `${l.speaker}: ${l.text}`
      if (size + s.length > maxChars) break
      out.unshift(s)
      size += s.length + 1
    }
    return out.join('\n')
  }

  /** Deletes the transcript, and makes sure nothing more is written to it. */
  delete(): void {
    this.deleted = true
    this.lines.length = 0
    fs.rmSync(this.file, { force: true })
  }
}

/** Removes transcripts and minutes older than the retention period. Says how many files went. */
export function sweepOldRecords(now = Date.now(), dirs: readonly string[] = RECORD_DIRS): number {
  const cutoff = now - config.retentionDays * 86_400_000
  let removed = 0
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name)
      // A transcript deleted meanwhile (the assistant was asked to leave) must not stop the sweep.
      const stat = fs.statSync(file, { throwIfNoEntry: false })
      if (stat?.isFile() && stat.mtimeMs < cutoff) {
        fs.rmSync(file, { force: true })
        removed++
      }
    }
  }
  return removed
}
