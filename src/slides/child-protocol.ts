// What the prepare parent (convert.ts) and the converter child (render-child.ts) say to each other: the job, as the
// child's one argument, and the JSON lines it writes to stdout. Types only.
import type { WarningCode } from './manifest.ts'

/** What the parent asks for. */
export interface Job {
  /** The copy of the PDF in the job's temporary folder. */
  input: string
  /** Where the images go. */
  out: string
  /** Page numbers never to render or read. */
  exclude: number[]
  /** The parent's time limit: the child ends itself after it too, should the parent be gone. */
  timeoutMs: number
}

/** Why the child stopped without a deck. */
export type RefusedReason =
  | 'no-canvas' | 'unreadable' | 'password' | 'too-many-pages' | 'exclude-range' | 'all-excluded' | 'page-failed' | 'page-slow' | 'page-too-big'
  | 'memory'

export type ChildMessage =
  | { type: 'open'; pages: number }
  | {
      type: 'page'
      n: number
      title: string
      pageLabel: string | null
      text: string
      /** Sticky notes on the page (Marp's speaker notes): for the skeleton script only, never the deck. */
      notes: string
      warnings: WarningCode[]
      /** pdf.js warnings on this page that are neither of the two above: counted, never kept. */
      other: number
    }
  | { type: 'done'; other: number }
  | { type: 'refused'; reason: RefusedReason; page?: number; pages?: number; name?: string }
