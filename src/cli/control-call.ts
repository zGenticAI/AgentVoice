// A request to the running voice service on its control socket, for the commands that talk to it (npm run join, npm run
// slides -- status and control): the socket is in the data folder, which only you can open, and the request carries the
// local token the service made.
import http from 'node:http'
import { config } from '../config.ts'
import { controlSocketProblem, nothingListening } from '../control-socket.ts'
import { readLocalToken } from '../local-token.ts'

export interface ControlReply {
  status: number
  body: string
}

/**
 * The local token, once the control socket is known to be safe to send it to: or why not, in words for the owner. The
 * token goes only to a socket in a folder only you can open, so no other user can be listening there.
 */
export function controlToken(socketPath = config.controlSocket, dataDir = config.dataDir): { token: string } | { problem: string } {
  let token: string
  try {
    token = readLocalToken(dataDir)
  } catch (err) {
    return { problem: (err as Error).message }
  }
  const problem = controlSocketProblem(socketPath)
  if (problem) return { problem }
  return { token }
}

/**
 * A request to the voice service on the control socket: its answer, or the error that kept it from coming. With
 * timeoutMs, one with no answer by then is given up on.
 */
export function controlCall(
  token: string,
  method: 'GET' | 'POST',
  urlPath: string,
  body = '',
  timeoutMs?: number,
  socketPath = config.controlSocket,
): Promise<ControlReply | Error> {
  return new Promise(resolve => {
    const req = http.request(
      {
        socketPath,
        path: urlPath,
        method,
        headers: {
          host: 'localhost',
          ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
          authorization: `Bearer ${token}`,
        },
      },
      response => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', chunk => (text += chunk))
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text }))
        response.on('error', resolve)
      },
    )
    req.on('error', resolve)
    if (timeoutMs !== undefined) req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`)))
    req.end(body)
  })
}

/** Why the voice service could not be reached, in words for the owner. */
export function unreachableText(err: Error, socketPath = config.controlSocket): string {
  return nothingListening(err)
    ? `The voice service is not running (nothing is listening on ${socketPath}). Start it with npm start, or scripts/install-service.sh.`
    : `Could not reach the voice service on ${socketPath}: ${err.message}`
}
