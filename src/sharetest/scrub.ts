// What the screen-share test may print or write: never a key or token, the meeting link (nor its id or passcode), a
// share's address, the public address, the meeting's key or the bot's id. Everything the test prints, its report and
// its JSON go through scrub, whoever wrote the text: the service's answers included.
import { redact } from '../probe/flux-probe.ts'

/** The parts of a meeting link that would let someone in: its path's ids and its query's values (a passcode). */
function linkParts(meetingUrl: string): string[] {
  const url = URL.parse(meetingUrl)
  if (!url) return []
  const parts = url.pathname.split('/').filter(p => p.length >= 6)
  for (const value of url.searchParams.values()) if (value.length >= 4) parts.push(value)
  return parts
}

/** What the public address's host reads as. */
export const PUBLIC_HOST = '[public-host]'

export interface Scrubber {
  scrub(text: string): string
  /** The bot's id, once the join has given it: from then on it reads "the bot". */
  setBot(botId: string): void
}

export function scrubber(o: { secrets: string[]; meetingUrl: string; publicUrl: string }): Scrubber {
  let bot = ''
  const host = URL.parse(o.publicUrl)?.host ?? ''
  const link = linkParts(o.meetingUrl)
  return {
    setBot(botId: string) {
      bot = botId
    },
    scrub(text: string): string {
      let out = redact(text, o.secrets)
      if (o.meetingUrl) out = out.split(o.meetingUrl).join('[meeting link]')
      for (const part of link) out = out.split(part).join('[meeting link]')
      if (bot) out = out.split(`bot ${bot}`).join('the bot').split(bot).join('the bot')
      // The public address's host reads as such, so an Origin header that was the page's own says only that.
      if (host) out = out.split(host).join(PUBLIC_HOST)
      // Any address left but that bare origin (a share's, with its token; a link's): none belongs in the report.
      out = out.replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, found => {
        // Punctuation after an address is the sentence's, not the address's.
        const [, url, after] = /^(.*?)([.,;:!?)]*)$/s.exec(found)!
        return `${url.toLowerCase() === `https://${PUBLIC_HOST}` ? url : '[link]'}${after}`
      })
      // A meeting's key, or any other id of that shape.
      return out.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[id]')
    },
  }
}
