// The bot page (public/agent.html, or the page AGENT_PAGE_FILE names) is the assistant's camera and microphone in the
// meeting. It carries placeholders that the server fills in as it sends the page, HTML-escaped:
// - {{name}}: the assistant's name, in its text and in <body data-agent-name="{{name}}">, which its script reads;
// - {{owner}}: the owner's name ("{{owner}}'s AI assistant");
// - {{company}}: the owner's company, or nothing when none is set (the default page hides the empty label).
// A valid name is plain letters, but what the page shows must never depend on that.
//
// A page of your own (AGENT_PAGE_FILE) keeps the contract the default page keeps:
// - it imports startAgent from /agent.js and calls it, which streams the meeting's audio to the service and plays
//   the assistant's voice (the only other file the page may load from the service is /pcm-worklet.js, which
//   agent.js loads itself);
// - it says the assistant is an AI where the meeting can see it, with the word "AI" in its visible text, as the
//   consent line, the chat notice and the participant list do. That is not a setting.
// The service reads the page once, when it starts (loadAgentPage): it checks both, refuses a page that breaks either,
// and serves the copy it checked until it is restarted, so a page edited or moved later is never served unchecked.
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from './env.ts'
import type { Names } from './identity.ts'

/** The default bot page. */
export const DEFAULT_AGENT_PAGE = path.join(ROOT, 'public', 'agent.html')

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, c => ESCAPES[c])
}

/** The page with the assistant's name, the owner's and the company (or nothing) in it. */
export function fillPage(html: string, id: Pick<Names, 'name' | 'owner' | 'company'>): string {
  return html
    .replaceAll('{{name}}', escapeHtml(id.name))
    .replaceAll('{{owner}}', escapeHtml(id.owner))
    .replaceAll('{{company}}', escapeHtml(id.company))
}

/** What a viewer reads of a page: its markup without comments, scripts, styles and tags. */
function visibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
}

/**
 * Why a bot page (filled in) breaks the contract, or '' when it keeps it: it must import startAgent from /agent.js,
 * and say "AI" in its visible text. `source` names the page in the message.
 */
export function agentPageProblem(html: string, source: string): string {
  const scripts = [...html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map(m => m[1]).join('\n')
  if (!/\bimport\s*\{[^}]*\bstartAgent\b[^}]*\}\s*from\s*['"]\/agent\.js['"]/.test(scripts) || !/\bstartAgent\s*\(/.test(scripts)) {
    return `${source} doesn't import startAgent from /agent.js and call it, so the bot would join the meeting deaf and silent. ` +
      'A bot page must do both: see src/pages.ts, and public/agent.html for an example.'
  }
  if (!/(?<![\p{L}\p{N}])AI(?![\p{L}\p{N}])/u.test(visibleText(html))) {
    return `${source} doesn't say the assistant is an AI where the meeting can see it: put the word "AI" in its visible ` +
      'text (the default page says "<owner>\'s AI assistant"), as the consent line, the chat notice and the participant list do.'
  }
  return ''
}

/**
 * The bot page as the service serves it: the page AGENT_PAGE_FILE names (`file`), or public/agent.html when none is,
 * read once and filled in with these names. With a `problem` when it can't be read, or breaks the contract above,
 * and then no page: the service refuses to start. The problem names the file, for the start-up log only.
 */
export function loadAgentPage(file: string, id: Pick<Names, 'name' | 'owner' | 'company'>): { page: string; problem: string } {
  const source = file ? `AGENT_PAGE_FILE (${file})` : 'public/agent.html'
  let html: string
  try {
    html = fs.readFileSync(file || DEFAULT_AGENT_PAGE, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? (err as Error).message
    return { page: '', problem: file ? `AGENT_PAGE_FILE names ${file}, which can't be read (${code}).` : `${source} can't be read (${code}).` }
  }
  const page = fillPage(html, id)
  const problem = agentPageProblem(page, source)
  return problem ? { page: '', problem } : { page, problem: '' }
}

/** Why the page AGENT_PAGE_FILE names can't be the bot page, or '' when it can (or none is named): for npm run check. */
export function agentPageFileProblem(file: string, id: Pick<Names, 'name' | 'owner' | 'company'>): string {
  return file ? loadAgentPage(file, id).problem : ''
}
