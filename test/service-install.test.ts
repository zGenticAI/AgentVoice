// scripts/install-service.sh fills its templates with this folder's path and node's, so a path with characters
// that mean something in a plist or a systemd unit must not break the file, and a file that doesn't read back as
// this folder must stop the script, not install a service that never runs. Its --print mode installs nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT } from '../src/config.ts'

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'av-install-'))
process.on('exit', () => fs.rmSync(BASE, { recursive: true, force: true }))
// The script never reaches a real service manager from here: launchctl, systemctl and loginctl are stand-ins that
// note being called and fail, and the home folder is a scratch one.
const FAKE_BIN = path.join(BASE, 'bin')
const CALLED = path.join(BASE, 'service-manager-called')
fs.mkdirSync(FAKE_BIN)
for (const tool of ['launchctl', 'systemctl', 'loginctl']) {
  fs.writeFileSync(path.join(FAKE_BIN, tool), `#!/bin/sh\necho "${tool} $*" >> "${CALLED}"\nexit 1\n`, { mode: 0o755 })
}
const HOME = path.join(BASE, 'home')

/** A copy of the script and its templates in a folder of this name, as a clone there would have them. */
function clone(name: string, edit: (file: string, text: string) => string = (_f, t) => t): string {
  const dir = path.join(BASE, name)
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  for (const file of ['install-service.sh', 'agent-voice.plist', 'agent-voice.service']) {
    fs.writeFileSync(path.join(dir, 'scripts', file), edit(file, fs.readFileSync(path.join(ROOT, 'scripts', file), 'utf8')), { mode: 0o755 })
  }
  return fs.realpathSync(dir)
}

/** What the script prints for that kind of service, from a clone in `dir`. */
function print(dir: string, kind: 'launchd' | 'systemd') {
  return spawnSync('bash', [path.join(dir, 'scripts', 'install-service.sh'), '--print', kind], {
    env: { ...process.env, SERVICE_LABEL: '', PATH: `${FAKE_BIN}:${process.env.PATH}`, HOME, XDG_CONFIG_HOME: path.join(HOME, '.config') },
    encoding: 'utf8',
  })
}

test.after(() => {
  assert.ok(!fs.existsSync(CALLED), `no service manager was called: ${fs.existsSync(CALLED) ? fs.readFileSync(CALLED, 'utf8') : ''}`)
  assert.ok(!fs.existsSync(HOME), 'nothing was installed in the home folder')
})

const xml = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
/** A unit's value as systemd reads it: "%%" is "%". */
const unit = (text: string) => text.replace(/%%/g, '%')

test('the plist and the unit name this folder, node and the label, and print without installing anything', () => {
  const dir = clone('plain')
  const plist = print(dir, 'launchd')
  assert.equal(plist.status, 0, plist.stderr)
  assert.match(plist.stdout, /<key>Label<\/key><string>local\.agent-voice<\/string>/)
  assert.ok(plist.stdout.includes(`<key>WorkingDirectory</key><string>${dir}</string>`), plist.stdout)
  assert.ok(plist.stdout.includes(`<string>${dir}/data/agent-voice.log</string>`))
  const service = print(dir, 'systemd')
  assert.equal(service.status, 0, service.stderr)
  assert.ok(service.stdout.includes(`WorkingDirectory=${dir}\n`), service.stdout)
  assert.match(service.stdout, /^Description=local\.agent-voice: /m)
  assert.ok(!fs.existsSync(path.join(dir, 'data')), 'nothing made: --print installs nothing')
})

test('a folder with &, <, > or % in its path gives a well-formed plist and a unit systemd reads as that folder', () => {
  const dir = clone('R&D <lab> 100% done')
  const plist = print(dir, 'launchd')
  assert.equal(plist.status, 0, plist.stderr)
  assert.ok(plist.stdout.includes('R&amp;D &lt;lab&gt; 100% done'), plist.stdout)
  assert.doesNotMatch(plist.stdout.replace(/&(?:amp|lt|gt|quot|apos);/g, ''), /&/, 'every "&" is an entity')
  const strings = [...plist.stdout.matchAll(/<string>([^<]*)<\/string>/g)].map(m => xml(m[1]))
  assert.ok(strings.includes(dir), strings.join('\n'))
  assert.ok(strings.includes(`${dir}/node_modules/tsx/dist/cli.mjs`))
  const xmllint = spawnSync('xmllint', ['--noout', '-'], { input: plist.stdout, encoding: 'utf8' })
  if (!xmllint.error) assert.equal(xmllint.status, 0, xmllint.stderr)

  const service = print(dir, 'systemd')
  assert.equal(service.status, 0, service.stderr)
  const value = (key: string) => /^(\w+)=(.*)$/m.exec(service.stdout.split('\n').find(line => line.startsWith(`${key}=`)) ?? '')?.[2] ?? ''
  assert.equal(unit(value('WorkingDirectory')), dir)
  assert.equal(value('WorkingDirectory'), dir.replace(/%/g, '%%'), 'each "%" doubled, so systemd reads no specifier')
  assert.ok(unit(value('ExecStart')).includes(`"${dir}/node_modules/tsx/dist/cli.mjs"`), value('ExecStart'))
  assert.equal(unit(value('StandardOutput')), `append:${dir}/data/agent-voice.log`)
  for (const line of service.stdout.split('\n').filter(l => l.includes('100'))) assert.doesNotMatch(line, /(?<!%)%(?!%)/, line)
})

test('a folder whose path no service file can hold is refused, with the reason', () => {
  for (const name of ['say "hi"', 'back\\slash', 'cost $5']) {
    const dir = clone(name)
    for (const kind of ['launchd', 'systemd'] as const) {
      const run = print(dir, kind)
      assert.equal(run.status, 1, `${name} ${kind}: ${run.stdout}`)
      assert.equal(run.stdout, '')
      assert.match(run.stderr, /can't go into a service file: it has a quote mark, backslash, "\$" or control character in it\. Move the clone/)
    }
  }
})

test('a service file that does not read back as this folder stops the script, loudly, before anything is installed', () => {
  const dir = clone('broken', (file, text) => file === 'agent-voice.plist' ? text.replace('<string>__DIR__</string>', '<string>__DIR__</strin>') : text)
  const run = print(dir, 'launchd')
  assert.equal(run.status, 1)
  assert.equal(run.stdout, '')
  assert.match(run.stderr, /The launchd plist made from scripts\/agent-voice\.plist is not valid|doesn't give back this folder/)
})

test('the systemd unit claims no ordering a user service manager cannot give', () => {
  const text = fs.readFileSync(path.join(ROOT, 'scripts', 'agent-voice.service'), 'utf8')
  const settings = text.split('\n').filter(line => !line.startsWith('#'))
  assert.doesNotMatch(settings.join('\n'), /network-online|^After=|^Wants=/m)
  assert.match(text, /^# .*network-online\.target/m, 'a comment says why')
})
