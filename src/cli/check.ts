// Checks the assistant's name, the owner's settings and profile, the Recall region and the bot page, then the speech,
// answer and voice services with a tiny real request each: npm run check
// Prints what works and what doesn't, and what the assistant will say and be told with these settings (the consent
// line, the chat notice, the participant-list name and the start of its rules), so they can be read before a meeting
// hears them. Never prints the keys themselves.
import path from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import WebSocket from 'ws'
import { spokenThinking, systemPrompt } from '../brain/brain.ts'
import { ROOT, config, publicUrlProblem, recallRegionProblem } from '../config.ts'
import { JOIN_LINE, joinChatMessage } from '../consent.ts'
import { IDENTITY_WARNINGS, identity } from '../identity.ts'
import { checkName, checkOwner, describeName } from '../name-check.ts'
import { SAMPLE_RATE } from '../pipeline/deepgram.ts'
import { synthesize } from '../pipeline/tts.ts'
import { agentPageFileProblem } from '../pages.ts'
import { PROFILE, PROFILE_SECTIONS, type ProfileSection } from '../profile.ts'

function keyShape(name: string): string {
  const raw = process.env[name]
  if (!raw?.trim()) return `${name} is empty in .env`
  if (/^["']|["']$/.test(raw.trim())) return `${name} has quote marks around it; remove them`
  if (raw !== raw.trim()) return `${name} has spaces around it; remove them`
  return ''
}

async function checkAnthropic(): Promise<string> {
  const msg = await new Anthropic().messages.create({
    model: config.model,
    max_tokens: 64,
    thinking: spokenThinking(config.model), // as the meeting's replies do, so the check proves the model takes it
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: 'Say "ready" and nothing else.' }],
  })
  const text = msg.content.find(b => b.type === 'text')
  return `${config.model} replied "${text?.type === 'text' ? text.text.trim() : '(no text)'}"`
}

function checkDeepgram(): Promise<string> {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ model: 'flux-general-en', encoding: 'linear16', sample_rate: String(SAMPLE_RATE) })
    const ws = new WebSocket(`wss://api.deepgram.com/v2/listen?${params}`, {
      headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY?.trim()}` },
    })
    const timer = setTimeout(() => (ws.terminate(), reject(new Error('no answer from Deepgram within 10 seconds'))), 10_000)
    ws.on('unexpected-response', (_req, res) => {
      let body = ''
      res.on('data', (c: Buffer) => (body += c))
      res.on('end', () => (clearTimeout(timer), reject(new Error(`refused (${res.statusCode}): ${body.slice(0, 300)}`))))
    })
    ws.on('error', err => (clearTimeout(timer), reject(err)))
    ws.on('open', () => ws.send(Buffer.alloc(SAMPLE_RATE * 2 * 0.5))) // half a second of silence
    ws.on('message', data => {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'Error') return clearTimeout(timer), ws.terminate(), reject(new Error(msg.description ?? data.toString()))
      clearTimeout(timer)
      ws.send(JSON.stringify({ type: 'CloseStream' }))
      setTimeout(() => ws.terminate(), 200)
      resolve(`Flux stream opened (first message: ${msg.type})`)
    })
  })
}

async function checkElevenLabs(): Promise<string> {
  let bytes = 0
  // The name, so the first spoken words are how the voice says it.
  for await (const chunk of synthesize(`Hello, this is ${identity.name}.`)) bytes += chunk.length
  if (!bytes) throw new Error('no audio came back')
  return `voice ${process.env.ELEVENLABS_VOICE_ID?.trim()} returned ${(bytes / 2 / SAMPLE_RATE).toFixed(1)} s of audio`
}

const checks: [string, string[], () => Promise<string>][] = [
  ['Anthropic', ['ANTHROPIC_API_KEY'], checkAnthropic],
  ['Deepgram', ['DEEPGRAM_API_KEY'], checkDeepgram],
  ['ElevenLabs', ['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID'], checkElevenLabs],
]

let failed = 0
// The name first: the service won't start with one that has errors.
const named = checkName(identity)
const nameNote = 'npm run check-name tries it on about 1,900 meeting lines'
if (named.errors.length) {
  failed++
  console.log(`✗ Name: ${describeName(identity)}\n${named.errors.map(e => `    ${e}`).join('\n')}\n    (${nameNote}.)`)
} else {
  console.log(`✓ Name: ${describeName(identity)}, bot name "${identity.botName}" (${nameNote})`)
}
// What reading .env warned about (a stale ALEX_BOT_NAME, a renamed variable): the service writes it at start-up too.
for (const warning of [...IDENTITY_WARNINGS.map(w => w.replace(/^\[identity\] /, '')), ...named.warnings]) console.log(`  Warning: ${warning}`)

// The owner: the service and the channel refuse to start without OWNER_NAME, or with a setting that can't go into text.
const owned = checkOwner(identity)
const ownerLine = [
  `"${identity.owner}"`,
  identity.ownerFull !== identity.owner ? `full name "${identity.ownerFull}"` : '',
  identity.company ? `company "${identity.company}"` : 'no company',
].filter(Boolean).join(', ')
if (owned.errors.length) {
  failed++
  console.log(`✗ Owner: ${owned.errors.join('\n    ')}`)
} else {
  console.log(`✓ Owner: ${ownerLine}`)
}
for (const warning of owned.warnings) console.log(`  Warning: ${warning}`)

// The profile: which sections were found, so a misspelt heading is seen before a meeting misses it.
const relative = path.relative(ROOT, PROFILE.file).startsWith('..') ? PROFILE.file : path.relative(ROOT, PROFILE.file)
const keys = Object.keys(PROFILE_SECTIONS) as ProfileSection[]
const found = keys.filter(key => PROFILE.sections[key]).map(key => PROFILE_SECTIONS[key])
const defaults = keys.filter(key => !PROFILE.sections[key]).map(key => PROFILE_SECTIONS[key])
if (PROFILE.problem) {
  failed++
  console.log(`✗ Profile: ${PROFILE.problem}`)
} else if (!PROFILE.found) {
  console.log(`  Profile: none at ${relative}, so every section has its generic default (copy profile.example.md to start one).`)
} else {
  console.log(
    `✓ Profile: ${relative}: ${found.length ? found.join(', ') : 'no sections'}` +
      (defaults.length ? `; the generic default for ${defaults.join(', ')}` : ''),
  )
}
for (const warning of PROFILE.warnings) console.log(`  Warning: ${warning.replace(/^\[profile\] /, '')}`)

// What the meeting hears and the model is told, with these settings: read them before a meeting does.
if (!owned.errors.length && !named.errors.length) {
  const rules = systemPrompt(identity, PROFILE).split('\n')
  console.log(`  Consent line: ${JOIN_LINE}`)
  console.log(`  Chat notice: ${joinChatMessage()}`)
  console.log(`  Spoken answers' rules start: ${rules[0]}\n    ${rules[1]}`)
}

// Recall: its key works in one region only, and there is no default. The key itself is first used by a join.
const region = recallRegionProblem(config.recallRegion)
if (region) {
  failed++
  console.log(`✗ Recall: ${region}`)
} else {
  console.log(`✓ Recall: region ${config.recallRegion} (the key is first used when the assistant joins a meeting)`)
}

// The bot's link: the page token, and the tunnel's https address the bot loads its page from. That the tunnel works is
// for curl to show once the service runs: this only checks what the settings can show.
const link = [config.agentPageToken ? '' : 'AGENT_PAGE_TOKEN is not set. Set it in .env to the output of openssl rand -hex 24.', publicUrlProblem(config.publicUrl)].filter(Boolean)
if (link.length) {
  failed++
  console.log(`✗ Bot link: ${link.join(' ')}`)
} else {
  console.log(`✓ Bot link: ${config.publicUrl}/agent (once the service runs, curl ${config.publicUrl}/health should print {"ok":true})`)
}

// The bot page: public/agent.html, or one of your own that keeps the contract (src/pages.ts).
const page = agentPageFileProblem(config.agentPageFile, identity)
if (page) {
  failed++
  console.log(`✗ Bot page: ${page}`)
} else {
  console.log(`✓ Bot page: ${config.agentPageFile || 'public/agent.html'}`)
}

for (const [name, keys, run] of checks) {
  const shape = keys.map(keyShape).filter(Boolean)
  if (shape.length) {
    failed++
    console.log(`✗ ${name}: ${shape.join('; ')}`)
    continue
  }
  try {
    console.log(`✓ ${name}: ${await run()}`)
  } catch (err) {
    failed++
    console.log(`✗ ${name}: ${(err as Error).message}`)
  }
}
console.log(
  failed ? `\n${failed} check(s) failed. Fix .env, then run npm run check again.` : '\nThe settings are complete, and Anthropic, Deepgram and ElevenLabs all work.',
)
process.exit(failed ? 1 : 0)
