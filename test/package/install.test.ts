// npm run test:package: the package as npm users get it. It packs the repository (or takes AGENTVOICE_TARBALL, the
// tarball the release workflow will publish), installs it with npm install -g into a prefix of its own, with a home
// folder, npm cache and temporary folder of its own, and runs the agentvoice command from there: init, start and stop,
// the channel, slides prepare, check-name, service print and every setup, for the default AgentVoice folder and for an
// AGENTVOICE_HOME with a space in it; npx; and tsx's compile cache. Nothing may be written into the installed package,
// and a .env put there is never read. Not part of npm test: it downloads the dependencies, as npm users do.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { OPENCODE_TESTED } from '../../src/channel/push-opencode.ts'
import { PACKAGE_NAME } from '../../src/home.ts'
import { CODEX_TESTED } from '../../src/setup/codex.ts'
import { stableNodePath } from '../../src/setup/node-path.ts'
import { launchdPlist, systemdUnit } from '../../src/service/units.ts'
import { makePdf } from '../fixtures/slides/make-pdf.ts'
import { parseToml, type TomlTable } from '../toml.ts'
import { readTarball } from './check-package.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const UID = process.geteuid?.() ?? 0

// Everything in one folder of its own, outside /tmp on Linux: setup codex refuses a home folder there (Codex leaves
// placeholder files in the folders its commands may write). Not inside the repository either, so nothing the package
// needs can be found in the repository's node_modules.
function base(): string {
  if (process.env.RUNNER_TEMP) return process.env.RUNNER_TEMP
  if (process.platform !== 'linux') return os.tmpdir()
  try {
    fs.accessSync('/var/tmp', fs.constants.W_OK)
    return '/var/tmp'
  } catch {
    return assert.fail('test:package needs a folder outside /tmp to work in on Linux: /var/tmp, or RUNNER_TEMP')
  }
}
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(base(), 'av-package-')))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))
const PREFIX = path.join(TMP, 'prefix')
const PKG = path.join(PREFIX, 'lib/node_modules', PACKAGE_NAME)
const BIN = path.join(PREFIX, 'bin/agentvoice')
const HOME = path.join(TMP, 'home')
const TMPDIR = path.join(TMP, 'tmp')
const ELSEWHERE = path.join(TMP, 'elsewhere')
const FAKE = path.join(TMP, 'fakebin')
const CALLS = path.join(TMP, 'calls.log')
const NODE_DIR = path.dirname(process.execPath)
for (const dir of [HOME, TMPDIR, ELSEWHERE, FAKE]) fs.mkdirSync(dir)

/**
 * npm's environment: this test's home folder, cache and temporary folder, and none of the npm settings npm run passes
 * down (your own .npmrc among them), but the ones that reach the registry through a proxy.
 */
function npmEnv(): NodeJS.ProcessEnv {
  const keep = /^npm_config_(https?_proxy|proxy|noproxy|cafile|ca|strict_ssl|registry)$/i
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_/i.test(key) || keep.test(key)))
  return { ...env, HOME, TMPDIR, npm_config_cache: path.join(TMP, 'cache'), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' }
}
function npm(args: string[], cwd = TMP) {
  return spawnSync('npm', args, { cwd, env: npmEnv(), encoding: 'utf8', timeout: 600_000 })
}

/** A command's environment: only these, so nothing of this shell's settings reaches AgentVoice. */
function env(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const all: Record<string, string | undefined> = { PATH: [path.join(PREFIX, 'bin'), FAKE, NODE_DIR, '/usr/bin', '/bin'].join(':'), HOME, TMPDIR, LANG: 'C.UTF-8', ...extra }
  return Object.fromEntries(Object.entries(all).filter((entry): entry is [string, string] => entry[1] !== undefined))
}
function agentvoice(args: string[], extra: Record<string, string | undefined> = {}, cwd = ELSEWHERE) {
  return spawnSync(BIN, args, { cwd, env: env(extra), encoding: 'utf8', timeout: 120_000 })
}

/** Every file and folder in a folder, links not followed, with a hash of each file. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const name = path.join(rel, entry.name)
      const full = path.join(dir, name)
      if (entry.isDirectory()) {
        files[name] = `dir ${(fs.statSync(full).mode & 0o777).toString(8)}`
        walk(name)
      } else if (entry.isSymbolicLink()) files[name] = `link ${fs.readlinkSync(full)}`
      else files[name] = `${(fs.statSync(full).mode & 0o777).toString(8)} ${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`
    }
  }
  walk('')
  return files
}
const mode = (file: string) => fs.statSync(file).mode & 0o777

// Stand-ins for the coding clients, which record what they are asked (one JSON line a call) and answer as the real ones.
const CLAUDE = `#!/usr/bin/env node
const fs = require('fs'), path = require('path')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ cmd: 'claude', cwd: process.cwd(), args }) + '\\n')
if (args[0] === 'mcp' && args[1] === 'remove') process.exit(1)
if (args[0] === 'mcp' && args[1] === 'add') {
  const file = path.join(process.env.CLAUDE_CONFIG_DIR || process.env.HOME, '.claude.json')
  const j = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { projects: {} }
  const dash = args.indexOf('--'), e = args[args.indexOf('-e') + 1]
  j.projects[process.cwd()] = { mcpServers: { [args[4]]: { type: 'stdio', command: args[dash + 1], args: args.slice(dash + 2), env: { [e.slice(0, e.indexOf('='))]: e.slice(e.indexOf('=') + 1) } } } }
  fs.writeFileSync(file, JSON.stringify(j))
  console.log('Added stdio MCP server zoom-meeting to local config')
  process.exit(0)
}
process.exit(3)
`
const CODEX = `#!/usr/bin/env node
const args = process.argv.slice(2)
require('fs').appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ cmd: 'codex', cwd: process.cwd(), args }) + '\\n')
if (args[0] === '--version') { console.log('codex-cli ${CODEX_TESTED}'); process.exit(0) }
if (args.join(' ') === 'mcp list --json') { console.log('[]'); process.exit(0) }
process.exit(3)
`
const OPENCODE = `#!/usr/bin/env node
require('fs').appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ cmd: 'opencode', cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n')
if (process.argv[2] === '--version') { console.log('opencode v${OPENCODE_TESTED}'); process.exit(0) }
process.exit(3)
`
for (const [name, text] of [['claude', CLAUDE], ['codex', CODEX], ['opencode', OPENCODE]]) fs.writeFileSync(path.join(FAKE, name), text, { mode: 0o755 })
const calls = (): { cmd: string; cwd: string; args: string[] }[] =>
  fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []

let TARBALL = ''
let VERSION = ''
/** The installed package as npm left it, with a .env of the wrong owner's in it: what it must still be at the end. */
let BEFORE: Record<string, string> = {}

before(() => {
  if (process.env.AGENTVOICE_TARBALL) TARBALL = path.resolve(process.env.AGENTVOICE_TARBALL)
  else {
    const packed = npm(['pack', '--ignore-scripts', '--json', '--pack-destination', TMP], ROOT)
    assert.equal(packed.status, 0, packed.stderr)
    const r = JSON.parse(packed.stdout)
    TARBALL = path.join(TMP, (Array.isArray(r) ? r[0] : (Object.values(r)[0] as { filename: string })).filename)
  }
  VERSION = JSON.parse((readTarball(TARBALL).get('package.json') as Buffer).toString('utf8')).version
  const install = npm(['install', '-g', '--prefix', PREFIX, TARBALL])
  assert.equal(install.status, 0, install.stdout + install.stderr)
})

test('npm installs exactly the tarball\'s files, links agentvoice into the prefix, and nests the dependencies in the package', () => {
  const files = Object.entries(snapshot(PKG)).filter(([name, what]) => !name.startsWith('node_modules') && !what.startsWith('dir')).map(([name]) => name).sort()
  assert.deepEqual(files, [...readTarball(TARBALL).keys()].sort())
  assert.equal(fs.realpathSync(BIN), path.join(fs.realpathSync(PKG), 'bin/agentvoice.js'))
  assert.ok(fs.existsSync(path.join(PKG, 'node_modules/tsx/package.json')), "tsx is the package's own")
  assert.ok(!fs.existsSync(path.join(PKG, 'data')), 'no data/ in the package')
  // A .env in the package's folder, with the wrong owner and a port nothing could use: it must never be read.
  fs.writeFileSync(path.join(PKG, '.env'), 'OWNER_NAME=Decoy\nPORT=1\nAGENT_NAME=Decoy\n')
  BEFORE = snapshot(PKG)
})

const CASES = [
  { name: 'the default AgentVoice folder', home: path.join(HOME, '.agentvoice'), setting: undefined, shown: '~/.agentvoice' },
  { name: 'AGENTVOICE_HOME with a space in it', home: path.join(TMP, 'av home'), setting: path.join(TMP, 'av home'), shown: path.join(TMP, 'av home') },
]

for (const [n, c] of CASES.entries()) {
  const run = (args: string[], extra: Record<string, string | undefined> = {}, cwd = ELSEWHERE) => agentvoice(args, { AGENTVOICE_HOME: c.setting, ...extra }, cwd)
  const commandEnv = (extra: Record<string, string | undefined> = {}) => env({ AGENTVOICE_HOME: c.setting, ...extra })

  test(`${c.name}: --version, --help and init, which makes the folder only yours and keeps what is there`, { timeout: 120_000 }, () => {
    const version = run(['--version'])
    assert.equal(version.status, 0, version.stderr)
    assert.equal(version.stdout, `${VERSION}\n`)
    const help = run(['--help'])
    assert.equal(help.status, 0, help.stderr)
    assert.match(help.stdout, new RegExp(`^AgentVoice ${VERSION.replaceAll('.', '\\.')}: `))
    assert.ok(help.stdout.includes(`Your settings: ${c.shown}/.env, in ${c.shown}.`), help.stdout)

    const init = run(['init'])
    assert.equal(init.status, 0, init.stderr)
    assert.equal(mode(c.home), 0o700)
    for (const dir of ['data', 'briefs']) assert.equal(mode(path.join(c.home, dir)), 0o700, dir)
    for (const [file, example] of [['.env', '.env.example'], ['profile.md', 'profile.example.md'], ['data/brief.md', 'brief.example.md']]) {
      assert.equal(mode(path.join(c.home, file)), 0o600, file)
      assert.equal(fs.readFileSync(path.join(c.home, file), 'utf8'), fs.readFileSync(path.join(PKG, example), 'utf8'), file)
    }
    fs.appendFileSync(path.join(c.home, 'profile.md'), '\nMine now.\n')
    const again = run(['init'])
    assert.equal(again.status, 0, again.stderr)
    assert.match(again.stdout, /kept .*profile\.md/)
    assert.match(fs.readFileSync(path.join(c.home, 'profile.md'), 'utf8'), /Mine now\.\n$/)
    assert.equal(mode(path.join(c.home, '.env')), 0o600)

    // Test values only: no real key, and no ElevenLabs settings, so the service calls no one at start.
    fs.writeFileSync(
      path.join(c.home, '.env'),
      [
        'OWNER_NAME=Robin',
        'ANTHROPIC_API_KEY=test-not-a-key',
        'DEEPGRAM_API_KEY=test-not-a-key',
        'ELEVENLABS_API_KEY=',
        'ELEVENLABS_VOICE_ID=',
        'RECALL_API_KEY=test-not-a-key',
        'RECALL_REGION=us-east-1',
        `AGENT_PAGE_TOKEN=${crypto.randomBytes(24).toString('hex')}`,
        'PUBLIC_URL=https://agentvoice.example.com',
        'PORT=0',
        'HOST=127.0.0.1',
        // Ignored, with a line that names the .env it was read from (the channel's).
        'AGENTVOICE_CLIENT=codex',
        '',
      ].join('\n'),
    )
    assert.equal(mode(path.join(c.home, '.env')), 0o600)
  })

  test(`${c.name}: agentvoice start, from another folder, keeps its token and socket in the AgentVoice folder, and stops on SIGTERM`, { timeout: 120_000 }, async () => {
    const child = spawn(BIN, ['start'], { cwd: ELSEWHERE, env: commandEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''
    child.stdout.on('data', chunk => (log += chunk))
    child.stderr.on('data', chunk => (log += chunk))
    const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)))
    try {
      const banner = /is listening\.[\s\S]*curl --unix-socket .*\/health/
      for (let i = 0; i < 600 && !banner.test(log) && child.exitCode === null; i++) await new Promise(r => setTimeout(r, 50))
      assert.match(log, banner)
      assert.match(log, /fixed lines will stream live/)
      assert.doesNotMatch(log, /\[tts\] could not make/)
      assert.doesNotMatch(log, /Decoy/, "the package's .env is not read")
      const data = path.join(c.home, 'data')
      const health = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        http.get({ socketPath: path.join(data, 'control.sock'), path: '/health' }, res => {
          let body = ''
          res.on('data', chunk => (body += chunk))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
        }).on('error', reject)
      })
      assert.equal(health.status, 200, health.body)
      assert.equal(mode(path.join(data, 'local-token')), 0o600)
      assert.equal(mode(data), 0o700)
      assert.equal(mode(c.home), 0o700)
    } finally {
      child.kill('SIGTERM')
    }
    assert.equal(await exited, 0, log)
  })

  test(`${c.name}: agentvoice channel speaks MCP from its first line, with the owner and the words of the AgentVoice folder`, { timeout: 120_000 }, async t => {
    // The first line on stdout is the answer to initialize: nothing before it.
    const raw: ChildProcessWithoutNullStreams = spawn(BIN, ['channel'], { cwd: ELSEWHERE, env: commandEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
    t.after(() => raw.kill('SIGKILL'))
    const first = await new Promise<string>((resolve, reject) => {
      let out = ''
      raw.stdout.on('data', chunk => {
        out += chunk
        if (out.includes('\n')) resolve(out.slice(0, out.indexOf('\n')))
      })
      raw.on('exit', code => reject(new Error(`exited (${code}) before a line on stdout: ${JSON.stringify(out)}`)))
      raw.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } })}\n`)
    })
    assert.deepEqual(JSON.parse(first).result.serverInfo, { name: 'zoom-meeting', version: VERSION })
    raw.kill('SIGTERM')

    const transport = new StdioClientTransport({ command: BIN, args: ['channel'], env: commandEnv(), cwd: ELSEWHERE, stderr: 'pipe' })
    let stderr = ''
    transport.stderr?.on('data', chunk => (stderr += chunk))
    const client = new Client({ name: 'test', version: '0' })
    t.after(() => client.close())
    await client.connect(transport)
    const instructions = client.getInstructions() ?? ''
    assert.match(instructions, /Alex, Robin's AI assistant/, 'the owner from the AgentVoice folder\'s .env')
    assert.doesNotMatch(instructions, /Decoy/)
    assert.match(instructions, /agentvoice slides prepare/)
    assert.doesNotMatch(instructions, /npm run/)
    for (let i = 0; i < 200 && !/The voice service is not running/.test(stderr); i++) await new Promise(r => setTimeout(r, 50))
    assert.ok(stderr.includes(`[client] AGENTVOICE_CLIENT in ${c.shown}/.env is ignored`), stderr)
    assert.ok(stderr.includes(`nothing is listening on ${path.join(c.home, 'data/control.sock')}`), stderr)
  })

  test(`${c.name}: slides prepare from another folder, check-name with the shipped corpus, and service print`, { timeout: 180_000 }, () => {
    const talks = path.join(TMP, `talks-${n}`)
    fs.mkdirSync(talks)
    fs.writeFileSync(path.join(talks, 'deck.pdf'), makePdf([{ texts: [{ text: 'Roadmap', size: 40 }] }, { texts: [{ text: 'Thanks', size: 40 }] }]))
    const prepared = run(['slides', 'prepare', 'deck.pdf'], {}, talks)
    assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr)
    assert.equal(fs.readdirSync(path.join(c.home, 'data/decks')).filter(name => !name.startsWith('.')).length, 1)
    assert.ok(fs.existsSync(path.join(talks, 'deck.script.md')), 'the script beside the PDF')
    assert.match(prepared.stdout, /agentvoice slides check deck\.script\.md/)

    const name = run(['check-name', 'Alex'])
    assert.equal(name.status, 0, name.stderr)
    assert.match(name.stdout, /Read 1,859 meeting lines with it/)

    const input = { label: 'local.agent-voice', home: c.home, node: stableNodePath(process.execPath), bin: path.join(fs.realpathSync(PKG), 'bin/agentvoice.js'), version: VERSION }
    const systemd = run(['service', 'print', 'systemd'])
    assert.equal(systemd.status, 0, systemd.stderr)
    assert.equal(systemd.stdout, systemdUnit(input))
    const launchd = run(['service', 'print', 'launchd'])
    assert.equal(launchd.status, 0, launchd.stderr)
    assert.equal(launchd.stdout, launchdPlist(input))
    for (const text of [systemd.stdout, launchd.stdout]) {
      assert.ok(text.includes(path.join(PREFIX, 'lib/node_modules', PACKAGE_NAME, 'bin/agentvoice.js')), text)
      assert.doesNotMatch(text, /node_modules\/tsx/)
    }
  })

  test(`${c.name}: setup claude-code, codex and opencode make a new session folder, and each config starts the channel`, { timeout: 300_000 }, async t => {
    const session = path.join(TMP, `session-${n}`)
    const node = stableNodePath(process.execPath)
    const bin = path.join(fs.realpathSync(PKG), 'bin/agentvoice.js')
    /** The channel, by a config's own command and environment, with no node on PATH. */
    const starts = async (command: string[], configEnv: Record<string, string>) => {
      const transport = new StdioClientTransport({ command: command[0], args: command.slice(1), env: { PATH: '/usr/bin:/bin', HOME, TMPDIR, ...configEnv }, cwd: session, stderr: 'pipe' })
      const client = new Client({ name: 'test', version: '0' })
      t.after(() => client.close())
      await client.connect(transport)
      assert.deepEqual(client.getServerVersion(), { name: 'zoom-meeting', version: VERSION })
      assert.ok((await client.listTools()).tools.some(tool => tool.name === 'next_question'))
      await client.close()
    }
    fs.rmSync(CALLS, { force: true })

    const claude = run(['setup', 'claude-code', session])
    assert.equal(claude.status, 0, claude.stdout + claude.stderr)
    assert.match(claude.stdout, /^Made .*session-\d \(only you can open it\)\./)
    assert.equal(mode(session), 0o700)
    assert.equal(fs.readFileSync(path.join(session, '.claude/settings.json'), 'utf8'), fs.readFileSync(path.join(PKG, '.claude/settings.json'), 'utf8'))
    assert.equal(fs.readFileSync(path.join(session, '.claude/agents/meeting-assistant.md'), 'utf8'), fs.readFileSync(path.join(PKG, '.claude/agents/meeting-assistant.md'), 'utf8'))
    const allow = JSON.parse(fs.readFileSync(path.join(session, '.claude/settings.local.json'), 'utf8')).permissions.allow as string[]
    assert.ok(allow.includes(`Read(/${c.home}/data/transcripts/**)`) && allow.includes(`Read(/${c.home}/data/minutes/**)`), allow.join('\n'))
    const added = calls().find(call => call.cmd === 'claude' && call.args[1] === 'add')
    assert.deepEqual(added?.args, ['mcp', 'add', '--scope', 'local', 'zoom-meeting', '-e', `AGENTVOICE_HOME=${c.home}`, '--', node, bin, 'channel'])
    await starts([node, bin, 'channel'], { AGENTVOICE_HOME: c.home })

    const codex = run(['setup', 'codex', session])
    assert.equal(codex.status, 0, codex.stdout + codex.stderr)
    const toml = parseToml(fs.readFileSync(path.join(session, '.codex/config.toml'), 'utf8'))
    const server = (toml.mcp_servers as TomlTable)['zoom-meeting'] as TomlTable
    assert.deepEqual([server.command, server.args, server.env], [node, [bin, 'channel'], { AGENTVOICE_CLIENT: 'codex', AGENTVOICE_HOME: c.home }])
    assert.equal(fs.readFileSync(path.join(session, '.codex/agents/meeting-assistant.toml'), 'utf8'), fs.readFileSync(path.join(PKG, '.codex/agents/meeting-assistant.toml'), 'utf8'))
    await starts([server.command as string, ...(server.args as string[])], server.env as Record<string, string>)

    const opencode = run(['setup', 'opencode', session])
    assert.equal(opencode.status, 0, opencode.stdout + opencode.stderr)
    const json = JSON.parse(fs.readFileSync(path.join(session, 'opencode.json'), 'utf8'))
    const oc = json.mcp.servers['zoom-meeting']
    assert.deepEqual([oc.command, oc.environment], [[node, bin, 'channel'], { AGENTVOICE_CLIENT: 'opencode', AGENTVOICE_HOME: c.home }])
    assert.ok(JSON.stringify(json.permissions).includes('*agentvoice* slides *'))
    assert.equal(fs.readFileSync(path.join(session, '.opencode/agents/meeting-assistant.md'), 'utf8'), fs.readFileSync(path.join(PKG, '.opencode/agents/meeting-assistant.md'), 'utf8'))
    await starts(oc.command, oc.environment)

    // Again there: it refreshes setup's own files.
    const again = run(['setup', 'claude-code'], {}, session)
    assert.equal(again.status, 0, again.stdout + again.stderr)
    assert.doesNotMatch(again.stdout, /^Made /m)
    const manifest = JSON.parse(fs.readFileSync(path.join(session, '.agentvoice-setup.json'), 'utf8'))
    assert.deepEqual([manifest.version, manifest.home, Object.keys(manifest.clients).sort()], [VERSION, c.home, ['claude-code', 'codex', 'opencode']])

    // A folder with someone's file in it: refused, nothing written.
    const notes = path.join(TMP, `notes-${n}`)
    fs.mkdirSync(notes)
    fs.writeFileSync(path.join(notes, 'todo.md'), 'x\n')
    const refused = run(['setup', 'claude-code', notes])
    assert.equal(refused.status, 1, refused.stdout)
    assert.match(refused.stderr, /already holds files that agentvoice setup didn't make\./)
    assert.deepEqual(fs.readdirSync(notes), ['todo.md'])
  })
}

test('npx runs the tarball too, and setup refuses there: a config can\'t point into npx\'s cache', { timeout: 600_000 }, () => {
  const npx = (args: string[]) => spawnSync('npx', ['--yes', `--package=${TARBALL}`, '--', 'agentvoice', ...args], { cwd: ELSEWHERE, env: { ...npmEnv(), PATH: env().PATH }, encoding: 'utf8', timeout: 600_000 })
  const version = npx(['--version'])
  assert.equal(version.status, 0, version.stderr)
  assert.equal(version.stdout.trim().split('\n').at(-1), VERSION)
  const setup = npx(['setup', 'claude-code', path.join(TMP, 'npx-session')])
  assert.equal(setup.status, 1, setup.stdout)
  assert.match(setup.stderr, new RegExp(`Install AgentVoice first \\(npm install -g ${PACKAGE_NAME.replace('/', '\\/')}\\): a client config can't point into npx's cache, which npm clears\\.`))
  assert.ok(!fs.existsSync(path.join(TMP, 'npx-session')))
})

test("tsx's compile cache: the bin uses tsx's own folder, 0700, and never one others can write or a link", { timeout: 120_000 }, () => {
  const tmpdir = path.join(TMP, 'tsx-test')
  fs.mkdirSync(tmpdir)
  const cache = path.join(tmpdir, `tsx-${UID}`)
  const version = () => {
    const r = agentvoice(['--version'], { TMPDIR: tmpdir })
    assert.equal(r.stderr, '')
    return r.stdout
  }
  assert.equal(version(), `${VERSION}\n`)
  assert.ok(fs.lstatSync(cache).isDirectory(), "tsx's own folder name")
  assert.equal(mode(cache), 0o700)
  assert.ok(fs.readdirSync(cache).length > 0, 'with entries in it')
  // The control: an entry rewritten in a folder the bin trusts runs.
  const entries = fs.readdirSync(cache).filter(name => fs.readFileSync(path.join(cache, name), 'utf8').includes('Unknown command'))
  assert.ok(entries.length > 0, fs.readdirSync(cache).join(', '))
  for (const name of entries) {
    const file = path.join(cache, name)
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), code: 'console.log("PLANTED")' }))
  }
  assert.equal(version(), 'PLANTED\n')
  fs.chmodSync(cache, 0o777)
  assert.equal(version(), `${VERSION}\n`, 'a folder others can write')
  fs.chmodSync(cache, 0o700)
  const real = path.join(tmpdir, 'planted')
  fs.renameSync(cache, real)
  fs.symlinkSync(real, cache)
  assert.equal(version(), `${VERSION}\n`, 'a link to a folder with the planted entry')
})

test('nothing was written into the installed package, and its .env was never read', () => {
  assert.deepEqual(snapshot(PKG), BEFORE)
  assert.ok(!fs.existsSync(path.join(PKG, 'data')))
})
