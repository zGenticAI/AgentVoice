// The slides page (public/slides.html and public/slides.js): what the bot shares as its screen while the assistant
// presents. Read once, when the service starts, filled in with the assistant's and the owner's names, checked, and
// served as it was then, like the bot page (src/pages.ts).
//
// The page must stay silent and leave the camera page alone: no audio or video element, no AudioContext, no microphone
// or camera, no speech, nothing of /agent.js or /audio, no animation frames, no storage, and never a reload or a
// navigation. Each of its frames says the assistant is an AI. A page that breaks any of that is refused at start: the
// routes then never serve it, and a presentation can't load.
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from '../env.ts'
import type { Names } from '../identity.ts'
import { fillPage } from '../pages.ts'
import type { SlidesPage } from './share.ts'

export const SLIDES_HTML_FILE = path.join(ROOT, 'public', 'slides.html')
export const SLIDES_SCRIPT_FILE = path.join(ROOT, 'public', 'slides.js')

/** What the page and its script must never hold. */
const FORBIDDEN: readonly [RegExp, string][] = [
  [/<\s*(audio|video|iframe|object|embed)\b/i, 'an audio, video or embedded element'],
  [/\b(AudioContext|webkitAudioContext|OfflineAudioContext)\b/, 'an AudioContext'],
  [/\bgetUserMedia\b|\bgetDisplayMedia\b|\bmediaDevices\b/, 'a microphone, camera or screen request'],
  [/\bspeechSynthesis\b|\bnew\s+Audio\b/, 'speech or sound'],
  [/\/agent\.js\b|['"`/]audio\b|\/pcm-worklet\.js\b/, "the camera page's script or audio"],
  [/\brequestAnimationFrame\b/, 'animation frames'],
  [/\b(localStorage|sessionStorage|indexedDB)\b|\bdocument\.cookie\b/, 'storage'],
  [/\blocation\.(reload|assign|replace)\b|\blocation\.href\s*=|\bwindow\.open\b|\bhistory\.(pushState|replaceState|go|back)\b/, 'a reload or a navigation'],
]

/** Script text without its comments, which may name what the page must not do. */
const withoutComments = (js: string) => js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')

/** What a viewer reads of an element's markup. */
const visible = (html: string) => html.replace(/<[^>]*>/g, ' ')

/** Why this page and script (the page filled in) can't be the slides page, or '' when they can. */
export function slidesPageProblem(html: string, script: string): string {
  const markup = html.replace(/<!--[\s\S]*?-->/g, '')
  const code = withoutComments(script)
  for (const [pattern, what] of FORBIDDEN) {
    if (pattern.test(markup) || pattern.test(code)) return `The slides page (public/slides.html or slides.js) has ${what}, which it must never have.`
  }
  const scripts = [...markup.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
  if (scripts.length !== 1 || !/\bsrc\s*=\s*"\/slides\.js"/.test(scripts[0][1]) || scripts[0][2].trim()) {
    return 'public/slides.html must load /slides.js and nothing else, with no inline script.'
  }
  if (/\son[a-z]+\s*=|\sstyle\s*=/i.test(markup.replace(/<script\b[\s\S]*?<\/script\s*>/gi, ''))) {
    return 'public/slides.html must have no event or style attributes.'
  }
  for (const id of ['starting', 'paused', 'ended']) {
    const frame = new RegExp(`<div class="frame(?: on)?" id="${id}">([\\s\\S]*?)</div>`).exec(markup)
    if (!frame) return `public/slides.html has no "${id}" frame.`
    if (!/(?<![\p{L}\p{N}])AI(?![\p{L}\p{N}])/u.test(visible(frame[1]))) return `The "${id}" frame of public/slides.html doesn't say the assistant is an AI.`
  }
  if (!/^<img id="a" alt="">$/m.test(markup) || !/^<img id="b" alt="">$/m.test(markup)) return 'public/slides.html must have its two slide images.'
  return ''
}

/** The page as the service serves it, read once. Never throws: a page that can't be read or used comes with why. */
export function loadSlidesPage(id: Pick<Names, 'name' | 'owner' | 'company'>, files = { html: SLIDES_HTML_FILE, script: SLIDES_SCRIPT_FILE }): SlidesPage {
  let html: string
  let script: string
  try {
    html = fillPage(fs.readFileSync(files.html, 'utf8'), id)
    script = fs.readFileSync(files.script, 'utf8')
  } catch (err) {
    return { html: '', script: '', problem: `The slides page can't be read (${(err as NodeJS.ErrnoException).code ?? 'error'}).` }
  }
  const problem = slidesPageProblem(html, script)
  return problem ? { html: '', script: '', problem } : { html, script, problem: '' }
}
