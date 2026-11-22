// agentvoice setup claude-code: the session folder's Claude Code files, and the zoom-meeting channel registered for
// that folder only (local scope), started by absolute paths into the installed package with the AgentVoice folder in
// its own environment (AGENTVOICE_HOME). The floor (.claude/settings.json, deny rules only) and the meeting-assistant
// are the package's, byte for byte. .claude/settings.local.json is yours: setup only adds to it what the
// meeting-assistant needs to run in the background, where it can't answer a prompt: its six channel tools, and reading
// the transcripts and minutes the meeting names, which are outside the project when installed from npm. Read rules,
// not additionalDirectories (which would let edit modes write the data folder); the floor's deny rules still win.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isWithin, realPath } from '../home.ts'
import { SetupError, type SetupFile, parseJsonObject } from './files.ts'

/** The meeting-assistant's six channel tools, allowed in settings.local.json. */
export const CLAUDE_CHANNEL_TOOLS = ['next_question', 'get_profile', 'reply', 'post_chat', 'add_to_brief', 'get_transcript'].map(tool => `mcp__zoom-meeting__${tool}`)
export const CLAUDE_SETTINGS = '.claude/settings.json'
export const CLAUDE_AGENT = '.claude/agents/meeting-assistant.md'
export const CLAUDE_LOCAL = '.claude/settings.local.json'

/** The forms a folder is named by in rules: as given and, if links lead elsewhere, as it really is. */
export function pathForms(dir: string): string[] {
  return [...new Set([path.resolve(dir), realPath(dir)])]
}

/** The read rules for the transcripts and minutes: an absolute path, written as //..., Claude Code's form for one. */
export function claudeReadRules(dataDir: string): string[] {
  return pathForms(dataDir).flatMap(dir => [`Read(/${dir}/transcripts/**)`, `Read(/${dir}/minutes/**)`])
}

/** What setup adds to permissions.allow, in this order. */
export const claudeAllows = (dataDir: string): string[] => [...CLAUDE_CHANNEL_TOOLS, ...claudeReadRules(dataDir)]

export interface ClaudeCodeInput {
  /** The package's folder, whose templates are copied. */
  packageDir: string
  /** The data folder (config.dataDir): where the transcripts and minutes are. */
  dataDir: string
  /** .claude/settings.local.json as it is in the session folder, if it is there. */
  local?: string
}

/** The files setup writes for Claude Code: what the tests check. */
export function renderClaudeCode({ packageDir, dataDir, local }: ClaudeCodeInput): SetupFile[] {
  const template = (rel: string) => fs.readFileSync(path.join(packageDir, rel), 'utf8')
  const mine = local === undefined ? {} : parseJsonObject(local, CLAUDE_LOCAL)
  const permissions = mine.permissions ?? {}
  if (typeof permissions !== 'object' || permissions === null || Array.isArray(permissions)) {
    throw new SetupError(`${CLAUDE_LOCAL} has a "permissions" that isn't an object: fix or remove it, then run this again.`)
  }
  const allow = (permissions as { allow?: unknown }).allow ?? []
  if (!Array.isArray(allow)) throw new SetupError(`${CLAUDE_LOCAL} has a "permissions.allow" that isn't a list: fix or remove it, then run this again.`)
  const added = claudeAllows(dataDir).filter(rule => !allow.includes(rule))
  const merged = { ...mine, permissions: { ...permissions, allow: [...allow, ...added] } }
  return [
    { rel: CLAUDE_SETTINGS, content: template(CLAUDE_SETTINGS) },
    { rel: CLAUDE_AGENT, content: template(CLAUDE_AGENT) },
    { rel: CLAUDE_LOCAL, content: `${JSON.stringify(merged, null, 2)}\n`, merged: true },
  ]
}

/** Runs a command and gives its exit status and output (stdio: what it shows). */
export type Runner = (command: string, args: string[], options: { cwd: string; quiet?: boolean }) => { status: number | null; stdout: string; stderr: string }

export const runCommand: Runner = (command, args, { cwd, quiet }) => {
  const run = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (!quiet) {
    if (run.stdout) process.stdout.write(run.stdout)
    if (run.stderr) process.stderr.write(run.stderr)
  }
  return { status: run.error ? null : run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? (run.error?.message ?? '') }
}

export interface ClaudeRegistration {
  folder: string
  home: string
  node: string
  bin: string
  run?: Runner
  /** Where Claude Code keeps .claude.json: CLAUDE_CONFIG_DIR, else the home folder. */
  configDir?: string
  log?: (line: string) => void
}

/**
 * Registers the channel for the session folder only: takes away a registration for every project (an earlier install's)
 * and this folder's own (claude mcp add refuses a name that is there), adds it, and reads back what Claude Code
 * recorded. Throws SetupError when Claude Code refuses it, or recorded something else.
 */
export function registerClaudeCode({ folder, home, node, bin, run = runCommand, configDir = process.env.CLAUDE_CONFIG_DIR || os.homedir(), log = console.log }: ClaudeRegistration): void {
  if (run('claude', ['mcp', 'remove', '--scope', 'user', 'zoom-meeting'], { cwd: folder, quiet: true }).status === 0) {
    log('Removed the zoom-meeting channel an earlier install registered for all your projects.')
  }
  run('claude', ['mcp', 'remove', '--scope', 'local', 'zoom-meeting'], { cwd: folder, quiet: true })
  // The server's name before -e, which takes several values: after it, the name is read as one more variable.
  const added = run('claude', ['mcp', 'add', '--scope', 'local', 'zoom-meeting', '-e', `AGENTVOICE_HOME=${home}`, '--', node, bin, 'channel'], { cwd: folder })
  if (added.status !== 0) {
    throw new SetupError(`claude mcp add failed (${added.status === null ? 'it did not run' : `exit ${added.status}`}), so the channel is not registered: ${(added.stderr || added.stdout).trim()}`)
  }
  const file = path.join(configDir, '.claude.json')
  let projects: Record<string, { mcpServers?: Record<string, unknown> }>
  try {
    projects = JSON.parse(fs.readFileSync(file, 'utf8')).projects ?? {}
  } catch {
    log(`Warning: ${file} couldn't be read, so setup couldn't confirm what Claude Code registered. Check it with: claude mcp get zoom-meeting (run in ${folder})`)
    return
  }
  const ours = (entry: unknown) => {
    const e = entry as { command?: unknown; args?: unknown; env?: Record<string, unknown> } | undefined
    return e?.command === node && JSON.stringify(e.args) === JSON.stringify([bin, 'channel']) && e.env?.AGENTVOICE_HOME === home
  }
  const here = Object.entries(projects).find(([key]) => key === folder || realPath(key) === folder)?.[1]?.mcpServers?.['zoom-meeting']
  if (here !== undefined) {
    if (!ours(here)) throw new SetupError(`Claude Code recorded another zoom-meeting server for ${folder} than the one given: ${JSON.stringify(here)}. Check it with: claude mcp get zoom-meeting`)
    return
  }
  // Recorded for a folder around this one (one with a .git, which Claude Code takes for the project): not this folder's.
  const outer = Object.entries(projects).find(([key, project]) => key !== folder && isWithin(folder, key) && ours(project?.mcpServers?.['zoom-meeting']))?.[0]
  if (outer !== undefined) throw new SetupError(`Claude Code registered it for ${outer}, not this folder (${folder}).`)
  log(`Warning: ${file} has no zoom-meeting server for ${folder}, so setup couldn't confirm what Claude Code registered. Check it with: claude mcp get zoom-meeting (run in ${folder})`)
}
