// What agentvoice setup writes into a session folder (src/setup/), checked without running a client: each client's
// files from the package's templates, with only the listed changes; the record of what setup wrote; that it refreshes
// its own files and never replaces one you changed (or one it didn't make) unasked; and which folders it takes. The
// command itself, with stand-in clients, is in test/setup-cli.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from '../src/config.ts'
import { CLONE_SETUP } from '../src/commands.ts'
import { PACKAGE_NAME } from '../src/home.ts'
import { CLAUDE_AGENT, CLAUDE_CHANNEL_TOOLS, CLAUDE_LOCAL, CLAUDE_SETTINGS, renderClaudeCode } from '../src/setup/claude-code.ts'
import { CODEX_AGENT, CODEX_CONFIG, HOME_ENV_NAMES, renderCodex } from '../src/setup/codex.ts'
import { type Apply, type Getent, MANIFEST, type Manifest, SetupError, type SetupFile, applySetup, groupOfYoursAlone, parseManifest, sha256, staleReasons, unifiedDiff, youAre } from '../src/setup/files.ts'
import { checkSessionFolder, sessionFolder } from '../src/setup/folder.ts'
import { OPENCODE_AGENT, OPENCODE_CONFIG, OPENCODE_LOCAL, renderOpenCode, sourceFolders } from '../src/setup/opencode.ts'
import { snapshot, tempDir } from './layouts.ts'
import { parseToml, type TomlTable } from './toml.ts'

type Ctx = { after: (fn: () => unknown) => void }
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const byRel = (files: SetupFile[]) => Object.fromEntries(files.map(file => [file.rel, file]))
const NODE = '/usr/local/bin/node'
const BIN = `/usr/local/lib/node_modules/${PACKAGE_NAME}/bin/agentvoice.js`
// A made-up home folder under a root that exists nowhere, so it is never a link: on macOS /home is one (to
// /System/Volumes/Data/home), and setup adds a linked path's real form too.
const AV = '/av-test-home/sam/.agentvoice'
const DATA = `${AV}/data`

// --- Claude Code ---------------------------------------------------------------------------------------------------
test("Claude Code: the floor and the meeting-assistant are the package's, byte for byte; settings.local.json gains the six tools and two reads", () => {
  const files = byRel(renderClaudeCode({ packageDir: ROOT, dataDir: DATA }))
  assert.deepEqual(Object.keys(files), [CLAUDE_SETTINGS, CLAUDE_AGENT, CLAUDE_LOCAL])
  assert.equal(files[CLAUDE_SETTINGS].content, read('.claude/settings.json'))
  assert.equal(files[CLAUDE_AGENT].content, read('.claude/agents/meeting-assistant.md'))
  assert.ok(!files[CLAUDE_SETTINGS].merged && !files[CLAUDE_AGENT].merged)
  assert.equal(files[CLAUDE_LOCAL].merged, true)
  assert.deepEqual(JSON.parse(files[CLAUDE_LOCAL].content), {
    permissions: {
      allow: [
        'mcp__zoom-meeting__next_question',
        'mcp__zoom-meeting__get_profile',
        'mcp__zoom-meeting__reply',
        'mcp__zoom-meeting__post_chat',
        'mcp__zoom-meeting__add_to_brief',
        'mcp__zoom-meeting__get_transcript',
        'Read(//av-test-home/sam/.agentvoice/data/transcripts/**)',
        'Read(//av-test-home/sam/.agentvoice/data/minutes/**)',
      ],
    },
  })
  // The six are the meeting-assistant's own tools, as its frontmatter lists them.
  const tools = /^tools: (.*)$/m.exec(read('.claude/agents/meeting-assistant.md'))?.[1].split(/,\s*/) ?? []
  assert.deepEqual(CLAUDE_CHANNEL_TOOLS.filter(tool => !tools.includes(tool)), [])
  assert.deepEqual(tools.filter(tool => tool.startsWith('mcp__')).sort(), [...CLAUDE_CHANNEL_TOOLS].sort())
})

test("Claude Code: settings.local.json is yours: what is there stays, only what is missing is added, and again adds nothing", () => {
  const yours = {
    outputStyle: 'Explanatory',
    permissions: { allow: ['Bash(git status)', 'mcp__zoom-meeting__reply', 'Read(//av-test-home/sam/work/acme-docs/**)'], deny: ['Read(//**/secrets/**)'], additionalDirectories: ['/av-test-home/sam/work'] },
    env: { A: '1' },
  }
  const merged = JSON.parse(byRel(renderClaudeCode({ packageDir: ROOT, dataDir: DATA, local: JSON.stringify(yours) }))[CLAUDE_LOCAL].content)
  assert.equal(merged.outputStyle, 'Explanatory')
  assert.deepEqual(merged.env, { A: '1' })
  assert.deepEqual(merged.permissions.deny, ['Read(//**/secrets/**)'])
  assert.deepEqual(merged.permissions.additionalDirectories, ['/av-test-home/sam/work'])
  assert.deepEqual(merged.permissions.allow.slice(0, 3), yours.permissions.allow, 'yours first, as they were')
  assert.equal(merged.permissions.allow.filter((rule: string) => rule === 'mcp__zoom-meeting__reply').length, 1, 'no rule twice')
  assert.equal(merged.permissions.allow.length, 3 + 7)
  const text = byRel(renderClaudeCode({ packageDir: ROOT, dataDir: DATA, local: JSON.stringify(yours) }))[CLAUDE_LOCAL].content
  assert.equal(byRel(renderClaudeCode({ packageDir: ROOT, dataDir: DATA, local: text }))[CLAUDE_LOCAL].content, text, 'a second run changes nothing')
  // A file that isn't plain JSON, or whose rules aren't where Claude Code reads them, stops setup: fix or remove it.
  for (const [local, why] of [['{ // mine\n}', /is not plain JSON/], ['[]', /is not a JSON object/], ['{"permissions": []}', /"permissions" that isn't an object/], ['{"permissions": {"allow": "x"}}', /"permissions\.allow" that isn't a list/]] as const) {
    assert.throws(() => renderClaudeCode({ packageDir: ROOT, dataDir: DATA, local }), (err: Error) => err instanceof SetupError && why.test(err.message) && /fix or remove it/.test(err.message), local)
  }
})

// --- Codex ---------------------------------------------------------------------------------------------------------
/** The lines of b that a lacks, and of a that b lacks. */
const lineChanges = (a: string, b: string) => {
  const [la, lb] = [a.split('\n'), b.split('\n')]
  return { removed: la.filter(line => !lb.includes(line)), added: lb.filter(line => !la.includes(line)) }
}

test("Codex: the package's config with exactly two changes, the channel by absolute paths and the AgentVoice folder's entries", () => {
  const files = byRel(renderCodex({ packageDir: ROOT, home: AV, dataDir: DATA, node: NODE, bin: BIN, homeDir: '/av-test-home/sam' }))
  assert.deepEqual(Object.keys(files), [CODEX_CONFIG, CODEX_AGENT])
  const template = read('.codex/config.toml')
  const written = files[CODEX_CONFIG].content
  assert.deepEqual(lineChanges(template, written), {
    removed: [
      '# The server scripts/install-channel.sh registers for Claude Code, by paths from the folder the session starts in. No',
      '# cwd: Codex would take a relative one from wherever its own process started.',
      'command = "node_modules/.bin/tsx"',
      'args = ["src/channel/server.ts"]',
      'env = { AGENTVOICE_CLIENT = "codex" }',
    ],
    added: [
      "# The installed package's channel, by absolute paths, written by agentvoice setup codex. Run it again after upgrading",
      '# AgentVoice or Node.',
      `command = "${NODE}"`,
      `args = ["${BIN}", "channel"]`,
      `env = { AGENTVOICE_CLIENT = "codex", AGENTVOICE_HOME = "${AV}" }`,
      '# Your AgentVoice folder, outside this one (agentvoice setup codex): its keys, the local token and prepared decks.',
      ...HOME_ENV_NAMES.map(name => `"~/.agentvoice/${name}" = "deny"`),
      '"~/.agentvoice/data/local-token" = "deny"',
      '"~/.agentvoice/data/decks" = "deny"',
    ],
  })
  // In place: the server's lines where the clone's were, the entries right after the last home-folder one.
  assert.ok(written.includes(`[mcp_servers.zoom-meeting]\n# The installed package's channel`))
  assert.ok(written.includes('"~/.local/share/opencode" = "deny"\n# Your AgentVoice folder, outside this one'))
  assert.ok(written.includes('"~/.agentvoice/data/decks" = "deny"\n\n# In this folder and every folder in it'))
  assert.deepEqual(HOME_ENV_NAMES.length, 14)

  // Parsed, it is the package's config but for those keys: the approval modes, the profile and the patterns as they were.
  const before = parseToml(template)
  const after = parseToml(written)
  const server = (t: TomlTable) => (t.mcp_servers as TomlTable)['zoom-meeting'] as TomlTable
  assert.equal(server(after).command, NODE)
  assert.deepEqual(server(after).args, [BIN, 'channel'])
  assert.deepEqual(server(after).env, { AGENTVOICE_CLIENT: 'codex', AGENTVOICE_HOME: AV })
  const fsOf = (t: TomlTable) => ((t.permissions as TomlTable).agentvoice as TomlTable).filesystem as TomlTable
  const added = Object.keys(fsOf(after)).filter(key => !(key in fsOf(before)))
  assert.deepEqual(added, [...HOME_ENV_NAMES.map(name => `~/.agentvoice/${name}`), '~/.agentvoice/data/local-token', '~/.agentvoice/data/decks'])
  for (const key of added) assert.equal(fsOf(after)[key], 'deny')
  for (const key of added) delete fsOf(after)[key]
  for (const key of ['command', 'args', 'env']) {
    delete server(after)[key]
    delete server(before)[key]
  }
  assert.deepEqual(after, before)
  // The meeting-assistant: the package's, byte for byte.
  assert.equal(files[CODEX_AGENT].content, read('.codex/agents/meeting-assistant.toml'))
})

test('Codex: an AgentVoice folder elsewhere is named in full, the data folder where it is, and any path comes back as it is', () => {
  const custom = '/srv/av home'
  const files = byRel(renderCodex({ packageDir: ROOT, home: custom, dataDir: '/var/lib/av-data', node: NODE, bin: BIN, homeDir: '/av-test-home/sam' }))
  const fsKeys = Object.keys((((parseToml(files[CODEX_CONFIG].content).permissions as TomlTable).agentvoice as TomlTable).filesystem as TomlTable))
  assert.deepEqual(fsKeys.filter(key => key.startsWith('/')), [...HOME_ENV_NAMES.map(name => `${custom}/${name}`), '/var/lib/av-data/local-token', '/var/lib/av-data/decks'])
  // ~/ only for the default folder: AGENTVOICE_HOME=~/notes/av is named in full, like any other.
  const other = byRel(renderCodex({ packageDir: ROOT, home: '/av-test-home/sam/notes/av', dataDir: '/av-test-home/sam/notes/av/data', node: NODE, bin: BIN, homeDir: '/av-test-home/sam' }))
  assert.match(other[CODEX_CONFIG].content, /^"\/av-test-home\/sam\/notes\/av\/\.env" = "deny"$/m)
  // A quote mark or backslash in a path is escaped as TOML takes it, and read back as it was.
  const odd = '/srv/a "b" \\c'
  const quoted = parseToml(byRel(renderCodex({ packageDir: ROOT, home: odd, dataDir: `${odd}/data`, node: `${odd}/node`, bin: `${odd}/agentvoice.js`, homeDir: '/av-test-home/sam' }))[CODEX_CONFIG].content)
  const server = (quoted.mcp_servers as TomlTable)['zoom-meeting'] as TomlTable
  assert.equal(server.command, `${odd}/node`)
  assert.deepEqual(server.args, [`${odd}/agentvoice.js`, 'channel'])
  assert.equal((server.env as TomlTable).AGENTVOICE_HOME, odd)
  assert.equal(((quoted.permissions as TomlTable).agentvoice as TomlTable).filesystem && (((quoted.permissions as TomlTable).agentvoice as TomlTable).filesystem as TomlTable)[`${odd}/.env`], 'deny')
})

test("Codex: a meeting-assistant whose shell you turned off keeps it off, and counts as setup's own either way", () => {
  const template = read('.codex/agents/meeting-assistant.toml')
  assert.ok(template.endsWith('\n# [features]\n# shell_tool = false\n'))
  const off = template.replace(/# \[features\]\n# shell_tool = false\n$/, '[features]\nshell_tool = false\n')
  const agent = (existing?: string) => byRel(renderCodex({ packageDir: ROOT, home: AV, dataDir: DATA, node: NODE, bin: BIN, homeDir: '/av-test-home/sam', agent: existing }))[CODEX_AGENT]
  assert.equal(agent(off).content, off, 'kept off')
  assert.equal(agent(template).content, template)
  assert.equal(agent(undefined).content, template)
  assert.equal(agent('something else').content, template)
  // The switch turned either way is still the file setup wrote: no refusal for it.
  assert.deepEqual(agent(undefined).alsoOurs?.(off), [template])
  assert.deepEqual(agent(undefined).alsoOurs?.(template), [off])
  assert.deepEqual(agent(undefined).alsoOurs?.('# mine\n'), [])
})

// --- OpenCode ------------------------------------------------------------------------------------------------------
test("OpenCode: the package's opencode.json with the listed edits only, and its meeting-assistant byte for byte", () => {
  const files = byRel(renderOpenCode({ packageDir: ROOT, home: AV, dataDir: DATA, node: NODE, bin: BIN }))
  assert.deepEqual(Object.keys(files), [OPENCODE_CONFIG, OPENCODE_AGENT], 'no .opencode/opencode.json without --source or --no-sources')
  assert.equal(files[OPENCODE_AGENT].content, read('.opencode/agents/meeting-assistant.md'))
  const written = files[OPENCODE_CONFIG].content
  const config = JSON.parse(written)
  assert.equal(written, `${JSON.stringify(config, null, 2)}\n`)
  // The package's, with each edit made by hand.
  const expected = JSON.parse(read('opencode.json'))
  expected.mcp.servers['zoom-meeting'].command = [NODE, BIN, 'channel']
  expected.mcp.servers['zoom-meeting'].environment = { AGENTVOICE_CLIENT: 'opencode', AGENTVOICE_HOME: AV }
  const slides = expected.permissions.findIndex((rule: { resource: string }) => rule.resource === 'npm run slides *')
  assert.ok(slides >= 0)
  expected.permissions[slides] = { action: 'shell', resource: '*agentvoice* slides *', effect: 'ask' }
  expected.agents['meeting-assistant'].permissions.push(
    { action: 'external_directory', resource: `${DATA}/transcripts/*`, effect: 'allow' },
    { action: 'external_directory', resource: `${DATA}/minutes/*`, effect: 'allow' },
  )
  assert.deepEqual(config, expected)
  assert.deepEqual(config.policies, JSON.parse(read('opencode.json')).policies, 'the floor as it is')
})

test('OpenCode: --source writes your .opencode/opencode.json as the clone script does, keeping what else is in it; --no-sources takes them away', t => {
  const tmp = tempDir(t)
  const docs = path.join(tmp, 'work/acme-docs')
  const site = path.join(tmp, 'work/acme-site')
  fs.mkdirSync(docs, { recursive: true })
  fs.mkdirSync(site)
  const render = (local: string | undefined, sources: string[] | null) =>
    byRel(renderOpenCode({ packageDir: ROOT, home: AV, dataDir: DATA, node: NODE, bin: BIN, local, sources }))[OPENCODE_LOCAL]
  const rule = (dir: string) => ({ action: 'external_directory', resource: `${dir}/*`, effect: 'allow' })
  const first = render(undefined, sourceFolders([docs, site], tmp, tmp))
  assert.equal(first.merged, true)
  assert.deepEqual(JSON.parse(first.content), { $schema: 'https://opencode.ai/config.json', agents: { 'meeting-assistant': { permissions: [rule(docs), rule(site)] } } })
  assert.equal(JSON.parse(first.content).mcp, undefined, 'no zoom-meeting of its own: opencode.json has the command')
  // Yours stays; a new list replaces the folders; --no-sources removes them, and what else you wrote stays.
  const yours = { ...JSON.parse(first.content), model: 'someprovider/somemodel', agents: { 'meeting-assistant': { permissions: [rule(docs), { action: 'read', resource: '*', effect: 'allow' }], temperature: 0 } } }
  const second = JSON.parse(render(JSON.stringify(yours), [site]).content)
  assert.equal(second.model, 'someprovider/somemodel')
  assert.deepEqual(second.agents['meeting-assistant'], { permissions: [{ action: 'read', resource: '*', effect: 'allow' }, rule(site)], temperature: 0 })
  const none = JSON.parse(render(JSON.stringify({ ...JSON.parse(first.content), model: 'm' }), []).content)
  assert.deepEqual(none, { $schema: 'https://opencode.ai/config.json', model: 'm' })
  assert.throws(() => render('{ // mine\n}', []), /\.opencode\/opencode\.json is not plain JSON \(it may have comments\): fix or remove it/)
})

test("OpenCode: --source refuses a folder it can't find, a file, the whole disk, the home folder and a folder that holds it", t => {
  const tmp = tempDir(t)
  const home = path.join(tmp, 'home')
  fs.mkdirSync(path.join(home, 'work'), { recursive: true })
  fs.writeFileSync(path.join(home, 'notes.md'), 'x')
  fs.symlinkSync(home, path.join(tmp, 'link-home'))
  for (const [source, why] of [
    ['missing', /is not a folder setup can find/],
    ['~/notes.md', /is not a folder: give the folder a source is in/],
    ['/', /your whole disk or home folder/],
    ['~', /your whole disk or home folder/],
    [home, /your whole disk or home folder/],
    [tmp, /or holds your home folder/],
    [path.join(tmp, 'link-home'), /your whole disk or home folder/],
  ] as const) {
    assert.throws(() => sourceFolders([source], home, home), (err: Error) => err instanceof SetupError && why.test(err.message), source)
  }
  assert.deepEqual(sourceFolders(['~/work', 'work'], home, home), [path.join(home, 'work'), path.join(home, 'work')])
})

// --- The folder ----------------------------------------------------------------------------------------------------
/**
 * A temp place: a home folder with its AgentVoice folder, and a package folder; refusals are checked to write nothing.
 * No group is yours alone here unless a test says so, whatever this computer's lists say (root's group is, here).
 */
function place(t: Ctx) {
  const tmp = tempDir(t, 'av-setup-')
  const homeDir = path.join(tmp, 'home')
  const ownerDir = path.join(homeDir, '.agentvoice')
  const packageDir = path.join(tmp, 'prefix/lib/node_modules', PACKAGE_NAME)
  fs.mkdirSync(path.join(ownerDir, 'data'), { recursive: true })
  fs.mkdirSync(packageDir, { recursive: true })
  fs.writeFileSync(path.join(ownerDir, '.env'), 'OWNER_NAME=Sam\n')
  const check = (folder: string, more: Partial<Parameters<typeof checkSessionFolder>[0]> = {}) =>
    checkSessionFolder({ folder: sessionFolder(folder, tmp, homeDir), client: 'claude-code', ownerDir, dataDir: path.join(ownerDir, 'data'), packageDir, homeDir, groupOfYours: () => false, ...more })
  return { tmp, homeDir, ownerDir, packageDir, check }
}

const manifestFor = (home: string): Manifest => ({ package: PACKAGE_NAME, version: '0.2.0', home, command: [NODE, BIN, 'channel'], clients: { 'claude-code': { files: {} } } })

test('setup takes a folder not made yet, an empty one (a .DS_Store aside), or one it set up before for this AgentVoice folder', t => {
  const p = place(t)
  assert.deepEqual(p.check(path.join(p.tmp, 'session')), { exists: false, manifest: null })
  assert.deepEqual(p.check(path.join(p.tmp, 'a/b/session')), { exists: false, manifest: null })
  fs.mkdirSync(path.join(p.tmp, 'empty'))
  assert.deepEqual(p.check(path.join(p.tmp, 'empty')), { exists: true, manifest: null })
  fs.writeFileSync(path.join(p.tmp, 'empty/.DS_Store'), '')
  assert.deepEqual(p.check(path.join(p.tmp, 'empty')), { exists: true, manifest: null })
  const before = path.join(p.tmp, 'before')
  fs.mkdirSync(path.join(before, '.git'), { recursive: true })
  fs.writeFileSync(path.join(before, 'notes.md'), 'mine')
  fs.writeFileSync(path.join(before, MANIFEST), JSON.stringify(manifestFor(p.ownerDir)))
  assert.deepEqual(p.check(before), { exists: true, manifest: manifestFor(p.ownerDir) })
  // The current folder unless one is given, and "~" for the home folder.
  assert.equal(sessionFolder(undefined, before, p.homeDir), before)
  assert.equal(sessionFolder('~/s', before, p.homeDir), path.join(p.homeDir, 's'))
})

test("setup refuses a folder holding files it didn't make, a project, or a setup for another AgentVoice folder, and writes nothing", t => {
  const p = place(t)
  const folder = (name: string, files: Record<string, string>) => {
    const dir = path.join(p.tmp, name)
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
      fs.writeFileSync(path.join(dir, rel), text)
    }
    return dir
  }
  const notes = folder('notes', { 'todo.md': 'x' })
  const project = folder('project', { '.claude/settings.json': '{"permissions":{}}', 'src/app.ts': '' })
  spawnSync('git', ['init', '-q', project])
  const other = folder('other', { [MANIFEST]: JSON.stringify(manifestFor('/av-test-home/sam/elsewhere')) })
  const broken = folder('broken', { [MANIFEST]: '{"package": "something"}' })
  fs.writeFileSync(path.join(p.tmp, 'a-file'), 'x')
  const before = snapshot(p.tmp)
  const refused = (dir: string, why: RegExp) => assert.throws(() => p.check(dir), (err: Error) => err instanceof SetupError && why.test(err.message), dir)
  const held = new RegExp(
    `^${notes.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} already holds files that agentvoice setup didn't make\\. The folder you start your coding client in for meetings gives the meeting-assistant its reach \\(Claude Code reads it without asking, Codex may write it\\), so setup takes a new, empty folder: mkdir -p ~/agentvoice-session && cd ~/agentvoice-session && agentvoice setup claude-code$`,
  )
  refused(notes, held)
  refused(project, /already holds files that agentvoice setup didn't make/)
  refused(other, /was set up for another AgentVoice folder, \/av-test-home\/sam\/elsewhere \(its \.agentvoice-setup\.json\), not ~\/\.agentvoice/)
  refused(broken, /\.agentvoice-setup\.json is not a record agentvoice setup wrote: fix or remove it/)
  refused(path.join(p.tmp, 'a-file'), /is a file, not a folder/)
  assert.deepEqual(snapshot(p.tmp), before, 'nothing written')
})

test('setup refuses the disk, the home folder, the AgentVoice folder and its data folder, the package, a clone and a folder inside a repository', t => {
  const p = place(t)
  const refused = (dir: string, why: RegExp, more = {}) => assert.throws(() => p.check(dir, more), (err: Error) => err instanceof SetupError && why.test(err.message), dir)
  const example = /for example: mkdir -p ~\/agentvoice-session && cd ~\/agentvoice-session && agentvoice setup claude-code$/
  refused('/', /^\/ is your whole disk\. Make a folder for your meeting sessions and run this in it, for example: /)
  refused(p.homeDir, /^~ is your home folder\. Make a folder for your meeting sessions and run this in it/)
  refused('~', example)
  // The AgentVoice folder, a folder in it, and one that holds it: Codex may write there, and leaves placeholders.
  refused(p.ownerDir, /^~\/\.agentvoice is your AgentVoice folder \(~\/\.agentvoice\)\. Your coding client must start somewhere else: Codex lets its commands write/)
  refused(path.join(p.ownerDir, 'briefs/s'), /is inside your AgentVoice folder/)
  fs.mkdirSync(path.join(p.homeDir, 'all'))
  const holding = path.join(p.tmp, 'holder')
  fs.mkdirSync(holding)
  refused(p.homeDir, example)
  refused(holding, /holder is a folder that holds your AgentVoice folder \(.*holder\/av\)/, { ownerDir: path.join(holding, 'av'), dataDir: path.join(holding, 'av/data') })
  refused(holding, /holder is a folder that holds its data folder \(.*holder\/data\)/, { dataDir: path.join(holding, 'data') })
  refused(path.join(p.tmp, 'data-elsewhere/sub'), /is inside its data folder/, { dataDir: path.join(p.tmp, 'data-elsewhere') })
  refused(path.join(p.tmp), /a folder that holds your AgentVoice folder/)
  // The package's folder, and anything in it: npm replaces it.
  refused(p.packageDir, /is inside the installed package/)
  refused(path.join(p.packageDir, 'session'), /is inside the installed package \(.*\), which npm replaces on every upgrade/)
  // A clone of AgentVoice: it has its own way.
  const clone = path.join(p.tmp, 'AgentVoice')
  fs.mkdirSync(path.join(clone, 'src/channel'), { recursive: true })
  fs.writeFileSync(path.join(clone, 'package.json'), JSON.stringify({ name: 'agent-voice' }))
  fs.writeFileSync(path.join(clone, 'src/channel/server.ts'), '')
  refused(clone, new RegExp(`AgentVoice is a clone of AgentVoice: ${CLONE_SETUP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.$`))
  fs.writeFileSync(path.join(clone, 'package.json'), JSON.stringify({ name: PACKAGE_NAME }))
  refused(clone, /is a clone of AgentVoice/)
  // A folder in another Git repository, made or not: the client would take the whole repository as the project.
  const repo = path.join(p.tmp, 'repo')
  fs.mkdirSync(path.join(repo, 'meetings'), { recursive: true })
  assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0)
  refused(path.join(repo, 'meetings'), /repo\/meetings is inside the Git repository .*repo, and your coding client would take that whole repository as the project\. Make the session folder outside it/)
  refused(path.join(repo, 'not-yet'), /is inside the Git repository/)
  // Characters the clients' rules would read as a pattern, and control characters, in the paths that go into them.
  for (const odd of ['av*', 'av?', 'av[1]', 'av{x}', 'av(1)']) {
    refused(path.join(p.tmp, 'session'), /has one of \* \? \[ \] \{ \} \( \) in its path, which the clients' rules read as a pattern/, { ownerDir: path.join(p.tmp, odd), dataDir: path.join(p.tmp, odd, 'data') })
  }
  refused(path.join(p.tmp, 'session'), /The data folder \(.*\) has one of/, { dataDir: path.join(p.tmp, 'd*') })
  refused(path.join(p.tmp, 'a\nb'), /The session folder \(.*\) has a control character in its path/)
  refused(path.join(p.tmp, 'session'), /Your AgentVoice folder \(.*\) has a control character/, { ownerDir: path.join(p.tmp, 'av\tx') })
})

test("setup takes only a folder of yours, in folders only you or root can change; an empty one of yours is made 0700", t => {
  const p = place(t)
  const refused = (dir: string, why: RegExp, more = {}) => assert.throws(() => p.check(dir, more), (err: Error) => err instanceof SetupError && why.test(err.message), dir)
  const example = 'for example: mkdir -p ~/agentvoice-session && cd ~/agentvoice-session && agentvoice setup claude-code'
  const mode = (dir: string) => fs.statSync(dir).mode & 0o7777
  const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // An empty folder of yours that others could write (mkdir -m 777, or a umask of 002): made 0700, then taken.
  const open = path.join(p.tmp, 'open')
  fs.mkdirSync(open)
  fs.chmodSync(open, 0o777)
  assert.deepEqual(p.check(open), { exists: true, manifest: null })
  assert.equal(mode(open), 0o700)
  // In a folder others can write, without the sticky bit, made or not: they could rename it and put theirs in its place.
  const shared = path.join(p.tmp, 'shared')
  fs.mkdirSync(path.join(shared, 'session'), { recursive: true })
  fs.chmodSync(shared, 0o777)
  fs.chmodSync(path.join(shared, 'session'), 0o755)
  const before = snapshot(p.tmp)
  // It names the folder, its mode, and the chmod that makes a folder of yours yours alone.
  const inShared = new RegExp(
    `^${esc(path.join(shared, 'session'))} is in ${esc(shared)}, which its group or others can write to \\(its mode is 777; to make it yours alone, run chmod go-w ${esc(JSON.stringify(shared))} and this again\\), so they could put a folder of their own in its place, with other client configs\\. Make the session folder where only you can change it, ${esc(example)}$`,
  )
  refused(path.join(shared, 'session'), inShared)
  refused(path.join(shared, 'new/session'), /new\/session is in .*shared, which its group or others can write to \(its mode is 777; /)
  // Its group only: refused while that group isn't yours alone.
  fs.chmodSync(shared, 0o770)
  refused(path.join(shared, 'session'), /which its group or others can write to \(its mode is 770; to make it yours alone, run chmod go-w /)
  assert.deepEqual(snapshot(p.tmp), before, 'nothing written')
  assert.equal(mode(path.join(shared, 'session')), 0o755, 'nor its mode changed')
  // With the sticky bit, as /tmp has it, only you can rename or remove what is yours there: taken.
  fs.chmodSync(shared, 0o1777)
  assert.deepEqual(p.check(path.join(shared, 'new/session')), { exists: false, manifest: null })
  // A folder setup made before for this AgentVoice folder, that others can write now: refused until it is yours alone.
  const earlier = path.join(p.tmp, 'earlier')
  fs.mkdirSync(earlier)
  fs.writeFileSync(path.join(earlier, MANIFEST), JSON.stringify(manifestFor(p.ownerDir)))
  fs.chmodSync(earlier, 0o777)
  refused(
    earlier,
    new RegExp(`earlier can be written by its group or others \\(its mode is 777\\), so the floor and the client configs setup wrote there may have been changed\\. Check what is in it, then run chmod 700 ".*earlier" and this again; or set up a new, empty folder, for example: `),
  )
  assert.equal(mode(earlier), 0o777, 'left as it is')
  fs.chmodSync(earlier, 0o700)
  assert.deepEqual(p.check(earlier), { exists: true, manifest: manifestFor(p.ownerDir) })
  // Another user's folder, as it looks to someone who isn't its owner (a uid that is neither yours nor root's): the
  // folder itself, empty or not, is refused, and so is one in a folder of theirs.
  const stranger = 54321
  const empty = path.join(p.tmp, 'empty')
  fs.mkdirSync(empty)
  refused(empty, new RegExp(`empty belongs to another user, who could change the floor and the client configs setup writes there\\. Make a folder of your own for your meeting sessions, ${example.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), { uid: stranger })
  if (process.geteuid?.() !== 0) refused(path.join(p.tmp, 'new'), /new is in .*, which belongs to another user/, { uid: stranger })
  if (process.geteuid?.() === 0) {
    // Folders another user really owns (only root can make one here), checked as you.
    const theirs = path.join(p.tmp, 'theirs')
    fs.mkdirSync(path.join(theirs, 'sub'), { recursive: true })
    fs.chownSync(theirs, 65534, 65534)
    fs.chownSync(path.join(theirs, 'sub'), 65534, 65534)
    refused(theirs, /theirs belongs to another user/)
    refused(path.join(theirs, 'sub'), /theirs\/sub belongs to another user/)
    refused(path.join(theirs, 'new'), /theirs\/new is in .*theirs, which belongs to another user/)
    assert.equal(mode(theirs) & 0o777, 0o755, 'its mode unchanged')
  }
  // No uid (null: a platform without one): nothing is checked of owners and modes, so a folder in one others can
  // write, which the checks refuse, is taken.
  const loose = path.join(p.tmp, 'loose')
  fs.mkdirSync(path.join(loose, 'session'), { recursive: true })
  fs.chmodSync(loose, 0o777)
  refused(path.join(loose, 'session'), /loose\/session is in .*loose, which its group or others can write to/)
  assert.deepEqual(p.check(path.join(loose, 'session'), { uid: null }), { exists: true, manifest: null })
  // Left out, or undefined, it is this process's: checked.
  refused(path.join(loose, 'session'), /which its group or others can write to/, { uid: undefined })
  assert.equal(youAre(null), null)
  assert.equal(youAre()?.uid, process.geteuid?.())
})

test('a folder only your group can write is yours alone when no one else is in that group, as Ubuntu and Fedora make one for each user', t => {
  const p = place(t)
  const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const refused = (dir: string, why: RegExp, more = {}) => assert.throws(() => p.check(dir, more), (err: Error) => err instanceof SetupError && why.test(err.message), dir)
  // mkdir -p ~/work under a umask of 002: 0775, with your own group.
  const work = path.join(p.tmp, 'work')
  fs.mkdirSync(work)
  fs.chmodSync(work, 0o775)
  const gid = fs.statSync(work).gid
  const yours = { groupOfYours: (g: number) => g === gid }
  assert.equal(fs.statSync(p.tmp).gid, gid, 'the folders here have one group')
  assert.deepEqual(p.check(path.join(work, 'meetings/session'), yours), { exists: false, manifest: null })
  fs.mkdirSync(path.join(work, 'meetings/session'), { recursive: true })
  fs.chmodSync(path.join(work, 'meetings'), 0o775)
  fs.chmodSync(path.join(work, 'meetings/session'), 0o775)
  assert.deepEqual(p.check(path.join(work, 'meetings/session'), yours), { exists: true, manifest: null })
  assert.equal(fs.statSync(path.join(work, 'meetings/session')).mode & 0o777, 0o700, 'the empty session folder itself is made 0700')
  // A group someone else is in: refused, with the folder, its mode and the chmod.
  refused(
    path.join(work, 'meetings/session'),
    new RegExp(`^${esc(path.join(work, 'meetings/session'))} is in ${esc(path.join(work, 'meetings'))}, which its group or others can write to \\(its mode is 775; to make it yours alone, run chmod go-w ${esc(JSON.stringify(path.join(work, 'meetings')))} and this again\\), so they could put a folder of their own in its place`),
  )
  // Others' write is never yours alone, whatever the group.
  fs.chmodSync(work, 0o777)
  refused(path.join(work, 'meetings/session'), /work, which its group or others can write to \(its mode is 777; /, yours)
  fs.chmodSync(work, 0o775)
  // A folder setup made before, that your own group can write: taken; another group: refused.
  const earlier = path.join(p.tmp, 'earlier')
  fs.mkdirSync(earlier)
  fs.writeFileSync(path.join(earlier, MANIFEST), JSON.stringify(manifestFor(p.ownerDir)))
  fs.chmodSync(earlier, 0o770)
  assert.deepEqual(p.check(earlier, yours), { exists: true, manifest: manifestFor(p.ownerDir) })
  refused(earlier, /earlier can be written by its group or others \(its mode is 770\)/)
  if (process.geteuid?.() === 0) {
    // A folder of root's, as another user sees it: no chmod to suggest, since it isn't theirs to change.
    refused(path.join(work, 'meetings/new'), new RegExp(`is in ${esc(path.join(work, 'meetings'))}, which its group or others can write to \\(its mode is 775\\), so they could`), { uid: 54321 })
  }
})

test("whether a group is yours alone: your primary group, named as you are, with no one else in it as a member or as their own", () => {
  const sam = { username: 'sam', gid: 1000 }
  const lists = (group: string | null, passwd: string | null, gid = '1000'): Getent => args => (args[0] === 'group' ? (args[1] === gid ? group : null) : passwd)
  const users = 'root:x:0:0:root:/root:/bin/bash\nsam:x:1000:1000:Sam:/av-test-home/sam:/bin/bash\nkim:x:1001:1001:Kim:/home/kim:/bin/bash\n'
  assert.equal(groupOfYoursAlone(1000, sam, lists('sam:x:1000:\n', users)), true)
  assert.equal(groupOfYoursAlone(1000, sam, lists('sam:x:1000:sam\n', users)), true, 'you, listed as a member too')
  assert.equal(groupOfYoursAlone(1000, sam, lists('sam:x:1000:sam,kim\n', users)), false, 'someone else a member')
  assert.equal(groupOfYoursAlone(1000, sam, lists('sam:x:1000:kim\n', users)), false)
  assert.equal(groupOfYoursAlone(1000, sam, lists('sam:x:1000:\n', `${users}lee:x:1002:1000::/home/lee:/bin/sh\n`)), false, "someone else's primary group")
  assert.equal(groupOfYoursAlone(1000, sam, lists('users:x:1000:\n', users)), false, 'not named as you are')
  assert.equal(groupOfYoursAlone(1001, sam, lists('kim:x:1001:\n', users, '1001')), false, 'not your primary group')
  assert.equal(groupOfYoursAlone(1005, sam, lists('sam:x:1005:\n', users, '1005')), false, 'named as you are, but not your primary group')
  assert.equal(groupOfYoursAlone(1000, sam, lists(null, users)), false, "the group lists can't be read (no getent, as on macOS)")
  assert.equal(groupOfYoursAlone(1000, sam, lists('sam:x:1000:\n', null)), false, "the user lists can't be read")
  assert.equal(groupOfYoursAlone(1000, sam, lists('sam:x:1000:\nsam:x:1000:kim\n', users)), false, 'two answers')
  // Asked once per group in a check.
  let asked = 0
  const you = youAre(1000, () => (asked++, true))
  assert.ok(you?.groupOfYours(5) && you.groupOfYours(5))
  assert.equal(asked, 1)
})

test('an empty folder of yours made 0700 is looked at again: what was put in it while others could write it makes it a folder that holds files', t => {
  const p = place(t)
  const late = path.join(p.tmp, 'late')
  fs.mkdirSync(late)
  fs.chmodSync(late, 0o775)
  // Someone puts a file in it between setup's first look and the chmod that shuts them out.
  const chmod = fs.chmodSync
  const mocked = t.mock.method(fs, 'chmodSync', ((file: fs.PathLike, mode: fs.Mode) => {
    if (String(file) === late) fs.writeFileSync(path.join(late, 'settings.json'), '{}')
    return chmod(file, mode)
  }) as typeof fs.chmodSync)
  assert.throws(() => p.check(late), (err: Error) => err instanceof SetupError && /late already holds files that agentvoice setup didn't make/.test(err.message))
  assert.equal(mocked.mock.callCount(), 1)
  mocked.mock.restore()
  assert.equal(fs.statSync(late).mode & 0o777, 0o700, 'shut, and refused')
})

// --- Writing -------------------------------------------------------------------------------------------------------
/** applySetup for a client's files into folder, as the command calls it. */
function apply(folder: string, files: SetupFile[], more: Partial<Apply> = {}) {
  const lines: string[] = []
  let repos = 0
  const manifest = (() => {
    try {
      return parseManifest(fs.readFileSync(path.join(folder, MANIFEST), 'utf8'))
    } catch {
      return null
    }
  })()
  const result = applySetup({
    folder,
    exists: fs.existsSync(folder),
    client: 'claude-code',
    files,
    manifest,
    replaceChanged: false,
    home: AV,
    command: [NODE, BIN, 'channel'],
    version: '0.3.0',
    again: 'agentvoice setup claude-code --replace-changed',
    makeRepo: () => (repos++, true),
    now: new Date(2026, 10, 22, 9, 5, 7),
    log: line => lines.push(line),
    ...more,
  })
  return { ...result, lines, repos }
}

const claudeFiles = (local?: string) => renderClaudeCode({ packageDir: ROOT, dataDir: DATA, local })
const modeOf = (file: string) => fs.statSync(file).mode & 0o777

test('setup writes each file 0600 in folders 0700, makes the folder a repository, and records what it wrote', t => {
  const tmp = tempDir(t)
  const folder = path.join(tmp, 'session')
  const result = apply(folder, claudeFiles())
  assert.deepEqual([result.made, result.repo, result.repos], [true, true, 1])
  assert.equal(modeOf(folder), 0o700)
  assert.equal(modeOf(path.join(folder, '.claude')), 0o700)
  assert.equal(modeOf(path.join(folder, '.claude/agents')), 0o700)
  for (const rel of [CLAUDE_SETTINGS, CLAUDE_AGENT, CLAUDE_LOCAL, MANIFEST]) assert.equal(modeOf(path.join(folder, rel)), 0o600, rel)
  assert.equal(fs.readFileSync(path.join(folder, CLAUDE_SETTINGS), 'utf8'), read('.claude/settings.json'))
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, MANIFEST), 'utf8'))
  assert.deepEqual(manifest, {
    package: PACKAGE_NAME,
    version: '0.3.0',
    home: AV,
    command: [NODE, BIN, 'channel'],
    clients: { 'claude-code': { files: { [CLAUDE_SETTINGS]: sha256(read('.claude/settings.json')), [CLAUDE_AGENT]: sha256(read('.claude/agents/meeting-assistant.md')) } } },
  })
  assert.match(manifest.clients['claude-code'].files[CLAUDE_SETTINGS], /^sha256:[0-9a-f]{64}$/)
  assert.deepEqual(fs.readdirSync(folder).filter(name => name.endsWith('.tmp')), [], 'no temporary file left')
  // Another client in the same folder adds its own entry; the first stays.
  apply(folder, renderCodex({ packageDir: ROOT, home: AV, dataDir: DATA, node: NODE, bin: BIN, homeDir: '/av-test-home/sam' }), { client: 'codex' })
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(folder, MANIFEST), 'utf8')).clients), ['claude-code', 'codex'])
})

test("running setup again refreshes the files it wrote (an upgrade's floor and agent), and merges into yours", t => {
  const tmp = tempDir(t)
  const folder = path.join(tmp, 'session')
  apply(folder, claudeFiles())
  fs.writeFileSync(path.join(folder, CLAUDE_LOCAL), JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }))
  // The next version's floor: setup's own file (the hash it recorded) is replaced, and the record follows.
  const upgraded = claudeFiles(fs.readFileSync(path.join(folder, CLAUDE_LOCAL), 'utf8')).map(file => (file.rel === CLAUDE_SETTINGS ? { ...file, content: file.content.replace('"deny": [', '"deny": [\n      "Read(//**/*.new)",') } : file))
  const again = apply(folder, upgraded)
  assert.deepEqual([again.made, again.lines], [false, []])
  assert.match(fs.readFileSync(path.join(folder, CLAUDE_SETTINGS), 'utf8'), /\*\.new/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, MANIFEST), 'utf8')).clients['claude-code'].files[CLAUDE_SETTINGS], sha256(upgraded[0].content))
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder, CLAUDE_LOCAL), 'utf8')).permissions.allow[0], 'Bash(ls)')
})

test("a file you changed, or one setup didn't write, at a path setup owns stops it with the difference, and --replace-changed keeps it as a backup", t => {
  const tmp = tempDir(t)
  const folder = path.join(tmp, 'session')
  apply(folder, claudeFiles())
  const settings = path.join(folder, CLAUDE_SETTINGS)
  const tightened = read('.claude/settings.json').replace('"Read(//**/.env)",', '"Read(//**/.env)",\n      "Read(//**/secrets/**)",')
  fs.writeFileSync(settings, tightened)
  const before = snapshot(tmp)
  assert.throws(
    () => apply(folder, claudeFiles()),
    (err: Error) => {
      assert.ok(err instanceof SetupError)
      const lines = err.message.split('\n')
      assert.match(lines[0], /^agentvoice setup claude-code wrote nothing: this file in .*session is not what setup wrote there last \(you changed it, or setup didn't make it\), and setup never replaces such a file unasked:$/)
      assert.ok(err.message.includes(`--- ${CLAUDE_SETTINGS} (yours)\n+++ ${CLAUDE_SETTINGS} (agentvoice setup's)\n@@ -2,7 +2,6 @@\n   "permissions": {\n     "deny": [\n       "Read(//**/.env)",\n-      "Read(//**/secrets/**)",\n       "Read(//**/.env.local)",\n`), err.message)
      assert.ok(err.message.endsWith('Your own rules belong in .claude/settings.local.json, which setup only adds to.\nTo replace it with the package\'s, keeping yours as a backup (<file>.before-setup-<date>-<time>): agentvoice setup claude-code --replace-changed'), err.message)
      return true
    },
  )
  assert.deepEqual(snapshot(tmp), before, 'nothing written')

  // One setup didn't write (no record of it): the same.
  const fresh = path.join(tmp, 'fresh')
  fs.mkdirSync(path.join(fresh, '.claude/agents'), { recursive: true })
  fs.writeFileSync(path.join(fresh, CLAUDE_AGENT), '---\nname: meeting-assistant\n---\nmine\n')
  fs.writeFileSync(path.join(fresh, MANIFEST), JSON.stringify(manifestFor(AV)))
  assert.throws(() => apply(fresh, claudeFiles()), /--- \.claude\/agents\/meeting-assistant\.md \(yours\)\n\+\+\+ \.claude\/agents\/meeting-assistant\.md \(agentvoice setup's\)/)
  assert.ok(!fs.existsSync(path.join(fresh, CLAUDE_SETTINGS)), 'nothing written, the files that were fine included')

  // --replace-changed: yours is kept beside it, then the package's is written.
  const replaced = apply(folder, claudeFiles(), { replaceChanged: true })
  const backup = `${settings}.before-setup-20261122-090507`
  assert.deepEqual(replaced.backups, [backup])
  assert.deepEqual(replaced.lines, [`Kept your ${CLAUDE_SETTINGS} as ${CLAUDE_SETTINGS}.before-setup-20261122-090507, and wrote the package's.`])
  assert.equal(fs.readFileSync(backup, 'utf8'), tightened)
  assert.equal(modeOf(backup), 0o600)
  assert.equal(fs.readFileSync(settings, 'utf8'), read('.claude/settings.json'))
  // Twice in the same second: a second backup, not over the first.
  fs.writeFileSync(settings, 'mine again')
  assert.deepEqual(apply(folder, claudeFiles(), { replaceChanged: true }).backups, [`${backup}-2`])
  assert.equal(fs.readFileSync(backup, 'utf8'), tightened)
})

test("Codex's meeting-assistant with its shell switched off is setup's own: setup goes on, and keeps it off", t => {
  const tmp = tempDir(t)
  const folder = path.join(tmp, 'session')
  const codex = (agent?: string) => renderCodex({ packageDir: ROOT, home: AV, dataDir: DATA, node: NODE, bin: BIN, homeDir: '/av-test-home/sam', agent })
  apply(folder, codex(), { client: 'codex' })
  const file = path.join(folder, CODEX_AGENT)
  const off = fs.readFileSync(file, 'utf8').replace(/# \[features\]\n# shell_tool = false\n$/, '[features]\nshell_tool = false\n')
  fs.writeFileSync(file, off)
  apply(folder, codex(off), { client: 'codex' })
  assert.equal(fs.readFileSync(file, 'utf8'), off)
  // And turned on again: still setup's.
  const on = off.replace(/\[features\]\nshell_tool = false\n$/, '# [features]\n# shell_tool = false\n')
  fs.writeFileSync(file, on)
  apply(folder, codex(on), { client: 'codex' })
  assert.equal(fs.readFileSync(file, 'utf8'), on)
})

test('a folder setup makes after its checks is made only in a folder no one else can change, and only by setup', t => {
  const p = place(t)
  const example = /Make the session folder where only you can change it, for example: mkdir -p ~\/agentvoice-session && cd ~\/agentvoice-session && agentvoice setup claude-code$/
  const refused = (folder: string, why: RegExp, more: Partial<Apply> = {}) => {
    const before = snapshot(p.tmp)
    assert.throws(() => apply(folder, claudeFiles(), more), (err: Error) => err instanceof SetupError && why.test(err.message) && example.test(err.message), folder)
    assert.deepEqual(snapshot(p.tmp), before, `${folder}: nothing made or written`)
  }
  // A missing parent, made by another user (open to all) between the checks and setup's own mkdir: in /tmp, say.
  const session = path.join(p.tmp, 'x/session')
  assert.deepEqual(p.check(session), { exists: false, manifest: null })
  const x = path.join(p.tmp, 'x')
  fs.mkdirSync(x)
  fs.chmodSync(x, 0o777)
  // Another user's, as root can make it; or, run as someone else, a folder of yours seen as a stranger's.
  const asRoot = process.geteuid?.() === 0
  if (asRoot) fs.chownSync(x, 65534, 65534)
  const stranger = asRoot ? {} : { you: { uid: 54321, groupOfYours: () => false } }
  refused(session, /^Setup was to make .*x\/session in .*x, which belongs to another user, and stopped: they could put a folder of their own in its place\. /, stranger)
  // The same folder of yours, open to all: refused too, with the chmod.
  if (asRoot) fs.chownSync(x, 0, 0)
  refused(session, /^Setup was to make .*x\/session in .*x, which its group or others can write to \(its mode is 777; to make it yours alone, run chmod go-w ".*x" and this again\), and stopped: /, asRoot ? {} : { you: youAre(undefined, () => false) })
  // Once it is yours alone, setup goes on.
  fs.chmodSync(x, 0o700)
  assert.equal(apply(session, claudeFiles()).made, true)

  // The session folder itself, made by something else after the checks: setup takes only a folder it makes.
  const late = path.join(p.tmp, 'late')
  assert.deepEqual(p.check(late), { exists: false, manifest: null })
  fs.mkdirSync(late)
  refused(late, /^.*late was made while setup ran, after its checks, by something other than setup, so setup stopped: it takes only a folder it makes, or one that was there when it checked\. /, { exists: false })
  assert.deepEqual(fs.readdirSync(late), [])

  // Or one made in the instant between setup's look and its mkdir: mkdir fails, and setup stops.
  const race = path.join(p.tmp, 'race')
  const mkdir = fs.mkdirSync
  const mocked = t.mock.method(fs, 'mkdirSync', ((dir: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
    if (String(dir) === race && !fs.existsSync(race)) mkdir(race)
    return mkdir(dir, options)
  }) as typeof fs.mkdirSync)
  try {
    assert.throws(() => apply(path.join(race, 'session'), claudeFiles()), (err: Error) => err instanceof SetupError && /^.*race was made while setup ran, after its checks, by something other than setup, so setup stopped/.test(err.message) && example.test(err.message))
  } finally {
    mocked.mock.restore()
  }
  assert.deepEqual(fs.readdirSync(race), [], 'nothing made in it')
})

test('setup never writes outside the folder: a link in it that leads out, or a folder where a file goes, stops it', t => {
  const tmp = tempDir(t)
  const folder = path.join(tmp, 'session')
  const outside = path.join(tmp, 'dot-claude')
  fs.mkdirSync(path.join(folder), { recursive: true })
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(folder, MANIFEST), JSON.stringify(manifestFor(AV)))
  fs.symlinkSync(outside, path.join(folder, '.claude'))
  const before = snapshot(tmp)
  assert.throws(() => apply(folder, claudeFiles()), /leads out of .*session \(through a link\): setup writes only inside the folder/)
  assert.deepEqual(snapshot(tmp), before)
  assert.deepEqual(fs.readdirSync(outside), [])
  fs.rmSync(path.join(folder, '.claude'))
  fs.mkdirSync(path.join(folder, CLAUDE_SETTINGS), { recursive: true })
  assert.throws(() => apply(folder, claudeFiles()), /settings\.json is a folder, where setup writes a file: move it away/)
})

test('the difference is a unified diff with three lines around each change', () => {
  const a = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'].join('\n')
  const b = ['1', '2', '3', '4', 'five', '6', '7', '8', '9', '10', '11', '12', '13'].join('\n')
  assert.equal(unifiedDiff(a, b, 'a (yours)', 'a (setup)'), ['--- a (yours)', '+++ a (setup)', '@@ -2,7 +2,7 @@', ' 2', ' 3', ' 4', '-5', '+five', ' 6', ' 7', ' 8', '@@ -10,3 +10,4 @@', ' 10', ' 11', ' 12', '+13'].join('\n'))
  assert.equal(unifiedDiff('', 'x\n', 'a', 'b'), ['--- a', '+++ b', '@@ -1,1 +1,2 @@', '+x', ' '].join('\n'))
})

test("a setup's record says when it is out of date: another version, node, bin or AgentVoice folder, or a node that is gone", () => {
  const m = manifestFor(AV)
  const now = { version: '0.2.0', home: AV, node: NODE, bin: BIN }
  assert.deepEqual(staleReasons(m, now, () => true), [])
  assert.deepEqual(staleReasons(m, { ...now, version: '0.3.0' }, () => true), ['it was set up by AgentVoice 0.2.0, and this is 0.3.0'])
  assert.deepEqual(staleReasons(m, { ...now, node: '/opt/homebrew/opt/node/bin/node' }, () => true), [`its configs start the channel with ${NODE}, not /opt/homebrew/opt/node/bin/node`])
  assert.deepEqual(staleReasons(m, now, () => false), [`the node its configs start the channel with, ${NODE}, is no longer there`])
  assert.deepEqual(staleReasons(m, { ...now, bin: '/other/bin/agentvoice.js' }, () => true), [`its configs start ${BIN}, not this AgentVoice's /other/bin/agentvoice.js`])
  assert.deepEqual(staleReasons(m, { ...now, home: '/srv/av' }, () => true), ['it is for the AgentVoice folder /av-test-home/sam/.agentvoice, and this one is /srv/av'])
  // A record setup didn't write is none at all.
  assert.equal(parseManifest('{"package":"other"}'), null)
  assert.equal(parseManifest('not json'), null)
  assert.equal(parseManifest(JSON.stringify({ ...m, clients: { cursor: { files: {} } } })), null)
})
