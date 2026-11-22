// Folders laid out as AgentVoice is found on a computer, in a temp folder, for the tests of the two modes
// (test/installed-mode.test.ts, test/clone-mode.test.ts, the agentvoice command's tests): an installed package
// (<tmp>/prefix/lib/node_modules/<the package name>, with the <tmp>/prefix/bin/agentvoice link, as npm install -g makes
// them) and a copy of the clone. Each holds what the package ships (bin/, src/, public/, the corpus, the templates,
// package.json), with node_modules linked to the repository's, and runs through the repository's tsx, as the bin does.
// Nothing here touches the repository's own .env or data/.
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT } from '../src/config.ts'
import { PACKAGE_NAME } from '../src/home.ts'

export const TSX = path.join(ROOT, 'node_modules/.bin/tsx')
// tsx's loader, for a command run as one process (node --import <it>), as test/service-stop.test.ts runs the service: the
// tsx command runs its script as a child of its own, which a SIGKILL to it would leave behind.
const TSX_LOADER = import.meta.resolve('tsx')
const tsx = (file: string, args: string[] = []) => [process.execPath, ['--import', TSX_LOADER, file, ...args]] as const
const TMP = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir()
const SHIPPED = ['bin', 'src', 'public', 'package.json', 'test/fixtures/name-corpus.json', '.env.example', 'profile.example.md', 'brief.example.md']

type Ctx = { after: (fn: () => unknown) => void }

export function tempDir(t: Ctx, prefix = 'av-layout-'): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(TMP, prefix)))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function copyPackage(into: string, version?: string): void {
  for (const item of SHIPPED) fs.cpSync(path.join(ROOT, item), path.join(into, item), { recursive: true })
  if (version) {
    const file = path.join(into, 'package.json')
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), version }, null, 2))
  }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(into, 'node_modules'))
}

export interface Installed {
  /** The temp folder everything is in. */
  tmp: string
  /** The installed package's folder. */
  pkg: string
  /** The prefix's bin folder, with the agentvoice link npm makes there (to the package's bin/agentvoice.js). */
  binDir: string
  /** HOME for the commands run here: its ~/.agentvoice is the default AgentVoice folder. */
  home: string
  /** A folder of no importance, to run the commands from. */
  elsewhere: string
}

/** An installed package, a home folder and a folder to run from, in a temp folder. version: written into its package.json. */
export function installedPackage(t: Ctx, version?: string): Installed {
  const tmp = tempDir(t, 'av-installed-')
  const pkg = path.join(tmp, 'prefix/lib/node_modules', PACKAGE_NAME)
  fs.mkdirSync(pkg, { recursive: true })
  copyPackage(pkg, version)
  const binDir = path.join(tmp, 'prefix/bin')
  fs.mkdirSync(binDir)
  fs.symlinkSync(path.join('../lib/node_modules', PACKAGE_NAME, 'bin/agentvoice.js'), path.join(binDir, 'agentvoice'))
  const home = path.join(tmp, 'home')
  const elsewhere = path.join(tmp, 'elsewhere')
  fs.mkdirSync(home)
  fs.mkdirSync(elsewhere)
  return { tmp, pkg, binDir, home, elsewhere }
}

/** A copy of the clone, as a source zip or a cp -r makes one (no .git), in a temp folder. */
export function cloneCopy(t: Ctx): { tmp: string; clone: string } {
  const tmp = tempDir(t, 'av-clone-')
  const clone = path.join(tmp, 'AgentVoice')
  fs.mkdirSync(clone)
  copyPackage(clone)
  return { tmp, clone }
}

/** Every file in a folder, with a hash of each. Links are not followed (readdir's recursive option would), so the link to node_modules is one entry. */
export function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const name = path.join(rel, entry.name)
      if (entry.isDirectory()) {
        files[name] = 'dir'
        walk(name)
      } else {
        files[name] = entry.isFile() ? crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex') : entry.isSymbolicLink() ? `link ${fs.readlinkSync(path.join(dir, name))}` : 'other'
      }
    }
  }
  walk('')
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)))
}

/**
 * The environment for a command run here: npm test's, without the settings that would point it at the test's own
 * folders, plus these (undefined removes one).
 */
export function envFor(extra: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string | undefined> = { ...process.env, ALEX_DATA_DIR: undefined, AGENTVOICE_HOME: undefined, PROFILE_FILE: undefined, CONTROL_SOCKET: undefined, ...extra }
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key]
  return env as Record<string, string>
}

// What a process of that package sees: run from outside the package, it imports the package's own modules.
const PROBE = `import path from 'node:path'
import { pathToFileURL } from 'node:url'
const [pkg, what] = process.argv.slice(2)
const load = (rel) => import(pathToFileURL(path.join(pkg, rel)).href)
const attempt = async (f) => { try { await f(); return 'ok' } catch (err) { return err.message } }
if (what === 'paths') {
  const env = await load('src/env.ts')
  const { config, required } = await load('src/config.ts')
  const { profileFile } = await load('src/profile.ts')
  const { CANVAS_MISSING, WORDS } = await load('src/commands.ts')
  const { readProfile } = await load('src/profile.ts')
  const { briefProblem } = await load('src/brief.ts')
  const { savedLifts } = await load('src/channel/push-opencode.ts')
  const saved = (resource) => savedLifts([{ id: 'psv_1', action: 'shell', resource }]).named
  console.log(JSON.stringify({
    mode: env.INSTALL_MODE, ownerDir: env.OWNER_DIR, packageDir: env.PACKAGE_DIR, root: env.ROOT, dataDir: config.dataDir,
    controlSocket: config.controlSocket, relative: env.pathSetting('briefs/acme.md'), profile: profileFile({}).file,
    probe: process.env.AV_PROBE ?? null, home: process.env.AGENTVOICE_HOME ?? null, homeInDotenv: env.HOME_SETTING.inDotenv,
    envFile: WORDS.envFile, join: WORDS.run('join'), missing: await attempt(() => required('AV_UNSET_SETTING')),
    canvas: CANVAS_MISSING, profileProblem: readProfile('/nonexistent-av/profile.md', true).problem, brief: briefProblem(''),
    lifts: { npm: saved('npm run slides *'), agentvoice: saved('agentvoice slides *') },
  }))
} else if (what === 'writers') {
  const { config } = await load('src/config.ts')
  const token = await load('src/local-token.ts')
  const socket = await load('src/control-socket.ts')
  const deck = await load('src/slides/deck.ts')
  console.log(JSON.stringify({
    dataDir: await attempt(() => token.prepareDataDir(config.dataDir)),
    token: await attempt(() => token.ensureLocalToken(config.dataDir)),
    decks: await attempt(() => deck.prepareDecksDir(deck.decksDir(config.dataDir))),
    socket: await attempt(() => socket.prepareControlSocket(config.controlSocket)),
  }))
}
`

/** Runs the probe for that package (what: 'paths' or 'writers'), from cwd, and returns what it printed, or its failure. */
export function probe(t: Ctx, pkg: string, what: 'paths' | 'writers', env: Record<string, string>, cwd: string) {
  const dir = tempDir(t, 'av-probe-')
  const file = path.join(dir, 'probe.mjs')
  fs.writeFileSync(file, PROBE)
  const [node, argv] = tsx(file, [pkg, what])
  const run = spawnSync(node, argv, { env, cwd, encoding: 'utf8', timeout: 60_000 })
  if (run.status !== 0) return { ok: false as const, status: run.status, stderr: run.stderr }
  return { ok: true as const, value: JSON.parse(run.stdout.trim().split('\n').at(-1) as string) }
}

/** Runs the package's agentvoice command, as its bin (node <pkg>/bin/agentvoice.js), to its end. */
export function agentvoice(pkg: string, args: string[], env: Record<string, string>, cwd: string, input?: string) {
  return spawnSync(process.execPath, [path.join(pkg, 'bin/agentvoice.js'), ...args], { env, cwd, input, encoding: 'utf8', timeout: 120_000 })
}

/** Runs one of the package's commands (a module under src/) through tsx, to its end. */
export function command(pkg: string, module: string, args: string[], env: Record<string, string>, cwd: string) {
  const [node, argv] = tsx(path.join(pkg, module), args)
  return spawnSync(node, argv, { env, cwd, encoding: 'utf8', timeout: 120_000 })
}

/** The voice service of that package, started from cwd; listening() waits for its banner. */
export function startService(t: Ctx, pkg: string, env: Record<string, string>, cwd: string) {
  const [node, argv] = tsx(path.join(pkg, 'src/server.ts'))
  const child = spawn(node, argv, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => child.kill('SIGKILL'))
  let log = ''
  child.stdout.on('data', c => (log += c))
  child.stderr.on('data', c => (log += c))
  const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)))
  const banner = /is listening\.[\s\S]*curl --unix-socket .*\/health/
  const listening = async () => {
    for (let i = 0; i < 400 && !banner.test(log) && child.exitCode === null; i++) await new Promise(r => setTimeout(r, 50))
    if (!banner.test(log)) throw new Error(`The service did not start:\n${log}`)
  }
  return { child, exited, listening, log: () => log }
}
