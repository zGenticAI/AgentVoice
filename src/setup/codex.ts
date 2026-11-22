// agentvoice setup codex: the session folder's Codex files. The package's .codex/config.toml with two edits: the
// channel started by absolute paths into the installed package, with the AgentVoice folder in its environment (Codex
// passes a server only the variables its config names), and the floor's entries for the AgentVoice folder, which is
// outside the session folder, so the patterns that cover a clone's own .env, local token and decks don't reach it.
// The meeting-assistant is the package's, byte for byte, except that a shell switch you turned off stays off. Codex
// itself saves your trust in the folder: setup writes nothing outside it, and only checks what Codex makes of it.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CODEX_INSTALL } from '../commands.ts'
import { isWithin, realPath, tildePath } from '../home.ts'
import { type Runner, runCommand } from './claude-code.ts'
import { SetupError, type SetupFile } from './files.ts'

/** The Codex AgentVoice was tested with, and the earliest it takes: TESTED= in scripts/install-codex.sh. */
export const CODEX_TESTED = '0.171.0'
export const CODEX_CONFIG = '.codex/config.toml'
export const CODEX_AGENT = '.codex/agents/meeting-assistant.toml'

/** The .env names denied in the AgentVoice folder: the floor's, with .env.*.local as its three usual names. */
export const HOME_ENV_NAMES = [
  '.env', '.env.local', '.env.development.local', '.env.production.local', '.env.test.local', '.env.production', '.env.prod',
  '.env.development', '.env.dev', '.env.staging', '.env.test', '.env.bak', '.env.backup', '.env.old',
]

/** A TOML basic string: in quotes, with backslashes and quote marks escaped (a control character is refused before). */
export const tomlString = (value: string): string => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`

// The lines of the package's config that setup replaces: the comment above the channel's command, and the three keys
// that start it from the folder a clone starts in.
const SERVER_LINES = /(?<=^\[mcp_servers\.zoom-meeting\]\n)(?:#[^\n]*\n)*command = [^\n]*\nargs = [^\n]*\nenv = [^\n]*\n/gm
// The last of the floor's home-folder entries, after which the AgentVoice folder's go.
const LAST_HOME_ENTRY = '"~/.local/share/opencode" = "deny"\n'
// The shell switch, the agent's last two lines: commented out in the package's, as it comes.
const SWITCH_OFF = '# [features]\n# shell_tool = false\n'
const SWITCH_ON = '[features]\nshell_tool = false\n'

/** Whether an agent file has its shell switch uncommented (the shell off), at its end. */
export const shellSwitchOn = (agent: string): boolean => agent.trimEnd().endsWith(SWITCH_ON.trimEnd())

/** The agent file with its shell switch the other way, or null if it doesn't end with the switch either way. */
function toggled(agent: string): string | null {
  if (agent.endsWith(SWITCH_OFF)) return agent.slice(0, -SWITCH_OFF.length) + SWITCH_ON
  if (agent.endsWith(SWITCH_ON)) return agent.slice(0, -SWITCH_ON.length) + SWITCH_OFF
  return null
}

export interface CodexInput {
  packageDir: string
  /** The AgentVoice folder, and its data folder (config.dataDir). */
  home: string
  dataDir: string
  /** The command that starts the channel: [node, bin] (agentvoiceCommand). */
  node: string
  bin: string
  /** The home folder: with the AgentVoice folder at its default place, entries under it are written ~/... */
  homeDir?: string
  /** .codex/agents/meeting-assistant.toml as it is in the session folder, if it is there. */
  agent?: string
}

/** The floor's entries for the AgentVoice folder: its .env names, the local token and the decks, as keys. */
export function homeEntries({ home, dataDir, homeDir = os.homedir() }: Pick<CodexInput, 'home' | 'dataDir' | 'homeDir'>): string[] {
  const atDefault = path.resolve(home) === path.join(homeDir, '.agentvoice')
  const key = (p: string) => {
    const rel = path.relative(homeDir, path.resolve(p))
    return atDefault && rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? `~/${rel}` : path.resolve(p)
  }
  return [...HOME_ENV_NAMES.map(name => key(path.join(home, name))), key(path.join(dataDir, 'local-token')), key(path.join(dataDir, 'decks'))]
}

/** The files setup writes for Codex: what the tests check. */
export function renderCodex(input: CodexInput): SetupFile[] {
  const { packageDir, home, node, bin, agent } = input
  const config = fs.readFileSync(path.join(packageDir, CODEX_CONFIG), 'utf8')
  if (config.match(SERVER_LINES)?.length !== 1 || config.split(LAST_HOME_ENTRY).length !== 2) {
    throw new Error(`${path.join(packageDir, CODEX_CONFIG)} is not the config this setup knows how to change: the package is broken.`)
  }
  const server = [
    "# The installed package's channel, by absolute paths, written by agentvoice setup codex. Run it again after upgrading",
    '# AgentVoice or Node.',
    `command = ${tomlString(node)}`,
    `args = [${tomlString(bin)}, "channel"]`,
    `env = { AGENTVOICE_CLIENT = "codex", AGENTVOICE_HOME = ${tomlString(home)} }`,
  ].join('\n')
  const entries = [
    '# Your AgentVoice folder, outside this one (agentvoice setup codex): its keys, the local token and prepared decks.',
    ...homeEntries(input).map(key => `${tomlString(key)} = "deny"`),
  ].join('\n')
  const written = config.replace(SERVER_LINES, () => `${server}\n`).replace(LAST_HOME_ENTRY, () => `${LAST_HOME_ENTRY}${entries}\n`)

  const template = fs.readFileSync(path.join(packageDir, CODEX_AGENT), 'utf8')
  const keepOff = agent !== undefined && shellSwitchOn(agent) && template.endsWith(SWITCH_OFF)
  return [
    { rel: CODEX_CONFIG, content: written },
    {
      rel: CODEX_AGENT,
      content: keepOff ? template.slice(0, -SWITCH_OFF.length) + SWITCH_ON : template,
      // The switch is yours to turn: the agent with it either way is still setup's.
      alsoOurs: current => [toggled(current)].filter((form): form is string => form !== null),
    },
  ]
}

/** What codex --version says against the tested version: a refusal, a note, or nothing. */
export function codexVersion(output: string): { version: string; note?: string } {
  const version = /\d+\.\d+\.\d+/.exec(output)?.[0]
  if (!version) throw new SetupError(`Could not tell which Codex this is (codex --version gave no version). AgentVoice needs Codex ${CODEX_TESTED} or later.`)
  const [a, b] = [version, CODEX_TESTED].map(v => v.split('.').map(Number))
  const order = a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
  if (order < 0) throw new SetupError(`Codex ${version} is older than ${CODEX_TESTED}, the earliest AgentVoice supports: update it (${CODEX_INSTALL}).`)
  return order > 0 ? { version, note: `Note: Codex ${version} is newer than AgentVoice was tested with (${CODEX_TESTED}). If something fails, tell us.` } : { version }
}

/**
 * On Linux, Codex's sandbox makes an empty, read-only placeholder for a path the floor denies that doesn't exist, when
 * that path is in a folder its commands may write (the session folder and the temporary folders), and can leave it
 * behind. So neither the home folder (the floor's ~/.ssh and the rest) nor the AgentVoice folder (its local-token, which
 * a placeholder would stop the voice service making) may be in /tmp or $TMPDIR. Throws SetupError for one that is.
 */
export function refuseTempFolders({ homeDir = os.homedir(), home, tmpdir = process.env.TMPDIR, platform = process.platform }: { homeDir?: string; home: string; tmpdir?: string; platform?: NodeJS.Platform }): void {
  if (platform !== 'linux') return
  const temps = ['/tmp', tmpdir].filter((t): t is string => !!t).map(t => realPath(t.replace(/\/+$/, '') || '/')).filter(t => t !== '/')
  for (const tmp of temps) {
    if (isWithin(homeDir, tmp)) {
      throw new SetupError(
        `Your home folder (${homeDir}) is inside ${tmp}, a folder where Codex's sandbox lets commands write. There, Codex makes ` +
          "empty, read-only placeholders for the floor's home-folder entries that don't exist (~/.ssh, ~/.aws and the rest) and " +
          'can leave them behind, which breaks ssh, gpg and other tools and can stop Codex starting. Use a home folder outside ' +
          '/tmp and $TMPDIR. If Codex already ran with this one, remove the empty files it left in it.',
      )
    }
    if (isWithin(home, tmp)) {
      throw new SetupError(
        `Your AgentVoice folder (${tildePath(home, homeDir)}) is inside ${tmp}, a folder where Codex's sandbox lets commands write. ` +
          "There, Codex makes empty, read-only placeholders for the floor's entries that don't exist (data/local-token among " +
          'them), which would stop the voice service starting. Use an AgentVoice folder outside /tmp and $TMPDIR (AGENTVOICE_HOME).',
      )
    }
  }
}

/** What Codex registers as zoom-meeting, run from a folder: none, ours (this command, as Codex), or another. */
export function codexServer(dir: string, node: string, bin: string, run: Runner = runCommand): 'none' | 'ours' | 'other' {
  const listed = run('codex', ['mcp', 'list', '--json'], { cwd: dir, quiet: true })
  const lines = (text: string) => text.split('\n').filter(line => !line.startsWith('WARNING: '))
  if (listed.status !== 0) {
    const why = lines(`${listed.stdout}\n${listed.stderr}`)
    const end = why.findIndex(line => line.startsWith('Stack backtrace'))
    throw new SetupError(`Codex can't load its config (run from ${dir}):\n${(end < 0 ? why : why.slice(0, end)).join('\n').trim()}`)
  }
  let servers: unknown
  try {
    servers = JSON.parse(lines(listed.stdout).join('\n'))
  } catch {
    throw new SetupError(`codex mcp list --json (run from ${dir}) gave something other than JSON: ${listed.stdout.trim().slice(0, 300)}`)
  }
  const server = (Array.isArray(servers) ? servers : []).find(entry => (entry as { name?: unknown })?.name === 'zoom-meeting') as
    | { transport?: { command?: unknown; args?: unknown; env?: Record<string, unknown> | null } }
    | undefined
  if (!server) return 'none'
  const t = server.transport
  return t?.command === node && JSON.stringify(t.args) === JSON.stringify([bin, 'channel']) && t.env?.AGENTVOICE_CLIENT === 'codex' ? 'ours' : 'other'
}
