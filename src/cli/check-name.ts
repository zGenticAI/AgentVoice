// Tries a name for the assistant: npm run check-name [-- [<name> [--variants a,b] [--misheard c,d]] [--all]]
// (--variants=a,b and --misheard=c,d work too). Without a name it checks what .env gives (AGENT_NAME,
// AGENT_NAME_VARIANTS, AGENT_NAME_MISHEARD and the participant-list name), read again here so that what reading it
// warns about (a stale ALEX_BOT_NAME ignored, a renamed variable) is printed and counted with the rest. A name on the
// command line comes with the lists given with it; a list not given is .env's when the name is .env's AGENT_NAME,
// and none otherwise (the default name with none gets its own): the output says which. Either way the participant-list name is
// the one the service would use with that name (AGENT_BOT_NAME, the older ALEX_BOT_NAME unless it names Alex and the
// name is another, or the one made from the name), so the start-up checks pass here exactly when npm start would with
// that name and those lists in .env. .env's own warnings are not printed for another name. It then reads about 1,900
// sample meeting lines (test/fixtures/name-corpus.json) with the name, its spellings and its mishearings, and
// explains every line that reads differently than with the default name.
// Prints to stdout; changes nothing. A usage error goes to stderr, with exit status 2.
import { DEFAULT_NAME, fold, nameList, readIdentity } from '../identity.ts'
import { checkName, checkOwner, describeName } from '../name-check.ts'
import { compareCorpus, loadCorpus, reportDifferences } from '../name-corpus.ts'

const USAGE = 'Usage: npm run check-name -- [<name> [--variants a,b] [--misheard c,d]] [--all]'

function usage(problem: string): never {
  process.stderr.write(`${problem}\n${USAGE}\n`)
  process.exit(2)
}

interface Args {
  name?: string
  variants?: string
  misheard?: string
  all: boolean
}

/** The command line, or a usage error: an unknown option, a list without a value or without a name, two names. */
function parseArgs(args: readonly string[]): Args {
  const parsed: Args = { all: false }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--all') {
      parsed.all = true
      continue
    }
    const list = /^--(variants|misheard)(?:=([\s\S]*))?$/.exec(arg)
    if (list) {
      const which = list[1] as 'variants' | 'misheard'
      const inline = list[2]
      const value = inline ?? args[i + 1]
      if (value === undefined || (inline === undefined && value.startsWith('-'))) {
        usage(`--${which} needs a value: a comma-separated list, as in --${which} a,b or --${which}=a,b.`)
      }
      if (inline === undefined) i++
      parsed[which] = value
      continue
    }
    if (arg.startsWith('-')) usage(`Unknown option '${arg}'.`)
    if (parsed.name !== undefined) usage(`One name at a time: "${parsed.name}" and "${arg}" were both given.`)
    parsed.name = arg
  }
  if (parsed.name === undefined) {
    for (const which of ['variants', 'misheard'] as const) {
      if (parsed[which] !== undefined) {
        usage(`--${which} needs a name before it: without one, the name and lists in .env are checked, and --${which} would be ignored.`)
      }
    }
  }
  return parsed
}

const args = parseArgs(process.argv.slice(2))

// The identity is read again from .env, not taken from identity.ts, which keeps its warnings for the start-up check:
// they are printed here with the rest, and only those for the name being tried.
const envName = process.env.AGENT_NAME?.trim() || DEFAULT_NAME
const sameName = args.name !== undefined && fold(args.name.trim()) === fold(envName)
const LISTS = [['variants', 'AGENT_NAME_VARIANTS'], ['misheard', 'AGENT_NAME_MISHEARD']] as const
// .env's lists that are set: they are for .env's name, so they come with a name on the command line only when it is that one.
const envLists = LISTS.filter(([, variable]) => nameList(process.env[variable]).length)
const fromEnv = args.name === undefined ? [] : envLists.filter(([which]) => sameName && args[which] === undefined)
const replaced = args.name === undefined ? [] : envLists.filter(([which]) => sameName && args[which] !== undefined)
const unused = args.name === undefined || sameName ? [] : envLists

const identityWarnings: string[] = []
const agent = readIdentity(
  args.name === undefined
    ? process.env
    : {
      ...process.env,
      AGENT_NAME: args.name,
      AGENT_NAME_VARIANTS: args.variants ?? (sameName ? process.env.AGENT_NAME_VARIANTS : undefined),
      AGENT_NAME_MISHEARD: args.misheard ?? (sameName ? process.env.AGENT_NAME_MISHEARD : undefined),
    },
  warning => void identityWarnings.push(warning.replace(/^\[identity\] /, '')),
)
const oldBotName = process.env.ALEX_BOT_NAME?.trim()
const botNameFrom = process.env.AGENT_BOT_NAME?.trim()
  ? 'from AGENT_BOT_NAME'
  : oldBotName && agent.botName === oldBotName
  ? 'from the older ALEX_BOT_NAME'
  : 'made from the name'

/** "AGENT_NAME_VARIANTS and AGENT_NAME_MISHEARD", or just one of them. */
const variables = (lists: typeof envLists) => lists.map(([, variable]) => variable).join(' and ')
const source = args.name === undefined ? ', from .env' : fromEnv.length ? `, with .env's ${variables(fromEnv)}` : ''
console.log(`Name: ${describeName(agent)}${source}`)
for (const [which, variable] of replaced) console.log(`--${which} was used instead of .env's ${variable}.`)
if (unused.length) {
  console.log(
    `.env's ${variables(unused)} ${unused.length === 1 ? 'was' : 'were'} not used: ${unused.length === 1 ? 'it is' : 'they are'} ` +
      `for "${envName}", .env's AGENT_NAME. Give this name's own with --variants and --misheard.`,
  )
}
console.log(`Participant-list name: "${agent.botName}", ${botNameFrom}`)
const named = checkName(agent)
const { errors } = named
// The owner's own settings are npm run check's to check: only what they say about this name (it is the owner's first
// name, so the assistant would answer what is said to the owner) is here.
const warnings = [...named.warnings, ...checkOwner(agent).warnings]
for (const error of errors) console.log(`✗ ${error}`)
for (const warning of [...identityWarnings, ...warnings]) console.log(`! ${warning}`)
const warned = identityWarnings.length + warnings.length
if (!errors.length && !warned) console.log('✓ It passes the start-up checks, with no warnings.')
else if (!errors.length) {
  console.log(
    `✓ It passes the start-up checks, with ${warned} warning${warned === 1 ? '' : 's'} (the service starts, and repeats ` +
      `${warned === 1 ? 'it' : 'them'}).`,
  )
} else console.log('The service will not start with this name until the errors are fixed.')

const corpus = loadCorpus()
const comparison = compareCorpus(corpus, agent)
const { tried, skipped, differences } = comparison
console.log(
  `\nRead ${tried.toLocaleString('en')} meeting lines with it` +
    (skipped ? ` (${skipped} left out: they need a spelling or a mishearing, and none is set)` : '') +
    ` and compared them with what the default name, ${DEFAULT_NAME}, gives.`,
)
if (!differences.length) {
  console.log('✓ Every line reads the same: answered, left, stopped or ignored as with the default name.')
} else {
  console.log(`${differences.length} line${differences.length === 1 ? ' reads' : 's read'} differently:`)
  for (const line of reportDifferences(comparison, agent, args.all ? Infinity : 8)) console.log(line)
  console.log(
    '\nEach line was written for the default name, so a difference means the name (or a spelling or mishearing) is a word ' +
      'these lines use, or sits where the rules read it differently. A name that is not an everyday word avoids them.',
  )
}
// Never an all-clear: the corpus is what the tests and reviews happened to say.
console.log(
  "  The corpus only shows the lines it contains: a word they don't use can still be heard in ordinary speech, as an everyday " +
    'word or as the name of someone you meet with.' + (warned ? ' The warnings above still stand.' : ''),
)
console.log(
  '\nThen see what speech recognition makes of it in real meetings: after a meeting, read its transcript in ' +
    'data/transcripts/ (kept for TRANSCRIPT_RETENTION_DAYS, and deleted at once if someone asked the assistant to leave ' +
    'or removed it), and look at how the lines said to the assistant wrote the name. Add other spellings to ' +
    'AGENT_NAME_VARIANTS and mishearings that are ordinary words to AGENT_NAME_MISHEARD in .env, then run this again. ' +
    'Neither may be the name of anyone you meet with: a mishearing counts for leaving.',
)
const leaves = differences.some(d => d.now.leave && !d.was.leave)
process.exit(errors.length || leaves ? 1 : 0)
