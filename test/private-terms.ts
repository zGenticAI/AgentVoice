// What test/private-terms.test.ts looks for in the tree, and where it looks.
//
// GENERIC_TERMS are always checked. They say nothing about anyone: a macOS home folder, a link into someone's
// claude.ai account, and an email address (except at the example domains documentation uses).
//
// Your private terms (your name, company, hostnames, accounts: whatever must never be published) are never in this
// repository, since a list of them would publish them. Keep them in a file of your own: PRIVATE_TERMS_FILE names it
// (a leading "~" is your home folder, a relative path is from the repository's root folder), else private-terms.txt
// in the repository's root folder, which .gitignore keeps out of the repository. A list in a file git would commit
// fails the check. The format:
// - one term per line; blank lines and lines starting with "#" are left out;
// - a plain term matches in any case, as a whole word: "Zorblax" catches "zorblax's" but not "Zorblaxes" or
//   "zorblax_prod", and a space in a term matches any run of spaces, a line break included;
// - a line written /like this/ is a regular expression, matched in any case, with Unicode escapes such as \p{L}:
//   /zorb\w*/ catches "Zorblaxes" too. It takes no flags (/zorb/i is an error), so a path is written with its
//   slashes escaped: /\/srv\/zorb/;
// - a line starting with "!" is a whole line that may stay, such as a copyright line naming your company: a line of a
//   file that is exactly that text, case included (spaces at either end and runs of spaces aside), is not checked for
//   your terms (the always-on patterns still apply). Every other line still is, so with "/zorblax/" and
//   "!Copyright 2026 Zorblax Ltd", that copyright line passes, but "Zorblax Ltd's pricing" and "Copyright 2026
//   Zorblax Ltd, London" don't.
// With no list, the check of your terms is skipped, with a note saying how to add one.
//
// What is checked: every file git would commit (tracked, or new and not ignored), and its name; a symbolic link's
// target; what the index holds for a file when it differs from the work tree, or when the file is gone from the work
// tree (that is what a commit takes); a UTF-16 file with a byte order mark as text; and in any other file with a NUL
// byte (a binary, or UTF-16 without a byte order mark), the runs of six or more readable characters in it, as ASCII,
// UTF-8 or UTF-16 in either byte order, the way strings(1) finds them. Each line is compared in Unicode's composed
// form, with soft hyphens, zero-width and other invisible characters taken out (and, separately, read as spaces), and
// with its \uXXXX escapes (as JSON writes them) decoded. A name wrapped across two lines of plain text, a comment or
// a quote is found too.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, pathSetting } from '../src/env.ts'

export interface Term {
  /** The term as the list writes it. */
  readonly label: string
  readonly pattern: RegExp
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Characters that don't show: soft hyphens, zero-width and joining characters, direction marks and controls,
// invisible operators and variation selectors. Inside a term, they hide it without changing how it looks.
const INVISIBLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFE00-\uFE0F\uFEFF]/g

/** Text as the terms are looked for in it: in Unicode's composed form (NFC), without invisible characters. */
export const asChecked = (text: string) => text.normalize('NFC').replace(INVISIBLE, '')

/** The same, with each invisible character read as a space: one between two words must not join them. */
const spaced = (text: string) => text.normalize('NFC').replace(INVISIBLE, ' ')

/** \uXXXX escapes, as JSON writes them, decoded. */
const unescaped = (text: string) => text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))

/** A plain term as a whole word, in any case: no letter, digit or underscore right before or after it. */
function wholeWord(term: string): RegExp {
  const body = asChecked(term).split(/\s+/).map(escapeRegex).join('\\s+')
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, 'iu')
}

/** A line as an allowance compares it: without spaces at either end, and with each run of spaces as one space. */
const asAllowed = (line: string) => line.trim().replace(/\s+/g, ' ')

export interface TermList {
  readonly terms: Term[]
  /** The whole lines the "!" lines allow, as asAllowed() gives them. */
  readonly allowed: string[]
}

/**
 * A list's text. `source` names the list in the error for a regular expression that isn't one, one with flags, or an
 * empty "!".
 */
export function parseList(text: string, source: string): TermList {
  const terms: Term[] = []
  const allowed: string[] = []
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    if (line.startsWith('!')) {
      const keep = asAllowed(asChecked(line.slice(1)))
      if (!keep) throw new Error(`${source}:${i + 1}: "${line}" allows nothing: put the whole line that may stay after the "!".`)
      return allowed.push(keep)
    }
    const regex = /^\/(.+)\/([a-z]*)$/.exec(line)
    if (!regex) return terms.push({ label: line, pattern: wholeWord(line) })
    if (regex[2]) {
      throw new Error(
        `${source}:${i + 1}: "${line}" ends in "/${regex[2]}": a regular expression here takes no flags (every one is ` +
          'matched in any case), so write it as /.../, and a path with its slashes escaped, such as /\\/srv\\/zorb/.',
      )
    }
    try {
      terms.push({ label: line, pattern: new RegExp(regex[1].normalize('NFC'), 'iu') })
    } catch {
      throw new Error(`${source}:${i + 1}: "${line}" is not a valid regular expression (with Unicode escapes).`)
    }
  })
  return { terms, allowed }
}

/** The terms in a list's text, without what it allows. */
export function parseTermList(text: string, source: string): Term[] {
  return parseList(text, source).terms
}

/**
 * What the terms find in this line: the first match of each term that matches, in the line as asChecked() gives it,
 * with its invisible characters read as spaces, or with its \uXXXX escapes decoded. Nothing, when the whole line is
 * one the list allows.
 */
export function findTerms(line: string, terms: readonly Term[], allowed: readonly string[] = []): string[] {
  const text = asChecked(line)
  if (allowed.length && allowed.includes(asAllowed(text))) return []
  const readings = [...new Set([text, spaced(line), asChecked(unescaped(line))])]
  return terms.flatMap(term => {
    for (const reading of readings) {
      const hit = term.pattern.exec(reading)?.[0]
      if (hit) return [hit]
    }
    return []
  })
}

/** An email address, unless it is at a domain kept for examples (example.com, .example, .invalid, .test, .localhost). */
// The domain is in lower case, as addresses are written, and its last part is two or more letters, as every top-level
// domain is, so a version ("v1.0.0") and random bytes in a font or an archive ("o@5.1", "kJ@gD.kJ") don't count.
const EMAIL = /[\w.%+-]+@(?!(?:[\w-]+\.)*(?:example\.(?:com|org|net)|[\w-]+\.(?:example|invalid|test|localhost))(?![\w.-]))[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?![\w-])/

export const GENERIC_TERMS: readonly Term[] = Object.freeze([
  { label: 'a macOS home folder', pattern: /\/Users\/[^\s/]/ },
  { label: "a link into someone's claude.ai account", pattern: /claude\.ai\/(?:artifacts?|code|projects?|chats?|share|public)\// },
  { label: 'an email address', pattern: EMAIL },
])

/** Where your private list is: PRIVATE_TERMS_FILE when set, else private-terms.txt in the repository's root folder. */
export function privateTermsFile(env: Record<string, string | undefined> = process.env): { file: string; named: boolean } {
  const set = env.PRIVATE_TERMS_FILE?.trim()
  return set ? { file: pathSetting(set), named: true } : { file: path.join(ROOT, 'private-terms.txt'), named: false }
}

export interface PrivateList {
  readonly file: string
  /** The terms, or null when there is no list. */
  readonly terms: Term[] | null
  /** The whole lines the list allows ("!" lines). */
  readonly allowed: string[]
  /** Why a list that PRIVATE_TERMS_FILE names can't be used, or ''. */
  readonly problem: string
}

/**
 * Your private list. No PRIVATE_TERMS_FILE and no private-terms.txt is no list (the check is skipped); a
 * PRIVATE_TERMS_FILE that can't be read, or a list with a broken regular expression, is a problem (the check fails).
 * `fallback` stands in for private-terms.txt in the tests.
 */
export function loadPrivateTerms(env: Record<string, string | undefined> = process.env, fallback?: string): PrivateList {
  const where = privateTermsFile(env)
  const file = !where.named && fallback ? fallback : where.file
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' && !where.named) return { file, terms: null, allowed: [], problem: '' }
    const named = where.named ? `PRIVATE_TERMS_FILE names ${file}` : file
    return { file, terms: null, allowed: [], problem: `${named}, which can't be read (${code ?? (err as Error).message}).` }
  }
  try {
    return { file, ...parseList(text, file), problem: '' }
  } catch (err) {
    return { file, terms: null, allowed: [], problem: (err as Error).message }
  }
}

export const NO_LIST_NOTE =
  'no private terms list of your own: put your private terms, one per line (or /regex/), in private-terms.txt in the ' +
  "repository's root folder (git ignores it) or in a file outside the repository that PRIVATE_TERMS_FILE names (see " +
  'test/private-terms.ts)'

// git's output for a large tree can pass spawnSync's default 1 MiB.
const GIT_BUFFER = 256 * 1024 * 1024

type Env = NodeJS.ProcessEnv

/** Runs git in `root`, and throws, with git's words, when it fails. */
function git(root: string, env: Env, args: string[]): Buffer {
  const run = spawnSync('git', args, { cwd: root, env, maxBuffer: GIT_BUFFER })
  if (run.error) throw run.error
  if (run.status !== 0) throw new Error(`git ${args[0]} failed in ${root}: ${run.stderr.toString().trim()}`)
  return run.stdout
}

/**
 * Every file git would commit, as paths from `root`: the tracked ones (a file deleted from the work tree but still in
 * the index included, since a commit takes it) and any new file not ignored; symbolic links too. Null when git isn't
 * installed or `root` is not in a git work tree. Throws for any other git failure (a "dubious ownership" refusal, say),
 * so the check fails rather than skips.
 */
export function trackedFiles(root = ROOT, env: Env = process.env): string[] | null {
  const run = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, env, encoding: 'utf8', maxBuffer: GIT_BUFFER })
  if (run.error) {
    if ((run.error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw run.error
  }
  if (run.status !== 0) {
    if (/not a git repository/i.test(run.stderr)) return null
    throw new Error(`git ls-files failed in ${root}: ${run.stderr.trim()}`)
  }
  return [...new Set(run.stdout.split('\0').filter(Boolean))].filter(file => {
    try {
      const stat = fs.lstatSync(path.join(root, file))
      return stat.isFile() || stat.isSymbolicLink()
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return true // gone from the work tree, but in the index: a commit takes it
      throw err
    }
  })
}

/** The tracked files whose work-tree copy differs from what the index holds (and so from what a commit takes). */
export function unstagedChanges(root = ROOT, env: Env = process.env): Set<string> {
  return new Set(git(root, env, ['diff', '--relative', '--name-only', '-z']).toString('utf8').split('\0').filter(Boolean))
}

/** What the index holds for each file, by path: the object a commit takes. */
export function stagedObjects(root = ROOT, env: Env = process.env): Map<string, string> {
  const objects = new Map<string, string>()
  for (const entry of git(root, env, ['ls-files', '-s', '-z']).toString('utf8').split('\0')) {
    const match = /^\d+ ([0-9a-f]+) \d\t(.+)$/s.exec(entry)
    if (match) objects.set(match[2], match[1])
  }
  return objects
}

// A run of readable characters in a binary, as strings(1) finds them: six or more, so that random bytes rarely make one.
const ASCII_RUN = /[\t\x20-\x7e]{6,}/g
// The same in text decoded as UTF-8 or UTF-16: Latin letters with accents too (but not U+FFFD, a byte that wasn't text).
const LATIN_RUN = /[\t\x20-\x7e\u00a0-\u024f]{6,}/g

/**
 * A file's bytes as text to check. UTF-8, unless there is a NUL in them. Then a byte order mark makes them UTF-16;
 * otherwise (a binary, or UTF-16 without one) they are the runs of readable characters in them, one per line, read as
 * ASCII, UTF-8, and UTF-16 in both byte orders from both even and odd offsets. `binary` says which it was.
 */
export function decode(bytes: Buffer): { text: string; binary: boolean } {
  if (!bytes.includes(0)) return { text: bytes.toString('utf8'), binary: false }
  const pairs = (from: number) => Buffer.from(bytes.subarray(from, from + ((bytes.length - from) & ~1)))
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: pairs(2).toString('utf16le'), binary: false }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: pairs(2).swap16().toString('utf16le'), binary: false }
  const runs = new Set<string>()
  for (const match of bytes.toString('latin1').matchAll(ASCII_RUN)) runs.add(match[0])
  const decoded = [bytes.toString('utf8'), pairs(0).toString('utf16le'), pairs(1).toString('utf16le'), pairs(0).swap16().toString('utf16le'), pairs(1).swap16().toString('utf16le')]
  for (const text of decoded) for (const match of text.matchAll(LATIN_RUN)) runs.add(match[0])
  return { text: [...runs].join('\n'), binary: true }
}

export interface FileText {
  /** '' for the work tree's copy, ' (staged)' for the index's; with ' (text in a binary)' for a binary's runs. */
  readonly where: string
  readonly text: string
}

/** What `fileTexts` and `offenders` need from git, gathered once. */
export interface GitState {
  readonly changed: ReadonlySet<string>
  readonly staged: ReadonlyMap<string, string>
  readonly env: Env
}

export const gitState = (root = ROOT, env: Env = process.env): GitState =>
  ({ changed: unstagedChanges(root, env), staged: stagedObjects(root, env), env })

/**
 * The texts a commit of this file would publish: the work tree's (a symbolic link's target, for a link), and the
 * index's when it differs from the work tree or the file is gone from it.
 */
export function fileTexts(file: string, root = ROOT, state: GitState = gitState(root)): FileText[] {
  const texts: FileText[] = []
  const add = (where: string, bytes: Buffer) => {
    const { text, binary } = decode(bytes)
    texts.push({ where: binary ? `${where} (text in a binary)` : where, text })
  }
  const full = path.join(root, file)
  let present = true
  try {
    const stat = fs.lstatSync(full)
    if (stat.isSymbolicLink()) texts.push({ where: '', text: fs.readlinkSync(full) })
    else add('', fs.readFileSync(full))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err
    present = false
  }
  const object = state.staged.get(file)
  if (object && (!present || state.changed.has(file))) add(' (staged)', git(root, state.env, ['cat-file', 'blob', object]))
  return texts
}

// What may open a line of a comment or a quote: indentation, then //, #, *, >, -- or ;. A name wrapped across two
// such lines is looked for without them.
const LINE_MARK = /^[ \t]*(?:\/\/+|#+|\*+|>+|--|;+)?[ \t]*/

/**
 * Where these terms are in these files: in a file's name ("file (its name) "match""), on a line ("file:line "match":
 * the line"), or across two lines, as a wrapped name is ("file:line "match": across lines"). Lines the list allows are
 * not checked for the terms. `env` is the environment git runs in.
 */
export function offenders(files: readonly string[], terms: readonly Term[], allowed: readonly string[] = [], root = ROOT, env: Env = process.env): string[] {
  const found: string[] = []
  const state = gitState(root, env)
  for (const file of files) {
    for (const hit of findTerms(file, terms)) found.push(`${file} (its name) "${hit}"`)
    for (const { where, text } of fileTexts(file, root, state)) {
      const lines = text.split('\n')
      lines.forEach((line, i) => {
        for (const hit of findTerms(line, terms, allowed)) found.push(`${file}${where}:${i + 1} "${hit}": ${line.trim().slice(0, 100)}`)
      })
      // A binary's runs are one per line, but two runs side by side are not one sentence wrapped.
      if (where.endsWith('(text in a binary)')) continue
      // Across lines: a match that still spans a line break once the spaces at its ends are trimmed. Lines counted as
      // the matches go, from the last one.
      const whole = lines.map(line => asChecked(line).replace(LINE_MARK, '')).join('\n')
      for (const term of terms) {
        let at = 0
        let line = 1
        for (const match of whole.matchAll(new RegExp(term.pattern.source, `${term.pattern.flags.replace('g', '')}g`))) {
          const hit = match[0].trim()
          if (!hit.includes('\n')) continue
          const start = match.index + match[0].indexOf(hit)
          for (; at < start; at++) if (whole[at] === '\n') line++
          found.push(`${file}${where}:${line} "${hit.replace(/\s+/g, ' ')}": across lines`)
        }
      }
    }
  }
  return found
}
