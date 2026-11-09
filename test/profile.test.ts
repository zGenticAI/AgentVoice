import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NO_PROFILE, standingContext } from '../src/brain/brain.ts'
import { ROOT } from '../src/config.ts'
import { MAX_ABOUT_CHARS, PROFILE, PROFILE_SECTIONS, inlineList, paragraph, parseProfile, profileFile, readProfile } from '../src/profile.ts'

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'av-profile-test-'))
process.on('exit', () => fs.rmSync(DIR, { recursive: true, force: true }))

test('npm test reads an empty profile, so a developer\'s own profile.md never changes what the suite checks', () => {
  assert.equal(PROFILE.file, path.join(ROOT, 'test', 'fixtures', 'no-profile.md'))
  assert.equal(PROFILE.found, true)
  assert.deepEqual(PROFILE.sections, NO_PROFILE.sections)
  assert.deepEqual(PROFILE.warnings, [])
})

test('the five sections are read by their headings, in any case, with comments and anything before the first section left out', () => {
  const profile = parseProfile(
    '# My profile\nIgnored intro.\n<!-- a note\n## About\nnot a heading inside a comment -->\n' +
      '## about\nSam runs Acme.\n<!-- left out -->\nIt builds clinic software.\n\n' +
      '## Hand to the session:\n- the roadmap\n- pricing\n\n' +
      '##  Knowledge   sources ##\n- `~/acme/docs`: the product.\n  ### Detail\n  more\n\n' +
      '## Never share\n- Revenue.\n\n## NEVER OPEN\n- `~/acme/hr/`\n',
    '/x/profile.md',
  )
  assert.deepEqual(profile.sections, {
    about: 'Sam runs Acme.\n\nIt builds clinic software.',
    handOff: '- the roadmap\n- pricing',
    sources: '- `~/acme/docs`: the product.\n  ### Detail\n  more',
    neverShare: '- Revenue.',
    neverOpen: '- `~/acme/hr/`',
  })
  assert.deepEqual(profile.warnings, [])
  assert.deepEqual(Object.values(PROFILE_SECTIONS), ['About', 'Hand to the session', 'Knowledge sources', 'Never share', 'Never open'])
})

test('an unknown heading is ignored with a warning naming it and the sections there are, so a typo is seen', () => {
  const profile = parseProfile('## Abuot\nSam runs Acme.\n\n## Never share\n- Revenue.\n', '/x/profile.md')
  assert.equal(profile.sections.about, '', 'its text is not taken as any section')
  assert.equal(profile.sections.neverShare, '- Revenue.')
  assert.equal(profile.warnings.length, 1)
  assert.match(profile.warnings[0], /^\[profile\] profile\.md: "## Abuot" is not a section the assistant reads \(About, Hand to the session, Knowledge sources, Never share, Never open\), so it is ignored\./)
})

test('a long About is a warning: it goes into every spoken answer', () => {
  const profile = parseProfile(`## About\n${'Sam runs Acme. '.repeat(50)}`, '/x/profile.md')
  assert.match(profile.warnings.join('\n'), new RegExp(`"## About" is \\d+ characters long\\. .*${MAX_ABOUT_CHARS} characters at most`))
})

test('a missing profile.md is the generic defaults; a PROFILE_FILE that is missing, or a profile that can\'t be read, stops the start', () => {
  const missing = path.join(DIR, 'missing.md')
  assert.equal(readProfile(missing).problem, '', 'the default profile.md is optional')
  assert.deepEqual(readProfile(missing).warnings, [])
  assert.equal(readProfile(missing).found, false)
  assert.deepEqual(readProfile(missing).sections, NO_PROFILE.sections)
  // Named, it holds the owner's Never share and Never open: a typo must not drop them without a word.
  assert.match(
    readProfile(missing, true).problem,
    /^PROFILE_FILE names .*missing\.md, which doesn't exist\. It holds your Never share and Never open, so the service and the channel don't start without it: /,
  )
  assert.match(readProfile(DIR, true).problem, /^PROFILE_FILE names .*, which can't be read \(EISDIR\)\./)
  assert.match(readProfile(DIR).problem, /^.*av-profile-test-\w+, which can't be read \(EISDIR\)\./, 'a profile.md that is there but can\'t be read too')
  assert.equal(readProfile(DIR).found, false)
  assert.equal(PROFILE.problem, '')
  assert.equal(parseProfile('## About\nx\n', '/x/p.md').problem, '')
})

test('PROFILE_FILE is profile.md in the repository unless set; a relative path is from the repository, "~" is home', () => {
  assert.deepEqual(profileFile({}), { file: path.join(ROOT, 'profile.md'), named: false })
  assert.deepEqual(profileFile({ PROFILE_FILE: ' ' }), { file: path.join(ROOT, 'profile.md'), named: false })
  assert.deepEqual(profileFile({ PROFILE_FILE: 'private/me.md' }), { file: path.join(ROOT, 'private/me.md'), named: true })
  assert.deepEqual(profileFile({ PROFILE_FILE: '~/notes/me.md' }), { file: path.join(os.homedir(), 'notes/me.md'), named: true })
})

test('a section goes into a prompt as one paragraph, or a list on one line', () => {
  assert.equal(paragraph('Sam runs Acme.\nIt builds clinic software.\n'), 'Sam runs Acme. It builds clinic software.')
  assert.equal(inlineList('current work, repos, decisions'), 'current work, repos, decisions', 'one line stays as it is')
  assert.equal(inlineList('current work, repos,\nor decisions'), 'current work, repos, or decisions')
  assert.equal(inlineList('- the roadmap.\n- pricing,\n  and discounts\n* hiring'), 'the roadmap; pricing, and discounts; hiring')
  assert.equal(inlineList('1. one\n2) two'), 'one; two')
  assert.equal(inlineList(''), '')
})

test("the standing context is the profile's About, else the company sentence, else nothing", () => {
  const about = parseProfile('## About\nPriya leads product.\n', '/x/p.md')
  assert.equal(standingContext({ owner: 'Priya', company: 'Acme' }, about), 'Priya leads product.')
  assert.equal(standingContext({ owner: 'Priya', company: 'Acme' }), 'Priya works at Acme.')
  assert.equal(standingContext({ owner: 'Priya', company: '' }), '')
})

test('profile.example.md has the five sections and nothing else, and its notes are comments', () => {
  const file = path.join(ROOT, 'profile.example.md')
  const profile = readProfile(file, true)
  assert.deepEqual(profile.warnings, [])
  for (const [key, heading] of Object.entries(PROFILE_SECTIONS)) {
    assert.ok(profile.sections[key as keyof typeof PROFILE_SECTIONS], `${heading} has example text`)
  }
  assert.doesNotMatch(Object.values(profile.sections).join('\n'), /<!--|-->/)
  // profile.md is yours: it is never committed.
  assert.match(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8'), /^profile\.md$/m)
})
