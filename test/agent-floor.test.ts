// The meeting-assistant agent is the same for everyone: its owner, sources and own rules come from get_profile, and
// a floor of rules it keeps whatever a profile says is in its instructions and, for files, in the committed
// Claude Code settings.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from '../src/config.ts'

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
  for (const rule of ['Read(//**/.env)', 'Read(//**/.env.local)', 'Read(//**/.env.*.local)', 'Read(~/.ssh/**)', 'Read(~/.cloudflared/**)', 'Read(~/.claude.json)', 'Read(//**/*.pem)', 'Read(//**/*.key)', 'Read(//**/local-token)']) {
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
