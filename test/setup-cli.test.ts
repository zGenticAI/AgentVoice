// agentvoice setup claude-code|codex|opencode, run as the installed command (the bin of a package laid out as npm
// install -g makes it: test/layouts.ts) with stand-in claude, codex and opencode commands that record what they are
// asked: the session folder it makes, what each client is told, what setup says, and what it refuses before writing
// anything. The files themselves are checked in test/setup-files.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ROOT } from '../src/config.ts'
import { CLONE_SETUP, DOCS_URL, cloneRefusal } from '../src/commands.ts'
import { PACKAGE_NAME, PACKAGE_VERSION, isWithin } from '../src/home.ts'
import { CODEX_TESTED } from '../src/setup/codex.ts'
import { MANIFEST } from '../src/setup/files.ts'
import { agentvoiceCommand } from '../src/setup/node-path.ts'
import { agentvoice, cloneCopy, command, envFor, installedPackage, snapshot, tempDir } from './layouts.ts'
import { parseToml, type TomlTable } from './toml.ts'

type Ctx = { after: (fn: () => unknown) => void }

// Stand-ins for the clients: each records its arguments and folder in $FAKE_LOG, one JSON line a call.
const CLAUDE = `#!/usr/bin/env node
const fs = require('fs'), path = require('path')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ cmd: 'claude', cwd: process.cwd(), args }) + '\\n')
if (args[0] === 'mcp' && args[1] === 'remove') process.exit(args[3] === 'user' && process.env.FAKE_CLAUDE_USER === 'yes' ? 0 : 1)
if (args[0] === 'mcp' && args[1] === 'add') {
  if (process.env.FAKE_CLAUDE_ADD_FAIL) { console.error('Invalid environment variable format: zoom-meeting'); process.exit(1) }
  console.log('Added stdio MCP server zoom-meeting to local config')
  if (process.env.FAKE_CLAUDE_NO_WRITE) process.exit(0)
  const file = path.join(process.env.CLAUDE_CONFIG_DIR || process.env.HOME, '.claude.json')
  const j = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { projects: {} }
  const dash = args.indexOf('--'), e = args.indexOf('-e')
  const [name, value] = [args[e + 1].slice(0, args[e + 1].indexOf('=')), args[e + 1].slice(args[e + 1].indexOf('=') + 1)]
  j.projects[process.env.FAKE_CLAUDE_KEY || process.cwd()] = { mcpServers: { [args[4]]: { type: 'stdio', command: args[dash + 1], args: args.slice(dash + 2), env: { [name]: value } } } }
  fs.writeFileSync(file, JSON.stringify(j))
  process.exit(0)
}
process.exit(3)
`
const CODEX = `#!/usr/bin/env node
const fs = require('fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ cmd: 'codex', cwd: process.cwd(), args }) + '\\n')
console.error('WARNING: proceeding, even though we could not create PATH aliases')
if (args[0] === '--version') { console.log('codex-cli ' + process.env.FAKE_CODEX_VERSION); process.exit(0) }
if (args.join(' ') === 'mcp list --json') {
  if (process.cwd() === process.env.FAKE_SESSION) {
    if (process.env.FAKE_FAIL) { console.error('Error: failed to load configuration\\n\\nCaused by:\\n    ' + process.env.FAKE_FAIL + '\\n\\nStack backtrace:\\n   0: <unknown>'); process.exit(1) }
    console.log(process.env.FAKE_HERE || '[]')
  } else console.log(process.env.FAKE_ELSEWHERE || '[]')
  process.exit(0)
}
process.exit(3)
`
const OPENCODE = `#!/usr/bin/env node
const fs = require('fs')
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ cmd: 'opencode', cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n')
if (process.argv[2] === '--version') { console.log('opencode v' + process.env.FAKE_OPENCODE_VERSION); process.exit(0) }
process.exit(3)
`

/**
 * A home folder outside /tmp and the temporary folder, which setup codex refuses on Linux (Codex leaves placeholders
 * there): in this checkout's node_modules/.cache, or /dev/shm. Removed after the test.
 */
function ownerHome(t: Ctx): string {
  const linux = process.platform === 'linux'
  for (const base of [path.join(ROOT, 'node_modules', '.cache'), '/dev/shm', ...(linux ? [] : [os.tmpdir()])]) {
    try {
      fs.mkdirSync(base, { recursive: true })
      if (linux && (isWithin(base, '/tmp') || isWithin(base, os.tmpdir()))) continue
      const home = fs.realpathSync(fs.mkdtempSync(path.join(base, 'av-setup-home-')))
      t.after(() => fs.rmSync(home, { recursive: true, force: true }))
      return home
    } catch {
      // Not there, or not ours to write: the next one.
    }
  }
  return assert.fail('no folder outside /tmp and the temporary folder to make a home folder in')
}

interface Options {
  /** The home folder: the layout's own (in /tmp) unless given. */
  home?: string
  /** Run init first (the default), so .env is there. */
  init?: boolean
}

/** An installed package with stand-in clients, init run for its home folder; run() runs agentvoice with them on PATH. */
function sandbox(t: Ctx, o: Options = {}) {
  const at = installedPackage(t)
  const home = o.home ?? at.home
  const fake = path.join(at.tmp, 'fakebin')
  fs.mkdirSync(fake)
  for (const [name, text] of [['claude', CLAUDE], ['codex', CODEX], ['opencode', OPENCODE]]) fs.writeFileSync(path.join(fake, name), text, { mode: 0o755 })
  const log = path.join(at.tmp, 'calls.log')
  const tmpdir = path.join(at.tmp, 'tmpdir')
  fs.mkdirSync(tmpdir)
  const session = path.join(at.tmp, 'session')
  const owner = path.join(home, '.agentvoice')
  const nodeDir = path.dirname(process.execPath)
  const env = (extra: Record<string, string | undefined> = {}) =>
    envFor({ HOME: home, PATH: [fake, nodeDir, '/usr/bin', '/bin'].join(':'), TMPDIR: tmpdir, FAKE_LOG: log, FAKE_SESSION: session, FAKE_CODEX_VERSION: CODEX_TESTED, FAKE_OPENCODE_VERSION: '2.3.2', CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, ...extra })
  const run = (args: string[], extra: Record<string, string | undefined> = {}, cwd = at.elsewhere) => agentvoice(at.pkg, args, env(extra), cwd)
  if (o.init !== false) {
    const init = run(['init'])
    assert.equal(init.status, 0, init.stderr)
    fs.appendFileSync(path.join(owner, '.env'), '\nOWNER_NAME=Sam\n')
  }
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [])
  const [node, bin] = agentvoiceCommand(process.execPath, at.pkg)
  return { ...at, home, owner, session, tmpdir, fake, nodeDir, env, run, calls, node, bin, pkgBefore: snapshot(at.pkg) }
}

/** The channel, started by a client's command and only the environment its config gives it (no PATH with node in it). */
async function channelStarts(t: Ctx, commandLine: string[], env: Record<string, string>, cwd: string) {
  const transport = new StdioClientTransport({ command: commandLine[0], args: commandLine.slice(1), env: { PATH: '/usr/bin:/bin', ...env }, cwd, stderr: 'pipe' })
  let stderr = ''
  transport.stderr?.on('data', chunk => (stderr += chunk))
  const client = new Client({ name: 'test', version: '0' })
  t.after(() => client.close())
  await client.connect(transport)
  const tools = (await client.listTools()).tools.map(tool => tool.name)
  return { version: client.getServerVersion(), instructions: client.getInstructions() ?? '', tools, stderr: () => stderr }
}

test('setup claude-code makes the session folder, writes the package floor and agent, and registers the channel for that folder only', { timeout: 120_000 }, async t => {
  const s = sandbox(t)
  const homeBefore = snapshot(s.home)
  const r = s.run(['setup', 'claude-code', s.session])
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.equal(r.stderr, '')
  assert.equal(
    r.stdout,
    [
      `Made ${s.session} (only you can open it).`,
      'Made it a Git repository of its own (git init), so Claude Code takes it as the project.',
      'Added stdio MCP server zoom-meeting to local config',
      `Done. The zoom-meeting channel is registered for ${s.session} only, with the floor and the meeting-assistant agent.`,
      'Allowed for the meeting-assistant in .claude/settings.local.json: its six channel tools, and reading the transcripts',
      `and minutes in ~/.agentvoice/data. Allow your knowledge sources there too (see ${DOCS_URL}/v${PACKAGE_VERSION}/docs/claude-code.md).`,
      'Before a meeting, start Claude Code in this folder with the channel loaded:',
      `  cd "${s.session}" && claude --dangerously-load-development-channels server:zoom-meeting`,
      'or resume a session there with --resume. Run agentvoice setup claude-code again after upgrading AgentVoice or Node.',
      '',
    ].join('\n'),
  )
  // Claude Code is told: take away an earlier install's registration for every project, this folder's own, then add
  // it for this folder, with the server's name before -e (which takes several values).
  assert.deepEqual(s.calls(), [
    { cmd: 'claude', cwd: s.session, args: ['mcp', 'remove', '--scope', 'user', 'zoom-meeting'] },
    { cmd: 'claude', cwd: s.session, args: ['mcp', 'remove', '--scope', 'local', 'zoom-meeting'] },
    { cmd: 'claude', cwd: s.session, args: ['mcp', 'add', '--scope', 'local', 'zoom-meeting', '-e', `AGENTVOICE_HOME=${s.owner}`, '--', s.node, s.bin, 'channel'] },
  ])
  assert.equal(s.bin, path.join(s.pkg, 'bin/agentvoice.js'))
  assert.equal(fs.statSync(s.session).mode & 0o777, 0o700)
  assert.ok(fs.existsSync(path.join(s.session, '.git')))
  assert.equal(fs.readFileSync(path.join(s.session, '.claude/settings.json'), 'utf8'), fs.readFileSync(path.join(ROOT, '.claude/settings.json'), 'utf8'))
  assert.equal(fs.readFileSync(path.join(s.session, '.claude/agents/meeting-assistant.md'), 'utf8'), fs.readFileSync(path.join(ROOT, '.claude/agents/meeting-assistant.md'), 'utf8'))
  const allow = JSON.parse(fs.readFileSync(path.join(s.session, '.claude/settings.local.json'), 'utf8')).permissions.allow
  assert.deepEqual(allow.slice(-2), [`Read(/${s.owner}/data/transcripts/**)`, `Read(/${s.owner}/data/minutes/**)`])
  const manifest = JSON.parse(fs.readFileSync(path.join(s.session, MANIFEST), 'utf8'))
  assert.deepEqual([manifest.package, manifest.version, manifest.home, manifest.command], [PACKAGE_NAME, PACKAGE_VERSION, s.owner, [s.node, s.bin, 'channel']])
  // Nothing written outside the folder: the home folder (the AgentVoice folder in it) is as it was, but for the
  // .claude.json the stand-in Claude Code wrote; nothing in the package.
  const homeAfter = snapshot(s.home)
  delete homeAfter['.claude.json']
  assert.deepEqual(homeAfter, homeBefore)
  assert.deepEqual(snapshot(s.pkg), s.pkgBefore)

  // The channel starts by the very command registered, with only the environment Claude Code gives it.
  const added = s.calls()[2].args as string[]
  const started = await channelStarts(t, added.slice(added.indexOf('--') + 1), { AGENTVOICE_HOME: s.owner, HOME: s.home, TMPDIR: s.tmpdir }, s.session)
  assert.equal(started.version?.name, 'zoom-meeting')
  assert.ok(started.tools.includes('next_question'), started.tools.join(', '))
  assert.match(started.instructions, /agentvoice slides prepare/)
  assert.doesNotMatch(started.instructions, /npm run/)

  // Again in the same folder: it refreshes, and says when it took away a registration for every project.
  fs.rmSync(path.join(s.tmp, 'calls.log'), { force: true })
  const again = s.run(['setup', 'claude-code'], { FAKE_CLAUDE_USER: 'yes' }, s.session)
  assert.equal(again.status, 0, again.stderr)
  assert.match(again.stdout, /^Removed the zoom-meeting channel an earlier install registered for all your projects\.\nAdded stdio MCP server/)
  assert.doesNotMatch(again.stdout, /Made /)
  assert.deepEqual(snapshot(s.pkg), s.pkgBefore)
})

test("setup claude-code refuses a folder with someone's files in it, and says when Claude Code put the channel elsewhere or refused it", { timeout: 120_000 }, t => {
  const s = sandbox(t)
  const notes = path.join(s.tmp, 'notes')
  fs.mkdirSync(notes)
  fs.writeFileSync(path.join(notes, 'todo.md'), 'x')
  const before = [snapshot(notes), snapshot(s.home)]
  const r = s.run(['setup', 'claude-code', notes])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /notes already holds files that agentvoice setup didn't make\./)
  assert.deepEqual(s.calls(), [], 'Claude Code was not asked anything')
  assert.deepEqual([snapshot(notes), snapshot(s.home)], before, 'nothing written')

  // Recorded for a folder around this one: not this folder's.
  const outer = s.run(['setup', 'claude-code', s.session], { FAKE_CLAUDE_KEY: s.tmp })
  assert.equal(outer.status, 1, outer.stdout)
  assert.equal(outer.stderr, `Claude Code registered it for ${s.tmp}, not this folder (${s.session}).\n`)
  // Not recorded where setup can read it back: said, and the way to check.
  fs.rmSync(path.join(s.home, '.claude.json'), { force: true })
  const unread = s.run(['setup', 'claude-code', s.session], { FAKE_CLAUDE_NO_WRITE: '1' })
  assert.equal(unread.status, 0, unread.stderr)
  assert.match(unread.stdout, /Warning: .*\.claude\.json couldn't be read, so setup couldn't confirm what Claude Code registered\. Check it with: claude mcp get zoom-meeting/)
  // Refused by Claude Code: said, with what it said.
  const refused = s.run(['setup', 'claude-code', s.session], { FAKE_CLAUDE_ADD_FAIL: '1' })
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /^claude mcp add failed \(exit 1\), so the channel is not registered: Invalid environment variable format: zoom-meeting$/m)
})

test('setup codex writes the config by absolute paths, checks what Codex makes of it, and says how to trust the folder', { timeout: 120_000 }, t => {
  const s = sandbox(t, { home: ownerHome(t) })
  const homeBefore = snapshot(s.home)
  const r = s.run(['setup', 'codex', s.session])
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const config = parseToml(fs.readFileSync(path.join(s.session, '.codex/config.toml'), 'utf8'))
  const server = (config.mcp_servers as TomlTable)['zoom-meeting'] as TomlTable
  assert.deepEqual([server.command, server.args, server.env], [s.node, [s.bin, 'channel'], { AGENTVOICE_CLIENT: 'codex', AGENTVOICE_HOME: s.owner }])
  const filesystem = ((config.permissions as TomlTable).agentvoice as TomlTable).filesystem as TomlTable
  assert.equal(filesystem['~/.agentvoice/.env'], 'deny')
  assert.equal(filesystem['~/.agentvoice/data/local-token'], 'deny')
  assert.equal(fs.readFileSync(path.join(s.session, '.codex/agents/meeting-assistant.toml'), 'utf8'), fs.readFileSync(path.join(ROOT, '.codex/agents/meeting-assistant.toml'), 'utf8'))
  assert.match(r.stdout, new RegExp(`^Made .*session \\(only you can open it\\)\\.\\nMade it a Git repository of its own \\(git init\\), so Codex takes it as the project\\.\\nDone \\(Codex ${CODEX_TESTED.replaceAll('.', '\\.')}\\)\\.`))
  assert.ok(r.stdout.includes(`Start Codex at the root of this folder:\n  cd "${s.session}" && codex\n`), r.stdout)
  assert.ok(
    r.stdout.includes(
      `Codex doesn't load this folder's config yet: it reads .codex/ only in a folder you trust. The first time you start\nCodex here it asks whether you trust the folder: choose "Trust and continue". If you once chose not to, set\n  [projects."${s.session}"]\n  trust_level = "trusted"\nin ~/.codex/config.toml. Then run agentvoice setup codex again here to check.`,
    ),
    r.stdout,
  )
  assert.match(r.stdout, /Don't start Codex here with --sandbox \(-s\) or --dangerously-bypass-approvals-and-sandbox: either replaces the floor\./)
  // Codex was asked from an empty folder (your own config) and from the session folder.
  const lists = s.calls().filter(call => call.args.join(' ') === 'mcp list --json')
  assert.equal(lists.length, 2)
  assert.notEqual(lists[0].cwd, s.session)
  assert.equal(lists[1].cwd, s.session)
  assert.ok(!fs.existsSync(lists[0].cwd), 'the empty folder is removed')
  assert.deepEqual(snapshot(s.home), homeBefore, 'nothing written in the home folder')

  // Once trusted: Codex loads it, by this command, as Codex.
  const ours = JSON.stringify([{ name: 'zoom-meeting', transport: { type: 'stdio', command: s.node, args: [s.bin, 'channel'], env: { AGENTVOICE_CLIENT: 'codex', AGENTVOICE_HOME: s.owner } } }])
  const trusted = s.run(['setup', 'codex'], { FAKE_HERE: ours, CODEX_HOME: '/srv/codex' }, s.session)
  assert.equal(trusted.status, 0, trusted.stderr)
  assert.match(trusted.stdout, /Codex trusts this folder and loads its config: the zoom-meeting channel, the meeting-assistant and the floor\./)
  assert.doesNotMatch(trusted.stdout, /trust_level|Made /)
  // A clone's command (or anything else) is not this folder's; one in your own config is said.
  const theirs = JSON.stringify([{ name: 'zoom-meeting', transport: { command: 'node_modules/.bin/tsx', args: ['src/channel/server.ts'], env: { AGENTVOICE_CLIENT: 'codex' } } }])
  const other = s.run(['setup', 'codex', s.session], { FAKE_HERE: theirs, FAKE_ELSEWHERE: theirs, CODEX_HOME: '/srv/codex' })
  assert.equal(other.status, 0, other.stderr)
  assert.match(other.stdout, /^Your own Codex config \(\/srv\/codex\/config\.toml\) registers a zoom-meeting server for every project, perhaps with codex mcp add\.\nRemove it, as this folder's config registers the channel for this folder only:\n {2}codex mcp remove zoom-meeting\n/)
  assert.match(other.stdout, /in \/srv\/codex\/config\.toml\. Then run agentvoice setup codex again here to check\./)
  // A config Codex can't load: what Codex said, without its backtrace.
  const broken = s.run(['setup', 'codex', s.session], { FAKE_FAIL: 'unknown variant `agentvoice`' })
  assert.equal(broken.status, 1)
  assert.match(broken.stderr, /^Codex can't load its config \(run from .*session\):\nError: failed to load configuration\n\nCaused by:\n {4}unknown variant `agentvoice`\n$/)
  assert.deepEqual(snapshot(s.pkg), s.pkgBefore)
})

test('setup codex checks Codex first, and refuses a home or AgentVoice folder in /tmp on Linux, writing nothing', { timeout: 120_000 }, t => {
  const s = sandbox(t, { home: ownerHome(t) })
  const refused = (args: string[], extra: Record<string, string | undefined>, why: RegExp) => {
    const r = s.run(args, extra)
    assert.equal(r.status, 1, r.stdout)
    assert.match(r.stderr, why)
    assert.ok(!fs.existsSync(s.session), 'no folder made')
  }
  refused(['setup', 'codex', s.session], { FAKE_CODEX_VERSION: '0.170.9' }, /^Codex 0\.170\.9 is older than 0\.171\.0, the earliest AgentVoice supports: update it \(npm install -g @openai\/codex\)\.\n$/)
  refused(['setup', 'codex', s.session], { FAKE_CODEX_VERSION: '' }, /Could not tell which Codex this is/)
  fs.renameSync(path.join(s.fake, 'codex'), path.join(s.fake, 'codex.off'))
  refused(['setup', 'codex', s.session], {}, /^Codex is not installed \(no codex command\)\. Install Codex 0\.171\.0 or later: npm install -g @openai\/codex\n$/)
  fs.renameSync(path.join(s.fake, 'codex.off'), path.join(s.fake, 'codex'))
  const newer = s.run(['setup', 'codex', s.session], { FAKE_CODEX_VERSION: '0.172.0' })
  assert.equal(newer.status, 0, newer.stderr)
  assert.match(newer.stdout, /^Note: Codex 0\.172\.0 is newer than AgentVoice was tested with \(0\.171\.0\)\. If something fails, tell us\.\n/)
  fs.rmSync(s.session, { recursive: true })
  if (process.platform !== 'linux') return
  // On Linux, Codex leaves placeholders for denied paths in the folders its commands may write.
  const inTmp = tempDir(t, 'av-home-in-tmp-')
  fs.cpSync(s.owner, path.join(inTmp, '.agentvoice'), { recursive: true })
  refused(['setup', 'codex', s.session], { HOME: inTmp }, /^Your home folder \(.*\) is inside \/tmp, a folder where Codex's sandbox lets commands write\./)
  const avInTmp = path.join(inTmp, 'av')
  fs.cpSync(s.owner, avInTmp, { recursive: true })
  refused(['setup', 'codex', s.session], { AGENTVOICE_HOME: avInTmp }, /^Your AgentVoice folder \(.*\/av\) is inside \/tmp, a folder where Codex's sandbox lets commands write\. There, Codex makes empty, read-only placeholders for the floor's entries that don't exist \(data\/local-token among them\)/)
  refused(['setup', 'codex', s.session], { TMPDIR: path.dirname(s.home) }, /^Your home folder \(.*\) is inside /)
})

test('setup opencode writes opencode.json by absolute paths with AGENTVOICE_HOME, --source folders in your own file, and checks OpenCode V2', { timeout: 120_000 }, async t => {
  const s = sandbox(t)
  const docs = path.join(s.tmp, 'work/acme-docs')
  fs.mkdirSync(docs, { recursive: true })
  const r = s.run(['setup', 'opencode', s.session, '--source', docs])
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const config = JSON.parse(fs.readFileSync(path.join(s.session, 'opencode.json'), 'utf8'))
  const server = config.mcp.servers['zoom-meeting']
  assert.deepEqual(server.command, [s.node, s.bin, 'channel'])
  assert.deepEqual(server.environment, { AGENTVOICE_CLIENT: 'opencode', AGENTVOICE_HOME: s.owner })
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.session, '.opencode/opencode.json'), 'utf8')).agents, {
    'meeting-assistant': { permissions: [{ action: 'external_directory', resource: `${docs}/*`, effect: 'allow' }] },
  })
  assert.ok(
    r.stdout.endsWith(
      [
        `opencode.json starts the channel with AGENTVOICE_HOME=${s.owner}, since OpenCode's background service, which runs it,`,
        "doesn't see your terminal's environment.",
        'The meeting-assistant may read the transcripts and minutes in ~/.agentvoice/data, and these folders:',
        `  ${docs}`,
        `Before a meeting, start OpenCode's background service, then OpenCode in this folder (${DOCS_URL}/v${PACKAGE_VERSION}/docs/opencode.md):`,
        '  opencode service start',
        `  cd "${s.session}" && opencode`,
        'Change opencode.json or .opencode/ only between meetings: OpenCode restarts the channel when its config changes.',
        'Run agentvoice setup opencode again after upgrading AgentVoice or Node.',
        '',
      ].join('\n'),
    ),
    r.stdout,
  )
  // The channel starts by the command and the environment opencode.json gives it, and nothing else.
  const started = await channelStarts(t, server.command, { ...server.environment, HOME: s.home, TMPDIR: s.tmpdir }, s.session)
  assert.equal(started.version?.name, 'zoom-meeting')
  assert.ok(started.tools.includes('next_question'))
  // Again without --source: your folders stay.
  const again = s.run(['setup', 'opencode'], {}, s.session)
  assert.equal(again.status, 0, again.stderr)
  assert.match(again.stdout, /and these folders:\n {2}.*acme-docs\n/)
  // OpenCode V1, an older V2 and none at all are refused; a newer major version is noted.
  const refused = (extra: Record<string, string>, why: RegExp) => {
    const run = s.run(['setup', 'opencode', path.join(s.tmp, 'other')], extra)
    assert.equal(run.status, 1, run.stdout)
    assert.match(run.stderr, why)
    assert.ok(!fs.existsSync(path.join(s.tmp, 'other')))
  }
  refused({ FAKE_OPENCODE_VERSION: '1.19.6' }, /^OpenCode 1\.19\.6 is V1 \(npm opencode-ai\), which AgentVoice doesn't support: its tool calls time out after 60 seconds\.\nInstall V2 instead: npm install -g @opencode\/cli\n$/)
  refused({ FAKE_OPENCODE_VERSION: '2.3.1' }, /is older than 2\.3\.2, the earliest AgentVoice supports/)
  refused({ FAKE_OPENCODE_VERSION: '2.3.2', PATH: [s.nodeDir, '/usr/bin', '/bin'].join(':') }, /^OpenCode is not installed \(no opencode command\)\. Install OpenCode 2\.3\.2 or later: npm install -g @opencode\/cli\n$/)
  const newer = s.run(['setup', 'opencode', s.session], { FAKE_OPENCODE_VERSION: '3.0.0' })
  assert.equal(newer.status, 0, newer.stderr)
  assert.match(newer.stdout, /^Note: OpenCode 3\.0\.0 is newer than AgentVoice was tested with \(2\.3\.2\)\. If something fails, tell us\.\n/)
  // A --source it can't take is refused before anything is written.
  const home = s.run(['setup', 'opencode', path.join(s.tmp, 'other'), '--source', '~'])
  assert.equal(home.status, 1)
  assert.equal(home.stderr, '~ is your whole disk or home folder, or holds your home folder: give the folders your sources are in.\n')
  assert.ok(!fs.existsSync(path.join(s.tmp, 'other')))
})

test('setup refuses before anything else in a clone, from npx, before init, and without git; and says how it is used', { timeout: 120_000 }, t => {
  const s = sandbox(t, { init: false })
  const refused = (r: ReturnType<typeof s.run>, why: string | RegExp, status = 1) => {
    assert.equal(r.status, status, r.stdout + r.stderr)
    if (typeof why === 'string') assert.equal(r.stderr, why)
    else assert.match(r.stderr, why)
    assert.ok(!fs.existsSync(s.session), 'no folder made')
  }
  refused(s.run(['setup', 'claude-code', s.session]), `${path.join(s.home, '.agentvoice/.env').replace(s.home, '~')} is not there yet. Run agentvoice init first.\n`)
  assert.equal(s.run(['init']).status, 0)
  refused(
    s.run(['setup', 'claude-code', s.session], { PATH: [s.fake, s.nodeDir].join(':') }),
    'agentvoice setup needs git, to make the session folder a repository of its own (so your coding client takes it as the project): install git, then run this again.\n',
  )
  fs.renameSync(path.join(s.fake, 'claude'), path.join(s.fake, 'claude.off'))
  refused(s.run(['setup', 'claude-code', s.session]), 'Claude Code is not installed (no claude command): install it, then run this again.\n')
  fs.renameSync(path.join(s.fake, 'claude.off'), path.join(s.fake, 'claude'))
  // The arguments: a client, one folder, and the options each takes.
  for (const [args, why] of [
    [[], /^Which client\? agentvoice setup claude-code, codex or opencode\.\nUsage: agentvoice setup claude-code/],
    [['cursor'], /^Unknown client "cursor": agentvoice setup claude-code, codex or opencode\./],
    [['claude-code', '--source', '/x'], /^--source is for agentvoice setup opencode only\./],
    [['codex', '--no-sources'], /^--no-sources is for agentvoice setup opencode only\./],
    [['opencode', '--source'], /^--source takes a folder\./],
    [['claude-code', '--force'], /^Unknown option: --force\./],
    [['claude-code', 'a', 'b'], /^One folder only: a or b\?/],
  ] as const) {
    refused(s.run(['setup', ...args]), why, 2)
  }
  const help = s.run(['setup', 'opencode', '--help'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /^Usage: agentvoice setup claude-code \[<folder>\] \[--replace-changed\]\n/)
  assert.deepEqual(s.calls().filter(call => call.cmd === 'claude' && call.args[0] === 'mcp'), [], 'no client was told anything')

  // Run from npx's cache, which npm clears: a config can't point there.
  const npx = path.join(s.tmp, 'npm-cache/_npx/0123abcd/node_modules', PACKAGE_NAME)
  fs.mkdirSync(path.dirname(npx), { recursive: true })
  fs.cpSync(s.pkg, npx, { recursive: true, verbatimSymlinks: true })
  const fromNpx = agentvoice(npx, ['setup', 'claude-code', s.session], s.env(), s.elsewhere)
  refused(fromNpx, `Install AgentVoice first (npm install -g ${PACKAGE_NAME}): a client config can't point into npx's cache, which npm clears.\n`)

  // A clone has its own way, also when the module is run on its own.
  const { clone, tmp } = cloneCopy(t)
  const direct = command(clone, 'src/cli/setup.ts', ['claude-code', path.join(tmp, 'session')], envFor({ HOME: tmp }), tmp)
  assert.equal(direct.status, 1, direct.stdout)
  assert.equal(direct.stderr, `${cloneRefusal(clone)}\n`)
  assert.ok(cloneRefusal(clone).endsWith(`${CLONE_SETUP}.`))
  assert.ok(!fs.existsSync(path.join(tmp, 'session')))
})
