// Streams test clips to Deepgram Flux exactly as the service would, and prints what Flux sent and what the assistant
// would have done with it: npm run flux-probe [-- --mic] [--files <dir>] [--nonverbal] [--json <path>]
// [--idle-max <seconds>] [--only <ids>]. docs/flux-probe.md says what it costs, and how to read the report. It changes
// nothing in the service, writes nothing unless --json says where, and never prints a key.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'
import { ROOT } from '../config.ts'
import { identity } from '../identity.ts'
import { fluxUrl } from '../pipeline/deepgram.ts'
import { synthesize } from '../pipeline/tts.ts'
import { USAGE, parseArgs, redact, runProbe } from '../probe/flux-probe.ts'

const parsed = parseArgs(process.argv.slice(2))
if ('error' in parsed) {
  console.error(parsed.error)
  process.exit(1)
}
const { args } = parsed
if (args.help) {
  console.log(`${USAGE}\nSee docs/flux-probe.md.`)
  process.exit(0)
}

const env = (name: string) => process.env[name]?.trim() ?? ''
const key = env('DEEPGRAM_API_KEY')
if (!key) {
  console.error(`DEEPGRAM_API_KEY is not set. Add it to ${path.join(ROOT, '.env')}`)
  process.exit(1)
}
// Every key and token in the environment, so that nothing the probe prints or writes can hold one.
const secrets = Object.entries(process.env)
  .filter(([name, value]) => /(KEY|TOKEN|SECRET)$/.test(name) && (value?.trim().length ?? 0) >= 8)
  .map(([, value]) => (value as string).trim())

let version = ''
try {
  version = String(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version ?? '')
} catch {
  // Only for the report's first line.
}

try {
  await runProbe(args, {
    url: fluxUrl(),
    deepgramKey: key,
    secrets,
    voice: Boolean(env('ELEVENLABS_API_KEY') && env('ELEVENLABS_VOICE_ID')),
    name: identity.name,
    speak: (text, model) => synthesize(text, undefined, model),
    ask: async prompt => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
      try {
        await rl.question(`${prompt} `)
      } finally {
        rl.close()
      }
    },
    out: text => void process.stdout.write(`${text}\n`),
    log: text => void process.stderr.write(`${text}\n`),
    app: `agent-voice ${version}`.trim(),
  })
} catch (err) {
  console.error(redact(`flux-probe: ${(err as Error).message}`, secrets))
  process.exitCode = 1
}
