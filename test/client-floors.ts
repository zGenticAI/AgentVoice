// The file floor of each client, read the way that client reads it, so tests can compare them by the files each keeps
// a session from reading: Claude Code's .claude/settings.json deny rules, Codex's permission profile in
// .codex/config.toml (as Codex 0.171.0 applies it to the commands it runs) and OpenCode's policies in opencode.json
// (as OpenCode 2.3.2 matches them). Example paths are relative to the project folder ("src/.env"), in the home folder
// ("~/.ssh/id_ed25519") or absolute. floorsFor() reads any set of those files at any place: the committed ones in a
// clone (the exports below, which place the clone at /home/sam/av), or what agentvoice setup writes into a session
// folder, with the AgentVoice folder outside it.
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from '../src/config.ts'
import { parseToml, type TomlTable } from './toml.ts'

export const HOME = '/home/sam'
export const FOLDER = `${HOME}/av`

/**
 * A glob as Claude Code's rules, gitignore and Codex's globset (with literal separators) read it: "**" spans folders
 * ("**\/" also matches none), "*" and "?" stay within one name.
 */
export function globRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith('**/', i)) {
      out += '(?:.*/)?'
      i += 2
    } else if (glob.startsWith('**', i)) {
      out += '.*'
      i += 1
    } else if (glob[i] === '*') out += '[^/]*'
    else if (glob[i] === '?') out += '[^/]'
    else out += glob[i].replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}
const hasGlob = (p: string) => /[*?[\]]/.test(p)

export type OpenCodeRule = { action: string; resource: string; effect: 'allow' | 'deny' | 'ask' }

/** OpenCode's wildcard match (packages/core/src/util/wildcard.ts at v2.3.2), as it runs off Windows. */
export function openCodeMatch(input: string, pattern: string): boolean {
  let escaped = pattern
    .replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  if (escaped.endsWith(' .*')) escaped = escaped.slice(0, -3) + '( .*)?'
  return new RegExp('^' + escaped + '$', 's').test(input.replaceAll('\\', '/'))
}

/** A permission check (OpenCode's permission.ts, evaluate): the last rule that matches, else ask. */
export const openCodeEvaluate = (action: string, resource: string, rules: OpenCodeRule[]) =>
  rules.findLast(rule => openCodeMatch(action, rule.action) && openCodeMatch(resource, rule.resource))?.effect ?? 'ask'
/** What every OpenCode agent starts with (its docs, "Permissions", Defaults), before the config's own rules. */
export const OPENCODE_BASE: OpenCodeRule[] = [
  { action: '*', resource: '*', effect: 'allow' },
  { action: 'read', resource: '*.env', effect: 'ask' },
  { action: 'read', resource: '*.env.*', effect: 'ask' },
  { action: 'read', resource: '*.env.example', effect: 'allow' },
]

export interface FloorPlace {
  /** The home folder ("~"), and the folder the client is started in (the project). */
  home: string
  project: string
}

export interface FloorFiles {
  /** .claude/settings.json (deny rules), and settings.local.json's allow rules if any. */
  claudeDeny: string[]
  claudeAllow?: string[]
  /** .codex/config.toml, parsed. */
  codex: TomlTable
  /** opencode.json, parsed. */
  opencode: { policies: OpenCodeRule[]; permissions: OpenCodeRule[]; agents: Record<string, { permissions?: OpenCodeRule[] }> }
}

/** Each client's floor, from these files, with the client started in place.project. */
export function floorsFor({ home, project }: FloorPlace, files: FloorFiles) {
  /** An example path as an absolute one. */
  const absolute = (p: string) => (p.startsWith('~/') ? `${home}/${p.slice(2)}` : p.startsWith('/') ? p : `${project}/${p}`)
  /** Where an absolute path is in the project, or null if it is not in it. */
  const inProject = (abs: string) => (abs.startsWith(`${project}/`) ? abs.slice(project.length + 1) : null)
  /** A Claude Code rule's glob as an absolute one: "//" is the disk's root, "~/" the home folder. */
  const claudeGlob = (rule: string, kind = 'Read') => {
    const glob = new RegExp(`^${kind}\\((.+)\\)$`).exec(rule)?.[1]
    if (!glob) return null
    return glob.startsWith('//') ? glob.slice(1) : glob.startsWith('~/') ? `${home}/${glob.slice(2)}` : null
  }
  const claudeMatches = (rules: string[], p: string) => {
    const abs = absolute(p)
    return rules.some(rule => {
      const full = claudeGlob(rule)
      return !!full && globRegExp(full).test(abs)
    })
  }

  /** Whether a Claude Code deny rule stops a session reading this file. */
  const claudeDenies = (p: string) => claudeMatches(files.claudeDeny, p)
  /** Whether a Claude Code allow rule lets a session (a background agent included) read this file without asking. */
  const claudeAllows = (p: string) => claudeMatches(files.claudeAllow ?? [], p)
  /** Whether Claude Code reads it without asking: in the project, or allowed, and not denied (deny wins). */
  const claudeReads = (p: string) => !claudeDenies(p) && (inProject(absolute(p)) !== null || claudeAllows(p))

  const codexProfile = (): TomlTable => (files.codex.permissions as TomlTable)[files.codex.default_permissions as string] as TomlTable
  /**
   * Whether the selected profile keeps a command Codex runs from reading this file, with Codex started at the project's
   * root (its workspace root): a "deny" path covers itself and all in it; a pattern under ":workspace_roots" covers the
   * files it matches in the project, which Codex on Linux looks for to glob_scan_max_depth names deep.
   */
  const codexDenies = (p: string) => {
    const abs = absolute(p)
    const filesystem = codexProfile().filesystem as TomlTable
    const depth = (filesystem.glob_scan_max_depth as number | undefined) ?? Infinity
    const under = (target: string) => abs === target || abs.startsWith(`${target}/`)
    for (const [key, access] of Object.entries(filesystem)) {
      if (key === 'glob_scan_max_depth') continue
      if (key === ':workspace_roots') {
        const rel = inProject(abs)
        if (rel === null) continue
        for (const [sub, subAccess] of Object.entries(access as TomlTable)) {
          if (subAccess !== 'deny') continue
          if (hasGlob(sub) ? globRegExp(sub).test(rel) && rel.split('/').length <= depth : rel === sub || rel.startsWith(`${sub}/`)) return true
        }
        continue
      }
      if (access !== 'deny') continue
      if (key.startsWith(':')) throw new Error(`a special path this reading doesn't take: ${key}`)
      const target = key.startsWith('~/') ? `${home}/${key.slice(2)}` : key
      if (hasGlob(target) ? globRegExp(target).test(abs) : under(target)) return true
    }
    return false
  }

  /**
   * Whether OpenCode's policies stop its read tool reading this file. OpenCode names a file in the project by its path
   * from where it was opened, and any other by its absolute path.
   */
  const openCodeDenies = (p: string) => {
    const abs = absolute(p)
    const resource = inProject(abs) ?? abs
    return files.opencode.policies.findLast(policy => policy.action === 'tool.use' && openCodeMatch(`read:${resource}`, policy.resource))?.effect === 'deny'
  }
  /**
   * Whether the meeting-assistant may read a file outside the project: OpenCode asks external_directory for its folder
   * ("<folder>/*") first, and the policies hold after that.
   */
  const openCodeAgentReads = (p: string) => {
    const abs = absolute(p)
    const rules = [...OPENCODE_BASE, ...files.opencode.permissions, ...(files.opencode.agents['meeting-assistant']?.permissions ?? [])]
    const reach = inProject(abs) !== null || openCodeEvaluate('external_directory', `${path.posix.dirname(abs)}/*`, rules) === 'allow'
    return reach && openCodeEvaluate('read', abs, rules) === 'allow' && !openCodeDenies(p)
  }

  return { absolute, inProject, claudeDenies, claudeAllows, claudeReads, codexProfile, codexDenies, openCodeDenies, openCodeAgentReads }
}

// --- The committed files, in a clone at /home/sam/av ---------------------------------------------------------------
/** Claude Code's deny rules for reading, from .claude/settings.json. */
export const CLAUDE_DENY: string[] = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/settings.json'), 'utf8')).permissions.deny
export const CODEX_CONFIG: TomlTable = parseToml(fs.readFileSync(path.join(ROOT, '.codex/config.toml'), 'utf8'))
export const OPENCODE_CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'opencode.json'), 'utf8'))

const CLONE = floorsFor({ home: HOME, project: FOLDER }, { claudeDeny: CLAUDE_DENY, codex: CODEX_CONFIG, opencode: OPENCODE_CONFIG })
/** An example path as an absolute one, in the clone at /home/sam/av. */
export const absolute = CLONE.absolute
/** Whether a Claude Code rule stops a session reading this file: "//" is the disk's root, "~/" the home folder. */
export const claudeDenies = CLONE.claudeDenies
/** The permission profile the committed config selects for this folder. */
export const codexProfile = CLONE.codexProfile
export const codexDenies = CLONE.codexDenies
export const openCodeDenies = CLONE.openCodeDenies
