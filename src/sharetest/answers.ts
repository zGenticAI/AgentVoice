// What the screen-share test asks the owner in the terminal, and how it reads the answers. Pure.
import type { Platform } from '../recall.ts'
import { LADDER_PX } from './protocol.ts'

export type YesNo = 'y' | 'n' | 's'

/** y, n or s (skip), in any case and spelt out; null for anything else, the empty line included: ask again. */
export function readYesNo(line: string): YesNo | null {
  const a = line.trim().toLowerCase()
  if (a === 'y' || a === 'yes') return 'y'
  if (a === 'n' || a === 'no') return 'n'
  if (a === 's' || a === 'skip') return 's'
  return null
}

/** For "press Enter once it has answered, or type n": the empty line is a yes. */
export function readEnterOrNo(line: string): YesNo | null {
  return line.trim() === '' ? 'y' : readYesNo(line)
}

/** A size from the ladder ('16 px'), 'none', or 's'; null for anything else: ask again. */
export function readLadder(line: string): string | null {
  const a = line.trim().toLowerCase().replace(/\s*px$/, '')
  if (a === 'none' || a === 's' || a === 'skip') return a === 'none' ? 'none' : 's'
  const n = Number(a)
  return (LADDER_PX as readonly number[]).includes(n) ? `${n} px` : null
}

/** Where the platform lets a guest share its screen: what to check before the test, and when the share is not seen. */
export function platformHint(platform: Platform, name: string): string {
  if (platform === 'zoom') {
    return 'In Zoom, "Who can share?" must be "All participants": in the meeting, the arrow beside Share, then Advanced sharing options.'
  }
  if (platform === 'google_meet') {
    return 'In Google Meet, open Host controls and turn on "Share their screen", or turn Host management off.'
  }
  return `In Microsoft Teams, "Who can present" must include everyone (Meeting options), or make ${name} a presenter: in People, the "..." beside its name, then Make a presenter.`
}
