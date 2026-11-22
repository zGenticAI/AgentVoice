// How agentvoice setup writes a session folder: each file atomically (a temporary file, then a rename), only you can
// read them (0600, folders 0700), and a record of what it wrote, .agentvoice-setup.json, so that running it again
// refreshes its own files and never replaces one you changed (or one it didn't make) without your say: it stops, shows
// the difference, and with --replace-changed keeps yours as a backup first. Two files are yours to add to, and setup
// only merges into them: Claude Code's .claude/settings.local.json and OpenCode's .opencode/opencode.json.
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PACKAGE_NAME, isWithin, realPath, tildePath } from '../home.ts'

export type Client = 'claude-code' | 'codex' | 'opencode'
export const CLIENTS: readonly Client[] = ['claude-code', 'codex', 'opencode']
/** The record of what setup wrote, in the session folder. */
export const MANIFEST = '.agentvoice-setup.json'

/** A refusal: setup says why and stops (exit 1). */
export class SetupError extends Error {}

/** The way setup says to make a session folder, for this client. */
export const sessionExample = (client: Client): string => `mkdir -p ~/agentvoice-session && cd ~/agentvoice-session && agentvoice setup ${client}`

/** You, as setup checks who else could change a folder: your user id, and whether a group is yours alone. */
export interface You {
  uid: number
  /** Whether no one but you is in this group, so that its being able to write a folder lets no one else change it. */
  groupOfYours: (gid: number) => boolean
}

/** The user lists' lines for these getent arguments (group <gid>, passwd), or null where they can't be read. */
export type Getent = (args: string[]) => string | null

const runGetent: Getent = args => {
  const run = spawnSync('getent', args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
  return run.status === 0 ? run.stdout : null
}

/**
 * Whether a group is yours alone: your own primary group, named as you are (the group of your own that Debian, Ubuntu
 * and Fedora give each user, which is why their umask, 002, lets the group write what you make), with no one else in
 * it, as a member or as their own primary group. Read from the system's lists with getent; false wherever they can't
 * be read (macOS has no getent, and there every user's primary group is staff).
 */
export function groupOfYoursAlone(gid: number, user?: { username: string; gid: number }, getent: Getent = runGetent): boolean {
  let me = user
  if (!me) {
    try {
      me = os.userInfo()
    } catch {
      return false
    }
  }
  if (gid !== me.gid) return false
  const group = getent(['group', String(gid)])?.split('\n').filter(Boolean)
  if (group?.length !== 1) return false
  const [name, , id, members = ''] = group[0].split(':')
  if (name !== me.username || id !== String(gid)) return false
  if (members.split(',').some(member => member !== '' && member !== me.username)) return false
  const users = getent(['passwd'])
  if (users === null) return false
  return users
    .split('\n')
    .filter(Boolean)
    .every(line => {
      const [user, , , primary] = line.split(':')
      return primary !== String(gid) || user === me.username
    })
}

/**
 * You, for setup's checks: the uid given (else this process's), with groupOfYoursAlone asked once per group. null: no
 * uid (a platform without one), and nothing is checked of owners and modes.
 */
export function youAre(uid?: number | null, groupOfYours?: (gid: number) => boolean): You | null {
  const id = uid === undefined ? process.geteuid?.() : uid
  if (id === undefined || id === null) return null
  const asked = new Map<number, boolean>()
  const alone = groupOfYours ?? ((gid: number) => groupOfYoursAlone(gid))
  return {
    uid: id,
    groupOfYours: gid => {
      if (!asked.has(gid)) asked.set(gid, alone(gid))
      return asked.get(gid) as boolean
    },
  }
}

/**
 * Who else could change what is in a folder: its owner, if that isn't you or root; and anyone who may write it, if
 * that is others, or a group that isn't yours alone, without the sticky bit (/tmp has it: there only an entry's owner
 * may rename or delete it). null: no one.
 */
export function othersCanChange(stat: fs.Stats, you: You): 'owner' | 'write' | null {
  if (stat.uid !== you.uid && stat.uid !== 0) return 'owner'
  if ((stat.mode & 0o1000) !== 0) return null
  if ((stat.mode & 0o002) !== 0) return 'write'
  return (stat.mode & 0o020) !== 0 && !you.groupOfYours(stat.gid) ? 'write' : null
}

/**
 * Why a folder others could change can't hold the session folder: who they are, and, for a folder of yours, the chmod
 * that makes it yours alone.
 */
export function othersRefusal(dir: string, stat: fs.Stats, you: You, who: 'owner' | 'write', homeDir: string = os.homedir()): string {
  if (who === 'owner') return `${tildePath(dir, homeDir)}, which belongs to another user`
  const mode = (stat.mode & 0o7777).toString(8)
  const fix = stat.uid === you.uid ? `; to make it yours alone, run chmod go-w ${JSON.stringify(dir)} and this again` : ''
  return `${tildePath(dir, homeDir)}, which its group or others can write to (its mode is ${mode}${fix})`
}

export interface Manifest {
  package: string
  version: string
  /** The AgentVoice folder this session folder is for. */
  home: string
  /** The channel's command, as the configs start it: [node, bin, 'channel']. */
  command: string[]
  /** Per client, the files setup owns there and the hash of what it wrote. */
  clients: Partial<Record<Client, { files: Record<string, string> }>>
}

/** A file setup writes: owned (written whole, while you haven't changed it) or merged (yours, which setup only adds to). */
export interface SetupFile {
  /** Its path in the session folder, with "/" between names. */
  rel: string
  content: string
  merged?: boolean
  /**
   * For an owned file: other forms of what is there that count as setup's own (the Codex agent with its shell switch
   * turned the other way, which setup carries over).
   */
  alsoOurs?: (current: string) => string[]
}

export const sha256 = (data: string | Buffer): string => `sha256:${crypto.createHash('sha256').update(data).digest('hex')}`

/** Whether two paths name the same folder: as given, or once links are resolved. */
export function sameFolder(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b) || realPath(a) === realPath(b)
}

/** The record in a session folder: null if there is none. Throws SetupError for one that can't be read. */
export function readManifest(folder: string): Manifest | null {
  const file = path.join(folder, MANIFEST)
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new SetupError(`${tildePath(file)} can't be read (${(err as NodeJS.ErrnoException).code}): fix or remove it, then run this again.`)
  }
  const manifest = parseManifest(text)
  if (!manifest) throw new SetupError(`${tildePath(file)} is not a record agentvoice setup wrote: fix or remove it, then run this again.`)
  return manifest
}

/** A record's text, checked for the shape setup writes; null if it isn't one. */
export function parseManifest(text: string): Manifest | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  const m = value as Partial<Manifest> | null
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return null
  if (m.package !== PACKAGE_NAME || typeof m.version !== 'string' || typeof m.home !== 'string' || !path.isAbsolute(m.home)) return null
  if (!Array.isArray(m.command) || !m.command.every(part => typeof part === 'string')) return null
  if (typeof m.clients !== 'object' || m.clients === null || Array.isArray(m.clients)) return null
  for (const [client, entry] of Object.entries(m.clients)) {
    if (!CLIENTS.includes(client as Client)) return null
    const files = (entry as { files?: unknown } | null)?.files
    if (typeof files !== 'object' || files === null || Array.isArray(files)) return null
    if (!Object.values(files).every(hash => typeof hash === 'string')) return null
  }
  return m as Manifest
}

export interface Make {
  /** You, for the check of each folder a new one is made in (null: none is checked, on a platform without user ids). */
  you?: You | null
  /** The folder itself must be made here: if it is there by now, something other than setup made it after the checks. */
  fresh?: boolean
  /** How setup says to make a session folder, for a refusal. */
  example?: string
}

/**
 * Makes a folder and any missing parent, each new one 0700 (whatever the umask); one that is there is left as it is.
 * Each is made only in a folder no one else can change, checked as it is made, and must be made here (mkdir fails if
 * it appears in between): so a missing folder another user makes after setup's checks, in /tmp say, is never used.
 */
export function makeFolder(dir: string, { you = youAre(), fresh = false, example }: Make = {}): void {
  const missing: string[] = []
  for (let at = path.resolve(dir); !fs.existsSync(at); at = path.dirname(at)) missing.unshift(at)
  const stop = (why: string) => new SetupError(`${why}${example ? ` Make the session folder where only you can change it, for example: ${example}` : ''}`)
  const appeared = (folder: string) =>
    stop(`${tildePath(folder)} was made while setup ran, after its checks, by something other than setup, so setup stopped: it takes only a folder it makes, or one that was there when it checked.`)
  if (fresh && !missing.length) throw appeared(dir)
  for (const folder of missing) {
    const parent = path.dirname(folder)
    if (you) {
      const stat = fs.lstatSync(parent, { throwIfNoEntry: false })
      if (!stat?.isDirectory()) throw stop(`${tildePath(parent)}, where setup was to make ${tildePath(folder)}, is not a folder now, so setup stopped.`)
      const who = othersCanChange(stat, you)
      if (who) throw stop(`Setup was to make ${tildePath(folder)} in ${othersRefusal(parent, stat, you, who)}, and stopped: they could put a folder of their own in its place.`)
    }
    try {
      fs.mkdirSync(folder, { mode: 0o700 })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw appeared(folder)
      throw err
    }
    fs.chmodSync(folder, 0o700)
  }
}

/** Writes a file whole or not at all: <file>.<pid>.tmp (0600), then a rename over it. Its folder is made 0700 if missing. */
export function writeAtomic(file: string, content: string | Buffer, you?: You | null): void {
  makeFolder(path.dirname(file), { you })
  const temp = `${file}.${process.pid}.tmp`
  fs.rmSync(temp, { force: true })
  try {
    fs.writeFileSync(temp, content, { flag: 'wx', mode: 0o600 })
    fs.chmodSync(temp, 0o600)
    fs.renameSync(temp, file)
  } catch (err) {
    fs.rmSync(temp, { force: true })
    throw err
  }
}

/** A JSON file of yours that setup merges into: its object, or undefined if it isn't there. Throws if it isn't plain JSON. */
export function readJsonObject(file: string, shown = file): Record<string, unknown> | undefined {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
  return parseJsonObject(text, shown)
}

/** The object in a JSON file's text; throws SetupError (naming the file as shown) if it isn't a plain JSON object. */
export function parseJsonObject(text: string, shown: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new SetupError(`${shown} is not plain JSON (it may have comments): fix or remove it, then run this again.`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SetupError(`${shown} is not a JSON object: fix or remove it, then run this again.`)
  }
  return value as Record<string, unknown>
}

/** What is at an owned path, against what setup would write there and what it wrote last. */
export type OwnedState = 'missing' | 'same' | 'ours' | 'changed'

export interface Planned extends SetupFile {
  state: OwnedState | 'merged'
  /** What is there now, if anything. */
  current?: string
}

/**
 * Each file setup would write, and what is there now: missing; the same as it would write; ours (what setup wrote last,
 * which it replaces); or changed (you changed it, or setup didn't write it), which setup never replaces unasked.
 */
export function plan(folder: string, files: readonly SetupFile[], recorded: Record<string, string> = {}): Planned[] {
  return files.map(file => {
    const at = path.join(folder, file.rel)
    let current: string | undefined
    try {
      current = fs.readFileSync(at, 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EISDIR') throw new SetupError(`${tildePath(at)} is a folder, where setup writes a file: move it away, then run this again.`)
      if (code !== 'ENOENT') throw err
    }
    if (file.merged) return { ...file, state: 'merged', current }
    if (current === undefined) return { ...file, state: 'missing' }
    if (current === file.content) return { ...file, state: 'same', current }
    const hash = recorded[file.rel]
    const forms = [current, ...(file.alsoOurs?.(current) ?? [])]
    if (hash !== undefined && forms.some(form => sha256(form) === hash)) return { ...file, state: 'ours', current }
    return { ...file, state: 'changed', current }
  })
}

/** A timestamp for a backup's name: YYYYMMDD-HHMMSS, local time. */
export function stamp(date: Date): string {
  const two = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`
}

/** Copies a file to <file>.before-setup-<stamp> (another number after it if that is taken), 0600, and returns that path. */
export function backUp(file: string, date: Date): string {
  const base = `${file}.before-setup-${stamp(date)}`
  for (let n = 1; ; n++) {
    const target = n === 1 ? base : `${base}-${n}`
    try {
      fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw err
    }
    fs.chmodSync(target, 0o600)
    return target
  }
}

/**
 * The lines that differ between two texts, as a unified diff with three lines around each change: what is there now
 * (yours) against what setup would write.
 */
export function unifiedDiff(before: string, after: string, beforeName: string, afterName: string): string {
  const a = before.split('\n')
  const b = after.split('\n')
  // The lines both start and end with are left out of the search, which is then over what differs only.
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const midA = a.slice(head, a.length - tail)
  const midB = b.slice(head, b.length - tail)
  type Op = { op: ' ' | '-' | '+'; text: string }
  const ops: Op[] = a.slice(0, head).map(text => ({ op: ' ', text }))
  if (midA.length * midB.length <= 4_000_000) {
    // The longest common subsequence of the middle lines, then a walk along it.
    const n = midA.length
    const m = midB.length
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        ops.push({ op: ' ', text: midA[i++] })
        j++
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) ops.push({ op: '-', text: midA[i++] })
      else ops.push({ op: '+', text: midB[j++] })
    }
    while (i < n) ops.push({ op: '-', text: midA[i++] })
    while (j < m) ops.push({ op: '+', text: midB[j++] })
  } else {
    // Too large to compare line by line: all of it, out and in.
    for (const text of midA) ops.push({ op: '-', text })
    for (const text of midB) ops.push({ op: '+', text })
  }
  for (const text of a.slice(a.length - tail)) ops.push({ op: ' ', text })

  const CONTEXT = 3
  const out = [`--- ${beforeName}`, `+++ ${afterName}`]
  const changed = ops.map((o, k) => (o.op === ' ' ? -1 : k)).filter(k => k >= 0)
  let k = 0
  while (k < changed.length) {
    // A hunk: changes no more than twice the context apart, with the context around them.
    let last = k
    while (last + 1 < changed.length && changed[last + 1] - changed[last] <= 2 * CONTEXT + 1) last++
    const from = Math.max(0, changed[k] - CONTEXT)
    const to = Math.min(ops.length, changed[last] + CONTEXT + 1)
    let lineA = 1
    let lineB = 1
    for (const o of ops.slice(0, from)) {
      if (o.op !== '+') lineA++
      if (o.op !== '-') lineB++
    }
    const hunk = ops.slice(from, to)
    const countA = hunk.filter(o => o.op !== '+').length
    const countB = hunk.filter(o => o.op !== '-').length
    out.push(`@@ -${countA ? lineA : lineA - 1},${countA} +${countB ? lineB : lineB - 1},${countB} @@`)
    for (const o of hunk) out.push(`${o.op}${o.text}`)
    k = last + 1
  }
  return out.join('\n')
}

/** What a record says that no longer matches this AgentVoice: why its folder needs setup again, or [] if nothing. */
export function staleReasons(
  manifest: Manifest,
  now: { version: string; home: string; node: string; bin: string },
  exists: (file: string) => boolean = fs.existsSync,
  homeDir: string = os.homedir(),
): string[] {
  const reasons: string[] = []
  if (manifest.version !== now.version) reasons.push(`it was set up by AgentVoice ${manifest.version}, and this is ${now.version}`)
  const [node, bin] = manifest.command
  if (node !== now.node) reasons.push(`its configs start the channel with ${node ?? 'no node'}, not ${now.node}`)
  else if (!exists(node)) reasons.push(`the node its configs start the channel with, ${node}, is no longer there`)
  if (bin !== now.bin) reasons.push(`its configs start ${bin ?? 'no command'}, not this AgentVoice's ${now.bin}`)
  if (!sameFolder(manifest.home, now.home)) reasons.push(`it is for the AgentVoice folder ${tildePath(manifest.home, homeDir)}, and this one is ${tildePath(now.home, homeDir)}`)
  return reasons
}

/** What a client's setup says to do with changes of yours, which it won't replace. */
const YOURS: Record<Client, string> = {
  'claude-code': 'Your own rules belong in .claude/settings.local.json, which setup only adds to.',
  codex:
    'Codex has no file of yours that setup merges into: after replacing .codex/config.toml, make your changes to it again ' +
    '(its backup has them).',
  opencode: 'Your own settings belong in .opencode/opencode.json, which setup only adds to.',
}

export interface Apply {
  folder: string
  /** Whether the folder is there already (else it is made, 0700). */
  exists: boolean
  client: Client
  files: readonly SetupFile[]
  /** The record of an earlier setup there, for this AgentVoice folder. */
  manifest: Manifest | null
  replaceChanged: boolean
  /** What the record says this setup is for: the AgentVoice folder, the channel's command, this version. */
  home: string
  command: string[]
  version: string
  /** The command that runs this setup again with --replace-changed, for the refusal to name. */
  again: string
  /** Makes the folder a Git repository of its own, once it is there; returns whether it made one. */
  makeRepo?: (folder: string) => boolean
  /** You, for the checks of each folder setup makes (youAre's, unless given; null: none). */
  you?: You | null
  now?: Date
  log?: (line: string) => void
}

/**
 * Writes a client's files into the session folder, and the record of them. Everything is checked first: a file of
 * yours at a path setup owns (changed since setup wrote it, or not written by setup) stops it, with what differs and
 * nothing written, unless replaceChanged, which keeps each such file as a backup before writing the package's.
 */
export function applySetup(a: Apply): { made: boolean; repo: boolean; backups: string[] } {
  const log = a.log ?? console.log
  const planned = plan(a.folder, a.files, a.manifest?.clients[a.client]?.files)
  for (const file of planned) {
    // A link in the folder that leads out of it (a .claude that is a link to ~/.claude) would have setup write there.
    const target = path.join(a.folder, file.rel)
    if (!isWithin(target, a.folder)) throw new SetupError(`${tildePath(target)} leads out of ${tildePath(a.folder)} (through a link): setup writes only inside the folder. Remove the link, then run this again.`)
  }
  const changed = planned.filter(file => file.state === 'changed')
  if (changed.length && !a.replaceChanged) {
    const diffs = changed.map(file => unifiedDiff(file.current ?? '', file.content, `${file.rel} (yours)`, `${file.rel} (agentvoice setup's)`))
    throw new SetupError(
      [
        `agentvoice setup ${a.client} wrote nothing: ${changed.length === 1 ? 'this file' : 'these files'} in ${tildePath(a.folder)} ` +
          `${changed.length === 1 ? 'is' : 'are'} not what setup wrote there last (you changed ${changed.length === 1 ? 'it' : 'them'}, or setup ` +
          "didn't make " + `${changed.length === 1 ? 'it' : 'them'}), and setup never replaces such a file unasked:`,
        '',
        ...diffs.flatMap(diff => [diff, '']),
        YOURS[a.client],
        `To replace ${changed.length === 1 ? 'it' : 'them'} with the package's, keeping yours as a backup (<file>.before-setup-<date>-<time>): ${a.again}`,
      ].join('\n'),
    )
  }
  const made = !a.exists
  const you = a.you === undefined ? youAre() : a.you
  // A folder that wasn't there at the checks is made here, with each missing one above it, each in a folder no one else
  // can change as it is made: one another user makes in between, in /tmp say, stops setup.
  if (made) makeFolder(a.folder, { you, fresh: true, example: sessionExample(a.client) })
  const repo = a.makeRepo?.(a.folder) ?? false
  const backups: string[] = []
  for (const file of changed) {
    const backup = backUp(path.join(a.folder, file.rel), a.now ?? new Date())
    backups.push(backup)
    log(`Kept your ${file.rel} as ${path.relative(a.folder, backup)}, and wrote the package's.`)
  }
  for (const file of planned) {
    if (file.state === 'same' || (file.state === 'merged' && file.current === file.content)) continue
    writeAtomic(path.join(a.folder, file.rel), file.content, you)
  }
  const owned = Object.fromEntries(planned.filter(file => !file.merged).map(file => [file.rel, sha256(file.content)]))
  const manifest: Manifest = {
    package: PACKAGE_NAME,
    version: a.version,
    home: a.home,
    command: a.command,
    clients: { ...a.manifest?.clients, [a.client]: { files: owned } },
  }
  writeAtomic(path.join(a.folder, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, you)
  return { made, repo, backups }
}
