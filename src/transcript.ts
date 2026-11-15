// Text-only meeting transcripts, kept on this computer and deleted after the retention period,
// as are the minutes written from them (src/minutes.ts).
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.ts'

export const TRANSCRIPTS_DIR = path.join(config.dataDir, 'transcripts')
export const MINUTES_DIR = path.join(config.dataDir, 'minutes')
// The speaker probe's measurements (src/speakers/probe.ts), one file per meeting, named as its transcript is.
export const PROBE_DIR = path.join(config.dataDir, 'speaker-probe')
// What the retention sweep deletes from: the chat notice promises both go after the retention period, and the probe's
// measurements go with them.
export const RECORD_DIRS: readonly string[] = [TRANSCRIPTS_DIR, MINUTES_DIR, PROBE_DIR]

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

  /** Adds a line, and says which it is (to amend later), or null once the transcript has been deleted. */
  add(speaker: string, text: string, role: Role = 'participant'): Line | null {
    if (this.deleted) return null
    const line = { at: new Date(), speaker, text, role }
    this.lines.push(line)
    fs.appendFileSync(this.file, `${fileLine(line)}\n`, { mode: 0o600 })
    return line
  }

  /**
   * Changes what a line says, in memory and in the file, or takes it out when the text is empty: for a line of the
   * assistant's that the meeting didn't hear to the end (src/pipeline/playback.ts). Nothing once deleted. Never throws:
   * when the file can't be written, memory still changes and the error's code is logged.
   */
  amend(line: Line, text: string): void {
    const at = this.lines.indexOf(line)
    if (this.deleted || at < 0) return
    if (text) line.text = text
    else this.lines.splice(at, 1)
    // The file holds the same lines as memory, so it is written again from them, to a file beside it that then takes
    // its place in one step: a crash leaves the old transcript or the new one, never part of one.
    const next = `${this.file}.next`
    try {
      fs.writeFileSync(next, this.lines.map(l => `${fileLine(l)}\n`).join(''), { mode: 0o600 })
      fs.renameSync(next, this.file)
    } catch (err) {
      // This runs as a session ends and as the service stops, which a full or failing disk must not get in the way of.
      // The file keeps the line whole; memory, which the minutes and the next answers are made from, has it right.
      // No copy of the transcript is left beside it, and the log has the error's code only, never meeting content.
      try {
        fs.rmSync(next, { force: true })
      } catch {
        // Removed with the transcript (delete, and forget in src/pipeline/session.ts), or by the retention sweep.
      }
      console.error(`[transcript] could not correct a line in the transcript file: ${(err as NodeJS.ErrnoException).code ?? 'error'}`)
    }
  }

  /** Every line, as the transcript file has it: "[hh:mm:ss] Speaker: text" (UTC). */
  text(): string {
    return this.lines.map(fileLine).join('\n')
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
    fs.rmSync(`${this.file}.next`, { force: true })
  }
}

/** A line as the transcript file has it: "[hh:mm:ss] Speaker: text" (UTC). */
function fileLine(line: Line): string {
  return `[${line.at.toISOString().slice(11, 19)}] ${line.speaker}: ${line.text}`
}

/** What a retention sweep did: how many files went, how many it had to leave, and the first failure's code. */
export interface Swept {
  removed: number
  /** Files it could not look at or delete, and folders it could not read. */
  failed: number
  /** ENOENT, EPERM and the like, or 'error': never the error's message, which names the file. */
  code: string
}

/**
 * Removes transcripts, minutes and the probe's measurements older than the retention period. A file it can't delete
 * (a read-only disk, say) doesn't stop it: the others still go, and the next sweep tries that one again.
 */
export function sweepOldRecords(now = Date.now(), dirs: readonly string[] = RECORD_DIRS): Swept {
  const cutoff = now - config.retentionDays * 86_400_000
  const swept: Swept = { removed: 0, failed: 0, code: '' }
  const failed = (err: unknown) => {
    swept.failed++
    const code = (err as NodeJS.ErrnoException)?.code
    swept.code ||= typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'error'
  }
  for (const dir of dirs) {
    let names: string[]
    try {
      if (!fs.existsSync(dir)) continue
      names = fs.readdirSync(dir)
    } catch (err) {
      failed(err)
      continue
    }
    for (const name of names) {
      const file = path.join(dir, name)
      try {
        // A transcript deleted meanwhile (the assistant was asked to leave) must not stop the sweep.
        const stat = fs.statSync(file, { throwIfNoEntry: false })
        if (stat?.isFile() && stat.mtimeMs < cutoff) {
          fs.rmSync(file, { force: true })
          swept.removed++
        }
      } catch (err) {
        failed(err)
      }
    }
  }
  return swept
}
