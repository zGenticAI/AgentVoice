// Installed from npm (a package laid out as npm install -g makes it, in a temp folder: test/layouts.ts), the owner's
// files are in their AgentVoice folder, ~/.agentvoice or AGENTVOICE_HOME, and never in the package's folder, which npm
// replaces on every upgrade. The messages name agentvoice, the settings file's real place and the version's docs.
// A .env and a profile in the package's folder, and in the folder the command runs from, prove neither is ever read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ROOT } from '../src/config.ts'
import { PACKAGE_NAME } from '../src/home.ts'
import { makePdf } from './fixtures/slides/make-pdf.ts'
import { TSX, command, envFor, installedPackage, probe, snapshot, startService } from './layouts.ts'

type Ctx = { after: (fn: () => unknown) => void }

/** An installed package with decoy settings where they must never be read: its own folder, and the folder run from. */
function installed(t: Ctx, version?: string) {
  const at = installedPackage(t, version)
  fs.writeFileSync(path.join(at.pkg, '.env'), 'AV_PROBE=package\nAGENTVOICE_CLIENT=cursor\n')
  fs.writeFileSync(path.join(at.elsewhere, '.env'), 'AV_PROBE=cwd\n')
  const owner = path.join(at.home, '.agentvoice')
  return { ...at, owner, before: snapshot(at.pkg) }
}

const keysEmpty = { ANTHROPIC_API_KEY: '', DEEPGRAM_API_KEY: '', ELEVENLABS_API_KEY: '', ELEVENLABS_VOICE_ID: '', RECALL_API_KEY: '' }

test('installed, the AgentVoice folder is ~/.agentvoice: .env, the data folder, the socket and relative paths are there', t => {
  const at = installed(t)
  fs.mkdirSync(at.owner)
  fs.writeFileSync(path.join(at.owner, '.env'), 'AV_PROBE=home\n')
  const got = probe(t, at.pkg, 'paths', envFor({ HOME: at.home }), at.elsewhere)
  assert.ok(got.ok, got.ok ? '' : got.stderr)
  assert.deepEqual(got.value, {
    mode: 'installed',
    ownerDir: at.owner,
    packageDir: at.pkg,
    root: at.pkg,
    dataDir: path.join(at.owner, 'data'),
    controlSocket: path.join(at.owner, 'data/control.sock'),
    relative: path.join(at.owner, 'briefs/acme.md'),
    profile: path.join(at.owner, 'profile.md'),
    probe: 'home',
    home: null,
    homeInDotenv: false,
    envFile: '~/.agentvoice/.env',
    join: 'agentvoice join',
    missing: `AV_UNSET_SETTING is not set. Add it to ${path.join(at.owner, '.env')}`,
    canvas: `Slide rendering needs @napi-rs/canvas: reinstall AgentVoice without --omit=optional: npm install -g ${PACKAGE_NAME}.`,
    profileProblem:
      "PROFILE_FILE names /nonexistent-av/profile.md, which doesn't exist. It holds your Never share and Never open, so the service and " +
      "the channel don't start without it: fix the path in ~/.agentvoice/.env, or remove PROFILE_FILE to use ~/.agentvoice/profile.md (or none).",
    brief: 'The brief is empty. Leave it out to use the shared brief (~/.agentvoice/data/brief.md).',
    // OpenCode's saved "Allow always" approvals: installed, one for agentvoice slides lifts the ask, as npm run slides does in a clone.
    lifts: { npm: [], agentvoice: ['agentvoice slides'] },
  })
  assert.deepEqual(snapshot(at.pkg), at.before, 'nothing written into the package')
})

test('installed, AGENTVOICE_HOME names the AgentVoice folder, a space in it included; a value in .env is ignored', t => {
  const at = installed(t)
  const custom = path.join(at.tmp, 'av home')
  fs.mkdirSync(custom)
  fs.writeFileSync(path.join(custom, '.env'), 'AV_PROBE=custom\n')
  const got = probe(t, at.pkg, 'paths', envFor({ HOME: at.home, AGENTVOICE_HOME: custom }), at.elsewhere)
  assert.ok(got.ok, got.ok ? '' : got.stderr)
  assert.equal(got.value.ownerDir, custom)
  assert.equal(got.value.dataDir, path.join(custom, 'data'))
  assert.equal(got.value.probe, 'custom')
  assert.equal(got.value.envFile, path.join(custom, '.env'), 'outside the home folder: in full')
  assert.equal(got.value.home, custom)

  // AGENTVOICE_HOME says where .env is, so .env can't say it: it is taken out again, so nothing this process starts
  // takes it for the folder either.
  fs.mkdirSync(at.owner)
  fs.writeFileSync(path.join(at.owner, '.env'), `AV_PROBE=home\nAGENTVOICE_HOME=${custom}\n`)
  const fromDotenv = probe(t, at.pkg, 'paths', envFor({ HOME: at.home }), at.elsewhere)
  assert.ok(fromDotenv.ok, fromDotenv.ok ? '' : fromDotenv.stderr)
  assert.equal(fromDotenv.value.ownerDir, at.owner)
  assert.equal(fromDotenv.value.probe, 'home')
  assert.equal(fromDotenv.value.home, null)
  assert.equal(fromDotenv.value.homeInDotenv, true)
})

test('installed, an AGENTVOICE_HOME that is relative, or inside the package, stops every command before it reads a thing', t => {
  const at = installed(t)
  const relative = probe(t, at.pkg, 'paths', envFor({ HOME: at.home, AGENTVOICE_HOME: 'av' }), at.elsewhere)
  assert.equal(relative.ok, false)
  assert.match(relative.ok ? '' : relative.stderr, /AGENTVOICE_HOME is "av": give an absolute path, or one that starts with ~\//)
  const inside = probe(t, at.pkg, 'paths', envFor({ HOME: at.home, AGENTVOICE_HOME: path.join(at.pkg, 'home') }), at.elsewhere)
  assert.equal(inside.ok, false)
  assert.ok(
    (inside.ok ? '' : inside.stderr).includes(`AGENTVOICE_HOME (${path.join(at.pkg, 'home')}) is inside the installed package (${at.pkg}), which npm replaces on every upgrade`),
    inside.ok ? '' : inside.stderr,
  )
  assert.deepEqual(snapshot(at.pkg), at.before)
})

test('installed, nothing writes into the package: the data folder, the token, the decks and the socket refuse a path there', t => {
  const at = installed(t)
  const env = envFor({ HOME: at.home, ALEX_DATA_DIR: path.join(at.pkg, 'data'), CONTROL_SOCKET: path.join(at.pkg, 'control.sock') })
  const got = probe(t, at.pkg, 'writers', env, at.elsewhere)
  assert.ok(got.ok, got.ok ? '' : got.stderr)
  const refused = (file: string, setting: string) =>
    `${file} is inside the installed package (${at.pkg}), which npm replaces on every upgrade: ${setting} must point outside it, ` +
    'into your AgentVoice folder (~/.agentvoice) for example.'
  assert.deepEqual(got.value, {
    dataDir: refused(path.join(at.pkg, 'data'), 'ALEX_DATA_DIR'),
    token: refused(path.join(at.pkg, 'data'), 'ALEX_DATA_DIR'),
    decks: refused(path.join(at.pkg, 'data/decks'), 'ALEX_DATA_DIR'),
    socket: refused(path.join(at.pkg, 'control.sock'), 'CONTROL_SOCKET'),
  })
  // Outside the package, the same calls make the data folder as they always did.
  const fine = probe(t, at.pkg, 'writers', envFor({ HOME: at.home, ALEX_DATA_DIR: path.join(at.tmp, 'data') }), at.elsewhere)
  assert.ok(fine.ok, fine.ok ? '' : fine.stderr)
  assert.deepEqual(fine.value, { dataDir: 'ok', token: 'ok', decks: 'ok', socket: 'ok' })
  assert.equal(fs.statSync(path.join(at.tmp, 'data/local-token')).mode & 0o777, 0o600)
  assert.deepEqual(snapshot(at.pkg), at.before, 'nothing written into the package')
})

test('installed, slides prepare writes the deck into the AgentVoice folder, and the script beside the PDF names agentvoice', { timeout: 120_000 }, t => {
  const at = installed(t)
  const pdf = path.join(at.elsewhere, 'deck.pdf')
  fs.writeFileSync(pdf, makePdf([{ texts: [{ text: 'Roadmap', size: 40 }] }, { texts: [{ text: 'Thanks', size: 40 }] }]))
  // A data folder inside the package is refused before anything is rendered, in words without paths.
  const refused = command(at.pkg, 'src/cli/slides.ts', ['prepare', 'deck.pdf'], envFor({ HOME: at.home, INIT_CWD: at.elsewhere, ALEX_DATA_DIR: path.join(at.pkg, 'data') }), at.elsewhere)
  assert.equal(refused.status, 1, refused.stderr)
  assert.match(refused.stdout + refused.stderr, /The data folder is inside the installed package, which npm replaces on every upgrade: ALEX_DATA_DIR must point outside it/)
  assert.deepEqual(snapshot(at.pkg), at.before, 'nothing written into the package')

  const run = command(at.pkg, 'src/cli/slides.ts', ['prepare', 'deck.pdf'], envFor({ HOME: at.home, INIT_CWD: at.elsewhere }), at.elsewhere)
  assert.equal(run.status, 0, run.stdout + run.stderr)
  const decks = fs.readdirSync(path.join(at.owner, 'data/decks')).filter(name => !name.startsWith('.'))
  assert.equal(decks.length, 1, decks.join(', '))
  assert.match(run.stdout, /agentvoice slides check deck\.script\.md/)
  assert.doesNotMatch(run.stdout, /npm run/)
  const script = fs.readFileSync(path.join(at.elsewhere, 'deck.script.md'), 'utf8')
  assert.match(script, /Then run, from where you ran prepare: agentvoice slides check /)
  assert.doesNotMatch(script, /npm run/)
  assert.deepEqual(snapshot(at.pkg), at.before, 'nothing written into the package')
})

test('installed, the voice service makes its AgentVoice folder only yours, and keeps its data, token and socket there', { timeout: 60_000 }, async t => {
  const at = installed(t)
  // A folder and .env made looser than they should be (copied in, say): the service tightens them at start.
  fs.mkdirSync(at.owner, { mode: 0o755 })
  fs.chmodSync(at.owner, 0o755)
  fs.writeFileSync(path.join(at.owner, '.env'), 'AV_PROBE=home\n', { mode: 0o644 })
  fs.chmodSync(path.join(at.owner, '.env'), 0o644)
  const s = startService(t, at.pkg, envFor({ HOME: at.home, PORT: '0', HOST: '127.0.0.1', ...keysEmpty }), at.elsewhere)
  await s.listening()
  const data = path.join(at.owner, 'data')
  assert.equal(fs.statSync(at.owner).mode & 0o777, 0o700, s.log())
  assert.equal(fs.statSync(path.join(at.owner, '.env')).mode & 0o777, 0o600)
  assert.equal(fs.statSync(data).mode & 0o777, 0o700)
  assert.equal(fs.statSync(path.join(data, 'local-token')).mode & 0o777, 0o600)
  assert.ok(fs.lstatSync(path.join(data, 'control.sock')).isSocket())
  assert.ok(s.log().includes(`This computer only:      ${path.join(data, 'control.sock')} (agentvoice join, the zoom-meeting channel)`), s.log())
  const health = await new Promise<number>((resolve, reject) => {
    http.get({ socketPath: path.join(data, 'control.sock'), path: '/health' }, res => (res.resume(), resolve(res.statusCode ?? 0))).on('error', reject)
  })
  assert.equal(health, 200)
  s.child.kill('SIGTERM')
  assert.equal(await s.exited, 0, s.log())
  assert.deepEqual(snapshot(at.pkg), at.before, 'nothing written into the package')
})

test("installed, the channel's instructions name agentvoice, its messages the AgentVoice folder, and its version is the package's", { timeout: 60_000 }, async t => {
  const at = installed(t, '0.0.0-test')
  fs.mkdirSync(at.owner, { mode: 0o700 })
  // Only a client's own config may say which client it is: .env saying so is ignored, and the line that says so names
  // the .env that was read.
  fs.writeFileSync(path.join(at.owner, '.env'), 'AGENTVOICE_CLIENT=cursor\n')
  const data = path.join(at.owner, 'data')
  fs.mkdirSync(data, { mode: 0o700 })
  fs.writeFileSync(path.join(data, 'local-token'), `${'a'.repeat(64)}\n`, { mode: 0o600 })
  const env = envFor({ HOME: at.home, ZOOM_JOIN_TELEGRAM_CHATS: '', AGENTVOICE_CLIENT: undefined, PROFILE_FILE: path.join(ROOT, 'test/fixtures/no-profile.md') })
  const transport = new StdioClientTransport({ command: TSX, args: [path.join(at.pkg, 'src/channel/server.ts')], env, cwd: at.elsewhere, stderr: 'pipe' })
  let stderr = ''
  transport.stderr?.on('data', chunk => (stderr += chunk))
  const client = new Client({ name: 'test', version: '0' })
  t.after(() => client.close())
  await client.connect(transport)
  assert.deepEqual(client.getServerVersion(), { name: 'zoom-meeting', version: '0.0.0-test' })

  const clone = fs.readFileSync(path.join(ROOT, 'test/fixtures/claude-code/instructions.txt'), 'utf8')
  const expected = clone
    .replaceAll('npm run slides -- prepare', 'agentvoice slides prepare')
    .replaceAll('npm run slides -- check', 'agentvoice slides check')
    .replaceAll('npm run join', 'agentvoice join')
  assert.notEqual(expected, clone, 'the clone names npm run')
  assert.equal(client.getInstructions(), expected)
  assert.doesNotMatch(client.getInstructions() ?? '', /npm run|\bdocs\/|\.env\b/)

  // Nothing listens on the socket: the channel says how to start the service, and that both must use the same folder.
  for (let i = 0; i < 200 && !/The voice service is not running/.test(stderr); i++) await new Promise(r => setTimeout(r, 50))
  assert.ok(
    stderr.includes(
      `The voice service is not running (nothing is listening on ${path.join(data, 'control.sock')}). Start it with agentvoice start or ` +
        'agentvoice service install, then try again. If it is running, check that it and this channel use the same AgentVoice folder ' +
        '(AGENTVOICE_HOME, now ~/.agentvoice).',
    ),
    stderr,
  )
  assert.match(stderr, /\[client\] AGENTVOICE_CLIENT in ~\/\.agentvoice\/\.env is ignored: the client that starts this channel sets it in its own config/)
  assert.deepEqual(snapshot(at.pkg), at.before, 'nothing written into the package')
})

test('installed, check names the profile from the AgentVoice folder, the settings file in full and agentvoice commands', { timeout: 60_000 }, t => {
  const at = installed(t)
  fs.mkdirSync(at.owner, { mode: 0o700 })
  const none = command(at.pkg, 'src/cli/check.ts', [], envFor({ HOME: at.home, ...keysEmpty }), at.elsewhere)
  assert.equal(none.status, 1, none.stderr)
  assert.match(none.stdout, /^ {2}Profile: none at profile\.md, so every section has its generic default \(agentvoice init makes one from the example\)\.$/m)
  assert.match(none.stdout, /✓ Name: .*\(agentvoice check-name tries it on about 1,900 meeting lines\)/)
  assert.match(none.stdout, /ANTHROPIC_API_KEY is empty in ~\/\.agentvoice\/\.env/)
  assert.match(none.stdout, /AGENT_PAGE_TOKEN is not set\. Set it in ~\/\.agentvoice\/\.env to the output of openssl rand -hex 24\./)
  assert.match(none.stdout, /check\(s\) failed\. Fix ~\/\.agentvoice\/\.env, then run agentvoice check again\.$/m)
  assert.match(none.stdout, /SPEAKER_PROBE, for test meetings only: https:\/\/github\.com\/[\w-]+\/AgentVoice\/blob\/v\d+\.\d+\.\d+[^/]*\/docs\/speaker-probe\.md/)
  assert.doesNotMatch(none.stdout.replace(/https:\/\/\S+/g, '<link>'), /npm run|\bin \.env|docs\//)

  // A PROFILE_FILE outside the AgentVoice folder is named in full, the home folder as "~".
  fs.mkdirSync(path.join(at.home, 'notes'))
  fs.writeFileSync(path.join(at.home, 'notes/profile.md'), '## About\n\nSam runs a small studio.\n')
  const named = command(at.pkg, 'src/cli/check.ts', [], envFor({ HOME: at.home, PROFILE_FILE: '~/notes/profile.md', ...keysEmpty }), at.elsewhere)
  assert.match(named.stdout, /^✓ Profile: ~\/notes\/profile\.md: About; the generic default for /m)
  // And one inside it, from the folder.
  fs.mkdirSync(path.join(at.owner, 'more'))
  fs.writeFileSync(path.join(at.owner, 'more/me.md'), '## About\n\nSam runs a small studio.\n')
  const inside = command(at.pkg, 'src/cli/check.ts', [], envFor({ HOME: at.home, PROFILE_FILE: 'more/me.md', ...keysEmpty }), at.elsewhere)
  assert.match(inside.stdout, /^✓ Profile: more\/me\.md: About; /m)
  assert.deepEqual(snapshot(at.pkg), at.before, 'nothing written into the package')
})

test('installed, flux-probe says to add its key to the .env in the AgentVoice folder, and points to the docs of this version', { timeout: 60_000 }, t => {
  const at = installed(t, '0.0.0-test')
  const run = command(at.pkg, 'src/cli/flux-probe.ts', [], envFor({ HOME: at.home, DEEPGRAM_API_KEY: '' }), at.elsewhere)
  assert.equal(run.status, 1, run.stdout + run.stderr)
  assert.equal(run.stderr.trim(), `DEEPGRAM_API_KEY is not set. Add it to ${path.join(at.owner, '.env')}`)
  const help = command(at.pkg, 'src/cli/flux-probe.ts', ['--help'], envFor({ HOME: at.home }), at.elsewhere)
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /^Usage: agentvoice flux-probe \[--mic\] \[--files <dir>\]/)
  assert.match(help.stdout, /\nSee https:\/\/github\.com\/[\w-]+\/AgentVoice\/blob\/v0\.0\.0-test\/docs\/flux-probe\.md\.\n$/)
})
