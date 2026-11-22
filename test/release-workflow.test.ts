// What .github/workflows/release.yml does when a GitHub release is published: three jobs, so that no code from this
// repository or its dependencies runs where an OIDC token can be had (pack packs with npm and git only, test runs
// everything without a token, publish checks out and installs nothing and publishes the tested tarball, checked by its
// hash); no npm token, registry or cache anywhere; actions pinned by commit; and a release only of the version
// package.json names, from main, a pre-release only when the version and the GitHub release both say so. The scripts
// the jobs run are run here, as they are written, with a stand-in npm.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT } from '../src/config.ts'
import { PACKAGE_NAME } from '../src/home.ts'
import { REPOSITORY_URL, parseArgs } from './package/check-package.ts'
import { parseYaml, type YamlMap } from './yaml.ts'

type Ctx = { after: (fn: () => unknown) => void }
type Step = { name?: string; id?: string; uses?: string; run?: string; if?: string; with?: YamlMap; env?: YamlMap }

const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8')
const RELEASE_TEXT = read('.github/workflows/release.yml')
const RELEASE = parseYaml(RELEASE_TEXT) as YamlMap
const CI = parseYaml(read('.github/workflows/ci.yml')) as YamlMap
const PKG = JSON.parse(read('package.json')) as Record<string, unknown> & { scripts: Record<string, string> }
const JOBS = RELEASE.jobs as YamlMap
const job = (name: string) => JOBS[name] as YamlMap
const steps = (name: string) => job(name).steps as Step[]
const runs = (name: string) => steps(name).flatMap(s => (s.run === undefined ? [] : [s.run]))
const stepNamed = (name: string, title: string) => {
  const step = steps(name).find(s => s.name === title)
  assert.ok(step?.run, `${name}: ${title}`)
  return step.run
}
const BASH = spawnSync('bash', ['--version']).error ? 'needs bash' : false
/** The file npm pack makes of this package at a version: @scope/name becomes scope-name-<version>.tgz. */
const tarballName = (version: string) => `${PACKAGE_NAME.slice(1).replace('/', '-')}-${version}.tgz`
const NPM = spawnSync('npm', ['--version'], { encoding: 'utf8' })

function tmp(t: Ctx, prefix: string) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A folder with a stand-in npm in it, for PATH: `npm view` says whether the version is out, `npm --version` is
 *  STUB_NPM_VERSION, `npm pack` prints STUB_PACK_JSON. Anything else fails, so a step that ran more would show. */
function stubNpm(t: Ctx) {
  const bin = tmp(t, 'av-release-bin-')
  fs.writeFileSync(path.join(bin, 'npm'), [
    '#!/bin/sh',
    'case "$1" in',
    '  view) if [ -n "$STUB_PUBLISHED" ]; then echo "$STUB_PUBLISHED"; exit 0; fi; echo "npm error 404 Not Found" >&2; exit 1 ;;',
    '  --version) echo "$STUB_NPM_VERSION"; exit 0 ;;',
    '  pack) printf "%s\\n" "$STUB_PACK_JSON"; exit 0 ;;',
    'esac',
    'echo "the stand-in npm was asked for: $*" >&2',
    'exit 3',
    '',
  ].join('\n'), { mode: 0o755 })
  return bin
}

/** Runs a step's script as GitHub runs a `run:` (bash), with its outputs file, and reads the outputs back. */
function runStep(script: string, o: { cwd: string; env: NodeJS.ProcessEnv; bin?: string }) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'av-release-out-')), 'output')
  fs.writeFileSync(out, '')
  const PATH = [o.bin, path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter)
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && !key.startsWith('GITHUB_')))
  const r = spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', script], {
    cwd: o.cwd,
    env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...o.env, PATH, GITHUB_OUTPUT: out },
    encoding: 'utf8',
  })
  const outputs = Object.fromEntries(fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map(line => line.split(/=(.*)/s).slice(0, 2)))
  fs.rmSync(path.dirname(out), { recursive: true, force: true })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, outputs }
}

test('release.yml runs when a GitHub release is published, in three jobs: pack, then test, then publish', () => {
  assert.deepEqual(RELEASE.on, { release: { types: ['published'] } })
  assert.deepEqual(RELEASE.permissions, { contents: 'read' })
  // One release at a time, and never one cut off half way.
  assert.deepEqual(RELEASE.concurrency, { group: 'release', 'cancel-in-progress': false })
  assert.deepEqual(Object.keys(JOBS), ['pack', 'test', 'publish'])
  assert.equal(job('pack').needs, undefined)
  assert.equal(job('test').needs, 'pack')
  assert.deepEqual(job('publish').needs, ['pack', 'test'])
  // Only in the repository package.json names (a fork's release publishes nothing), and only a version not yet on npm.
  const repo = /^github\.repository == '([^']+)'$/.exec(String(job('pack').if))?.[1]
  assert.equal(`git+https://github.com/${repo}.git`, REPOSITORY_URL)
  assert.equal((PKG.repository as { url: string }).url, REPOSITORY_URL)
  assert.equal(job('publish').if, "needs.pack.outputs.published == 'no'")
  for (const name of Object.keys(JOBS)) assert.equal(job(name)['runs-on'], 'ubuntu-latest', name)
})

test('only the publish job can get an OIDC token, in the npm environment, and it runs no code from the repository or its dependencies', () => {
  assert.deepEqual(job('pack').permissions, { contents: 'read' })
  assert.deepEqual(job('test').permissions, { contents: 'read' })
  assert.deepEqual(job('publish').permissions, { contents: 'read', 'id-token': 'write' })
  assert.equal(RELEASE_TEXT.match(/id-token/g)?.length, 1)
  // The environment whose required reviewer is the gate, and the name npmjs.com's trusted publisher is given.
  assert.equal(job('publish').environment, 'npm')
  for (const name of ['pack', 'test']) assert.equal(job(name).environment, undefined, name)
  // No checkout: nothing of the repository is there to run. The tarball comes from the artifact the pack job made.
  assert.deepEqual(steps('publish').flatMap(s => (s.uses ? [s.uses.split('@')[0]] : [])), ['actions/setup-node', 'actions/download-artifact'])
  // npm runs no lifecycle scripts for a tarball (only for a folder), so publishing one runs nothing of the package.
  const runsCode = /\bnpm\s+(?:ci|install|i|test|t|run|run-script|exec|x|rebuild|pack|start)\b|\bnpx\b|\btsx\b/
  const nodeCalls = (script: string) => [...script.matchAll(/\bnode\s+(\S+)\s+(\S+)/g)].map(m => ({ flag: m[1], arg: m[2], all: m[0] }))
  for (const script of runs('publish')) {
    assert.doesNotMatch(script, runsCode, script)
    for (const call of nodeCalls(script)) assert.equal(call.flag, '-e', call.all)
  }
  assert.equal(stepNamed('publish', 'Publish to npm'), 'npm publish "$RUNNER_TEMP/package/$TARBALL_NAME" --provenance --access public --tag "$DIST_TAG"')
  // The pack job runs npm and git only: no npm ci, no scripts, and node only on its own code or package.json's fields.
  for (const script of runs('pack')) {
    assert.doesNotMatch(script.replace(/\bnpm pack --ignore-scripts\b/g, ''), runsCode, script)
    for (const call of nodeCalls(script)) {
      if (call.flag === '-p') assert.match(call.arg, /^"require\('\.\/package\.json'\)\.[a-z.]+"\)"?$/, call.all)
      else assert.equal(call.flag, '-e', call.all)
    }
  }
  assert.match(stepNamed('pack', 'Pack, running no scripts'), /npm pack --ignore-scripts --json --pack-destination "\$RUNNER_TEMP\/package"/)
})

test('no npm token, registry or dependency cache in any release job, and provenance only from the workflow', () => {
  assert.doesNotMatch(RELEASE_TEXT, /NODE_AUTH_TOKEN|NPM_TOKEN|secrets\.|registry-url|_authToken|(?<![\w-])token:/)
  for (const name of Object.keys(JOBS)) {
    const setup = steps(name).filter(s => s.uses?.startsWith('actions/setup-node@'))
    assert.equal(setup.length, 1, name)
    // No cache: one another workflow wrote could reach what is published.
    assert.deepEqual(setup[0].with, { 'node-version': 24 }, name)
    for (const s of steps(name)) assert.ok(!s.uses?.startsWith('actions/cache'), name)
  }
  // setup-node turns on npm's cache by itself when package.json names npm as its package manager.
  assert.equal(PKG.packageManager, undefined)
  assert.equal((PKG.devEngines as { packageManager?: unknown } | undefined)?.packageManager, undefined)
  // provenance: true in publishConfig would make a publish by hand fail (npm makes provenance only in CI).
  assert.deepEqual(PKG.publishConfig, { access: 'public' })
  assert.match(stepNamed('publish', 'Publish to npm'), / --provenance /)
})

test('every action is pinned to a full commit, with its version beside it; checkout and setup-node are the commits ci.yml uses', () => {
  const pins = (text: string) => {
    const found = new Map<string, Set<string>>()
    for (const line of text.split('\n').filter(l => /^\s*(?:- )?uses:/.test(l))) {
      const m = /^\s*(?:- )?uses: (actions\/[a-z-]+)@([0-9a-f]{40}) # (v\d+\.\d+\.\d+)$/.exec(line)
      assert.ok(m, line)
      found.set(m[1], (found.get(m[1]) ?? new Set()).add(`${m[2]} ${m[3]}`))
    }
    return found
  }
  const release = pins(RELEASE_TEXT)
  assert.deepEqual([...release.keys()].sort(), ['actions/checkout', 'actions/download-artifact', 'actions/setup-node', 'actions/upload-artifact'])
  for (const [action, pinned] of release) assert.equal(pinned.size, 1, `${action} is pinned once: ${[...pinned].join(', ')}`)
  const ci = pins(read('.github/workflows/ci.yml'))
  for (const action of ['actions/checkout', 'actions/setup-node']) assert.deepEqual(release.get(action), ci.get(action), action)
  // ci.yml parses too, and its jobs are the tests and the package (pull requests never get an OIDC token).
  assert.deepEqual(Object.keys(CI.jobs as YamlMap), ['test', 'package'])
  assert.deepEqual(CI.permissions, { contents: 'read' })
  assert.doesNotMatch(read('.github/workflows/ci.yml'), /id-token/)
})

test('the test and publish jobs take the pack job\'s one tarball, and check its hash before anything uses it', () => {
  const pack = job('pack')
  assert.deepEqual(pack.outputs, {
    tarball: '${{ steps.pack.outputs.tarball }}',
    integrity: '${{ steps.pack.outputs.integrity }}',
    dist_tag: '${{ steps.release.outputs.dist_tag }}',
    published: '${{ steps.release.outputs.published }}',
  })
  assert.deepEqual(steps('pack').flatMap(s => (s.id ? [s.id] : [])), ['release', 'pack'])
  // Every needs.pack.outputs.<x> the later jobs read is one the pack job sets.
  for (const m of RELEASE_TEXT.matchAll(/needs\.pack\.outputs\.([a-z_]+)/g)) assert.ok(m[1] in (pack.outputs as YamlMap), m[0])
  const upload = steps('pack').find(s => s.uses?.startsWith('actions/upload-artifact@'))
  assert.deepEqual(upload?.with, {
    name: 'package',
    path: '${{ runner.temp }}/package/${{ steps.pack.outputs.tarball }}',
    'if-no-files-found': 'error',
    'retention-days': 7,
  })
  for (const name of ['test', 'publish']) {
    const env = job(name).env as YamlMap
    assert.equal(env.TARBALL_NAME, '${{ needs.pack.outputs.tarball }}', name)
    assert.equal(env.INTEGRITY, '${{ needs.pack.outputs.integrity }}', name)
    const all = steps(name)
    const download = all.findIndex(s => s.uses?.startsWith('actions/download-artifact@'))
    assert.deepEqual(all[download].with, { name: 'package', path: '${{ runner.temp }}/package' }, name)
    const check = all.findIndex(s => /createHash\("sha512"\)/.test(s.run ?? ''))
    const firstUse = all.findIndex(s => /\$TARBALL_NAME/.test(s.run ?? '') && s !== all[check])
    assert.ok(download < check && check < firstUse, `${name}: download, then the hash check, then the tarball's use`)
    // Every step of the later jobs runs: none is skipped by a condition of its own, the hash check least of all.
    for (const step of all) assert.equal(step.if, undefined, `${name}: ${step.name ?? step.uses ?? step.run}`)
    // In the test job, before npm ci: nothing of the repository's dependencies has run yet.
    if (name === 'test') assert.ok(check < all.findIndex(s => s.run === 'npm ci'))
  }
  assert.equal((job('publish').env as YamlMap).DIST_TAG, '${{ needs.pack.outputs.dist_tag }}')
})

test('the hash check passes the pack job\'s tarball only, in both later jobs', { skip: BASH }, t => {
  const testCheck = steps('test').find(s => /createHash/.test(s.run ?? ''))?.run
  const publishCheck = steps('publish').find(s => /createHash/.test(s.run ?? ''))?.run
  assert.ok(testCheck && publishCheck)
  assert.equal(testCheck, publishCheck)
  const temp = tmp(t, 'av-release-hash-')
  fs.mkdirSync(path.join(temp, 'package'))
  const file = path.join(temp, 'package', tarballName('0.2.0'))
  fs.writeFileSync(file, 'the tarball the pack job made')
  const integrity = `sha512-${crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64')}`
  const env = { RUNNER_TEMP: temp, TARBALL_NAME: path.basename(file), INTEGRITY: integrity }
  assert.equal(runStep(testCheck, { cwd: temp, env }).status, 0)
  fs.appendFileSync(file, ', and one byte more')
  const swapped = runStep(testCheck, { cwd: temp, env })
  assert.equal(swapped.status, 1)
  assert.equal(swapped.stderr, `${file} is not the tarball the pack job made.\n`)
  assert.equal(runStep(testCheck, { cwd: temp, env: { ...env, TARBALL_NAME: 'missing.tgz' } }).status, 1)
})

test("the pack step's outputs come from npm 11's array and npm 12's object, and are the tarball's file name and hash", { skip: BASH }, t => {
  const bin = stubNpm(t)
  const script = stepNamed('pack', 'Pack, running no scripts')
  const one = { filename: tarballName('0.4.0-rc.1'), integrity: 'sha512-AAAA' }
  for (const json of [[one], { [PACKAGE_NAME]: one }]) {
    const temp = tmp(t, 'av-release-pack-')
    const r = runStep(script, { cwd: temp, bin, env: { RUNNER_TEMP: temp, STUB_PACK_JSON: JSON.stringify(json) } })
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(r.outputs, { tarball: one.filename, integrity: one.integrity })
    assert.ok(fs.statSync(path.join(temp, 'package')).isDirectory())
  }
})

test("the pack step, with the real npm, names a tarball whose hash the later jobs' check accepts", { skip: BASH || (NPM.error ? 'needs npm' : false), timeout: 120_000 }, t => {
  const temp = tmp(t, 'av-release-real-')
  const r = runStep(stepNamed('pack', 'Pack, running no scripts'), { cwd: ROOT, env: { RUNNER_TEMP: temp, npm_config_cache: path.join(temp, 'cache') } })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.outputs.tarball, tarballName(String(PKG.version)))
  const file = path.join(temp, 'package', r.outputs.tarball)
  assert.equal(r.outputs.integrity, `sha512-${crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64')}`)
  const check = steps('test').find(s => /createHash/.test(s.run ?? ''))?.run ?? ''
  assert.equal(runStep(check, { cwd: temp, env: { RUNNER_TEMP: temp, TARBALL_NAME: r.outputs.tarball, INTEGRITY: r.outputs.integrity } }).status, 0)
})

test('the release check: the tag is v<version>, the commit is on main, and a pre-release goes to next only when both say so', { skip: BASH }, t => {
  const script = stepNamed('pack', 'Check the release, its tag and the version')
  const bin = stubNpm(t)
  const repo = tmp(t, 'av-release-repo-')
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
      cwd: repo,
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: path.dirname(repo) },
      encoding: 'utf8',
    })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.trim()
  }
  const commit = (pkg: Record<string, unknown>) => {
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
    git('add', 'package.json')
    git('commit', '-q', '--allow-empty', '-m', String(pkg.version))
    return git('rev-parse', 'HEAD')
  }
  git('init', '-q')
  const pkg = { name: PACKAGE_NAME, version: '0.2.0', repository: { type: 'git', url: REPOSITORY_URL } }
  const run = (o: { pkg?: Record<string, unknown>; tag: string; prerelease?: boolean; published?: string; onMain?: boolean }) => {
    const sha = commit({ ...pkg, ...o.pkg })
    if (o.onMain !== false) git('update-ref', 'refs/remotes/origin/main', sha)
    return runStep(script, {
      cwd: repo,
      bin,
      env: {
        TAG: o.tag,
        PRERELEASE: String(o.prerelease ?? false),
        REPOSITORY: 'zGenticAI/AgentVoice',
        GITHUB_SHA: sha,
        STUB_PUBLISHED: o.published ?? '',
      },
    })
  }
  const error = (r: ReturnType<typeof run>) => (r.status === 1 ? /^::error::(.*)$/m.exec(r.stdout)?.[1] : `exit ${r.status}: ${r.stderr}`)

  let r = run({ tag: 'v0.2.0' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.deepEqual(r.outputs, { dist_tag: 'latest', published: 'no' })
  r = run({ tag: 'v0.2.0', published: '0.2.0' })
  assert.deepEqual(r.outputs, { dist_tag: 'latest', published: 'yes' })
  r = run({ tag: 'v0.4.0-rc.1', prerelease: true, pkg: { version: '0.4.0-rc.1' } })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.deepEqual(r.outputs, { dist_tag: 'next', published: 'no' })

  assert.equal(error(run({ tag: 'v0.2.1' })), "The release's tag is v0.2.1, but package.json's version is 0.2.0: the tag must be v0.2.0.")
  assert.equal(error(run({ tag: '0.2.0' })), "The release's tag is 0.2.0, but package.json's version is 0.2.0: the tag must be v0.2.0.")
  assert.equal(error(run({ tag: 'v0.2.0', pkg: { name: 'agent-voice' } })), 'package.json is named agent-voice, not @zgentic/agentvoice.')
  assert.equal(
    error(run({ tag: 'v0.2.0', pkg: { repository: { type: 'git', url: 'https://github.com/zGenticAI/AgentVoice' } } })),
    "package.json's repository.url is https://github.com/zGenticAI/AgentVoice: npm's provenance check needs git+https://github.com/zGenticAI/AgentVoice.git.",
  )
  assert.equal(error(run({ tag: 'v0.2.0', onMain: false })), 'v0.2.0 is not on main: release only from main.')
  assert.equal(
    error(run({ tag: 'v0.2.0', prerelease: true })),
    'The GitHub release is marked as a pre-release, but 0.2.0 has no pre-release part (such as -rc.1). Unmark it, or give the version one.',
  )
  assert.equal(
    error(run({ tag: 'v0.4.0-rc.1', pkg: { version: '0.4.0-rc.1' } })),
    '0.4.0-rc.1 is a pre-release version, but the GitHub release is not marked as a pre-release. Mark it, or use a plain version.',
  )
})

test('the publish job refuses an npm older than 11.5.1, which trusted publishing needs', { skip: BASH }, t => {
  const bin = stubNpm(t)
  const script = stepNamed('publish', 'Check npm (trusted publishing needs 11.5.1 or later)')
  const status = (version: string) => runStep(script, { cwd: bin, bin, env: { STUB_NPM_VERSION: version } })
  for (const version of ['11.5.1', '11.6.0', '11.19.1', '12.0.0', '12.2.3']) assert.equal(status(version).status, 0, version)
  for (const version of ['10.9.2', '11.4.9', '11.5.0']) {
    const r = status(version)
    assert.equal(r.status, 1, version)
    assert.equal(r.stderr, `npm ${version} is older than 11.5.1, which trusted publishing needs.\n`)
  }
})

test('the test job runs the typecheck, every test and the package checks on that tarball, with scripts package.json has', () => {
  const checkout = (name: string) => steps(name).find(s => s.uses?.startsWith('actions/checkout@'))?.with
  // The whole history, so the release check finds origin/main and check-package --release finds the tag.
  for (const name of ['pack', 'test']) assert.deepEqual(checkout(name), { 'persist-credentials': false, 'fetch-depth': 0 }, name)
  assert.deepEqual(runs('test').slice(1), [
    'npm ci',
    'npm run typecheck',
    'npm test',
    'npm run check-package -- --release --tarball "$RUNNER_TEMP/package/$TARBALL_NAME"',
    'AGENTVOICE_TARBALL="$RUNNER_TEMP/package/$TARBALL_NAME" npm run test:package',
  ])
  for (const script of ['typecheck', 'test', 'check-package', 'test:package']) assert.ok(PKG.scripts[script], script)
  const o = parseArgs(['--release', '--tarball', '/tmp/x.tgz'])
  assert.equal(o.release, true)
  assert.equal(o.tarball, '/tmp/x.tgz')
  assert.match(read('test/package/install.test.ts'), /process\.env\.AGENTVOICE_TARBALL/)
})

test("docs/development.md's Releasing names the workflow, its environment and the trusted publisher's fields as they are", () => {
  const dev = read('docs/development.md')
  const releasing = /^## Releasing\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(dev)?.[1]
  assert.ok(releasing, 'docs/development.md has a Releasing section')
  const repo = /'([^']+)'/.exec(String(job('pack').if))?.[1] ?? ''
  const fields = `the repository \`${repo}\`, the workflow \`release.yml\` and the environment \`${job('publish').environment as string}\``
  assert.ok(releasing.includes(fields), fields)
  for (const words of ['`pack`', '`test`', '`publish`', '`v<version>`', '`next`', 'npm run check-package -- --release', 'PRIVATE_TERMS_FILE=']) {
    assert.ok(releasing.includes(words), words)
  }
  // The trusted publisher expires unless it publishes within 2 days of being saved.
  assert.match(releasing, /2 days/)
})

test('the YAML reader reads what the workflows use, and refuses what it does not take rather than guess', () => {
  assert.deepEqual(parseYaml('a: 1\nb: [x, "y z", \'w\']\nc:\n  - k: v\n    l: true\n  - plain # a comment\nd: |\n  line one\n    indented\n\ne: ${{ x }} # comment\non:\n'), {
    a: 1,
    b: ['x', 'y z', 'w'],
    c: [{ k: 'v', l: true }, 'plain'],
    d: 'line one\n  indented\n',
    e: '${{ x }}',
    on: null,
  })
  for (const bad of ['a: 1\na: 2\n', 'a: &x 1\n', 'a: *x\n', 'a: !tag 1\n', 'a: {b: 1}\n', 'a: >\n  folded\n', 'a:\n\t- b\n', 'a: b: c\n', 'a: "open\n', 'a: [x, [y]]\n']) {
    assert.throws(() => parseYaml(bad), /^Error: YAML line \d+: /, JSON.stringify(bad))
  }
})
