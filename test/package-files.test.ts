// What npm would publish (test/package/check-package.ts): the repository packs exactly test/fixtures/package-files.txt,
// and the check catches what must not ship, on a copy of the repository made into a git work tree of its own: a file
// git doesn't track in a packed folder, a changed "files", a tarball that isn't HEAD, and, for a release by hand, a
// private term in a packed file or no list to look for them. An owner's files in the folder are never packed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT } from '../src/config.ts'
import { PACKAGE_NAME } from '../src/home.ts'
import { FILE_LIST, NO_LIST, checkPackage, neverShip, packageJsonProblems, packedFiles, parseArgs, readTarball } from './package/check-package.ts'
import { PUBLIC_NAMES, trackedFiles } from './private-terms.ts'

type Ctx = { after: (fn: () => unknown) => void }

const NPM = spawnSync('npm', ['--version'], { encoding: 'utf8' })
const SKIP = NPM.error || !trackedFiles() ? 'needs npm and a git checkout' : false

// git for the copies only: none of the GIT_ variables a hook running this suite may have, no user or system config,
// and no repository above the temporary folder.
function gitEnv(base: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  return Object.assign(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: base })
}

/** A copy of the repository's tracked files, committed as a git work tree of its own. */
function copy(t: Ctx) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'av-package-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const root = path.join(base, 'AgentVoice')
  for (const file of trackedFiles() ?? []) {
    const from = path.join(ROOT, file)
    if (!fs.existsSync(from)) continue
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.cpSync(from, path.join(root, file), { verbatimSymlinks: true })
  }
  const env = gitEnv(base)
  const git = (...args: string[]) => {
    const run = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: root, env, encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    return run.stdout
  }
  git('init', '-q')
  git('add', '-A')
  git('commit', '-q', '-m', 'copy')
  const check = (o: Parameters<typeof checkPackage>[0] = {}) => checkPackage({ root, env: { ...env, PRIVATE_TERMS_FILE: '', GITHUB_ACTIONS: '' }, ...o })
  const pack = (into: string) => {
    fs.mkdirSync(into, { recursive: true })
    const run = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', into], { cwd: root, env, encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    const r = JSON.parse(run.stdout)
    return path.join(into, (Array.isArray(r) ? r[0] : Object.values(r)[0] as { filename: string }).filename)
  }
  return { base, root, env, git, check, pack }
}

test('the repository packs exactly the files test/fixtures/package-files.txt lists, each tracked, and package.json is fit to publish', { skip: SKIP, timeout: 120_000 }, () => {
  const { problems, files, name } = checkPackage()
  assert.deepEqual(problems, [])
  assert.equal(name, PACKAGE_NAME)
  assert.deepEqual(files, fs.readFileSync(path.join(ROOT, FILE_LIST), 'utf8').trim().split('\n'))
  // The rule the list follows: the tracked src/**/*.ts but the corpus recorder, the bin, the served pages, the corpus,
  // the client templates, the examples, the docs and the notices.
  const tracked = trackedFiles() ?? []
  const src = tracked.filter(file => /^src\/.*\.ts$/.test(file) && file !== 'src/cli/record-name-corpus.ts')
  assert.deepEqual(files.filter(file => file.startsWith('src/')), src.sort())
  assert.deepEqual(files.filter(file => file.startsWith('docs/')), tracked.filter(file => /^docs\/[^/]+\.md$/.test(file)).sort())
  assert.ok(!files.includes('src/cli/record-name-corpus.ts'))
  assert.ok(!files.some(file => file.startsWith('data/') || file.startsWith('scripts/')), 'no data/ (nothing to land in) and no install scripts')
  for (const file of files) assert.equal(neverShip(file), null, file)
})

test("an owner's files in the folder are never packed: keys, data, decks, briefs, profiles, logs, local configs", { skip: SKIP, timeout: 120_000 }, t => {
  const c = copy(t)
  const owner = [
    '.env', '.env.local', '.env.example.bak', 'data/local-token', 'data/brief.md', 'data/decks/d1/deck.pdf', 'data/transcripts/t.jsonl',
    'profile.md', 'profile.local.md', 'briefs/acme.md', 'decks/q3.pdf', 'q3.pdf', 'q3.script.md', 'docs/q3.script.md', 'src/.env',
    'src/cli/.env.local', 'src/data/decks/x.ts', 'src/server.key', '.codex/auth.json', '.claude/settings.local.json', '.opencode/opencode.json',
    'key.pem', 'x.log', 'private-terms.txt', '.npmrc', 'notes/secret.md', 'public/extra.html', 'test/fixtures/other.json',
  ]
  for (const file of owner) {
    fs.mkdirSync(path.dirname(path.join(c.root, file)), { recursive: true })
    fs.writeFileSync(path.join(c.root, file), 'not for publishing\n')
  }
  const { problems, files } = c.check()
  assert.deepEqual(problems, [])
  for (const file of owner) assert.ok(!files.includes(file), file)
})

test('a file git does not track, in a folder the package takes, fails the check: it would ship from a working folder', { skip: SKIP, timeout: 120_000 }, t => {
  const c = copy(t)
  fs.writeFileSync(path.join(c.root, 'docs/draft.md'), '# Draft\n')
  fs.writeFileSync(path.join(c.root, 'src/notes.local.ts'), 'export {}\n')
  const { problems } = c.check()
  assert.deepEqual(problems, [
    `It packs docs/draft.md, which ${FILE_LIST} doesn't list.`,
    `It packs src/notes.local.ts, which ${FILE_LIST} doesn't list.`,
    "It packs docs/draft.md, which git doesn't track.",
    "It packs src/notes.local.ts, which git doesn't track.",
  ])
})

test('a changed "files" fails the check: what it adds, what it drops, and what must never ship', { skip: SKIP, timeout: 120_000 }, t => {
  const c = copy(t)
  const file = path.join(c.root, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
  pkg.files = pkg.files.filter((entry: string) => entry !== '/NOTICE').concat('/scripts/install-service.sh', '/tsconfig.json')
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2))
  const { problems } = c.check()
  assert.deepEqual(problems, [
    `It packs scripts/install-service.sh, which ${FILE_LIST} doesn't list.`,
    `It packs tsconfig.json, which ${FILE_LIST} doesn't list.`,
    `It doesn't pack NOTICE, which ${FILE_LIST} lists.`,
    "It packs scripts/install-service.sh: the clone's scripts or the workflows, which must never be published.",
    'It packs tsconfig.json: a file for development only, which must never be published.',
  ])
})

test("package.json must be fit to publish: the name, no private, the bin, public access, the repository, exact dependencies", () => {
  const good = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.deepEqual(packageJsonProblems(good), [])
  assert.equal(good.name, PUBLIC_NAMES[0])
  assert.equal(good.repository.url, `git+https://github.com/${PUBLIC_NAMES[1]}.git`)
  const bad = {
    ...good,
    name: 'agent-voice',
    private: true,
    bin: { agentvoice: 'src/cli/agentvoice.ts' },
    publishConfig: { provenance: true },
    repository: { url: 'https://github.com/someone/fork' },
    dependencies: { ...good.dependencies, ws: '^8.22.0', tsx: 'latest', dotenv: '18.0.8' },
  }
  assert.deepEqual(packageJsonProblems(bad), [
    `package.json is named "agent-voice", not ${PACKAGE_NAME}.`,
    'package.json has "private", which npm refuses to publish.',
    'package.json\'s bin.agentvoice is not "bin/agentvoice.js".',
    'package.json\'s publishConfig.access is not "public": a scoped package is published private unless it is.',
    "package.json sets publishConfig.provenance: the release workflow passes --provenance, and a publish by hand can't make it.",
    `package.json's repository.url is "https://github.com/someone/fork": npm's provenance check needs git+https://github.com/${PUBLIC_NAMES[1]}.git.`,
    "package.json's dependency tsx is \"latest\", not an exact version: an npm user's install has no lockfile, so it would get versions nobody tested.",
    "package.json's dependency ws is \"^8.22.0\", not an exact version: an npm user's install has no lockfile, so it would get versions nobody tested.",
  ])
})

test("package.json's other fields for npm: a command for macOS and Linux on Node 24, public, with no install scripts and no library entry", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.deepEqual(pkg.os, ['darwin', 'linux'], 'npm refuses Windows, which AgentVoice does not support')
  assert.deepEqual(pkg.engines, { node: '>=24' })
  assert.deepEqual(pkg.publishConfig, { access: 'public' })
  assert.deepEqual(pkg.bin, { agentvoice: 'bin/agentvoice.js' })
  assert.equal(pkg.homepage, `https://github.com/${PUBLIC_NAMES[1]}#readme`)
  assert.deepEqual(pkg.bugs, { url: `https://github.com/${PUBLIC_NAMES[1]}/issues` })
  assert.deepEqual(pkg.repository, { type: 'git', url: `git+https://github.com/${PUBLIC_NAMES[1]}.git` })
  assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.includes('mcp'), 'keywords')
  for (const key of ['main', 'exports', 'private']) assert.ok(!(key in pkg), key)
  for (const script of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack']) assert.ok(!(script in pkg.scripts), `no ${script}: nothing runs on an npm user's machine, and nothing is built`)
  // Every "files" entry is rooted: an unrooted one matches the same name in any folder (an owner's .opencode/opencode.json).
  for (const entry of pkg.files as string[]) assert.match(entry, /^(?:!?\/|!\*\*\/)/, entry)
})

test("npm pack's tarball, left in the repository's root, is ignored by git", { skip: SKIP }, () => {
  const ignored = spawnSync('git', ['check-ignore', '-q', `${PACKAGE_NAME.slice(1).replace('/', '-')}-0.3.0.tgz`], { cwd: ROOT })
  assert.equal(ignored.status, 0)
})

test("--pack-json reads npm 11's array and npm 12's object, keyed by the package's name", { skip: SKIP, timeout: 120_000 }, t => {
  const files = [{ path: 'package.json' }, { path: 'bin/agentvoice.js' }]
  assert.deepEqual(packedFiles(JSON.stringify([{ name: PACKAGE_NAME, files }])), ['package.json', 'bin/agentvoice.js'])
  assert.deepEqual(packedFiles(JSON.stringify({ [PACKAGE_NAME]: { name: PACKAGE_NAME, files } })), ['package.json', 'bin/agentvoice.js'])
  assert.throws(() => packedFiles('{"error": {"code": "E404"}}'), /isn't npm pack --json's output/)
  // The repository's own list, in both shapes, from a file.
  const c = copy(t)
  const run = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: c.root, env: c.env, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  const array = JSON.parse(run.stdout)
  const entry = Array.isArray(array) ? array[0] : Object.values(array)[0]
  for (const [shape, json] of [['npm 11', [entry]], ['npm 12', { [PACKAGE_NAME]: entry }]] as const) {
    const file = path.join(c.base, `${shape.replace(' ', '')}.json`)
    fs.writeFileSync(file, JSON.stringify(json))
    assert.deepEqual(c.check({ packJson: file }).problems, [], shape)
  }
  const dropped = path.join(c.base, 'dropped.json')
  fs.writeFileSync(dropped, JSON.stringify({ [PACKAGE_NAME]: { ...entry, files: entry.files.filter((f: { path: string }) => f.path !== '.env.example') } }))
  assert.deepEqual(c.check({ packJson: dropped }).problems, [`It doesn't pack .env.example, which ${FILE_LIST} lists.`], 'as npm 12 did with a .env.* negation')
})

test('--tarball checks the tarball as it will be published: every file in it is HEAD\'s, byte for byte', { skip: SKIP, timeout: 120_000 }, t => {
  const c = copy(t)
  const tarball = c.pack(path.join(c.base, 'one'))
  const files = readTarball(tarball)
  assert.ok(files.has('bin/agentvoice.js') && files.has('package.json'))
  assert.deepEqual(c.check({ tarball }).problems, [])
  // A file changed after the commit, packed from the working folder: not HEAD's.
  fs.appendFileSync(path.join(c.root, 'docs/setup.md'), '\nA line HEAD never had.\n')
  const changed = c.pack(path.join(c.base, 'two'))
  assert.deepEqual(c.check({ tarball: changed }).problems, ["The tarball's docs/setup.md is not HEAD's."])
  // Not a tarball at all.
  fs.writeFileSync(path.join(c.base, 'not.tgz'), 'nope')
  assert.match(c.check({ tarball: path.join(c.base, 'not.tgz') }).problems[0], /not\.tgz can't be read: /)
})

test('--release by hand needs your private-terms list and a clean HEAD tagged v<version>, and finds a private term in a packed file', { skip: SKIP, timeout: 120_000 }, t => {
  const c = copy(t)
  const version = JSON.parse(fs.readFileSync(path.join(c.root, 'package.json'), 'utf8')).version
  const list = path.join(c.base, 'terms.txt')
  // No list, no tag.
  assert.deepEqual(c.check({ release: true }).problems, [`HEAD is not tagged: a release of ${version} is made from the tag v${version}.`, NO_LIST])
  c.git('tag', `v${version}`)
  assert.deepEqual(c.check({ release: true }).problems, [NO_LIST])
  // GitHub Actions has no list: the owner runs this by hand on the tag before approving the publish.
  assert.deepEqual(c.check({ release: true, env: { ...c.env, GITHUB_ACTIONS: 'true', PRIVATE_TERMS_FILE: '' } }).problems, [])
  // A list: nothing of it in the package.
  fs.writeFileSync(list, 'Zorblax\n')
  const withList = (o: Parameters<typeof checkPackage>[0] = {}) => c.check({ release: true, env: { ...c.env, PRIVATE_TERMS_FILE: list, GITHUB_ACTIONS: '' }, ...o })
  assert.deepEqual(withList().problems, [])
  // A term in a packed file (committed and tagged, so only the term is wrong), in the folder and in a tarball.
  fs.appendFileSync(path.join(c.root, 'docs/setup.md'), '\nThanks to Zorblax for the test meeting.\n')
  c.git('commit', '-q', '-am', 'thanks')
  c.git('tag', '-f', `v${version}`)
  const line = fs.readFileSync(path.join(c.root, 'docs/setup.md'), 'utf8').trimEnd().split('\n').length
  const hit = `A packed file names a private term: docs/setup.md:${line} "Zorblax": Thanks to Zorblax for the test meeting.`
  assert.deepEqual(withList().problems, [hit])
  assert.deepEqual(withList({ tarball: c.pack(path.join(c.base, 'tagged')) }).problems, [hit])
  // The project's own public names pass a list that names what they are named after; the rest of it is still checked.
  const scope = PUBLIC_NAMES[0].slice(1, PUBLIC_NAMES[0].indexOf('/'))
  fs.writeFileSync(list, `/${scope}/\n`)
  const named = withList().problems
  assert.ok(!named.some(p => p.includes('package.json')), named.join('\n'))
  // A tracked file that differs from HEAD.
  fs.writeFileSync(list, 'Zorblax\n!Thanks to Zorblax for the test meeting.\n')
  fs.appendFileSync(path.join(c.root, 'README.md'), '\nUncommitted.\n')
  assert.deepEqual(withList().problems, ['Tracked files differ from HEAD:\n M README.md'])
})

test('the command line: one input, --release, and a relative path from the folder npm run was run in', () => {
  const from = process.env.INIT_CWD || process.cwd()
  assert.deepEqual(parseArgs([]), {})
  assert.deepEqual(parseArgs(['--release', '--tarball', 'x.tgz']), { release: true, tarball: path.resolve(from, 'x.tgz') })
  assert.deepEqual(parseArgs(['--pack-json', '/tmp/p.json']), { packJson: '/tmp/p.json' })
  assert.throws(() => parseArgs(['--tarball']), /^Error: --tarball takes a file\.$/)
  assert.throws(() => parseArgs(['--tarball', 'a', '--pack-json', 'b']), /One input/)
  assert.throws(() => parseArgs(['--dry-run']), /Unknown option: --dry-run\./)
})

test('the never-ship list: what an owner keeps, and what is for development only', () => {
  for (const file of [
    '.env', 'src/.env', '.env.local', 'docs/.env.production', 'data/brief.md', 'src/data/decks/x.ts', 'decks/a.ts', 'briefs/acme.md', 'x/local-token',
    'control.sock', 'pending-bots.json', 'profile.md', 'docs/profile.local.md', 'q3.pdf', 'docs/q3.script.md', 'key.pem', 'src/server.key', 'a.p12',
    'b.pfx', 'x.log', 'private-terms.txt', '.claude/settings.local.json', '.claude/worktrees/a/x.md', '.opencode/opencode.json',
    '.opencode/opencode.jsonc', '.codex/auth.json', '.npmrc', 'test/package/check-package.ts', 'test/fixtures/other.json',
    'scripts/install-service.sh', '.github/workflows/ci.yml', 'public/agent.d.ts', 'tsconfig.json', '.nvmrc', 'CONTRIBUTING.md',
    'CODE_OF_CONDUCT.md', 'package-lock.json', 'x-agentvoice-0.3.0.tgz',
  ]) {
    assert.notEqual(neverShip(file), null, file)
  }
  for (const file of fs.readFileSync(path.join(ROOT, FILE_LIST), 'utf8').trim().split('\n')) assert.equal(neverShip(file), null, file)
})
