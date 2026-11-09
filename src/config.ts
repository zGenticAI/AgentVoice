import path from 'node:path'
import { ROOT, pathSetting } from './env.ts'
import { type Names, identity } from './identity.ts'

export { ROOT, pathSetting }

function optional(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback
}

// Read lazily, when first used, so the tests and npm run check load the modules without every key set.
export function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is not set. Add it to ${path.join(ROOT, '.env')}`)
  return value
}

// Deepgram takes up to 100 keyterms and 500 tokens of them in all, and refuses the whole stream
// ("Keyterm limit exceeded") beyond that, which would leave the assistant deaf in every meeting.
// https://developers.deepgram.com/docs/flux/configure
export const MAX_KEYTERMS = 100
export const MAX_KEYTERM_TOKENS = 500
// A rough count, on the safe side: about 1.3 tokens a word, and at least 2 for any term.
const tokensIn = (term: string) => Math.max(2, Math.ceil(term.split(/\s+/).length * 1.3))

/**
 * Words Deepgram should listen out for: the assistant's name (always first), the owner's name and the company if
 * there is one, plus any extra ones, comma-separated. Terms past the limits are left out, with a warning. The name's
 * variants and mishearings are not added: they are what Deepgram writes when it gets the name wrong.
 */
export function keyterms(
  extra: string,
  warn: (message: string) => void = console.warn,
  id: Pick<Names, 'name' | 'owner' | 'company'> = identity,
): string[] {
  const seen = new Set<string>()
  const terms = [id.name, id.owner, id.company, ...extra.split(',').map(t => t.trim())].filter(
    t => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()),
  )
  const kept: string[] = []
  let tokens = 0
  for (const term of terms) {
    if (kept.length >= MAX_KEYTERMS || tokens + tokensIn(term) > MAX_KEYTERM_TOKENS) break
    kept.push(term)
    tokens += tokensIn(term)
  }
  const dropped = terms.slice(kept.length)
  if (dropped.length) {
    warn(`[stt] DEEPGRAM_KEYTERMS is over Deepgram's limit (${MAX_KEYTERMS} terms, about ${MAX_KEYTERM_TOKENS} tokens). Left out: ${dropped.join(', ')}`)
  }
  return kept
}

/**
 * The owner's Telegram chats they may send the assistant into a meeting from, comma-separated. Only private
 * chats: a Telegram user's chat ID is a positive number, a group's negative, and anyone in a
 * group could ask. Anything else is left out, with a warning. None means the session only.
 */
export function telegramChats(raw: string, warn: (message: string) => void = console.warn): string[] {
  const chats: string[] = []
  for (const id of raw.split(',').map(t => t.trim()).filter(Boolean)) {
    if (/^[1-9]\d{0,19}$/.test(id)) chats.includes(id) || chats.push(id)
    else warn(`[join] ZOOM_JOIN_TELEGRAM_CHATS: "${id}" is not a private chat's ID, so it is left out`)
  }
  return chats
}

/**
 * A cap from .env: a positive number (a whole one when `whole`), at most `max`. Anything else gets the
 * default, with a warning, so a typo never turns a cap off.
 */
export function cap(
  name: string,
  raw: string,
  fallback: number,
  opts: { max?: number; whole?: boolean } = {},
  warn: (message: string) => void = console.warn,
): number {
  if (!raw.trim()) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0 || (opts.whole && !Number.isInteger(value))) {
    warn(`[config] ${name}=${raw} is not a positive ${opts.whole ? 'whole number' : 'number'}, so the default ${fallback} is used`)
    return fallback
  }
  if (opts.max !== undefined && value > opts.max) {
    warn(`[config] ${name}=${raw} is more than ${opts.max}, so ${opts.max} is used`)
    return opts.max
  }
  return value
}

/**
 * Settings an older install may still have in .env that do nothing now: a warning for each, which the service
 * says once at start.
 */
export function retiredSettings(env: NodeJS.ProcessEnv): string[] {
  const warnings: string[] = []
  if (env.CONTROL_PORT?.trim()) {
    warnings.push(
      '[config] CONTROL_PORT does nothing now: npm run join and the Claude Code channel reach the service through its ' +
        'control socket (CONTROL_SOCKET, control.sock in the data folder unless set). Remove CONTROL_PORT from .env.',
    )
  }
  if (env.ALEX_MODEL?.trim() && !env.AGENT_MODEL?.trim()) {
    warnings.push('[config] ALEX_MODEL is now called AGENT_MODEL. It still works for now: rename it in .env.')
  }
  return warnings
}

/** The regions Recall runs in. A Recall API key works in its own region only, so there is no default. */
export const RECALL_REGIONS = ['us-east-1', 'us-west-2', 'eu-central-1', 'ap-northeast-1'] as const

/** Why RECALL_REGION can't be used, or '' when it can. */
export function recallRegionProblem(region: string): string {
  const regions = `${RECALL_REGIONS.slice(0, -1).join(', ')} or ${RECALL_REGIONS.at(-1)}`
  if (!region) return `RECALL_REGION is not set. Set it in .env to the region of your Recall account (${regions}): its API key works there only.`
  if (!(RECALL_REGIONS as readonly string[]).includes(region)) return `RECALL_REGION is "${region}", which is not a Recall region: use ${regions}.`
  return ''
}

// Addresses the meeting bot, on the internet, can't reach: private, shared (CGNAT) and link-local IPv4 ranges, IPv6
// unique-local and link-local ranges, and names only a local network resolves.
const PRIVATE_IPV4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/
const PRIVATE_IPV6 = /^\[(f[cd]|fe[89ab])[0-9a-f]*:/i
const LOCAL_NAMES = /\.(local|internal|lan|home\.arpa)$/i

/**
 * Why PUBLIC_URL can't be the bot page's address, or '' when it can. Recall's bot loads the page from the internet,
 * so it has to be the tunnel's https address, with nothing after it (the page is <address>/agent): with anything
 * else the bot joins the meeting, posts the chat notice, and stays there silent until the page wait runs out
 * (15 minutes) or it is asked to leave. A name that resolves to a private address can't be told from here: the curl
 * of <address>/health from outside your network shows that.
 */
export function publicUrlProblem(url: string): string {
  const example = 'such as https://assistant.example.com'
  if (!url) return `PUBLIC_URL is not set. Set it in .env to your tunnel's https address (${example}).`
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return `PUBLIC_URL is "${url}", which is not an address. Set it to your tunnel's https address (${example}).`
  }
  if (parsed.protocol !== 'https:') return `PUBLIC_URL is "${url}": it has to be your tunnel's https address (${example}), since the meeting bot loads its page from it.`
  if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
    return `PUBLIC_URL is "${url}": give only your tunnel's address, with no path, ?query or #part (${example}). The bot's page is that address followed by /agent.`
  }
  const host = parsed.hostname.replace(/\.$/, '')
  if (/^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1?\]|\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\])$/i.test(host) || host.endsWith('.localhost')) {
    return `PUBLIC_URL is "${url}", this computer's own address, which the meeting bot can't reach: set it to your tunnel's https address (${example}).`
  }
  if (PRIVATE_IPV4.test(host) || PRIVATE_IPV6.test(host) || LOCAL_NAMES.test(host)) {
    return `PUBLIC_URL is "${url}", an address on a private network, which the meeting bot on the internet can't reach: set it to your tunnel's https address (${example}).`
  }
  return ''
}

/** The name the install script gives the installed service (launchd label, systemd unit), unless SERVICE_LABEL says another. */
export const DEFAULT_SERVICE_LABEL = 'local.agent-voice'

// AGENT_MODEL, or ALEX_MODEL, its first name, which still works.
const model = optional('AGENT_MODEL') || optional('ALEX_MODEL', 'claude-sonnet-5-5')
// ALEX_DATA_DIR: the tests point it at a folder of their own, so they never touch real transcripts.
const dataDir = optional('ALEX_DATA_DIR') || path.join(ROOT, 'data')

export const config = {
  // The public listener: the tunnel points here, and it serves only what the meeting bot needs. It binds to
  // HOST, this machine only unless set, since the tunnel connects from here.
  port: Number(optional('PORT', '8787')),
  host: optional('HOST', '127.0.0.1'),
  // The control listener: /api/join (npm run join), /bridge (the Claude Code channel) and the detailed /health. A
  // Unix socket in the data folder, which only you can open, unless CONTROL_SOCKET names another path (a relative
  // one is taken from this folder, so the service, the join CLI and the channel all find the same one).
  controlSocket: pathSetting(optional('CONTROL_SOCKET') || path.join(dataDir, 'control.sock')),
  // Cost caps: how many meetings the assistant is in at once, and how long it stays in one (a day at most).
  maxMeetings: cap('MAX_MEETINGS', optional('MAX_MEETINGS'), 3, { whole: true }),
  maxMeetingMinutes: cap('MAX_MEETING_MINUTES', optional('MAX_MEETING_MINUTES'), 180, { max: 1440 }),
  // Empty unless set: there is no address that would work by default (see publicUrlProblem).
  publicUrl: optional('PUBLIC_URL').replace(/\/+$/, ''),
  agentPageToken: optional('AGENT_PAGE_TOKEN'),
  model,
  // The model that writes the minutes once a meeting is over: the same as the spoken answers' unless set.
  minutesModel: optional('MINUTES_MODEL', model),
  // AGENT_BOT_NAME (or the older ALEX_BOT_NAME), else made from the name: see src/identity.ts.
  botName: identity.botName,
  // No default: the service refuses to start until it is one of RECALL_REGIONS (recallRegionProblem).
  recallRegion: optional('RECALL_REGION'),
  // How long transcripts and minutes are kept.
  retentionDays: Number(optional('TRANSCRIPT_RETENTION_DAYS', '30')),
  deepgramKeyterms: keyterms(optional('DEEPGRAM_KEYTERMS')),
  // ElevenLabs' zero retention mode (enterprise accounts only): the assistant's speech is not kept in its history.
  elevenLabsZeroRetention: optional('ELEVENLABS_ZERO_RETENTION').toLowerCase() === 'true',
  joinTelegramChats: telegramChats(optional('ZOOM_JOIN_TELEGRAM_CHATS')),
  dataDir,
  // A bot page of your own, served at /agent instead of public/agent.html (src/pages.ts says what it must do), or ''.
  agentPageFile: optional('AGENT_PAGE_FILE') && pathSetting(optional('AGENT_PAGE_FILE')),
  // What scripts/install-service.sh names the installed service: the service only says it, to say how to stop it.
  serviceLabel: optional('SERVICE_LABEL', DEFAULT_SERVICE_LABEL),
}
