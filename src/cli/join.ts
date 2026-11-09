// Sends the assistant into a meeting: npm run join -- "<Zoom, Google Meet or Microsoft Teams link>"
import http from 'node:http'
import { config } from '../config.ts'
import { controlSocketProblem, nothingListening } from '../control-socket.ts'
import { identity } from '../identity.ts'
import { readLocalToken } from '../local-token.ts'

const meetingUrl = process.argv[2]
if (!meetingUrl) {
  console.error('Usage: npm run join -- "<Zoom, Google Meet or Microsoft Teams meeting link>"')
  process.exit(1)
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

const body = JSON.stringify({ meetingUrl })
const res = await new Promise<{ status: number; body: string } | Error>(resolve => {
  const req = http.request(
    {
      socketPath: config.controlSocket,
      path: '/api/join',
      method: 'POST',
      headers: {
        host: 'localhost',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
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

if (res instanceof Error) {
  console.error(
    nothingListening(res)
      ? `The voice service is not running (nothing is listening on ${config.controlSocket}). Start it with npm start, or scripts/install-service.sh.`
      : `Could not reach the voice service on ${config.controlSocket}: ${res.message}`,
  )
  process.exit(1)
}
if (res.status !== 200) {
  console.error(`Could not start the bot: ${res.body}`)
  process.exit(1)
}
const { bot_id, tip } = JSON.parse(res.body)
console.log(`${identity.name} is joining (bot ${bot_id}).`)
console.log(tip)
