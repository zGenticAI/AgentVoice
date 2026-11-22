// Loads .env before anything reads process.env. Its own module so that config.ts and identity.ts can both
// rely on it without importing each other first. Variables already set (as npm test sets some) win over .env.
// .env is in the owner's folder (src/home.ts): this folder in a clone; ~/.agentvoice, or AGENTVOICE_HOME, installed
// from npm.
import { config as loadEnv } from 'dotenv'
import os from 'node:os'
import path from 'node:path'
import { INSTALL_MODE, OWNER_DIR, PACKAGE_DIR } from './home.ts'

/** The package's own folder (the repository, in a clone): the same value as before, so the tests that use it hold. */
export const ROOT = PACKAGE_DIR
export { INSTALL_MODE, OWNER_DIR, PACKAGE_DIR }
// Which coding client started the zoom-meeting channel (src/channel/client-text.ts) is read before .env: .env is shared
// by every client that starts the channel in this folder, so only a client's own config may say (Codex's and
// OpenCode's set it; Claude Code's leaves it unset). inDotenv: .env set it too, which is ignored.
const clientBeforeDotenv = process.env.AGENTVOICE_CLIENT
// AGENTVOICE_HOME says where .env is, so it can't come from .env: OWNER_DIR was settled before it was read, and a value
// .env sets is taken out again, so that nothing in this process, nor any process it starts, takes it for the folder.
const homeBeforeDotenv = process.env.AGENTVOICE_HOME
loadEnv({ path: path.join(OWNER_DIR, '.env'), quiet: true })
export const CLIENT_SETTING = { value: clientBeforeDotenv, inDotenv: process.env.AGENTVOICE_CLIENT !== clientBeforeDotenv }
/** inDotenv: .env set AGENTVOICE_HOME, which is ignored (and taken out of the environment). */
export const HOME_SETTING = { value: homeBeforeDotenv, inDotenv: process.env.AGENTVOICE_HOME !== homeBeforeDotenv }
if (HOME_SETTING.inDotenv) delete process.env.AGENTVOICE_HOME

/**
 * A path from .env, with a leading "~" taken as the home folder (dotenv doesn't expand it, and the service's own
 * advice for a long data path is CONTROL_SOCKET=~/.agent-voice/control.sock). A relative path is taken from the owner's
 * folder (this folder, in a clone; ~/.agentvoice or AGENTVOICE_HOME, installed from npm).
 */
export function pathSetting(value: string, home = os.homedir()): string {
  const expanded = value === '~' ? home : value.startsWith('~/') ? path.join(home, value.slice(2)) : value
  return path.resolve(OWNER_DIR, expanded)
}
