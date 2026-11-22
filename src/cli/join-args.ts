// What npm run join takes: the meeting link, and the options for that meeting. Kept apart from the command so it can be
// tested without a voice service.
import { WORDS } from '../commands.ts'

export const JOIN_USAGE =
  `Usage: ${WORDS.run('join', '"<Zoom, Google Meet or Microsoft Teams meeting link>" [--brief <file>] [--speaker-probe]')}\n` +
  `       ${WORDS.run('join', '"<meeting link>" --slides <deck.script.md> [--from <slide>] [--brief <file>]')}\n` +
  `       ${WORDS.run('join', '"<meeting link>" --share-test [--json <file>] [--keep] [--brief <file>]')}`

export interface JoinArgs {
  meetingUrl: string
  /** The file of the meeting's own brief, which it then answers from instead of the shared one. */
  briefFile?: string
  /** Measure who is speaking in this meeting: a test meeting, with SPEAKER_PROBE on (docs/speaker-probe.md). */
  speakerProbe?: true
  /** Run the screen-share test in this meeting: a test meeting you host (docs/share-test.md). */
  shareTest?: true
  /** With --share-test: also write the test's raw step records to this file. */
  jsonFile?: string
  /** With --share-test: leave the assistant in the meeting when the test ends. */
  keep?: true
  /** A presentation script (<deck>.script.md): the assistant presents its prepared deck in this meeting (docs/presenting.md). */
  slidesFile?: string
  /** With --slides: the slide (PDF page) to start from. */
  from?: number
}

/** Options that take a value, as --name <value> or --name=<value>, and the field each one fills. */
const VALUE_OPTIONS = { '--brief': 'briefFile', '--json': 'jsonFile', '--slides': 'slidesFile' } as const satisfies Record<string, keyof JoinArgs>
/** Options that take none, and the field each one sets. */
const FLAG_OPTIONS = { '--speaker-probe': 'speakerProbe', '--share-test': 'shareTest', '--keep': 'keep' } as const satisfies Record<string, keyof JoinArgs>

/** The join command's arguments, or why they can't be used. Options may come before or after the link. */
export function joinArgs(argv: readonly string[]): JoinArgs | { problem: string } {
  const links: string[] = []
  const options: Partial<JoinArgs> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      links.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    const name = eq < 0 ? arg : arg.slice(0, eq)
    if (Object.hasOwn(FLAG_OPTIONS, name)) {
      if (eq >= 0) return { problem: `${name} takes no value.` }
      const flag = FLAG_OPTIONS[name as keyof typeof FLAG_OPTIONS]
      if (options[flag] !== undefined) return { problem: `Give ${name} once.` }
      options[flag] = true
      continue
    }
    if (name === '--from') {
      const value = eq < 0 ? argv[++i] : arg.slice(eq + 1)
      if (!value || !/^\d{1,3}$/.test(value) || Number(value) < 1 || Number(value) > 100) return { problem: '--from needs a slide number from 1 to 100 after it.' }
      if (options.from !== undefined) return { problem: 'Give --from once.' }
      options.from = Number(value)
      continue
    }
    if (!Object.hasOwn(VALUE_OPTIONS, name)) return { problem: `Unknown option ${name}.` }
    const field = VALUE_OPTIONS[name as keyof typeof VALUE_OPTIONS]
    const value = eq < 0 ? argv[++i] : arg.slice(eq + 1)
    if (!value || (eq < 0 && value.startsWith('--'))) return { problem: `${name} needs a file after it.` }
    if (options[field] !== undefined) return { problem: `Give ${name} once.` }
    options[field] = value
  }
  if (links.length !== 1) return { problem: links.length ? 'Give one meeting link.' : 'Give the meeting link.' }
  // The share test is a test meeting of its own: it measures nothing of who is speaking, and the probe nothing of it.
  if (options.shareTest && options.speakerProbe) return { problem: 'Use --share-test or --speaker-probe, not both.' }
  for (const [name, field] of [['--json', 'jsonFile'], ['--keep', 'keep']] as const) {
    if (options[field] !== undefined && !options.shareTest) return { problem: `${name} goes with --share-test.` }
  }
  // The share test shares a page of its own: a meeting presents slides, or runs the test.
  if (options.slidesFile !== undefined && options.shareTest) return { problem: 'Use --share-test or --slides, not both.' }
  if (options.from !== undefined && options.slidesFile === undefined) return { problem: '--from goes with --slides.' }
  return { meetingUrl: links[0], ...options }
}
