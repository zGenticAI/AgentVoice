// Sends the assistant into a meeting: npm run join -- "<Zoom, Google Meet or Microsoft Teams link>" [--brief <file>]
// [--speaker-probe]
// With --brief, the meeting answers from that file's brief instead of the shared one (data/brief.md), and no other
// meeting sees it. With --speaker-probe, for a test meeting whose participants have agreed, the service measures who is
// speaking (it needs SPEAKER_PROBE on: docs/speaker-probe.md). With --share-test [--json <file>] [--keep], it runs the
// screen-share test in a test meeting you host, asking you what you see and hear, and prints a report
// (docs/share-test.md, src/cli/share-test-run.ts).
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import readline from 'node:readline'
import { briefProblem } from '../brief.ts'
import { ROOT, config } from '../config.ts'
import { controlSocketProblem, nothingListening } from '../control-socket.ts'
import { identity } from '../identity.ts'
import { readLocalToken } from '../local-token.ts'
import { writePrivate } from '../probe/flux-probe.ts'
import { PROBE_OFF } from '../speakers/probe.ts'
import { JOIN_USAGE, type JoinArgs, joinArgs } from './join-args.ts'
import { QUESTION_WAIT_MS, type ServiceReply, runShareTest } from './share-test-run.ts'

const args = joinArgs(process.argv.slice(2))
if ('problem' in args) {
  console.error(`${args.problem}\n${JOIN_USAGE}`)
  process.exit(1)
}

// The brief for this meeting only: read here, from the file you named, and checked before anything is sent.
let brief: string | undefined
if (args.briefFile) {
  try {
    brief = fs.readFileSync(args.briefFile, 'utf8')
  } catch (err) {
    console.error(`Could not read the brief ${args.briefFile}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`)
    process.exit(1)
  }
  const unfit = briefProblem(brief)
  if (unfit) {
    console.error(`${args.briefFile}: ${unfit}`)
    process.exit(1)
  }
}

// /api/join is on the control socket (in the data folder, which only you can open), and needs the local token the
// voice service made.
let token: string
try {
  token = readLocalToken(config.dataDir)
} catch (err) {
  console.error((err as Error).message)
  process.exit(1)
}
// The token goes only to a socket in a folder only you can open, so no other user can be listening there.
const problem = controlSocketProblem(config.controlSocket)
if (problem) {
  console.error(problem)
  process.exit(1)
}

/**
 * A request to the voice service on the control socket: its answer, or the error that kept it from coming. With
 * timeoutMs, one with no answer by then is given up on.
 */
function call(method: 'GET' | 'POST', urlPath: string, body = '', timeoutMs?: number): Promise<{ status: number; body: string } | Error> {
  return new Promise(resolve => {
    const req = http.request(
      {
        socketPath: config.controlSocket,
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

function unreachableText(err: Error): string {
  return nothingListening(err)
    ? `The voice service is not running (nothing is listening on ${config.controlSocket}). Start it with npm start, or scripts/install-service.sh.`
    : `Could not reach the voice service on ${config.controlSocket}: ${err.message}`
}

function unreachable(err: Error): never {
  console.error(unreachableText(err))
  process.exit(1)
}

if (args.shareTest) {
  const code = await shareTest(args)
  // The report may still be on its way to a pipe: exit once it has gone.
  await new Promise(resolve => process.stdout.write('', resolve))
  process.exit(code)
}

/**
 * The screen-share test (src/cli/share-test-run.ts), with the terminal, the clock and the control socket. The first
 * Ctrl-C stops the test, which then stops the share and takes the assistant out; a second one quits at once. Closing
 * the terminal (SIGHUP) or SIGTERM stops it the same way, and never quits at once: a closing terminal sends SIGHUP
 * twice, and the share and the assistant must still be taken out.
 */
async function shareTest(args: JoinArgs): Promise<number> {
  const stop = new AbortController()
  let interrupts = 0
  const interrupt = () => {
    if (++interrupts > 1) process.exit(130)
    stop.abort()
  }
  process.on('SIGINT', interrupt)
  const hangUp = (signal: NodeJS.Signals) => stop.abort(signal === 'SIGHUP' ? 'the terminal closed' : `it was stopped (${signal})`)
  process.on('SIGHUP', hangUp)
  process.on('SIGTERM', hangUp)
  // Writing to a terminal that has closed fails (EIO, or EPIPE on a pipe): with no listener, that error would end the
  // process before the share is stopped and the assistant taken out. What can't be printed is lost, nothing more.
  for (const stream of [process.stdout, process.stderr, process.stdin]) stream.on('error', () => {})
  const reach = async (method: 'GET' | 'POST', urlPath: string, body: string, timeoutMs: number): Promise<ServiceReply> => {
    const reply = await call(method, urlPath, body, timeoutMs)
    if (reply instanceof Error) throw new Error(unreachableText(reply))
    return reply
  }
  // Every key and token here, so that nothing the test prints or writes can hold one.
  const secrets = [token, ...Object.entries(process.env).filter(([n, v]) => /(KEY|TOKEN|SECRET)$/.test(n) && (v?.trim().length ?? 0) >= 8).map(([, v]) => (v as string).trim())]
  let version = ''
  try {
    version = String(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version ?? '')
  } catch {
    // Only for the report's first line.
  }
  return runShareTest(
    { meetingUrl: args.meetingUrl, brief, jsonFile: args.jsonFile, keep: args.keep },
    {
      client: {
        health: () => reach('GET', '/health', '', 10_000),
        join: body => reach('POST', '/api/join', body, 60_000),
        status: botId => reach('GET', `/api/share-test/status?${new URLSearchParams({ bot: botId })}`, '', 10_000),
        // The longest: a share call waits up to 15 s for Recall, and a test line up to 10 s to play, behind any before it.
        action: (botId, action, step) => reach('POST', '/api/share-test/action', JSON.stringify({ bot_id: botId, action, step }), 45_000),
      },
      ask: (prompt, signal) => askLine(prompt, signal, interrupt),
      out: text => void process.stdout.write(`${text}\n`),
      log: text => void process.stderr.write(`${text}\n`),
      now: Date.now,
      sleep: (ms, signal) =>
        new Promise((resolve, reject) => {
          if (signal.aborted) return reject(new Error('stopped'))
          const onAbort = () => {
            clearTimeout(timer)
            reject(new Error('stopped'))
          }
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort)
            resolve()
          }, ms)
          signal.addEventListener('abort', onAbort, { once: true })
        }),
      signal: stop.signal,
      writeJson: writePrivate,
      name: identity.name,
      app: `agent-voice ${version}`.trim(),
      node: process.version,
      date: new Date(),
      secrets,
      publicUrl: config.publicUrl,
    },
  )
}

/**
 * One question in the terminal: the owner's line, or null after QUESTION_WAIT_MS with none. Rejects when the test is
 * stopped meanwhile, or the terminal closes. In a terminal, readline takes Ctrl-C itself: it stops the test all the same.
 */
function askLine(prompt: string, signal: AbortSignal, interrupt: () => void): Promise<string | null> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('stopped'))
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
    let settled = false
    const settle = (done: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      rl.close()
      done()
    }
    const onAbort = () => settle(() => reject(new Error('stopped')))
    const timer = setTimeout(() => settle(() => resolve(null)), QUESTION_WAIT_MS)
    signal.addEventListener('abort', onAbort, { once: true })
    rl.on('SIGINT', interrupt)
    rl.on('close', () => settle(() => reject(new Error('the terminal closed'))))
    // A terminal that closed under a question: readline passes its error on, and would end the process with it.
    rl.on('error', () => settle(() => reject(new Error('the terminal closed'))))
    rl.question(`${prompt} `, answer => settle(() => resolve(answer)))
  })
}

// What this join needs the running service to be able to do. One older than this command would ignore a meeting's
// brief and send the assistant in with the shared one, so it is asked first, and refused rather than joined.
const needs = brief === undefined ? [] : ['meeting_brief']
if (needs.length || args.speakerProbe) {
  const health = await call('GET', '/health')
  if (health instanceof Error) unreachable(health)
  let said: { features?: unknown; speaker_probe?: unknown } = {}
  try {
    said = JSON.parse(health.body) ?? {}
  } catch {
    // An answer that isn't JSON lists nothing.
  }
  const can = Array.isArray(said.features) ? said.features.map(String) : []
  if (!needs.every(feature => can.includes(feature))) {
    console.error(
      'The voice service is older than this command and cannot keep a brief for one meeting: restart it, then try again ' +
        '(or leave out --brief to use the shared brief).',
    )
    process.exit(1)
  }
  // The speaker probe needs SPEAKER_PROBE on in the service. One older than this command has none, and would send the
  // assistant in without it: the test meeting would measure nothing.
  if (args.speakerProbe && said.speaker_probe !== true) {
    console.error(
      typeof said.speaker_probe === 'boolean'
        ? PROBE_OFF
        : 'The voice service is older than this command and has no speaker probe: restart it, then try again (or leave out --speaker-probe).',
    )
    process.exit(1)
  }
}

// speaker_probe only when asked for: without it, the request is what it always was.
const body = { meetingUrl: args.meetingUrl, brief, ...(args.speakerProbe ? { speaker_probe: true } : {}) }
const res = await call('POST', '/api/join', JSON.stringify(body))
if (res instanceof Error) unreachable(res)
if (res.status !== 200) {
  console.error(`Could not start the bot: ${res.body}`)
  process.exit(1)
}
const { bot_id, tip, brief_note, speaker_probe } = JSON.parse(res.body)
console.log(`${identity.name} is joining (bot ${bot_id}).`)
if (brief_note) console.log(brief_note)
if (args.speakerProbe) {
  console.log(
    speaker_probe === true
      ? 'The speaker probe is on for this meeting: use it only in a test meeting whose participants have agreed (docs/speaker-probe.md).'
      : 'The voice service did not turn the speaker probe on for this meeting, so it measures nothing.',
  )
}
console.log(tip)
