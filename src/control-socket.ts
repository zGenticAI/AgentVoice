// The control listener's Unix socket: /api/join (npm run join), /bridge (the Claude Code channel) and the
// detailed /health. A TCP port on 127.0.0.1 can be bound by any user of this computer while the service is
// down, and the join CLI and the channel would then send the local token to whoever holds it. A socket in a
// folder only you can open can't be reached, or taken over, by anyone else: on macOS it is the folder that keeps
// other users out (connecting ignores the socket's own mode there), so the socket must stay in such a folder.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { config } from './config.ts'

// The longest path a Unix socket can have, in bytes with the terminating NUL (sun_path): 108 on Linux, 104 on
// macOS and the BSDs. A longer one fails to bind, or is cut short.
const SUN_PATH_BYTES = process.platform === 'linux' ? 108 : 104

const NOT_RUNNING_CODES = new Set(['ENOENT', 'ECONNREFUSED'])

/** The error from connecting to the control socket means nothing is listening there (no service, or a stale socket). */
export function nothingListening(err: unknown): boolean {
  return NOT_RUNNING_CODES.has((err as NodeJS.ErrnoException)?.code ?? '')
}

/**
 * Why this path can't be the control socket, or '' if it can: it is too long for this system, or its folder is
 * not one only you can open. The service checks it before it listens, and the join CLI and the channel before
 * they send the local token there.
 */
export function controlSocketProblem(socketPath: string): string {
  const bytes = Buffer.byteLength(socketPath)
  if (bytes >= SUN_PATH_BYTES) {
    return (
      `The control socket ${socketPath} is ${bytes} bytes long, longer than this system allows (${SUN_PATH_BYTES - 1}). ` +
      'Set CONTROL_SOCKET in .env to a shorter path, in a folder only you can open (for example ~/.agent-voice/control.sock, after mkdir -m 700 ~/.agent-voice).'
    )
  }
  const dir = path.dirname(socketPath)
  let stat: fs.Stats
  try {
    stat = fs.statSync(dir)
  } catch {
    return `The folder of the control socket, ${dir}, does not exist. Start the voice service once to make the data folder, or set CONTROL_SOCKET in .env.`
  }
  const uid = process.getuid?.()
  const yours = uid === undefined || stat.uid === uid
  if (!yours || (stat.mode & 0o077) !== 0) {
    return (
      `The control socket must be in a folder only you can open, and ${dir} is not ` +
      `(${yours ? `mode ${(stat.mode & 0o777).toString(8)}` : "it is another user's"}). ` +
      `Run chmod 700 ${dir}, or set CONTROL_SOCKET in .env to a path in such a folder.`
    )
  }
  return ''
}

/** Whether something answers on the socket. */
function answers(socketPath: string): Promise<boolean> {
  return new Promise(resolve => {
    const probe = net.connect(socketPath)
    probe.once('connect', () => {
      probe.destroy()
      resolve(true)
    })
    probe.once('error', () => resolve(false))
  })
}

/**
 * Makes the path ready for the service to listen on, or throws why it can't: the path is unusable (see
 * controlSocketProblem), something other than a socket is there (left as it is), or another voice service is
 * listening on it. A stale socket, left by a service that did not stop cleanly, is removed.
 */
export async function prepareControlSocket(socketPath: string): Promise<void> {
  const problem = controlSocketProblem(socketPath)
  if (problem) throw new Error(problem)
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(socketPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  if (!stat.isSocket()) {
    throw new Error(`${socketPath} exists and is not a socket, so the voice service leaves it alone. Move it away, or set CONTROL_SOCKET in .env to another path.`)
  }
  if (await answers(socketPath)) {
    throw new Error(`Another voice service is already running on ${socketPath}. Stop it first (${howToStop()}).`)
  }
  fs.unlinkSync(socketPath)
}

/**
 * How to stop the voice service that scripts/install-service.sh installed under this label (SERVICE_LABEL), on this
 * computer's service manager, or the one started by hand.
 */
export function howToStop(label = config.serviceLabel, platform = process.platform): string {
  const manager =
    platform === 'darwin'
      ? `launchctl unload ~/Library/LaunchAgents/${label}.plist`
      : platform === 'linux'
        ? `systemctl --user stop ${label}`
        : ''
  return `${manager ? `${manager}, or ` : ''}Ctrl-C in the Terminal running npm start`
}
