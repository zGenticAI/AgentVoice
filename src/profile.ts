// The owner's profile: standing prose about the owner and their work, in a markdown file of its own (PROFILE_FILE,
// profile.md in this folder unless set; gitignored, with profile.example.md to copy). The short values that go into
// sentences (the names, the company) are in .env instead (src/identity.ts). Markdown, because the readers are
// language models and the writer need not be a programmer. Five sections, each optional:
//
// - "## About": one to three sentences of standing context. The spoken answers' rules start with it (src/brain/brain.ts).
// - "## Hand to the session": which questions the assistant hands to the owner's Claude Code session.
// - "## Knowledge sources": where the meeting-assistant agent looks, what each source is for, and any rule per source.
// - "## Never share": standing disclosure rules for the session and the agent, on top of their own.
// - "## Never open": more paths the agent must not read, on top of its own.
//
// A missing profile.md, or a missing section, means the generic default (see the uses). A file PROFILE_FILE names that
// isn't there, or a profile that is there but can't be read, is a problem: the service and the channel refuse to
// start, since it holds the owner's Never share and Never open, which a typo must not drop. Any other "## " heading
// is ignored, with a warning, so a misspelt one is not silently lost: npm run check lists what it found. HTML comments are left out,
// so the example's notes can stay in a copy. The spoken answers' rules are built from it once, at start-up, so the
// prompt cache keeps them; the channel's get_profile tool reads it again at every call, so an edit reaches the
// session's agent without a restart.
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, pathSetting } from './env.ts'

/** The sections, by key, with their headings as the file writes them. */
export const PROFILE_SECTIONS = {
  about: 'About',
  handOff: 'Hand to the session',
  sources: 'Knowledge sources',
  neverShare: 'Never share',
  neverOpen: 'Never open',
} as const

export type ProfileSection = keyof typeof PROFILE_SECTIONS

export interface OwnerProfile {
  /** The file it was read from. */
  readonly file: string
  /** Whether the file was there to read. */
  readonly found: boolean
  /**
   * Why the profile can't be used, or '': PROFILE_FILE names a file that isn't there, or the file can't be read. The
   * service and the channel refuse to start with one; get_profile says it.
   */
  readonly problem: string
  /** Each section's text, '' when it is missing or empty. */
  readonly sections: Readonly<Record<ProfileSection, string>>
  /** What reading it warned about: "[profile] ..." lines. */
  readonly warnings: readonly string[]
}

/** The topics handed to the owner's session when the profile names none. */
export const DEFAULT_HAND_OFF = 'current work, repos, documents, decisions, plans, design detail, positioning or how it compares with other products'

/** The most the About section should hold, in characters: it goes into every spoken answer's prompt. */
export const MAX_ABOUT_CHARS = 600

const EMPTY: Record<ProfileSection, string> = { about: '', handOff: '', sources: '', neverShare: '', neverOpen: '' }

/** A heading as compared: spaces collapsed, lower case, a closing colon dropped. */
const headingKey = (heading: string) => heading.replace(/\s+/g, ' ').replace(/:$/, '').trim().toLowerCase()
const BY_HEADING = new Map(Object.entries(PROFILE_SECTIONS).map(([key, heading]) => [headingKey(heading), key as ProfileSection]))

/** The profile in this text, from this file. Text before the first "## " heading (a title, say) is not read. */
export function parseProfile(text: string, file: string): OwnerProfile {
  const sections = { ...EMPTY }
  const warnings: string[] = []
  const name = path.basename(file)
  let current: ProfileSection | null = null
  const kept: Record<ProfileSection, string[]> = { about: [], handOff: [], sources: [], neverShare: [], neverOpen: [] }
  for (const line of text.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?(?:-->|$)/g, '').split('\n')) {
    const heading = /^##(?!#)\s*(.*?)\s*#*\s*$/.exec(line)
    if (heading) {
      current = BY_HEADING.get(headingKey(heading[1])) ?? null
      if (!current) {
        warnings.push(
          `[profile] ${name}: "## ${heading[1]}" is not a section the assistant reads (${Object.values(PROFILE_SECTIONS).join(', ')}), ` +
            'so it is ignored. Check its spelling.',
        )
      }
      continue
    }
    if (current) kept[current].push(line)
  }
  for (const key of Object.keys(kept) as ProfileSection[]) sections[key] = kept[key].join('\n').trim()
  if (sections.about.length > MAX_ABOUT_CHARS) {
    warnings.push(
      `[profile] ${name}: "## About" is ${sections.about.length} characters long. It goes into the prompt of every spoken answer, ` +
        `so keep it to one to three sentences (${MAX_ABOUT_CHARS} characters at most): longer detail belongs in the brief or a knowledge source.`,
    )
  }
  return Object.freeze({ file, found: true, problem: '', sections: Object.freeze(sections), warnings: Object.freeze(warnings) })
}

/**
 * The profile in this file. A missing profile.md is the generic defaults: it is optional. A file that PROFILE_FILE
 * names (`named`) and that isn't there, or a profile that is there but can't be read, has a `problem` (and the
 * defaults' sections, for get_profile to say so with).
 */
export function readProfile(file: string, named = false): OwnerProfile {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    const which = named ? `PROFILE_FILE names ${file}` : file
    const fix = named ? 'fix the path in .env, or remove PROFILE_FILE to use profile.md in this folder (or none)' : 'make it readable, or remove it'
    const problem =
      code === 'ENOENT' && !named
        ? ''
        : `${which}, which ${code === 'ENOENT' ? "doesn't exist" : `can't be read (${code ?? (err as Error).message})`}. It holds your ` +
          `Never share and Never open, so the service and the channel don't start without it: ${fix}.`
    return Object.freeze({ file, found: false, problem, sections: Object.freeze({ ...EMPTY }), warnings: Object.freeze([]) })
  }
  return parseProfile(text, file)
}

/** Where the profile is: PROFILE_FILE (a leading "~" is the home folder, a relative path is from this folder), else profile.md here. */
export function profileFile(env: Record<string, string | undefined> = process.env): { file: string; named: boolean } {
  const set = env.PROFILE_FILE?.trim()
  return set ? { file: pathSetting(set), named: true } : { file: path.join(ROOT, 'profile.md'), named: false }
}

/** Reads the profile PROFILE_FILE names again: for get_profile, so an edit applies without a restart. */
export function loadProfile(): OwnerProfile {
  const { file, named } = profileFile()
  return readProfile(file, named)
}

/**
 * The profile as this process read it at start-up: what the spoken answers' rules are built from. Its warnings are
 * not printed here; the service and the channel write them to stderr when they start, and npm run check prints them.
 */
export const PROFILE: OwnerProfile = loadProfile()

/** A section as one paragraph: its lines joined with spaces, list markers dropped. For a sentence of a prompt. */
export function paragraph(text: string): string {
  return items(text).join(' ')
}

/**
 * A section as a list for one line of a prompt: a markdown list is its items joined with "; ", each without its
 * closing full stop or comma; any other text is one paragraph, as it is. "current work, repos, decisions" stays as it is.
 */
export function inlineList(text: string): string {
  const list = items(text)
  return list.length > 1 ? list.map(item => item.replace(/[.;,]+$/, '')).join('; ') : list.join('')
}

const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+/

/** The items of a markdown list (a line that carries on an item belongs to it), or the text as one paragraph. */
function items(text: string): string[] {
  const lines = text.split('\n').filter(line => line.trim())
  if (!lines.some(line => BULLET.test(line))) return lines.length ? [lines.map(line => line.trim()).join(' ')] : []
  const list: string[] = []
  for (const line of lines) {
    if (BULLET.test(line) || !list.length) list.push(line.replace(BULLET, '').trim())
    else list[list.length - 1] += ` ${line.trim()}`
  }
  return list.filter(Boolean)
}
