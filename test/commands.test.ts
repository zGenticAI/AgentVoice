// The words for commands, the owner's files and the docs (src/commands.ts): a clone's are word for word what its
// messages always said; installed from npm, the agentvoice command, the settings file's real place and the running
// version's docs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ROOT } from '../src/config.ts'
import { CANVAS_MISSING, CLONE_SETUP, DOCS_URL, INSTALL_FIRST, PROFILE_HERE, UPGRADE, WORDS, commandWords } from '../src/commands.ts'
import { PACKAGE_NAME } from '../src/home.ts'

test("a clone's words are today's: npm run, npm start, the install scripts, .env and docs/", () => {
  const words = commandWords('clone', ROOT, '0.3.0', '/home/sam')
  assert.equal(words.run('join'), 'npm run join')
  assert.equal(words.run('join', '"<link>" --speaker-probe'), 'npm run join -- "<link>" --speaker-probe')
  assert.equal(words.run('check'), 'npm run check')
  assert.equal(words.run('slides', 'check <the script>'), 'npm run slides -- check <the script>')
  assert.equal(words.run('check-name', '--all'), 'npm run check-name -- --all')
  assert.equal(`${words.run('speaker-report')} ${words.optional('--json')}`, 'npm run speaker-report [-- --json]')
  assert.equal(words.start, 'npm start')
  assert.equal(words.serviceInstall, 'scripts/install-service.sh')
  assert.equal(words.envFile, '.env')
  assert.equal(words.ownerPath('data/transcripts/'), 'data/transcripts/')
  assert.equal(words.ownerPath('data/brief.md'), 'data/brief.md')
  assert.equal(words.profileHere, 'profile.md in this folder')
  assert.equal(words.startProfile, 'copy profile.example.md to start one')
  assert.equal(words.sameFolder, 'the same .env (CONTROL_SOCKET) and the same data folder')
  assert.equal(words.doc('setup'), 'docs/setup.md')
  assert.equal(words.reinstall, 'npm install')
})

test('installed, the words name agentvoice, the AgentVoice folder and the docs of the running version', () => {
  // The repository on GitHub, where npm's page for the package links to (package.json's homepage and repository).
  assert.match(DOCS_URL, /^https:\/\/github\.com\/[\w-]+\/AgentVoice\/blob$/)
  const words = commandWords('installed', '/h/.agentvoice', '0.3.0', '/h')
  assert.equal(words.run('join'), 'agentvoice join')
  assert.equal(words.run('join', '"<link>" --speaker-probe'), 'agentvoice join "<link>" --speaker-probe')
  assert.equal(words.run('check'), 'agentvoice check')
  assert.equal(words.run('slides', 'check <the script>'), 'agentvoice slides check <the script>')
  assert.equal(words.run('check-name', '--all'), 'agentvoice check-name --all')
  assert.equal(`${words.run('speaker-report')} ${words.optional('--json')}`, 'agentvoice speaker-report [--json]')
  assert.equal(`${words.run('flux-probe')} ${words.optional('--mic')}`, 'agentvoice flux-probe [--mic]')
  assert.equal(words.start, 'agentvoice start')
  assert.equal(words.serviceInstall, 'agentvoice service install')
  assert.equal(words.envFile, '~/.agentvoice/.env')
  assert.equal(words.ownerPath('data/transcripts/'), '~/.agentvoice/data/transcripts/')
  assert.equal(words.ownerPath('data/brief.md'), '~/.agentvoice/data/brief.md')
  assert.equal(words.profileHere, '~/.agentvoice/profile.md')
  assert.equal(words.startProfile, 'agentvoice init makes one from the example')
  assert.equal(words.sameFolder, 'the same AgentVoice folder (AGENTVOICE_HOME, now ~/.agentvoice)')
  assert.equal(words.doc('setup'), `${DOCS_URL}/v0.3.0/docs/setup.md`)
  assert.equal(words.reinstall, `npm install -g ${PACKAGE_NAME}`)
  // An AgentVoice folder outside the home folder is named in full.
  const elsewhere = commandWords('installed', '/srv/av', '0.3.0', '/h')
  assert.equal(elsewhere.envFile, '/srv/av/.env')
  assert.equal(elsewhere.ownerPath('data/speaker-probe/'), '/srv/av/data/speaker-probe/')
  assert.equal(elsewhere.sameFolder, 'the same AgentVoice folder (AGENTVOICE_HOME, now /srv/av)')
})

test('this suite runs from a clone, so its words are the clone words, and the one-mode sentences are fixed', () => {
  const clone = commandWords('clone', ROOT)
  for (const key of ['start', 'serviceInstall', 'envFile', 'profileHere', 'startProfile', 'sameFolder', 'reinstall'] as const) {
    assert.equal(WORDS[key], clone[key], key)
  }
  assert.equal(WORDS.run('slides', 'list'), 'npm run slides -- list')
  assert.equal(PROFILE_HERE, 'profile.md in this folder')
  assert.equal(CANVAS_MISSING, 'Slide rendering needs @napi-rs/canvas: run npm install (without --omit=optional).')
  assert.equal(
    CLONE_SETUP,
    'set it up as its README says (cp .env.example .env, scripts/install-service.sh, scripts/install-channel.sh, ' +
      'scripts/install-codex.sh, scripts/install-opencode.sh)',
  )
  assert.equal(INSTALL_FIRST, `Install AgentVoice first (npm install -g ${PACKAGE_NAME})`)
  assert.equal(UPGRADE, `npm install -g ${PACKAGE_NAME}@latest`)
})
