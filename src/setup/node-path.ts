// The command that starts AgentVoice by absolute paths, as agentvoice setup writes it into a coding client's config and
// agentvoice service install into the service's unit: [node, the package's bin]. Clients don't give the channel the
// shell's PATH (OpenCode's background service, Codex's fixed list of variables), so neither is found by name.
import fs from 'node:fs'
import path from 'node:path'
import { PACKAGE_DIR } from '../home.ts'

function real(file: string): string | null {
  try {
    return fs.realpathSync(file)
  } catch {
    return null
  }
}

/**
 * The node to write down for this one. process.execPath is Node's resolved path, which with Homebrew is a versioned
 * Cellar folder (<brew>/Cellar/<formula>/<version>/bin/node) that the next brew upgrade removes. When the formula's opt
 * link (<brew>/opt/<formula>/bin/node) leads to the same file, that link is written instead: it follows upgrades.
 * Anything else (nvm's, fnm's or Volta's folder, /usr/bin/node) as it is. Never PATH's node: fnm's per-shell link is
 * temporary.
 */
export function stableNodePath(execPath: string = process.execPath): string {
  const parts = execPath.split(path.sep)
  const cellar = parts.lastIndexOf('Cellar')
  if (cellar < 1 || parts.length !== cellar + 5 || parts[cellar + 3] !== 'bin' || parts[cellar + 4] !== 'node') return execPath
  const formula = parts[cellar + 1]
  const opt = [...parts.slice(0, cellar), 'opt', formula, 'bin', 'node'].join(path.sep)
  const target = real(execPath)
  return target !== null && real(opt) === target ? opt : execPath
}

/** [node, bin]: this Node (stableNodePath) and this package's bin/agentvoice.js, by its real path. */
export function agentvoiceCommand(execPath: string = process.execPath, packageDir: string = PACKAGE_DIR): [string, string] {
  return [stableNodePath(execPath), path.join(real(packageDir) ?? path.resolve(packageDir), 'bin', 'agentvoice.js')]
}
