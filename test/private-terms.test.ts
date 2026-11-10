// Nothing private stays in the tree. Two checks, over every file git would commit (README included):
// - always: patterns that say nothing about anyone, such as a macOS home folder, a link into a claude.ai account or
//   an email address;
// - when you have one: your own list of private terms (your name, company, hostnames, accounts), which lives
//   outside the repository (PRIVATE_TERMS_FILE, else a gitignored private-terms.txt here). Without one, that check
//   is skipped, with a note saying how to add one. See test/private-terms.ts for the list's format.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT } from '../src/config.ts'
import {
  GENERIC_TERMS, PUBLIC_ADDRESSES, NO_LIST_NOTE, decode, findTerms, loadPrivateTerms, offenders, parseList, parseTermList, privateTermsFile,
  trackedFiles,
} from './private-terms.ts'

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'av-terms-'))
process.on('exit', () => fs.rmSync(DIR, { recursive: true, force: true }))

const FILES = trackedFiles()
const LIST = loadPrivateTerms()

test('a list has one term or /regex/ per line, with # comments; a plain term is a whole word in any case', () => {
  const terms = parseTermList(
    ['# made-up terms', '', 'Zorblax', '  qux.example.invalid  ', 'Mega Corp', '/blorp-?\\d+/', '# /not a term/'].join('\n'),
    'list.txt',
  )
  assert.deepEqual(terms.map(t => t.label), ['Zorblax', 'qux.example.invalid', 'Mega Corp', '/blorp-?\\d+/'])
  const hits = (text: string) => findTerms(text, terms)
  assert.deepEqual(hits('Ask ZORBLAX, or zorblax\'s team.'), ['ZORBLAX'])
  assert.deepEqual(hits('Zorblaxes and Zorblaxian are other words, and so is qux.example.invalidated'), [])
  assert.deepEqual(hits('see https://qux.example.invalid/x'), ['qux.example.invalid'])
  assert.deepEqual(hits('quxXexampleXinvalid'), [], 'a dot is a dot, not any character')
  assert.deepEqual(hits('at mega  corp today'), ['mega  corp'], 'a space is any run of spaces')
  assert.deepEqual(hits('megacorp'), [])
  assert.deepEqual(hits('BLORP42 and blorp-7'), ['BLORP42'], 'a regex, in any case: one hit per term and line')
  assert.throws(() => parseTermList('ok\n/(unclosed/\n', 'list.txt'), /list\.txt:2: "\/\(unclosed\/" is not a valid regular expression/)
})

test('a regular expression takes Unicode escapes and no flags: a line with flags is an error, not a term that never matches', () => {
  assert.deepEqual(findTerms('ask Zorblax now', parseTermList('/\\p{Lu}orblax/', 'list.txt')), ['Zorblax'], '\\p{...} works')
  assert.throws(() => parseTermList('/zorblax/i', 'list.txt'), /list\.txt:1: "\/zorblax\/i" ends in "\/i": a regular expression here takes no flags/)
  assert.throws(() => parseTermList('/srv/zorb', 'list.txt'), /takes no flags .* a path with its slashes escaped/, 'a path reads as /srv/ with flags')
  assert.deepEqual(findTerms('see /srv/zorb/x', parseTermList('/\\/srv\\/zorb/', 'list.txt')), ['/srv/zorb'])
  assert.throws(() => parseTermList('/zorb\\-x/', 'list.txt'), /not a valid regular expression \(with Unicode escapes\)/, 'u mode refuses a needless escape')
})

test('terms are found however the text hides them: decomposed accents, invisible characters, \\u escapes', () => {
  const terms = parseTermList('José\nZorblax\nMega Corp\n/jos\u0065\u0301 q/', 'list.txt')
  assert.deepEqual(findTerms('ask Jose\u0301 today', terms), ['José'], 'NFD, as macOS file names have it')
  assert.deepEqual(findTerms('ask José Q today', terms), ['José', 'José Q'], 'a regex written decomposed matches composed text')
  assert.deepEqual(findTerms('Zor\u00ADblax and Zorb\u200Blax', terms), ['Zorblax'])
  for (const hidden of ['\u200E', '\u034F', '\u2062', '\uFE0F', '\u202E']) assert.deepEqual(findTerms(`Zorb${hidden}lax`, terms), ['Zorblax'], `U+${hidden.codePointAt(0)?.toString(16)}`)
  assert.deepEqual(findTerms('word\u200BZorblax', terms), ['Zorblax'], 'an invisible character between two words is a space too')
  assert.deepEqual(findTerms('{"owner": "Zorbl\\u0061x"}', terms), ['Zorblax'], 'as JSON escapes it')
  assert.deepEqual(findTerms('{"owner": "Jose\\u0301"}', terms), ['José'], 'an escaped decomposed accent')
  assert.deepEqual(findTerms('{"owner": "Jos\\u00e9"}', terms), ['José'])
  assert.deepEqual(findTerms('ZORBLAX_API_KEY and zorblax_prod', terms), [], 'an underscore joins words, by design')
})

test('a file with NUL bytes is UTF-16 with a byte order mark, else the runs of text in it, in any encoding and offset', () => {
  const terms = parseTermList('Zorblax\nJosé', 'list.txt')
  assert.deepEqual(decode(Buffer.from('plain text')), { text: 'plain text', binary: false })
  assert.deepEqual(decode(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Zorblax', 'utf16le')])), { text: 'Zorblax', binary: false })
  assert.deepEqual(decode(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('Zorblax', 'utf16le').swap16()])), { text: 'Zorblax', binary: false })
  const found = (bytes: Buffer) => {
    const { text, binary } = decode(bytes)
    assert.equal(binary, true)
    return [...new Set(text.split('\n').flatMap(line => findTerms(line, terms)))]
  }
  const zeros = (size: number, at: number, data: Buffer) => { const b = Buffer.alloc(size); data.copy(b, at); return b }
  const ascii = Buffer.from('Author: Zorblax')
  assert.deepEqual(found(zeros(4096, 3000, ascii)), ['Zorblax'], 'ASCII at an even offset in a zero-padded binary')
  assert.deepEqual(found(zeros(4096, 3001, ascii)), ['Zorblax'], 'and at an odd one')
  assert.deepEqual(found(Buffer.from('owner: Zorblax\n', 'utf16le')), ['Zorblax'], 'UTF-16LE with no byte order mark')
  assert.deepEqual(found(Buffer.concat([Buffer.from([0]), Buffer.from('owner: Zorblax', 'utf16le')])), ['Zorblax'], 'at an odd offset')
  assert.deepEqual(found(Buffer.from('owner: Zorblax', 'utf16le').swap16()), ['Zorblax'], 'UTF-16BE with no byte order mark')
  assert.deepEqual(found(Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('name: José Q')])), ['José'], 'UTF-8 after NUL bytes')
})

test('random bytes are not taken for an email address or a home folder, so an image or an archive passes the always-on check', () => {
  // A fixed pseudo-random sequence, so the test is the same every run: 4 MiB, NUL bytes included.
  let seed = 0x2f6b3a1d
  const bytes = Buffer.alloc(4 * 1024 * 1024)
  for (let i = 0; i < bytes.length; i++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
    bytes[i] = seed & 0xff
  }
  const { text } = decode(bytes)
  assert.deepEqual(text.split('\n').flatMap(line => findTerms(line, GENERIC_TERMS)), [])
  assert.deepEqual(findTerms('fips140@v1.0.0, o@5.1, kJ@gD.kJ and E@tEA.EA', GENERIC_TERMS), [], 'not a domain')
  assert.deepEqual(findTerms('mail sam.r' + '@zorblax-qux.co.uk.', GENERIC_TERMS).length, 1, 'a real address at the end of a sentence still counts')
})

test('the check covers what a commit takes: names, links, staged copies, deleted files, UTF-16, binaries, wrapped names', { skip: spawnSync('git', ['--version']).error ? 'no git' : false }, () => {
  const repo = fs.mkdtempSync(path.join(DIR, 'repo-'))
  // git for the throwaway repository only: none of the GIT_ variables a hook running this suite may have (GIT_INDEX_FILE
  // names the outer commit's index), no user or system config, and no repository above the temporary folder.
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  Object.assign(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: DIR })
  const git = (...args: string[]) => {
    const run = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: repo, env, encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
  }
  const write = (file: string, data: string | Buffer) => fs.writeFileSync(path.join(repo, file), data)
  git('init', '-q')
  write('.gitignore', 'ignored.txt\n')
  write('ignored.txt', 'Zorblax\n')
  write('clean.md', 'Nothing here.\nCopyright 2026 Zorblax Ltd\n')
  write('notes.md', 'Ask Zorblax.\n')
  write('Zorblax-plan.md', 'Nothing here.\n')
  fs.symlinkSync('/Us' + 'ers/zorblax/secrets', path.join(repo, 'link'))
  write('wide.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('owner: Zorblax\n', 'utf16le')]))
  write('image.bin', Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from('Author: Zorblax')]))
  write('wrapped.md', 'Thanks to Mega\nCorp for this.\n')
  write('wrapped.ts', '// Thanks to Mega\n// Corp for this.\n/**\n * Ask Mega\n * Corp.\n */\n# Mega\n# Corp\n> Mega\n> Corp\n')
  write('staged.md', 'Zorblax\n')
  write('gone.md', 'Zorblax\n')
  git('add', '-A')
  write('staged.md', 'Nothing here now.\n') // the index still has the term, and a commit takes the index
  fs.rmSync(path.join(repo, 'gone.md')) // so does a file deleted from the work tree but not from the index

  const files = trackedFiles(repo, env) ?? []
  assert.ok(!files.includes('ignored.txt'), 'an ignored file is never committed')
  for (const file of ['link', 'gone.md', 'staged.md', 'image.bin']) assert.ok(files.includes(file), file)
  const list = parseList('Zorblax\nMega Corp\n!Copyright 2026 Zorblax Ltd', 'list.txt')
  const found = offenders(files, list.terms, list.allowed, repo, env).sort()
  const at = (prefix: string) => found.filter(hit => hit.startsWith(prefix))
  assert.deepEqual(at('clean.md'), [], 'the allowed line passes')
  assert.equal(at('notes.md:1 "Zorblax"').length, 1)
  assert.equal(at('Zorblax-plan.md (its name) "Zorblax"').length, 1)
  assert.equal(at('link:1 "zorblax"').length, 1, "a link's target")
  assert.equal(at('wide.txt:1 "Zorblax"').length, 1)
  assert.equal(at('wrapped.md:1 "Mega Corp": across lines').length, 1)
  assert.deepEqual(at('wrapped.ts').map(hit => hit.split(' ')[0]), ['wrapped.ts:1', 'wrapped.ts:4', 'wrapped.ts:7', 'wrapped.ts:9'], 'in comments and quotes')
  assert.equal(at('staged.md (staged):1 "Zorblax"').length, 1)
  assert.equal(at('staged.md:').length, 0, 'the work tree copy is clean')
  assert.equal(at('gone.md (staged):1 "Zorblax"').length, 1)
  assert.equal(at('image.bin (text in a binary):').length, 1)
  assert.deepEqual(offenders(['link'], GENERIC_TERMS, [], repo, env).length, 1, 'the always-on patterns read link targets too')
  assert.equal(trackedFiles(fs.mkdtempSync(path.join(DIR, 'not-a-repo-')), env), null, 'not a git checkout')
})

test('a "!" line is a whole line that may stay, exactly as written: every other line is still checked', () => {
  const list = parseList(['/zorblax/', 'Mega Corp', '!Copyright 2026 Zorblax Ltd', '  !  Mega Corp   Inc.  '].join('\n'), 'list.txt')
  assert.deepEqual(list.terms.map(t => t.label), ['/zorblax/', 'Mega Corp'], 'an allowance is not a term')
  const hits = (line: string) => findTerms(line, list.terms, list.allowed)
  assert.deepEqual(hits('Copyright 2026 Zorblax Ltd'), [])
  assert.deepEqual(hits('   Copyright 2026  Zorblax Ltd  '), [], 'spaces at either end and runs of spaces aside')
  assert.deepEqual(hits('Mega Corp Inc.'), [])
  // Anything more on the line, or less, is checked: an allowance never hides the rest of a line.
  assert.deepEqual(hits("Zorblax Ltd's internal pricing"), ['Zorblax'])
  assert.deepEqual(hits('Copyright 2026 Zorblax Ltd, London'), ['Zorblax'])
  assert.deepEqual(hits('Copyright 2026 Zorblax Ltd. Ask Zorblax Ltd (Jane) about Q3.'), ['Zorblax'])
  assert.deepEqual(hits('Zorblax Ltd'), ['Zorblax'])
  assert.deepEqual(hits('copyright 2026 zorblax ltd'), ['zorblax'], 'case included')
  assert.deepEqual(hits('Mega Corp Incorporated'), ['Mega Corp'])
  assert.deepEqual(findTerms('Copyright 2026 Zorblax Ltd', list.terms), ['Zorblax'], 'nothing is allowed unless passed')
  assert.throws(() => parseList('ok\n!\n', 'list.txt'), /list\.txt:2: "!" allows nothing/)
  assert.deepEqual(parseTermList('/zorblax/\n!Copyright 2026 Zorblax Ltd\n', 'list.txt').map(t => t.label), ['/zorblax/'])
})

test('the always-on patterns catch a home folder, a claude.ai account link and an email address, and nothing ordinary', () => {
  const caught = [
    // Each written in two parts, so that this file doesn't hold what it looks for.
    '/Us' + 'ers/me/x', 'https://claude.ai' + '/artifact/abc', 'https://claude.ai' + '/code/session_01', 'claude.ai' + '/code/artifact/1',
    'claude.ai' + '/project/9', 'claude.ai' + '/chat/1', 'claude.ai' + '/share/1', 'mail sam.r' + '@zorblax-qux.co.uk now',
  ]
  for (const text of caught) assert.notDeepEqual(findTerms(text, GENERIC_TERMS), [], text)
  const ordinary = [
    '/home/sam/', 'https://code.claude.com/docs', 'claude.ai/code', '@modelcontextprotocol/sdk', 'sam@' + 'example.com',
    'x@' + 'acme.invalid', 'users/me', 'Sam', 'Acme',
  ]
  for (const text of ordinary) assert.deepEqual(findTerms(text, GENERIC_TERMS), [], text)
})

test('the email check passes the addresses the project publishes, and only those, whole', () => {
  for (const address of PUBLIC_ADDRESSES) {
    assert.deepEqual(findTerms(`report it to ${address}.`, GENERIC_TERMS), [], address)
    const [local, domain] = address.split('@')
    for (const near of [`x${address}`, `${address}.evil.com`, `${address}x`, `${local.slice(1)}@${domain}`, `someone@${domain}`]) {
      assert.notDeepEqual(findTerms(near, GENERIC_TERMS), [], near)
    }
  }
})

test('every published address is still in use, so the list never keeps one nobody should write to', { skip: FILES ? false : 'not a git checkout' }, () => {
  const text = (FILES ?? []).filter(file => file !== 'test/private-terms.ts').map(file => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n')
  for (const address of PUBLIC_ADDRESSES) assert.ok(text.includes(address), address)
})

test('the list is PRIVATE_TERMS_FILE, else private-terms.txt here, which git ignores; a named list that is missing fails', () => {
  assert.deepEqual(privateTermsFile({}), { file: path.join(ROOT, 'private-terms.txt'), named: false })
  assert.deepEqual(privateTermsFile({ PRIVATE_TERMS_FILE: '~/x/terms.txt' }), { file: path.join(os.homedir(), 'x/terms.txt'), named: true })
  assert.deepEqual(privateTermsFile({ PRIVATE_TERMS_FILE: 'rel.txt' }), { file: path.join(ROOT, 'rel.txt'), named: true })
  assert.match(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8'), /^private-terms\.txt$/m)
  const ignored = spawnSync('git', ['check-ignore', '-q', 'private-terms.txt'], { cwd: ROOT })
  if (ignored.error === undefined && FILES) assert.equal(ignored.status, 0, 'git ignores private-terms.txt')

  const none = loadPrivateTerms({ PRIVATE_TERMS_FILE: '' }, path.join(DIR, 'nothing-here.txt'))
  assert.equal(none.terms, null)
  assert.deepEqual(none.allowed, [])
  assert.equal(none.problem, '', 'no list of your own: the check is skipped, not failed')
  const missing = loadPrivateTerms({ PRIVATE_TERMS_FILE: path.join(DIR, 'missing.txt') })
  assert.equal(missing.terms, null)
  assert.match(missing.problem, /^PRIVATE_TERMS_FILE names .*missing\.txt, which can't be read \(ENOENT\)/)
  const file = path.join(DIR, 'terms.txt')
  fs.writeFileSync(file, '# mine\nZorblax\n!Copyright 2026 Zorblax Ltd\n')
  const mine = loadPrivateTerms({ PRIVATE_TERMS_FILE: file })
  assert.deepEqual(mine.terms?.map(t => t.label), ['Zorblax'])
  assert.deepEqual(mine.allowed, ['Copyright 2026 Zorblax Ltd'])
  assert.deepEqual(findTerms('Copyright 2026 Zorblax Ltd', mine.terms ?? [], mine.allowed), [])
  assert.deepEqual(findTerms('Copyright 2026 Zorblax Ltd, Zorblax', mine.terms ?? [], mine.allowed), ['Zorblax'])
  assert.match(NO_LIST_NOTE, /private-terms\.txt/)
  assert.match(NO_LIST_NOTE, /PRIVATE_TERMS_FILE/)
})

test('the files checked are every file git would commit, the README, the tests and this guard included', { skip: FILES ? false : 'not a git checkout' }, () => {
  const files = FILES ?? []
  assert.ok(files.length > 60, `${files.length} files`)
  for (const file of ['README.md', 'src/server.ts', 'public/agent.html', 'scripts/install-service.sh', '.claude/agents/meeting-assistant.md',
    '.claude/settings.json', 'test/private-terms.test.ts', 'test/private-terms.ts', 'test/fixtures/name-corpus.json']) {
    assert.ok(files.includes(file), file)
  }
  // Not what .gitignore keeps out: your settings, profile, private list, data and dependencies.
  const yours = /^node_modules\/|^data\/(?!\.gitkeep$)|^\.env$|^profile\.md$|^private-terms\.txt$|settings\.local\.json$/
  for (const file of files) assert.doesNotMatch(file, yours, file)
})

test('no file names a home folder, links into a claude.ai account or holds an email address', { skip: FILES ? false : 'not a git checkout' }, () => {
  assert.deepEqual(offenders(FILES ?? [], GENERIC_TERMS), [])
})

test('no file names a term from your private list', { skip: LIST.terms || LIST.problem ? false : NO_LIST_NOTE }, () => {
  assert.equal(LIST.problem, '')
  assert.ok(FILES, 'not a git checkout: the files git would commit can\'t be listed')
  assert.ok(LIST.terms?.length, `${LIST.file} has no terms in it`)
  // The list itself must never be committed: a regex such as /sam\.r/ doesn't match its own text, so nothing else would catch it.
  const real = (file: string) => { try { return fs.realpathSync.native(file) } catch { return path.resolve(file) } }
  const list = real(LIST.file)
  assert.ok(!(FILES ?? []).some(file => real(path.join(ROOT, file)) === list),
    `${LIST.file} is a file git would commit: keep your list outside the repository, or in the gitignored private-terms.txt`)
  assert.deepEqual(offenders(FILES ?? [], LIST.terms ?? [], LIST.allowed), [])
})
