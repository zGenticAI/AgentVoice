// What npm run slides takes. Kept apart from the command so it can be tested without rendering anything.

export const SLIDES_USAGE = `Usage:
  npm run slides -- prepare <deck.pdf> [--exclude <pages>] [--label <name>]
  npm run slides -- check <deck.script.md>
  npm run slides -- list
  npm run slides -- delete <deck id> | --all
See docs/presenting.md.`

export type SlidesArgs =
  | { command: 'prepare'; file: string; exclude: number[]; label?: string }
  | { command: 'check'; file: string }
  | { command: 'list' }
  | { command: 'delete'; ids: string[]; all: boolean }
  | { command: 'help' }

/** Pages as "3,9" or "3-5", from 1 to 100, or null. */
export function pageList(value: string): number[] | null {
  const pages: number[] = []
  for (const part of value.split(',').map(p => p.trim())) {
    const m = /^(\d{1,3})(?:-(\d{1,3}))?$/.exec(part)
    if (!m) return null
    const [from, to] = [Number(m[1]), Number(m[2] ?? m[1])]
    if (from < 1 || to > 100 || to < from) return null
    for (let n = from; n <= to; n++) pages.push(n)
  }
  return [...new Set(pages)].sort((a, b) => a - b)
}

/** The command and its arguments, or why they can't be used. */
export function slidesArgs(argv: readonly string[]): SlidesArgs | { problem: string } {
  const [command, ...rest] = argv
  if (!command || command === 'help' || command === '-h' || command === '--help') return { command: 'help' }
  const plain: string[] = []
  const options = new Map<string, string[]>()
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (!arg.startsWith('--')) {
      plain.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    const name = eq < 0 ? arg : arg.slice(0, eq)
    if (name === '--all') {
      if (eq >= 0) return { problem: '--all takes no value.' }
      options.set(name, [])
      continue
    }
    if (name !== '--exclude' && name !== '--label') return { problem: `Unknown option ${name}.` }
    const value = eq < 0 ? rest[++i] : arg.slice(eq + 1)
    if (value === undefined || value === '' || (eq < 0 && value.startsWith('--'))) return { problem: `${name} needs a value after it.` }
    options.set(name, [...(options.get(name) ?? []), value])
  }
  const allowed: Record<string, string[]> = { prepare: ['--exclude', '--label'], check: [], list: [], delete: ['--all'] }
  if (!Object.hasOwn(allowed, command)) return { problem: `Unknown command ${command}.` }
  const extra = [...options.keys()].find(o => !allowed[command].includes(o))
  if (extra) return { problem: `${command} takes no ${extra}.` }

  if (command === 'prepare' || command === 'check') {
    if (plain.length !== 1) return { problem: command === 'prepare' ? 'Give one PDF.' : 'Give one script (<deck>.script.md).' }
    if (command === 'check') return { command, file: plain[0] }
    const exclude: number[] = []
    for (const value of options.get('--exclude') ?? []) {
      const pages = pageList(value)
      if (!pages) return { problem: `--exclude takes page numbers from 1 to 100, such as 3,9 or 4-6 (not "${value}").` }
      exclude.push(...pages)
    }
    const labels = options.get('--label') ?? []
    if (labels.length > 1) return { problem: 'Give --label once.' }
    return { command, file: plain[0], exclude: [...new Set(exclude)].sort((a, b) => a - b), ...(labels.length ? { label: labels[0] } : {}) }
  }
  if (command === 'list') {
    if (plain.length) return { problem: 'list takes nothing more.' }
    return { command }
  }
  const all = options.has('--all')
  if (all === Boolean(plain.length)) return { problem: 'Give the deck ids to delete, or --all.' }
  return { command: 'delete', ids: plain, all }
}
