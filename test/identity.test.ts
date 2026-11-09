import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { GRAMMAR_WORDS } from '../src/brain/attention.ts'
import { makeNameRules } from '../src/brain/text.ts'
import { ROOT, keyterms } from '../src/config.ts'
import {
  ADDRESS_WORDS, ALEX_PROFILE, type AgentName, COMMON_FIRST_NAMES, COMMON_WORD_NAMES, DEFAULT_NAME, type Owner, agentName, defaultBotName,
  fold, identity, nameList, readIdentity, readOwner,
} from '../src/identity.ts'
import { botNameProblem, checkName, checkNameAtStartup, checkOwner, describeName, isGrammarWord, ownerSettingProblem } from '../src/name-check.ts'

const named = (name: string, variants: string[] = [], misheard: string[] = []): AgentName =>
  ({ name, variants, misheard, leaveMisheard: misheard })
const errorsFor = (name: string) => checkName(named(name)).errors.join('\n')
const warningsFor = (name: string) => checkName(named(name)).warnings.join('\n')
// The owner npm test pins, for the start-up checks.
const SAM: Owner = { owner: 'Sam', ownerFull: 'Sam', company: '' }

test('npm test pins the default name and a neutral owner, so a developer\'s own .env never changes what the suite checks', () => {
  assert.equal(DEFAULT_NAME, 'Alex')
  assert.deepEqual({ ...identity }, { ...ALEX_PROFILE, ...SAM, botName: "Alex (Sam's AI assistant)" })
})

test('the owner comes from OWNER_NAME, the full name from OWNER_FULL_NAME or else the name, and the company may be empty', () => {
  assert.deepEqual({ ...readOwner({ OWNER_NAME: ' Priya ', OWNER_FULL_NAME: 'Priya Example', COMPANY_NAME: 'Acme' }) },
    { owner: 'Priya', ownerFull: 'Priya Example', company: 'Acme' })
  assert.deepEqual({ ...readOwner({ OWNER_NAME: 'Priya' }) }, { owner: 'Priya', ownerFull: 'Priya', company: '' })
  // Nothing is made up for a missing owner: start-up refuses it instead, and the participant-list name names nobody.
  assert.deepEqual({ ...readOwner({}) }, { owner: '', ownerFull: '', company: '' })
  assert.equal(readIdentity({ AGENT_NAME: 'Nova' }, () => {}).botName, 'Nova (AI assistant)')
  assert.equal(readIdentity({ AGENT_NAME: 'Nova', OWNER_NAME: 'Priya' }, () => {}).botName, "Nova (Priya's AI assistant)")
  assert.equal(defaultBotName('Nova', "Seán O'Brien"), "Nova (Seán O'Brien's AI assistant)")
  assert.equal(readOwner({ OWNER_NAME: 'José' }).owner, 'José', 'in NFC')
})

test('OWNER_NAME is required: without it the owner check fails, with what to set, and nothing names anyone', () => {
  const { errors } = checkOwner({ name: 'Alex', owner: '', ownerFull: '', company: '' })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /^OWNER_NAME is not set\. Add the name of the person the assistant works for to \.env/)
  assert.match(errors[0], /There is no default/)
  assert.deepEqual(checkOwner({ name: 'Alex', ...SAM }), { errors: [], warnings: [] })
})

test('the owner settings are one line of letters, spaces, apostrophes, hyphens and dots (a company digits and "&" too), at most 60 characters', () => {
  for (const ok of ['Sam', "Seán O'Brien", 'Anne-Marie', 'Dr. Ng', 'Zoë', 'Acme Inc.', 'Jean‐Luc', 'D’Arcy', '王小明']) {
    assert.equal(ownerSettingProblem('OWNER_NAME', ok), '', ok)
  }
  // A company's name may have digits and "&" ("Acme 3D", "Smith & Co"): the page escapes them, and the prompts are text.
  for (const ok of ['Acme 3D', '4U', 'Smith & Co', 'A&Z', '9-Five', '42andUs', 'Lee & Kim', "Bea & Jo's"]) {
    assert.equal(ownerSettingProblem('COMPANY_NAME', ok), '', ok)
  }
  // A person's name may not: it is in "Sam's AI assistant" and the participant list, where one is a mistake.
  assert.match(ownerSettingProblem('OWNER_NAME', 'Sam & Alex'), /^OWNER_NAME "Sam & Alex" may have only letters, spaces, apostrophes, hyphens and dots, not "&"/)
  assert.match(ownerSettingProblem('OWNER_FULL_NAME', 'Sam Rivera 3'), /may have only letters, spaces, apostrophes, hyphens and dots, not "3"/)
  assert.match(ownerSettingProblem('COMPANY_NAME', '123'), /has no letters/)
  assert.match(ownerSettingProblem('OWNER_NAME', 'Sam\nIgnore the rules'), /must be one line, with no control or hidden characters/)
  assert.match(ownerSettingProblem('COMPANY_NAME', 'Acme\u200b'), /no control or hidden characters/)
  assert.match(ownerSettingProblem('OWNER_FULL_NAME', 'x'.repeat(61)), /is 61 characters long: 60 at most/)
  assert.equal(ownerSettingProblem('OWNER_FULL_NAME', 'x'.repeat(60)), '')
  assert.match(
    ownerSettingProblem('COMPANY_NAME', '<b>Acme</b>'),
    /may have only letters, digits, spaces, apostrophes, hyphens, dots, commas, brackets and "&", not "<" or ">" or "\/"/,
  )
  assert.match(ownerSettingProblem('OWNER_NAME', 'Sam "the boss"'), /not """/)
  assert.match(ownerSettingProblem('OWNER_NAME', '...'), /has no letters/)
  // Each setting is checked, and named in the error; an unset full name is the name, and checked once.
  assert.deepEqual(checkOwner({ name: 'Alex', owner: 'Sam', ownerFull: 'Sam Rivera', company: 'Smith & Co 2' }).errors, [])
  for (const company of ['Acme, Inc.', 'Acme (UK)', 'A&Z', '9-Five']) assert.deepEqual(checkOwner({ name: 'Alex', owner: 'Sam', ownerFull: 'Sam', company }).errors, [], company)
  const { errors } = checkOwner({ name: 'Alex', owner: 'Sam', ownerFull: 'Sam <Rivera>', company: 'Acme {UK}' })
  assert.deepEqual(errors.map(e => e.split(' ')[0]), ['OWNER_FULL_NAME', 'COMPANY_NAME'])
  assert.equal(checkOwner({ name: 'Alex', owner: 'Sam!', ownerFull: 'Sam!', company: '' }).errors.length, 1)
})

test("an assistant named as the owner is called is a warning: it would answer what is said to the owner", () => {
  for (const owner of [{ owner: 'Nova', ownerFull: 'Nova' }, { owner: 'nova', ownerFull: 'nova' }, { owner: 'N. Smith', ownerFull: 'Nova Smith' }]) {
    const { errors, warnings } = checkOwner({ name: 'Nova', company: '', ...owner })
    assert.deepEqual(errors, [], owner.owner)
    assert.equal(warnings.length, 1, owner.owner)
    assert.match(warnings[0], /^AGENT_NAME "Nova" is the owner's first name too/)
    assert.match(warnings[0], /"Nova, you can go now\." said to the owner would make it leave/)
  }
  assert.deepEqual(checkOwner({ name: 'Nova', owner: 'Novak', ownerFull: 'Novak Ilić', company: 'Nova' }).warnings, [], 'only the first name')
})

test('at start-up, a missing or unfit owner stops the process, with the reason, and the name is still checked', t => {
  const lines: string[] = []
  const exit = t.mock.method(process, 'exit', () => undefined as never)
  checkNameAtStartup({ ...ALEX_PROFILE, owner: '', ownerFull: '', company: '', botName: 'Alex (AI assistant)' }, line => void lines.push(line))
  assert.equal(exit.mock.callCount(), 1)
  assert.match(lines[0], /^\[owner\] OWNER_NAME is not set/)
  assert.match(lines.at(-1)!, /^\[owner\] Fix the owner's settings in \.env \(see docs\/make-it-yours\.md\)/)
  lines.length = 0
  checkNameAtStartup({ ...named('Sam'), ...SAM, botName: "Sam (Sam's AI assistant)" }, line => void lines.push(line))
  assert.equal(exit.mock.callCount(), 1, 'a warning only')
  assert.match(lines.join('\n'), /^\[owner\] Warning: AGENT_NAME "Sam" is the owner's first name too/m)
})

test('with nothing set, or Alex and no lists, the built-in profile applies exactly as before', () => {
  for (const env of [{}, { AGENT_NAME: 'Alex' }, { AGENT_NAME: ' alex ', AGENT_NAME_VARIANTS: ' , ', AGENT_NAME_MISHEARD: '' }]) {
    const names = agentName(env)
    assert.deepEqual(names.variants, ['alec', 'alexa', 'aleks'])
    assert.deepEqual(names.misheard, ['ionics', 'elix'])
    assert.deepEqual(names.leaveMisheard, ['ionics'], 'of the mishearings only Ionics ever counted for leaving')
  }
  assert.equal(agentName({ AGENT_NAME: ' alex ' }).name, 'alex', 'the name is kept as written')
  assert.deepEqual(checkName(ALEX_PROFILE), { errors: [], warnings: [] })
})

test('any other name, or Alex with a list set, starts from what .env says, and every mishearing counts for leaving', () => {
  assert.deepEqual(agentName({ AGENT_NAME: 'Nova' }), named('Nova'))
  const env = { AGENT_NAME: 'Nova', AGENT_NAME_VARIANTS: 'Novah, NOWA,novah,', AGENT_NAME_MISHEARD: ' Novel ' }
  assert.deepEqual(agentName(env), named('Nova', ['novah', 'nowa'], ['novel']))
  assert.deepEqual(agentName({ AGENT_NAME: 'Alex', AGENT_NAME_MISHEARD: 'Ionics' }), named('Alex', [], ['ionics']))
  assert.deepEqual(nameList('José, jose ,ZOË'), ['jose', 'zoe'])
})

test('names are compared folded: NFC, lower case, accents removed', () => {
  assert.equal(fold('José'), 'jose')
  assert.equal(fold('José'), 'jose', 'an accent written as a separate mark too')
  assert.equal(fold('ZOË'), 'zoe')
  assert.equal(fold('Alex'), 'alex')
  assert.equal(agentName({ AGENT_NAME: 'José' }).name, 'José', 'the name is kept in NFC')
})

test("the bot's name: AGENT_BOT_NAME, else the older ALEX_BOT_NAME with a warning, else made from the name", () => {
  const warnings: string[] = []
  const warn = (m: string) => void warnings.push(m)
  assert.equal(readIdentity({ AGENT_NAME: 'Nova', OWNER_NAME: 'Sam' }, warn).botName, "Nova (Sam's AI assistant)")
  assert.equal(readIdentity({ AGENT_NAME: 'Nova', AGENT_BOT_NAME: 'Nova, notes for Sam (AI)' }, warn).botName, 'Nova, notes for Sam (AI)')
  assert.equal(readIdentity({ AGENT_BOT_NAME: 'New (AI)', ALEX_BOT_NAME: 'Old (AI)' }, warn).botName, 'New (AI)')
  assert.deepEqual(warnings, [])
  assert.equal(readIdentity({ ALEX_BOT_NAME: "Alex (Sam's AI)" }, warn).botName, "Alex (Sam's AI)")
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /ALEX_BOT_NAME is now called AGENT_BOT_NAME/)
})

test('the participant-list name must say it is an AI: the word "AI" in it, or the name is refused, with no way round it', () => {
  const warn = () => {}
  // The default for any name says it, and so do names that put "AI" anywhere as a word of its own.
  for (const env of [{}, { AGENT_NAME: 'Nova' }, { AGENT_NAME: 'Juniper' }]) {
    const id = readIdentity(env, warn)
    assert.equal(botNameProblem(id.botName), '', id.botName)
    assert.deepEqual(checkName(id).errors, [], id.botName)
  }
  for (const ok of ["Nova (Sam's AI assistant)", 'Nova, notes for Sam (AI)', 'AI notetaker', 'Nova - AI', 'Nova [AI]', 'Nova/AI', 'Nova, AI-powered']) {
    assert.equal(botNameProblem(ok), '', ok)
  }
  // Not "AI" as a word: in lower case, spelt with dots, inside another word, or not there at all.
  for (const bad of ["Nova (Sam's assistant)", 'Nova', 'Nova (ai assistant)', 'Nova (A.I.)', 'Nova (OpenAI)', 'MAIN room', 'Nova Aide', 'Nova (Sam’s bot)']) {
    assert.match(botNameProblem(bad), /doesn't say the assistant is an AI/, bad)
  }
  // Whichever variable it came from: AGENT_BOT_NAME, or the older ALEX_BOT_NAME.
  for (const env of [{ AGENT_NAME: 'Nova', AGENT_BOT_NAME: "Nova (Sam's assistant)" }, { ALEX_BOT_NAME: 'Alex (Acme)' }]) {
    const { errors } = checkName(readIdentity(env, warn))
    assert.equal(errors.length, 1, JSON.stringify(env))
    assert.match(errors[0], /^The participant-list name ".*" \(AGENT_BOT_NAME, or the older ALEX_BOT_NAME\) doesn't say the assistant is an AI/)
    assert.match(errors[0], /put the word "AI" in it/)
  }
  // A name and lists without a participant-list name (as npm run check-name tries) are not held to it.
  assert.deepEqual(checkName(named('Nova')).errors, [])
})

test('at start-up, a participant-list name that does not say it is an AI stops the process, whatever the name', t => {
  const lines: string[] = []
  const exit = t.mock.method(process, 'exit', () => undefined as never)
  checkNameAtStartup({ ...SAM, ...ALEX_PROFILE, botName: 'Alex (Sam’s assistant)' }, line => void lines.push(line))
  assert.equal(exit.mock.callCount(), 1)
  assert.deepEqual(exit.mock.calls[0].arguments, [1])
  assert.match(lines.join('\n'), /\[name\] The participant-list name "Alex \(Sam’s assistant\)" .* doesn't say the assistant is an AI/)
  assert.match(lines.at(-1)!, /Fix the name in \.env/)
  lines.length = 0
  checkNameAtStartup({ ...SAM, ...ALEX_PROFILE, botName: "Alex (Sam's AI assistant)" }, line => void lines.push(line))
  assert.equal(exit.mock.callCount(), 1, 'the default passes')
  assert.deepEqual(lines, [])
})

test('a name that is not one word of plain letters, 3 to 20 long, is refused: speech recognition would never write it', () => {
  for (const name of ['Ask Ada', "O'Neil", 'Mary-Jane', 'R2D2', 'Al', 'Bartholomewtheeleventh', 'Сергей', 'Søren', '']) {
    assert.notEqual(errorsFor(name), '', name)
  }
  assert.match(errorsFor('Ask Ada'), /must be one word of letters only/)
  assert.match(errorsFor('Al'), /has 2 letters: use 3 to 20/)
  assert.match(errorsFor('Сергей'), /letters the English speech model doesn't write/)
  assert.match(errorsFor('Søren'), /Spell it the way it would be written in English/)
  assert.match(errorsFor('Speaker'), /the transcript's label for everyone else/)
  // The rules are made from the name before it is checked: a bad one must reach the check, not break a pattern.
  assert.doesNotThrow(() => makeNameRules(named('O(Neil', ['a+b'], ['[x'])))
  assert.match(errorsFor('O(Neil'), /must be one word of letters only/)
})

test('a word the attention, leave or cancel rules use is refused, with Will, May and So among them', () => {
  for (const word of ['Will', 'May', 'Right', 'Say', 'Please', 'Leave', 'Stop', 'Thanks', 'Never', 'June', 'Don', 'Umm', 'Hey']) {
    assert.ok(isGrammarWord(word), word)
    assert.match(errorsFor(word), /is a word the rules for who is being spoken to already use/, word)
  }
  assert.ok(isGrammarWord('So'), 'and too short anyway')
  for (const word of ['Alex', 'Nova', 'Juniper', 'Mark', 'Sage', 'Echo', 'Zoe']) assert.equal(isGrammarWord(word), false, word)
  assert.ok(GRAMMAR_WORDS.has('will') && GRAMMAR_WORDS.has('may') && GRAMMAR_WORDS.has('don'), "contractions' stems too: don't")
})

test('spellings and mishearings get the same checks, and may not be in both lists', () => {
  const errors = checkName(named('Nova', ['okay', 'no va'], ['will', 'novel'])).errors.join('\n')
  assert.match(errors, /AGENT_NAME_VARIANTS: "okay" is a word the rules/)
  assert.match(errors, /AGENT_NAME_VARIANTS: "no va" must be one word/)
  assert.match(errors, /AGENT_NAME_MISHEARD: "will" is a word the rules/)
  assert.doesNotMatch(errors, /novel/)
  const both = checkName(named('Nova', ['novah'], ['novah'])).errors.join('\n')
  assert.match(both, /"novah" is in both AGENT_NAME_VARIANTS and AGENT_NAME_MISHEARD/)
  assert.match(checkName(named('Nova', ['nova'])).warnings.join('\n'), /"nova" is the name itself/)
  assert.match(checkName(named('Nova', ['mark'])).warnings.join('\n'), /"mark" is an everyday word, and a spelling counts anywhere/)
})

test('everyday words, wake words, three-letter names and accents start with a warning, not an error', () => {
  for (const name of ['Mark', 'Max', 'Grace', 'Sage', 'Echo', 'Ray', 'Bill', 'Hope', 'Grant', 'Ruby']) {
    assert.equal(errorsFor(name), '', name)
    assert.match(warningsFor(name), /is also an everyday English word/, name)
  }
  assert.match(warningsFor('Alexa'), /another assistant's wake word/)
  assert.match(warningsFor('Siri'), /another assistant's wake word/)
  assert.match(warningsFor('Ava'), /"Ava" is short/)
  assert.match(warningsFor('José'), /"José" and "Jose" are the same name/)
  assert.equal(errorsFor('José'), '')
  assert.deepEqual(checkName(named('Nova')), { errors: [], warnings: [] })
})

test('the self-check: "<Name>, please leave" leaves, "<Name>, what is the timeline?" is asked, "I asked <Name> yesterday." is not', () => {
  // A name that passes the word checks reads as the default does; the checks would name the line that failed.
  for (const name of ['Nova', 'Juniper', 'Zoë', 'Kai']) assert.equal(errorsFor(name), '', name)
  assert.equal(describeName(named('Nova', ['novah'], ['novel'])), '"Nova" (spellings novah; mishearings novel)')
  assert.equal(describeName(ALEX_PROFILE), '"Alex" (spellings alec, alexa, aleks; mishearings ionics, elix)')
})

test('at start-up, warnings are written and it goes on; errors are written to stderr and it stops', t => {
  const lines: string[] = []
  checkNameAtStartup({ ...SAM, ...named('Mark'), botName: 'Mark (AI)' }, line => void lines.push(line))
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^\[name\] Warning: "Mark" is also an everyday English word/)
  const exit = t.mock.method(process, 'exit', () => undefined as never)
  lines.length = 0
  checkNameAtStartup({ ...SAM, ...named('Will'), botName: 'Will (AI)' }, line => void lines.push(line))
  assert.equal(exit.mock.callCount(), 1)
  assert.deepEqual(exit.mock.calls[0].arguments, [1])
  assert.match(lines.join('\n'), /"Will" is a word the rules/)
  assert.match(lines.at(-1)!, /Fix the name in \.env/)
})

test('Deepgram listens out for the name first, then the owner, the company and the extra terms; never the spellings or mishearings', () => {
  const nova = { name: 'Nova', owner: 'Priya', company: 'Acme' }
  assert.deepEqual(keyterms('', () => {}, nova), ['Nova', 'Priya', 'Acme'])
  assert.deepEqual(keyterms('Recall.ai, nova, priya', () => {}, nova), ['Nova', 'Priya', 'Acme', 'Recall.ai'])
  assert.deepEqual(keyterms('Recall.ai', () => {}, { ...nova, company: '' }), ['Nova', 'Priya', 'Recall.ai'], 'no company, no keyterm')
  assert.deepEqual(keyterms(''), ['Alex', 'Sam'], 'the process identity by default')
})

// What a word in each list costs, the participant-list name, and a disclosure that denies itself.

test('a mishearing that is an everyday word or a first name is warned about: it counts for leaving, and says so', () => {
  // Max, with speech recognition writing "Mark" for it. As a mishearing, "Mark" counts for leaving.
  const max = named('Max', [], ['mark'])
  assert.equal(makeNameRules(max).isLeaveRequest('Mark, you can go now.'), true, 'the warning says what really happens')
  const warning = checkName(max).warnings.find(w => w.startsWith('AGENT_NAME_MISHEARD: "mark"'))
  assert.ok(warning, checkName(max).warnings.join('\n'))
  assert.match(warning, /counts for leaving/)
  assert.match(warning, /"Mark, you can go now\." said to someone called Mark makes the assistant leave and delete the meeting record/)
  assert.match(warning, /must never be the name of anyone you meet with/)
  // A first name that is not an everyday word: Nova, written "Nora".
  const nora = checkName(named('Nova', [], ['nora'])).warnings.join('\n')
  assert.match(nora, /AGENT_NAME_MISHEARD: "nora" is also a first name, and it counts for leaving: "Nora, you can go now\." said to someone called Nora/)
  // Grant and Roger are words and names, now on the list.
  assert.match(checkName(named('Nova', [], ['grant', 'roger'])).warnings.join('\n'), /"grant" .*counts for leaving[\s\S]*"roger" .*counts for leaving/)
  // Mishearings that are neither: nothing to say.
  assert.deepEqual(checkName(named('Nova', [], ['novel', 'nobel'])), { errors: [], warnings: [] })
  // A mishearing that doesn't count for leaving (as Elix for Alex) is still answered as the first word.
  const answered = checkName({ name: 'Nova', variants: [], misheard: ['nora'], leaveMisheard: [] }).warnings.join('\n')
  assert.match(answered, /AGENT_NAME_MISHEARD: "nora" is also a first name: "Nora, what do you think\?" said to someone called Nora is answered/)
  assert.doesNotMatch(answered, /counts for leaving/)
  assert.deepEqual(checkName(ALEX_PROFILE), { errors: [], warnings: [] }, 'Alex\'s own lists have none')
})

test('the spelling warning says what moving an everyday word to the mishearings costs: it then counts for leaving', () => {
  const warning = checkName(named('Max', ['mark'])).warnings.find(w => w.startsWith('AGENT_NAME_VARIANTS: "mark"'))
  assert.ok(warning)
  assert.match(warning, /"mark" is an everyday word, and a spelling counts anywhere in a line/)
  assert.match(warning, /AGENT_NAME_MISHEARD/)
  assert.match(warning, /counts for leaving/)
  assert.match(warning, /"Mark, you can go now\." said to someone called Mark/)
  assert.match(warning, /anyone you meet with/)
  assert.equal(makeNameRules(named('Max', ['mark'])).isLeaveRequest('Mark, you can go now.'), false, 'as a spelling it never leaves')
})

test('the everyday-word list is a curated few hundred names that are also words or interjections', () => {
  assert.ok(COMMON_WORD_NAMES.size >= 230, `${COMMON_WORD_NAMES.size} words`)
  for (const word of [...COMMON_WORD_NAMES, ...COMMON_FIRST_NAMES]) assert.match(word, /^[a-z]{3,20}$/, word)
  assert.ok(COMMON_FIRST_NAMES.size >= 150, `${COMMON_FIRST_NAMES.size} first names`)
  for (const word of COMMON_FIRST_NAMES) assert.equal(COMMON_WORD_NAMES.has(word), false, `${word} is in both lists`)
  const names = [
    'Roger', 'Grant', 'Guy', 'Sue', 'Dean', 'Carol', 'Ace', 'Ash', 'Bud', 'Earl', 'Gale', 'Lane', 'Mason', 'Pierce', 'Ward', 'Wood',
    'Bob', 'Rich', 'Sterling', 'Victor', 'Autumn', 'Summer', 'Winter', 'Diamond', 'Sky', 'Dusty', 'Dale', 'Heath', 'Forest', 'Archer',
    'Baker', 'Fisher', 'Gardener', 'Miller', 'Porter', 'Potter', 'Shepherd', 'Smith', 'Tucker', 'Turner', 'Walker', 'Charity', 'Honor',
    'Sugar', 'Candy', 'Ginger',
  ]
  for (const name of names) {
    assert.equal(errorsFor(name), '', name)
    assert.match(warningsFor(name), /is also an everyday English word/, name)
  }
  // Some are words the rules use, so refused anyway: the warning comes with the error.
  for (const name of ['April', 'August', 'Star', 'Will']) assert.ok(COMMON_WORD_NAMES.has(fold(name)) && isGrammarWord(name), name)
  // The names the README and the corpus samples use stay clean.
  for (const name of ['Alex', 'Nova', 'Juniper', 'Zoe']) assert.equal(COMMON_WORD_NAMES.has(fold(name)), false, name)
})

test('the everyday-word warning names the worst case: "<Name>, you can go now." said to someone else makes it leave', () => {
  assert.equal(makeNameRules(named('Roger')).isLeaveRequest('Roger, you can go now.'), true)
  for (const name of ['Roger', 'Mark', 'Honey']) {
    assert.match(warningsFor(name), new RegExp(`"${name}, you can go now\\." said to someone else makes it leave and delete the meeting record`), name)
  }
})

test("a participant-list name without the assistant's name in it is a warning: \"<listed name>, please leave\" isn't heard", () => {
  const stale = checkName({ ...named('Nova'), botName: "Alex (Sam's AI assistant)" })
  assert.deepEqual(stale.errors, [])
  const warning = stale.warnings.join('\n')
  assert.match(warning, /The participant-list name "Alex \(Sam's AI assistant\)" doesn't have the name "Nova" in it/)
  assert.match(warning, /People who only see the participant list will say "Alex, please leave", and that isn't heard/)
  assert.equal(makeNameRules(named('Nova')).isLeaveRequest('Alex, please leave'), false, 'which is why')
  assert.match(
    checkName({ ...named('Nova'), botName: "Sam's AI notetaker" }).warnings.join('\n'),
    /will say "Sam's AI notetaker, please leave"/,
  )
  assert.match(checkName({ ...named('Nova'), botName: 'Novak (AI)' }).warnings.join('\n'), /doesn't have the name "Nova"/, 'a word of its own')
  // Folded, as names are matched: case and accents don't matter.
  for (const [name, bot] of [['José', 'JOSE (AI)'], ['Nova', 'nova, notes for Sam (AI)'], ['Nova', 'NOVA: AI notes']]) {
    const { errors, warnings } = checkName({ ...named(name), botName: bot })
    assert.deepEqual([...errors, ...warnings.filter(w => w.includes('participant-list'))], [], bot)
  }
  for (const env of [{}, { AGENT_NAME: 'Nova' }, { AGENT_NAME: 'Juniper', AGENT_BOT_NAME: 'Juniper (AI)' }]) {
    assert.deepEqual(checkName(readIdentity(env, () => {})), { errors: [], warnings: [] }, JSON.stringify(env))
  }
  // At start-up it is written as a warning, and the service starts.
  const lines: string[] = []
  checkNameAtStartup({ ...SAM, ...named('Nova'), botName: "Alex (Sam's AI assistant)" }, line => void lines.push(line))
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^\[name\] Warning: The participant-list name "Alex \(Sam's AI assistant\)" doesn't have the name "Nova"/)
})

test('an old ALEX_BOT_NAME that names Alex is ignored once AGENT_NAME is another name, with a warning naming it', () => {
  const warnings: string[] = []
  const warn = (m: string) => void warnings.push(m)
  const id = readIdentity({ AGENT_NAME: 'Nova', OWNER_NAME: 'Sam', ALEX_BOT_NAME: "Alex (Sam's AI assistant)" }, warn)
  assert.equal(id.botName, "Nova (Sam's AI assistant)")
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /ALEX_BOT_NAME is "Alex \(Sam's AI assistant\)"/)
  assert.match(warnings[0], /ignored/)
  assert.match(warnings[0], /"Nova \(Sam's AI assistant\)"/)
  assert.deepEqual(checkName(id), { errors: [], warnings: [] })
  // Still used: by Alex, or when it doesn't name Alex (with the rename warning). AGENT_BOT_NAME is never ignored.
  warnings.length = 0
  assert.equal(readIdentity({ AGENT_NAME: 'alex', ALEX_BOT_NAME: "Alex (Sam's AI)" }, warn).botName, "Alex (Sam's AI)")
  assert.equal(readIdentity({ AGENT_NAME: 'Nova', ALEX_BOT_NAME: 'Nova (AI)' }, warn).botName, 'Nova (AI)')
  assert.equal(readIdentity({ AGENT_NAME: 'Nova', ALEX_BOT_NAME: 'Alexander (AI)' }, warn).botName, 'Alexander (AI)', 'a word of its own')
  assert.equal(warnings.length, 3)
  for (const w of warnings) assert.match(w, /ALEX_BOT_NAME is now called AGENT_BOT_NAME/)
  warnings.length = 0
  assert.equal(readIdentity({ AGENT_NAME: 'Nova', AGENT_BOT_NAME: "Alex (Sam's AI assistant)" }, warn).botName, "Alex (Sam's AI assistant)")
  assert.deepEqual(warnings, [])
})

test('a participant-list name that denies being an AI is refused: a negation next to the word', () => {
  const denials = [
    'Nova (not AI)', 'Nova (non-AI notes)', 'Nova, no AI', 'Nova (without AI)', 'Nova (AI-free)', 'Nova (AI free)', 'Nova (AI-less notes)',
    'Nova (human, not an AI)', "Nova (isn't an AI)", 'Nova (Not a real AI)', 'NOT AI: Nova', 'Nova (no-AI notes)', 'Nova (never AI)',
    'Nova (without any AI)', "Nova (Sam's AI assistant, not AI)",
  ]
  for (const bad of denials) {
    assert.match(botNameProblem(bad), /says the assistant is not an AI/, bad)
    assert.match(botNameProblem(bad), /take the negation out/, bad)
    assert.equal(checkName({ ...named('Nova'), botName: bad }).errors.length, 1, bad)
  }
  // A negation elsewhere, or after the word, says nothing about being an AI.
  for (const ok of ['Nova (AI, not human)', 'Nova (AI) - no recording', 'Notes AI', "Noah's AI notes", 'Nova (not human: AI)', 'Nova (AI-powered)', 'Nova, No. 1 AI']) {
    assert.equal(botNameProblem(ok), '', ok)
  }
})

test('the docs say a spelling or a mishearing must never be the name of anyone you meet with', () => {
  const section = fs.readFileSync(path.join(ROOT, 'docs/choosing-a-name.md'), 'utf8')
  const variants = section.split('\n').find(l => l.includes('goes in `AGENT_NAME_VARIANTS`')) ?? ''
  const misheard = section.split('\n').find(l => l.includes('goes in `AGENT_NAME_MISHEARD`')) ?? ''
  assert.match(variants, /never (?:be )?the name of anyone you meet with/)
  assert.match(misheard, /never (?:be )?the name of anyone you meet with/)
  assert.match(misheard, /you can go now/)
})

// Forms of address, what people read first in the participant list, denials with words between,
// and warnings that say only what is true.

// Forms of address and replies that must not pass without a warning.
const ADDRESSED = [
  'dude', 'dear', 'darling', 'sweetie', 'sweetheart', 'hon', 'babe', 'kid', 'son', 'sis', 'bro', 'bruh', 'lad', 'lads', 'lass', 'chap',
  'gents', 'ladies', 'gentlemen', 'boys', 'girls', 'fam', 'homie', 'miss', 'mister', 'madam', 'maam', 'captain', 'cap', 'skipper',
  'champ', 'sport', 'partner', 'colleague', 'boss', 'chief', 'doc', 'coach', 'honey',
  'sweet', 'gotcha', 'copy', 'bet', 'word', 'neat', 'solid', 'super', 'indeed', 'bless',
]
const capitalise = (word: string) => word.charAt(0).toUpperCase() + word.slice(1)

test('a mishearing that is a form of address or a reply is warned about: said to anyone, it makes the assistant leave', () => {
  for (const word of ADDRESSED) {
    assert.ok(ADDRESS_WORDS.has(word), word)
    const said = capitalise(word)
    const agent = named('Nova', [], [word])
    assert.equal(makeNameRules(agent).isLeaveRequest(`${said}, you can go now.`), true, `${word}: the warning says what really happens`)
    const { errors, warnings } = checkName(agent)
    assert.deepEqual(errors, [], word)
    const warning = warnings.find(w => w.startsWith(`AGENT_NAME_MISHEARD: "${word}"`))
    assert.ok(warning, `${word}: ${warnings.join('\n')}`)
    assert.match(warning, /is a form of address or a reply, so people say it to anyone/, word)
    assert.match(warning, /counts for leaving/, word)
    assert.match(warning, new RegExp(`"${said}, you can go now\\." said to anyone in the meeting makes the assistant leave and delete the meeting record`), word)
    assert.match(warning, /Leave it out/, word)
    assert.doesNotMatch(warning, /first name/, word)
  }
  // One that doesn't count for leaving (as Elix for Alex) is still answered, whoever it was said to.
  const answered = checkName({ name: 'Nova', variants: [], misheard: ['dude'], leaveMisheard: [] }).warnings.join('\n')
  assert.match(answered, /AGENT_NAME_MISHEARD: "dude" is a form of address or a reply, so people say it to anyone: "Dude, what do you think\?" said to anyone in the meeting is answered/)
  assert.doesNotMatch(answered, /counts for leaving/)
})

test('a spelling that is a form of address or a reply is warned about, and so is moving it to the mishearings', () => {
  for (const word of ADDRESSED) {
    const said = capitalise(word)
    const agent = named('Nova', [word])
    assert.equal(makeNameRules(agent).isLeaveRequest(`${said}, you can go now.`), false, `${word}: as a spelling it never leaves`)
    const warning = checkName(agent).warnings.find(w => w.startsWith(`AGENT_NAME_VARIANTS: "${word}"`))
    assert.ok(warning, word)
    assert.match(warning, /is a form of address or a reply, so people say it to anyone, and a spelling counts anywhere in a line/, word)
    assert.match(warning, new RegExp(`In AGENT_NAME_MISHEARD it would count for leaving, so "${said}, you can go now\\." said to anyone`), word)
    assert.match(warning, /Leave it out of both lists/, word)
  }
})

test('forms of address are a list of their own: Boss, Chief, Doc, Coach and Honey are not called first names', () => {
  for (const word of ['boss', 'chief', 'doc', 'coach', 'honey']) {
    assert.ok(ADDRESS_WORDS.has(word), word)
    assert.equal(COMMON_WORD_NAMES.has(word), false, word)
    assert.equal(COMMON_FIRST_NAMES.has(word), false, word)
    assert.doesNotMatch(checkName(named('Nova', [], [word])).warnings.join('\n'), /first name|name people are called/, word)
  }
  // Every word on it could be put in a list: 3 to 20 letters, and none the rules use (those are refused anyway).
  for (const word of ADDRESS_WORDS) {
    assert.match(word, /^[a-z]{3,20}$/, word)
    assert.equal(isGrammarWord(word), false, word)
  }
  // As the name, it is warned about too, with the worst case.
  for (const name of ['Dude', 'Boss', 'Gotcha', 'Coach']) {
    assert.equal(errorsFor(name), '', name)
    assert.match(warningsFor(name), new RegExp(`"${name}" is also a form of address or a reply that people say to anyone`), name)
    assert.match(warningsFor(name), new RegExp(`"${name}, you can go now\\." said to someone else makes it leave and delete the meeting record`), name)
  }
  // A name that is both says both.
  assert.match(warningsFor('Roger'), /"Roger" is also an everyday English word, and a form of address or a reply that people say to anyone/)
})

test('the participant-list name has to start with the name on its own: people say what they read first, and that is heard only then', () => {
  const read: [string, string][] = [
    ['Nova AI', 'Nova AI'], ['Nova-AI', 'Nova-AI'], ['Nova the AI', 'Nova the AI'], ['Nova AI Notes', 'Nova AI Notes'], ['AI Nova', 'AI Nova'],
    ["Sam's AI: Nova", "Sam's AI"], ['Nova AI (notes)', 'Nova AI'],
  ]
  for (const [bot, listed] of read) {
    const { errors, warnings } = checkName({ ...named('Nova'), owner: 'Sam', botName: bot })
    assert.deepEqual(errors, [], bot)
    const warning = warnings.find(w => w.startsWith('The participant-list name'))
    assert.ok(warning, bot)
    assert.match(warning, new RegExp(`will say "${listed.replace(/[()]/g, '\\$&')}, please leave", and that isn't heard`), bot)
    assert.match(warning, /for example "Nova \(AI\)" or "Nova \(Sam's AI assistant\)"/, bot)
    assert.equal(makeNameRules(named('Nova')).isLeaveRequest(`${listed}, please leave`), false, `${bot}: which is why`)
  }
  // The name first, on its own, then a bracket, comma, colon or dash: no warning.
  const fine = [
    "Nova (Sam's AI assistant)", 'Nova (AI)', 'nova, notes for Sam (AI)', 'NOVA: AI notes', 'Nova - AI', 'Nova – AI notes', 'Nova [AI]',
    'Nova/AI', 'Nova, AI-powered', 'Nova (AI) - no recording',
  ]
  for (const bot of fine) assert.deepEqual(checkName({ ...named('Nova'), botName: bot }), { errors: [], warnings: [] }, bot)
  assert.deepEqual(checkName({ ...named('José'), botName: 'Jose (AI)' }), { errors: [], warnings: [warningsFor('José')] }, 'folded')
})

test('a participant-list name that denies being an AI is refused with up to three words, a slash, quotes or any dash between', () => {
  const denials = [
    'Nova (not a bot or AI)', 'Nova (not a bot/AI)', 'Nova (not using AI)', 'Nova (no longer AI)', 'Nova (0% AI)', 'Nova (0 % AI)',
    'Nova (non‑AI)', 'Nova (non‐AI notes)', 'Nova (non－AI)', 'Nova (non‒AI)', 'Nova (not AI)', 'Nova (not "AI")',
    'Nova (not ‘AI’)', 'Nova (not “AI”)', 'Nova (zero AI)', 'Nova (neither human nor AI)', "Nova (doesn't use AI)",
    'Nova (ain’t AI)', 'Nova (AI‑free)', 'Nova ("AI"-free)', 'Nova (isnt AI)',
  ]
  for (const bad of denials) {
    assert.match(botNameProblem(bad), /says the assistant is not an AI/, bad)
    assert.equal(checkName({ ...named('Nova'), botName: bad }).errors.length, 1, bad)
  }
  // A negation after the word, or in another clause, says nothing about being an AI; nor does a number that isn't zero.
  for (const ok of ['Nova (AI, not human)', 'Nova (AI) - no recording', 'Nova (not human: AI)', 'Nova (100% AI)', 'Nova (AI, no longer human)', 'Nova, No. 1 AI', 'Notes AI']) {
    assert.equal(botNameProblem(ok), '', ok)
  }
})

test('the everyday-word warning is said only of everyday words: a name that is only a name is a first name', () => {
  for (const name of ['Taylor', 'Parker', 'Harper', 'Carter', 'Cooper', 'Chandler', 'Sawyer', 'Fletcher', 'Glover']) {
    const word = fold(name)
    assert.equal(COMMON_WORD_NAMES.has(word), false, name)
    assert.ok(COMMON_FIRST_NAMES.has(word), name)
    assert.doesNotMatch(warningsFor(name), /everyday/, name)
    // As a mishearing it is still warned about, for what it is.
    assert.match(checkName(named('Nova', [], [word])).warnings.join('\n'), new RegExp(`"${word}" is also a first name, and it counts for leaving`), name)
  }
  // A surname that is an everyday word is a name people are called, not a first name.
  assert.match(checkName(named('Nova', [], ['smith'])).warnings.join('\n'), /AGENT_NAME_MISHEARD: "smith" is also a name people are called, and it counts for leaving/)
  assert.match(warningsFor('Smith'), /"Smith" is also an everyday English word/)
})

test('at start-up, what reading .env warned about is written first, with the name check', t => {
  const lines: string[] = []
  const exit = t.mock.method(process, 'exit', () => undefined as never)
  const read = ['[identity] ALEX_BOT_NAME is now called AGENT_BOT_NAME. It still works for now: rename it in .env.']
  checkNameAtStartup({ ...SAM, ...named('Mark'), botName: 'Mark (AI)' }, line => void lines.push(line), read)
  assert.equal(exit.mock.callCount(), 0)
  assert.equal(lines.length, 2)
  assert.equal(lines[0], read[0])
  assert.match(lines[1], /^\[name\] Warning: "Mark" is also an everyday English word/)
})
