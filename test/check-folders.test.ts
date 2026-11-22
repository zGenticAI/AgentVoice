// What agentvoice check says first when AgentVoice is installed from npm (src/cli/check-folders.ts): where the
// AgentVoice folder, the settings, the data and the package are, and warnings for what to fix there. A clone's check
// adds nothing, except one note when AGENTVOICE_HOME is set. The installed service's unit is read as launchd and
// systemd read it (src/service/units.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from '../src/config.ts'
import { type FolderReport, cloneHomeNote, folderReport } from '../src/cli/check-folders.ts'
import { PACKAGE_NAME } from '../src/home.ts'
import { MANIFEST } from '../src/setup/files.ts'
import { readBackProgram, readBackWorkingDirectory, serviceKind, unitFile } from '../src/service/units.ts'
import { cloneCopy, command, envFor, installedPackage, tempDir } from './layouts.ts'

type Ctx = { after: (fn: () => unknown) => void }

/** A home folder with an AgentVoice folder made as init makes it (but its own profile and brief), and a node that exists. */
function owner(t: Ctx) {
  const homeDir = tempDir(t, 'av-check-')
  const home = path.join(homeDir, '.agentvoice')
  fs.mkdirSync(path.join(home, 'data'), { recursive: true, mode: 0o700 })
  fs.chmodSync(home, 0o700)
  fs.writeFileSync(path.join(home, '.env'), 'OWNER_NAME=Sam\n', { mode: 0o600 })
  fs.writeFileSync(path.join(home, 'profile.md'), '## About\n\nSam runs a small studio.\n')
  fs.writeFileSync(path.join(home, 'data/brief.md'), 'The Q3 plan.\n')
  const node = path.join(homeDir, 'node/bin/node')
  fs.mkdirSync(path.dirname(node), { recursive: true })
  fs.writeFileSync(node, '', { mode: 0o755 })
  const bin = path.join(homeDir, 'prefix/lib/node_modules', PACKAGE_NAME, 'bin/agentvoice.js')
  const cwd = path.join(homeDir, 'session')
  fs.mkdirSync(cwd)
  const input: FolderReport = {
    home,
    fromSetting: false,
    dataDir: path.join(home, 'data'),
    packageDir: ROOT,
    version: '0.3.0',
    profileFile: path.join(home, 'profile.md'),
    cwd,
    node,
    bin,
    label: 'local.agent-voice',
    kind: 'systemd',
    env: {},
    homeDir,
  }
  const report = (more: Partial<FolderReport> = {}) => folderReport({ ...input, ...more })
  const warnings = (more: Partial<FolderReport> = {}) => report(more).filter(line => line.startsWith('  Warning: '))
  return { homeDir, home, node, bin, cwd, input, report, warnings }
}

test('installed, check first says where the AgentVoice folder, the settings, the data and the package are', t => {
  const o = owner(t)
  assert.deepEqual(o.report(), ['Folders', '  AgentVoice folder: ~/.agentvoice', '  Settings: ~/.agentvoice/.env', '  Data: ~/.agentvoice/data', `  Package: ${ROOT} (0.3.0)`])
  assert.equal(o.report({ fromSetting: true })[1], '  AgentVoice folder: ~/.agentvoice (AGENTVOICE_HOME)')
  assert.equal(o.report({ dataDir: '/srv/av-data' })[3], '  Data: /srv/av-data')
  fs.rmSync(path.join(o.home, '.env'))
  assert.equal(o.report()[2], '  Settings: ~/.agentvoice/.env (not there yet: agentvoice init makes it)')
})

test('installed, check warns when others can open the AgentVoice folder or read .env, and says the chmod', t => {
  const o = owner(t)
  fs.chmodSync(o.home, 0o755)
  fs.chmodSync(path.join(o.home, '.env'), 0o644)
  assert.deepEqual(o.warnings(), [
    '  Warning: ~/.agentvoice can be opened by other users (mode 755): chmod 700 ~/.agentvoice',
    '  Warning: ~/.agentvoice/.env can be read by other users (mode 644): chmod 600 ~/.agentvoice/.env',
  ])
  fs.chmodSync(o.home, 0o710)
  fs.chmodSync(path.join(o.home, '.env'), 0o640)
  assert.equal(o.warnings().length, 2, 'group access is looser too')
  // A path the shell would split is given in full, in quotes ("~" isn't expanded inside them).
  const spaced = path.join(o.homeDir, 'av home')
  fs.mkdirSync(spaced, { mode: 0o777 })
  fs.chmodSync(spaced, 0o777)
  assert.deepEqual(o.warnings({ home: spaced }), [`  Warning: ~/av home can be opened by other users (mode 777): chmod 700 "${spaced}"`])
  fs.chmodSync(o.home, 0o700)
  fs.chmodSync(path.join(o.home, '.env'), 0o600)
  assert.deepEqual(o.warnings(), [])
})

test('installed, check warns while the profile or the shared brief is still the example', t => {
  const o = owner(t)
  fs.copyFileSync(path.join(ROOT, 'profile.example.md'), path.join(o.home, 'profile.md'))
  fs.copyFileSync(path.join(ROOT, 'brief.example.md'), path.join(o.home, 'data/brief.md'))
  assert.deepEqual(o.warnings(), [
    '  Warning: ~/.agentvoice/profile.md is still the example (profile.example.md): make it yours.',
    '  Warning: the shared brief, ~/.agentvoice/data/brief.md, is still the example (brief.example.md): fill it in for your meetings.',
  ])
  // The profile in use: PROFILE_FILE's, when it names another.
  const mine = path.join(o.homeDir, 'notes.md')
  fs.writeFileSync(mine, '## About\n')
  assert.equal(o.warnings({ profileFile: mine }).length, 1)
  fs.appendFileSync(path.join(o.home, 'data/brief.md'), '\nMine now.\n')
  assert.deepEqual(o.warnings({ profileFile: mine }), [])
})

test('installed, check run in a session folder says when its setup is for another version, node, bin or AgentVoice folder', t => {
  const o = owner(t)
  const write = (m: object) => fs.writeFileSync(path.join(o.cwd, MANIFEST), JSON.stringify(m))
  const manifest = { package: PACKAGE_NAME, version: '0.3.0', home: o.home, command: [o.node, o.bin, 'channel'], clients: { 'claude-code': { files: {} }, codex: { files: {} } } }
  write(manifest)
  assert.deepEqual(o.warnings(), [], 'up to date')
  write({ ...manifest, version: '0.2.0' })
  assert.deepEqual(o.warnings(), [
    "  Warning: this folder's coding-client setup is out of date: it was set up by AgentVoice 0.2.0, and this is 0.3.0. Run agentvoice setup claude-code again here.",
    "  Warning: this folder's coding-client setup is out of date: it was set up by AgentVoice 0.2.0, and this is 0.3.0. Run agentvoice setup codex again here.",
  ])
  const gone = path.join(o.homeDir, 'Cellar/node/24.1.0/bin/node')
  write({ ...manifest, command: [gone, o.bin, 'channel'], clients: { opencode: { files: {} } } })
  assert.deepEqual(o.warnings(), [`  Warning: this folder's coding-client setup is out of date: its configs start the channel with ${gone}, not ${o.node}. Run agentvoice setup opencode again here.`])
  write({ ...manifest, clients: { codex: { files: {} } } })
  fs.rmSync(o.node)
  assert.match(o.warnings()[0], /the node its configs start the channel with, .*node, is no longer there\. Run agentvoice setup codex again here\.$/)
  fs.writeFileSync(o.node, '')
  write({ ...manifest, home: '/srv/other', command: [o.node, '/old/bin/agentvoice.js', 'channel'], clients: { codex: { files: {} } } })
  assert.match(o.warnings()[0], /its configs start \/old\/bin\/agentvoice\.js, not this AgentVoice's .*; it is for the AgentVoice folder \/srv\/other, and this one is ~\/\.agentvoice\. Run/)
  // Not a record setup wrote: not a session folder.
  fs.writeFileSync(path.join(o.cwd, MANIFEST), '{"package": "other"}')
  assert.deepEqual(o.warnings(), [])
})

test("installed, check says when the installed voice service starts another AgentVoice, or a node that is gone", t => {
  const o = owner(t)
  const unit = unitFile('systemd', 'local.agent-voice', {}, o.homeDir)
  assert.equal(unit, path.join(o.homeDir, '.config/systemd/user/local.agent-voice.service'))
  fs.mkdirSync(path.dirname(unit), { recursive: true })
  const systemd = (dir: string, node: string, bin: string) => fs.writeFileSync(unit, `[Service]\nWorkingDirectory=${dir.replaceAll('%', '%%')}\nExecStart="${node.replaceAll('%', '%%')}" "${bin}" start\n`)
  systemd(o.home, o.node, o.bin)
  assert.deepEqual(o.warnings(), [], 'up to date')
  systemd(o.home, '/usr/bin/node', o.bin)
  assert.deepEqual(o.warnings(), [`  Warning: ~/.config/systemd/user/local.agent-voice.service is out of date: it starts the voice service with /usr/bin/node, not ${o.node}. Run agentvoice service install again.`])
  const old = `/old/lib/node_modules/${PACKAGE_NAME}/bin/agentvoice.js`
  systemd(o.home, o.node, old)
  assert.deepEqual(o.warnings(), [`  Warning: ~/.config/systemd/user/local.agent-voice.service is out of date: it starts ${old}, not this AgentVoice's ${o.bin}. Run agentvoice service install again.`])
  fs.rmSync(o.node)
  systemd(o.home, o.node, o.bin)
  assert.match(o.warnings()[0], /is out of date: the node it starts the voice service with, .*, is no longer there\. Run agentvoice service install again\.$/)
  fs.writeFileSync(o.node, '')
  // A clone's unit (scripts/agent-voice.service, filled in): another folder, which only --replace replaces.
  const clone = '/home/sam/AgentVoice'
  fs.writeFileSync(unit, fs.readFileSync(path.join(ROOT, 'scripts/agent-voice.service'), 'utf8').replaceAll('__LABEL__', 'local.agent-voice').replaceAll('__DIR__', clone).replaceAll('__NODE__', '/usr/bin/node'))
  assert.deepEqual(o.warnings(), ['  Warning: ~/.config/systemd/user/local.agent-voice.service runs the voice service from /home/sam/AgentVoice, not your AgentVoice folder: agentvoice service install --replace replaces it with this one.'])
  // Another label, another file; XDG_CONFIG_HOME moves it; no service manager here, nothing to read.
  assert.deepEqual(o.warnings({ label: 'other' }), [])
  assert.equal(unitFile('systemd', 'x', { XDG_CONFIG_HOME: '/srv/config' }, o.homeDir), '/srv/config/systemd/user/x.service')
  assert.deepEqual(o.warnings({ kind: null }), [])

  // launchd: ~/Library/LaunchAgents/<label>.plist.
  const plist = unitFile('launchd', 'local.agent-voice', {}, o.homeDir)
  assert.equal(plist, path.join(o.homeDir, 'Library/LaunchAgents/local.agent-voice.plist'))
  fs.mkdirSync(path.dirname(plist), { recursive: true })
  const xml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  const launchd = (node: string) =>
    fs.writeFileSync(plist, `<plist version="1.0">\n<dict>\n  <key>WorkingDirectory</key><string>${xml(o.home)}</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>${xml(node)}</string>\n    <string>${xml(o.bin)}</string>\n    <string>start</string>\n  </array>\n</dict>\n</plist>\n`)
  launchd(o.node)
  assert.deepEqual(o.warnings({ kind: 'launchd' }), [])
  launchd('/opt/homebrew/Cellar/node/24.1.0/bin/node')
  assert.match(o.warnings({ kind: 'launchd' })[0], /^ {2}Warning: ~\/Library\/LaunchAgents\/local\.agent-voice\.plist is out of date: it starts the voice service with \/opt\/homebrew\/Cellar\/node\/24\.1\.0\/bin\/node, not /)
})

test('a unit is read back as launchd and systemd read it: its folder, and its program with each argument', () => {
  const clone = fs.readFileSync(path.join(ROOT, 'scripts/agent-voice.service'), 'utf8').replaceAll('__LABEL__', 'l').replaceAll('__DIR__', '/srv/a%%b').replaceAll('__NODE__', '/usr/bin/node')
  assert.equal(readBackWorkingDirectory('systemd', clone), '/srv/a%b')
  assert.deepEqual(readBackProgram('systemd', clone), ['/usr/bin/node', '/srv/a%b/node_modules/tsx/dist/cli.mjs', 'src/server.ts'])
  const plist = fs.readFileSync(path.join(ROOT, 'scripts/agent-voice.plist'), 'utf8').replaceAll('__LABEL__', 'l').replaceAll('__DIR__', '/srv/a &amp; b').replaceAll('__NODE__', '/usr/bin/node')
  assert.equal(readBackWorkingDirectory('launchd', plist), '/srv/a & b')
  assert.deepEqual(readBackProgram('launchd', plist), ['/usr/bin/node', '/srv/a & b/node_modules/tsx/dist/cli.mjs', 'src/server.ts'])
  assert.equal(readBackWorkingDirectory('systemd', '[Service]\n'), null)
  assert.equal(readBackProgram('launchd', '<plist/>'), null)
  assert.deepEqual([serviceKind('darwin'), serviceKind('linux'), serviceKind('win32')], ['launchd', 'systemd', null])
})

const keysEmpty = { ANTHROPIC_API_KEY: '', DEEPGRAM_API_KEY: '', ELEVENLABS_API_KEY: '', ELEVENLABS_VOICE_ID: '', RECALL_API_KEY: '' }

test('installed, agentvoice check prints the Folders block before its checks, with its warnings', { timeout: 60_000 }, t => {
  const at = installedPackage(t)
  const env = envFor({ HOME: at.home, TMPDIR: at.tmp, XDG_CONFIG_HOME: path.join(at.home, '.config'), ...keysEmpty })
  const owner = path.join(at.home, '.agentvoice')
  assert.equal(command(at.pkg, 'src/cli/init.ts', [], env, at.elsewhere).status, 0)
  const run = command(at.pkg, 'src/cli/check.ts', [], env, at.elsewhere)
  assert.equal(run.status, 1, run.stderr)
  const lines = run.stdout.split('\n')
  assert.deepEqual(lines.slice(0, 8), [
    'Folders',
    '  AgentVoice folder: ~/.agentvoice',
    '  Settings: ~/.agentvoice/.env',
    '  Data: ~/.agentvoice/data',
    `  Package: ${at.pkg} (${JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version})`,
    '  Warning: ~/.agentvoice/profile.md is still the example (profile.example.md): make it yours.',
    '  Warning: the shared brief, ~/.agentvoice/data/brief.md, is still the example (brief.example.md): fill it in for your meetings.',
    '',
  ])
  assert.match(lines[8], /^✓ Name: /)
  // AGENTVOICE_HOME named it.
  const custom = path.join(at.tmp, 'av home')
  fs.cpSync(owner, custom, { recursive: true })
  const named = command(at.pkg, 'src/cli/check.ts', [], { ...env, AGENTVOICE_HOME: custom }, at.elsewhere)
  assert.equal(named.stdout.split('\n')[1], `  AgentVoice folder: ${custom} (AGENTVOICE_HOME)`)
})

test("a clone's check is as it was, but for one note when AGENTVOICE_HOME is set, which it ignores", { timeout: 60_000 }, t => {
  const { clone, tmp } = cloneCopy(t)
  const env = envFor({ HOME: tmp, ...keysEmpty })
  const plain = command(clone, 'src/cli/check.ts', [], env, tmp)
  assert.match(plain.stdout, /^✓ Name: /, 'no Folders block, no note')
  const set = command(clone, 'src/cli/check.ts', [], { ...env, AGENTVOICE_HOME: path.join(tmp, 'av') }, tmp)
  const note = '  Note: AGENTVOICE_HOME is set, but this is a cloned folder: its own .env and data/ are used, and AGENTVOICE_HOME is ignored.'
  assert.equal(set.stdout, `${note}\n${plain.stdout}`)
  assert.equal(cloneHomeNote(' /x '), note)
  assert.equal(cloneHomeNote(''), null)
  assert.equal(cloneHomeNote(undefined), null)
})
