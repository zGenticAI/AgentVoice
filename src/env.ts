// Loads .env before anything reads process.env. Its own module so that config.ts and identity.ts can both
// rely on it without importing each other first. Variables already set (as npm test sets some) win over .env.
import { config as loadEnv } from 'dotenv'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
loadEnv({ path: path.join(ROOT, '.env'), quiet: true })

/**
 * A path from .env, with a leading "~" taken as the home folder (dotenv doesn't expand it, and the service's own
 * advice for a long data path is CONTROL_SOCKET=~/.agent-voice/control.sock). A relative path is taken from this folder.
 */
export function pathSetting(value: string, home = os.homedir()): string {
  const expanded = value === '~' ? home : value.startsWith('~/') ? path.join(home, value.slice(2)) : value
  return path.resolve(ROOT, expanded)
}
