// Sends the assistant into a meeting: npm run join -- "<Zoom, Google Meet or Microsoft Teams link>" [--brief <file>]
// [--speaker-probe]
// With --brief, the meeting answers from that file's brief instead of the shared one (data/brief.md), and no other
// meeting sees it. With --speaker-probe, for a test meeting whose participants have agreed, the service measures who is
// speaking (it needs SPEAKER_PROBE on: docs/speaker-probe.md).
import fs from 'node:fs'
import http from 'node:http'
import { briefProblem } from '../brief.ts'
import { config } from '../config.ts'
import { controlSocketProblem, nothingListening } from '../control-socket.ts'
import { identity } from '../identity.ts'
import { readLocalToken } from '../local-token.ts'
import { PROBE_OFF } from '../speakers/probe.ts'
import { JOIN_USAGE, joinArgs } from './join-args.ts'

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

/** A request to the voice service on the control socket: its answer, or the error that kept it from coming. */
function call(method: 'GET' | 'POST', path: string, body = ''): Promise<{ status: number; body: string } | Error> {
  return new Promise(resolve => {
    const req = http.request(
      {
        socketPath: config.controlSocket,
        path,
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
    req.end(body)
  })
}

function unreachable(err: Error): never {
  console.error(
    nothingListening(err)
      ? `The voice service is not running (nothing is listening on ${config.controlSocket}). Start it with npm start, or scripts/install-service.sh.`
      : `Could not reach the voice service on ${config.controlSocket}: ${err.message}`,
  )
  process.exit(1)
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
