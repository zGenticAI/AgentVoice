// A cloned folder works exactly as it did before AgentVoice could be installed from npm: the same files in the same
// places (.env, profile.md and data/ in the clone, whatever AGENTVOICE_HOME says), the same messages word for word, and
// no new chmod. The repository itself is never written to here: what writes runs in a copy (test/layouts.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { MAX_BRIEF_CHARS, briefProblem } from '../src/brief.ts'
import { JOIN_USAGE } from '../src/cli/join-args.ts'
import { SLIDES_USAGE } from '../src/cli/slides-args.ts'
import { ROOT, recallRegionProblem, required, retiredSettings } from '../src/config.ts'
import { controlSocketProblem, howToStop, prepareControlSocket } from '../src/control-socket.ts'
import { readIdentity } from '../src/identity.ts'
import { readLocalToken } from '../src/local-token.ts'
import { checkName, checkOwner } from '../src/name-check.ts'
import { USAGE as FLUX_USAGE } from '../src/probe/flux-probe.ts'
import { readProfile } from '../src/profile.ts'
import { slidesNote, slidesPlatformProblem } from '../src/slides/platforms.ts'
import { OWNER_ACTIONS } from '../src/slides/presenter.ts'
import { PROBE_OFF, PROBE_ON } from '../src/speakers/probe.ts'
import { formatReport } from '../src/speakers/report.ts'
import { cloneCopy, command, envFor, probe, snapshot, startService, tempDir } from './layouts.ts'

const keysEmpty = { ANTHROPIC_API_KEY: '', DEEPGRAM_API_KEY: '', ELEVENLABS_API_KEY: '', ELEVENLABS_VOICE_ID: '', RECALL_API_KEY: '' }

test("the clone's own folder holds .env, data/ and profile.md, and AGENTVOICE_HOME is ignored", t => {
  const elsewhere = tempDir(t)
  const home = path.join(elsewhere, 'av')
  fs.mkdirSync(home)
  fs.writeFileSync(path.join(home, '.env'), 'AV_PROBE=home\n')
  // The repository, as npm run runs it (read only: nothing is written).
  const got = probe(t, ROOT, 'paths', envFor({ AGENTVOICE_HOME: home }), elsewhere)
  assert.ok(got.ok, got.ok ? '' : got.stderr)
  assert.equal(got.value.mode, 'clone')
  assert.equal(got.value.ownerDir, ROOT)
  assert.equal(got.value.packageDir, ROOT)
  assert.equal(got.value.dataDir, path.join(ROOT, 'data'))
  assert.equal(got.value.controlSocket, path.join(ROOT, 'data/control.sock'))
  assert.equal(got.value.relative, path.join(ROOT, 'briefs/acme.md'), 'a relative path is from the clone')
  assert.equal(got.value.profile, path.join(ROOT, 'profile.md'))
  assert.notEqual(got.value.probe, 'home', "AGENTVOICE_HOME's .env is not read")
  assert.equal(got.value.home, home, 'and the variable is left as it was')
  assert.equal(got.value.envFile, '.env')
  assert.equal(got.value.join, 'npm run join')
  assert.equal(got.value.missing, `AV_UNSET_SETTING is not set. Add it to ${path.join(ROOT, '.env')}`)
  assert.equal(got.value.canvas, 'Slide rendering needs @napi-rs/canvas: run npm install (without --omit=optional).')
  assert.match(got.value.profileProblem, /: fix the path in \.env, or remove PROFILE_FILE to use profile\.md in this folder \(or none\)\.$/)
  assert.equal(got.value.brief, 'The brief is empty. Leave it out to use the shared brief (data/brief.md).')
  assert.deepEqual(got.value.lifts, { npm: ['npm run slides'], agentvoice: [] })

  // A copy (a source zip, cp -r: no .git) is a clone too, and reads its own .env.
  const { clone, tmp } = cloneCopy(t)
  fs.writeFileSync(path.join(clone, '.env'), 'AV_PROBE=clone\n')
  const copy = probe(t, clone, 'paths', envFor({ AGENTVOICE_HOME: home }), tmp)
  assert.ok(copy.ok, copy.ok ? '' : copy.stderr)
  assert.equal(copy.value.mode, 'clone')
  assert.equal(copy.value.ownerDir, clone)
  assert.equal(copy.value.dataDir, path.join(clone, 'data'))
  assert.equal(copy.value.probe, 'clone')
  // Nor does an AGENTVOICE_HOME that installed mode would refuse stop a clone.
  const relative = probe(t, clone, 'paths', envFor({ AGENTVOICE_HOME: 'not/absolute' }), tmp)
  assert.ok(relative.ok, relative.ok ? '' : relative.stderr)
})

test("a clone's data folder, token, decks and socket are in the clone, as before: nothing there is refused", t => {
  const { clone, tmp } = cloneCopy(t)
  const got = probe(t, clone, 'writers', envFor({}), tmp)
  assert.ok(got.ok, got.ok ? '' : got.stderr)
  assert.deepEqual(got.value, { dataDir: 'ok', token: 'ok', decks: 'ok', socket: 'ok' })
  assert.equal(fs.statSync(path.join(clone, 'data')).mode & 0o777, 0o700)
  assert.equal(fs.statSync(path.join(clone, 'data/local-token')).mode & 0o777, 0o600)
})

test("a clone's service changes no mode but the data folder's, as before: the clone and its .env are left as they are", { timeout: 60_000 }, async t => {
  const { clone, tmp } = cloneCopy(t)
  fs.chmodSync(clone, 0o755)
  fs.writeFileSync(path.join(clone, '.env'), 'AV_PROBE=clone\n', { mode: 0o644 })
  fs.chmodSync(path.join(clone, '.env'), 0o644)
  const s = startService(t, clone, envFor({ PORT: '0', HOST: '127.0.0.1', ...keysEmpty }), tmp)
  await s.listening()
  assert.equal(fs.statSync(clone).mode & 0o777, 0o755, s.log())
  assert.equal(fs.statSync(path.join(clone, '.env')).mode & 0o777, 0o644)
  assert.equal(fs.statSync(path.join(clone, 'data')).mode & 0o777, 0o700)
  assert.ok(fs.lstatSync(path.join(clone, 'data/control.sock')).isSocket())
  assert.ok(s.log().includes(`This computer only:      ${path.join(clone, 'data/control.sock')} (npm run join, the zoom-meeting channel)`), s.log())
  s.child.kill('SIGTERM')
  assert.equal(await s.exited, 0, s.log())
})

test("a clone's npm run check says what it said: .env, npm run, docs/ and the profile's path", { timeout: 60_000 }, t => {
  const { clone, tmp } = cloneCopy(t)
  const before = snapshot(clone)
  const home = path.join(tmp, 'home')
  fs.mkdirSync(path.join(home, 'notes'), { recursive: true })
  const none = command(clone, 'src/cli/check.ts', [], envFor({ HOME: home, ...keysEmpty }), tmp)
  assert.equal(none.status, 1, none.stderr)
  for (const line of [
    '  Profile: none at profile.md, so every section has its generic default (copy profile.example.md to start one).',
    "✗ Bot link: AGENT_PAGE_TOKEN is not set. Set it in .env to the output of openssl rand -hex 24. PUBLIC_URL is not set. Set it in .env to your tunnel's https address (such as https://assistant.example.com).",
    '  Speaker probe: off (SPEAKER_PROBE, for test meetings only: docs/speaker-probe.md)',
    '  Slides: presenting is off on every platform (SLIDES_PLATFORMS: add one once the screen-share test passes there, docs/share-test.md)',
    '✗ Anthropic: ANTHROPIC_API_KEY is empty in .env',
    '✗ ElevenLabs: ELEVENLABS_API_KEY is empty in .env; ELEVENLABS_VOICE_ID is empty in .env',
    '4 check(s) failed. Fix .env, then run npm run check again.',
  ]) {
    assert.ok(none.stdout.split('\n').includes(line), `${line}\n---\n${none.stdout}`)
  }
  assert.match(none.stdout, /^✓ Name: .*\(npm run check-name tries it on about 1,900 meeting lines\)$/m)
  // A profile outside the clone is named in full, as before (not with "~").
  fs.writeFileSync(path.join(home, 'notes/profile.md'), '## About\n\nSam runs a small studio.\n')
  const named = command(clone, 'src/cli/check.ts', [], envFor({ HOME: home, PROFILE_FILE: '~/notes/profile.md', ...keysEmpty }), tmp)
  assert.match(named.stdout, new RegExp(`^✓ Profile: ${path.join(home, 'notes/profile.md').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}: About; `, 'm'), named.stdout)
  assert.deepEqual(snapshot(clone), before, 'check writes nothing')
})

test("a clone's messages are word for word what 0.2.0 said", async t => {
  assert.equal(
    PROBE_ON,
    'SPEAKER_PROBE is on: a meeting joined with npm run join -- "<link>" --speaker-probe subscribes to Recall\'s participant events ' +
      '(names and who is speaking reach this computer through the tunnel) and keeps measurements, numbers only, in data/speaker-probe/. ' +
      'Use it only in test meetings whose participants have agreed (docs/speaker-probe.md), and remove it from .env when the tests are done.',
  )
  assert.equal(
    PROBE_OFF,
    'SPEAKER_PROBE is not set in .env, so this meeting cannot have the speaker probe, which is for test meetings only ' +
      '(docs/speaker-probe.md). Set SPEAKER_PROBE=1 and restart the service, or join without --speaker-probe.',
  )
  assert.equal(
    JOIN_USAGE,
    'Usage: npm run join -- "<Zoom, Google Meet or Microsoft Teams meeting link>" [--brief <file>] [--speaker-probe]\n' +
      '       npm run join -- "<meeting link>" --slides <deck.script.md> [--from <slide>] [--brief <file>]\n' +
      '       npm run join -- "<meeting link>" --share-test [--json <file>] [--keep] [--brief <file>]',
  )
  assert.equal(
    SLIDES_USAGE,
    `Usage:
  npm run slides -- prepare <deck.pdf> [--exclude <pages>] [--label <name>]
  npm run slides -- check <deck.script.md>
  npm run slides -- list
  npm run slides -- delete <deck id> | --all
  npm run slides -- status [--meeting <bot id>]
  npm run slides -- control <${OWNER_ACTIONS.join('|')}> [<slide>] [--meeting <bot id>]
See docs/presenting.md.`,
  )
  assert.equal(FLUX_USAGE, 'Usage: npm run flux-probe [-- --mic] [--files <dir>] [--nonverbal] [--json <path>] [--idle-max <seconds>] [--only <ids>]')
  assert.equal(howToStop('local.agent-voice', 'linux'), 'systemctl --user stop local.agent-voice, or Ctrl-C in the Terminal running npm start')
  assert.equal(howToStop('local.agent-voice', 'darwin'), 'launchctl unload ~/Library/LaunchAgents/local.agent-voice.plist, or Ctrl-C in the Terminal running npm start')
  assert.equal(howToStop('x', 'win32'), 'Ctrl-C in the Terminal running npm start')
  assert.equal(briefProblem(''), 'The brief is empty. Leave it out to use the shared brief (data/brief.md).')
  assert.ok(MAX_BRIEF_CHARS > 0)
  assert.match(recallRegionProblem(''), /^RECALL_REGION is not set\. Set it in \.env to the region of your Recall account \(/)
  assert.deepEqual(retiredSettings({ CONTROL_PORT: '8788', ALEX_MODEL: 'x' }), [
    '[config] CONTROL_PORT does nothing now: npm run join and the zoom-meeting channel reach the service through its control socket ' +
      '(CONTROL_SOCKET, control.sock in the data folder unless set). Remove CONTROL_PORT from .env.',
    '[config] ALEX_MODEL is now called AGENT_MODEL. It still works for now: rename it in .env.',
  ])
  assert.throws(() => required('AV_UNSET_SETTING'), { message: `AV_UNSET_SETTING is not set. Add it to ${path.join(ROOT, '.env')}` })

  const dir = tempDir(t)
  assert.equal(
    readProfile(path.join(dir, 'gone.md'), true).problem,
    `PROFILE_FILE names ${path.join(dir, 'gone.md')}, which doesn't exist. It holds your Never share and Never open, so the service and the ` +
      "channel don't start without it: fix the path in .env, or remove PROFILE_FILE to use profile.md in this folder (or none).",
  )
  assert.throws(() => readLocalToken(dir), {
    message: `The local token ${path.join(dir, 'local-token')} is missing: start the voice service once to create it (npm start).`,
  })
  assert.equal(
    controlSocketProblem(path.join(dir, 'nowhere/control.sock')),
    `The folder of the control socket, ${path.join(dir, 'nowhere')}, does not exist. Start the voice service once to make the data folder, or set CONTROL_SOCKET in .env.`,
  )
  fs.chmodSync(dir, 0o755)
  assert.equal(
    controlSocketProblem(path.join(dir, 'control.sock')),
    `The control socket must be in a folder only you can open, and ${dir} is not (mode 755). Run chmod 700 ${dir}, or set CONTROL_SOCKET in .env to a path in such a folder.`,
  )
  fs.chmodSync(dir, 0o700)
  fs.writeFileSync(path.join(dir, 'control.sock'), '')
  await assert.rejects(prepareControlSocket(path.join(dir, 'control.sock')), {
    message: `${path.join(dir, 'control.sock')} exists and is not a socket, so the voice service leaves it alone. Move it away, or set CONTROL_SOCKET in .env to another path.`,
  })
  assert.match(controlSocketProblem(`/${'x'.repeat(120)}/control.sock`), /Set CONTROL_SOCKET in \.env to a shorter path, in a folder only you can open \(for example ~\/\.agent-voice\/control\.sock/)

  assert.equal(
    slidesPlatformProblem('zoom', []),
    'Presenting slides is off on Zoom. Run the screen-share test in a Zoom meeting you host first (docs/share-test.md). Once it passes, ' +
      'add zoom to SLIDES_PLATFORMS in .env (it lists none yet) and restart the service.',
  )
  assert.match(slidesNote({ name: 'Q3', narrated: 2, totalMs: 60_000, script: { minutes: null } }, 'zoom', 'Alex'), /\(npm run slides -- control start, or slides_control in your coding session\)/)
  assert.equal(formatReport({}, { dir: 'data/speaker-probe', files: 0, skipped: 0 }).split('\n')[1], 'Nothing measured yet. See docs/speaker-probe.md for how to run a test meeting.')

  const quiet = () => {}
  const owner = checkOwner(readIdentity({ AGENT_NAME: 'Alex', OWNER_NAME: '' }, quiet))
  assert.match(owner.errors[0], /^OWNER_NAME is not set\. Add the name of the person the assistant works for to \.env, as it should say it /)
  const short = checkName(readIdentity({ AGENT_NAME: 'Ava', OWNER_NAME: 'Sam' }, quiet)).warnings
  assert.ok(short.some(w => w.includes('see how its transcript (data/transcripts/) writes the name')), short.join('\n'))
  const word = checkName(readIdentity({ AGENT_NAME: 'Max', OWNER_NAME: 'Sam' }, quiet)).warnings
  assert.ok(word.some(w => w.endsWith("A name that isn't a word is safer: npm run check-name shows what changes on the sample lines.")), word.join('\n'))
  const warned: string[] = []
  readIdentity({ AGENT_NAME: 'Alex', OWNER_NAME: 'Sam', ALEX_BOT_NAME: 'Alex bot' }, w => void warned.push(w))
  assert.deepEqual(warned, ['[identity] ALEX_BOT_NAME is now called AGENT_BOT_NAME. It still works for now: rename it in .env.'])
})

test("package.json's scripts are 0.2.0's, with AGENTVOICE_HOME cleared for the tests like the other settings, and the package checks", () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts
  const test020 =
    'AGENT_NAME=Alex AGENT_NAME_VARIANTS= AGENT_NAME_MISHEARD= AGENT_BOT_NAME= ALEX_BOT_NAME= OWNER_NAME=Sam OWNER_FULL_NAME= COMPANY_NAME= ' +
    'PROFILE_FILE=test/fixtures/no-profile.md AGENT_PAGE_FILE= SERVICE_LABEL= RECALL_REGION=us-east-1 DEEPGRAM_KEYTERMS= ' +
    'ZOOM_JOIN_TELEGRAM_CHATS= AGENTVOICE_CLIENT= SPEAKER_PROBE= SLIDES_PLATFORMS= ALEX_DATA_DIR=$(mktemp -d) node --import tsx --test test/*.test.ts'
  assert.deepEqual(scripts, {
    start: 'tsx src/server.ts',
    join: 'tsx src/cli/join.ts',
    check: 'tsx src/cli/check.ts',
    channel: 'tsx src/channel/server.ts',
    'check-name': 'tsx src/cli/check-name.ts',
    'record-name-corpus': 'tsx src/cli/record-name-corpus.ts',
    'speaker-report': 'tsx src/cli/speaker-report.ts',
    'flux-probe': 'tsx src/cli/flux-probe.ts',
    slides: 'tsx src/cli/slides.ts',
    test: test020.replace('AGENTVOICE_CLIENT= ', 'AGENTVOICE_CLIENT= AGENTVOICE_HOME= '),
    typecheck: 'tsc --noEmit',
    'check-package': 'tsx test/package/check-package.ts',
    'test:package': 'node --import tsx --test test/package/*.test.ts',
    prepublishOnly: 'tsx test/package/check-package.ts --release',
  })
})

test("package.json's runtime dependencies are exact versions, each the one package-lock.json installs, so npm users run what a clone tested", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'))
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@anthropic-ai/sdk', '@modelcontextprotocol/sdk', 'dotenv', 'pdfjs-dist', 'tsx', 'ws'])
  for (const [name, version] of Object.entries(pkg.dependencies)) {
    assert.match(version as string, /^\d+\.\d+\.\d+$/, name)
    assert.equal(lock.packages[`node_modules/${name}`].version, version, `${name}: the version the lock installs`)
  }
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies, 'the lock records the same pins')
  // The development and optional ones as they were.
  assert.deepEqual(pkg.devDependencies, { '@types/node': '^24.19.2', '@types/ws': '^8.18.2', typescript: '^7.0.2' })
  assert.deepEqual(pkg.optionalDependencies, { '@napi-rs/canvas': '1.1.1' })
  // The lock's own names follow the package's; its version is the package's (0.2.0 until the release PR).
  assert.deepEqual([lock.name, lock.version, lock.packages[''].name, lock.packages[''].version], [pkg.name, pkg.version, pkg.name, pkg.version])
})
