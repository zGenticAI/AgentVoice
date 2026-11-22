// The agentvoice command (src/cli/agentvoice.ts, which bin/agentvoice.js runs): its help and version, and that each
// command runs its own module, with its own arguments, as npm run runs it in a clone. In a clone (npm link), init, setup
// and service refuse, with the clone's way instead. The installed cases run the bin of a package laid out as npm
// install -g makes it, in a temp folder (test/layouts.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { JOIN_USAGE } from '../src/cli/join-args.ts'
import { SLIDES_USAGE } from '../src/cli/slides-args.ts'
import { DOCS_URL, README_URL, cloneRefusal } from '../src/commands.ts'
import { ROOT } from '../src/config.ts'
import { PACKAGE_NAME, PACKAGE_VERSION } from '../src/home.ts'
import { CHECK_NAME_USAGE } from '../src/name-check.ts'
import { USAGE as FLUX_USAGE } from '../src/probe/flux-probe.ts'
import { SPEAKER_REPORT_USAGE } from '../src/speakers/report.ts'
import { TSX, agentvoice, cloneCopy, envFor, installedPackage, snapshot, tempDir } from './layouts.ts'

type Ctx = { after: (fn: () => unknown) => void }

const DISPATCHER = 'src/cli/agentvoice.ts'
/** The dispatcher of the folder given (the repository unless said), run through tsx, as npm link's agentvoice runs it. */
const dispatch = (args: string[], { root = ROOT, env = envFor({}), cwd = ROOT }: { root?: string; env?: Record<string, string>; cwd?: string } = {}) =>
  spawnSync(TSX, [path.join(root, DISPATCHER), ...args], { env, cwd, encoding: 'utf8', timeout: 60_000 })

const keysEmpty = { ANTHROPIC_API_KEY: '', DEEPGRAM_API_KEY: '', ELEVENLABS_API_KEY: '', ELEVENLABS_VOICE_ID: '', RECALL_API_KEY: '' }

/** What agentvoice --help prints (spec 2.5), but for its last line. */
const helpText = (version: string, last: string) => `AgentVoice ${version}: a voice assistant for your Zoom, Google Meet and Microsoft Teams meetings.

Usage: agentvoice <command> [options]

Set up
  init                          Make your AgentVoice folder (~/.agentvoice, or AGENTVOICE_HOME) from the examples:
                                .env, profile.md, data/brief.md and briefs/. It never overwrites a file.
  check                         Check your settings, and try the Anthropic, Deepgram and ElevenLabs keys.
  start                         Run the voice service in this terminal (Ctrl-C stops it).
  service install [--replace]   Keep the voice service running: launchd on macOS, systemd on Linux.
  service print [launchd|systemd]
                                Print the file it would install, and install nothing.
  service uninstall             Stop the installed service and remove its file.
  setup claude-code [<folder>]  Make <folder> (a new, empty one; this one unless given) the folder you start Claude
                                Code in for meetings.
  setup codex [<folder>]        The same for Codex.
  setup opencode [<folder>] [--source <dir>]... [--no-sources]
                                The same for OpenCode; each --source is a folder its meeting-assistant may read.
                                Each setup takes --replace-changed, to replace files you changed (kept as backups).

Meetings
  join "<link>" [--brief <file>] [--slides <deck.script.md> [--from <slide>]] [--speaker-probe]
                                Send the assistant into a meeting.
  join "<link>" --share-test [--json <file>] [--keep]
                                Test a screen share, in a meeting you host.
  slides prepare <deck.pdf> | check <deck.script.md> | list | delete <id>|--all | status | control <action>
                                Prepare a slide deck, and steer a presentation.

Tuning
  check-name [<name>] [--variants <a,b>] [--misheard <c,d>] [--all]
                                How a name does on about 1,900 sample meeting lines.
  speaker-report [--json]       The speaker probe's measurements, by platform.
  flux-probe [--help]           What Deepgram Flux does with backchannels, noise and interruptions.

For your coding client
  channel                       The zoom-meeting channel. The config that agentvoice setup writes starts it.

  help <command>                That command's options.
  --version, -v                 The version.

${last}
`
const cloneLast = (root: string) => `This is a cloned folder (${root}): your settings are in its .env, and its README says how to set it up.`

test('--version, -v and version print the version in package.json, and nothing else', () => {
  for (const args of [['--version'], ['-v'], ['version'], ['--version', 'extra']]) {
    const run = dispatch(args)
    assert.equal(run.status, 0, run.stderr)
    assert.equal(run.stdout, `${JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version}\n`, args.join(' '))
    assert.equal(run.stderr, '')
  }
})

test('no command, help, --help and -h print the help on stdout; in a clone its last line says so', () => {
  for (const args of [[], ['help'], ['--help'], ['-h']]) {
    const run = dispatch(args)
    assert.equal(run.status, 0, run.stderr)
    assert.equal(run.stdout, helpText(PACKAGE_VERSION, cloneLast(ROOT)), args.join(' ') || '(none)')
    assert.equal(run.stderr, '')
  }
})

test('installed, the help names your settings file and AgentVoice folder, and the README', t => {
  const at = installedPackage(t, '0.3.0')
  const plain = agentvoice(at.pkg, ['--help'], envFor({ HOME: at.home, TMPDIR: at.tmp }), at.elsewhere)
  assert.equal(plain.status, 0, plain.stderr)
  assert.equal(plain.stdout, helpText('0.3.0', `Your settings: ~/.agentvoice/.env, in ~/.agentvoice. Docs: ${README_URL}`))
  assert.equal(README_URL, DOCS_URL.replace(/\/blob$/, '#readme'))
  const custom = path.join(at.tmp, 'av home')
  const named = agentvoice(at.pkg, [], envFor({ HOME: at.home, TMPDIR: at.tmp, AGENTVOICE_HOME: custom }), at.elsewhere)
  assert.equal(named.status, 0, named.stderr)
  assert.equal(named.stdout.trimEnd().split('\n').at(-1), `Your settings: ${custom}/.env, in ${custom}. Docs: ${README_URL}`)
  assert.equal(agentvoice(at.pkg, ['-v'], envFor({ HOME: at.home, TMPDIR: at.tmp }), at.elsewhere).stdout, '0.3.0\n', "the package's own version")
  assert.ok(!fs.existsSync(path.join(at.home, '.agentvoice')), 'and help makes no folder')
})

test("help <command>, and <command> --help or -h, print that command's usage lines, its own where it has them", t => {
  const own: Record<string, string> = {
    join: JOIN_USAGE,
    slides: SLIDES_USAGE,
    'check-name': CHECK_NAME_USAGE,
    'speaker-report': SPEAKER_REPORT_USAGE,
    'flux-probe': `${FLUX_USAGE}\nSee docs/flux-probe.md.`,
    init: 'Usage: agentvoice init',
    check: 'Usage: agentvoice check',
    start: 'Usage: agentvoice start',
    channel: 'Usage: agentvoice channel',
    service: 'Usage: agentvoice service install [--replace]\n       agentvoice service print [launchd|systemd]\n       agentvoice service uninstall',
    setup:
      'Usage: agentvoice setup claude-code [<folder>] [--replace-changed]\n' +
      '       agentvoice setup codex [<folder>] [--replace-changed]\n' +
      '       agentvoice setup opencode [<folder>] [--source <dir>]... [--no-sources] [--replace-changed]',
    help: 'Usage: agentvoice help [<command>]',
    version: 'Usage: agentvoice --version',
  }
  for (const [command, usage] of Object.entries(own)) {
    const run = dispatch(['help', command])
    assert.equal(run.status, 0, `${command}: ${run.stderr}`)
    assert.equal(run.stdout, `${usage}\n`, command)
  }
  // The flag form asks the same, and never runs the command: init would make a folder, start the service.
  for (const flag of ['--help', '-h']) {
    for (const command of ['init', 'start', 'channel', 'check', 'join', 'setup', 'service']) {
      const run = dispatch([command, flag])
      assert.equal(run.status, 0, `${command} ${flag}: ${run.stderr}`)
      assert.equal(run.stdout, `${own[command]}\n`, `${command} ${flag}`)
    }
  }

  // Installed, the commands' own usage lines name agentvoice, and the docs page of this version.
  const at = installedPackage(t, '0.3.0')
  const env = envFor({ HOME: at.home, TMPDIR: at.tmp })
  const join = agentvoice(at.pkg, ['help', 'join'], env, at.elsewhere)
  assert.match(join.stdout, /^Usage: agentvoice join "<Zoom, Google Meet or Microsoft Teams meeting link>" \[--brief <file>\]/)
  assert.doesNotMatch(join.stdout, /npm/)
  const slides = agentvoice(at.pkg, ['slides', '--help'], env, at.elsewhere)
  assert.match(slides.stdout, /^Usage:\n {2}agentvoice slides prepare <deck\.pdf>/)
  assert.ok(slides.stdout.endsWith(`See ${DOCS_URL}/v0.3.0/docs/presenting.md.\n`), slides.stdout)
  const init = agentvoice(at.pkg, ['init', '--help'], env, at.elsewhere)
  assert.equal(init.stdout, 'Usage: agentvoice init\n')
  assert.ok(!fs.existsSync(path.join(at.home, '.agentvoice')), 'init --help made no folder')
})

test('an unknown command, or help for one, says so on stderr with exit 2; the development scripts are not commands', () => {
  for (const [args, name] of [[['nope'], 'nope'], [['--nope'], '--nope'], [['help', 'nope'], 'nope'], [['record-name-corpus'], 'record-name-corpus'], [['test'], 'test'], [['typecheck'], 'typecheck'], [['toString'], 'toString'], [[''], '']] as const) {
    const run = dispatch([...args])
    assert.equal(run.status, 2, args.join(' '))
    assert.equal(run.stdout, '')
    assert.equal(run.stderr, `Unknown command "${name}". Run agentvoice --help for the commands.\n`)
  }
})

test('in a clone, init, setup and service refuse, name the clone, say its way, and write nothing', t => {
  const { clone, tmp } = cloneCopy(t)
  const home = path.join(tmp, 'home')
  fs.mkdirSync(home)
  const before = snapshot(clone)
  for (const args of [['init'], ['setup', 'claude-code'], ['setup', 'codex', path.join(tmp, 'session')], ['service', 'install'], ['service', 'print', 'systemd'], ['service', 'uninstall']]) {
    const run = dispatch(args, { root: clone, env: envFor({ HOME: home }), cwd: tmp })
    assert.equal(run.status, 1, args.join(' '))
    assert.equal(run.stdout, '')
    assert.equal(run.stderr, `${cloneRefusal(clone)}\n`)
  }
  assert.equal(
    cloneRefusal(clone),
    `This is a cloned folder (${clone}): set it up as its README says (cp .env.example .env, scripts/install-service.sh, ` +
      'scripts/install-channel.sh, scripts/install-codex.sh, scripts/install-opencode.sh).',
  )
  // init's own module refuses too, run on its own.
  const direct = spawnSync(TSX, [path.join(clone, 'src/cli/init.ts')], { env: envFor({ HOME: home }), cwd: tmp, encoding: 'utf8', timeout: 60_000 })
  assert.equal(direct.status, 1, direct.stderr)
  assert.equal(direct.stderr, `${cloneRefusal(clone)}\n`)
  assert.deepEqual(snapshot(clone), before, 'nothing written into the clone')
  assert.deepEqual(fs.readdirSync(home), [], 'nor into the home folder')
  assert.deepEqual(fs.readdirSync(tmp).sort(), ['AgentVoice', 'home'], 'nor a session folder')
})

test("npm link's agentvoice (a link to the clone) runs the clone, in clone mode", t => {
  const tmp = tempDir(t)
  const prefix = path.join(tmp, 'prefix')
  fs.mkdirSync(path.join(prefix, 'lib/node_modules', path.dirname(PACKAGE_NAME)), { recursive: true })
  fs.mkdirSync(path.join(prefix, 'bin'))
  fs.symlinkSync(ROOT, path.join(prefix, 'lib/node_modules', PACKAGE_NAME))
  fs.symlinkSync(path.join('../lib/node_modules', PACKAGE_NAME, 'bin/agentvoice.js'), path.join(prefix, 'bin/agentvoice'))
  const env = envFor({ HOME: tmp, TMPDIR: tmp, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` })
  const help = spawnSync(path.join(prefix, 'bin/agentvoice'), ['--help'], { env, cwd: tmp, encoding: 'utf8', timeout: 60_000 })
  assert.equal(help.status, 0, help.stderr)
  assert.equal(help.stdout, helpText(PACKAGE_VERSION, cloneLast(ROOT)))
  const init = spawnSync(path.join(prefix, 'bin/agentvoice'), ['init'], { env, cwd: tmp, encoding: 'utf8', timeout: 60_000 })
  assert.equal(init.status, 1)
  assert.equal(init.stderr, `${cloneRefusal(ROOT)}\n`)
  assert.ok(!fs.existsSync(path.join(tmp, '.agentvoice')))
})

test('installed, an AGENTVOICE_HOME that cannot be used is said in one line, for every command, with nothing on stdout', t => {
  const at = installedPackage(t)
  for (const args of [['--version'], ['init'], ['channel']]) {
    const run = agentvoice(at.pkg, args, envFor({ HOME: at.home, TMPDIR: at.tmp, AGENTVOICE_HOME: 'relative/av' }), at.elsewhere, '')
    assert.equal(run.status, 1, args.join(' '))
    assert.equal(run.stdout, '')
    assert.equal(
      run.stderr,
      'AGENTVOICE_HOME is "relative/av": give an absolute path, or one that starts with ~/, so the service, the commands and your coding client all find the same folder.\n',
    )
  }
  assert.deepEqual(fs.readdirSync(at.home), [])
})

test('each command runs its own module with its own arguments, from the folder it is run in', { timeout: 120_000 }, t => {
  const at = installedPackage(t)
  const owner = path.join(at.home, '.agentvoice')
  const env = envFor({ HOME: at.home, TMPDIR: at.tmp, ...keysEmpty })
  const run = (...args: string[]) => agentvoice(at.pkg, args, env, at.elsewhere)

  const name = run('check-name', 'Alex')
  assert.equal(name.status, 0, name.stderr)
  assert.match(name.stdout, /^Name: "Alex" /)
  assert.match(name.stdout, /Read 1,859 meeting lines with it/, 'the shipped corpus')

  const report = run('speaker-report', '--json')
  assert.equal(report.status, 0, report.stderr)
  assert.deepEqual(JSON.parse(report.stdout), { files: 0, skipped: 0, platforms: {} })
  const wrong = run('speaker-report', '--platform')
  assert.equal(wrong.status, 1)
  assert.equal(wrong.stderr, 'Unknown option --platform.\nUsage: agentvoice speaker-report [--json]\n')

  const list = run('slides', 'list')
  assert.equal(list.status, 0, list.stderr)
  assert.equal(list.stdout, `No prepared decks in ${path.join(owner, 'data/decks')}.\n`)

  const join = run('join')
  assert.equal(join.status, 1)
  assert.match(join.stderr, /\nUsage: agentvoice join "<Zoom, Google Meet or Microsoft Teams meeting link>"/)

  const flux = run('flux-probe', '--bogus')
  assert.equal(flux.status, 1)
  assert.match(flux.stderr, /^Unknown option --bogus\.\nUsage: agentvoice flux-probe \[--mic\]/)

  const check = run('check')
  assert.equal(check.status, 1, check.stderr)
  assert.ok(check.stdout.includes('✗ Anthropic: ANTHROPIC_API_KEY is empty in ~/.agentvoice/.env'), check.stdout)
  assert.match(check.stdout, /check\(s\) failed\. Fix ~\/\.agentvoice\/\.env, then run agentvoice check again\.\n$/)
})

/** The first line the process writes on stdout. */
function firstLine(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = ''
    child.stdout.on('data', chunk => {
      out += chunk
      if (out.includes('\n')) resolve(out.slice(0, out.indexOf('\n')))
    })
    child.on('exit', code => reject(new Error(`exited (${code}) before a line on stdout: ${JSON.stringify(out)}`)))
  })
}

/** Starts a channel, sends MCP's initialize, and returns the first line on stdout, which must be the answer. */
async function handshake(t: Ctx, command: string, args: string[], env: Record<string, string>, cwd: string) {
  const child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => child.kill('SIGKILL'))
  let stderr = ''
  child.stderr.on('data', chunk => (stderr += chunk))
  const line = firstLine(child)
  const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }
  child.stdin.write(`${JSON.stringify(initialize)}\n`)
  const first = await line.catch(err => {
    throw new Error(`${(err as Error).message}\n${stderr}`)
  })
  return { first, stderr: () => stderr }
}

test('agentvoice channel writes nothing on stdout before the MCP handshake: in a clone, and installed through the bin', { timeout: 60_000 }, async t => {
  const data = tempDir(t)
  const cloneRun = await handshake(t, TSX, [path.join(ROOT, DISPATCHER), 'channel'], envFor({ ALEX_DATA_DIR: data }), data)
  const answer = JSON.parse(cloneRun.first)
  assert.equal(answer.id, 1, cloneRun.first)
  assert.deepEqual(answer.result.serverInfo, { name: 'zoom-meeting', version: PACKAGE_VERSION })

  const at = installedPackage(t, '0.3.0')
  const installed = await handshake(t, process.execPath, [path.join(at.pkg, 'bin/agentvoice.js'), 'channel'], envFor({ HOME: at.home, TMPDIR: at.tmp }), at.elsewhere)
  const reply = JSON.parse(installed.first)
  assert.equal(reply.id, 1, installed.first)
  assert.deepEqual(reply.result.serverInfo, { name: 'zoom-meeting', version: '0.3.0' })
  assert.match(reply.result.instructions, /agentvoice slides prepare/)
  assert.doesNotMatch(reply.result.instructions, /npm run/)
})

test('agentvoice start runs the voice service in this one process, which SIGTERM stops in order', { timeout: 60_000 }, async t => {
  const at = installedPackage(t)
  const owner = path.join(at.home, '.agentvoice')
  const child = spawn(process.execPath, [path.join(at.pkg, 'bin/agentvoice.js'), 'start'], {
    env: envFor({ HOME: at.home, TMPDIR: at.tmp, PORT: '0', HOST: '127.0.0.1', ...keysEmpty }),
    cwd: at.elsewhere,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => child.kill('SIGKILL'))
  let log = ''
  child.stdout.on('data', c => (log += c))
  child.stderr.on('data', c => (log += c))
  const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)))
  for (let i = 0; i < 400 && !/curl --unix-socket .*\/health/.test(log) && child.exitCode === null; i++) await new Promise(r => setTimeout(r, 50))
  assert.match(log, /Alex is listening\./, log)
  assert.ok(log.includes(`This computer only:      ${path.join(owner, 'data/control.sock')} (agentvoice join, the zoom-meeting channel)`), log)
  const health = await new Promise<string>((resolve, reject) => {
    http.get({ socketPath: path.join(owner, 'data/control.sock'), path: '/health' }, res => {
      let body = ''
      res.on('data', c => (body += c))
      res.on('end', () => resolve(body))
    }).on('error', reject)
  })
  assert.equal(JSON.parse(health).ok, true)
  // No process between: the signal reaches the service itself.
  child.kill('SIGTERM')
  assert.equal(await exited, 0, log)
  assert.match(log, /\[stop\] SIGTERM: ending 0 meeting session\(s\)/)
})

test('the command loads only home.ts and commands.ts before the command, and never changes folder', () => {
  const source = fs.readFileSync(path.join(ROOT, DISPATCHER), 'utf8')
  const top = [...source.matchAll(/^import .* from '([^']+)'$/gm)].map(m => m[1])
  assert.deepEqual(top, ['node:path', 'node:url'])
  const before = source.slice(0, source.indexOf('/** Each command, and its module under src/. */'))
  assert.deepEqual([...before.matchAll(/await import\('([^']+)'\)/g)].map(m => m[1]), ['../home.ts', '../commands.ts'])
  assert.doesNotMatch(source, /process\.chdir|INIT_CWD/)
})
