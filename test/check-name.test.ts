import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { ROOT } from '../src/config.ts'

// npm run check-name, run as the owner runs it. The identity variables are pinned as npm test pins them, so a
// developer's own .env never changes what it says; each test sets what .env would.
const TSX = path.join(ROOT, 'node_modules/.bin/tsx')
const PINNED = { AGENT_NAME: 'Alex', AGENT_NAME_VARIANTS: '', AGENT_NAME_MISHEARD: '', AGENT_BOT_NAME: '', ALEX_BOT_NAME: '' }
const checkName = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(TSX, [path.join(ROOT, 'src/cli/check-name.ts'), ...args], {
    env: { ...process.env, ...PINNED, ...env },
    encoding: 'utf8',
    timeout: 30000,
  })

test('--variants=X and --misheard=X are read as well as --variants X and --misheard X', () => {
  for (const args of [['Nova', '--variants=Novah', '--misheard=Over'], ['Nova', '--variants', 'Novah', '--misheard', 'Over'], ['--misheard=Over', 'Nova', '--variants=Novah']]) {
    const run = checkName(args)
    assert.equal(run.status, 1, `${args.join(' ')}: ${run.stdout}${run.stderr}`)
    assert.match(run.stdout, /^Name: "Nova" \(spellings novah; mishearings over\)/, args.join(' '))
    assert.match(run.stdout, /✗ AGENT_NAME_MISHEARD: "over" is a word the rules/, args.join(' '))
    assert.doesNotMatch(run.stdout, /passes the start-up checks/, args.join(' '))
  }
})

test('an unknown option, a list without a name, a missing value or two names is a usage error, and nothing is checked', () => {
  const usage: [string[], RegExp][] = [
    [['--misheard', 'Over'], /--misheard needs a name/],
    [['--variants=Novah'], /--variants needs a name/],
    [['Nova', '--mishear', 'Over'], /Unknown option '--mishear'/],
    [['Nova', '-a'], /Unknown option '-a'/],
    [['Nova', '--misheard'], /--misheard needs a value/],
    [['Nova', '--variants', '--all'], /--variants needs a value/],
    [['Nova', 'Juniper'], /One name at a time/],
  ]
  for (const [args, said] of usage) {
    const run = checkName(args)
    assert.equal(run.status, 2, `${args.join(' ')}: ${run.stdout}${run.stderr}`)
    assert.equal(run.stdout, '', args.join(' '))
    assert.match(run.stderr, said, args.join(' '))
    assert.match(run.stderr, /Usage: npm run check-name -- \[<name> \[--variants a,b\] \[--misheard c,d\]\] \[--all\]/, args.join(' '))
  }
})

test('a name on the command line is checked with the participant-list name the service would use, from .env', () => {
  // AGENT_BOT_NAME without "AI": npm start refuses it, so check-name must too.
  const refused = checkName(['Nova'], { AGENT_BOT_NAME: "Nova (Sam's assistant)" })
  assert.equal(refused.status, 1, refused.stdout)
  assert.match(refused.stdout, /Participant-list name: "Nova \(Sam's assistant\)", from AGENT_BOT_NAME/)
  assert.match(refused.stdout, /✗ The participant-list name "Nova \(Sam's assistant\)" .* doesn't say the assistant is an AI/)
  assert.doesNotMatch(refused.stdout, /passes the start-up checks/)
  // One that names someone else: a warning.
  const other = checkName(['Nova'], { AGENT_BOT_NAME: "Alex (Sam's AI assistant)" })
  assert.equal(other.status, 0, other.stdout)
  assert.match(other.stdout, /! The participant-list name "Alex \(Sam's AI assistant\)" doesn't have the name "Nova" in it/)
  // An old ALEX_BOT_NAME that names Alex is ignored for another name, as the service ignores it, and says so.
  const stale = checkName(['Nova'], { ALEX_BOT_NAME: "Alex (Sam's AI assistant)" })
  assert.equal(stale.status, 0, stale.stdout)
  assert.match(stale.stdout, /Participant-list name: "Nova \(Sam's AI assistant\)", made from the name/)
  assert.match(stale.stdout, /! .*ALEX_BOT_NAME is "Alex \(Sam's AI assistant\)".*ignored/)
  // Nothing set: the one made from the name.
  assert.match(checkName(['Nova']).stdout, /Participant-list name: "Nova \(Sam's AI assistant\)", made from the name/)
  // Without a name, the identity .env gives.
  const fromEnv = checkName([], { AGENT_NAME: 'Nova', AGENT_BOT_NAME: 'Nova (AI)' })
  assert.match(fromEnv.stdout, /^Name: "Nova", from \.env\nParticipant-list name: "Nova \(AI\)", from AGENT_BOT_NAME/)
})

test('no unconditional all-clear: the corpus shows only the lines it has, and the everyday-word warning names the worst case', () => {
  const nova = checkName(['Nova'])
  assert.equal(nova.status, 0, nova.stdout)
  assert.match(nova.stdout, /✓ Every line reads the same/)
  assert.match(nova.stdout, /The corpus only shows the lines it contains: a word they don't use can still be heard in ordinary speech/)
  const roger = checkName(['Roger'])
  assert.equal(roger.status, 0, roger.stdout)
  assert.match(roger.stdout, /! "Roger" is also an everyday English word.*"Roger, you can go now\." said to someone else makes it leave/)
  assert.match(roger.stdout, /The corpus only shows the lines it contains/)
  assert.match(roger.stdout, /The warnings above still stand/)
  // A mishearing that is a first name says it counts for leaving.
  assert.match(checkName(['Max', '--misheard=Mark']).stdout, /! AGENT_NAME_MISHEARD: "mark" is also .* counts for leaving/)
})

test('without a name, what reading .env warns about is printed and counted, so there is no "no warnings" over it', () => {
  // A stale ALEX_BOT_NAME, ignored for another name.
  const stale = checkName([], { AGENT_NAME: 'Nova', ALEX_BOT_NAME: "Alex (Sam's AI assistant)" })
  assert.equal(stale.status, 0, stale.stdout)
  assert.equal(stale.stderr, '', 'printed once, with the rest, not on stderr when the identity is imported')
  assert.match(stale.stdout, /^Name: "Nova", from \.env\nParticipant-list name: "Nova \(Sam's AI assistant\)", made from the name/)
  assert.match(stale.stdout, /\n! ALEX_BOT_NAME is "Alex \(Sam's AI assistant\)", which names Alex, but AGENT_NAME is "Nova": it is ignored/)
  assert.doesNotMatch(stale.stdout, /with no warnings/)
  assert.match(stale.stdout, /✓ It passes the start-up checks, with 1 warning \(the service starts, and repeats it\)/)
  assert.match(stale.stdout, /The warnings above still stand/)
  // A renamed variable.
  const renamed = checkName([], { ALEX_BOT_NAME: "Alex (Sam's AI)" })
  assert.equal(renamed.stderr, '')
  assert.match(renamed.stdout, /Participant-list name: "Alex \(Sam's AI\)", from the older ALEX_BOT_NAME/)
  assert.match(renamed.stdout, /\n! ALEX_BOT_NAME is now called AGENT_BOT_NAME/)
  assert.match(renamed.stdout, /with 1 warning/)
  // Nothing to say: the all-clear for the checks, and the corpus caveat all the same.
  const clean = checkName([], { AGENT_NAME: 'Nova' })
  assert.match(clean.stdout, /✓ It passes the start-up checks, with no warnings\./)
})

test(".env's own identity warnings are not printed for a different name; .env's lists are used only for .env's own name", () => {
  // .env is for Nova, with a stale ALEX_BOT_NAME; Alex is tried. For Alex the old variable is still used (with the
  // rename warning), and what it means for Nova is no business of this run.
  const env = { AGENT_NAME: 'Nova', ALEX_BOT_NAME: "Alex (Sam's AI assistant)", AGENT_NAME_VARIANTS: 'Novah', AGENT_NAME_MISHEARD: 'Over' }
  const alex = checkName(['Alex'], env)
  assert.equal(alex.stderr, '', alex.stderr)
  assert.doesNotMatch(alex.stdout, /but AGENT_NAME is "Nova"/)
  assert.match(alex.stdout, /! ALEX_BOT_NAME is now called AGENT_BOT_NAME/)
  assert.match(alex.stdout, /^Name: "Alex" \(spellings alec, alexa, aleks; mishearings ionics, elix\)\n/, "Alex's own lists, not Nova's")
  assert.match(alex.stdout, /\.env's AGENT_NAME_VARIANTS and AGENT_NAME_MISHEARD were not used: they are for "Nova", \.env's AGENT_NAME/)
  assert.equal(alex.status, 0, alex.stdout)
  // The name .env has: its lists come with it, so "Over" (a word the rules use) is refused, as npm start would.
  for (const name of ['Nova', 'nova']) {
    const nova = checkName([name], env)
    assert.equal(nova.status, 1, nova.stdout)
    assert.match(nova.stdout, new RegExp(`^Name: "${name}" \\(spellings novah; mishearings over\\), with \\.env's AGENT_NAME_VARIANTS and AGENT_NAME_MISHEARD\\n`))
    assert.match(nova.stdout, /✗ AGENT_NAME_MISHEARD: "over" is a word the rules/)
    assert.doesNotMatch(nova.stdout, /were not used/)
  }
  // A list given on the command line is used instead of .env's, and says so.
  const given = checkName(['Nova', '--misheard', 'Novel'], env)
  assert.equal(given.status, 0, given.stdout)
  assert.match(given.stdout, /^Name: "Nova" \(spellings novah; mishearings novel\), with \.env's AGENT_NAME_VARIANTS\n/)
  assert.match(given.stdout, /--misheard was used instead of \.env's AGENT_NAME_MISHEARD/)
  // .env with no lists: nothing to say about them.
  assert.doesNotMatch(checkName(['Juniper'], { AGENT_NAME: 'Nova' }).stdout, /were not used|with \.env's/)
})
