// Checks what npm would publish: exactly the files test/fixtures/package-files.txt lists, each tracked by git, none
// that must never ship (the owner's keys, data, decks, briefs, profile; the tests, scripts and workflows), and a
// package.json fit to publish. Development only: never shipped, and under test/ so npm run typecheck covers it.
//
//   npm run check-package                              npm pack --dry-run's list, with the npm on PATH
//   npm run check-package -- --pack-json <file>        that list from another npm (CI's npm 12 step)
//   npm run check-package -- --tarball <file>          a packed tarball, as it will be published: also, every file in it
//                                                      is HEAD's, byte for byte
//   ... --release                                      also: no tracked file differs from HEAD, HEAD is tagged
//                                                      v<version>, and (by hand, outside GitHub Actions) no packed file
//                                                      holds a term of your private list (PRIVATE_TERMS_FILE)
//
// prepublishOnly runs it with --release, for a publish from a folder. Exit 1 with every problem listed, 2 for a usage
// mistake.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import zlib from 'node:zlib'
import { PACKAGE_NAME } from '../../src/home.ts'
import { GENERIC_TERMS, PUBLIC_NAMES, decode, findTerms, loadPrivateTerms, textOffenders } from '../private-terms.ts'

/** The repository this file is in: the package that is checked. */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
/** The expected file list, one path a line, from the package's root. */
export const FILE_LIST = 'test/fixtures/package-files.txt'
export const REPOSITORY_URL = 'git+https://github.com/zGenticAI/AgentVoice.git'
export const USAGE = 'Usage: npm run check-package -- [--pack-json <file> | --tarball <file>] [--release]'
export const NO_LIST =
  'Give your private-terms list (PRIVATE_TERMS_FILE=<file>): npm test skips that check without one, a fresh clone ' +
  "never has one, and a published version can't be changed."

// git's output for a large tree can pass spawnSync's default 1 MiB.
const BUFFER = 256 * 1024 * 1024

export interface CheckOptions {
  /** The package's folder, a git work tree (the repository, unless a test gives a copy). */
  root?: string
  /** npm pack --dry-run --json's output, from another npm. */
  packJson?: string
  /** A packed tarball. */
  tarball?: string
  release?: boolean
  env?: NodeJS.ProcessEnv
}

export interface CheckResult {
  problems: string[]
  /** The packed files, as npm lists them. */
  files: string[]
  name?: string
  version?: string
}

/** npm pack --json's output, in either shape: npm 11 prints an array, npm 12 an object keyed by the package's name. */
export function packedFiles(json: string): string[] {
  const parsed: unknown = JSON.parse(json)
  const entry = (Array.isArray(parsed) ? parsed[0] : parsed && typeof parsed === 'object' ? Object.values(parsed)[0] : undefined) as { files?: { path?: unknown }[] } | undefined
  if (!entry || !Array.isArray(entry.files)) throw new Error("it isn't npm pack --json's output: no files in it")
  return entry.files.map(file => {
    if (typeof file.path !== 'string') throw new Error("it isn't npm pack --json's output: a file without a path")
    return file.path
  })
}

/**
 * The files in an npm tarball (a gzipped tar of package/<path>), by path from the package's root, with their bytes.
 * `odd` gets what a package shouldn't hold: entries outside package/, links and anything else that isn't a file or a
 * folder.
 */
export function readTarball(file: string, odd: string[] = []): Map<string, Buffer> {
  const data = zlib.gunzipSync(fs.readFileSync(file))
  const files = new Map<string, Buffer>()
  let at = 0
  let longName: string | null = null
  let paxPath: string | null = null
  while (at + 512 <= data.length) {
    const header = data.subarray(at, at + 512)
    if (header.every(byte => byte === 0)) break
    const field = (start: number, length: number) => {
      const bytes = header.subarray(start, start + length)
      const end = bytes.indexOf(0)
      return bytes.subarray(0, end < 0 ? length : end).toString('utf8')
    }
    const size = parseInt(field(124, 12).trim() || '0', 8)
    const type = String.fromCharCode(header[156])
    const body = data.subarray(at + 512, at + 512 + size)
    at += 512 + Math.ceil(size / 512) * 512
    if (type === 'x') {
      // A pax header: "<length> path=<value>\n" records, for the next entry.
      for (const record of body.toString('utf8').split('\n')) {
        const m = /^\d+ path=(.*)$/s.exec(record)
        if (m) paxPath = m[1]
      }
      continue
    }
    if (type === 'g') continue
    if (type === 'L') {
      longName = body.toString('utf8').replace(/\0[\s\S]*$/, '')
      continue
    }
    const prefix = field(345, 155)
    const name = longName ?? paxPath ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100))
    longName = paxPath = null
    if (type === '5') continue
    if (!name.startsWith('package/')) {
      odd.push(`${name}, outside package/`)
      continue
    }
    if (type === '0' || type === '\0' || type === '7') files.set(name.slice('package/'.length), Buffer.from(body))
    else odd.push(`${name.slice('package/'.length)}, ${type === '1' || type === '2' ? 'a link' : `an entry of type ${JSON.stringify(type)}`}`)
  }
  return files
}

/** Why this packed path must never be published, or null. */
export function neverShip(file: string): string | null {
  const parts = file.split('/')
  const base = parts.at(-1) ?? ''
  const folders = parts.slice(0, -1)
  if (base === '.env' || (base.startsWith('.env.') && file !== '.env.example')) return 'a settings file (.env)'
  for (const folder of ['data', 'decks', 'briefs']) if (folders.includes(folder)) return `something in a ${folder}/ folder`
  if (['local-token', 'control.sock', 'pending-bots.json'].includes(base)) return 'what the voice service keeps'
  if (/^profile(\..+)?\.md$/i.test(base) && file !== 'profile.example.md') return 'a profile'
  if (/\.(pdf|script\.md)$/i.test(base)) return 'a slide deck or its script'
  if (/\.(pem|key|p12|pfx)$/i.test(base)) return 'a key or certificate'
  if (/\.log$/i.test(base)) return 'a log'
  if (base === 'private-terms.txt') return 'a private-terms list'
  if (file === '.claude/settings.local.json' || file.startsWith('.claude/worktrees/')) return "Claude Code's own settings or worktrees"
  if (/^\.opencode\/opencode\.jsonc?$/.test(file)) return 'your own OpenCode config'
  if (file === '.codex/auth.json') return "Codex's sign-in"
  if (base === '.npmrc') return "npm's settings (a token, perhaps)"
  if (parts[0] === 'test' && file !== 'test/fixtures/name-corpus.json') return 'a test'
  if (parts[0] === 'scripts' || parts[0] === '.github') return "the clone's scripts or the workflows"
  if (/^public\/.*\.d\.ts$/.test(file)) return 'a type declaration for the pages'
  if (['tsconfig.json', '.nvmrc', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'package-lock.json'].includes(file)) return 'a file for development only'
  if (/\.tgz$/i.test(base)) return 'a packed tarball'
  return null
}

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** What is wrong with this package.json for publishing. */
export function packageJsonProblems(pkg: Record<string, unknown>): string[] {
  const problems: string[] = []
  const at = (value: unknown, key: string) => (value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined)
  if (pkg.name !== PACKAGE_NAME) problems.push(`package.json is named ${JSON.stringify(pkg.name)}, not ${PACKAGE_NAME}.`)
  if ('private' in pkg) problems.push('package.json has "private", which npm refuses to publish.')
  if (at(pkg.bin, 'agentvoice') !== 'bin/agentvoice.js') problems.push('package.json\'s bin.agentvoice is not "bin/agentvoice.js".')
  if (at(pkg.publishConfig, 'access') !== 'public') problems.push('package.json\'s publishConfig.access is not "public": a scoped package is published private unless it is.')
  if (at(pkg.publishConfig, 'provenance') !== undefined) problems.push("package.json sets publishConfig.provenance: the release workflow passes --provenance, and a publish by hand can't make it.")
  if (at(pkg.repository, 'url') !== REPOSITORY_URL) problems.push(`package.json's repository.url is ${JSON.stringify(at(pkg.repository, 'url'))}: npm's provenance check needs ${REPOSITORY_URL}.`)
  const deps = pkg.dependencies && typeof pkg.dependencies === 'object' ? (pkg.dependencies as Record<string, unknown>) : {}
  for (const [name, version] of Object.entries(deps)) {
    if (typeof version !== 'string' || !EXACT.test(version)) {
      problems.push(`package.json's dependency ${name} is ${JSON.stringify(version)}, not an exact version: an npm user's install has no lockfile, so it would get versions nobody tested.`)
    }
  }
  return problems
}

/** Runs git in root: whether it worked, its stdout and its stderr. */
function git(root: string, env: NodeJS.ProcessEnv, args: string[]): { ok: boolean; out: Buffer; err: string } {
  const run = spawnSync('git', args, { cwd: root, env, maxBuffer: BUFFER })
  if (run.error) return { ok: false, out: Buffer.alloc(0), err: run.error.message }
  return { ok: run.status === 0, out: run.stdout, err: run.stderr.toString().trim() }
}

/** Every check, from the input the options name. */
export function checkPackage(o: CheckOptions = {}): CheckResult {
  const root = o.root ?? PACKAGE_ROOT
  const env = o.env ?? process.env
  const problems: string[] = []
  let files: string[]
  let contents: Map<string, Buffer> | null = null
  let pkg: Record<string, unknown>
  try {
    if (o.tarball) {
      const odd: string[] = []
      contents = readTarball(o.tarball, odd)
      for (const entry of odd) problems.push(`The tarball holds ${entry}, which a package mustn't.`)
      files = [...contents.keys()]
      const json = contents.get('package.json')
      if (!json) return { problems: [...problems, 'The tarball has no package.json.'], files }
      pkg = JSON.parse(json.toString('utf8'))
    } else {
      let json: string
      if (o.packJson) json = fs.readFileSync(o.packJson, 'utf8')
      else {
        const run = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, env, encoding: 'utf8', maxBuffer: BUFFER })
        if (run.error || run.status !== 0) return { problems: [`npm pack --dry-run failed: ${run.error?.message ?? run.stderr.trim()}`], files: [] }
        json = run.stdout
      }
      files = packedFiles(json)
      pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    }
  } catch (err) {
    return { problems: [`${o.tarball ?? o.packJson ?? 'npm pack'} can't be read: ${(err as Error).message}`], files: [] }
  }
  files.sort()

  // 1. Exactly the expected files.
  const expected = fs.readFileSync(path.join(root, FILE_LIST), 'utf8').split('\n').map(line => line.trim()).filter(Boolean)
  const listed = new Set(expected)
  const packed = new Set(files)
  for (const file of files) if (!listed.has(file)) problems.push(`It packs ${file}, which ${FILE_LIST} doesn't list.`)
  for (const file of expected) if (!packed.has(file)) problems.push(`It doesn't pack ${file}, which ${FILE_LIST} lists.`)

  // 2. Each tracked by git: nothing untracked in a working folder can ship.
  const tracked = git(root, env, ['ls-files', '-z'])
  if (!tracked.ok) problems.push(`git ls-files failed, so it can't be checked that every packed file is tracked: ${tracked.err}`)
  else {
    const inGit = new Set(tracked.out.toString('utf8').split('\0').filter(Boolean))
    for (const file of files) if (!inGit.has(file)) problems.push(`It packs ${file}, which git doesn't track.`)
  }

  // 3. Nothing that must never ship.
  for (const file of files) {
    const why = neverShip(file)
    if (why) problems.push(`It packs ${file}: ${why}, which must never be published.`)
  }

  // 4. package.json.
  problems.push(...packageJsonProblems(pkg))

  // 5. A tarball is HEAD, and only HEAD.
  if (contents) {
    for (const [file, bytes] of contents) {
      const head = git(root, env, ['cat-file', 'blob', `HEAD:${file}`])
      if (!head.ok) {
        problems.push(`The tarball's ${file} is not in HEAD.`)
        continue
      }
      const same = file === 'package.json' ? sameJson(bytes, head.out) : bytes.equals(head.out)
      if (!same) problems.push(`The tarball's ${file} is not HEAD's.`)
    }
  }

  const version = typeof pkg.version === 'string' ? pkg.version : undefined
  if (o.release) {
    // 6. Released from a clean, tagged HEAD.
    const status = git(root, env, ['status', '--porcelain', '--untracked-files=no'])
    if (!status.ok) problems.push(`git status failed: ${status.err}`)
    else if (status.out.toString().trim()) problems.push(`Tracked files differ from HEAD:\n${status.out.toString().trimEnd()}`)
    const tag = git(root, env, ['describe', '--exact-match', '--tags', 'HEAD'])
    const name = tag.ok ? tag.out.toString().trim() : ''
    if (name !== `v${version}`) problems.push(`HEAD is ${name ? `tagged ${name}` : 'not tagged'}: a release of ${version} is made from the tag v${version}.`)

    // 7. By hand (outside GitHub Actions): your private terms, in every packed file.
    if (!env.GITHUB_ACTIONS) {
      const list = loadPrivateTerms(env, path.join(root, 'private-terms.txt'))
      if (list.problem) problems.push(list.problem)
      else if (!list.terms?.length) problems.push(NO_LIST)
      else {
        for (const file of files) {
          let bytes: Buffer
          try {
            bytes = contents?.get(file) ?? fs.readFileSync(path.join(root, file))
          } catch (err) {
            problems.push(`${file} can't be read for your private terms: ${(err as Error).message}`)
            continue
          }
          const text = { where: '', ...decode(bytes) }
          if (text.binary) text.where = ' (text in a binary)'
          const hits = [
            ...findTerms(file, list.terms, [], PUBLIC_NAMES).map(hit => `${file} (its name) "${hit}"`),
            ...textOffenders(file, text, list.terms, list.allowed, PUBLIC_NAMES),
            ...textOffenders(file, text, GENERIC_TERMS),
          ]
          for (const hit of hits) problems.push(`A packed file names a private term: ${hit}`)
        }
      }
    }
  }
  return { problems, files, name: typeof pkg.name === 'string' ? pkg.name : undefined, version }
}

function sameJson(a: Buffer, b: Buffer): boolean {
  try {
    return isDeepStrictEqual(JSON.parse(a.toString('utf8')), JSON.parse(b.toString('utf8')))
  } catch {
    return false
  }
}

/** The command line. Throws a message for one it can't take. */
export function parseArgs(argv: readonly string[]): CheckOptions {
  const o: CheckOptions = {}
  // npm run sets INIT_CWD to the folder it was run in, and runs this in the package's root.
  const from = process.env.INIT_CWD || process.cwd()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--release') o.release = true
    else if (arg === '--pack-json' || arg === '--tarball') {
      const value = argv[++i]
      if (value === undefined) throw new Error(`${arg} takes a file.`)
      if (o.packJson || o.tarball) throw new Error('One input: --pack-json or --tarball.')
      if (arg === '--pack-json') o.packJson = path.resolve(from, value)
      else o.tarball = path.resolve(from, value)
    } else throw new Error(`Unknown option: ${arg}.`)
  }
  return o
}

function isEntryPoint(): boolean {
  try {
    return fs.realpathSync(process.argv[1] ?? '') === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  let options: CheckOptions
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`${(err as Error).message}\n${USAGE}`)
    process.exit(2)
  }
  const { problems, files, name, version } = checkPackage(options)
  if (problems.length) {
    console.error(`The package check failed:\n${problems.map(p => `- ${p}`).join('\n')}`)
    process.exitCode = 1
  } else {
    const what = options.tarball ? path.basename(options.tarball) : options.packJson ? `the list in ${path.basename(options.packJson)}` : 'npm pack'
    const also = [
      options.tarball ? 'each as HEAD has it' : '',
      options.release ? `from HEAD tagged v${version}` : '',
      options.release && !process.env.GITHUB_ACTIONS ? 'with none of your private terms' : '',
    ].filter(Boolean)
    console.log(`${name} ${version} (${what}): the ${files.length} files ${FILE_LIST} lists, each tracked by git${also.length ? `, ${also.join(', ')}` : ''}.`)
  }
}
