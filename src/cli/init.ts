// agentvoice init: makes your AgentVoice folder (~/.agentvoice, or AGENTVOICE_HOME) from the package's examples, as a
// clone's README has you copy them: .env from .env.example, profile.md, the shared brief (data/brief.md) and briefs/.
// Only you can open the folder (0700), and only you can read .env and the brief (0600). It never overwrites a file: one
// that is already there is kept as it is (.env is made 0600 again, as the voice service does at every start). Installed
// from npm only: a clone is set up by its own files (its README).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cloneRefusal } from '../commands.ts'
import { INSTALL_MODE, OWNER_DIR, PACKAGE_DIR, isWithin, tildePath } from '../home.ts'

/** What init makes in the AgentVoice folder, in order: folders end in "/". */
export const INIT_ITEMS = ['.env', 'profile.md', 'data/brief.md', 'briefs/'] as const
export type InitItem = (typeof INIT_ITEMS)[number]

/** The example each file is made from, in the package's folder. */
const EXAMPLES: Record<Exclude<InitItem, 'briefs/'>, string> = {
  '.env': '.env.example',
  'profile.md': 'profile.example.md',
  'data/brief.md': 'brief.example.md',
}
// The folders, made in this order: the AgentVoice folder itself, then the two inside it.
const FOLDERS = ['', 'data', 'briefs'] as const

export interface InitResult {
  /** What was made, as INIT_ITEMS names it. */
  made: InitItem[]
  /** What was there already, and kept as it was. */
  kept: InitItem[]
}

/** Why init can't use a path: something is there that isn't what it would make (a file for a folder, or the reverse). */
function notA(file: string, what: 'folder' | 'file'): Error {
  return new Error(`${tildePath(file)} is there, and is not a ${what}: move it away, then run agentvoice init again.`)
}

/** A path's kind, links followed: 'missing' when nothing is there. */
function kind(file: string): 'folder' | 'file' | 'other' | 'missing' {
  const stat = fs.statSync(file, { throwIfNoEntry: false })
  return !stat ? 'missing' : stat.isDirectory() ? 'folder' : stat.isFile() ? 'file' : 'other'
}

/**
 * Makes the AgentVoice folder home from the examples in packageDir, never overwriting anything. Everything is checked
 * first, so a refusal (a file where a folder goes, or the reverse; a path inside the package) writes nothing.
 */
export function initHome({ home, packageDir }: { home: string; packageDir: string }): InitResult {
  const folders = FOLDERS.map(rel => path.join(home, rel))
  const files = Object.entries(EXAMPLES).map(([rel, example]) => ({ rel: rel as InitItem, dst: path.join(home, rel), src: path.join(packageDir, example) }))
  for (const target of [...folders, ...files.map(f => f.dst)]) {
    // npm replaces the package's folder on every upgrade, so nothing of the owner's is ever written there.
    if (isWithin(target, packageDir)) {
      throw new Error(`${target} is inside the installed package (${packageDir}), which npm replaces on every upgrade: your AgentVoice folder must be outside it.`)
    }
  }
  for (const folder of folders) if (!['folder', 'missing'].includes(kind(folder))) throw notA(folder, 'folder')
  for (const { dst } of files) if (!['file', 'missing'].includes(kind(dst))) throw notA(dst, 'file')
  // The examples are read before anything is made: a package without one is broken, and says so.
  const texts = files.map(({ src }) => fs.readFileSync(src))

  const made: InitItem[] = []
  const kept: InitItem[] = []
  const briefsThere = kind(path.join(home, 'briefs')) === 'folder'
  for (const folder of folders) {
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 })
    fs.chmodSync(folder, 0o700) // the mode applies only when a folder is made, and less any umask
  }
  files.forEach(({ rel, dst }, i) => {
    try {
      fs.writeFileSync(dst, texts[i], { flag: 'wx', mode: 0o600 })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      kept.push(rel)
      // .env holds every key: made private again, as the voice service does at every start (prepareOwnerDir).
      if (rel === '.env') fs.chmodSync(dst, 0o600)
      return
    }
    fs.chmodSync(dst, 0o600) // the mode given to a new file is less any umask
    made.push(rel)
  })
  ;(briefsThere ? kept : made).push('briefs/')
  const order = (list: InitItem[]) => INIT_ITEMS.filter(item => list.includes(item))
  return { made: order(made), kept: order(kept) }
}

const MADE_FROM: Record<InitItem, string> = {
  '.env': 'from .env.example (only you can read it)',
  'profile.md': 'from profile.example.md',
  'data/brief.md': 'from brief.example.md: the shared brief (only you can read it)',
  'briefs/': 'for the briefs of single meetings',
}
const KEPT_AS: Record<InitItem, string> = {
  '.env': 'your settings (only you can read it)',
  'profile.md': 'your profile',
  'data/brief.md': 'the shared brief',
  'briefs/': 'for the briefs of single meetings',
}

/** What init prints: what it made and kept, and what to do next. fromSetting: AGENTVOICE_HOME named the folder. */
export function initReport({ home, made, kept, fromSetting }: InitResult & { home: string; fromSetting: boolean }): string {
  const at = (rel: string) => tildePath(path.join(home, rel))
  const width = Math.max(...INIT_ITEMS.map(item => at(item).length)) + 3
  const lines = [`Your AgentVoice folder is ${tildePath(home)} (${fromSetting ? 'AGENTVOICE_HOME; ' : ''}only you can open it).`]
  for (const item of INIT_ITEMS) {
    const wasMade = made.includes(item)
    if (!wasMade && !kept.includes(item)) continue
    lines.push(`  ${wasMade ? 'made' : 'kept'}  ${at(item).padEnd(width)}${wasMade ? MADE_FROM[item] : KEPT_AS[item]}`)
  }
  lines.push(
    '(A file that was already there is listed as "kept", and left as it was.)',
    '',
    'Next:',
    `  1. In ${at('.env')}, set OWNER_NAME, the keys (ANTHROPIC_API_KEY, DEEPGRAM_API_KEY, ELEVENLABS_API_KEY with`,
    '     ELEVENLABS_VOICE_ID, RECALL_API_KEY with RECALL_REGION), AGENT_PAGE_TOKEN (openssl rand -hex 24) and PUBLIC_URL.',
    `  2. Make ${at('profile.md')} yours, and fill in the shared brief, ${at('data/brief.md')}: until then they`,
    '     are the examples.',
    '  3. agentvoice check',
    '  4. agentvoice start, or agentvoice service install to keep it running.',
    '  5. To link your coding session: make a new, empty folder for it, then run agentvoice setup claude-code (or codex,',
    '     or opencode) in it, for example: mkdir -p ~/agentvoice-session && cd ~/agentvoice-session && agentvoice setup claude-code',
  )
  if (fromSetting) {
    lines.push(
      'Keep AGENTVOICE_HOME set in your shell for agentvoice commands: agentvoice service install and agentvoice setup write ' +
        'it into the service and the client configs themselves.',
    )
  }
  return lines.join('\n')
}

/** Run as a command (agentvoice init), not imported by a test. */
function isEntryPoint(): boolean {
  try {
    return fs.realpathSync(process.argv[1] ?? '') === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  if (INSTALL_MODE === 'clone') {
    console.error(cloneRefusal(PACKAGE_DIR))
    process.exitCode = 1
  } else {
    try {
      const result = initHome({ home: OWNER_DIR, packageDir: PACKAGE_DIR })
      console.log(initReport({ ...result, home: OWNER_DIR, fromSetting: Boolean(process.env.AGENTVOICE_HOME?.trim()) }))
    } catch (err) {
      console.error((err as Error).message)
      process.exitCode = 1
    }
  }
}
