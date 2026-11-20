// Codex's committed config (.codex/config.toml), its meeting-assistant (.codex/agents/meeting-assistant.toml) and
// scripts/install-codex.sh. Codex is pull-only: the channel registered here, which of its tools ask first (checked the
// way Codex 0.171.0 decides it), the floor's profile as Codex's Linux sandbox can apply it, the agent's one switch, and
// the script, run with a stand-in codex. The floor's files are compared with the other clients' in agent-floor.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT } from '../src/config.ts'
import { CODEX_CONFIG, codexProfile } from './client-floors.ts'
import { parseToml, type TomlTable } from './toml.ts'

const SERVER = (CODEX_CONFIG.mcp_servers as TomlTable)['zoom-meeting'] as TomlTable
type Tool = { name: string; annotations?: { readOnlyHint?: boolean } | null; inputSchema: { properties: Record<string, { maximum?: number }> } }
/** The channel's tools, as it lists them (pinned in the Claude Code fixture; the names are the same for every client). */
const TOOLS: Tool[] = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/claude-code/tools.json'), 'utf8'))

test('the channel is zoom-meeting, started from the folder Codex starts in, as Codex, with room for the longest wait', () => {
  assert.deepEqual(Object.keys(CODEX_CONFIG.mcp_servers as TomlTable), ['zoom-meeting'])
  assert.deepEqual(Object.keys(SERVER).sort(), ['args', 'command', 'default_tools_approval_mode', 'env', 'tool_timeout_sec', 'tools'])
  // Paths from the session's folder, and no cwd: Codex takes a relative cwd from wherever its own process started.
  assert.equal(SERVER.command, 'node_modules/.bin/tsx')
  assert.deepEqual(SERVER.args, ['src/channel/server.ts'])
  assert.deepEqual(SERVER.env, { AGENTVOICE_CLIENT: 'codex' })
  // The same server scripts/install-channel.sh registers for Claude Code.
  const claude = fs.readFileSync(path.join(ROOT, 'scripts/install-channel.sh'), 'utf8')
  assert.match(claude, /-- "\$DIR\/node_modules\/\.bin\/tsx" "\$DIR\/src\/channel\/server\.ts"$/m)
  // Codex's own limit is 300 seconds: a call is cut at tool_timeout_sec, whatever the server says meanwhile.
  const longest = TOOLS.find(tool => tool.name === 'next_question')!.inputSchema.properties.wait_seconds.maximum!
  assert.equal(longest, 600)
  assert.ok((SERVER.tool_timeout_sec as number) >= longest + 60, String(SERVER.tool_timeout_sec))
})

/** The approval mode Codex uses for a tool: its own, else the server's default, else auto (mcp_tool_call.rs). */
const modeOf = (tool: string) => (((SERVER.tools as TomlTable)[tool] as TomlTable | undefined)?.approval_mode as string | undefined) ?? (SERVER.default_tools_approval_mode as string | undefined) ?? 'auto'
/** Whether Codex asks before a call (requires_mcp_tool_approval_for_mode). */
function asks(tool: Tool): boolean {
  const mode = modeOf(tool.name)
  const readOnly = tool.annotations?.readOnlyHint === true
  if (mode === 'approve') return false
  if (mode === 'prompt') return true
  if (mode === 'writes') return !readOnly
  // auto: asks unless read-only (none of the channel's tools says it is not destructive or not open-world).
  return !readOnly
}

test("each of the channel's tools has its own approval mode: the agent's six and two that only read run at once; joining, the brief and slides always ask", () => {
  assert.deepEqual(Object.keys(SERVER.tools as TomlTable).sort(), TOOLS.map(tool => tool.name).sort(), 'every tool, and only those')
  for (const [name, settings] of Object.entries(SERVER.tools as TomlTable)) assert.deepEqual(Object.keys(settings as TomlTable), ['approval_mode'], name)
  const asking = TOOLS.filter(asks).map(tool => tool.name).sort()
  assert.deepEqual(asking, ['join_meeting', 'set_brief', 'slides_control'])
  const running = TOOLS.filter(tool => !asks(tool)).map(tool => tool.name).sort()
  assert.deepEqual(running, ['add_to_brief', 'get_profile', 'get_transcript', 'next_question', 'post_chat', 'reply', 'slides_status', 'why_not_answered'])
  // Only auto offers to remember a choice, which Codex writes into the file that defines the server: this one.
  for (const tool of TOOLS) assert.notEqual(modeOf(tool.name), 'auto', tool.name)
  // A tool added later, and not listed yet, asks every time.
  assert.equal(SERVER.default_tools_approval_mode, 'prompt')
  assert.equal(modeOf('a_tool_added_later'), 'prompt')
})

test("the floor is the profile Codex uses here: its workspace access, no network, and deny patterns its Linux sandbox can apply", () => {
  assert.equal(CODEX_CONFIG.default_permissions, 'agentvoice')
  assert.deepEqual(Object.keys(CODEX_CONFIG.permissions as TomlTable), ['agentvoice'])
  assert.equal(CODEX_CONFIG.sandbox_mode, undefined, 'no sandbox_mode: it would replace the profile')
  const profile = codexProfile()
  // Writes in this folder and the temp folders, as Codex's own :workspace; its network setting (off) is kept.
  assert.equal(profile.extends, ':workspace')
  assert.deepEqual(Object.keys(profile).sort(), ['description', 'extends', 'filesystem'])
  const filesystem = profile.filesystem as TomlTable
  for (const [key, access] of Object.entries(filesystem)) {
    if (key === 'glob_scan_max_depth' || key === ':workspace_roots') continue
    assert.match(key, /^~\/[^*?[\]]+$/, key)
    assert.equal(access, 'deny', key)
  }
  // Patterns only, in this folder: Codex 0.171.0 can't start a command on Linux when a pattern matches a file inside
  // a folder denied by name (bubblewrap can't mount over a file in a folder it has already hidden).
  for (const [pattern, access] of Object.entries(filesystem[':workspace_roots'] as TomlTable)) {
    assert.match(pattern, /^\*\*\//, pattern)
    assert.equal(access, 'deny', pattern)
  }
  // On Linux, Codex looks for the files a pattern matches this many names deep: more than this checkout's deepest.
  const deepest = Math.max(...spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim().split('\n').map(file => file.split('/').length))
  assert.ok((filesystem.glob_scan_max_depth as number) >= deepest + 8, String(filesystem.glob_scan_max_depth))
})

test("Codex's meeting-assistant: no model of its own, the shell on, and the one switch that turns it off", () => {
  const text = fs.readFileSync(path.join(ROOT, '.codex/agents/meeting-assistant.toml'), 'utf8')
  const agent = parseToml(text)
  assert.deepEqual(Object.keys(agent).sort(), ['description', 'developer_instructions', 'name'], 'no model, and no features: the shell is on')
  assert.equal(agent.name, 'meeting-assistant')
  // The switch is in the file, commented out, at its end: uncommented, it is a valid table that turns the shell off.
  assert.match(text, /\n# \[features\]\n# shell_tool = false\n$/)
  const off = parseToml(text.replace(/# \[features\]\n# shell_tool = false\n$/, '[features]\nshell_tool = false\n'))
  assert.deepEqual(off.features, { shell_tool: false })
  assert.equal(off.developer_instructions, agent.developer_instructions)
  assert.match(text, /To turn its shell off, uncomment the last two lines of this file/)
  assert.match(text, /can't read your knowledge sources/)
})

test('.codex/ is committed, for everyone who uses this folder', () => {
  const ignored = (file: string) => spawnSync('git', ['check-ignore', '--no-index', '-q', file], { cwd: ROOT }).status === 0
  assert.ok(!ignored('.codex/config.toml'))
  assert.ok(!ignored('.codex/agents/meeting-assistant.toml'))
})

// --- scripts/install-codex.sh ------------------------------------------------------------------------------------
/** What a stand-in `codex mcp list --json` prints: this folder's server, another one, or none. */
const OURS = JSON.stringify([{ name: 'zoom-meeting', transport: { type: 'stdio', command: 'node_modules/.bin/tsx', args: ['src/channel/server.ts'], env: { AGENTVOICE_CLIENT: 'codex' } } }])
const THEIRS = JSON.stringify([{ name: 'zoom-meeting', transport: { type: 'stdio', command: '/opt/av/node_modules/.bin/tsx', args: ['/opt/av/src/channel/server.ts'], env: null } }])

/** A copy of what the script uses, a stand-in codex of the given version and answers, and a home folder. */
function installSandbox(t: { after: (fn: () => unknown) => void }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'av-cx-install-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const repo = path.join(dir, 'repo')
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'node_modules/.bin'), { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'scripts/install-codex.sh'), path.join(repo, 'scripts/install-codex.sh'))
  fs.writeFileSync(path.join(repo, 'node_modules/.bin/tsx'), '#!/bin/sh\n', { mode: 0o755 })
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  // Like the real one, it says on stderr where its home is; `mcp list` answers by the folder it is run in.
  fs.writeFileSync(
    path.join(bin, 'codex'),
    `#!/bin/sh
echo "WARNING: proceeding, even though we could not create PATH aliases" >&2
if [ "$1" = "--version" ]; then echo "codex-cli $FAKE_CODEX_VERSION"; exit 0; fi
if [ "$1 $2 $3" = "mcp list --json" ]; then
  if [ "$(pwd -P)" = "$FAKE_REPO" ]; then
    if [ -n "$FAKE_FAIL" ]; then printf 'Error: failed to load configuration\\n\\nCaused by:\\n    %s\\n\\nStack backtrace:\\n   0: <unknown>\\n' "$FAKE_FAIL" >&2; exit 1; fi
    printf '%s\\n' "$FAKE_HERE"
  else
    printf '%s\\n' "$FAKE_ELSEWHERE"
  fi
  exit 0
fi
echo "unexpected: codex $*" >&2
exit 3
`,
    { mode: 0o755 },
  )
  const home = path.join(dir, 'home')
  fs.mkdirSync(home)
  // The home folder the script is run with: by default one outside the temporary folders, as an owner's is (it need not
  // exist: the script reads nothing in it).
  type Options = { version?: string; here?: string; elsewhere?: string; fail?: string; withCodex?: boolean; codexHome?: string; home?: string; tmpdir?: string }
  const run = (args: string[] = [], o: Options = {}) =>
    spawnSync('bash', [path.join(repo, 'scripts/install-codex.sh'), ...args], {
      encoding: 'utf8',
      env: {
        PATH: [...(o.withCodex === false ? [] : [bin]), path.dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
        HOME: o.home ?? '/home/av-test-owner',
        TMPDIR: o.tmpdir ?? dir,
        FAKE_REPO: repo,
        FAKE_CODEX_VERSION: o.version ?? '0.171.0',
        FAKE_HERE: o.here ?? OURS,
        FAKE_ELSEWHERE: o.elsewhere ?? '[]',
        FAKE_FAIL: o.fail ?? '',
        ...(o.codexHome ? { CODEX_HOME: o.codexHome } : {}),
      },
    })
  /** Every file and folder under the sandbox, with its size and time: the script must change none of them. */
  const snapshot = () => {
    const out: string[] = []
    const walk = (at: string) => {
      for (const name of fs.readdirSync(at).sort()) {
        const full = path.join(at, name)
        const stat = fs.lstatSync(full)
        out.push(`${path.relative(dir, full)} ${stat.size} ${stat.mtimeMs}`)
        if (stat.isDirectory()) walk(full)
      }
    }
    walk(dir)
    return out
  }
  return { repo, home, run, snapshot }
}

test('install-codex.sh checks Codex and this folder, says how to start Codex here, and writes nothing', t => {
  const box = installSandbox(t)
  const before = box.snapshot()
  const r = box.run()
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stderr, '')
  assert.match(r.stdout, /^Codex 0\.171\.0 is ready to use here\. Start it at the root of this folder/)
  assert.ok(r.stdout.includes(`  cd "${box.repo}" && codex\n`), r.stdout)
  assert.match(r.stdout, /Codex trusts this folder and loads its config: the zoom-meeting channel, the meeting-assistant and the floor\./)
  assert.match(r.stdout, /Don't start Codex here with --sandbox \(-s\) or --dangerously-bypass-approvals-and-sandbox: either replaces the floor\./)
  assert.doesNotMatch(r.stdout, /Note:|codex mcp remove|trust_level/)
  assert.deepEqual(box.snapshot(), before, 'nothing written, in the folder or the home folder')
})

test("install-codex.sh, before you trust the folder: how to trust it, in the config Codex reads", t => {
  const box = installSandbox(t)
  const r = box.run([], { here: '[]' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /Codex doesn't load this folder's config yet: it reads \.codex\/ only in a folder you trust\./)
  assert.match(r.stdout, /choose "Trust and continue"/)
  assert.ok(r.stdout.includes(`  [projects."${box.repo}"]\n  trust_level = "trusted"\nin ~/.codex/config.toml. Then run this script again to check.`), r.stdout)
  const other = box.run([], { here: '[]', codexHome: '/srv/codex-home' })
  assert.match(other.stdout, /in \/srv\/codex-home\/config\.toml\. Then run this script again/)
  // A zoom-meeting from elsewhere (your own config) is not this folder's.
  assert.match(box.run([], { here: THEIRS }).stdout, /Codex doesn't load this folder's config yet/)
})

test('install-codex.sh says to remove a zoom-meeting your own config registers for every project, and does not remove it itself', t => {
  const box = installSandbox(t)
  const r = box.run([], { elsewhere: THEIRS })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^Your own Codex config \(~\/\.codex\/config\.toml\) registers a zoom-meeting server for every project/)
  assert.match(r.stdout, /\n  codex mcp remove zoom-meeting\n/)
  assert.match(r.stdout, /Codex trusts this folder and loads its config/)
})

test("install-codex.sh refuses no Codex, an older one, a config Codex can't load, a folder without npm install, and unknown options", t => {
  const box = installSandbox(t)
  const refused = (r: ReturnType<typeof box.run>, why: RegExp, status = 1) => {
    assert.equal(r.status, status, r.stdout + r.stderr)
    assert.match(r.stderr, why)
  }
  refused(box.run([], { withCodex: false }), /^Codex is not installed \(no codex command\)\. Install Codex 0\.171\.0 or later: npm install -g @openai\/codex\n$/)
  refused(box.run([], { version: '0.170.9' }), /Codex 0\.170\.9 is older than 0\.171\.0, the earliest AgentVoice supports/)
  refused(box.run([], { version: '0.99.0' }), /older than 0\.171\.0/)
  refused(box.run([], { version: '' }), /Could not tell which Codex this is/)
  const broken = box.run([], { fail: 'filesystem glob path `**/.env` only supports `deny` access' })
  refused(broken, /Codex can't load its config \(run from .*\):\nError: failed to load configuration\n\nCaused by:\n {4}filesystem glob path `\*\*\/\.env` only supports `deny` access/)
  assert.doesNotMatch(broken.stderr, /Stack backtrace|WARNING/)
  refused(box.run(['--bogus']), /Unknown option: --bogus/, 2)
  for (const version of ['0.172.1', '0.171.1', '1.0.0']) {
    const newer = box.run([], { version })
    assert.equal(newer.status, 0, newer.stderr)
    assert.match(newer.stdout, new RegExp(`^Note: Codex ${version.replaceAll('.', '\\.')} is newer than AgentVoice was tested with \\(0\\.171\\.0\\)\\. If something fails, tell us\\.`))
  }
  fs.rmSync(path.join(box.repo, 'node_modules'), { recursive: true })
  refused(box.run(), /Run npm install in .* first: the channel runs with its tsx\./)
})

test('install-codex.sh refuses a home folder inside a temporary folder, where Codex would leave placeholders in it', t => {
  // On Linux, Codex's sandbox makes an empty read-only placeholder for a denied path that doesn't exist, when the path
  // is in a folder its commands may write (this folder and the temporary folders), and can leave it behind: with a home
  // folder in /tmp, ~/.ssh, ~/.aws and the rest became empty files, and Codex could no longer start here.
  const box = installSandbox(t)
  const before = box.snapshot()
  for (const [home, tmpdir] of [[box.home, undefined], ['/tmp/av-owner', '/var/tmp/av-elsewhere'], ['/tmp', undefined]] as const) {
    const r = box.run([], { home, tmpdir })
    assert.equal(r.status, 1, `${home}: ${r.stdout}`)
    assert.match(r.stderr, /^Your home folder \(.+\) is inside .+, a folder where Codex's sandbox lets commands write\. /, home)
    assert.match(r.stderr, /empty, read-only placeholders .*~\/\.ssh.*can stop Codex starting here/s)
    assert.match(r.stderr, /Use a home folder\noutside \/tmp and \$TMPDIR\./)
    assert.equal(r.stdout, '')
  }
  assert.deepEqual(box.snapshot(), before, 'nothing written')
  // A home folder beside them, with a name that only starts the same, is fine.
  assert.equal(box.run([], { home: '/tmpfiles/owner' }).status, 0)
  assert.equal(box.run([], { home: '/home/owner' }).status, 0)
})
