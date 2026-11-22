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
// that last called an owner-only tool, if it is not a subagent's. Nothing else is ever posted, and nowhere else.
//
// The registration file holds a password that opens every OpenCode session of this user, so it is read with care: only
// a regular file (never a link), owned by this user, that no one else can read or write (mode 0600 or stricter), and
// only a URL on this machine (loopback). Nor is the password sent anywhere until the service it names is known to be the
// one this channel runs in (openCodeSink): the file outlives a service that crashed, and the port is the same for every
// user of the computer. The password, the URL's credentials and the event's text are never logged.
// A server started with `opencode serve` or --standalone is not the background service: the channel it starts can't
// push, and the meeting's questions reach the session only through the meeting-assistant.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { commandWords } from '../commands.ts'
import { INSTALL_MODE, type InstallMode, OWNER_DIR } from '../home.ts'
import { agentvoiceCommand } from '../setup/node-path.ts'
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
  version?: string
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
  const { url, password, id, pid, version } = info as Record<string, unknown>
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
      ...(typeof version === 'string' ? { version } : {}),
    },
  }
}

const sameService = (a: OpenCodeService, b: OpenCodeService) =>
  a.origin === b.origin && a.authorization === b.authorization && a.id === b.id && a.pid === b.pid && a.version === b.version

// --- Is it this channel's own service? ------------------------------------------------------------------------------
/** A process's parent, or null if it can't be read (the process is gone, or this system has no /proc). */
function procParent(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    // "pid (name) state ppid ...": the name may hold spaces and brackets, so it is skipped to its last ")".
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
    return Number.isInteger(ppid) && ppid >= 0 ? ppid : null
  } catch {
    return null
  }
}

/** Every process's parent, from ps (macOS has no /proc), or null if ps can't be run. */
function psParents(): Map<number, number> | null {
  try {
    const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] })
    const parents = new Map<number, number>()
    for (const line of out.split('\n')) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number)
      if (Number.isInteger(pid) && Number.isInteger(ppid)) parents.set(pid, ppid)
    }
    return parents
  } catch {
    return null
  }
}

/**
 * Whether pid is a live ancestor of this process: its parent, that one's parent, and so on. null when this system can't
 * say. OpenCode starts the channel as a child of its service (through tsx), so the service that started it is always
 * one; a service that has stopped, or another server, never is.
 */
export function isAncestor(pid: number, self: number = process.pid): boolean | null {
  if (!Number.isInteger(pid) || pid <= 0 || pid === self) return false
  let parentOf: (p: number) => number | null
  if (procParent(self) !== null) parentOf = procParent
  else {
    const parents = psParents()
    if (!parents?.has(self)) return null
    parentOf = p => parents.get(p) ?? null
  }
  let at = self
  for (let i = 0; i < 256; i++) {
    const parent = parentOf(at)
    if (parent === null || parent <= 0 || parent === at) return false
    if (parent === pid) return true
    at = parent
  }
  return false
}

// --- The service's API ----------------------------------------------------------------------------------------------
type Answer = { ok: true; body: unknown } | { ok: false; why: string }
// An answer the channel reads (the service's info, a session, the saved approvals) is small. Anything far larger is
// not read.
const MAX_ANSWER_BYTES = 1024 * 1024

/**
 * One request to the service, with its own auth. Says why it failed only by status or error code: never the URL, the
 * password or the text. body: what is posted, as JSON (none for a GET).
 */
function call(service: OpenCodeService, method: 'GET' | 'POST', pathname: string, timeoutMs: number, body?: unknown): Promise<Answer> {
  const url = new URL(pathname, service.origin)
  const payload = body === undefined ? undefined : JSON.stringify(body)
  return new Promise(resolve => {
    let settled = false
    const done = (answer: Answer) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(answer)
    }
    // agent: false: a fresh connection, never a proxy an environment setting would give the global agent. The password
    // goes to this machine only.
    const req = http.request(
      {
        host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
        port: url.port || 80,
        path: url.pathname + url.search,
        method,
        agent: false,
        headers: {
          ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
          ...(service.authorization ? { authorization: service.authorization } : {}),
        },
      },
      res => {
        const status = res.statusCode ?? 0
        if (status < 200 || status >= 300) {
          res.resume()
          return done({ ok: false, why: `HTTP ${status}` })
        }
        let size = 0
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_ANSWER_BYTES) {
            done({ ok: false, why: 'an answer too large to read' })
            req.destroy()
          } else chunks.push(chunk)
        })
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          try {
            done({ ok: true, body: text ? JSON.parse(text) : undefined })
          } catch {
            done({ ok: true, body: undefined })
          }
        })
        res.on('error', () => done({ ok: false, why: 'the answer was cut off' }))
      },
    )
    const timer = setTimeout(() => {
      done({ ok: false, why: `no answer within ${timeoutMs} ms` })
      req.destroy()
    }, timeoutMs)
    req.on('error', err => done({ ok: false, why: (err as NodeJS.ErrnoException).code ?? 'the connection failed' }))
    req.end(payload)
  })
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null

/** OpenCode's wildcard match for a permission rule (packages/core/src/util/wildcard.ts at 2.3.2), off Windows. */
function wildcard(input: string, pattern: string): boolean {
  let escaped = pattern
    .replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  if (escaped.endsWith(' .*')) escaped = escaped.slice(0, -3) + '( .*)?'
  return new RegExp('^' + escaped + '$', 's').test(input.replaceAll('\\', '/'))
}

export interface AlwaysAsk {
  action: string
  resource: string
  named: string
}

const MCP_ASKS: readonly AlwaysAsk[] = [
  { action: 'zoom-meeting_join_meeting', resource: '*', named: 'join_meeting' },
  { action: 'zoom-meeting_set_brief', resource: '*', named: 'set_brief' },
  { action: 'zoom-meeting_slides_control', resource: '*', named: 'slides_control' },
]
const CLONE_SLIDES = commandWords('clone', OWNER_DIR).run('slides')

/**
 * What the committed opencode.json makes ask every time (decision: they always ask), as OpenCode checks a call against
 * a rule: its action, and its resource ("*" for an MCP tool; the command for the shell).
 */
export const ALWAYS_ASK: readonly AlwaysAsk[] = [
  ...MCP_ASKS,
  { action: 'shell', resource: CLONE_SLIDES, named: CLONE_SLIDES },
  { action: 'shell', resource: commandWords('clone', OWNER_DIR).run('slides', 'start deck.pdf'), named: CLONE_SLIDES },
]

/**
 * The same, in this mode. Installed from npm, the slides command is agentvoice slides, which the opencode.json that
 * agentvoice setup writes makes ask however it is run: by name, or as the command that same file starts the channel
 * with (<node> <bin>, command()).
 */
export function alwaysAsk(mode: InstallMode, command: () => [string, string] = agentvoiceCommand): readonly AlwaysAsk[] {
  if (mode === 'clone') return ALWAYS_ASK
  const slides = commandWords('installed', OWNER_DIR).run('slides')
  const [node, bin] = command()
  return [
    ...MCP_ASKS,
    { action: 'shell', resource: slides, named: slides },
    { action: 'shell', resource: `${slides} prepare deck.pdf`, named: slides },
    { action: 'shell', resource: `${node} ${bin} slides prepare deck.pdf`, named: slides },
  ]
}

/**
 * Which of the always-asked (alwaysAsk, in this mode) a project's saved approvals ("Allow always") let run without
 * asking, by name, and those approvals' IDs (only plain ones, for the line that says how to remove them); null if the
 * list can't be read.
 */
export function savedLifts(rows: unknown, asks: readonly AlwaysAsk[] = alwaysAsk(INSTALL_MODE)): { named: string[]; ids: string[] } | null {
  if (!Array.isArray(rows)) return null
  const named = new Set<string>()
  const ids = new Set<string>()
  for (const ask of asks) {
    for (const row of rows) {
      const r = record(row)
      if (typeof r?.action !== 'string' || typeof r.resource !== 'string' || !wildcard(ask.action, r.action) || !wildcard(ask.resource, r.resource)) continue
      named.add(ask.named)
      if (typeof r.id === 'string' && /^[\w-]{1,100}$/.test(r.id)) ids.add(r.id)
    }
  }
  return { named: [...named], ids: [...ids] }
}

// --- The sink -------------------------------------------------------------------------------------------------------
export interface OpenCodeSinkOptions {
  /** The registration file: OpenCode's own (serviceFile()) unless a test gives another; null when there is none. */
  file?: string | null
  /** How long one request may take (ms). */
  timeoutMs?: number
  /** Where log lines go (stderr: stdout carries MCP). */
  log?: (line: string) => void
  /** Whether a process started this one (isAncestor unless a test gives another). */
  ancestor?: (pid: number) => boolean | null
}

export interface OpenCodePushSink extends PushSink {
  /**
   * A session called an owner-only tool. It becomes the owner's session, the one events are posted to, once the service
   * says it is a session of its own, not a subagent's. Resolves once that is settled; never throws.
   */
  ownerCalled(session: string): Promise<void>
}

/**
 * OpenCode's sink. It can push once it knows the owner's session and has found the service, and while nothing in the
 * project has lifted what always asks.
 *
 * - The service: the registration names it, but only one that is alive and started this channel is used (its process
 *   is an ancestor of this one, checked on this machine before anything is sent to it), and only once the service at
 *   the registered URL says it is that process (GET /api/info, as OpenCode's own client checks). A registration left
 *   by a service that has stopped, or one of a server this channel doesn't run in, is never sent the password.
 * - The owner's session: the one that last called an owner-only tool, if it has no parent. A subagent's session (the
 *   built-in General agent has every tool the session has) is never taken: events go on to the owner's own session.
 * - What always asks: the committed opencode.json makes join_meeting, set_brief, slides_control and npm run slides ask
 *   every time. OpenCode lets "Allow always" lift that for the whole project; while it is lifted, nothing is posted,
 *   so meeting text put into the session can't run one of them with nobody asked. The project's saved approvals are
 *   read at each owner-only call and before each post: "Allow always" for npm run slides is chosen at a shell call,
 *   which the channel never sees.
 *
 * A failed post reads the registration again, once, and checks and tries the service it names if that is another. If
 * none answers, the sink still says it can push while the service it ran in is alive, and looks for it again, checked
 * the same way, before the next post: a service that was busy for a moment is posted to again without waiting for an
 * owner-only call.
 */
export function openCodeSink(options: OpenCodeSinkOptions = {}): OpenCodePushSink {
  const file = options.file === undefined ? serviceFile() : options.file
  const timeoutMs = options.timeoutMs ?? POST_TIMEOUT_MS
  const log = options.log ?? ((line: string) => console.error(line))
  const ancestor = options.ancestor ?? isAncestor
  // The service found and checked, while it answers.
  let known: OpenCodeService | null = null
  // The service this channel was last found to run in: kept when a post and the check after it get no answer, so the
  // next post looks for it again. Gone once it has stopped.
  let ranIn: OpenCodeService | null = null
  let owner: string | null = null
  // The owner's session's project: OpenCode keeps saved approvals by project.
  let project: string | null = null
  // What always asks that the project's saved approvals let run without asking (empty while none do).
  let lifted: string[] = []
  // Owner-only calls in the order they came, and the latest whose check has been applied.
  let calls = 0
  let applied = 0
  // Why the sink can't push, logged once rather than at every check.
  let lastProblem = ''
  const say = (problem: string) => {
    if (problem !== lastProblem) log(`[zoom-meeting] ${problem}. Until it can be, meeting questions reach this session only through the meeting-assistant.`)
    lastProblem = problem
  }

  /** Reads the registration and checks that it names the service this channel runs in: the service, or null. */
  const find = async (): Promise<OpenCodeService | null> => {
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
    const service = found.service
    const named = `OpenCode's service registration ${file}`
    if (service.pid === undefined) {
      say(`${named} names no process: it is not used`)
      return null
    }
    const started = ancestor(service.pid)
    if (started === null) {
      say(`${named} can't be checked: this system doesn't say which process started this channel`)
      return null
    }
    if (!started) {
      say(`${named} names a service this channel doesn't run in (it has stopped, or this OpenCode runs a server of its own): it is not used`)
      return null
    }
    const info = await call(service, 'GET', '/api/info', timeoutMs)
    if (!info.ok) {
      say(`OpenCode's service did not say who it is (${info.why}): it is not used`)
      return null
    }
    const { pid, version } = record(info.body) ?? {}
    if (pid !== service.pid || (service.version !== undefined && version !== service.version)) {
      say(`The service at the address ${named} gives is not the one it registers: it is not used`)
      return null
    }
    lastProblem = ''
    known = service
    ranIn = service
    return service
  }

  /**
   * The service found before, while it still started this channel. One that has stopped leaves its registration behind,
   * and its address to whatever listens there next, while this channel, its orphan, may still be linked to the voice
   * service: it is never posted to again.
   */
  const stillOurs = (): OpenCodeService | null => {
    if (!ranIn) return null
    if (ranIn.pid !== undefined && ancestor(ranIn.pid) === true) return known
    known = null
    ranIn = null
    say("The OpenCode service this channel ran in has stopped: nothing is posted until the service it runs in is found again")
    return null
  }

  /** The approvals saved for the project lift something that always asks: nothing is posted until they are removed. */
  const liftedBy = (now: { named: string[]; ids: string[] }, where: string) => {
    lifted = now.named
    // OpenCode lists saved approvals only by project: the line gives the commands that remove these.
    const remove = now.ids.length
      ? now.ids.map(id => `opencode api permission.saved.remove --param id=${id}`).join('; ')
      : `opencode api permission.saved.list --param projectID=${where} lists them`
    say(
      `OpenCode has saved "Allow always" for ${lifted.join(', ')} in this project, which the committed opencode.json makes ask ` +
        "every time: so that meeting text can't make your session do that with nobody asked, nothing is posted into it until " +
        `you remove that approval (${remove}), then use join_meeting, set_brief, slides_status, slides_control or why_not_answered again`,
    )
  }
  const savedPath = (where: string) => `/api/permission/saved?projectID=${encodeURIComponent(where)}`

  /**
   * Whether the session has no parent (root) or is a subagent's, and its project (OpenCode keeps saved approvals by
   * project, and lists none without one); null when the service can't say.
   */
  const lookUp = async (service: OpenCodeService, session: string): Promise<{ root: boolean; project: string } | null> => {
    const got = await call(service, 'GET', `/api/session/${encodeURIComponent(session)}`, timeoutMs)
    if (!got.ok) {
      say(`OpenCode's service could not say whose session called an owner-only tool (${got.why}): it is not taken as yours`)
      return null
    }
    const info = record(record(got.body)?.data)
    if (!info || info.id !== session || typeof info.projectID !== 'string' || !/^[\w-]{1,100}$/.test(info.projectID)) {
      say("OpenCode's service did not say whose session called an owner-only tool: it is not taken as yours")
      return null
    }
    return { root: info.parentID === undefined || info.parentID === null, project: info.projectID }
  }

  return {
    canPush: () => {
      if (owner === null || lifted.length) return false
      // While the service it ran in is alive, a push can be tried: push() finds and checks it again if it has to.
      stillOurs()
      return ranIn !== null
    },

    async ownerCalled(session: string) {
      const turn = ++calls
      const service = stillOurs() ?? (await find())
      if (!service) return
      const found = await lookUp(service, session)
      if (!found) return
      if (!found.root) {
        if (turn > applied) {
          log(`[zoom-meeting] A subagent's session used an owner-only tool: it is not taken as yours.${owner ? ' Events still go to your own session.' : ''}`)
        }
        return
      }
      // What the project's saved approvals lift, checked at every owner-only call: "Allow always" is chosen at one.
      const saved = await call(service, 'GET', savedPath(found.project), timeoutMs)
      const now = saved.ok ? savedLifts(record(saved.body)?.data) : null
      // A later call has been settled already: it stands.
      if (turn < applied) return
      applied = turn
      owner = session
      project = found.project
      if (now === null) {
        // Not known for now. Nothing is lost by going on: each post reads them first, and nothing is posted while they
        // can't be read (deliver). One slow answer here must not stop every push of the meeting.
        lifted = []
        log(
          `[zoom-meeting] Could not check OpenCode's saved approvals (${saved.ok ? 'an answer it could not read' : saved.why}): ` +
            "they are checked again before each post, and nothing is posted while they can't be read.",
        )
        return
      }
      lifted = now.named
      if (lifted.length) liftedBy(now, found.project)
      else lastProblem = ''
    },

    async push(event: ChannelEvent) {
      const session = owner
      const where = project
      if (!session || !where || lifted.length) return false
      // Checked again before each post: the password goes only to the service this channel still runs in.
      const service = stillOurs() ?? (await find())
      if (!service) return false
      const steer = { text: plainEvent(event), delivery: 'steer' }
      const path = `/api/session/${encodeURIComponent(session)}/synthetic`
      // The project's saved approvals, read again before the post: one saved since the last owner-only call (at a shell
      // call, for npm run slides) stops it. null: one is saved, and nothing is posted.
      const deliver = async (to: OpenCodeService): Promise<Answer | null> => {
        const saved = await call(to, 'GET', savedPath(where), timeoutMs)
        if (!saved.ok) return saved
        const now = savedLifts(record(saved.body)?.data)
        if (now === null) return { ok: false, why: "its saved approvals could not be read" }
        if (now.named.length) {
          liftedBy(now, where)
          return null
        }
        return call(to, 'POST', path, timeoutMs, steer)
      }
      let outcome = await deliver(service)
      if (outcome && !outcome.ok) {
        const again = await find()
        if (again && !sameService(again, service)) outcome = await deliver(again)
      }
      if (!outcome) return false
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
