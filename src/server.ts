// The voice service. Serves the agent page, carries its audio over /audio, accepts the Claude Code
// channel on /bridge, and starts meeting bots through Recall.
//
// Who may do what never depends on forwarding headers, which only some proxies add. Instead there are
// separate listeners:
// - public (PORT on HOST, 127.0.0.1 unless set): the tunnel points here. Only what the meeting bot needs: the
//   agent page and its scripts, /audio for a meeting this process started, and a /health that says only ok.
// - control (a Unix socket in the data folder, CONTROL_SOCKET to put it elsewhere): /api/join for npm run join,
//   /bridge for the Claude Code channel, and the detailed /health. No pages. Only you can open it, and no other
//   user can take its place while the service is down, as one could with a port (src/control-socket.ts).
//
// The service owns getting every bot it sent into a meeting out of the call again: it keeps asking Recall until
// the bot is out, keeps the bots it has not seen out in the data folder in case it crashes, and stops in order
// on SIGTERM and on a crash alike.
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo, ListenOptions } from 'node:net'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { type WebSocket, WebSocketServer } from 'ws'
import { Brain } from './brain/brain.ts'
import { SessionBridge } from './bridge.ts'
import { ROOT, config, publicUrlProblem, recallRegionProblem, retiredSettings } from './config.ts'
import { FIXED_LINES } from './consent.ts'
import { prepareControlSocket } from './control-socket.ts'
import { identity } from './identity.ts'
import { ensureLocalToken, prepareDataDir } from './local-token.ts'
import { checkNameAtStartup } from './name-check.ts'
import { hasLocalToken, sameSecret } from './network.ts'
import { loadAgentPage } from './pages.ts'
import { LineCache } from './pipeline/line-cache.ts'
import { MeetingSession, PAGE_ERRORS, type SessionOptions, endSessions } from './pipeline/session.ts'
import { PROFILE } from './profile.ts'
import * as recall from './recall.ts'
import { type LiveSession, sessionHandlers } from './sessions.ts'
import { sweepOldRecords } from './transcript.ts'

const PUBLIC_DIR = path.join(ROOT, 'public')
// What the meeting bot loads through the tunnel, besides the agent page: its scripts.
const BOT_SCRIPTS = ['agent.js', 'pcm-worklet.js']

// How long a meeting waits for its bot's page before the bot is asked to leave. Recall gives up on a waiting room
// after 10 minutes, so a page that has not connected by then never will.
const PAGE_WAIT_MS = 15 * 60_000
// After a meeting's page disconnects, a page reconnecting for it is still let in for this long; then its bot is
// made sure to be out of the call.
const RECONNECT_MS = 60_000
// The most /api/join reads of a request: it only carries a meeting link.
const MAX_BODY_BYTES = 16_384

function readBrief(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

class JoinError extends Error {}

/** A request /api/join can't read, with the status that says why. */
class BodyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** What the owner needs to know so the bot actually gets in. */
function joinTip(): string {
  return `${identity.name} joins as a guest: if the meeting has a waiting room or lobby, someone in the meeting has to admit it.`
}

function send(res: http.ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

/**
 * What the public port serves, by path: the bot page as the service was given it (filled in and checked, see
 * src/pages.ts), and its scripts from public/, read once here. So what a running service serves never changes under
 * it: a pull, or an edit to a page of your own, takes effect at the next restart, and a request never reads a file.
 */
function botFiles(agentPage: string): Map<string, { body: string; type: string }> {
  const files = new Map([['/agent', { body: agentPage, type: 'text/html; charset=utf-8' }]])
  for (const file of BOT_SCRIPTS) files.set(`/${file}`, { body: fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8'), type: 'text/javascript' })
  return files
}

function isJson(req: http.IncomingMessage): boolean {
  return (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() === 'application/json'
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > MAX_BODY_BYTES) throw new BodyError(413, 'The request is too large.')
    chunks.push(c as Buffer)
  }
  let body: unknown
  try {
    body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
  } catch {
    throw new BodyError(400, 'The request is not valid JSON.')
  }
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
}

/**
 * Node takes the HTTP server's own error listener off a socket before it emits 'upgrade'. Until the socket is
 * handed to ws (which adds its own), an error on it, such as a client resetting the connection, would be an
 * 'error' event nothing listens to, and would take the process down. Returns what takes the listener off again,
 * just before handleUpgrade (as ws's README does for noServer).
 */
function destroyOnError(socket: Duplex): () => void {
  const onError = () => socket.destroy()
  socket.on('error', onError)
  return () => socket.off('error', onError)
}

/** Answers a websocket upgrade with a plain HTTP refusal, so the client can say why it was refused. */
function refuse(socket: Duplex, status: number, reason: string): void {
  // The write fails if the client has reset the connection: see destroyOnError.
  socket.on('error', () => socket.destroy())
  socket.once('finish', () => socket.destroy())
  socket.end(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Type: text/plain\r\n` +
      `Content-Length: ${Buffer.byteLength(reason)}\r\n\r\n${reason}`,
  )
}

/**
 * Wraps a request handler so a failure answers 500 instead of leaving the request hanging. The control listener
 * (your user only) says what failed; the public one says only that something did, since anyone can reach it.
 */
function guarded(
  handle: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> | void,
  tell = true,
): http.RequestListener {
  return (req, res) => {
    Promise.resolve()
      .then(() => handle(req, res))
      .catch(err => {
        console.error('[http]', err)
        if (!res.headersSent) send(res, 500, tell ? (err as Error).message : 'internal error')
      })
  }
}

type UpgradeListener = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void

/** An error's name and message, short. Never the request's URL, which can carry a meeting's key and the page token. */
function errorName(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : 'an error that is not an Error'
}

/**
 * Wraps an upgrade listener so nothing it throws takes the process down (Node does not catch what an
 * 'upgrade' listener throws). The connection is closed, and only what failed is logged.
 */
function guardedUpgrade(listener: string, handle: UpgradeListener): UpgradeListener {
  return (req, socket, head) => {
    try {
      handle(req, socket, head)
    } catch (err) {
      console.error(`[${listener}] an upgrade request failed, so its connection was closed (${errorName(err)})`)
      socket.destroy()
    }
  }
}

/** The request's URL, or null if its target can't be read as one (URL.parse never throws). */
function requestUrl(req: http.IncomingMessage): URL | null {
  return URL.parse(req.url ?? '/', 'http://localhost')
}

/** Resolves when work settles, or after ms, whichever is first. */
function within(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, Math.max(0, ms))
    void work.finally(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

export interface ServiceConfig {
  /** The public listener (the tunnel points here) and the address it binds to. */
  port: number
  host: string
  /** The control listener's Unix socket (see src/control-socket.ts). */
  controlSocket: string
  publicUrl: string
  agentPageToken: string
  /**
   * The bot page served at /agent, filled in and checked (loadAgentPage in src/pages.ts: AGENT_PAGE_FILE's page, or
   * public/agent.html). Without one, public/agent.html with this process's names, read when the service is made.
   */
  agentPage?: string
  /** The secret the join CLI and the channel send on /api/join and /bridge (data/local-token). */
  localToken: string
  dataDir: string
  maxMeetings: number
  maxMeetingMinutes: number
  /** How long a meeting waits for its bot's page before its bot is asked to leave (ms). Tests make it short. */
  pageWaitMs?: number
  /** How long a meeting's key stays valid after its page disconnects, for a page that reconnects (ms). */
  reconnectMs?: number
  /** The waits between tries to get a bot out of its call (ms); the last one repeats until it is out. */
  leaveBackoffMs?: readonly number[]
  /** How long stop() waits for Recall: for the bots it is still creating, then for its answers to leave_call (ms). */
  stopWaitMs?: number
}

/** What the server uses of a MeetingSession. */
export interface ServiceSession extends LiveSession {
  end(): void
  reachedTimeLimit(minutes: number): Promise<void>
  /** Someone asked the assistant to leave the meeting, or removed it: no page is let in for it again. */
  readonly leftMeeting?: boolean
}

export interface ServiceDeps<S extends ServiceSession> {
  /** Creates a Recall bot (recall.createBot, unless a test passes a fake). */
  createBot(plan: recall.BotPlan): Promise<{ id: string }>
  /** Asks a bot to leave its call (recall.leaveCall). A RecallError says Recall's answer; any other error, no answer. */
  leaveCall(botId: string): Promise<void>
  /** Starts the conversation for a page that connected to /audio (a MeetingSession, unless a test passes a fake). */
  startSession(ws: WebSocket, opts: SessionOptions, ctx: { bridge: SessionBridge; brief: () => string }): S
}

export interface Service<S extends ServiceSession> {
  readonly publicServer: http.Server
  readonly controlServer: http.Server
  readonly bridge: SessionBridge
  readonly sessions: ReadonlySet<S>
  /** Listens on both listeners, then asks the bots a run that crashed left in their calls to leave (PENDING_BOTS_FILE). */
  listen(): Promise<void>
  /**
   * For a shutdown: takes no more joins or pages, and asks every bot not yet out of its call to leave, once each,
   * those Recall is still creating included. A bot Recall can't be reached for stays in PENDING_BOTS_FILE, so the
   * next start asks it again. Ending the meeting sessions is endSessions's work.
   */
  stop(): Promise<void>
  /** Closes the listeners and drops the timers, asking no bot anything (as a crash would, as far as the bots go). */
  close(): Promise<void>
}

/**
 * The bots this service sent into meetings and has not yet seen out of their calls: each one's id, its meeting's
 * key, and when the service would ask it to leave unless something ended the meeting first. Kept in the data
 * folder (0600), so a service that crashed or was killed asks them to leave when it starts again. Nothing of the
 * meetings themselves.
 */
export const PENDING_BOTS_FILE = 'pending-bots.json'

// The waits between tries to get a bot out of its call, while Recall can't be reached or has trouble of its own:
// about two minutes in all, then every five minutes until it is out.
const LEAVE_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000, 300_000]
// How long a shutdown waits for Recall: launchd sends SIGKILL 20 s after SIGTERM, and
// scripts/agent-voice.service gives systemd the same 20 s.
const STOP_WAIT_MS = 10_000
const STOPPING = 'The voice service is stopping: try again once it has started again.'

/** A meeting this process sent a bot into, from the join until its bot is out of the call. */
interface Meeting<S> {
  key: string
  botId: string
  /** None for a bot a run that crashed left behind: no page is let in for it. */
  platform?: recall.Platform
  /**
   * waiting: its bot's page has not connected yet. live: the page is connected. away: it went, and may come back
   * within the reconnect window. leaving: the bot is being asked to leave its call, and no page is let in.
   */
  state: 'waiting' | 'live' | 'away' | 'leaving'
  /** The session of its connected page. */
  session?: S
  /** When its page first connected (epoch ms): the time limit counts from then, across reconnects. */
  startedAt?: number
  /** It reached MAX_MEETING_MINUTES: its bot leaves, and no page is let in for it again. */
  timeUp?: boolean
  /** When the service asks its bot to leave unless the meeting ends first (epoch ms): the page wait, then the time limit. */
  deadline: number
  /** The page wait, the reconnect window, or the next try to get the bot out. */
  timer?: NodeJS.Timeout
  /** MAX_MEETING_MINUTES, from when its page first connected, whether or not a page is connected when it runs out. */
  limit?: NodeJS.Timeout
}

export function createServers<S extends ServiceSession>(cfg: ServiceConfig, deps: ServiceDeps<S>): Service<S> {
  const served = botFiles(cfg.agentPage ?? loadAgentPage('', identity).page)
  const briefFile = path.join(cfg.dataDir, 'brief.md')
  const brief = () => readBrief(briefFile)
  const pendingFile = path.join(cfg.dataDir, PENDING_BOTS_FILE)
  const backoff = cfg.leaveBackoffMs?.length ? cfg.leaveBackoffMs : LEAVE_BACKOFF_MS
  // Meetings started through /api/join or join_meeting, keyed by the random key in the bot page URL, until their
  // bot is out of the call. Only these keys open a bot session: the page token travels to Recall, the tunnel and the
  // bot's browser, so it alone is not enough.
  const meetings = new Map<string, Meeting<S>>()
  const sessions = new Set<S>()
  // Bots Recall is still creating: they hold their place under MAX_MEETINGS already, and stop() waits for them.
  const creating = new Set<Promise<unknown>>()
  let stopping = false
  let stopped: Promise<void> | null = null
  let closed = false

  /**
   * Meetings that hold a place under MAX_MEETINGS: every one until its bot is out of the call. Waiting for its
   * bot's page, with it connected, while a page may come back for it, and while its bot is being asked to leave.
   */
  const liveMeetings = () => meetings.size

  /** Keeps PENDING_BOTS_FILE in step with the meetings, and removes it once there are none. */
  function save(): void {
    if (closed) return
    try {
      if (!meetings.size) return fs.rmSync(pendingFile, { force: true })
      const bots = [...meetings.values()].map(({ key, botId, deadline }) => ({ key, botId, deadline }))
      const tmp = `${pendingFile}.tmp`
      fs.writeFileSync(tmp, `${JSON.stringify(bots, null, 2)}\n`, { mode: 0o600 })
      fs.chmodSync(tmp, 0o600) // mode applies only when the file is created
      fs.renameSync(tmp, pendingFile)
    } catch (err) {
      console.error(`[leave] could not update ${pendingFile}: ${errorName(err)}`)
    }
  }

  function clearTimers(meeting: Meeting<S>): void {
    clearTimeout(meeting.timer)
    clearTimeout(meeting.limit)
  }

  /** The bot is out of its call, or Recall says it can't be asked to leave: its place is free. */
  function gone(meeting: Meeting<S>): void {
    if (closed || meetings.get(meeting.key) !== meeting) return
    clearTimers(meeting)
    meetings.delete(meeting.key)
    save()
  }

  /** Asks Recall once: true once the bot is out of its call (or can't be asked), false if it is worth asking again. */
  async function askToLeave(meeting: Meeting<S>): Promise<boolean> {
    try {
      await deps.leaveCall(meeting.botId)
      console.log(`[leave] bot ${meeting.botId} is leaving its call`)
    } catch (err) {
      if (recall.worthRetrying(err)) return false
      const status = (err as recall.RecallError).status
      if ([400, 404, 409, 410].includes(status)) console.log(`[leave] bot ${meeting.botId} is no longer in its call (Recall answered ${status})`)
      else console.warn(`[leave] Recall refused to ask bot ${meeting.botId} to leave (${errorName(err)}): if it is still in its call, remove it by hand`)
    }
    gone(meeting)
    return true
  }

  /**
   * Gets the bot out of its call: asks Recall now, then again after each wait in the backoff while Recall can't
   * be reached or has trouble of its own, until it is out. Its meeting keeps its place under MAX_MEETINGS until
   * then, and no page is let in for it.
   */
  function leave(meeting: Meeting<S>, why: string): void {
    if (meeting.state === 'leaving') return
    meeting.state = 'leaving'
    clearTimers(meeting)
    console.log(`[leave] bot ${meeting.botId}: ${why}, so it is asked to leave its call`)
    const attempt = async (n: number): Promise<void> => {
      if (await askToLeave(meeting)) return
      // Stopping: stop() asks once more, and PENDING_BOTS_FILE keeps the bot for the next start.
      if (stopping || closed || meetings.get(meeting.key) !== meeting) return
      const wait = backoff[Math.min(n, backoff.length - 1)]
      if (n === 0 || n === backoff.length - 1) {
        console.warn(
          `[leave] could not get bot ${meeting.botId} out of its call (Recall can't be reached, or has trouble): ` +
            `asking again in ${Math.round(wait / 1000)} s${n ? ', and so on until it is out. Remove it from the meeting by hand if you can.' : ''}`,
        )
      }
      meeting.timer = setTimeout(() => void attempt(n + 1), wait)
      meeting.timer.unref()
    }
    void attempt(0)
  }

  /** MAX_MEETING_MINUTES is up: the assistant says so in the chat and leaves. With no page connected, the bot just leaves. */
  function timeUp(meeting: Meeting<S>): void {
    meeting.timeUp = true
    if (meeting.state === 'live' && meeting.session) {
      // Its page closes once the session has ended, and then the bot is asked to leave (pageGone).
      meeting.session.reachedTimeLimit(cfg.maxMeetingMinutes).catch(err => console.error('[leave]', errorName(err)))
    } else if (meeting.state === 'away') {
      leave(meeting, `it reached the ${cfg.maxMeetingMinutes}-minute limit for one meeting while its page was away`)
    }
  }

  /** The meeting's page disconnected. */
  function pageGone(meeting: Meeting<S>, session: S): void {
    if (meeting.session !== session || meeting.state !== 'live') return
    meeting.session = undefined
    meeting.state = 'away'
    if (stopping) return // stop() asks its bot to leave
    if (meeting.timeUp) return leave(meeting, 'it reached the time limit for one meeting')
    // "Alex, please leave", or a removal: nothing more of the meeting, so no page for it either.
    if (session.leftMeeting) return leave(meeting, 'it was asked to leave the meeting, or removed from it')
    // The session asked the bot to leave as it ended, once; a page may still come back for the meeting while the bot
    // is in the call. If none has by the end of the window, the service makes sure the bot is out.
    meeting.timer = setTimeout(() => leave(meeting, 'its page went and did not come back'), cfg.reconnectMs ?? RECONNECT_MS)
    meeting.timer.unref()
  }

  /** Creates a Recall bot that joins the meeting with the agent page as its camera and microphone. */
  async function startBot(meetingUrl: unknown): Promise<{ bot_id: string; platform: recall.Platform; key: string }> {
    const platform = typeof meetingUrl === 'string' ? recall.meetingPlatform(meetingUrl) : null
    if (typeof meetingUrl !== 'string' || !platform) {
      throw new JoinError('Pass a Zoom, Google Meet or Microsoft Teams meeting link.')
    }
    if (!cfg.agentPageToken) throw new JoinError('Set AGENT_PAGE_TOKEN in .env first.')
    // A page the bot can't load would leave it in the meeting, silent, until the page wait runs out or it is asked to leave.
    const unreachable = publicUrlProblem(cfg.publicUrl)
    if (unreachable) throw new JoinError(unreachable)
    if (stopping) throw new JoinError(STOPPING)
    const busy = liveMeetings() + creating.size
    if (busy >= cfg.maxMeetings) {
      const ending = [...meetings.values()].filter(m => m.state === 'away' || m.state === 'leaving').length
      const leaving = ending === 1 ? '1 of them ending: its bot is leaving the call' : `${ending} of them ending: their bots are leaving their calls`
      throw new JoinError(
        `Already in ${busy} meeting${busy === 1 ? '' : 's'}, the most MAX_MEETINGS allows${ending ? ` (${leaving})` : ''}. ` +
          'Try again once one has ended, or raise MAX_MEETINGS in .env.',
      )
    }
    const key = randomUUID()
    const pageUrl = `${cfg.publicUrl}/agent?key=${key}&token=${cfg.agentPageToken}`
    const creation = deps.createBot({ meetingUrl, pageUrl })
    creating.add(creation)
    let bot: { id: string }
    try {
      bot = await creation
    } finally {
      creating.delete(creation)
    }
    const pageWait = cfg.pageWaitMs ?? PAGE_WAIT_MS
    const meeting: Meeting<S> = { key, botId: bot.id, platform, state: 'waiting', deadline: Date.now() + pageWait }
    meetings.set(key, meeting)
    save()
    // Stopped while Recall created it: stop() asks it to leave along with the others.
    if (stopping) throw new JoinError(`${STOPPING} The bot it had just created (${bot.id}) is asked to leave.`)
    // A bot whose page never comes (the tunnel was down, say) would sit in the call silent, at a cost.
    meeting.timer = setTimeout(() => leave(meeting, 'its page never connected'), pageWait)
    meeting.timer.unref()
    // The bot's id is enough to find it in Recall. The meeting's link stays out of the log, which nothing deletes: for
    // Google Meet even a link without its query string lets anyone join.
    console.log(`[join] bot ${bot.id} is joining a ${recall.PLATFORM_NAMES[platform]} meeting`)
    return { bot_id: bot.id, platform, key }
  }

  /** Asks the bots a run that crashed, or was killed, left in their calls to leave (from PENDING_BOTS_FILE). */
  function recover(): void {
    let saved: unknown
    try {
      saved = JSON.parse(fs.readFileSync(pendingFile, 'utf8'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[leave] could not read ${pendingFile} (${errorName(err)}), so the bots it lists are not asked to leave`)
      }
      return
    }
    for (const entry of Array.isArray(saved) ? saved : []) {
      const { key, botId, deadline } = (entry ?? {}) as Record<string, unknown>
      if (typeof key !== 'string' || typeof botId !== 'string' || !/^[\w-]{1,100}$/.test(botId) || meetings.has(key)) continue
      const meeting: Meeting<S> = { key, botId, state: 'waiting', deadline: typeof deadline === 'number' ? deadline : Date.now() }
      meetings.set(key, meeting)
      leave(meeting, 'the service last stopped without seeing it out of its call')
    }
    save()
  }

  const bridge = new SessionBridge({
    // get_transcript, post_chat, add_to_brief and late answers, each for the meeting named, else the newest
    // meeting the assistant is in; post_chat without a key is refused while it is in more than one (src/sessions.ts).
    ...sessionHandlers(sessions),
    setBrief: markdown => {
      fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 })
      // The brief says what must not be disclosed: readable by you only.
      fs.writeFileSync(briefFile, markdown, { mode: 0o600 })
      fs.chmodSync(briefFile, 0o600) // mode applies only when the file is created
    },
    joinMeeting: async meetingUrl => {
      const { bot_id, platform, key } = await startBot(meetingUrl)
      // The key is what this meeting's questions and events carry as "meeting".
      return { note: `${identity.name} is joining the ${recall.PLATFORM_NAMES[platform]} meeting (bot ${bot_id}). ${joinTip()}`, meeting: key }
    },
  })

  const audioWss = new WebSocketServer({ noServer: true })
  const bridgeWss = new WebSocketServer({ noServer: true })

  /** Starts the conversation for a page that connected to /audio. Null if it could not start. */
  function startAudio(ws: WebSocket, opts: SessionOptions): S | null {
    let session: S
    try {
      session = deps.startSession(ws, opts, { bridge, brief })
    } catch (err) {
      console.error('[audio]', (err as Error).message)
      ws.send(JSON.stringify({ type: 'error', message: PAGE_ERRORS.start }))
      ws.close()
      return null
    }
    sessions.add(session)
    ws.on('close', () => sessions.delete(session))
    console.log(`[audio] session started for bot ${opts.botId}`)
    return session
  }

  // --- Public listener: only what the meeting bot needs ---------------------------------------------
  function handlePublic(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = requestUrl(req)
    if (!url) return send(res, 400, 'bad request')
    const file = served.get(url.pathname)
    if (req.method === 'GET' && file) return send(res, 200, file.body, file.type)
    // Anyone can reach this through the tunnel, so it says nothing about meetings or the session link.
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, JSON.stringify({ ok: true }), 'application/json')
    send(res, 404, 'not found')
  }

  function onPublicUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const handOver = destroyOnError(socket)
    const url = requestUrl(req)
    if (!url) return refuse(socket, 400, 'bad request')
    // Only the bot page's audio.
    if (url.pathname !== '/audio') return refuse(socket, 404, 'not found')
    if (!cfg.agentPageToken || !sameSecret(url.searchParams.get('token') ?? '', cfg.agentPageToken)) return refuse(socket, 403, 'forbidden')
    if (stopping) return refuse(socket, 503, 'the voice service is stopping')
    const key = url.searchParams.get('key') ?? ''
    const meeting = meetings.get(key)
    const platform = meeting?.platform
    if (!meeting || !platform || meeting.state === 'leaving') {
      console.warn('[audio] refused a bot page for a meeting this service did not start, or one that is over')
      return refuse(socket, 403, 'forbidden')
    }
    // One page per meeting. The bot's page only reconnects once its first connection has gone, so a second
    // one at the same time is someone else's.
    if (meeting.state === 'live') {
      console.warn(`[audio] refused a second page for bot ${meeting.botId}: its page is connected`)
      return refuse(socket, 409, 'this meeting already has its page')
    }
    // The callback runs before any other upgrade is handled, so two pages can't both get past the check above.
    handOver()
    audioWss.handleUpgrade(req, socket, head, ws => {
      const session = startAudio(ws, { meetingKey: key, botId: meeting.botId, platform: recall.PLATFORM_NAMES[platform] })
      if (!session) return
      clearTimeout(meeting.timer)
      meeting.state = 'live'
      meeting.session = session
      if (meeting.startedAt === undefined) {
        // MAX_MEETING_MINUTES caps what one meeting can cost: from when its page first connected, whether or not a
        // page is connected when it runs out.
        meeting.startedAt = Date.now()
        meeting.deadline = meeting.startedAt + cfg.maxMeetingMinutes * 60_000
        meeting.limit = setTimeout(() => timeUp(meeting), cfg.maxMeetingMinutes * 60_000)
        meeting.limit.unref()
        save()
      }
      ws.on('close', () => pageGone(meeting, session))
    })
  }

  // --- Control listener: a Unix socket only you can open -------------------------------------------------

  async function handleControl(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = requestUrl(req)
    if (!url) return send(res, 400, 'bad request')
    if (req.method === 'GET' && url.pathname === '/health') {
      const health = {
        ok: true,
        session_linked: bridge.connected,
        meetings: sessions.size,
        bot_meetings: liveMeetings(),
        max_meetings: cfg.maxMeetings,
      }
      return send(res, 200, JSON.stringify(health), 'application/json')
    }
    if (req.method === 'POST' && url.pathname === '/api/join') return join(req, res)
    send(res, 404, 'not found')
  }

  /** Starts a meeting bot, for npm run join. */
  async function join(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Not for web pages, as a second line: no browser can open the socket, but were one ever to reach it (through a
    // local proxy, say), it could otherwise start bots on your Recall account (CSRF). Browsers send an Origin header
    // with every POST; the join CLI never does.
    if (req.headers.origin !== undefined) {
      console.warn(`[security] refused /api/join from a web page (${req.headers.origin})`)
      return send(res, 403, 'forbidden: /api/join is not for web pages')
    }
    // Nor for another program without the local token, which only you can read.
    if (!hasLocalToken(req, cfg.localToken)) {
      console.warn('[security] refused /api/join without the local token')
      return send(res, 401, 'The local token is missing or wrong (npm run join sends the one in the data folder).')
    }
    // A form or a "simple" cross-site request can't send JSON without the browser asking first.
    if (!isJson(req)) return send(res, 415, 'Send JSON, with Content-Type: application/json.')
    try {
      const { meetingUrl } = await readJson(req)
      const { bot_id, platform } = await startBot(meetingUrl)
      return send(res, 200, JSON.stringify({ bot_id, platform, tip: joinTip() }), 'application/json')
    } catch (err) {
      const status = err instanceof JoinError ? 400 : err instanceof BodyError ? err.status : 500
      return send(res, status, (err as Error).message)
    }
  }

  function onControlUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const handOver = destroyOnError(socket)
    const url = requestUrl(req)
    if (!url) return refuse(socket, 400, 'bad request')
    if (url.pathname === '/bridge') {
      // Only the channel server. Not a web page (browsers always send an Origin header with a websocket, and the
      // channel never does), nor another program without the local token.
      if (req.headers.origin !== undefined) {
        console.warn(`[security] refused a /bridge link from a web page (${req.headers.origin})`)
        return refuse(socket, 403, 'forbidden')
      }
      if (!hasLocalToken(req, cfg.localToken)) {
        console.warn('[security] refused a /bridge link without the local token')
        return refuse(socket, 401, 'the local token is missing or wrong')
      }
      // The bridge logs each link, and which session questions go to.
      handOver()
      return bridgeWss.handleUpgrade(req, socket, head, ws => bridge.attach(ws))
    }
    // Bot pages connect through the public listener only.
    refuse(socket, 404, 'not found')
  }

  const publicServer = http.createServer(guarded(handlePublic, false))
  publicServer.on('upgrade', guardedUpgrade('audio', onPublicUpgrade))
  const controlServer = http.createServer(guarded(handleControl))
  controlServer.on('upgrade', guardedUpgrade('control', onControlUpgrade))

  const listenOn = (server: http.Server, options: ListenOptions) =>
    new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(options, () => {
        server.off('error', reject)
        resolve()
      })
    })

  const closeServers = () =>
    Promise.all(
      [publicServer, controlServer]
        .filter(s => s.listening)
        .map(
          s =>
            new Promise<void>(resolve => {
              s.close(() => resolve())
              s.closeAllConnections()
            }),
        ),
    )

  return {
    publicServer,
    controlServer,
    bridge,
    sessions,
    async listen() {
      // Refuses to start beside another service on the same socket, before anything listens: so a second service
      // never takes the first one's port, nor asks the first one's bots to leave (recover).
      await prepareControlSocket(cfg.controlSocket)
      try {
        await listenOn(publicServer, { port: cfg.port, host: cfg.host })
        await listenOn(controlServer, { path: cfg.controlSocket })
        // Inside a folder only you can open already; and readable and writable by you only, where that counts too.
        fs.chmodSync(cfg.controlSocket, 0o600)
      } catch (err) {
        await closeServers()
        throw err
      }
      recover()
    },
    stop() {
      if (stopped) return stopped
      stopping = true
      const until = Date.now() + (cfg.stopWaitMs ?? STOP_WAIT_MS)
      stopped = (async () => {
        // Bots Recall is still creating join the meetings once created (startBot), so they are asked below too.
        await within(Promise.allSettled([...creating]), until - Date.now())
        const asked = [...meetings.values()].map(meeting => {
          clearTimers(meeting)
          return askToLeave(meeting)
        })
        await within(Promise.allSettled(asked), until - Date.now())
        if (meetings.size) {
          console.warn(`[stop] ${meetings.size} bot(s) could not be asked to leave their calls: the service asks again when it starts`)
        }
      })()
      return stopped
    },
    async close() {
      closed = true
      for (const meeting of meetings.values()) clearTimers(meeting)
      for (const ws of [...audioWss.clients, ...bridgeWss.clients]) ws.terminate()
      await closeServers()
    },
  }
}

/**
 * How the service stops: on SIGTERM, SIGINT or SIGHUP (launchd or systemd stop or restart it with SIGTERM; closing the
 * Terminal that runs npm start sends SIGHUP), and on a crash. It ends
 * the meeting sessions, so each bot is asked to leave its call and the owner's session hears that the meeting ended, and
 * asks every other bot still in a call (one still joining, or whose page has gone) to leave too. Then it exits: with
 * 1 after a crash, so launchd or systemd starts it again. Never later than failsafeMs, whatever is stuck.
 */
export function stopper<S>(
  service: { readonly sessions: ReadonlySet<S>; stop(): Promise<void> },
  deps: { endSessions(sessions: S[]): Promise<void>; exit(code: number): void; exitDelayMs?: number; failsafeMs?: number },
): (why: string, code?: number) => void {
  let stopping = false
  let exitCode = 0
  return (why, code = 0) => {
    exitCode = Math.max(exitCode, code)
    if (stopping) return
    stopping = true
    console.log(`[stop] ${why}: ending ${service.sessions.size} meeting session(s), and asking any other bot still in a call to leave`)
    const failsafe = setTimeout(() => deps.exit(exitCode), deps.failsafeMs ?? 15_000)
    // endSessions ends every session before it waits for their minutes, so their bots are asked to leave first.
    const ending = (async () => deps.endSessions([...service.sessions]))()
    void Promise.allSettled([ending, service.stop()]).then(results => {
      for (const r of results) if (r.status === 'rejected') console.error('[stop]', r.reason)
      // Time for the last events to reach the session.
      setTimeout(() => {
        clearTimeout(failsafe)
        deps.exit(exitCode)
      }, deps.exitDelayMs ?? 300)
    })
  }
}

// --- The service itself (npm start, launchd, systemd) ----------------------------------------------------

// At start and then hourly, since the service runs for weeks: the chat notice promises the deletion.
function sweep(): void {
  try {
    const removed = sweepOldRecords()
    if (removed) console.log(`[retention] deleted ${removed} transcript and minutes files older than ${config.retentionDays} days`)
  } catch (err) {
    console.error('[retention]', (err as Error).message)
  }
}

/** A path as a shell takes it: quoted only if it has to be. */
const shellPath = (p: string) => (/^[\w./~-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`)

async function main(): Promise<void> {
  // The service never runs with a name it can't hear, or one that would make it leave by mistake, or a
  // participant-list name that doesn't say it is an AI, or without knowing whose assistant it is.
  checkNameAtStartup()
  // Nor with a Recall region its key can't work in (there is no default), or a bot page that would join deaf, or not
  // say it is an AI: the page is read and checked here, once, and that copy is served. Nor with a profile that
  // PROFILE_FILE names but can't be read: it holds the owner's Never share and Never open. Before the data folder is
  // touched: nothing is made for a service that stops.
  const agentPage = loadAgentPage(config.agentPageFile, identity)
  const problem = recallRegionProblem(config.recallRegion) || agentPage.problem || PROFILE.problem
  if (problem) throw new Error(problem)
  for (const warning of [...retiredSettings(process.env), ...PROFILE.warnings]) console.warn(warning)
  // Transcripts, minutes, the brief, the local token and the control socket: reachable by you only.
  prepareDataDir(config.dataDir)
  const localToken = ensureLocalToken(config.dataDir)

  const brain = new Brain()
  // The assistant's fixed lines play from audio made once per voice and kept in data/tts-cache. Only those lines:
  // never anything said in a meeting, nor Claude's answers.
  const lines = new LineCache({ dir: path.join(config.dataDir, 'tts-cache'), lines: FIXED_LINES })

  const service = createServers(
    {
      port: config.port,
      host: config.host,
      controlSocket: config.controlSocket,
      publicUrl: config.publicUrl,
      agentPageToken: config.agentPageToken,
      agentPage: agentPage.page,
      localToken,
      dataDir: config.dataDir,
      maxMeetings: config.maxMeetings,
      maxMeetingMinutes: config.maxMeetingMinutes,
    },
    {
      createBot: recall.createBot,
      leaveCall: recall.leaveCall,
      startSession: (ws, opts, { bridge, brief }) => new MeetingSession(ws, opts, { brain, bridge, brief, speak: lines.speak }),
    },
  )

  // launchd or systemd stops or restarts the service with SIGTERM (and SIGKILL 20 s later). End the meetings first: the assistant
  // leaves calls it could no longer hear (the bot page does not reconnect), the owner's session hears that each meeting ended,
  // with its minutes if they are written within 10 s, and bots still joining are asked to leave. A crash does the
  // same, so no bot is left silent in a call, then exits with 1.
  const stop = stopper(service, { endSessions: sessions => endSessions(sessions, 10_000), exit: code => process.exit(code) })
  process.once('SIGTERM', () => stop('SIGTERM'))
  process.once('SIGINT', () => stop('SIGINT'))
  // Closing the Terminal that runs npm start (or a dropped SSH session) sends SIGHUP: stop in order then too, or the
  // bots would stay in their calls.
  process.once('SIGHUP', () => stop('SIGHUP'))
  process.on('uncaughtException', err => {
    console.error('[crash] uncaught exception:', err)
    stop('a crash (uncaught exception)', 1)
  })
  process.on('unhandledRejection', reason => {
    console.error('[crash] unhandled rejection:', reason)
    stop('a crash (unhandled rejection)', 1)
  })

  sweep()
  setInterval(sweep, 3_600_000).unref()

  // Made in the background, so the service starts at once. A line that isn't ready yet streams live.
  if (process.env.ELEVENLABS_API_KEY?.trim() && process.env.ELEVENLABS_VOICE_ID?.trim()) {
    void lines.warm().then(({ found, generated, failed, removed }) => {
      console.log(
        `[tts] ${found + generated} of ${FIXED_LINES.length} fixed lines cached (${generated} made now` +
          `${failed ? `, ${failed} failed and will stream live` : ''}${removed ? `, ${removed} old files removed` : ''})`,
      )
    })
  } else {
    console.log(`[tts] ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID is not set, so ${identity.name}'s fixed lines will stream live`)
  }

  if (!['127.0.0.1', '::1', 'localhost'].includes(config.host)) {
    console.warn(
      `[security] WARNING: HOST=${config.host}, so port ${config.port} is open to other machines, not only to the tunnel on this one.\n` +
        '[security] It serves only the bot page and the audio of meetings this service started (with AGENT_PAGE_TOKEN), but\n' +
        '[security] leave HOST unset unless the tunnel runs on another machine.',
    )
  }

  await service.listen()
  const port = (service.publicServer.address() as AddressInfo).port
  console.log(`${identity.name} is listening.`)
  const bound = config.host.includes(':') ? `[${config.host}]` : config.host
  console.log(`  For the meeting bot:     http://${bound}:${port} (the tunnel points here)`)
  console.log(`  Public address:          ${config.publicUrl || '(not set)'}`)
  const link = [config.agentPageToken ? '' : 'AGENT_PAGE_TOKEN is not set.', publicUrlProblem(config.publicUrl)].filter(Boolean)
  if (link.length) console.warn(`[start] ${link.join(' ')} Until then, a meeting can't be joined.`)
  console.log(`  This computer only:      ${config.controlSocket} (npm run join, the Claude Code channel)`)
  console.log(`  Details:                 curl --unix-socket ${shellPath(config.controlSocket)} http://localhost/health`)
}

/** Started as the service (npm start, launchd, systemd), not imported by a test. */
function isEntryPoint(): boolean {
  try {
    return fs.realpathSync(process.argv[1] ?? '') === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  main().catch(err => {
    console.error('[start]', (err as Error).message)
    process.exit(1)
  })
}
