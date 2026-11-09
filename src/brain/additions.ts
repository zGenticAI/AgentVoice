// What the owner's session adds to the brief during a meeting: facts it gets ahead of questions with, and
// the answers it gives. Alex's fast tier answers from them as from the brief, so a follow-up ("what was
// the third step again?") is answered at once instead of being handed to the session again.
// Kept in memory for that meeting only, never on disk.

/** The most the additions hold, in characters. More would make every spoken answer slower. */
export const MAX_ADDITIONS_CHARS = 8000

export class BriefAdditions {
  private entries: string[] = []
  private chars = 0

  /**
   * Keeps one addition. Empty text is ignored. When the additions would pass MAX_ADDITIONS_CHARS, the
   * oldest go first, and how many is reported; an addition longer than that on its own is cut to it.
   */
  add(text: string): { added: boolean; dropped: number } {
    const entry = text.trim().slice(0, MAX_ADDITIONS_CHARS)
    if (!entry) return { added: false, dropped: 0 }
    let dropped = 0
    while (this.entries.length && this.chars + entry.length > MAX_ADDITIONS_CHARS) {
      this.chars -= this.entries.shift()!.length
      dropped++
    }
    this.entries.push(entry)
    this.chars += entry.length
    return { added: true, dropped }
  }

  /** The additions as a bullet list, oldest first ('' when there are none). */
  text(): string {
    // Later lines of an addition are indented, so each one stays a single bullet.
    return this.entries.map(e => `- ${e.replace(/\n/g, '\n  ')}`).join('\n')
  }

  clear(): void {
    this.entries = []
    this.chars = 0
  }

  get size(): number {
    return this.entries.length
  }
}
