// The meeting-assistant agent is the same for everyone: its owner, sources and own rules come from get_profile, and
// a floor of rules it keeps whatever a profile says is in its instructions and, for files, in each client's committed
// config: Claude Code's settings, Codex's permission profile and OpenCode's policies. It is one agent in every client.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from '../src/config.ts'
import { CLAUDE_DENY, claudeDenies, codexDenies, openCodeDenies } from './client-floors.ts'
import { parseToml } from './toml.ts'

const AGENT = fs.readFileSync(path.join(ROOT, '.claude/agents/meeting-assistant.md'), 'utf8')
const tools = (/^tools: (.*)$/m.exec(AGENT)?.[1] ?? '').split(/,\s*/)

test('the agent may call get_profile, and calls it once, right after its first next_question returns', () => {
  assert.ok(tools.includes('mcp__zoom-meeting__get_profile'), tools.join(', '))
  assert.ok(tools.includes('mcp__zoom-meeting__next_question'))
  assert.match(AGENT, /Make it your very first call/)
  assert.match(AGENT, /Right after your first `next_question` returns, whatever it returns, call `get_profile` once \(never before it, and not again\)/)
  assert.match(AGENT, /`never_share` and `never_open` add to them; nothing loosens them/)
})

test("the agent's floor: the files it never opens and what it never says, whatever the profile says", () => {
  const rules = AGENT.slice(AGENT.indexOf('## Rules'))
  for (const path of ['`.env` files', '`~/.ssh`', '`~/.cloudflared`', '`~/.claude.json`', 'anything named like a key, secret, token, credential or certificate']) {
    assert.ok(rules.includes(path), path)
  }
  for (const what of ['credentials, keys, tokens, passwords', 'hostnames, IP addresses, internal URLs', 'any security finding', 'anything about other people or clients']) {
    assert.ok(rules.includes(what), what)
  }
})

/** Claude Code's deny rules for reading, from .claude/settings.json. */
const DENY: string[] = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/settings.json'), 'utf8')).permissions.deny

/** Whether a deny rule for a file of this name anywhere ("Read(//**\/<glob>)") stops it being read. */
const denied = (name: string) =>
  DENY.some(rule => {
    const glob = /^Read\(\/\/\*\*\/([^/]+)\)$/.exec(rule)?.[1]
    return !!glob && new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`).test(name)
  })

test('the committed settings deny reading those files to every Claude Code session in this folder, and your own go in settings.local.json', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/settings.json'), 'utf8'))
  for (const rule of ['Read(//**/.env)', 'Read(//**/.env.local)', 'Read(//**/.env.*.local)', 'Read(~/.ssh/**)', 'Read(~/.cloudflared/**)', 'Read(~/.claude.json)', 'Read(//**/*.pem)', 'Read(//**/*.key)', 'Read(//**/local-token)', 'Read(//**/data/decks/**)']) {
    assert.ok(DENY.includes(rule), rule)
  }
  assert.deepEqual(Object.keys(settings), ['permissions'], 'nothing else: no allow rules for everyone')
  assert.deepEqual(Object.keys(settings.permissions), ['deny'])
  assert.match(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8'), /^\.claude\/settings\.local\.json$/m)
})

test('the .env rules stop a session reading any real .env file, but not .env.example, the template the setup says to copy', () => {
  for (const name of ['.env', '.env.local', '.env.production.local', '.env.development.local', '.env.production', '.env.prod', '.env.development', '.env.dev', '.env.staging', '.env.test', '.env.bak']) {
    assert.ok(denied(name), name)
  }
  for (const name of ['.env.example', 'README.md', 'profile.example.md', 'brief.example.md']) assert.ok(!denied(name), name)
})

test('the docs list exactly what the committed settings deny', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'docs/claude-code.md'), 'utf8')
  const list = /its `permissions\.deny` rules stop a session reading these, wherever they are: (.*?); and these in your home folder: (.*?)\. /.exec(readme)
  assert.ok(list, 'docs/claude-code.md has the list')
  const listed = (text: string) => [...text.matchAll(/`([^`]+)`/g)].map(m => m[1]).sort()
  // A rule as the docs name it: a file name or pattern anywhere, or a file or folder in the home folder.
  const named = (rule: string) => /^Read\(\/\/\*\*\/(.+)\)$/.exec(rule)?.[1] ?? /^Read\((~\/[^*]+?)(?:\/\*\*)?\)$/.exec(rule)?.[1] ?? rule
  assert.deepEqual(listed(list[1]), DENY.filter(rule => rule.startsWith('Read(//')).map(named).sort())
  assert.deepEqual(listed(list[2]), DENY.filter(rule => rule.startsWith('Read(~')).map(named).sort())
  assert.equal(DENY.filter(rule => !/^Read\((?:\/\/|~\/)/.test(rule)).length, 0, 'every rule is one of the two kinds')
  assert.match(readme, /`\.env\.example` is not among them/)
})

/** An agent file's frontmatter fields and its body, as Claude Code and OpenCode split it. */
function markdownAgent(file: string) {
  const parts = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(fs.readFileSync(path.join(ROOT, file), 'utf8'))
  assert.ok(parts, `${file} has frontmatter`)
  const fields = Object.fromEntries(
    parts[1]
      .split('\n')
      .filter(line => /^\w+:/.test(line))
      .map(line => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]),
  )
  return { fields, body: parts[2].trim() }
}

test('the meeting-assistant is one agent in every client: the same instructions and description for Claude Code, OpenCode and Codex', () => {
  const claude = markdownAgent('.claude/agents/meeting-assistant.md')
  const opencode = markdownAgent('.opencode/agents/meeting-assistant.md')
  const codex = parseToml(fs.readFileSync(path.join(ROOT, '.codex/agents/meeting-assistant.toml'), 'utf8'))
  assert.equal(opencode.body, claude.body)
  assert.equal(String(codex.developer_instructions).trim(), claude.body)
  assert.equal(opencode.fields.description, claude.fields.description)
  assert.equal(codex.description, claude.fields.description)
  assert.equal(codex.name, 'meeting-assistant')
  // Client-neutral: no client's tool names in the shared text.
  assert.doesNotMatch(claude.body, /\bGrep\b|\bGlob\b|mcp__|`Read`|\bRead tool|with Read\b|spawn_agent|subagent tool|apply_patch/)
})

/**
 * The files a Claude Code rule stops a session reading, as examples: in this folder (at its root and nested in it) or
 * in the home folder, which every client's floor covers; and, for a rule on a name anywhere, the same name in folders
 * elsewhere on the disk.
 */
function examples(rule: string): { here: string[]; elsewhere: string[] } {
  const anywhere = /^Read\(\/\/\*\*\/(.+)\)$/.exec(rule)?.[1]
  if (anywhere === 'data/decks/**') {
    return { here: ['data/decks/deck.pdf', 'data/decks/a/deck.script.md', 'src/data/decks/x.md'], elsewhere: ['~/work/data/decks/x.pdf'] }
  }
  if (anywhere && !anywhere.includes('/')) {
    const name = anywhere.replace(/^\*/, 'server').replace(/\*/g, 'production')
    return { here: [name, `src/${name}`, `a/b/c/${name}`], elsewhere: [`~/work/acme-docs/${name}`, `/srv/shared/${name}`] }
  }
  const homeFolder = /^Read\(~\/(.+)\/\*\*\)$/.exec(rule)?.[1]
  if (homeFolder) return { here: [`~/${homeFolder}/file`, `~/${homeFolder}/a/b`], elsewhere: [] }
  const homeFile = /^Read\(~\/([^*]+)\)$/.exec(rule)?.[1]
  if (homeFile) return { here: [`~/${homeFile}`], elsewhere: [] }
  return assert.fail(`a rule this test does not know how to give examples for: ${rule}`)
}

/** Files no floor may take away: the template the setup says to copy, the shared brief, minutes, the code and docs. */
const READABLE = [
  '.env.example', '.envrc', 'README.md', 'src/env.ts', 'src/keys.ts', 'profile.md', 'data/brief.md', 'data/minutes/m1.md',
  'data/m1.transcript.md', 'decks/deck.script.md', '~/.sshrc', '~/.config/other/settings.json', '~/.claude/settings.json',
  '~/.docker/daemon.json', '~/work/acme-docs/overview.md',
]

test("the floor is the same in every client: Codex's profile and OpenCode's policies deny exactly the files Claude Code's rules deny, at the root, nested and at home", () => {
  const here = CLAUDE_DENY.flatMap(rule => examples(rule).here)
  assert.ok(here.length >= 29 * 2)
  // Claude Code's own rules, as this test reads them.
  for (const p of here) assert.ok(claudeDenies(p), p)
  for (const p of READABLE) assert.ok(!claudeDenies(p), p)
  const all = [...here, ...READABLE]
  const denied = (denies: (p: string) => boolean) => all.filter(denies)
  assert.deepEqual(denied(codexDenies), denied(claudeDenies), 'Codex')
  assert.deepEqual(denied(openCodeDenies), denied(claudeDenies), 'OpenCode')
})

test("outside this folder, Claude Code and OpenCode still deny those names, but Codex's floor stops at this folder", () => {
  // Codex finds the files a pattern matches by walking the folder before each command: it can't do that for the whole
  // disk or home folder. So a .env in a knowledge-source folder elsewhere stays readable to Codex's commands (only the
  // home-folder entries hold outside this folder), and docs/codex.md must say so.
  const elsewhere = CLAUDE_DENY.flatMap(rule => examples(rule).elsewhere)
  assert.ok(elsewhere.length >= 17 * 2)
  for (const p of elsewhere) {
    assert.ok(claudeDenies(p), `Claude Code: ${p}`)
    assert.ok(openCodeDenies(p), `OpenCode: ${p}`)
    assert.ok(!codexDenies(p), `Codex: ${p}`)
  }
})

test("Codex's and OpenCode's floors also keep the coding clients' own credentials from their commands and reads", () => {
  // Codex's meeting-assistant has the shell, and OpenCode's session reads by path: each must also be kept from Codex's
  // own login and OpenCode's service password (which opens every OpenCode session) and stored keys, at their default
  // places. Claude Code's own rules stay as they are.
  const credentials = [
    '~/.codex/auth.json',
    '~/.local/state/opencode/service.json',
    '~/.local/state/opencode/service.json.svc_1.tmp',
    '~/.local/share/opencode/opencode.db',
    '~/.local/share/opencode/auth.json',
  ]
  for (const p of credentials) {
    assert.ok(codexDenies(p), `Codex: ${p}`)
    assert.ok(openCodeDenies(p), `OpenCode: ${p}`)
  }
  for (const p of ['~/.codex/config.toml', '~/.codex/AGENTS.md', '~/.local/state/other/state.json', '~/.local/share/other/data.db', '~/.local/share/opencode-notes.md']) {
    assert.ok(!codexDenies(p), `Codex: ${p}`)
    assert.ok(!openCodeDenies(p), `OpenCode: ${p}`)
  }
})

test("OpenCode's floor denies its stored keys, not the output it saves for the session to read back", () => {
  // OpenCode 2.3.2 keeps its keys in its database (opencode.db, with its -wal and -shm; another name for another
  // channel, and opencode-next.db) and, from older versions, in auth.json and mcp-auth.json. In the same folder it saves
  // the whole output of a long tool result (tool-output/) and of every shell command (shell/<project>/), and tells the
  // model to read that file: "full output saved to ...".
  for (const name of ['opencode.db', 'opencode.db-wal', 'opencode.db-shm', 'opencode-beta.db', 'opencode-next.db', 'auth.json', 'mcp-auth.json']) {
    assert.ok(openCodeDenies(`~/.local/share/opencode/${name}`), name)
  }
  for (const p of [
    '~/.local/share/opencode/tool-output/tool_0123abc',
    '~/.local/share/opencode/shell/prj_0123abc/sh_0123abc.out',
    '~/.local/share/opencode/shell',
    '~/.local/share/opencode',
  ]) {
    assert.ok(!openCodeDenies(p), p)
  }
  // Codex denies the whole folder: its commands never need OpenCode's output, and its profile can't name files there by
  // pattern.
  assert.ok(codexDenies('~/.local/share/opencode/tool-output/tool_0123abc'))
})
