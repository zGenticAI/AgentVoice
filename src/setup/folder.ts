// The session folder agentvoice setup makes for a coding client: the folder you start Claude Code, Codex or OpenCode in
// for meetings. What it holds is within the meeting-assistant's reach (Claude Code reads it without asking, Codex's
// commands may write it), and meeting text reaching the agent is the main risk, so setup takes only a folder made for
// it: one that isn't there yet, an empty one, or one it set up before for this AgentVoice folder. Never your home
// folder, your AgentVoice folder (Codex leaves placeholder files for the paths it may not read in the folders it may
// write, and a placeholder local-token would stop the voice service), the package's folder, a clone, or a folder in
// another Git repository (the client would take the whole repository as the project).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CLONE_SETUP } from '../commands.ts'
import { PACKAGE_NAME, isWithin, realPath, tildePath } from '../home.ts'
import { type Client, MANIFEST, type Manifest, SetupError, readManifest, sameFolder } from './files.ts'

/** The way setup says to make a session folder, for this client. */
export const sessionExample = (client: Client): string => `mkdir -p ~/agentvoice-session && cd ~/agentvoice-session && agentvoice setup ${client}`

/** A control character: no path with one goes into a config (a line break would end a TOML or unit line). */
export const CONTROL = /[\u0000-\u001f\u007f]/
/** The characters Claude Code's rules (and Codex's, OpenCode's) read as a pattern, not as part of a path. */
export const GLOB = /[*?[\]{}()]/

/** "~" and "~/x" as the home folder; anything else as given. */
export function expandHome(p: string, homeDir: string = os.homedir()): string {
  return p === '~' ? homeDir : p.startsWith('~/') ? path.join(homeDir, p.slice(2)) : p
}

/** The session folder: the one given (else the current one), "~" expanded, links resolved as far as it exists. */
export function sessionFolder(given: string | undefined, cwd: string = process.cwd(), homeDir: string = os.homedir()): string {
  return realPath(path.resolve(cwd, expandHome(given ?? '.', homeDir)))
}

/** The program a command name runs, found on PATH as a shell finds it, or null. */
export function onPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    const file = path.join(dir, command)
    try {
      const stat = fs.statSync(file)
      if (stat.isFile()) {
        fs.accessSync(file, fs.constants.X_OK)
        return file
      }
    } catch {
      // Not there, or not one it can run: the next folder.
    }
  }
  return null
}

/** git's environment for setup's own calls: none of a GIT_DIR or GIT_WORK_TREE the shell may carry, which would point it elsewhere. */
export function gitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = { ...env }
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete clean[name]
  return clean
}

/** The nearest folder of this path that exists. */
function nearestExisting(p: string): string {
  let at = path.resolve(p)
  while (!fs.existsSync(at) && path.dirname(at) !== at) at = path.dirname(at)
  return at
}

/** The top of the Git work tree this path is in (as far as it exists), or null if it is in none. */
export function gitTopLevel(p: string): string | null {
  const run = spawnSync('git', ['-C', nearestExisting(p), 'rev-parse', '--show-toplevel'], { encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'pipe', 'ignore'] })
  const top = run.status === 0 ? run.stdout.trim() : ''
  return top ? realPath(top) : null
}

/** Whether a folder is a clone of AgentVoice (or a copy of one): its package.json and the channel's code. */
export function isAgentVoiceClone(folder: string): boolean {
  try {
    const name = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8')).name
    return (name === 'agent-voice' || name === PACKAGE_NAME) && fs.existsSync(path.join(folder, 'src/channel/server.ts'))
  } catch {
    return false
  }
}

export interface FolderCheck {
  /** The session folder (links resolved). */
  folder: string
  client: Client
  /** The AgentVoice folder, its data folder (config.dataDir) and the package's folder. */
  ownerDir: string
  dataDir: string
  packageDir: string
  homeDir?: string
}

/**
 * Checks the session folder as setup takes it, and throws SetupError saying why one can't be used. Returns whether it
 * is there, and the record of an earlier setup there for this AgentVoice folder.
 */
export function checkSessionFolder({ folder, client, ownerDir, dataDir, packageDir, homeDir = os.homedir() }: FolderCheck): { exists: boolean; manifest: Manifest | null } {
  const shown = tildePath(folder, homeDir)
  const example = sessionExample(client)
  for (const [what, p] of [['The session folder', folder], ['Your AgentVoice folder', ownerDir], ['The data folder', dataDir]] as const) {
    if (CONTROL.test(p)) throw new SetupError(`${what} (${JSON.stringify(p)}) has a control character in its path, which can't go into a client's config: use a folder without one.`)
  }
  const real = realPath(folder)
  if (real === path.parse(real).root || real === realPath(homeDir)) {
    throw new SetupError(`${shown} is ${real === path.parse(real).root ? 'your whole disk' : 'your home folder'}. Make a folder for your meeting sessions and run this in it, for example: ${example}`)
  }
  for (const [name, dir] of [['your AgentVoice folder', ownerDir], ['its data folder', dataDir]] as const) {
    if (isWithin(folder, dir) || isWithin(dir, folder)) {
      throw new SetupError(
        `${shown} is ${isWithin(folder, dir) ? (sameFolder(folder, dir) ? name : `inside ${name}`) : `a folder that holds ${name}`} (${tildePath(dir, homeDir)}). ` +
          'Your coding client must start somewhere else: Codex lets its commands write the folder it starts in, and leaves ' +
          'placeholder files there for the ones it may not read; and the meeting-assistant would have that folder (your ' +
          `keys, the local token, the transcripts) within its reach. Make a folder of its own for your meeting sessions, for example: ${example}`,
      )
    }
  }
  if (isWithin(folder, packageDir)) {
    throw new SetupError(`${shown} is inside the installed package (${packageDir}), which npm replaces on every upgrade. Make a folder for your meeting sessions, for example: ${example}`)
  }
  if (isAgentVoiceClone(folder)) throw new SetupError(`${shown} is a clone of AgentVoice: ${CLONE_SETUP}.`)
  const top = gitTopLevel(folder)
  if (top !== null && !sameFolder(top, folder)) {
    throw new SetupError(
      `${shown} is inside the Git repository ${tildePath(top, homeDir)}, and your coding client would take that whole ` +
        `repository as the project. Make the session folder outside it, for example: ${example}`,
    )
  }
  for (const [what, p] of [['Your AgentVoice folder', ownerDir], ['The data folder', dataDir]] as const) {
    if (GLOB.test(p)) {
      throw new SetupError(
        `${what} (${p}) has one of * ? [ ] { } ( ) in its path, which the clients' rules read as a pattern, so the rules ` +
          'setup writes for it would match other files: give AgentVoice a folder without them (AGENTVOICE_HOME, or ALEX_DATA_DIR for the data folder).',
      )
    }
  }

  const stat = fs.statSync(folder, { throwIfNoEntry: false })
  if (!stat) return { exists: false, manifest: null }
  if (!stat.isDirectory()) throw new SetupError(`${shown} is a file, not a folder. Make a folder for your meeting sessions, for example: ${example}`)
  if (fs.readdirSync(folder).every(name => name === '.DS_Store')) return { exists: true, manifest: null }
  const manifest = readManifest(folder)
  if (manifest && sameFolder(manifest.home, ownerDir)) return { exists: true, manifest }
  if (manifest) {
    throw new SetupError(
      `${shown} was set up for another AgentVoice folder, ${tildePath(manifest.home, homeDir)} (its ${MANIFEST}), not ${tildePath(ownerDir, homeDir)}. ` +
        `Set up a new, empty folder for this one, for example: ${example}`,
    )
  }
  throw new SetupError(
    `${shown} already holds files that agentvoice setup didn't make. The folder you start your coding client in for ` +
      'meetings gives the meeting-assistant its reach (Claude Code reads it without asking, Codex may write it), so setup ' +
      `takes a new, empty folder: ${example}`,
  )
}

/** Makes the session folder a Git repository of its own, if it isn't one: each client then takes it as the project's root. */
export function gitInit(folder: string): boolean {
  if (fs.existsSync(path.join(folder, '.git'))) return false
  const run = spawnSync('git', ['-C', folder, 'init', '-q'], { encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
  if (run.status !== 0) throw new SetupError(`git init in ${tildePath(folder)} failed: ${(run.stderr || run.stdout).trim() || `exit ${run.status}`}`)
  return true
}
