// The name corpus (test/fixtures/name-corpus.json): about 1,900 meeting lines, as written and as speech
// recognition gives them, each with {Name} where the assistant's name is, and what the attention, leave and
// cancel rules made of it with the default name. Any other name should give the same results: if it doesn't,
// the name is clashing with the grammar (or with a word in the line). test/name-corpus.test.ts checks this for
// the default name and sample ones; npm run check-name runs it for yours and explains each difference.
import fs from 'node:fs'
import path from 'node:path'
import { type Attention, makeAttention } from './brain/attention.ts'
import { makeNameRules } from './brain/text.ts'
import { ROOT } from './env.ts'
import type { AgentName } from './identity.ts'

export const CORPUS_FILE = path.join(ROOT, 'test', 'fixtures', 'name-corpus.json')

/** One line of the corpus. leave, cancel and said are left out when false or empty. */
export interface CorpusLine {
  line: string
  attention: Attention
  leave?: boolean
  cancel?: boolean
  /** What saidAfterName() gave, as templates too. */
  said?: string[]
}

export interface Corpus {
  about: string
  /** The names the results were recorded with: the default profile. */
  recordedWith: AgentName
  lines: CorpusLine[]
}

export function loadCorpus(file = CORPUS_FILE): Corpus {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Corpus
}

/** What the rules make of one line. */
export interface Result {
  attention: Attention
  leave: boolean
  cancel: boolean
  said: string[]
}

const SLOT = /\{(Name|name|NAME|Variant[23]?|variant[23]?|VARIANT[23]?|Misheard2?|misheard2?|MISHEARD2?)\}/g

const capitalised = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1)

/**
 * The template with these names in it, written the way the slot is ("{Name}", "{name}", "{NAME}"). {Variant2}
 * and {Variant3} are the second and third spelling, {Misheard2} the second mishearing; with fewer, the first
 * stands in. Null when the line needs a spelling or a mishearing and these names have none.
 */
export function render(template: string, agent: AgentName): string | null {
  let missing = false
  const text = template.replace(SLOT, (_, slot: string) => {
    const kind = slot.toLowerCase().replace(/\d$/, '')
    const n = Number(slot.match(/\d$/)?.[0] ?? 1) - 1
    const list = kind === 'name' ? [agent.name] : kind === 'variant' ? agent.variants : agent.misheard
    if (!list.length) {
      missing = true
      return ''
    }
    const word = list[n % list.length]
    if (slot === slot.toUpperCase()) return word.toUpperCase()
    if (slot === slot.toLowerCase()) return word.toLowerCase()
    return capitalised(word)
  })
  return missing ? null : text
}

/**
 * The other way from render(): a line read with these names, with each of them put back as its slot. Whole words
 * only, so "Alexis" stays as it is. For recording the results again (npm run record-name-corpus).
 */
export function toTemplate(text: string, agent: AgentName): string {
  const slots: [string, string][] = [
    ['Name', agent.name],
    ...agent.variants.map((word, i): [string, string] => [`Variant${i ? i + 1 : ''}`, word]),
    ...agent.misheard.map((word, i): [string, string] => [`Misheard${i ? i + 1 : ''}`, word]),
  ]
  let out = text
  for (const [slot, word] of slots) {
    const forms = [[slot, capitalised(word)], [slot.toLowerCase(), word.toLowerCase()], [slot.toUpperCase(), word.toUpperCase()]]
    for (const [form, written] of forms) {
      const escaped = written.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'gu'), `{${form}}`)
    }
  }
  return out
}

/** Reads lines with the rules for these names. */
export function reader(agent: AgentName): (line: string) => Result {
  const grammar = makeAttention(agent)
  const rules = makeNameRules(agent)
  return line => ({
    attention: grammar.attention(line),
    leave: rules.isLeaveRequest(line),
    cancel: rules.isCancelRequest(line),
    said: grammar.saidAfterName(line),
  })
}

/** What was recorded for a line, with these names in it. */
export function expected(entry: CorpusLine, agent: AgentName): Result {
  return {
    attention: entry.attention,
    leave: entry.leave ?? false,
    cancel: entry.cancel ?? false,
    said: (entry.said ?? []).map(s => render(s, agent) ?? s),
  }
}

export interface Difference {
  /** The line, with these names in it. */
  line: string
  /** What the default name made of it. */
  was: Result
  /** What these names make of it. */
  now: Result
}

export interface Comparison {
  /** Lines read. */
  tried: number
  /** Lines left out: they need a spelling or a mishearing these names don't have. */
  skipped: number
  differences: Difference[]
}

/**
 * Reads every line of the corpus with these names and compares it with what was recorded. `said` compares what
 * the leave rule was given too; without it only the outcomes count (answered, left, cancelled, and the rest).
 */
export function compareCorpus(corpus: Corpus, agent: AgentName, opts: { said?: boolean } = {}): Comparison {
  const read = reader(agent)
  const differences: Difference[] = []
  let tried = 0
  let skipped = 0
  for (const entry of corpus.lines) {
    const line = render(entry.line, agent)
    if (line === null) {
      skipped++
      continue
    }
    tried++
    const was = expected(entry, agent)
    const now = read(line)
    const same = was.attention === now.attention && was.leave === now.leave && was.cancel === now.cancel &&
      (!opts.said || JSON.stringify(was.said) === JSON.stringify(now.said))
    if (!same) differences.push({ line, was, now })
  }
  return { tried, skipped, differences }
}

// How each attention result reads in a report.
const READS: Record<Attention, string> = {
  asked: 'answered',
  called: 'taken as a call (the next line goes to the assistant)',
  nothing_asked: 'taken as said to the assistant, with nothing asked',
  mentioned: 'taken as talk about the assistant',
  no_name: 'not taken as having the name in it',
}

/** The groups a report puts differences in, worst first, and what each means. */
const GROUPS: { title: string; has: (d: Difference) => boolean; says: (d: Difference) => string }[] = [
  {
    title: 'Would now make the assistant leave and delete the meeting record (must not happen)',
    has: d => d.now.leave && !d.was.leave,
    says: () => 'is taken as a request to leave',
  },
  {
    title: 'Would now be answered: the assistant would talk when nobody asked it',
    has: d => d.now.attention === 'asked' && d.was.attention !== 'asked',
    says: d => `is answered (with the default name it was ${READS[d.was.attention]})`,
  },
  {
    title: 'Would now stop what the assistant is doing',
    has: d => d.now.cancel && !d.was.cancel,
    says: () => 'is taken as "never mind"',
  },
  {
    title: 'Would no longer make the assistant leave',
    has: d => d.was.leave && !d.now.leave,
    says: () => 'is not taken as a request to leave',
  },
  {
    title: 'Would no longer be answered',
    has: d => d.was.attention === 'asked' && d.now.attention !== 'asked',
    says: d => `is ${READS[d.now.attention]}, not answered`,
  },
  {
    title: 'Would no longer stop what the assistant is doing',
    has: d => d.was.cancel && !d.now.cancel,
    says: () => 'is not taken as "never mind"',
  },
  {
    title: 'Read differently, but still not answered (harmless on its own)',
    has: () => true,
    says: d => `is ${READS[d.now.attention]} (with the default name: ${READS[d.was.attention]})`,
  },
]

/**
 * A plain report of how these names do on the corpus, grouped worst first, with up to `perGroup` lines in each
 * (all of them when it is Infinity). Empty groups are left out.
 */
export function reportDifferences(comparison: Comparison, agent: AgentName, perGroup = 8): string[] {
  const out: string[] = []
  const left = [...comparison.differences]
  for (const group of GROUPS) {
    const these = left.filter(group.has)
    if (!these.length) continue
    for (const d of these) left.splice(left.indexOf(d), 1)
    out.push('', `${group.title}: ${these.length} line${these.length === 1 ? '' : 's'}`)
    for (const d of these.slice(0, perGroup)) out.push(`  - as "${agent.name}", "${d.line}" ${group.says(d)}`)
    if (these.length > perGroup) out.push(`  ... and ${these.length - perGroup} more (npm run check-name -- --all lists them all)`)
  }
  return out
}
