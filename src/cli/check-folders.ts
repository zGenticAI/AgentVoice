// What agentvoice check says first, installed from npm: where your AgentVoice folder, settings, data and the package
// are, and what to fix there. Warnings, not failures: a folder or .env others can open, a profile or shared brief
// still the example, a session folder whose setup is for another version, node or AgentVoice folder, and an installed
// voice service that starts another AgentVoice (or a node that is gone). In a clone, only a note when AGENTVOICE_HOME
// is set, since a clone ignores it.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { tildePath } from '../home.ts'
import { MANIFEST, parseManifest, sameFolder, staleReasons } from '../setup/files.ts'
import { type ServiceKind, readBackProgram, readBackWorkingDirectory, unitFile } from '../service/units.ts'

export interface FolderReport {
  /** The AgentVoice folder, and whether AGENTVOICE_HOME named it. */
  home: string
  fromSetting: boolean
  dataDir: string
  packageDir: string
  version: string
  /** The profile in use (PROFILE_FILE, else profile.md in the AgentVoice folder). */
  profileFile: string
  /** The folder check runs in: a session folder, perhaps. */
  cwd: string
  /** The command setup and service install write: [node, bin] (agentvoiceCommand). */
  node: string
  bin: string
  /** The service's label (SERVICE_LABEL), and this computer's service manager. */
  label: string
  kind: ServiceKind | null
  env?: NodeJS.ProcessEnv
  homeDir?: string
}

/** The Folders block's lines. */
export function folderReport(r: FolderReport): string[] {
  const homeDir = r.homeDir ?? os.homedir()
  const t = (p: string) => tildePath(p, homeDir)
  // A path as a command takes it: ~/... unless it needs quotes, which "~" can't be in.
  const arg = (p: string) => (/^~?[\w@%+=:,./-]+$/.test(t(p)) ? t(p) : `"${p}"`)
  const mode = (p: string) => fs.statSync(p, { throwIfNoEntry: false })?.mode
  const octal = (m: number) => (m & 0o777).toString(8)
  const same = (file: string, example: string) => {
    try {
      return fs.readFileSync(file).equals(fs.readFileSync(path.join(r.packageDir, example)))
    } catch {
      return false
    }
  }
  const env = path.join(r.home, '.env')
  const envThere = fs.existsSync(env)
  const lines = [
    'Folders',
    `  AgentVoice folder: ${t(r.home)}${r.fromSetting ? ' (AGENTVOICE_HOME)' : ''}`,
    `  Settings: ${t(env)}${envThere ? '' : ' (not there yet: agentvoice init makes it)'}`,
    `  Data: ${t(r.dataDir)}`,
    `  Package: ${r.packageDir} (${r.version})`,
  ]
  const warn = (text: string) => lines.push(`  Warning: ${text}`)
  const homeMode = mode(r.home)
  if (homeMode !== undefined && homeMode & 0o077) warn(`${t(r.home)} can be opened by other users (mode ${octal(homeMode)}): chmod 700 ${arg(r.home)}`)
  const envMode = envThere ? mode(env) : undefined
  if (envMode !== undefined && envMode & 0o077) warn(`${t(env)} can be read by other users (mode ${octal(envMode)}): chmod 600 ${arg(env)}`)
  if (same(r.profileFile, 'profile.example.md')) warn(`${t(r.profileFile)} is still the example (profile.example.md): make it yours.`)
  const brief = path.join(r.dataDir, 'brief.md')
  if (same(brief, 'brief.example.md')) warn(`the shared brief, ${t(brief)}, is still the example (brief.example.md): fill it in for your meetings.`)

  // A session folder setup made, for another version, node or AgentVoice folder: its configs start the channel by paths.
  let manifest = null
  try {
    manifest = parseManifest(fs.readFileSync(path.join(r.cwd, MANIFEST), 'utf8'))
  } catch {
    // None here: not a session folder.
  }
  if (manifest) {
    const reasons = staleReasons(manifest, { version: r.version, home: r.home, node: r.node, bin: r.bin }, fs.existsSync, homeDir)
    if (reasons.length) {
      for (const client of Object.keys(manifest.clients)) warn(`this folder's coding-client setup is out of date: ${reasons.join('; ')}. Run agentvoice setup ${client} again here.`)
    }
  }

  // The installed voice service, if any, for this label.
  if (r.kind) {
    const file = unitFile(r.kind, r.label, r.env ?? process.env, homeDir)
    let text: string | null = null
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      // Not installed.
    }
    if (text !== null) {
      const dir = readBackWorkingDirectory(r.kind, text)
      const [node, bin] = readBackProgram(r.kind, text) ?? []
      if (dir === null || !sameFolder(dir, r.home)) {
        warn(`${t(file)} runs the voice service from ${dir === null ? 'no folder it names' : t(dir)}, not your AgentVoice folder: agentvoice service install --replace replaces it with this one.`)
      } else {
        const reasons: string[] = []
        if (node !== r.node) reasons.push(`it starts the voice service with ${node ?? 'no node'}, not ${r.node}`)
        else if (!fs.existsSync(node)) reasons.push(`the node it starts the voice service with, ${node}, is no longer there`)
        if (bin !== r.bin) reasons.push(`it starts ${bin ?? 'no command'}, not this AgentVoice's ${r.bin}`)
        if (reasons.length) warn(`${t(file)} is out of date: ${reasons.join('; ')}. Run agentvoice service install again.`)
      }
    }
  }
  return lines
}

/** In a clone, the one line check adds: AGENTVOICE_HOME is set (value), and ignored. Null when it isn't set. */
export function cloneHomeNote(value: string | undefined): string | null {
  return value?.trim() ? '  Note: AGENTVOICE_HOME is set, but this is a cloned folder: its own .env and data/ are used, and AGENTVOICE_HOME is ignored.' : null
}
