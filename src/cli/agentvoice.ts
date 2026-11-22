// The agentvoice command, which bin/agentvoice.js runs through tsx: one command for what the npm scripts do in a clone
// (agentvoice start, join, check, slides, ...), and for setting AgentVoice up when it is installed from npm (init, setup,
// service). It reads the command from process.argv[2], points process.argv at that command's module, as if the module
// had been run itself, and imports it: so each command's process.argv.slice(2) is its own arguments, as with npm run,
// and the voice service knows it was started (src/server.ts, isEntryPoint). It never changes folder (a command's
// files are found from the folder it is run in), and loads only home.ts and commands.ts before the command's module,
// so .env is read by the command's own import of env.ts, as with npm run.
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Loaded here, not imported at the top: an AGENTVOICE_HOME that can't be used is said in one plain line (src/home.ts
// says why), for every command, rather than as a stack trace.
let home: typeof import('../home.ts')
let words: typeof import('../commands.ts')
try {
  home = await import('../home.ts')
  words = await import('../commands.ts')
} catch (err) {
  console.error((err as Error).message)
  process.exit(1)
}
const { INSTALL_MODE, OWNER_DIR, PACKAGE_DIR, PACKAGE_VERSION, tildePath } = home
const { README_URL, WORDS, cloneRefusal } = words

/** Each command, and its module under src/. */
const MODULES = {
  init: 'cli/init.ts',
  check: 'cli/check.ts',
  start: 'server.ts',
  join: 'cli/join.ts',
  slides: 'cli/slides.ts',
  'check-name': 'cli/check-name.ts',
  'speaker-report': 'cli/speaker-report.ts',
  'flux-probe': 'cli/flux-probe.ts',
  channel: 'channel/server.ts',
  service: 'cli/service.ts',
  setup: 'cli/setup.ts',
} as const
type Command = keyof typeof MODULES
/** Only an installed package has these: a clone is set up by its own files and scripts (its README). */
const INSTALLED_ONLY: ReadonlySet<Command> = new Set(['init', 'setup', 'service'])

const isCommand = (name: string): name is Command => Object.hasOwn(MODULES, name)

/** What agentvoice --help prints. */
function help(): string {
  const last =
    INSTALL_MODE === 'installed'
      ? `Your settings: ${tildePath(path.join(OWNER_DIR, '.env'))}, in ${tildePath(OWNER_DIR)}. Docs: ${README_URL}`
      : `This is a cloned folder (${PACKAGE_DIR}): your settings are in its .env, and its README says how to set it up.`
  return `AgentVoice ${PACKAGE_VERSION}: a voice assistant for your Zoom, Google Meet and Microsoft Teams meetings.

Usage: agentvoice <command> [options]

Set up
  init                          Make your AgentVoice folder (~/.agentvoice, or AGENTVOICE_HOME) from the examples:
                                .env, profile.md, data/brief.md and briefs/. It never overwrites a file.
  check                         Check your settings, and try the Anthropic, Deepgram and ElevenLabs keys.
  start                         Run the voice service in this terminal (Ctrl-C stops it).
  service install [--replace]   Keep the voice service running: launchd on macOS, systemd on Linux.
  service print [launchd|systemd]
                                Print the file it would install, and install nothing.
  service uninstall             Stop the installed service and remove its file.
  setup claude-code [<folder>]  Make <folder> (a new, empty one; this one unless given) the folder you start Claude
                                Code in for meetings.
  setup codex [<folder>]        The same for Codex.
  setup opencode [<folder>] [--source <dir>]... [--no-sources]
                                The same for OpenCode; each --source is a folder its meeting-assistant may read.
                                Each setup takes --replace-changed, to replace files you changed (kept as backups).

Meetings
  join "<link>" [--brief <file>] [--slides <deck.script.md> [--from <slide>]] [--speaker-probe]
                                Send the assistant into a meeting.
  join "<link>" --share-test [--json <file>] [--keep]
                                Test a screen share, in a meeting you host.
  slides prepare <deck.pdf> | check <deck.script.md> | list | delete <id>|--all | status | control <action>
                                Prepare a slide deck, and steer a presentation.

Tuning
  check-name [<name>] [--variants <a,b>] [--misheard <c,d>] [--all]
                                How a name does on about 1,900 sample meeting lines.
  speaker-report [--json]       The speaker probe's measurements, by platform.
  flux-probe [--help]           What Deepgram Flux does with backchannels, noise and interruptions.

For your coding client
  channel                       The zoom-meeting channel. The config that agentvoice setup writes starts it.

  help <command>                That command's options.
  --version, -v                 The version.

${last}`
}

/**
 * A command's usage lines, for agentvoice help <command> (and <command> --help): the command's own, where it has them,
 * so they say what its usage errors say; else these.
 */
async function usage(command: Command | 'help' | 'version'): Promise<string> {
  switch (command) {
    case 'join':
      return (await import('./join-args.ts')).JOIN_USAGE
    case 'slides':
      return (await import('./slides-args.ts')).SLIDES_USAGE
    case 'check-name':
      return (await import('../name-check.ts')).CHECK_NAME_USAGE
    case 'speaker-report':
      return (await import('../speakers/report.ts')).SPEAKER_REPORT_USAGE
    case 'flux-probe':
      // What flux-probe --help prints.
      return `${(await import('../probe/flux-probe.ts')).USAGE}\nSee ${WORDS.doc('flux-probe')}.`
    case 'init':
    case 'check':
    case 'start':
    case 'channel':
      return `Usage: agentvoice ${command}`
    case 'service':
      return [
        'Usage: agentvoice service install [--replace]',
        '       agentvoice service print [launchd|systemd]',
        '       agentvoice service uninstall',
      ].join('\n')
    case 'setup':
      return (await import('./setup.ts')).SETUP_USAGE
    case 'help':
      return 'Usage: agentvoice help [<command>]'
    case 'version':
      return 'Usage: agentvoice --version'
  }
}

function unknown(name: string): void {
  console.error(`Unknown command "${name}". Run agentvoice --help for the commands.`)
  process.exitCode = 2
}

const HELP = new Set(['help', '--help', '-h'])
const VERSION = new Set(['version', '--version', '-v'])
const [command, ...rest] = process.argv.slice(2)

if (command === undefined || HELP.has(command)) {
  const about = command === 'help' ? rest[0] : undefined
  if (about === undefined) console.log(help())
  else if (isCommand(about) || about === 'help' || about === 'version') console.log(await usage(about))
  else unknown(about)
} else if (VERSION.has(command)) {
  console.log(PACKAGE_VERSION)
} else if (!isCommand(command)) {
  unknown(command)
} else if (rest[0] === '--help' || rest[0] === '-h') {
  // agentvoice init --help, agentvoice start -h: the usage, never the command (which would make a folder, or start the
  // service, for a question).
  console.log(await usage(command))
} else if (INSTALLED_ONLY.has(command) && INSTALL_MODE === 'clone') {
  console.error(cloneRefusal(PACKAGE_DIR))
  process.exitCode = 1
} else {
  const file = fileURLToPath(new URL(`../${MODULES[command]}`, import.meta.url))
  process.argv = [process.execPath, file, ...rest]
  await import(pathToFileURL(file).href)
}
