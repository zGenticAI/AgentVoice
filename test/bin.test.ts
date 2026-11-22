// bin/agentvoice.js, the command npm links into <prefix>/bin: it needs Node 24, runs the command from the folder it is
// run in (never a stale INIT_CWD), and has tsx keep compiled code in memory only. tsx's own cache is two folders in the
// temp folder: <tmp>/tsx-<uid>, whose entries it runs as they are, and <tmp>/tsx, an old one, which it deletes with
// everything in it; on Linux that is /tmp, which other users can write. The control for each runs the same command
// through tsx with its cache, as npm run does in a clone: a planted entry runs, and the old folder's files are deleted.
// Each case has a temp folder of its own as TMPDIR, so the cache the rest of the tests use is never touched.
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
  const env = (extra: Record<string, string | undefined> = {}) => envFor({ HOME: at.home, TMPDIR: tmpdir, TSX_DISABLE_CACHE: undefined, ...extra })
  /** agentvoice --version, run by the bin. */
  const version = (extra: Record<string, string | undefined> = {}) => {
    const run = agentvoice(at.pkg, ['--version'], env(extra), at.elsewhere)
    assert.equal(run.stderr, '')
    return run.stdout
  }
  /** The control: the same command run through tsx with its cache, as npm run runs a clone's commands. */
  const withCache = () => {
    const run = command(at.pkg, 'src/cli/agentvoice.ts', ['--version'], env(), at.elsewhere)
    assert.equal(run.stderr, '')
    return run.stdout
  }
  return { at, tmpdir, cache, version, withCache }
}

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

test("the bin never runs what is in tsx's cache folder, nor makes one", { timeout: 60_000 }, t => {
  const { tmpdir, cache, version, withCache } = setup(t)
  assert.equal(version(), '0.3.0\n')
  assert.deepEqual(fs.readdirSync(tmpdir), [], 'nothing made in the temp folder')
  // The control: run through tsx with its cache, the command fills tsx-<uid>, and a planted entry there runs.
  assert.equal(withCache(), '0.3.0\n')
  plant(cache)
  assert.equal(withCache(), 'PLANTED\n')
  // The bin: the same folder, a folder of yours (0700) as tsx makes it, and the planted entry is not run.
  fs.chmodSync(cache, 0o700)
  const entries = fs.readdirSync(cache).sort()
  assert.equal(version(), '0.3.0\n')
  assert.deepEqual(fs.readdirSync(cache).sort(), entries, 'and nothing written there')
})

test("tsx's old cache folder, <tmp>/tsx, which tsx deletes with what is in it: the bin leaves it as it is", { timeout: 60_000 }, t => {
  const { tmpdir, cache, version, withCache } = setup(t)
  const old = path.join(tmpdir, 'tsx')
  /** <tmp>/tsx as another user would make it (here, a folder anyone can write, with a file and a folder in it). */
  const make = () => {
    fs.rmSync(old, { recursive: true, force: true })
    fs.mkdirSync(path.join(old, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(old, 'a'), 'theirs\n')
    fs.writeFileSync(path.join(old, 'sub/b'), 'theirs\n')
    fs.chmodSync(old, 0o777)
    fs.chmodSync(path.join(old, 'sub'), 0o777)
    if (UID === 0) for (const p of [old, path.join(old, 'a'), path.join(old, 'sub'), path.join(old, 'sub/b')]) fs.chownSync(p, 65534, 65534)
  }
  // The control: a run through tsx that compiles (its cache is new) deletes it.
  make()
  assert.equal(withCache(), '0.3.0\n')
  assert.ok(!fs.existsSync(path.join(old, 'a')) && !fs.existsSync(path.join(old, 'sub')), `tsx deleted what was in ${old}`)
  // The bin, with the cache new as well: everything is still there.
  make()
  fs.rmSync(cache, { recursive: true, force: true })
  assert.equal(version(), '0.3.0\n')
  assert.equal(fs.readFileSync(path.join(old, 'a'), 'utf8'), 'theirs\n')
  assert.equal(fs.readFileSync(path.join(old, 'sub/b'), 'utf8'), 'theirs\n')
  assert.deepEqual(fs.readdirSync(tmpdir), ['tsx'], 'and nothing else made')
})

test('whatever TSX_DISABLE_CACHE was, the bin keeps compiled code in memory; a temp folder that is not there is no error', t => {
  const { tmpdir, version } = setup(t)
  for (const value of [undefined, '', '0', '1']) {
    assert.equal(version({ TSX_DISABLE_CACHE: value }), '0.3.0\n', String(value))
    assert.deepEqual(fs.readdirSync(tmpdir), [], `nothing made with TSX_DISABLE_CACHE=${value}`)
  }
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
