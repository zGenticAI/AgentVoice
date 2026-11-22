// What the pages on the coding clients (docs/codex.md, docs/opencode.md, the README and the pages they touch) quote
// from the code and the committed configs: the tested versions, which tools ask first, the shell switch, the log lines,
// the line Alex says, and the shape of a message OpenCode's session is sent. A change to any of them must change the
// docs as well.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from '../src/config.ts'
import { SESSION_OFFLINE_LINE } from '../src/consent.ts'
import { OPENCODE_TESTED } from '../src/channel/push-opencode.ts'
import { EVENT_HEADER, plainEvent } from '../src/channel/sink.ts'
import { REPORT_END as FLUX_REPORT_END } from '../src/probe/flux-report.ts'
import { REPORT_END as SHARE_REPORT_END } from '../src/sharetest/report.ts'
import { CODEX_TESTED } from '../src/setup/codex.ts'
import { slidesNote } from '../src/slides/platforms.ts'
import { CODEX_CONFIG, OPENCODE_CONFIG, type OpenCodeRule } from './client-floors.ts'
import type { TomlTable } from './toml.ts'

const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8')
const CODEX = read('docs/codex.md')
const OPENCODE = read('docs/opencode.md')
const README = read('README.md')

test('the pages name the versions the setup scripts and the channel check', () => {
  const codex = /^TESTED=(\d+\.\d+\.\d+)$/m.exec(read('scripts/install-codex.sh'))?.[1]
  assert.ok(codex)
  // agentvoice setup codex checks the same version as the clone's script.
  assert.equal(codex, CODEX_TESTED)
  assert.ok(CODEX.includes(`Tested with Codex CLI ${codex}`))
  assert.ok(CODEX.includes(`Codex CLI ${codex} or later`))
  assert.ok(README.includes(`**Codex CLI** ${codex} or later`))
  const opencode = /^NEED=(\d+\.\d+\.\d+)$/m.exec(read('scripts/install-opencode.sh'))?.[1]
  assert.equal(opencode, OPENCODE_TESTED)
  assert.ok(OPENCODE.includes(`Tested with OpenCode ${opencode}`))
  assert.ok(OPENCODE.includes(`OpenCode ${opencode} or later`))
  assert.ok(README.includes(`**OpenCode** ${opencode} or later`))
})

test('the pages say exactly which tools ask first, as the committed configs set them', () => {
  const tools = ((CODEX_CONFIG.mcp_servers as TomlTable)['zoom-meeting'] as TomlTable).tools as TomlTable
  const prompts = Object.keys(tools).filter(name => (tools[name] as TomlTable).approval_mode === 'prompt')
  assert.equal(prompts.length, 3)
  const listed = `\`${prompts.slice(0, -1).join('`, `')}\` and \`${prompts.at(-1)}\``
  assert.ok(CODEX.includes(`${listed} ask every time, also when the meeting-assistant calls them; the other eight never ask`), listed)
  const asks = (OPENCODE_CONFIG.permissions as OpenCodeRule[]).filter(rule => rule.effect === 'ask')
  const named = asks.map(rule => (rule.action === 'shell' ? `\`${rule.resource.replace(/ \*$/, ' ...')}\`` : `\`${rule.action.replace(/^zoom-meeting_/, '')}\``))
  assert.equal(named.length, 4)
  assert.ok(OPENCODE.includes(`${named.slice(0, -1).join(', ')} and ${named.at(-1)}; everything else runs without asking`), named.join(', '))
})

test("docs/codex.md shows the agent file's shell switch as it is, and says where the floor stops", () => {
  const agent = read('.codex/agents/meeting-assistant.toml').trimEnd().split('\n')
  const switchLines = agent.slice(-2)
  assert.deepEqual(switchLines, ['# [features]', '# shell_tool = false'])
  assert.ok(CODEX.includes(`\`\`\`toml\n${switchLines.map(line => line.replace(/^# /, '')).join('\n')}\n\`\`\``))
  // test/agent-floor.test.ts pins the gap itself.
  assert.match(CODEX, /\*\*It stops at this folder\.\*\*/)
  assert.match(CODEX, /A `\.env` or a key in a knowledge-source folder elsewhere is readable to Codex's commands, the meeting-assistant's included/)
})

test('the log lines the pages quote are the ones the voice service writes', () => {
  const bridge = read('src/bridge.ts')
  const pages = [CODEX, OPENCODE, read('docs/claude-code.md'), read('CHANGELOG.md')]
  const quoted = new Set(pages.flatMap(page => [...page.matchAll(/`(\[bridge\][^`]*)`/g)].map(m => m[1])))
  assert.ok(quoted.size >= 4, [...quoted].join('\n'))
  for (const line of quoted) {
    // "#N" and "(1 linked)" stand for what the service fills in.
    const pattern = line
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/#N/g, '#\\$\\{[^}]+\\}')
      .replace(/\\\(1 linked\\\)/g, '\\(\\$\\{[^}]+\\} linked\\)')
    assert.match(bridge, new RegExp(`\`${pattern}\``), line)
  }
})

test('the pages quote what Alex says and what the reports end with as the code has them', () => {
  assert.equal(SESSION_OFFLINE_LINE, "I can't reach Sam's notes right now, so I'll pass that question on to Sam.")
  assert.ok(CODEX.includes(`"${SESSION_OFFLINE_LINE}"`))
  assert.ok(OPENCODE.includes(`"${SESSION_OFFLINE_LINE}"`))
  assert.ok(read('docs/flux-probe.md').includes(`\`${FLUX_REPORT_END}\``))
  assert.ok(read('docs/share-test.md').includes(`\`${SHARE_REPORT_END}\``))
  assert.ok(read('src/slides/actions.ts').includes("'Next: write the sections (or ask your coding session (Claude Code, Codex or OpenCode) to draft them), then'"))
  assert.ok(read('docs/presenting.md').includes('Next: write the sections (or ask your coding session (Claude Code, Codex or OpenCode) to draft them), then'))
  // What the join says, as a clone words it (src/commands.ts): the page shows the clone's command.
  const note = slidesNote({ name: 'Q3', narrated: 2, totalMs: 60_000, script: { minutes: null } }, 'zoom', 'Alex')
  assert.ok(note.includes('(npm run slides -- control start, or slides_control in your coding session)'), note)
  assert.ok(read('docs/presenting.md').includes('(npm run slides -- control start, or slides_control in your coding session)'))
})

test("docs/opencode.md's example message is what the channel posts", () => {
  const block = /A question, as the model saw it in the check \(made-up text\):\n```\n([\s\S]*?)\n```/.exec(OPENCODE)?.[1]
  assert.ok(block)
  const first = /^(.*)\n<meeting_event>\n([\s\S]*)\n<\/meeting_event>$/.exec(block)
  assert.ok(first, block)
  const ids = /kind=question question_id=(\S+) meeting=(\S+)/.exec(first[1])
  assert.ok(ids)
  assert.equal(plainEvent({ kind: 'question', question_id: ids[1], meeting: ids[2], content: first[2] }), block)
  assert.ok(OPENCODE.includes(`each starting \`${EVENT_HEADER}\``))
})

test('the README and the other pages link to the Codex and OpenCode pages, and say how to stop OpenCode answering', () => {
  for (const page of ['docs/codex.md', 'docs/opencode.md']) assert.ok(README.includes(`](${page})`), page)
  for (const file of ['docs/claude-code.md', 'docs/setup.md', 'docs/security.md']) {
    const text = read(file)
    assert.ok(text.includes('](codex.md)') && text.includes('](opencode.md)'), file)
  }
  assert.match(OPENCODE, /## Answering while you are away[\s\S]*`opencode service stop` stops the background service with the processes it started, the channel among them/)
  assert.ok(README.includes('(docs/opencode.md#answering-while-you-are-away)'))
  assert.ok(README.includes('(docs/codex.md#the-meeting-assistant-has-a-shell)'))
})
