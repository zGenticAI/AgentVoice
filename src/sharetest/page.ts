// The screen-share test's page (public/share-test.html): what the bot shares as its screen during npm run join
// --share-test. Read once, when the service starts, and served as it was then, like the bot page (src/pages.ts).
//
// Its script and style are inline, so the page is one file and nothing else on the public listener is needed for it:
// the Content-Security-Policy names each by its SHA-256, so the browser runs only those, and lets the page connect only
// to its own link on the public address. The page must stay silent and leave the camera page alone: no audio or video
// element, no AudioContext, no microphone or camera, no speech, and nothing of /agent.js or /audio. A page that breaks
// that is refused at start, and a meeting can't be joined with the share test until it is fixed.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from '../env.ts'
import { SHARE_TEST_LINK_PATH } from './protocol.ts'

export const SHARE_TEST_PAGE_FILE = path.join(ROOT, 'public', 'share-test.html')

/** What the page must never hold, in its markup or its script. */
const FORBIDDEN: readonly [RegExp, string][] = [
  [/<\s*(audio|video|iframe|object|embed)\b/i, 'an audio, video or embedded element'],
  [/\b(AudioContext|webkitAudioContext|OfflineAudioContext)\b/, 'an AudioContext'],
  [/\bgetUserMedia\b|\bgetDisplayMedia\b|\bmediaDevices\b/, 'a microphone, camera or screen request'],
  [/\bspeechSynthesis\b|\bAudio\s*\(/, 'speech or sound'],
  [/\/agent\.js\b|\/audio\b|\/pcm-worklet\.js\b/, "the camera page's script or audio"],
  [/\blocation\.(reload|assign|replace)\b|\blocation\.href\s*=|\bwindow\.open\b/, 'a reload or a navigation'],
]

/** Why the page can't be the share-test page, or '' when it can. */
export function shareTestPageProblem(html: string): string {
  const text = html.replace(/<!--[\s\S]*?-->/g, '')
  for (const [pattern, what] of FORBIDDEN) if (pattern.test(text)) return `public/share-test.html has ${what}, which the screen-share test page must never have.`
  const scripts = [...text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
  const styles = [...text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)]
  if (scripts.length !== 1 || /\bsrc\s*=/i.test(scripts[0][1]) || styles.length !== 1) {
    return 'public/share-test.html must have exactly one inline script and one inline style, and load nothing else.'
  }
  if (/\sstyle\s*=|\son[a-z]+\s*=/i.test(text.replace(/<script\b[\s\S]*?<\/script\s*>/gi, ''))) {
    return 'public/share-test.html must have no style or event attributes: its policy allows only its own script and style.'
  }
  return ''
}

const sha256 = (text: string) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`

export interface ShareTestPage {
  /** The page, or '' when it can't be served (then problem says why). */
  html: string
  /** The policy's script-src and style-src: the page's inline script and style, by their hashes. */
  scriptHash: string
  styleHash: string
  problem: string
}

/** The page as the service serves it, read once. Never throws: a page that can't be read or used comes with why. */
export function loadShareTestPage(file = SHARE_TEST_PAGE_FILE): ShareTestPage {
  let html: string
  try {
    html = fs.readFileSync(file, 'utf8')
  } catch (err) {
    return { html: '', scriptHash: '', styleHash: '', problem: `public/share-test.html can't be read (${(err as NodeJS.ErrnoException).code ?? 'error'}).` }
  }
  const problem = shareTestPageProblem(html)
  if (problem) return { html: '', scriptHash: '', styleHash: '', problem }
  const script = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/i.exec(html)![1]
  const style = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/i.exec(html)![1]
  return { html, scriptHash: sha256(script), styleHash: sha256(style), problem: '' }
}

/**
 * The headers the page goes out with. Its policy lets it run only its own script and style, and connect only to its
 * link on the public address (wss, the host filled in here, so it never depends on how 'self' matches a websocket).
 */
export function shareTestHeaders(page: ShareTestPage, publicHost: string): Record<string, string> {
  const csp = [
    "default-src 'none'",
    `script-src ${page.scriptHash}`,
    `style-src ${page.styleHash}`,
    `connect-src wss://${publicHost}${SHARE_TEST_LINK_PATH}`,
    "img-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
  return {
    'content-security-policy': csp,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  }
}
