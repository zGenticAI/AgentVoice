// What npm run join takes: the meeting link, and the options for that meeting. Kept apart from the command so it can be
// tested without a voice service.

export const JOIN_USAGE =
  'Usage: npm run join -- "<Zoom, Google Meet or Microsoft Teams meeting link>" [--brief <file>] [--speaker-probe]'

export interface JoinArgs {
  meetingUrl: string
  /** The file of the meeting's own brief, which it then answers from instead of the shared one. */
  briefFile?: string
  /** Measure who is speaking in this meeting: a test meeting, with SPEAKER_PROBE on (docs/speaker-probe.md). */
  speakerProbe?: true
}

/** Options that take a value, as --name <value> or --name=<value>, and the field each one fills. */
const VALUE_OPTIONS = { '--brief': 'briefFile' } as const satisfies Record<string, keyof JoinArgs>
/** Options that take none, and the field each one sets. */
const FLAG_OPTIONS = { '--speaker-probe': 'speakerProbe' } as const satisfies Record<string, keyof JoinArgs>

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
    if (!Object.hasOwn(VALUE_OPTIONS, name)) return { problem: `Unknown option ${name}.` }
    const field = VALUE_OPTIONS[name as keyof typeof VALUE_OPTIONS]
    const value = eq < 0 ? argv[++i] : arg.slice(eq + 1)
    if (!value || (eq < 0 && value.startsWith('--'))) return { problem: `${name} needs a file after it.` }
    if (options[field] !== undefined) return { problem: `Give ${name} once.` }
    options[field] = value
  }
  if (links.length !== 1) return { problem: links.length ? 'Give one meeting link.' : 'Give the meeting link.' }
  return { meetingUrl: links[0], ...options }
}
