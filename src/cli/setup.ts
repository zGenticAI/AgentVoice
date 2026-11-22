// agentvoice setup claude-code|codex|opencode [<folder>]: makes a session folder, the folder you start your coding
// client in for meetings, with that client's files for the zoom-meeting channel, the meeting-assistant and the floor,
// and the channel started by absolute paths into the installed package (node and the package's bin, which the client
// runs without your shell's PATH or environment), with your AgentVoice folder in the channel's own environment. The
// folder is a new or empty one, or one setup made before for this AgentVoice folder (src/setup/folder.ts); running it
// again there refreshes setup's own files, and never replaces one you changed without --replace-changed
// (src/setup/files.ts). Installed from npm only: a clone has its committed files and scripts/install-*.sh.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CODEX_INSTALL, INSTALL_FIRST, OPENCODE_INSTALL, WORDS, cloneRefusal } from '../commands.ts'
import { INSTALL_MODE, OWNER_DIR, PACKAGE_DIR, PACKAGE_VERSION, realPath, tildePath } from '../home.ts'
import { OPENCODE_TESTED } from '../channel/push-opencode.ts'
import { CLAUDE_LOCAL, registerClaudeCode, renderClaudeCode, runCommand } from '../setup/claude-code.ts'
import { CODEX_AGENT, CODEX_TESTED, codexServer, codexVersion, refuseTempFolders, renderCodex, tomlString } from '../setup/codex.ts'
import { CLIENTS, type Client, SetupError, type SetupFile, applySetup } from '../setup/files.ts'
import { CONTROL, checkSessionFolder, gitInit, onPath, sessionFolder } from '../setup/folder.ts'
import { agentvoiceCommand } from '../setup/node-path.ts'
import { OPENCODE_LOCAL, localServer, openCodeVersion, renderOpenCode, sourceFolders, sourcesIn } from '../setup/opencode.ts'

export const SETUP_USAGE = [
  'Usage: agentvoice setup claude-code [<folder>] [--replace-changed]',
  '       agentvoice setup codex [<folder>] [--replace-changed]',
  '       agentvoice setup opencode [<folder>] [--source <dir>]... [--no-sources] [--replace-changed]',
].join('\n')

export interface SetupArgs {
  client: Client
  folder?: string
  replaceChanged: boolean
  sources: string[]
  noSources: boolean
}

/** A mistake in the command line: said with the usage, exit 2. */
export class UsageError extends Error {}

/** The command line after agentvoice setup. Throws UsageError for one it can't take. */
export function parseSetupArgs(argv: readonly string[]): SetupArgs {
  const [client, ...rest] = argv
  if (client === undefined) throw new UsageError('Which client? agentvoice setup claude-code, codex or opencode.')
  if (!CLIENTS.includes(client as Client)) throw new UsageError(`Unknown client "${client}": agentvoice setup claude-code, codex or opencode.`)
  const args: SetupArgs = { client: client as Client, replaceChanged: false, sources: [], noSources: false }
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === '--replace-changed') args.replaceChanged = true
    else if (arg === '--source' || arg === '--no-sources') {
      if (client !== 'opencode') throw new UsageError(`${arg} is for agentvoice setup opencode only.`)
      if (arg === '--no-sources') args.noSources = true
      else if (i + 1 >= rest.length) throw new UsageError('--source takes a folder.')
      else args.sources.push(rest[++i])
    } else if (arg.startsWith('-')) throw new UsageError(`Unknown option: ${arg}.`)
    else if (args.folder !== undefined) throw new UsageError(`One folder only: ${args.folder} or ${arg}?`)
    else args.folder = arg
  }
  return args
}

/** A path as a shell command takes it: in quotes when it needs them. */
const quoted = (p: string) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `"${p}"`)

/** What setup checks before anything else: the mode, the package's place, init, git and the client itself. */
function preconditions(client: Client): { note?: string; version?: string } {
  if (INSTALL_MODE === 'clone') throw new SetupError(cloneRefusal(PACKAGE_DIR))
  if (realPath(PACKAGE_DIR).split(path.sep).includes('_npx')) {
    throw new SetupError(`${INSTALL_FIRST}: a client config can't point into npx's cache, which npm clears.`)
  }
  if (!fs.existsSync(path.join(OWNER_DIR, '.env'))) throw new SetupError(`${tildePath(path.join(OWNER_DIR, '.env'))} is not there yet. Run agentvoice init first.`)
  if (!onPath('git')) throw new SetupError('agentvoice setup needs git, to make the session folder a repository of its own (so your coding client takes it as the project): install git, then run this again.')
  if (client === 'claude-code') {
    if (!onPath('claude')) throw new SetupError('Claude Code is not installed (no claude command): install it, then run this again.')
    return {}
  }
  if (client === 'codex') {
    if (!onPath('codex')) throw new SetupError(`Codex is not installed (no codex command). Install Codex ${CODEX_TESTED} or later: ${CODEX_INSTALL}`)
    return codexVersion(runCommand('codex', ['--version'], { cwd: os.tmpdir(), quiet: true }).stdout)
  }
  if (!onPath('opencode')) throw new SetupError(`OpenCode is not installed (no opencode command). Install OpenCode ${OPENCODE_TESTED} or later: ${OPENCODE_INSTALL}`)
  return openCodeVersion(runCommand('opencode', ['--version'], { cwd: os.tmpdir(), quiet: true }).stdout)
}

async function setup(args: SetupArgs): Promise<void> {
  const { client } = args
  const checked = preconditions(client)
  if (checked.note) console.log(checked.note)
  const { config } = await import('../config.ts')
  const home = OWNER_DIR
  const dataDir = path.resolve(config.dataDir)
  const [node, bin] = agentvoiceCommand()
  for (const [what, p] of [['node', node], ['The package', bin]] as const) {
    if (CONTROL.test(p)) throw new SetupError(`${what} (${JSON.stringify(p)}) has a control character in its path, which can't go into a client's config.`)
  }
  if (client === 'codex') refuseTempFolders({ home })
  const sources = client === 'opencode' && (args.sources.length || args.noSources) ? sourceFolders(args.sources) : null
  const folder = sessionFolder(args.folder)
  const { exists, manifest } = checkSessionFolder({ folder, client, ownerDir: home, dataDir, packageDir: PACKAGE_DIR })
  const existing = (rel: string) => {
    try {
      return fs.readFileSync(path.join(folder, rel), 'utf8')
    } catch {
      return undefined
    }
  }
  const input = { packageDir: PACKAGE_DIR, home, dataDir, node, bin }
  const files: SetupFile[] =
    client === 'claude-code'
      ? renderClaudeCode({ ...input, local: existing(CLAUDE_LOCAL) })
      : client === 'codex'
        ? renderCodex({ ...input, agent: existing(CODEX_AGENT) })
        : renderOpenCode({ ...input, local: existing(OPENCODE_LOCAL), sources })
  // The same command with --replace-changed, for the refusal to name.
  const again = [
    'agentvoice setup',
    client,
    ...(args.folder !== undefined ? [quoted(folder)] : []),
    ...args.sources.flatMap(source => ['--source', quoted(source)]),
    ...(args.noSources ? ['--no-sources'] : []),
    '--replace-changed',
  ].join(' ')
  const done = applySetup({
    folder,
    exists,
    client,
    files,
    manifest,
    replaceChanged: args.replaceChanged,
    home,
    command: [node, bin, 'channel'],
    version: PACKAGE_VERSION,
    again,
    makeRepo: gitInit,
  })
  if (done.made) console.log(`Made ${tildePath(folder)} (only you can open it).`)
  if (done.repo) console.log(`Made it a Git repository of its own (git init), so ${client === 'claude-code' ? 'Claude Code' : client === 'codex' ? 'Codex' : 'OpenCode'} takes it as the project.`)

  if (client === 'claude-code') {
    registerClaudeCode({ folder, home, node, bin })
    console.log(
      [
        `Done. The zoom-meeting channel is registered for ${folder} only, with the floor and the meeting-assistant agent.`,
        'Allowed for the meeting-assistant in .claude/settings.local.json: its six channel tools, and reading the transcripts',
        `and minutes in ${tildePath(dataDir)}. Allow your knowledge sources there too (see ${WORDS.doc('claude-code')}).`,
        'Before a meeting, start Claude Code in this folder with the channel loaded:',
        `  cd "${folder}" && claude --dangerously-load-development-channels server:zoom-meeting`,
        'or resume a session there with --resume. Run agentvoice setup claude-code again after upgrading AgentVoice or Node.',
      ].join('\n'),
    )
    return
  }

  if (client === 'codex') {
    // A zoom-meeting in your own Codex config would start the channel in every project.
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'agentvoice-setup-'))
    let there: string
    try {
      there = codexServer(elsewhere, node, bin)
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true })
    }
    const userConfig = `${process.env.CODEX_HOME || '~/.codex'}/config.toml`
    if (there !== 'none') {
      console.log(`Your own Codex config (${userConfig}) registers a zoom-meeting server for every project, perhaps with codex mcp add.`)
      console.log("Remove it, as this folder's config registers the channel for this folder only:\n  codex mcp remove zoom-meeting\n")
    }
    const here = codexServer(folder, node, bin)
    const lines = [`Done (Codex ${checked.version}). ${folder} is set up for Codex: the zoom-meeting channel, the meeting-assistant and the floor.`, 'Start Codex at the root of this folder:', `  cd "${folder}" && codex`]
    if (here === 'ours') lines.push('Codex trusts this folder and loads its config: the zoom-meeting channel, the meeting-assistant and the floor.')
    else {
      lines.push(
        "Codex doesn't load this folder's config yet: it reads .codex/ only in a folder you trust. The first time you start",
        'Codex here it asks whether you trust the folder: choose "Trust and continue". If you once chose not to, set',
        `  [projects.${tomlString(folder)}]`,
        '  trust_level = "trusted"',
        `in ${userConfig}. Then run agentvoice setup codex again here to check.`,
      )
    }
    lines.push(
      "Don't start Codex here with --sandbox (-s) or --dangerously-bypass-approvals-and-sandbox: either replaces the floor.",
      'Run agentvoice setup codex again after upgrading AgentVoice or Node.',
    )
    console.log(lines.join('\n'))
    return
  }

  const local = existing(OPENCODE_LOCAL)
  if (localServer(local)) console.log(`Warning: ${OPENCODE_LOCAL} has a zoom-meeting server of its own, which replaces the one in opencode.json: remove it from there.`)
  const reads = sourcesIn(local)
  console.log(
    [
      `Done (OpenCode ${checked.version}). ${folder} is set up for OpenCode: the zoom-meeting channel, the meeting-assistant and the floor.`,
      `opencode.json starts the channel with AGENTVOICE_HOME=${home}, since OpenCode's background service, which runs it,`,
      "doesn't see your terminal's environment.",
      `The meeting-assistant may read the transcripts and minutes in ${tildePath(dataDir)}` +
        (reads.length ? `, and these folders:\n${reads.map(f => `  ${f}`).join('\n')}` : ` (add your knowledge sources with --source <dir>).`),
      `Before a meeting, start OpenCode's background service, then OpenCode in this folder (${WORDS.doc('opencode')}):`,
      '  opencode service start',
      `  cd "${folder}" && opencode`,
      'Change opencode.json or .opencode/ only between meetings: OpenCode restarts the channel when its config changes.',
      'Run agentvoice setup opencode again after upgrading AgentVoice or Node.',
    ].join('\n'),
  )
}

/** Run as a command (agentvoice setup), not imported. */
function isEntryPoint(): boolean {
  try {
    return fs.realpathSync(process.argv[1] ?? '') === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) console.log(SETUP_USAGE)
  else {
    try {
      await setup(parseSetupArgs(argv))
    } catch (err) {
      if (err instanceof UsageError) {
        console.error(`${err.message}\n${SETUP_USAGE}`)
        process.exitCode = 2
      } else if (err instanceof SetupError) {
        console.error(err.message)
        process.exitCode = 1
      } else throw err
    }
  }
}
