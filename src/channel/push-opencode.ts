// OpenCode's sink (src/channel/sink.ts): how the channel puts a meeting event into the owner's OpenCode session.
//
// OpenCode drops MCP notifications it has no handler for, Claude Code's channel notification among them. It does take
// "synthetic" input into a session over its own HTTP API: POST /api/session/{id}/synthetic, which wakes an idle session
// and is taken in at the next step boundary of a busy one. The channel runs as a child of OpenCode's background
// service, as the same user, and finds that service the way OpenCode's own client does
// (@opencode/client/service at 2.3.2: packages/client/src/service-probe.ts): the registration file
// $XDG_STATE_HOME/opencode/service.json (default ~/.local/state/opencode/service.json), which holds the service's
// URL and its password, sent as HTTP Basic auth with the user name "opencode".
//
// Each event is posted as one fixed plain-text message (plainEvent in sink.ts) to the owner's session alone: the one
// that last called an owner-only tool. Nothing else is ever posted, and nowhere else.
//
// The registration file holds a password that opens every OpenCode session of this user, so it is read with care: only
// a regular file (never a link), owned by this user, that no one else can read or write (mode 0600 or stricter), and
// only a URL on this machine (loopback). The password, the URL's credentials and the event's text are never logged.
// A service started with `opencode serve` or --standalone keeps its password elsewhere: there is no registration for
// it, so the channel can't push, and the meeting's questions reach the session only through the meeting-assistant.
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Client } from './client-text.ts'
import { type ChannelEvent, type PushSink, plainEvent } from './sink.ts'

/** How long one post may take (ms). A post to an idle session is answered in milliseconds. */
export const POST_TIMEOUT_MS = 3000
// The registration file is a few hundred bytes. Anything far larger is not OpenCode's.
const MAX_FILE_BYTES = 64 * 1024
// The hosts the service may be on: this machine only. URL keeps IPv6 hosts in brackets.
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost'])

/** The OpenCode service, as its registration file names it. */
export interface OpenCodeService {
  /** Where the service listens: http, on a loopback host, with no path, user name or password in it. */
  origin: string
  /** The Basic auth header, when the service has a password (in 2.3.2 it always has). */
  authorization?: string
  // Which instance it is: a restarted service has another id and pid, and usually another password.
  id?: string
  pid?: number
}

/**
 * Where OpenCode's background service registers itself. The service writes it under its state folder: XDG_STATE_HOME
 * when that is set, else ~/.local/state (packages/util/src/global-roots.ts). The channel's environment is the
 * service's, which keeps the XDG_STATE_HOME it was started with, so this is the same file. A relative path, in
 * XDG_STATE_HOME or for the home folder, names no file this channel would trust: then there is none.
 * Release builds use service.json; development builds of OpenCode use another name, and aren't supported.
 */
export function serviceFile(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string | null {
  const state = env.XDG_STATE_HOME || (home ? path.join(home, '.local', 'state') : '')
  return state && path.isAbsolute(state) ? path.join(state, 'opencode', 'service.json') : null
}

/** The service's URL, if it is plain http on this machine with nothing else in it, or why not. */
export function loopbackOrigin(url: unknown): { origin: string } | { problem: string } {
  if (typeof url !== 'string') return { problem: 'it names no URL' }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { problem: 'its URL is not one' }
  }
  if (parsed.protocol !== 'http:') return { problem: 'its URL is not plain http' }
  // Never in a log line: they could be credentials.
  if (parsed.username || parsed.password) return { problem: 'its URL carries a user name or password' }
  if (!LOOPBACK.has(parsed.hostname)) return { problem: 'its URL is not on this machine (only 127.0.0.1, ::1 and localhost are taken)' }
  return { origin: `${parsed.protocol}//${parsed.host}` }
}

/**
 * Reads the registration file, or says why it can't be used. uid: who must own it (this process's user; given only by
 * tests). The file is opened without following a link, and checked on what was opened, so it can't be swapped between
 * the check and the read.
 */
export function readService(file: string, uid: number | undefined = process.getuid?.()): { service: OpenCodeService } | { problem: string } {
  const named = `OpenCode's service registration ${file}`
  if (uid === undefined) return { problem: `${named} can't be checked on this system` }
  let fd: number
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { problem: `${named} was not found: is OpenCode's background service running?` }
    if (code === 'ELOOP') return { problem: `${named} is a link, not a file: it is not used` }
    return { problem: `${named} can't be read (${code ?? 'unknown error'})` }
  }
  let text: string
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) return { problem: `${named} is not a regular file: it is not used` }
    if (stat.uid !== uid) return { problem: `${named} belongs to another user: it is not used` }
    if ((stat.mode & 0o177) !== 0) {
      return { problem: `${named} is not private to you (mode ${(stat.mode & 0o777).toString(8)}; it should be 600 or stricter): it is not used` }
    }
    if (stat.size > MAX_FILE_BYTES) return { problem: `${named} is too large to be OpenCode's: it is not used` }
    text = fs.readFileSync(fd, 'utf8')
  } catch (err) {
    return { problem: `${named} can't be read (${(err as NodeJS.ErrnoException).code ?? 'unknown error'})` }
  } finally {
    fs.closeSync(fd)
  }
  let info: unknown
  try {
    info = JSON.parse(text)
  } catch {
    return { problem: `${named} is not JSON: it is not used` }
  }
  if (typeof info !== 'object' || info === null || Array.isArray(info)) return { problem: `${named} is not a registration: it is not used` }
  const { url, password, id, pid } = info as Record<string, unknown>
  const where = loopbackOrigin(url)
  if ('problem' in where) return { problem: `${named} is not used: ${where.problem}` }
  if (password !== undefined && typeof password !== 'string') return { problem: `${named} is not used: its password is not text` }
  return {
    service: {
      origin: where.origin,
      // As OpenCode's own client sends it (service-probe.ts, headers()).
      ...(password !== undefined ? { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` } : {}),
      ...(typeof id === 'string' ? { id } : {}),
      ...(typeof pid === 'number' ? { pid } : {}),
    },
  }
}

const sameService = (a: OpenCodeService, b: OpenCodeService) =>
  a.origin === b.origin && a.authorization === b.authorization && a.id === b.id && a.pid === b.pid

type Outcome = { ok: true } | { ok: false; why: string }

/**
 * Posts one message into a session, as synthetic input that steers it (taken in at its next step, and waking it if
 * idle). Says why it failed only by status or error code: never the URL, the password or the text.
 */
function post(service: OpenCodeService, session: string, text: string, timeoutMs: number): Promise<Outcome> {
  const url = new URL(`/api/session/${encodeURIComponent(session)}/synthetic`, service.origin)
  const body = JSON.stringify({ text, delivery: 'steer' })
  return new Promise(resolve => {
    let settled = false
    const done = (outcome: Outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }
    // agent: false: a fresh connection, never a proxy an environment setting would give the global agent. The password
    // goes to this machine only.
    const req = http.request(
      {
        host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
        port: url.port || 80,
        path: url.pathname,
        method: 'POST',
        agent: false,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          ...(service.authorization ? { authorization: service.authorization } : {}),
        },
      },
      res => {
        res.resume() // nothing in the answer is needed: only whether it was taken
        const status = res.statusCode ?? 0
        done(status >= 200 && status < 300 ? { ok: true } : { ok: false, why: `HTTP ${status}` })
      },
    )
    const timer = setTimeout(() => {
      done({ ok: false, why: `no answer within ${timeoutMs} ms` })
      req.destroy()
    }, timeoutMs)
    req.on('error', err => done({ ok: false, why: (err as NodeJS.ErrnoException).code ?? 'the connection failed' }))
    req.end(body)
  })
}

export interface OpenCodeSinkOptions {
  /** The owner's session ID, as the channel last learnt it from an owner-only tool call (null until then). */
  owner: () => string | null
  /** The registration file: OpenCode's own (serviceFile()) unless a test gives another; null when there is none. */
  file?: string | null
  /** How long one post may take (ms). */
  timeoutMs?: number
  /** Where log lines go (stderr: stdout carries MCP). */
  log?: (line: string) => void
}

/**
 * OpenCode's sink. It can push once it knows the owner's session and has found the service. A failed post reads the
 * registration again, once, and tries the service it names if that is another (the service may have restarted).
 */
export function openCodeSink(options: OpenCodeSinkOptions): PushSink {
  const file = options.file === undefined ? serviceFile() : options.file
  const timeoutMs = options.timeoutMs ?? POST_TIMEOUT_MS
  const log = options.log ?? ((line: string) => console.error(line))
  let known: OpenCodeService | null = null
  // Why the service can't be used, logged once rather than at every check.
  let lastProblem = ''
  const say = (problem: string) => {
    if (problem !== lastProblem) log(`[zoom-meeting] ${problem}. Until it can be, meeting questions reach this session only through the meeting-assistant.`)
    lastProblem = problem
  }
  const find = (): OpenCodeService | null => {
    known = null
    if (!file) {
      say("OpenCode's service registration can't be found: there is no home folder or XDG_STATE_HOME")
      return null
    }
    const found = readService(file)
    if ('problem' in found) {
      say(found.problem)
      return null
    }
    lastProblem = ''
    known = found.service
    return known
  }
  return {
    canPush: () => options.owner() !== null && (known ?? find()) !== null,
    async push(event: ChannelEvent) {
      const session = options.owner()
      if (!session) return false
      const service = known ?? find()
      if (!service) return false
      const text = plainEvent(event)
      let outcome = await post(service, session, text, timeoutMs)
      if (!outcome.ok) {
        const again = find()
        if (again && !sameService(again, service)) outcome = await post(again, session, text, timeoutMs)
      }
      // What failed, never what the event said, the password or the URL.
      if (!outcome.ok) log(`[zoom-meeting] Could not post a ${event.kind} event to the OpenCode session: ${outcome.why}.`)
      return outcome.ok
    },
  }
}

// --- What the client says it is ------------------------------------------------------------------------------------
/** The OpenCode version AgentVoice was tested with, and the earliest it supports. */
export const OPENCODE_TESTED = '2.3.2'

/** A name or version the client sent, safe for a log line. */
const shown = (value: unknown) => (typeof value === 'string' ? value.replace(/[^\w.+-]/g, '?').slice(0, 40) : '')

/**
 * Warnings from what the client says it is in the MCP handshake (clientInfo), checked against AGENTVOICE_CLIENT. Only
 * ever warnings: the channel goes by AGENTVOICE_CLIENT whatever the client says. OpenCode says "opencode" and its
 * version; Claude Code and Codex are not checked.
 */
export function clientInfoWarnings(client: Client, info: { name?: unknown; version?: unknown } | undefined): string[] {
  const name = shown(info?.name)
  const says = name ? `calls itself "${name}"` : 'gives no name'
  if (client !== 'opencode') {
    return name === 'opencode'
      ? [`[client] The client that started this channel calls itself OpenCode, but AGENTVOICE_CLIENT is ${client}: OpenCode's opencode.json in this folder sets it to opencode. Going on as ${client}.`]
      : []
  }
  if (name !== 'opencode') {
    return [`[client] AGENTVOICE_CLIENT is opencode, but the client that started this channel ${says}: only OpenCode's opencode.json should set it. Going on as OpenCode.`]
  }
  const version = shown(info?.version)
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!parts) return [`[client] OpenCode gave no version this channel can read ("${version}"): AgentVoice was tested with OpenCode ${OPENCODE_TESTED}.`]
  const [major, minor, patch] = parts.slice(1).map(Number)
  if (major === 1) {
    return [
      `[client] OpenCode ${version} is V1, which AgentVoice does not support: its tool calls time out after 60 seconds, so the meeting-assistant's ` +
        `next_question fails. Install OpenCode ${OPENCODE_TESTED} or later (npm package @opencode/cli).`,
    ]
  }
  if (major !== 2) return [`[client] OpenCode ${version} is a major version AgentVoice was not tested with (tested: ${OPENCODE_TESTED}): if something fails, tell us.`]
  const [tMajor, tMinor, tPatch] = OPENCODE_TESTED.split('.').map(Number)
  if (major === tMajor && (minor < tMinor || (minor === tMinor && patch < tPatch))) {
    return [`[client] OpenCode ${version} is older than ${OPENCODE_TESTED}, the earliest AgentVoice supports: update it (npm package @opencode/cli).`]
  }
  return []
}
