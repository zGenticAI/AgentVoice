// OpenCode's committed config (opencode.json), its meeting-assistant (.opencode/agents/meeting-assistant.md) and the
// script that writes each user's own .opencode/opencode.json. Rules are checked the way OpenCode 2.3.2 checks them, with
// its own matching copied below: the floor as policies against a root and a nested file of each kind, the prompts, the
// agent's tools, and that a user's own file can let the agent read a folder outside this one and nothing more.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT } from '../src/config.ts'
import { openCodeMatch } from './client-floors.ts'

type Rule = { action: string; resource: string; effect: 'allow' | 'deny' | 'ask' }
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'opencode.json'), 'utf8'))
const POLICIES: Rule[] = CONFIG.policies
const GLOBAL: Rule[] = CONFIG.permissions
const AGENT_RULES: Rule[] = CONFIG.agents['meeting-assistant'].permissions

/** OpenCode's wildcard match (packages/core/src/util/wildcard.ts at v2.3.2). */
const match = openCodeMatch
/** A permission check (packages/core/src/permission.ts, evaluate): the last rule that matches, else ask. */
const evaluate = (action: string, resource: string, rules: Rule[]) =>
  rules.findLast(rule => match(action, rule.action) && match(resource, rule.resource))?.effect ?? 'ask'
/** A policy check (packages/core/src/config/plugin/policy.ts): the last tool.use statement matching "<action>:<resource>". */
const policyDenies = (action: string, resource: string) =>
  POLICIES.findLast(policy => policy.action === 'tool.use' && match(`${action}:${resource}`, policy.resource))?.effect === 'deny'
/** What every agent starts with (docs "Permissions", Defaults), before the config's own rules. */
const BASE: Rule[] = [
  { action: '*', resource: '*', effect: 'allow' },
  { action: 'read', resource: '*.env', effect: 'ask' },
  { action: 'read', resource: '*.env.*', effect: 'ask' },
  { action: 'read', resource: '*.env.example', effect: 'allow' },
]

/** Claude Code's floor, .claude/settings.json: the files no session in this folder may read. */
const DENY: string[] = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/settings.json'), 'utf8')).permissions.deny

/**
 * Paths a Claude Code rule covers, as OpenCode names them to its read check: relative to where OpenCode was opened for
 * a file in the project (at its root, nested, or above it when opened in a subfolder), absolute for any other file.
 */
function covered(rule: string): string[] {
  const anywhere = /^Read\(\/\/\*\*\/(.+)\)$/.exec(rule)?.[1]
  if (anywhere === 'data/decks/**') {
    return ['data/decks', 'data/decks/deck.pdf', 'data/decks/a/deck.script.md', 'src/data/decks/x.md', '../data/decks/x.pdf', '/home/sam/av/data/decks/x.pdf']
  }
  if (anywhere && !anywhere.includes('/')) {
    const name = anywhere.replace(/^\*/, 'server').replace(/\*/g, 'production')
    return [name, `src/${name}`, `a/b/${name}`, `../${name}`, `/home/sam/other/${name}`]
  }
  const homeFolder = /^Read\(~\/(.+)\/\*\*\)$/.exec(rule)?.[1]
  if (homeFolder) return [`/home/sam/${homeFolder}`, `/home/sam/${homeFolder}/file`, `/home/sam/${homeFolder}/a/b`, `/srv/sam/${homeFolder}/x`]
  const homeFile = /^Read\(~\/([^*]+)\)$/.exec(rule)?.[1]
  if (homeFile) return [`/home/sam/${homeFile}`, `/srv/sam/${homeFile}`]
  assert.fail(`a rule this test does not know how to check: ${rule}`)
}

test('the floor: every file Claude Code may not read here, OpenCode may not either, at the root and nested alike', () => {
  assert.ok(DENY.length >= 29)
  for (const rule of DENY) {
    for (const resource of covered(rule)) assert.ok(policyDenies('read', resource), `${rule}: ${resource}`)
  }
  // Not the template the setup says to copy, the shared brief, transcripts and minutes, or anything else.
  for (const resource of ['.env.example', '.envrc', 'README.md', 'src/env.ts', 'data/brief.md', 'data/minutes/m1.md', 'data/m1.transcript.md', 'decks/deck.script.md', 'profile.md', '/home/sam/work/acme-docs/overview.md']) {
    assert.ok(!policyDenies('read', resource), resource)
  }
  // A pattern like */.env alone misses the root file: each name has its root form too.
  assert.ok(!match('read:.env', 'read:*/.env'))
  // Policies only ever deny reading: they are the floor, and nothing in them allows.
  for (const policy of POLICIES) {
    assert.equal(policy.action, 'tool.use')
    assert.equal(policy.effect, 'deny')
    assert.match(policy.resource, /^read:/)
  }
})

test('the channel runs as zoom-meeting, with direct tools, as OpenCode, with no limit on how long a call may take', () => {
  assert.deepEqual(Object.keys(CONFIG.mcp), ['servers'], 'no mcp.timeout: a number there caps every call')
  const server = CONFIG.mcp.servers['zoom-meeting']
  assert.deepEqual(server, {
    type: 'local',
    command: ['node_modules/.bin/tsx', 'src/channel/server.ts'],
    codemode: false,
    environment: { AGENTVOICE_CLIENT: 'opencode' },
  })
  // The same server scripts/install-channel.sh registers for Claude Code.
  const claude = fs.readFileSync(path.join(ROOT, 'scripts/install-channel.sh'), 'utf8')
  assert.match(claude, /-- "\$DIR\/node_modules\/\.bin\/tsx" "\$DIR\/src\/channel\/server\.ts"$/m)
})

test("the owner's session is asked before joining, setting the brief, steering slides and running npm run slides; the rest runs", () => {
  const rules = [...BASE, ...GLOBAL]
  for (const tool of ['join_meeting', 'set_brief', 'slides_control']) assert.equal(evaluate(`zoom-meeting_${tool}`, '*', rules), 'ask', tool)
  for (const command of ['npm run slides -- prepare deck.pdf', 'npm run slides -- check deck.script.md', 'npm run slides']) {
    assert.equal(evaluate('shell', command, rules), 'ask', command)
  }
  for (const tool of ['next_question', 'get_profile', 'reply', 'post_chat', 'get_transcript', 'add_to_brief', 'slides_status', 'why_not_answered']) {
    assert.equal(evaluate(`zoom-meeting_${tool}`, '*', rules), 'allow', tool)
  }
  assert.equal(evaluate('shell', 'npm test', rules), 'allow')
})

const SIX = ['next_question', 'get_profile', 'reply', 'post_chat', 'get_transcript', 'add_to_brief']

test("OpenCode's built-in General subagent may use none of the channel's tools, whatever is saved as always allowed", () => {
  // General has every tool the session has (packages/core/src/plugin/agent.ts at 2.3.2 denies it only question and
  // subagent): with them it could take the questions, or be taken for the owner's session. A configured deny beats a
  // saved "Allow always" (permission.ts, evaluateInput), so this holds after one too. The channel also takes no
  // subagent's session as the owner's (src/channel/push-opencode.ts).
  const GENERAL: Rule[] = CONFIG.agents.general.permissions
  const builtIn: Rule[] = [{ action: 'question', resource: '*', effect: 'deny' }, { action: 'subagent', resource: '*', effect: 'deny' }]
  const rules = [...BASE, ...GLOBAL, ...builtIn, ...GENERAL]
  for (const tool of [...SIX, 'join_meeting', 'set_brief', 'slides_status', 'slides_control', 'why_not_answered']) {
    assert.equal(evaluate(`zoom-meeting_${tool}`, '*', rules), 'deny', tool)
  }
  // Its other tools are as OpenCode makes them.
  assert.equal(evaluate('read', 'docs/setup.md', rules), 'allow')
  assert.equal(evaluate('shell', 'npm test', rules), 'allow')
  assert.deepEqual(Object.keys(CONFIG.agents.general), ['permissions'], 'nothing else of it is changed')
})

test('the meeting-assistant may use its six tools and read, and nothing else', () => {
  const rules = [...BASE, ...GLOBAL, ...AGENT_RULES]
  assert.deepEqual(AGENT_RULES[0], { action: '*', resource: '*', effect: 'deny' }, 'everything is denied first')
  for (const tool of SIX) assert.equal(evaluate(`zoom-meeting_${tool}`, '*', rules), 'allow', tool)
  assert.equal(evaluate('read', 'docs/setup.md', rules), 'allow')
  for (const tool of ['join_meeting', 'set_brief', 'slides_control', 'slides_status', 'why_not_answered']) {
    assert.equal(evaluate(`zoom-meeting_${tool}`, '*', rules), 'deny', tool)
  }
  for (const [action, resource] of [
    ['grep', 'alpha'], ['glob', '**/*'], ['shell', 'cat .env'], ['shell', 'npm run slides -- prepare x.pdf'], ['edit', 'README.md'], ['write', 'x.md'],
    ['webfetch', 'https://example.com'], ['websearch', 'x'], ['subagent', 'general'], ['question', '*'], ['skill', 'x'], ['execute', '*'],
    ['external_directory', '/home/sam/work/*'], ['experimental_image_generate', 'x/y'],
  ]) {
    assert.equal(evaluate(action, resource, rules), 'deny', `${action} ${resource}`)
  }
  // Its reads still meet the floor, which no agent rule can lift.
  assert.ok(policyDenies('read', '.env') && policyDenies('read', 'data/decks/deck.pdf'))
})

test("a user's own .opencode/opencode.json, read after the committed file, lets the agent read the folders it names, and no others", () => {
  // OpenCode appends an agent's rules from each config file in order: the committed opencode.json, then
  // .opencode/opencode.json (config.ts: direct files, then project ones), then .opencode/agents/*.md. So the agent's
  // rules live in opencode.json, not in its .md, where they would come last and undo the user's.
  const mine: Rule[] = [{ action: 'external_directory', resource: '/home/sam/work/acme-docs/*', effect: 'allow' }]
  const rules = [...BASE, ...GLOBAL, ...AGENT_RULES, ...mine]
  assert.equal(evaluate('external_directory', '/home/sam/work/acme-docs/status/*', rules), 'allow')
  assert.equal(evaluate('external_directory', '/home/sam/work/acme-ops/*', rules), 'deny')
  assert.equal(evaluate('zoom-meeting_join_meeting', '*', rules), 'deny')
  assert.ok(policyDenies('read', '/home/sam/work/acme-docs/.env'), 'the floor still holds there')
})

/** An agent file's frontmatter keys and its body, as OpenCode and Claude Code split it. */
function agentFile(file: string) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
  const parts = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)
  assert.ok(parts, `${file} has frontmatter`)
  const fields = Object.fromEntries(
    parts[1]
      .split('\n')
      .filter(line => /^\w+:/.test(line))
      .map(line => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]),
  )
  return { fields, body: parts[2].trim() }
}

test("the meeting-assistant is the same agent in every client: one body, the same description, no model of OpenCode's own", () => {
  const claude = agentFile('.claude/agents/meeting-assistant.md')
  const opencode = agentFile('.opencode/agents/meeting-assistant.md')
  assert.equal(opencode.body, claude.body)
  assert.doesNotMatch(claude.body, /\bGrep\b|\bGlob\b|mcp__|`Read`|\bRead tool|with Read\b/, 'no client-specific tool names in the shared body')
  assert.equal(opencode.fields.description, claude.fields.description)
  assert.equal(opencode.fields.mode, 'subagent')
  assert.deepEqual(Object.keys(opencode.fields).sort(), ['description', 'mode'], 'no model, no steps (OpenCode takes tools away on the last step), no permissions here')
  assert.equal(CONFIG.agents['meeting-assistant'].mode, 'subagent')
  assert.equal(claude.fields.model, 'sonnet', "Claude Code's keeps its model")
})

// --- scripts/install-opencode.sh ---------------------------------------------------------------------------------
/** A copy of this folder's parts the script uses, a fake opencode of the given version, and a home folder. */
function installSandbox(t: { after: (fn: () => unknown) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-oc-install-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const repo = path.join(dir, 'repo')
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'node_modules/.bin'), { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'scripts/install-opencode.sh'), path.join(repo, 'scripts/install-opencode.sh'))
  fs.copyFileSync(path.join(ROOT, 'opencode.json'), path.join(repo, 'opencode.json'))
  fs.writeFileSync(path.join(repo, 'node_modules/.bin/tsx'), '#!/bin/sh\n', { mode: 0o755 })
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'opencode'), '#!/bin/sh\necho "opencode v$FAKE_OPENCODE_VERSION"\n', { mode: 0o755 })
  const home = path.join(dir, 'home')
  const sources = path.join(home, 'work', 'acme-docs')
  fs.mkdirSync(sources, { recursive: true })
  fs.mkdirSync(path.join(home, 'work', 'acme-site'))
  const run = (args: string[], version = '2.3.2', withOpencode = true) =>
    spawnSync('bash', [path.join(repo, 'scripts/install-opencode.sh'), ...args], {
      encoding: 'utf8',
      env: {
        PATH: [...(withOpencode ? [bin] : []), path.dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
        HOME: home,
        FAKE_OPENCODE_VERSION: version,
      },
    })
  const written = path.join(repo, '.opencode/opencode.json')
  const mine = () => JSON.parse(fs.readFileSync(written, 'utf8'))
  return { repo, home, sources, run, written, mine }
}

test('install-opencode.sh writes your own .opencode/opencode.json: the same channel, by absolute path', t => {
  const box = installSandbox(t)
  const r = box.run([])
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(box.mine(), {
    $schema: 'https://opencode.ai/config.json',
    mcp: { servers: { 'zoom-meeting': { ...CONFIG.mcp.servers['zoom-meeting'], command: [path.join(box.repo, 'node_modules/.bin/tsx'), path.join(box.repo, 'src/channel/server.ts')] } } },
  })
  assert.match(r.stdout, /reads only inside this folder/)
  assert.match(r.stdout, /Change opencode\.json or \.opencode\/ only between meetings/)
})

test('install-opencode.sh --source lets the meeting-assistant read those folders, keeps them on a rerun, and keeps what else you wrote', t => {
  const box = installSandbox(t)
  const site = path.join(box.home, 'work', 'acme-site')
  assert.equal(box.run(['--source', '~/work/acme-docs', '--source', site]).status, 0)
  const rules = [
    { action: 'external_directory', resource: `${fs.realpathSync(box.sources)}/*`, effect: 'allow' },
    { action: 'external_directory', resource: `${fs.realpathSync(site)}/*`, effect: 'allow' },
  ]
  assert.deepEqual(box.mine().agents, { 'meeting-assistant': { permissions: rules } })

  // Your own settings in that file stay; a rerun without --source keeps the folders.
  fs.writeFileSync(box.written, JSON.stringify({ ...box.mine(), model: 'someprovider/somemodel' }))
  assert.equal(box.run([]).status, 0)
  assert.equal(box.mine().model, 'someprovider/somemodel')
  assert.deepEqual(box.mine().agents['meeting-assistant'].permissions, rules)
  // A new --source list replaces the folders; --no-sources takes them all away.
  assert.equal(box.run(['--source', site]).status, 0)
  assert.deepEqual(box.mine().agents['meeting-assistant'].permissions, [rules[1]])
  const r = box.run(['--no-sources'])
  assert.equal(r.status, 0)
  assert.equal(box.mine().agents, undefined)
  assert.equal(box.mine().model, 'someprovider/somemodel')
})

test("install-opencode.sh refuses OpenCode V1, a 2.x older than 2.3.2, no OpenCode, and sources it can't take, writing nothing", t => {
  const box = installSandbox(t)
  const refused = (r: ReturnType<typeof box.run>, why: RegExp) => {
    assert.equal(r.status === 0, false, r.stdout)
    assert.match(r.stderr, why)
    assert.equal(fs.existsSync(box.written), false)
  }
  refused(box.run([], '1.19.6'), /OpenCode 1\.19\.6 is V1 \(npm opencode-ai\), which AgentVoice doesn't support[\s\S]*npm install -g @opencode\/cli/)
  refused(box.run([], '2.3.1'), /older than 2\.3\.2/)
  refused(box.run([], '2.2.9'), /older than 2\.3\.2/)
  refused(box.run([], '', false), /OpenCode is not installed/)
  refused(box.run(['--source', path.join(box.home, 'missing')]), /is not a folder this script can find/)
  refused(box.run(['--source', box.home]), /your whole disk or home folder/)
  refused(box.run(['--source', '/']), /your whole disk or home folder/)
  refused(box.run(['--bogus']), /Unknown option/)
  const later = box.run([], '2.10.0')
  assert.equal(later.status, 0, later.stderr)
  const next = box.run([], '3.0.0')
  assert.equal(next.status, 0, next.stderr)
  assert.match(next.stdout, /newer than AgentVoice was tested with \(2\.3\.2\)/)
  // A file of yours it can't read as JSON is left as it is.
  fs.writeFileSync(box.written, '{ // a comment\n}')
  const r = box.run([])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /is not plain JSON/)
  assert.equal(fs.readFileSync(box.written, 'utf8'), '{ // a comment\n}')
})

test('your own .opencode/opencode.json is never committed; the shared config and agent are', () => {
  const ignored = (file: string) => spawnSync('git', ['check-ignore', '--no-index', '-q', file], { cwd: ROOT }).status === 0
  assert.ok(ignored('.opencode/opencode.json'))
  assert.ok(ignored('.opencode/opencode.jsonc'))
  assert.ok(!ignored('.opencode/agents/meeting-assistant.md'))
  assert.ok(!ignored('opencode.json'))
})
