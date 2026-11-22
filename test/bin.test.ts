// bin/agentvoice.js, the command npm links into <prefix>/bin: it needs Node 24, runs the command from the folder it is
// run in (never a stale INIT_CWD), and uses tsx's compile cache (<temp folder>/tsx-<uid>, whose entries tsx runs as they
// are) only when that folder is a real folder of yours that nobody else can write. A planted entry proves both that the
// cache is what runs and that the bin stops using it. Each case has a temp folder of its own as TMPDIR, so the cache
// the rest of the tests use is never touched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from '../src/config.ts'
import { agentvoice, command, envFor, installedPackage } from './layouts.ts'

type Ctx = { after: (fn: () => unknown) => void }

const UID = process.geteuid?.() ?? 0

function setup(t: Ctx) {
  const at = installedPackage(t, '0.3.0')
  const tmpdir = path.join(at.tmp, 'tsx-test')
  fs.mkdirSync(tmpdir)
  const cache = path.join(tmpdir, `tsx-${UID}`)
  const version = (extra: Record<string, string | undefined> = {}) => {
    const run = agentvoice(at.pkg, ['--version'], envFor({ HOME: at.home, TMPDIR: tmpdir, TSX_DISABLE_CACHE: undefined, ...extra }), at.elsewhere)
    assert.equal(run.stderr, '')
    return run.stdout
  }
  return { at, tmpdir, cache, version }
}

const mode = (file: string) => fs.statSync(file).mode & 0o777

/** Rewrites the cache entry tsx compiled the command from (the one that says "Unknown command") to print PLANTED. */
function plant(cache: string): void {
  const entries = fs.readdirSync(cache).filter(name => fs.readFileSync(path.join(cache, name), 'utf8').includes('Unknown command'))
  assert.ok(entries.length > 0, `the command's entry is in ${cache}: ${fs.readdirSync(cache).join(', ')}`)
  for (const name of entries) {
    const file = path.join(cache, name)
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(file, JSON.stringify({ ...entry, code: 'console.log("PLANTED")' }))
  }
}

test("the bin uses tsx's own cache folder, made 0700, and the cache is what runs: a planted entry runs", { timeout: 60_000 }, t => {
  const { cache, version } = setup(t)
  assert.equal(version(), '0.3.0\n')
  assert.ok(fs.lstatSync(cache).isDirectory(), 'tsx-<uid>, the folder tsx itself uses')
  assert.equal(mode(cache), 0o700)
  assert.ok(fs.readdirSync(cache).length > 0, 'tsx wrote its entries there')
  // The control: with the folder as the bin left it, what is in the cache runs.
  plant(cache)
  assert.equal(version(), 'PLANTED\n')
  // Yours and only too readable: made 0700, and used.
  fs.chmodSync(cache, 0o755)
  assert.equal(version(), 'PLANTED\n')
  assert.equal(mode(cache), 0o700)
})

test('a cache folder others can write, a link, or one that is not yours is not used: the command compiles without it', { timeout: 60_000 }, t => {
  const { tmpdir, cache, version } = setup(t)
  assert.equal(version(), '0.3.0\n')
  plant(cache)
  for (const loose of [0o777, 0o770, 0o722]) {
    fs.chmodSync(cache, loose)
    assert.equal(version(), '0.3.0\n', loose.toString(8))
    assert.equal(mode(cache), loose, 'left as it is, never made safe: an entry may be planted already')
  }
  fs.chmodSync(cache, 0o700)
  // A link to a folder holding the planted entry.
  const real = path.join(tmpdir, 'elsewhere-cache')
  fs.renameSync(cache, real)
  fs.symlinkSync(real, cache)
  assert.equal(version(), '0.3.0\n', 'a link')
  fs.unlinkSync(cache)
  fs.renameSync(real, cache)
  assert.equal(version(), 'PLANTED\n', 'the same folder, in place again')
  if (UID === 0) {
    // Another user's folder (only root can make one here).
    fs.chownSync(cache, 65534, 65534)
    assert.equal(version(), '0.3.0\n', "another user's folder")
    fs.chownSync(cache, 0, 0)
  }
  // A file in its place.
  fs.rmSync(cache, { recursive: true })
  fs.writeFileSync(cache, '')
  assert.equal(version(), '0.3.0\n', 'a file')
})

test('TSX_DISABLE_CACHE already set, or a temp folder that is not there, is no cache at all, and no error', t => {
  const { tmpdir, cache, version } = setup(t)
  assert.equal(version({ TSX_DISABLE_CACHE: '1' }), '0.3.0\n')
  assert.ok(!fs.existsSync(cache), 'no folder made')
  assert.equal(version({ TMPDIR: path.join(tmpdir, 'gone') }), '0.3.0\n')
  assert.ok(!fs.existsSync(path.join(tmpdir, 'gone')))
  assert.deepEqual(fs.readdirSync(tmpdir), [])
})

test('the bin needs Node 24, and says so on stderr', t => {
  const { at, tmpdir } = setup(t)
  const old = 'data:text/javascript,Object.defineProperty(process,"version",{value:"v22.11.0"});Object.defineProperty(process,"versions",{value:{...process.versions,node:"22.11.0"}})'
  const run = spawnSync(process.execPath, ['--import', old, path.join(at.pkg, 'bin/agentvoice.js'), '--version'], { env: envFor({ HOME: at.home, TMPDIR: tmpdir }), cwd: at.elsewhere, encoding: 'utf8', timeout: 60_000 })
  assert.equal(run.status, 1)
  assert.equal(run.stdout, '')
  assert.equal(run.stderr, 'AgentVoice needs Node.js 24 or later; this is Node v22.11.0.\n')
  assert.deepEqual(fs.readdirSync(tmpdir), [], 'and does nothing else')
})

test("package.json names it as the agentvoice command, and git keeps it executable", () => {
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).bin, { agentvoice: 'bin/agentvoice.js' })
  const staged = spawnSync('git', ['ls-files', '--stage', 'bin/agentvoice.js'], { cwd: ROOT, encoding: 'utf8' })
  if (staged.status === 0 && staged.stdout) assert.match(staged.stdout, /^100755 /)
  assert.match(fs.readFileSync(path.join(ROOT, 'bin/agentvoice.js'), 'utf8'), /^#!\/usr\/bin\/env node\n/)
})

test('the link npm makes in <prefix>/bin runs it from your PATH, from any folder', t => {
  const { at, tmpdir } = setup(t)
  const env = envFor({ HOME: at.home, TMPDIR: tmpdir, PATH: `${at.binDir}:${path.dirname(process.execPath)}:${process.env.PATH}` })
  const run = spawnSync('agentvoice', ['--version'], { env, cwd: at.elsewhere, encoding: 'utf8', timeout: 60_000 })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout, '0.3.0\n')
  assert.ok(fs.statSync(path.join(at.pkg, 'bin/agentvoice.js')).mode & 0o100, 'the bin is executable')
})

test('a file given to a command is found from the folder it is run in, whatever INIT_CWD it inherits', { timeout: 60_000 }, t => {
  const { at, tmpdir } = setup(t)
  const stale = path.join(at.tmp, 'stale')
  fs.mkdirSync(stale)
  fs.writeFileSync(path.join(at.elsewhere, 'talk.script.md'), '# Not a script\n')
  const env = envFor({ HOME: at.home, TMPDIR: tmpdir, INIT_CWD: stale })
  // The control: run as npm run would, the slides command takes INIT_CWD's folder (here, the stale one).
  const asNpm = command(at.pkg, 'src/cli/slides.ts', ['check', 'talk.script.md'], env, at.elsewhere)
  assert.match(asNpm.stderr, /talk\.script\.md was not found\./)
  const run = agentvoice(at.pkg, ['slides', 'check', 'talk.script.md'], env, at.elsewhere)
  assert.doesNotMatch(run.stdout + run.stderr, /was not found/, run.stdout + run.stderr)
  assert.match(run.stderr, /line 1: the script must start with its front matter/, 'it read the file in this folder')
})
