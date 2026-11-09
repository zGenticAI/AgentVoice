// Who may reach which part of the service. Kept separate from server.ts so it is easy to test.
//
// Nothing here trusts forwarding headers (X-Forwarded-For, CF-Connecting-IP): only some proxies add them, so
// behind one that adds none every request would look local. Instead the service has separate listeners (see
// server.ts): the public one serves only what the meeting bot needs, and everything else is on a control
// listener on a Unix socket in the data folder (src/control-socket.ts), which only you can reach. No Host check
// is needed there: a web page pointing a name of its own at 127.0.0.1 (DNS rebinding) reaches TCP ports, and no
// browser can open a Unix socket. The Origin refusal and the local token stay, as a second line.
import { timingSafeEqual } from 'node:crypto'
import type http from 'node:http'

/** Compares two secrets in constant time, so how long a refusal takes says nothing about the secret. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** The request carries the local token (data/local-token) as "Authorization: Bearer <token>". */
export function hasLocalToken(req: http.IncomingMessage, token: string): boolean {
  const m = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')
  return Boolean(token && m) && sameSecret(m![1], token)
}
