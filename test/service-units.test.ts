// agentvoice service install | print | uninstall, for an installed AgentVoice (src/cli/service.ts), and the files it
// writes (src/service/units.ts): the exact systemd unit and launchd plist, paths escaped for each and read back as the
// service manager will read them, the paths and labels refused, and what install and uninstall do on each kind of
// computer, run against a scratch home folder with stand-ins for launchctl and systemctl. The clone's
// scripts/install-service.sh and its templates are pinned by test/service-install.test.ts, and stay as they were.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT } from '../src/config.ts'
import { DOCS_URL, UPGRADE, cloneRefusal, commandWords } from '../src/commands.ts'
import { PACKAGE_NAME, PACKAGE_VERSION } from '../src/home.ts'
import { type ServiceContext, ServiceError, UsageError, checkedUnit, parseServiceArgs, service } from '../src/cli/service.ts'
import { onPath } from '../src/setup/folder.ts'
import { agentvoiceCommand } from '../src/setup/node-path.ts'
import {
  forPlist, forSystemd, launchdPlist, readBackHome, readBackProgram, readBackWorkingDirectory, systemdUnit, unitFile,
} from '../src/service/units.ts'
import { agentvoice, envFor, installedPackage, tempDir } from './layouts.ts'

type Ctx = { after: (fn: () => unknown) => void }

const PKG = `/usr/local/lib/node_modules/${PACKAGE_NAME}`
/** The docs page the messages name: the version's, on GitHub. */
const SETUP_DOC = `${DOCS_URL}/v0.3.0/docs/setup.md`
const FIXED = { label: 'local.agent-voice', home: '/home/sam/.agentvoice', node: '/opt/homebrew/opt/node/bin/node', bin: `${PKG}/bin/agentvoice.js`, version: '0.3.0' }

test('the systemd unit, exactly: the AgentVoice folder, AGENTVOICE_HOME, node and the bin by absolute paths, and its log', () => {
  assert.equal(
    systemdUnit(FIXED),
    `# Keeps the AgentVoice voice service running, as a systemd user service. Written by agentvoice service install
# (${PACKAGE_NAME} 0.3.0): run it again after upgrading AgentVoice or Node.
[Unit]
Description=local.agent-voice: the meeting assistant's voice service
# No After=/Wants=network-online.target: that is a system unit, which a user's service manager doesn't have.

[Service]
Type=simple
WorkingDirectory=/home/sam/.agentvoice
Environment="AGENTVOICE_HOME=/home/sam/.agentvoice"
ExecStart="/opt/homebrew/opt/node/bin/node" "${PKG}/bin/agentvoice.js" start
# Started again whenever it stops, as launchd's KeepAlive does on macOS.
Restart=always
RestartSec=5
# The service stops in order on SIGTERM, within 20 s. SIGTERM goes to the main process only: the service itself.
KillSignal=SIGTERM
KillMode=mixed
TimeoutStopSec=20
StandardOutput=append:/home/sam/.agentvoice/data/agent-voice.log
StandardError=append:/home/sam/.agentvoice/data/agent-voice.log

[Install]
WantedBy=default.target
`,
  )
})

test('the launchd plist, exactly: the same, with AGENTVOICE_HOME in its EnvironmentVariables', () => {
  assert.equal(
    launchdPlist(FIXED),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Keeps the AgentVoice voice service running on macOS. Written by agentvoice service install
     (${PACKAGE_NAME} 0.3.0): run it again after upgrading AgentVoice or Node. -->
<plist version="1.0">
<dict>
  <key>Label</key><string>local.agent-voice</string>
  <key>WorkingDirectory</key><string>/home/sam/.agentvoice</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENTVOICE_HOME</key><string>/home/sam/.agentvoice</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/opt/node/bin/node</string>
    <string>${PKG}/bin/agentvoice.js</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/home/sam/.agentvoice/data/agent-voice.log</string>
  <key>StandardErrorPath</key><string>/home/sam/.agentvoice/data/agent-voice.log</string>
</dict>
</plist>
`,
  )
  // The version goes into a comment, which can't hold "--".
  assert.doesNotMatch(launchdPlist({ ...FIXED, version: '0.4.0-rc--1' }).split('\n')[3], /--(?!>)/)
})

test('a path with %, &, < or > is escaped for each file and read back as that path; a plist stays valid', () => {
  assert.equal(forSystemd('/srv/100% done'), '/srv/100%% done')
  assert.equal(forPlist('/srv/R&D <lab>'), '/srv/R&amp;D &lt;lab&gt;')
  const odd = { ...FIXED, home: '/srv/R&D <lab> 100% done/av', node: '/srv/n%de & co/node', bin: '/srv/<pkg>/bin/agentvoice.js' }
  for (const [kind, text] of [['systemd', systemdUnit(odd)], ['launchd', launchdPlist(odd)]] as const) {
    assert.equal(readBackWorkingDirectory(kind, text), odd.home, kind)
    assert.equal(readBackHome(kind, text), odd.home, kind)
    assert.deepEqual(readBackProgram(kind, text), [odd.node, odd.bin, 'start'], kind)
  }
  assert.ok(systemdUnit(odd).includes('StandardOutput=append:/srv/R&D <lab> 100%% done/av/data/agent-voice.log\n'))
  assert.doesNotMatch(launchdPlist(odd).replace(/&(?:amp|lt|gt);/g, ''), /&/, 'every "&" is an entity')
  const xmllint = onPath('xmllint')
  for (const input of [FIXED, odd]) {
    const lint = xmllint ? spawnSync(xmllint, ['--noout', '-'], { input: launchdPlist(input), encoding: 'utf8' }) : null
    if (lint) assert.equal(lint.status, 0, lint.stderr)
    const plutil = process.platform === 'darwin' ? onPath('plutil') : null
    if (plutil) {
      const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'av-plist-'))
      fs.writeFileSync(path.join(dir, 'x.plist'), launchdPlist(input))
      const run = spawnSync(plutil, ['-lint', '-s', path.join(dir, 'x.plist')], { encoding: 'utf8' })
      fs.rmSync(dir, { recursive: true, force: true })
      assert.equal(run.status, 0, run.stdout + run.stderr)
    }
  }
  // Read back from a file that names nothing: nothing.
  for (const kind of ['systemd', 'launchd'] as const) {
    assert.equal(readBackWorkingDirectory(kind, ''), null)
    assert.equal(readBackHome(kind, ''), null)
    assert.equal(readBackProgram(kind, ''), null)
  }
})

/** A scratch home folder with an AgentVoice folder that init made, and stand-ins for launchctl and systemctl. */
function computer(t: Ctx, platform: NodeJS.Platform = 'linux', more: Partial<ServiceContext> = {}) {
  const homeDir = tempDir(t, 'av-service-')
  const home = path.join(homeDir, '.agentvoice')
  fs.mkdirSync(home, { mode: 0o755 })
  fs.writeFileSync(path.join(home, '.env'), 'OWNER_NAME=Sam\n', { mode: 0o600 })
  const calls: string[] = []
  const out: string[] = []
  const err: string[] = []
  const fail = new Set<string>()
  const pkg = path.join(homeDir, 'prefix/lib/node_modules', PACKAGE_NAME)
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true })
  const ctx: ServiceContext = {
    mode: 'installed',
    home,
    packageDir: pkg,
    version: '0.3.0',
    words: commandWords('installed', home, '0.3.0', homeDir),
    label: 'local.agent-voice',
    node: '/usr/bin/node',
    bin: path.join(pkg, 'bin/agentvoice.js'),
    platform,
    env: {},
    homeDir,
    run: (command, args) => {
      const line = [command, ...args].join(' ')
      calls.push(line)
      return [...fail].some(f => line.startsWith(f)) ? 1 : 0
    },
    has: command => command === 'systemctl' || command === 'launchctl' || onPath(command) !== null,
    out: text => void out.push(text),
    err: text => void err.push(text),
    ...more,
  }
  const target = unitFile(platform === 'darwin' ? 'launchd' : 'systemd', ctx.label, {}, homeDir)
  return { homeDir, home, pkg, ctx, calls, out, err, fail, target }
}

/** What service throws, as the command would say it. */
function refusal(fn: () => void): string {
  try {
    fn()
  } catch (e) {
    if (e instanceof ServiceError || e instanceof UsageError) return e.message
    throw e
  }
  return assert.fail('not refused')
}

test('the command line: install [--replace], print [launchd|systemd], uninstall; anything else is a usage error', () => {
  assert.deepEqual(parseServiceArgs(['install']), { action: 'install', replace: false })
  assert.deepEqual(parseServiceArgs(['install', '--replace']), { action: 'install', replace: true })
  assert.deepEqual(parseServiceArgs(['print']), { action: 'print' })
  assert.deepEqual(parseServiceArgs(['print', 'launchd']), { action: 'print', kind: 'launchd' })
  assert.deepEqual(parseServiceArgs(['uninstall']), { action: 'uninstall' })
  for (const [argv, why] of [
    [[], 'Which one? agentvoice service install, print or uninstall.'],
    [['start'], 'Unknown service command "start": agentvoice service install, print or uninstall.'],
    [['install', '--force'], "agentvoice service install doesn't take --force."],
    [['print', 'upstart'], "agentvoice service print doesn't take upstart."],
    [['uninstall', '--replace'], "agentvoice service uninstall doesn't take --replace."],
  ] as const) {
    assert.throws(() => parseServiceArgs(argv), (e: Error) => e instanceof UsageError && e.message === why, why)
  }
})

test('install on Linux writes the systemd unit, makes the folders 0700 and starts it; it says how to check, stop and upgrade', t => {
  const c = computer(t)
  service({ action: 'install', replace: false }, c.ctx)
  assert.equal(c.target, path.join(c.homeDir, '.config/systemd/user/local.agent-voice.service'))
  assert.equal(fs.readFileSync(c.target, 'utf8'), systemdUnit({ ...c.ctx }))
  assert.deepEqual(c.calls, [
    'systemctl --user daemon-reload',
    'systemctl --user enable local.agent-voice.service',
    'systemctl --user restart local.agent-voice.service',
    'systemctl --user is-active --quiet local.agent-voice.service',
  ])
  assert.equal(fs.statSync(c.home).mode & 0o777, 0o700)
  assert.equal(fs.statSync(path.join(c.home, 'data')).mode & 0o777, 0o700)
  assert.deepEqual(c.err, [])
  assert.deepEqual(c.out, [
    [
      "The meeting assistant's voice service is installed and loaded as the systemd user service local.agent-voice. Logs: ~/.agentvoice/data/agent-voice.log",
      'To confirm it started (a missing setting stops it at once): tail -n 20 ~/.agentvoice/data/agent-voice.log, and the details on its control socket (the line the log shows when it starts: curl --unix-socket ...)',
      'To stop it: systemctl --user stop local.agent-voice',
      `To keep it running while you are logged out: loginctl enable-linger ${os.userInfo().username}`,
      `After upgrading AgentVoice (${UPGRADE}), run agentvoice service install again: it restarts the service on the new version.`,
      'After switching Node (nvm keeps a prefix per version), reinstall AgentVoice there and run it again.',
    ].join('\n'),
  ])
  // XDG_CONFIG_HOME moves it; USER names the linger command.
  const x = computer(t, 'linux', { env: { XDG_CONFIG_HOME: '/nonexistent-av-config', USER: 'sam' } })
  assert.equal(unitFile('systemd', 'local.agent-voice', x.ctx.env, x.homeDir), '/nonexistent-av-config/systemd/user/local.agent-voice.service')
  // Again, for its own folder: it replaces its own unit without --replace, and restarts the service.
  c.calls.length = 0
  service({ action: 'install', replace: false }, { ...c.ctx, version: '0.3.1' })
  assert.match(fs.readFileSync(c.target, 'utf8'), /\(.* 0\.3\.1\): run it again/)
  assert.ok(c.calls.includes('systemctl --user restart local.agent-voice.service'))
  // A service that doesn't start is said, with where to look.
  c.fail.add('systemctl --user is-active')
  assert.equal(refusal(() => service({ action: 'install', replace: false }, c.ctx)), 'The service local.agent-voice did not start. See ~/.agentvoice/data/agent-voice.log, and: systemctl --user status local.agent-voice')
  c.fail.add('systemctl --user enable')
  assert.equal(refusal(() => service({ action: 'install', replace: false }, c.ctx)), 'systemctl --user enable local.agent-voice.service failed (exit 1).')
})

test('install on macOS writes the launchd plist and loads it', t => {
  const c = computer(t, 'darwin')
  service({ action: 'install', replace: false }, c.ctx)
  assert.equal(c.target, path.join(c.homeDir, 'Library/LaunchAgents/local.agent-voice.plist'))
  assert.equal(fs.readFileSync(c.target, 'utf8'), launchdPlist(c.ctx))
  assert.deepEqual(c.calls, [`launchctl unload ${c.target}`, `launchctl load ${c.target}`, 'launchctl list local.agent-voice'])
  assert.match(c.out[0], /^The meeting assistant's voice service is installed and loaded as the launchd agent local\.agent-voice\. Logs: ~\/\.agentvoice\/data\/agent-voice\.log\n/)
  assert.match(c.out[0], /\nTo stop it: launchctl unload ~\/Library\/LaunchAgents\/local\.agent-voice\.plist\n/)
  c.fail.add('launchctl list')
  assert.equal(refusal(() => service({ action: 'install', replace: false }, c.ctx)), 'launchd did not take ~/Library/LaunchAgents/local.agent-voice.plist: the service is not running. See ~/.agentvoice/data/agent-voice.log.')
})

test("install never replaces a unit that runs the voice service from another folder, a clone's say, unless --replace", t => {
  const c = computer(t)
  fs.mkdirSync(path.dirname(c.target), { recursive: true })
  const clone = path.join(c.homeDir, 'AgentVoice')
  const theirs = fs.readFileSync(path.join(ROOT, 'scripts/agent-voice.service'), 'utf8')
    .replaceAll('__LABEL__', 'local.agent-voice').replaceAll('__DIR__', clone).replaceAll('__NODE__', '/usr/bin/node')
  fs.writeFileSync(c.target, theirs)
  assert.equal(
    refusal(() => service({ action: 'install', replace: false }, c.ctx)),
    `~/.config/systemd/user/local.agent-voice.service runs the voice service from ~/AgentVoice. Stop and remove that one first (${SETUP_DOC}, "Keeping it running"), or run agentvoice service install --replace to replace it.`,
  )
  assert.equal(fs.readFileSync(c.target, 'utf8'), theirs, 'left as it was')
  assert.equal(c.calls.length, 0, 'the service manager was not asked anything')
  // A file that names no folder is not replaced either.
  fs.writeFileSync(c.target, '[Service]\nExecStart=/bin/true\n')
  assert.match(refusal(() => service({ action: 'install', replace: false }, c.ctx)), /runs the voice service from a folder it doesn't name\. Stop and remove/)
  // With --replace, it is.
  fs.writeFileSync(c.target, theirs)
  service({ action: 'install', replace: true }, c.ctx)
  assert.equal(fs.readFileSync(c.target, 'utf8'), systemdUnit(c.ctx))
  assert.ok(c.calls.includes('systemctl --user restart local.agent-voice.service'))
})

test('install warns about a unit of another label that also runs this AgentVoice folder or this package', t => {
  const c = computer(t)
  const dir = path.dirname(c.target)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'other.service'), systemdUnit({ ...c.ctx, label: 'other' }))
  fs.writeFileSync(path.join(dir, 'bin.service'), systemdUnit({ ...c.ctx, label: 'bin', home: '/srv/elsewhere' }))
  fs.writeFileSync(path.join(dir, 'unrelated.service'), systemdUnit({ ...c.ctx, label: 'x', home: `${c.home}2`, bin: '/srv/other/bin/agentvoice.js' }))
  service({ action: 'install', replace: false }, c.ctx)
  assert.deepEqual(c.err, ['bin.service', 'other.service'].map(name =>
    `Warning: ~/.config/systemd/user/${name} also runs this voice service (from ~/.agentvoice, or with ~/prefix/lib/node_modules/${PACKAGE_NAME}/bin/agentvoice.js). Stop and remove it (see "Keeping it running" in ${SETUP_DOC}), or the two fight over the port.`,
  ))
})

test('install refuses, writing nothing: before init, from npx, without a service manager, and for a label or path a unit can\'t hold', t => {
  const c = computer(t)
  const install = (more: Partial<ServiceContext> = {}) => refusal(() => service({ action: 'install', replace: false }, { ...c.ctx, ...more }))
  fs.rmSync(path.join(c.home, '.env'))
  assert.equal(install(), '~/.agentvoice/.env is not there yet. Run agentvoice init first.')
  fs.writeFileSync(path.join(c.home, '.env'), '')
  const npx = path.join(c.homeDir, '.npm/_npx/0123abcd/node_modules', PACKAGE_NAME)
  assert.equal(install({ packageDir: npx }), `Install AgentVoice first (npm install -g ${PACKAGE_NAME}): a service can't point into npx's cache, which npm clears.`)
  assert.equal(install({ platform: 'win32' }), 'This installs the service on macOS (launchd) or Linux (systemd) only. Run agentvoice start instead.')
  assert.equal(install({ has: () => false }), 'systemctl was not found: on Linux this installs a systemd user service. Run agentvoice start instead.')
  assert.equal(install({ label: 'my label' }), 'SERVICE_LABEL "my label" may have only letters, digits, dots, hyphens and underscores.')
  assert.equal(install({ label: '.hidden' }), 'SERVICE_LABEL ".hidden" may have only letters, digits, dots, hyphens and underscores.')
  // Checked as print checks them (before anything is installed, and for print too).
  const print = (more: Partial<ServiceContext>) => refusal(() => service({ action: 'print' }, { ...c.ctx, ...more }))
  assert.equal(print({ label: 'a/b' }), 'SERVICE_LABEL "a/b" may have only letters, digits, dots, hyphens and underscores.')
  for (const bad of ['say "hi"', 'back\\slash', 'dollar$HOME', 'line\nbreak', 'tab\there']) {
    for (const key of ['home', 'node', 'bin'] as const) {
      assert.equal(
        key === 'home' ? print({ home: `/srv/${bad}/x` }) : install({ [key]: `/srv/${bad}/x` }),
        `The path ${JSON.stringify(`/srv/${bad}/x`)} can't go into a service file: it has a quote mark, backslash, "$" or control character in it. Move your AgentVoice folder (AGENTVOICE_HOME), AgentVoice or node to a folder without one, or run agentvoice start instead.`,
      )
    }
  }
  assert.ok(!fs.existsSync(path.join(c.homeDir, '.config')), 'nothing written')
  assert.ok(!fs.existsSync(path.join(c.home, 'data')), 'no folder made')
  assert.equal(c.calls.length, 0)
  // In a clone: the clone's way.
  assert.equal(install({ mode: 'clone' }), cloneRefusal(c.pkg))
})

test('print writes the file it would install, and installs nothing; it needs no init, and takes the kind', t => {
  const c = computer(t)
  fs.rmSync(path.join(c.home, '.env'))
  service({ action: 'print' }, c.ctx)
  service({ action: 'print', kind: 'launchd' }, { ...c.ctx, platform: 'win32' })
  assert.deepEqual(c.out, [systemdUnit(c.ctx).trimEnd(), launchdPlist(c.ctx).trimEnd()])
  assert.equal(refusal(() => service({ action: 'print' }, { ...c.ctx, platform: 'win32' })), 'This installs the service on macOS (launchd) or Linux (systemd) only. Run agentvoice start instead.')
  assert.ok(!fs.existsSync(path.join(c.homeDir, '.config')))
  assert.equal(c.calls.length, 0)
  // What it checks before it prints (or installs): the file reads back as this folder and this command.
  assert.equal(checkedUnit('systemd', c.ctx), systemdUnit(c.ctx))
  assert.match(refusal(() => checkedUnit('systemd', { ...c.ctx, home: '/srv/av ' })), /^The systemd unit agentvoice service install made doesn't give back your AgentVoice folder \(\/srv\/av \) as systemd will read it, so nothing was installed\.$/)
})

test('uninstall stops and removes this AgentVoice folder\'s unit only', t => {
  const c = computer(t)
  service({ action: 'uninstall' }, c.ctx)
  assert.deepEqual(c.out, ['No voice service is installed as local.agent-voice (~/.config/systemd/user/local.agent-voice.service is not there): nothing to remove.'])
  service({ action: 'install', replace: false }, c.ctx)
  c.calls.length = 0
  c.out.length = 0
  // Another folder's: left, and named.
  const theirs = systemdUnit({ ...c.ctx, home: path.join(c.homeDir, 'AgentVoice') })
  fs.writeFileSync(c.target, theirs)
  assert.equal(
    refusal(() => service({ action: 'uninstall' }, c.ctx)),
    `~/.config/systemd/user/local.agent-voice.service runs the voice service from ~/AgentVoice, not your AgentVoice folder (~/.agentvoice), so it was left as it is. Remove it as that one was installed (${SETUP_DOC}, "Keeping it running").`,
  )
  assert.equal(fs.readFileSync(c.target, 'utf8'), theirs)
  assert.equal(c.calls.length, 0)
  // Ours: stopped, removed, and systemd told.
  fs.writeFileSync(c.target, systemdUnit(c.ctx))
  service({ action: 'uninstall' }, c.ctx)
  assert.ok(!fs.existsSync(c.target))
  assert.deepEqual(c.calls, ['systemctl --user disable --now local.agent-voice.service', 'systemctl --user daemon-reload'])
  assert.deepEqual(c.out, ['Stopped the voice service local.agent-voice and removed ~/.config/systemd/user/local.agent-voice.service. Your AgentVoice folder (~/.agentvoice) is as it was.'])
  assert.ok(fs.existsSync(path.join(c.home, '.env')), 'the AgentVoice folder stays')
  // macOS, and from npx too (after npm uninstall -g, npx is how the command is still at hand).
  const m = computer(t, 'darwin', { packageDir: path.join('/nonexistent-av/.npm/_npx/0123/node_modules', PACKAGE_NAME) })
  fs.mkdirSync(path.dirname(m.target), { recursive: true })
  fs.writeFileSync(m.target, launchdPlist(m.ctx))
  service({ action: 'uninstall' }, m.ctx)
  assert.ok(!fs.existsSync(m.target))
  assert.deepEqual(m.calls, [`launchctl unload ${m.target}`])
})

test('agentvoice service, installed: print names the home, the node and bin setup writes, and SERVICE_LABEL from .env; install runs systemctl', { timeout: 120_000 }, t => {
  const at = installedPackage(t)
  const fake = path.join(at.tmp, 'fakebin')
  fs.mkdirSync(fake)
  const log = path.join(at.tmp, 'calls.log')
  fs.writeFileSync(path.join(fake, 'systemctl'), `#!/bin/sh\necho "systemctl $*" >> "${log}"\n`, { mode: 0o755 })
  const env = (extra: Record<string, string | undefined> = {}) =>
    envFor({ HOME: at.home, TMPDIR: at.tmp, SERVICE_LABEL: undefined, XDG_CONFIG_HOME: undefined, PATH: [fake, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':'), ...extra })
  const owner = path.join(at.home, '.agentvoice')
  const [node, bin] = agentvoiceCommand(process.execPath, at.pkg)
  const printed = agentvoice(at.pkg, ['service', 'print', 'systemd'], env(), at.elsewhere)
  assert.equal(printed.status, 0, printed.stderr)
  assert.equal(printed.stdout, systemdUnit({ label: 'local.agent-voice', home: owner, node, bin, version: PACKAGE_VERSION }))
  assert.equal(bin, path.join(at.pkg, 'bin/agentvoice.js'))
  assert.doesNotMatch(printed.stdout, /node_modules\/tsx/)
  assert.ok(!fs.existsSync(owner), 'print makes nothing')
  const install = agentvoice(at.pkg, ['service', 'install'], env(), at.elsewhere)
  assert.equal(install.status, 1)
  assert.equal(install.stderr, '~/.agentvoice/.env is not there yet. Run agentvoice init first.\n')
  assert.equal(agentvoice(at.pkg, ['init'], env(), at.elsewhere).status, 0)
  fs.appendFileSync(path.join(owner, '.env'), '\nSERVICE_LABEL=my.voice\n')
  const plist = agentvoice(at.pkg, ['service', 'print', 'launchd'], env(), at.elsewhere)
  assert.equal(plist.stdout, launchdPlist({ label: 'my.voice', home: owner, node, bin, version: PACKAGE_VERSION }))
  if (process.platform === 'linux') {
    const done = agentvoice(at.pkg, ['service', 'install'], env(), at.elsewhere)
    assert.equal(done.status, 0, done.stderr)
    assert.match(done.stdout, /^The meeting assistant's voice service is installed and loaded as the systemd user service my\.voice\. Logs: ~\/\.agentvoice\/data\/agent-voice\.log\n/)
    const unit = path.join(at.home, '.config/systemd/user/my.voice.service')
    assert.equal(fs.readFileSync(unit, 'utf8'), systemdUnit({ label: 'my.voice', home: owner, node, bin, version: PACKAGE_VERSION }))
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), [
      'systemctl --user daemon-reload',
      'systemctl --user enable my.voice.service',
      'systemctl --user restart my.voice.service',
      'systemctl --user is-active --quiet my.voice.service',
    ])
    // The environment's label wins over .env's, as the script and the service read it.
    const other = agentvoice(at.pkg, ['service', 'print'], env({ SERVICE_LABEL: 'from.shell' }), at.elsewhere)
    assert.match(other.stdout, /^Description=from\.shell: /m)
    const removed = agentvoice(at.pkg, ['service', 'uninstall'], env(), at.elsewhere)
    assert.equal(removed.status, 0, removed.stderr)
    assert.ok(!fs.existsSync(unit))
  }
  const usage = agentvoice(at.pkg, ['service', 'reinstall'], env(), at.elsewhere)
  assert.equal(usage.status, 2)
  assert.match(usage.stderr, /^Unknown service command "reinstall": agentvoice service install, print or uninstall\.\nUsage: agentvoice service install \[--replace\]\n/)
})
