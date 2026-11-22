// agentvoice setup opencode: the session folder's OpenCode files. The package's opencode.json with the channel started
// by absolute paths into the installed package and the AgentVoice folder in its environment (OpenCode runs the
// channel in its background service, which doesn't see your terminal's environment), the slides command asked for
// however it is run, and the meeting-assistant let read the transcripts and minutes, which are outside the folder. The
// policies (the floor) already deny .env, local-token and data/decks by name anywhere. The meeting-assistant is the
// package's, byte for byte. With --source, your .opencode/opencode.json lets it read those folders too, by the rules
// of scripts/install-opencode.sh.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OPENCODE_INSTALL, commandWords } from '../commands.ts'
import { OPENCODE_TESTED } from '../channel/push-opencode.ts'
import { pathForms } from './claude-code.ts'
import { SetupError, type SetupFile, parseJsonObject } from './files.ts'
import { expandHome } from './folder.ts'

export const OPENCODE_CONFIG = 'opencode.json'
export const OPENCODE_AGENT = '.opencode/agents/meeting-assistant.md'
export const OPENCODE_LOCAL = '.opencode/opencode.json'
/** What the shell asks for before running: agentvoice slides, by name or by the <node> <bin> form this file starts the channel with. */
export const SLIDES_ASK = '*agentvoice* slides *'

type Rule = { action: string; resource: string; effect: string }

/** The meeting-assistant's reading outside the folder: what --source and the data folder's rules are. */
const outside = (rule: unknown) => (rule as Rule | null)?.action === 'external_directory' && (rule as Rule).effect === 'allow'
const folderRule = (dir: string): Rule => ({ action: 'external_directory', resource: `${dir.replaceAll('\\', '/')}/*`, effect: 'allow' })

/** The rules that let the meeting-assistant read the transcripts and minutes, which the meeting names. */
export function dataDirRules(dataDir: string): Rule[] {
  return pathForms(dataDir).flatMap(dir => [folderRule(path.join(dir, 'transcripts')), folderRule(path.join(dir, 'minutes'))])
}

/**
 * The folders given with --source, as the rules name them: their real paths. Refuses one that isn't a folder, the whole
 * disk, the home folder, and a folder that holds it (also when a link leads there).
 */
export function sourceFolders(given: readonly string[], cwd: string = process.cwd(), homeDir: string = os.homedir()): string[] {
  let home: string | null = null
  try {
    home = fs.realpathSync(homeDir)
  } catch {
    home = path.resolve(homeDir)
  }
  const holdsHome = (folder: string) => home !== null && (home === folder || home.startsWith(folder.endsWith(path.sep) ? folder : folder + path.sep))
  return given.map(source => {
    let real: string
    try {
      real = fs.realpathSync(path.resolve(cwd, expandHome(source, homeDir)))
    } catch {
      throw new SetupError(`${source} is not a folder setup can find.`)
    }
    if (!fs.statSync(real).isDirectory()) throw new SetupError(`${source} is not a folder: give the folder a source is in.`)
    if (real === path.parse(real).root || holdsHome(real)) {
      throw new SetupError(`${source} is your whole disk or home folder, or holds your home folder: give the folders your sources are in.`)
    }
    return real
  })
}

export interface OpenCodeInput {
  packageDir: string
  home: string
  dataDir: string
  node: string
  bin: string
  /** .opencode/opencode.json as it is in the session folder, if it is there. */
  local?: string
  /** The --source folders (sourceFolders), or null to leave your file as it is; [] with --no-sources. */
  sources?: string[] | null
}

/** The files setup writes for OpenCode: what the tests check. */
export function renderOpenCode({ packageDir, home, dataDir, node, bin, local, sources = null }: OpenCodeInput): SetupFile[] {
  const config = JSON.parse(fs.readFileSync(path.join(packageDir, OPENCODE_CONFIG), 'utf8'))
  const server = config.mcp.servers['zoom-meeting']
  // One command, not a path per part (the script's path.resolve would make "channel" a path).
  server.command = [node, bin, 'channel']
  server.environment = { AGENTVOICE_CLIENT: 'opencode', AGENTVOICE_HOME: home }
  const cloneSlides = `${commandWords('clone', packageDir).run('slides')} *`
  const slides = (config.permissions as Rule[]).find(rule => rule.action === 'shell' && rule.resource === cloneSlides)
  if (!slides) throw new Error(`${path.join(packageDir, OPENCODE_CONFIG)} has no ask for "${cloneSlides}": the package is broken.`)
  slides.resource = SLIDES_ASK
  const agent = config.agents['meeting-assistant'].permissions as Rule[]
  if (agent[0]?.action !== '*' || agent[0]?.effect !== 'deny') throw new Error(`${path.join(packageDir, OPENCODE_CONFIG)}: the meeting-assistant's rules don't start by denying everything: the package is broken.`)
  agent.push(...dataDirRules(dataDir))

  const files: SetupFile[] = [
    { rel: OPENCODE_CONFIG, content: `${JSON.stringify(config, null, 2)}\n` },
    { rel: OPENCODE_AGENT, content: fs.readFileSync(path.join(packageDir, OPENCODE_AGENT), 'utf8') },
  ]
  if (sources === null) return files
  // Yours, read after opencode.json: only the meeting-assistant's reading of the source folders, as the script writes it.
  const mine = local === undefined ? {} : parseJsonObject(local, OPENCODE_LOCAL)
  mine.$schema ??= 'https://opencode.ai/config.json'
  const agents = (mine.agents ?? {}) as Record<string, { permissions?: unknown[] } & Record<string, unknown>>
  const assistant = agents['meeting-assistant'] ?? {}
  const kept = (Array.isArray(assistant.permissions) ? assistant.permissions : []).filter(rule => !outside(rule))
  const next: Record<string, unknown> = { ...assistant, permissions: [...kept, ...sources.map(folderRule)] }
  if (!(next.permissions as unknown[]).length) delete next.permissions
  const allAgents: Record<string, unknown> = { ...agents, 'meeting-assistant': next }
  if (!Object.keys(next).length) delete allAgents['meeting-assistant']
  if (Object.keys(allAgents).length) mine.agents = allAgents
  else delete mine.agents
  files.push({ rel: OPENCODE_LOCAL, content: `${JSON.stringify(mine, null, 2)}\n`, merged: true })
  return files
}

/** The folders your .opencode/opencode.json lets the meeting-assistant read (its text), for the closing lines. */
export function sourcesIn(local: string | undefined): string[] {
  if (local === undefined) return []
  try {
    const rules = JSON.parse(local)?.agents?.['meeting-assistant']?.permissions
    return Array.isArray(rules) ? rules.filter(outside).map(rule => (rule as Rule).resource.replace(/\/\*$/, '')) : []
  } catch {
    return []
  }
}

/** Whether your .opencode/opencode.json has a zoom-meeting server of its own, which would replace opencode.json's. */
export function localServer(local: string | undefined): boolean {
  if (local === undefined) return false
  try {
    return JSON.parse(local)?.mcp?.servers?.['zoom-meeting'] !== undefined
  } catch {
    return false
  }
}

/** What opencode --version says: V2 at OPENCODE_TESTED or later, else a refusal; a note for a newer major version. */
export function openCodeVersion(output: string): { version: string; note?: string } {
  const version = /\d+\.\d+\.\d+/.exec(output)?.[0]
  if (!version) throw new SetupError(`Could not tell which OpenCode this is (opencode --version gave no version). AgentVoice needs OpenCode ${OPENCODE_TESTED} or later.`)
  const [major, minor, patch] = version.split('.').map(Number)
  if (major < 2) {
    throw new SetupError(
      `OpenCode ${version} is V1 (npm opencode-ai), which AgentVoice doesn't support: its tool calls time out after 60 seconds.\n` +
        `Install V2 instead: ${OPENCODE_INSTALL}`,
    )
  }
  const [tMajor, tMinor, tPatch] = OPENCODE_TESTED.split('.').map(Number)
  if (major === tMajor && (minor < tMinor || (minor === tMinor && patch < tPatch))) {
    throw new SetupError(`OpenCode ${version} is older than ${OPENCODE_TESTED}, the earliest AgentVoice supports: update it (${OPENCODE_INSTALL}).`)
  }
  return major > tMajor ? { version, note: `Note: OpenCode ${version} is newer than AgentVoice was tested with (${OPENCODE_TESTED}). If something fails, tell us.` } : { version }
}
