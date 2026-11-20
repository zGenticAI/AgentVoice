// The file floor of each client, read the way that client reads it, so tests can compare them by the files each keeps
// a session from reading: Claude Code's .claude/settings.json deny rules, Codex's permission profile in
// .codex/config.toml (as Codex 0.171.0 applies it to the commands it runs) and OpenCode's policies in opencode.json
// (as OpenCode 2.3.2 matches them). Example paths are relative to this folder ("src/.env"), in the home folder
// ("~/.ssh/id_ed25519") or absolute; the examples place this folder at /home/sam/av.
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from '../src/config.ts'
import { parseToml, type TomlTable } from './toml.ts'

export const HOME = '/home/sam'
export const FOLDER = `${HOME}/av`

/** An example path as an absolute one. */
export const absolute = (p: string) => (p.startsWith('~/') ? `${HOME}/${p.slice(2)}` : p.startsWith('/') ? p : `${FOLDER}/${p}`)

/** Where an absolute path is in this folder, or null if it is not in it. */
const inFolder = (abs: string) => (abs.startsWith(`${FOLDER}/`) ? abs.slice(FOLDER.length + 1) : null)

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

// --- Claude Code ---------------------------------------------------------------------------------------------------
/** Claude Code's deny rules for reading, from .claude/settings.json. */
export const CLAUDE_DENY: string[] = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/settings.json'), 'utf8')).permissions.deny

/** Whether a Claude Code rule stops a session reading this file: "//" is the disk's root, "~/" the home folder. */
export function claudeDenies(p: string): boolean {
  const abs = absolute(p)
  return CLAUDE_DENY.some(rule => {
    const glob = /^Read\((.+)\)$/.exec(rule)?.[1]
    if (!glob) return false
    const full = glob.startsWith('//') ? glob.slice(1) : glob.startsWith('~/') ? `${HOME}/${glob.slice(2)}` : null
    return !!full && globRegExp(full).test(abs)
  })
}

// --- Codex ---------------------------------------------------------------------------------------------------------
export const CODEX_CONFIG: TomlTable = parseToml(fs.readFileSync(path.join(ROOT, '.codex/config.toml'), 'utf8'))

/** The permission profile the committed config selects for this folder. */
export function codexProfile(): TomlTable {
  const name = CODEX_CONFIG.default_permissions as string
  return (CODEX_CONFIG.permissions as TomlTable)[name] as TomlTable
}

/**
 * Whether the selected profile keeps a command Codex runs from reading this file, with Codex started at this folder's
 * root (its workspace root): a "deny" path covers itself and all in it; a pattern under ":workspace_roots" covers the
 * files it matches in this folder, which Codex on Linux looks for to glob_scan_max_depth names deep.
 */
export function codexDenies(p: string): boolean {
  const abs = absolute(p)
  const filesystem = codexProfile().filesystem as TomlTable
  const depth = (filesystem.glob_scan_max_depth as number | undefined) ?? Infinity
  const under = (target: string) => abs === target || abs.startsWith(`${target}/`)
  for (const [key, access] of Object.entries(filesystem)) {
    if (key === 'glob_scan_max_depth') continue
    if (key === ':workspace_roots') {
      const rel = inFolder(abs)
      if (rel === null) continue
      for (const [sub, subAccess] of Object.entries(access as TomlTable)) {
        if (subAccess !== 'deny') continue
        if (hasGlob(sub) ? globRegExp(sub).test(rel) && rel.split('/').length <= depth : rel === sub || rel.startsWith(`${sub}/`)) return true
      }
      continue
    }
    if (access !== 'deny') continue
    if (key.startsWith(':')) throw new Error(`a special path this reading doesn't take: ${key}`)
    const target = key.startsWith('~/') ? `${HOME}/${key.slice(2)}` : key
    if (hasGlob(target) ? globRegExp(target).test(abs) : under(target)) return true
  }
  return false
}

// --- OpenCode ------------------------------------------------------------------------------------------------------
export type OpenCodeRule = { action: string; resource: string; effect: 'allow' | 'deny' | 'ask' }
export const OPENCODE_CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'opencode.json'), 'utf8'))

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

/**
 * Whether OpenCode's policies stop its read tool reading this file. OpenCode names a file in the project by its path
 * from where it was opened, and any other by its absolute path.
 */
export function openCodeDenies(p: string): boolean {
  const abs = absolute(p)
  const resource = inFolder(abs) ?? abs
  const policies: OpenCodeRule[] = OPENCODE_CONFIG.policies
  return policies.findLast(policy => policy.action === 'tool.use' && openCodeMatch(`read:${resource}`, policy.resource))?.effect === 'deny'
}
