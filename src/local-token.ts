// The data folder's permissions, and the local token: a random secret in <data folder>/local-token, readable
// only by you. The voice service makes it at its first start; the join CLI and the zoom-meeting channel read
// it from the same folder and send it on /api/join and /bridge. So another user or program on this machine,
// or a web page open in a browser here, can neither start bots on your Recall account nor take a meeting's
// questions, although those endpoints are on 127.0.0.1.
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { WORDS } from './commands.ts'
import { refuseInsidePackage } from './home.ts'

export const LOCAL_TOKEN_FILE = 'local-token'
// 64 hex characters. A shorter token (a file cut short, or edited by hand) is made again.
const TOKEN_BYTES = 32
const MIN_TOKEN_CHARS = 32

export function localTokenPath(dataDir: string): string {
  return path.join(dataDir, LOCAL_TOKEN_FILE)
}

/**
 * Installed from npm, the owner's folder (~/.agentvoice, or AGENTVOICE_HOME) holds .env with every key: the folder is
 * readable by you only (0700), and .env too (0600). Run at every start of the service, so a folder or .env that was
 * copied in, or loosened since, is made private again. Never in a clone, whose folder is the repository.
 */
export function prepareOwnerDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700) // mode applies only when the folder is created
  const env = path.join(dir, '.env')
  if (fs.existsSync(env)) fs.chmodSync(env, 0o600)
}

/**
 * The data folder holds transcripts, minutes, the brief and the local token: readable by you only (0700),
 * and the brief too (0600), since it holds what must not be disclosed. Run at every start, so a folder or
 * brief made before this was in place is made private as well. Installed from npm, never inside the package's folder,
 * which npm replaces on every upgrade.
 */
export function prepareDataDir(dataDir: string): void {
  refuseInsidePackage(dataDir, 'ALEX_DATA_DIR')
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dataDir, 0o700) // mode applies only when the folder is created
  const brief = path.join(dataDir, 'brief.md')
  if (fs.existsSync(brief)) fs.chmodSync(brief, 0o600)
}

/** The voice service's local token, made (0600) if there is none yet. */
export function ensureLocalToken(dataDir: string): string {
  refuseInsidePackage(dataDir, 'ALEX_DATA_DIR')
  const file = localTokenPath(dataDir)
  const existing = readTokenFile(file)
  if (existing.length >= MIN_TOKEN_CHARS) {
    fs.chmodSync(file, 0o600)
    return existing
  }
  const token = randomBytes(TOKEN_BYTES).toString('hex')
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 })
  fs.chmodSync(file, 0o600) // mode applies only when the file is created
  console.log(`[security] made the local token for the join CLI and the zoom-meeting channel: ${file}`)
  return token
}

/** For the join CLI and the channel: the token the voice service made, or an error that says what to do. */
export function readLocalToken(dataDir: string): string {
  const file = localTokenPath(dataDir)
  const token = readTokenFile(file)
  if (!token) throw new Error(`The local token ${file} is missing: start the voice service once to create it (${WORDS.start}).`)
  return token
}

function readTokenFile(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8').trim()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw new Error(`Could not read the local token ${file}: ${(err as Error).message}`)
  }
}
