// The two modes (src/home.ts): a clone, where everything is in the repository as it always was, and installed from npm
// (<anything>/node_modules/<the package's name>), where the owner's files are in ~/.agentvoice or AGENTVOICE_HOME. What a
// process does in each is in test/installed-mode.test.ts and test/clone-mode.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { INSTALL_MODE, OWNER_DIR, PACKAGE_DIR, ROOT } from '../src/config.ts'
import {
  PACKAGE_NAME, PACKAGE_VERSION, insidePackage, installModeOf, isWithin, ownerDirFor, packagePathError, realPath, tildePath,
} from '../src/home.ts'
import { prepareOwnerDir } from '../src/local-token.ts'

const TMP = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir()

function tempDir(t: { after: (fn: () => unknown) => void }, prefix = 'av-home-'): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(TMP, prefix)))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

const mkdir = (dir: string) => (fs.mkdirSync(dir, { recursive: true }), dir)
const [SCOPE, NAME] = PACKAGE_NAME.split('/')

test('the suite runs from a clone: the owner folder is the repository, the package folder too', () => {
  assert.equal(INSTALL_MODE, 'clone')
  assert.equal(PACKAGE_DIR, ROOT)
  assert.equal(OWNER_DIR, ROOT)
  assert.match(PACKAGE_NAME, /^@[a-z0-9-]+\/agentvoice$/, 'a scoped package, whose folder installModeOf looks for')
  assert.equal(PACKAGE_VERSION, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version)
  assert.equal(installModeOf(ROOT), 'clone')
})

test('installed means the package folder, links resolved, is <anything>/node_modules/<the package name>', t => {
  const dir = tempDir(t)
  // npm i -g, the npx cache, a local install, pnpm's store: wherever npm, pnpm, yarn or bun put the package.
  for (const installed of [
    `prefix/lib/node_modules/${PACKAGE_NAME}`,
    `home/.npm/_npx/1a2b3c4d5e6f7a8b/node_modules/${PACKAGE_NAME}`,
    `project/node_modules/${PACKAGE_NAME}`,
    `project/node_modules/.pnpm/${PACKAGE_NAME.replace('/', '+')}@0.3.0/node_modules/${PACKAGE_NAME}`,
    `home/.bun/install/global/node_modules/${PACKAGE_NAME}`,
  ]) {
    assert.equal(installModeOf(mkdir(path.join(dir, installed))), 'installed', installed)
  }
  // A path not made (yet) is read as it is written.
  assert.equal(installModeOf(path.join(dir, `gone/node_modules/${PACKAGE_NAME}`)), 'installed')

  // A clone wherever it is, a copy without .git (test/client-text.test.ts makes one in /tmp), and npm link or
  // npm i -g ./AgentVoice, which link to the clone: all clones.
  const clone = mkdir(path.join(dir, 'AgentVoice'))
  assert.equal(installModeOf(clone), 'clone')
  assert.equal(installModeOf(mkdir(path.join(dir, 'copy/agentvoice'))), 'clone')
  const linked = path.join(mkdir(path.join(dir, `prefix2/lib/node_modules/${SCOPE}`)), NAME)
  fs.symlinkSync(clone, linked)
  assert.equal(installModeOf(linked), 'clone', 'npm link: the link leads to the clone')
  // Only this package's name, in its scope.
  for (const other of ['p/node_modules/@other/agentvoice', 'p/node_modules/agentvoice', `p/node_modules/${SCOPE}/agent-voice`, `p/node_modules/${PACKAGE_NAME}/x`, `p/${PACKAGE_NAME}`]) {
    assert.equal(installModeOf(mkdir(path.join(dir, other))), 'clone', other)
  }
  // And the other way round: a link, from anywhere, to an installed package is the installed package.
  const viaLink = path.join(dir, 'shortcut')
  fs.symlinkSync(path.join(dir, `prefix/lib/node_modules/${PACKAGE_NAME}`), viaLink)
  assert.equal(installModeOf(viaLink), 'installed')
})

test("a clone's owner folder is the clone itself, and AGENTVOICE_HOME is not read", () => {
  for (const set of [undefined, '', '/somewhere/else', 'relative', '/']) {
    assert.equal(ownerDirFor('clone', { AGENTVOICE_HOME: set }, '/home/sam', '/home/sam/AgentVoice'), '/home/sam/AgentVoice', String(set))
  }
})

test('installed, the owner folder is ~/.agentvoice, or AGENTVOICE_HOME: "~/x" or an absolute path', t => {
  const home = tempDir(t)
  const pkg = mkdir(path.join(home, `prefix/lib/node_modules/${PACKAGE_NAME}`))
  const owner = (set?: string) => ownerDirFor('installed', set === undefined ? {} : { AGENTVOICE_HOME: set }, home, pkg)
  assert.equal(owner(), path.join(home, '.agentvoice'))
  assert.equal(owner(''), path.join(home, '.agentvoice'), 'empty is unset')
  assert.equal(owner('  '), path.join(home, '.agentvoice'))
  assert.equal(owner('~/av'), path.join(home, 'av'))
  assert.equal(owner(' ~/meetings/av home '), path.join(home, 'meetings/av home'), 'trimmed, and a space inside is kept')
  assert.equal(owner('/srv/agentvoice'), '/srv/agentvoice')
  assert.equal(owner('/srv/agentvoice/'), '/srv/agentvoice')
  assert.equal(owner('/srv/x/../agentvoice'), '/srv/agentvoice')
  // Not made yet is fine: agentvoice init makes it.
  assert.ok(!fs.existsSync(owner('~/not-yet')))
})

test('installed, an AGENTVOICE_HOME that the service, the commands and the client could read differently is refused', t => {
  const home = tempDir(t)
  const pkg = mkdir(path.join(home, `prefix/lib/node_modules/${PACKAGE_NAME}`))
  const refusal = (set: string) => {
    try {
      ownerDirFor('installed', { AGENTVOICE_HOME: set }, home, pkg)
    } catch (err) {
      return (err as Error).message
    }
    return ''
  }
  // A relative path would depend on the folder each one starts in; "~user" is not expanded.
  for (const relative of ['av', './av', '.agentvoice', '~sam/av', '$HOME/av']) {
    assert.equal(
      refusal(relative),
      `AGENTVOICE_HOME is "${relative}": give an absolute path, or one that starts with ~/, so the service, the commands and ` +
        'your coding client all find the same folder.',
      relative,
    )
  }
  // The whole disk, or the home folder itself, however it is written, or through a link.
  fs.symlinkSync(home, path.join(TMP, `av-home-link-${process.pid}`))
  t.after(() => fs.rmSync(path.join(TMP, `av-home-link-${process.pid}`), { force: true }))
  for (const [set, shown] of [['/', '/'], ['~', home], ['~/', home], [home, home], [`${home}/`, home], [`${home}/x/..`, home], [path.join(TMP, `av-home-link-${process.pid}`), path.join(TMP, `av-home-link-${process.pid}`)]]) {
    assert.equal(refusal(set), `AGENTVOICE_HOME is ${shown}, your whole disk or your home folder: give AgentVoice a folder of its own, such as ~/.agentvoice.`, set)
  }
  // The package folder, or anything in it, made or not, or reached through a link: npm replaces it on every upgrade.
  fs.symlinkSync(pkg, path.join(home, 'pkg-link'))
  for (const [set, shown] of [
    [pkg, pkg],
    [path.join(pkg, 'home'), path.join(pkg, 'home')],
    [path.join(pkg, 'not/made/yet'), path.join(pkg, 'not/made/yet')],
    ['~/pkg-link/data', path.join(home, 'pkg-link/data')],
  ]) {
    assert.equal(
      refusal(set),
      `AGENTVOICE_HOME (${shown}) is inside the installed package (${pkg}), which npm replaces on every upgrade: choose a folder outside it.`,
      set,
    )
  }
  // Beside the package, or above it, is not inside it.
  assert.equal(refusal(path.join(home, `prefix/lib/node_modules/${PACKAGE_NAME}-home`)), '')
  assert.equal(refusal(path.join(home, 'prefix')), '')
})

test('insidePackage: only installed, and only the package folder or below it, links resolved', t => {
  const dir = tempDir(t)
  const pkg = mkdir(path.join(dir, `lib/node_modules/${PACKAGE_NAME}`))
  assert.equal(insidePackage(path.join(ROOT, 'data')), false, 'never in a clone, its data folder included')
  assert.equal(insidePackage(ROOT), false)
  assert.equal(insidePackage(path.join(pkg, 'data'), 'clone', pkg), false)
  for (const inside of [pkg, path.join(pkg, 'data'), path.join(pkg, 'data/decks/x'), path.join(pkg, 'src/../data')]) {
    assert.equal(insidePackage(inside, 'installed', pkg), true, inside)
  }
  fs.symlinkSync(path.join(pkg), path.join(dir, 'link'))
  assert.equal(insidePackage(path.join(dir, 'link/data/control.sock'), 'installed', pkg), true, 'through a link')
  for (const outside of [path.join(dir, 'home/.agentvoice/data'), path.dirname(pkg), `${pkg}-x/data`, path.join(pkg, '..', 'agentvoice2')]) {
    assert.equal(insidePackage(outside, 'installed', pkg), false, outside)
  }
})

test('realPath and isWithin resolve links as far as the path exists', t => {
  const dir = tempDir(t)
  mkdir(path.join(dir, 'real/a'))
  fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'))
  assert.equal(realPath(path.join(dir, 'link/a/not/yet')), path.join(dir, 'real/a/not/yet'))
  assert.equal(realPath(path.join(dir, 'link')), path.join(dir, 'real'))
  assert.equal(realPath('/'), '/')
  assert.ok(isWithin(path.join(dir, 'link/a'), path.join(dir, 'real')))
  assert.ok(isWithin(path.join(dir, 'real'), path.join(dir, 'link')))
  assert.ok(!isWithin(path.join(dir, 'real-x'), path.join(dir, 'real')))
  assert.ok(!isWithin(dir, path.join(dir, 'real')))
  assert.ok(isWithin(path.join(dir, 'real/..x'), path.join(dir, 'real')), 'a name that starts with two dots is inside')
})

test('tildePath shows the home folder as ~, for messages only', () => {
  assert.equal(tildePath('/home/sam', '/home/sam'), '~')
  assert.equal(tildePath('/home/sam/.agentvoice/.env', '/home/sam'), '~/.agentvoice/.env')
  assert.equal(tildePath('/home/sam/.agentvoice/data/transcripts/', '/home/sam'), '~/.agentvoice/data/transcripts/')
  assert.equal(tildePath('/home/sam/.agentvoice', '/home/sam/'), '~/.agentvoice')
  assert.equal(tildePath('/home/samuel/x', '/home/sam'), '/home/samuel/x')
  assert.equal(tildePath('/srv/av/.env', '/home/sam'), '/srv/av/.env')
  assert.equal(tildePath('/home', '/home/sam'), '/home')
})

test('packagePathError says what put the path there, and where it belongs instead', () => {
  assert.equal(
    packagePathError('/p/lib/node_modules/av/data', 'ALEX_DATA_DIR', '/p/lib/node_modules/av', path.join(os.homedir(), '.agentvoice')).message,
    '/p/lib/node_modules/av/data is inside the installed package (/p/lib/node_modules/av), which npm ' +
      'replaces on every upgrade: ALEX_DATA_DIR must point outside it, into your AgentVoice folder (~/.agentvoice) for example.',
  )
})

test('prepareOwnerDir makes the owner folder only yours (0700), and .env in it (0600), every time', t => {
  const dir = tempDir(t)
  const owner = path.join(dir, 'av home')
  prepareOwnerDir(owner)
  assert.equal(fs.statSync(owner).mode & 0o777, 0o700, 'made 0700')
  assert.ok(!fs.existsSync(path.join(owner, '.env')), 'and no .env made')
  fs.chmodSync(owner, 0o755)
  fs.writeFileSync(path.join(owner, '.env'), 'OWNER_NAME=Sam\n', { mode: 0o644 })
  fs.chmodSync(path.join(owner, '.env'), 0o644)
  fs.writeFileSync(path.join(owner, 'profile.md'), '# x\n', { mode: 0o644 })
  prepareOwnerDir(owner)
  assert.equal(fs.statSync(owner).mode & 0o777, 0o700, 'tightened again')
  assert.equal(fs.statSync(path.join(owner, '.env')).mode & 0o777, 0o600)
  assert.equal(fs.readFileSync(path.join(owner, '.env'), 'utf8'), 'OWNER_NAME=Sam\n', 'left as it was')
  assert.equal(fs.statSync(path.join(owner, 'profile.md')).mode & 0o777, 0o644, 'nothing else is touched (the folder keeps others out)')
})
