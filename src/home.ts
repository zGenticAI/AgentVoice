// Where AgentVoice runs from, and where the owner's files are. Two modes, told apart by where the package sits:
// - a clone (the repository, a source zip, a copy, npm link): everything is in that folder, as it always was;
// - installed from npm (<anything>/node_modules/<PACKAGE_NAME>): the package folder holds only the code and the
//   templates, which npm replaces on every upgrade, and the owner's files (.env, profile.md, briefs/, data/) are in
//   their AgentVoice folder, ~/.agentvoice unless AGENTVOICE_HOME names another.
// Every process that loads this from the same package gets the same answer: the service, the commands, the channel.
// Node builtins only: src/env.ts imports it before .env is read, and the slide converter's parent may reach it, so it
// never imports env.ts, config.ts or any network code (test/import-graph.test.ts).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_NAME = '@zgentic/agentvoice'
/** The package's own folder: code, public/, the name corpus, the templates. In a clone, the repository. */
export const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export type InstallMode = 'clone' | 'installed'

/**
 * A path with its links resolved, for one that may not exist yet too: the nearest existing folder's real path, plus
 * the rest as given.
 */
export function realPath(file: string): string {
  const rest: string[] = []
  let current = path.resolve(file)
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...rest)
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(file)
      rest.unshift(path.basename(current))
      current = parent
    }
  }
}

/** Whether file is dir itself or inside it, links resolved (for paths not made yet, as far as they exist). */
export function isWithin(file: string, dir: string): boolean {
  const rel = path.relative(realPath(dir), realPath(file))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

/** 'installed' when the package folder, links resolved, is <anything>/node_modules/<PACKAGE_NAME>. */
export function installModeOf(packageDir: string): InstallMode {
  let real: string
  try {
    real = fs.realpathSync(packageDir)
  } catch {
    real = path.resolve(packageDir)
  }
  const parts = real.split(path.sep)
  const [scope, name] = PACKAGE_NAME.split('/')
  return parts.at(-3) === 'node_modules' && parts.at(-2) === scope && parts.at(-1) === name ? 'installed' : 'clone'
}

/**
 * The owner's folder: in a clone, the clone itself (AGENTVOICE_HOME is not read); installed, AGENTVOICE_HOME, or
 * ~/.agentvoice when it is unset or empty. Throws, saying why, on an AGENTVOICE_HOME that can't be used.
 */
export function ownerDirFor(mode: InstallMode, env: NodeJS.ProcessEnv = process.env, home = os.homedir(), packageDir = PACKAGE_DIR): string {
  if (mode === 'clone') return packageDir
  const set = env.AGENTVOICE_HOME?.trim()
  if (!set) return path.join(home, '.agentvoice')
  const expanded = set === '~' ? home : set.startsWith('~/') ? path.join(home, set.slice(2)) : set
  if (!path.isAbsolute(expanded)) {
    throw new Error(
      `AGENTVOICE_HOME is "${set}": give an absolute path, or one that starts with ~/, so the service, the commands and ` +
        'your coding client all find the same folder.',
    )
  }
  const dir = path.resolve(expanded)
  const real = realPath(dir)
  if (real === path.parse(real).root || real === realPath(home)) {
    throw new Error(`AGENTVOICE_HOME is ${dir}, your whole disk or your home folder: give AgentVoice a folder of its own, such as ~/.agentvoice.`)
  }
  if (isWithin(dir, packageDir)) {
    throw new Error(
      `AGENTVOICE_HOME (${dir}) is inside the installed package (${packageDir}), which npm replaces on every upgrade: ` +
        'choose a folder outside it.',
    )
  }
  return dir
}

export const INSTALL_MODE: InstallMode = installModeOf(PACKAGE_DIR)
/** The owner's folder: .env, profile.md, briefs/ and data/ (unless ALEX_DATA_DIR says another). In a clone, PACKAGE_DIR. */
export const OWNER_DIR = ownerDirFor(INSTALL_MODE)
export const PACKAGE_VERSION: string = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8')).version

/** Installed only: whether this path (made or not yet made) is the package folder or inside it. Always false in a clone. */
export function insidePackage(file: string, mode: InstallMode = INSTALL_MODE, packageDir = PACKAGE_DIR): boolean {
  return mode === 'installed' && isWithin(file, packageDir)
}

/** A path as people read it: the home folder as "~" (for messages; never for files that are written). */
export function tildePath(file: string, home = os.homedir()): string {
  const rel = path.relative(home, file)
  if (rel === '') return '~'
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return file
  return `~/${rel}${file.endsWith(path.sep) ? path.sep : ''}`
}

/**
 * Why the owner's files can't go at this path: it is inside the installed package, which npm replaces on every upgrade.
 * setting is what put them there (ALEX_DATA_DIR, CONTROL_SOCKET).
 */
export function packagePathError(file: string, setting: string, packageDir = PACKAGE_DIR, ownerDir = OWNER_DIR): Error {
  return new Error(
    `${file} is inside the installed package (${packageDir}), which npm replaces on every upgrade: ${setting} must point ` +
      `outside it, into your AgentVoice folder (${tildePath(ownerDir)}) for example.`,
  )
}

/** Installed only: throws packagePathError when this path is inside the package, so nothing is ever written there. */
export function refuseInsidePackage(file: string, setting: string): void {
  if (insidePackage(file)) throw packagePathError(file, setting)
}
