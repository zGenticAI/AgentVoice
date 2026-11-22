// agentvoice init (src/cli/init.ts): it makes the AgentVoice folder from the package's examples, readable only by you,
// and never overwrites a file. initHome runs here on temp folders; the command itself runs from a package laid out as
// npm install -g makes it (test/layouts.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { INIT_ITEMS, initHome, initReport } from '../src/cli/init.ts'
import { ROOT } from '../src/config.ts'
import { agentvoice, envFor, installedPackage, snapshot, tempDir } from './layouts.ts'

const mode = (file: string) => fs.statSync(file).mode & 0o777
const read = (file: string) => fs.readFileSync(file, 'utf8')
const example = (name: string) => read(path.join(ROOT, name))

test('init makes the folder, data/ and briefs/ (0700) and .env, profile.md and the shared brief (0600) from the examples', t => {
  const home = path.join(tempDir(t), '.agentvoice')
  const result = initHome({ home, packageDir: ROOT })
  assert.deepEqual(result, { made: ['.env', 'profile.md', 'data/brief.md', 'briefs/'], kept: [] })
  for (const folder of ['', 'data', 'briefs']) assert.equal(mode(path.join(home, folder)), 0o700, folder || 'the folder')
  for (const file of ['.env', 'profile.md', 'data/brief.md']) assert.equal(mode(path.join(home, file)), 0o600, file)
  assert.equal(read(path.join(home, '.env')), example('.env.example'))
  assert.equal(read(path.join(home, 'profile.md')), example('profile.example.md'))
  assert.equal(read(path.join(home, 'data/brief.md')), example('brief.example.md'))
  assert.deepEqual(fs.readdirSync(home).sort(), ['.env', 'briefs', 'data', 'profile.md'])
  assert.deepEqual(fs.readdirSync(path.join(home, 'data')), ['brief.md'])
  assert.deepEqual(fs.readdirSync(path.join(home, 'briefs')), [])
})

test('the modes hold whatever the umask: never a copy that is widened, or narrowed, later', t => {
  const home = path.join(tempDir(t), 'av')
  const umask = process.umask(0o277)
  try {
    initHome({ home, packageDir: ROOT })
  } finally {
    process.umask(umask)
  }
  for (const folder of ['', 'data', 'briefs']) assert.equal(mode(path.join(home, folder)), 0o700, folder || 'the folder')
  for (const file of ['.env', 'profile.md', 'data/brief.md']) assert.equal(mode(path.join(home, file)), 0o600, file)
})

test('a second run keeps every file as it is, changes included; .env and the folders are made private again', t => {
  const home = path.join(tempDir(t), '.agentvoice')
  initHome({ home, packageDir: ROOT })
  fs.writeFileSync(path.join(home, '.env'), 'OWNER_NAME=Sam\n')
  fs.writeFileSync(path.join(home, 'profile.md'), '## About\n\nMine.\n')
  fs.writeFileSync(path.join(home, 'data/brief.md'), 'My brief.\n')
  fs.writeFileSync(path.join(home, 'briefs/acme.md'), 'For Acme.\n')
  for (const loose of ['', 'data', 'briefs']) fs.chmodSync(path.join(home, loose), 0o755)
  fs.chmodSync(path.join(home, '.env'), 0o644)
  fs.chmodSync(path.join(home, 'profile.md'), 0o644)
  assert.deepEqual(initHome({ home, packageDir: ROOT }), { made: [], kept: ['.env', 'profile.md', 'data/brief.md', 'briefs/'] })
  assert.equal(read(path.join(home, '.env')), 'OWNER_NAME=Sam\n')
  assert.equal(read(path.join(home, 'profile.md')), '## About\n\nMine.\n')
  assert.equal(read(path.join(home, 'data/brief.md')), 'My brief.\n')
  assert.equal(read(path.join(home, 'briefs/acme.md')), 'For Acme.\n')
  assert.equal(mode(path.join(home, '.env')), 0o600, '.env holds every key')
  assert.equal(mode(path.join(home, 'profile.md')), 0o644, 'any other file is left as it was')
  for (const folder of ['', 'data', 'briefs']) assert.equal(mode(path.join(home, folder)), 0o700, folder || 'the folder')

  // One missing is made, and the rest kept.
  fs.rmSync(path.join(home, 'profile.md'))
  assert.deepEqual(initHome({ home, packageDir: ROOT }), { made: ['profile.md'], kept: ['.env', 'data/brief.md', 'briefs/'] })
  assert.equal(read(path.join(home, 'profile.md')), example('profile.example.md'))
})

test('a file where a folder goes, or a folder where a file goes, is refused, with nothing written', t => {
  const tmp = tempDir(t)
  const asFile = path.join(tmp, 'a-file')
  fs.writeFileSync(asFile, 'mine\n')
  assert.throws(() => initHome({ home: asFile, packageDir: ROOT }), {
    message: `${asFile} is there, and is not a folder: move it away, then run agentvoice init again.`,
  })
  assert.equal(read(asFile), 'mine\n')

  for (const [rel, made] of [['data', 'file'], ['briefs', 'file'], ['.env', 'folder'], ['data/brief.md', 'folder']] as const) {
    const home = path.join(tmp, `home-${rel.replace('/', '-')}`)
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true })
    if (made === 'file') fs.writeFileSync(path.join(home, rel), 'mine\n')
    else fs.mkdirSync(path.join(home, rel))
    const before = snapshot(home)
    assert.throws(() => initHome({ home, packageDir: ROOT }), {
      message: `${path.join(home, rel)} is there, and is not a ${made === 'file' ? 'folder' : 'file'}: move it away, then run agentvoice init again.`,
    }, rel)
    assert.deepEqual(snapshot(home), before, `${rel}: nothing written`)
  }
})

test('nothing is ever made inside the package, even through a link', t => {
  const tmp = tempDir(t)
  const pkg = path.join(tmp, 'pkg')
  fs.mkdirSync(pkg)
  for (const name of ['.env.example', 'profile.example.md', 'brief.example.md']) fs.copyFileSync(path.join(ROOT, name), path.join(pkg, name))
  const before = snapshot(pkg)
  assert.throws(() => initHome({ home: path.join(pkg, 'home'), packageDir: pkg }), /is inside the installed package \(.*\), which npm replaces on every upgrade: your AgentVoice folder must be outside it\.$/)
  const home = path.join(tmp, 'home')
  fs.mkdirSync(home)
  fs.symlinkSync(pkg, path.join(home, 'data'))
  assert.throws(() => initHome({ home, packageDir: pkg }), {
    message: `${path.join(home, 'data')} is inside the installed package (${pkg}), which npm replaces on every upgrade: your AgentVoice folder must be outside it.`,
  })
  assert.deepEqual(snapshot(pkg), before)
  assert.deepEqual(fs.readdirSync(home), ['data'])
})

const NEXT = (at: (rel: string) => string) => [
  '',
  'Next:',
  `  1. In ${at('.env')}, set OWNER_NAME, the keys (ANTHROPIC_API_KEY, DEEPGRAM_API_KEY, ELEVENLABS_API_KEY with`,
  '     ELEVENLABS_VOICE_ID, RECALL_API_KEY with RECALL_REGION), AGENT_PAGE_TOKEN (openssl rand -hex 24) and PUBLIC_URL.',
  `  2. Make ${at('profile.md')} yours, and fill in the shared brief, ${at('data/brief.md')}: until then they`,
  '     are the examples.',
  '  3. agentvoice check',
  '  4. agentvoice start, or agentvoice service install to keep it running.',
  '  5. To link your coding session: make a new, empty folder for it, then run agentvoice setup claude-code (or codex,',
  '     or opencode) in it, for example: mkdir -p ~/agentvoice-session && cd ~/agentvoice-session && agentvoice setup claude-code',
]

/** What init prints the first time, for ~/.agentvoice (spec 3.1). */
const FIRST_RUN = [
  'Your AgentVoice folder is ~/.agentvoice (only you can open it).',
  '  made  ~/.agentvoice/.env            from .env.example (only you can read it)',
  '  made  ~/.agentvoice/profile.md      from profile.example.md',
  '  made  ~/.agentvoice/data/brief.md   from brief.example.md: the shared brief (only you can read it)',
  '  made  ~/.agentvoice/briefs/         for the briefs of single meetings',
  '(A file that was already there is listed as "kept", and left as it was.)',
  ...NEXT(rel => `~/.agentvoice/${rel}`),
].join('\n')

test('what init prints: the folder, what it made or kept, and the next steps', () => {
  const home = path.join(os.homedir(), '.agentvoice')
  assert.equal(initReport({ home, made: [...INIT_ITEMS], kept: [], fromSetting: false }), FIRST_RUN)
  assert.equal(
    initReport({ home, made: ['profile.md'], kept: ['.env', 'data/brief.md', 'briefs/'], fromSetting: false }).split('\n').slice(1, 5).join('\n'),
    [
      '  kept  ~/.agentvoice/.env            your settings (only you can read it)',
      '  made  ~/.agentvoice/profile.md      from profile.example.md',
      '  kept  ~/.agentvoice/data/brief.md   the shared brief',
      '  kept  ~/.agentvoice/briefs/         for the briefs of single meetings',
    ].join('\n'),
  )
  // Named by AGENTVOICE_HOME, outside the home folder: in full, and the reminder to keep it set.
  const custom = '/srv/av home'
  const named = initReport({ home: custom, made: [...INIT_ITEMS], kept: [], fromSetting: true }).split('\n')
  assert.equal(named[0], 'Your AgentVoice folder is /srv/av home (AGENTVOICE_HOME; only you can open it).')
  assert.equal(named[1], '  made  /srv/av home/.env            from .env.example (only you can read it)')
  assert.equal(named[4], '  made  /srv/av home/briefs/         for the briefs of single meetings')
  assert.deepEqual(named.slice(6, -1), NEXT(rel => `${custom}/${rel}`))
  assert.equal(
    named.at(-1),
    'Keep AGENTVOICE_HOME set in your shell for agentvoice commands: agentvoice service install and agentvoice setup write it into the service and the client configs themselves.',
  )
})

test('agentvoice init, installed: ~/.agentvoice, or AGENTVOICE_HOME, a space in it included; the package is left as it is', { timeout: 60_000 }, t => {
  const at = installedPackage(t)
  const before = snapshot(at.pkg)
  const env = envFor({ HOME: at.home, TMPDIR: at.tmp })
  const first = agentvoice(at.pkg, ['init'], env, at.elsewhere)
  assert.equal(first.status, 0, first.stderr)
  assert.equal(first.stderr, '')
  const owner = path.join(at.home, '.agentvoice')
  assert.equal(first.stdout, `${FIRST_RUN}\n`)
  assert.equal(mode(owner), 0o700)
  assert.equal(mode(path.join(owner, '.env')), 0o600)
  assert.equal(read(path.join(owner, '.env')), example('.env.example'))
  const again = agentvoice(at.pkg, ['init'], env, at.elsewhere)
  assert.equal(again.status, 0, again.stderr)
  assert.match(again.stdout, /^ {2}kept {2}~\/\.agentvoice\/\.env {12}your settings/m)
  assert.deepEqual(fs.readdirSync(at.elsewhere), [], 'nothing in the folder it ran in')

  const custom = path.join(at.tmp, 'av home')
  const named = agentvoice(at.pkg, ['init'], envFor({ HOME: at.home, TMPDIR: at.tmp, AGENTVOICE_HOME: custom }), at.elsewhere)
  assert.equal(named.status, 0, named.stderr)
  assert.ok(named.stdout.startsWith(`Your AgentVoice folder is ${custom} (AGENTVOICE_HOME; only you can open it).\n`), named.stdout)
  assert.match(named.stdout, /\nKeep AGENTVOICE_HOME set in your shell for agentvoice commands: .*\n$/)
  assert.equal(read(path.join(custom, 'data/brief.md')), example('brief.example.md'))
  assert.deepEqual(snapshot(at.pkg), before, 'nothing written into the package')
})
