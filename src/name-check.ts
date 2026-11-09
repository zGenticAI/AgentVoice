// Whether a name works for the assistant: checked at start-up (the voice service and the channel refuse to
// start with a name that can't work), by npm run check and by npm run check-name. Errors and warnings go to
// stderr only, since the channel process speaks MCP on stdout.
//
// Errors are names the rules can't hear or would mistake: not one word of plain letters, too short or long,
// the participants' label, or a word the attention, leave and cancel rules already use ("Will" would answer
// every "Will you ...?"). And three lines must read as they do for the default name: "<Name>, please leave"
// (the consent line teaches it), "<Name>, what is the timeline?" and "I asked <Name> yesterday.".
// Warnings are names that work but cost something: everyday words, forms of address and replies ("Dude", "Sweet":
// said to anyone), other assistants' wake words, very short names and accents (ignored when matching). A spelling
// (AGENT_NAME_VARIANTS) is warned about when it is an everyday word or a form of address; a mishearing
// (AGENT_NAME_MISHEARD) when it is an everyday word, a form of address or a common first name, since a mishearing
// counts for leaving: "Dude, you can go now." said to anyone, or "Mark, you can go now." said to a colleague, would
// make the assistant leave. Neither may be the name of anyone you meet with. The word lists are curated
// (src/identity.ts), not a dictionary, so a word they miss can still be heard.
// The participant-list name (AGENT_BOT_NAME) is checked too: it must say the assistant is an AI, as the consent
// line and the chat notice do, so it has to contain the word "AI", with no negation before it ("not AI", "not a
// bot or AI", "non-AI") or after it ("AI-free"). There is no way round that. One that doesn't start with the
// assistant's name on its own ("Nova AI", "AI Nova") is a warning: people who only see the list say "<what they
// read first>, please leave", and that is heard only when it is the name.
// The owner's settings (OWNER_NAME, OWNER_FULL_NAME, COMPANY_NAME) are checked here too (checkOwner): OWNER_NAME
// must be set, and each goes into prompts and onto the bot page, so it must be one short line of plain name text.
import { GRAMMAR_WORDS, isFillerOnly, makeAttention } from './brain/attention.ts'
import { LEAVE_AND_CANCEL_WORDS, makeNameRules } from './brain/text.ts'
import {
  ADDRESS_WORDS, type AgentName, COMMON_FIRST_NAMES, COMMON_WORD_NAMES, IDENTITY_WARNINGS, type Identity, type Names, PARTICIPANT_LABEL,
  WAKE_WORDS, defaultBotName, fold, hasWord, identity, stripAccents,
} from './identity.ts'

export const MIN_LETTERS = 3
export const MAX_LETTERS = 20
/** The longest OWNER_NAME, OWNER_FULL_NAME or COMPANY_NAME may be, in characters. */
export const MAX_OWNER_CHARS = 60

export interface NameCheck {
  /** Why the name can't be used. The service doesn't start while there are any. */
  errors: string[]
  /** What using it costs. The service starts anyway. */
  warnings: string[]
}

/** "AI" as a word of its own: in "Nova (Sam's AI assistant)" or "AI notes", but not in "OpenAI", "MAIN" or "Aide". */
const AI_WORD = /(?<![\p{L}\p{N}])AI(?![\p{L}\p{N}])/gu
/**
 * What may come between a negation and "AI" in the same bracket or clause: spaces (any kind), any dash or hyphen,
 * the non-breaking one (U+2011) among them, a slash ("not a bot/AI") and quotes ('not "AI"'). Not a bracket, comma,
 * colon or full stop: "Nova (AI, not human)" and "Nova (not human: AI)" deny nothing about being an AI.
 */
const GAP = String.raw`[\s\p{Pd}\u2212/"'\u2018\u2019\u201c\u201d\u00ab\u00bb\u200b-\u200d\u2060\ufeff]+`
/** A word between: "a", "bot", "using", "Sam's". */
const BETWEEN = String.raw`[\p{L}\p{N}]+(?:['’]\p{L}+)?`
/**
 * A negation before "AI", with at most three words between: "not AI", "non-AI", "not a bot or AI", "not a bot/AI",
 * "not using AI", "no longer AI", "0% AI", "without any AI", "isn't an AI". The negations are not, no, non, without,
 * never, nor, neither, zero, 0%, isn't, ain't and any other n't word, each a word of its own ("Notes AI" and
 * "100% AI" are fine). It can catch a name that means no denial ("no-nonsense AI"): that is refused, and reworded.
 */
const DENIED_BEFORE = new RegExp(
  String.raw`(?<![\p{L}\p{N}'’])(?:not|no|non|without|never|nor|neither|zero|0\s*%|isnt|aint|\p{L}*n['’]t)(?:${GAP}${BETWEEN}){0,3}${GAP}$`,
  'iu',
)
/** "free" or "less" right after "AI": "AI-free", "AI free", "AI-less" (with any dash), '"AI"-free'. */
const DENIED_AFTER = new RegExp(String.raw`^(?:${GAP})?(?:free|less)(?![\p{L}\p{N}])`, 'iu')

/**
 * Why this participant-list name can't be used, or '' when it can. The participant list is one of the three places
 * the meeting learns it is talking to an AI, with the consent line and the chat notice, so the name has to say so,
 * and must not say the opposite.
 */
export function botNameProblem(botName: string): string {
  const said = [...botName.matchAll(AI_WORD)]
  if (!said.length) {
    return `The participant-list name "${botName}" (AGENT_BOT_NAME, or the older ALEX_BOT_NAME) doesn't say the assistant is ` +
      'an AI. The meeting must be able to see that from the participant list, as the consent line and the chat notice say ' +
      `it: put the word "AI" in it, in capitals, for example "Nova (Sam's AI assistant)", or leave AGENT_BOT_NAME unset.`
  }
  for (const { index } of said) {
    const before = DENIED_BEFORE.exec(botName.slice(0, index))?.[0] ?? ''
    const after = before ? '' : DENIED_AFTER.exec(botName.slice(index + 2))?.[0] ?? ''
    if (!before && !after) continue
    const phrase = botName.slice(index - before.length, index + 2 + after.length)
    return `The participant-list name "${botName}" (AGENT_BOT_NAME, or the older ALEX_BOT_NAME) says the assistant is not ` +
      `an AI ("${phrase}"). The meeting must be able to see from the participant list that it is one, as the consent line ` +
      `and the chat notice say: take the negation out, for example "Nova (Sam's AI assistant)", or leave AGENT_BOT_NAME unset.`
  }
  return ''
}

/**
 * What people who only see the participant list read first, and so call the assistant: the name up to a bracket,
 * comma, colon, slash or spaced dash. "Nova (Sam's AI assistant)" is read as "Nova", "Nova AI" as "Nova AI", and
 * "Nova-AI", one word to the eye, as "Nova-AI".
 */
export function listedName(botName: string): string {
  return botName.split(/\s*(?:[([{,;:|/]|\s\p{Pd}\s)/u)[0].trim() || botName.trim()
}

/** "mark" as it would be written opening a line: "Mark". */
const capitalised = (word: string) => word.charAt(0).toUpperCase() + word.slice(1)

/** True when the rules already use this word, so it can't be a name. */
export function isGrammarWord(word: string): boolean {
  const folded = fold(word)
  return GRAMMAR_WORDS.has(folded) || LEAVE_AND_CANCEL_WORDS.has(folded) || isFillerOnly(folded)
}

/** Why this word can't be the name, a spelling or a mishearing (`what` says which), or '' when it can. */
function wordProblem(word: string, what: string): string {
  if (!/^\p{L}+$/u.test(word)) {
    return `${what} "${word}" must be one word of letters only, with no spaces, hyphens, apostrophes or digits: ` +
      'the rules would read it as several words (or "O\'Neil" as a possessive), so it would never be heard.'
  }
  const folded = fold(word)
  if (!/^[a-z]+$/.test(folded)) {
    return `${what} "${word}" has letters the English speech model doesn't write (it writes a to z; accents are fine). ` +
      'Spell it the way it would be written in English.'
  }
  if (folded.length < MIN_LETTERS || folded.length > MAX_LETTERS) {
    return `${what} "${word}" has ${folded.length} letters: use ${MIN_LETTERS} to ${MAX_LETTERS}.`
  }
  if (folded === fold(PARTICIPANT_LABEL)) {
    return `${what} "${word}" is the transcript's label for everyone else in the meeting, so it can't be the assistant's.`
  }
  if (isGrammarWord(folded)) {
    return `${what} "${word}" is a word the rules for who is being spoken to already use, so ordinary lines with it ` +
      'would be taken as said to the assistant, or even as a request to leave. Choose a word they don\'t use.'
  }
  return ''
}

/**
 * Whether these names work, and what using them costs. With a participant-list name, also whether it says it is an AI
 * (an error otherwise) and starts with the name on its own (a warning otherwise).
 */
export function checkName(agent: AgentName & { readonly botName?: string; readonly owner?: string }): NameCheck {
  const errors: string[] = []
  const warnings: string[] = []
  const { name } = agent
  const folded = fold(name)
  const nameProblem = wordProblem(name, 'AGENT_NAME:')
  if (nameProblem) errors.push(nameProblem)
  const botProblem = agent.botName === undefined ? '' : botNameProblem(agent.botName)
  if (botProblem) errors.push(botProblem)
  // People who only see the participant list call the assistant what they read first there, and that has to be its name.
  const listed = agent.botName === undefined ? '' : listedName(agent.botName)
  if (agent.botName !== undefined && !nameProblem && fold(listed) !== folded) {
    const what = hasWord(agent.botName, name)
      ? `doesn't start with the name "${name}" on its own`
      : `doesn't have the name "${name}" in it`
    warnings.push(
      `The participant-list name "${agent.botName}" ${what}. People who only see the participant list will say ` +
        `"${listed}, please leave", and that isn't heard: the assistant leaves only for its own name. Start it with ` +
        `"${name}" alone and put the rest in brackets, for example "${name} (AI)" or "${defaultBotName(name, agent.owner ?? '')}", or leave ` +
        'AGENT_BOT_NAME (and the older ALEX_BOT_NAME) unset.',
    )
  }
  for (const [list, words] of [['AGENT_NAME_VARIANTS:', agent.variants], ['AGENT_NAME_MISHEARD:', agent.misheard]] as const) {
    for (const word of words) {
      const problem = wordProblem(word, list)
      if (problem) errors.push(problem)
      else if (fold(word) === folded) warnings.push(`${list} "${word}" is the name itself, so it adds nothing: leave it out.`)
    }
  }
  for (const word of agent.variants.filter(v => agent.misheard.map(fold).includes(fold(v)))) {
    errors.push(
      `"${word}" is in both AGENT_NAME_VARIANTS and AGENT_NAME_MISHEARD. A spelling counts anywhere in a line, a mishearing ` +
        'only as its first word: put it in one list.',
    )
  }

  // Three lines that must read as they do for the default name. Only worth trying once the name itself is fine.
  if (!nameProblem) {
    const rules = makeNameRules(agent)
    const grammar = makeAttention(agent)
    if (!rules.isLeaveRequest(`${name}, please leave`)) {
      errors.push(`"${name}, please leave" is not taken as a request to leave, but the consent line tells the meeting to say it.`)
    }
    if (grammar.attention(`${name}, what is the timeline?`) !== 'asked') {
      errors.push(`"${name}, what is the timeline?" is not taken as a question to the assistant.`)
    }
    if (grammar.attention(`I asked ${name} yesterday.`) !== 'mentioned') {
      errors.push(`"I asked ${name} yesterday." is not taken as talk about the assistant.`)
    }
  }

  // Said of the name only what is true of it: an everyday word, a form of address or a reply, or both ("Roger").
  const kinds = [
    COMMON_WORD_NAMES.has(folded) ? 'an everyday English word' : '',
    ADDRESS_WORDS.has(folded) ? 'a form of address or a reply that people say to anyone' : '',
  ].filter(Boolean)
  if (kinds.length) {
    warnings.push(
      `"${name}" is also ${kinds.join(', and ')}, so ordinary lines that start with it, or have it after a comma, may be taken ` +
        `as said to the assistant, and "${capitalised(name)}, you can go now." said to someone else makes it leave and delete ` +
        'the meeting record. A name that isn\'t a word is safer: npm run check-name shows what changes on the sample lines.',
    )
  }
  if (WAKE_WORDS.has(folded)) {
    warnings.push(
      `"${name}" is another assistant's wake word: phones and speakers in the room may answer too, and people say it to their own.`,
    )
  }
  if (!nameProblem && folded.length === MIN_LETTERS) {
    warnings.push(
      `"${name}" is short. Short names are easier to mishear: after a meeting, see how its transcript (data/transcripts/) ` +
        'writes the name, and add what speech recognition writes.',
    )
  }
  if (!nameProblem && stripAccents(name) !== name) {
    warnings.push(
      `Accents are ignored when matching, so "${name}" and "${stripAccents(name)}" are the same name ` +
        '(speech recognition usually writes the second).',
    )
  }
  for (const word of agent.variants) {
    const said = capitalised(word)
    if (ADDRESS_WORDS.has(fold(word))) {
      warnings.push(
        `AGENT_NAME_VARIANTS: "${word}" is a form of address or a reply, so people say it to anyone, and a spelling counts ` +
          'anywhere in a line: lines with it may be taken as said to the assistant, whoever they were said to. In ' +
          `AGENT_NAME_MISHEARD it would count for leaving, so "${said}, you can go now." said to anyone would make the ` +
          'assistant leave and delete the meeting record. Leave it out of both lists.',
      )
    } else if (COMMON_WORD_NAMES.has(fold(word))) {
      warnings.push(
        `AGENT_NAME_VARIANTS: "${word}" is an everyday word, and a spelling counts anywhere in a line, so ordinary lines with it may ` +
          'be taken as said to the assistant. In AGENT_NAME_MISHEARD it would count only as the first word, but a mishearing ' +
          `counts for leaving: "${said}, you can go now." said to someone called ${said} would make the assistant leave and ` +
          'delete the meeting record. Move it there only if it is not the name of anyone you meet with; otherwise leave it out.',
      )
    }
  }
  // A mishearing people say to anyone, or that people may be called: for leaving, it is the assistant's name as much
  // as the name itself. Said to anyone is the wider of the two, so it is what a word that is both is warned about.
  const variants = agent.variants.map(fold)
  for (const word of agent.misheard.filter(m => fold(m) !== folded && !variants.includes(fold(m)))) {
    const said = capitalised(word)
    const leaves = agent.leaveMisheard.map(fold).includes(fold(word))
    if (ADDRESS_WORDS.has(fold(word))) {
      warnings.push(
        `AGENT_NAME_MISHEARD: "${word}" is a form of address or a reply, so people say it to anyone` +
          (leaves
            ? `, and a mishearing counts for leaving: "${said}, you can go now." said to anyone in the meeting makes the ` +
              'assistant leave and delete the meeting record. Leave it out: a missed "please leave" can be said again; a ' +
              'false one can\'t be undone.'
            : `: "${said}, what do you think?" said to anyone in the meeting is answered. Leave it out.`),
      )
      continue
    }
    const kind = COMMON_FIRST_NAMES.has(fold(word)) ? 'a first name' : COMMON_WORD_NAMES.has(fold(word)) ? 'a name people are called' : ''
    if (!kind) continue
    warnings.push(
      leaves
        ? `AGENT_NAME_MISHEARD: "${word}" is also ${kind}, and it counts for leaving: "${said}, you can go now." said to ` +
            `someone called ${said} makes the assistant leave and delete the meeting record. A mishearing must never be the ` +
            `name of anyone you meet with: if anyone might be called ${said}, leave it out (a missed "please leave" can be ` +
            'said again; a false one can\'t be undone).'
        : `AGENT_NAME_MISHEARD: "${word}" is also ${kind}: "${said}, what do you think?" said to someone called ${said} ` +
            'is answered. A mishearing must never be the name of anyone you meet with.',
    )
  }
  return { errors, warnings }
}

/** One line for the log: the name and its lists. */
export function describeName(agent: AgentName): string {
  const lists = [
    agent.variants.length ? `spellings ${agent.variants.join(', ')}` : '',
    agent.misheard.length ? `mishearings ${agent.misheard.join(', ')}` : '',
  ].filter(Boolean)
  return `"${agent.name}"${lists.length ? ` (${lists.join('; ')})` : ''}`
}

/** What an owner setting may hold besides letters (and the marks accents are made of): spaces, apostrophes, hyphens, dots. */
const OWNER_EXTRAS = String.raw` '’.\-‐`
const NOT_OWNER_TEXT = new RegExp(String.raw`[^\p{L}\p{M}${OWNER_EXTRAS}]`, 'gu')
/** A company's name may also have digits, "&", commas and brackets ("Acme 3D", "Smith & Co", "Acme, Inc.", "Acme (UK)"): the bot page escapes them, and prompts are text. */
const NOT_COMPANY_TEXT = new RegExp(String.raw`[^\p{L}\p{M}\p{Nd}&,()${OWNER_EXTRAS}]`, 'gu')

/**
 * Why this owner setting (OWNER_NAME, OWNER_FULL_NAME or COMPANY_NAME, named by `variable`) can't go into the
 * assistant's words, or '' when it can. Each is said in prompts, the consent line and on the bot page, so it must be
 * one short line of name text: anything else (a quote, a bracket, a line break, a hidden character) could break the
 * page or the prompt, or turn a setting into an instruction. A company may have digits and "&" as well; a person's
 * name may not, since it is in "<owner>'s AI assistant" and the participant list, where either is a mistake.
 */
export function ownerSettingProblem(variable: string, value: string): string {
  if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value)) {
    return `${variable} must be one line, with no control or hidden characters: ${JSON.stringify(value)}.`
  }
  const length = [...value].length
  if (length > MAX_OWNER_CHARS) return `${variable} is ${length} characters long: ${MAX_OWNER_CHARS} at most, since it goes into the prompts.`
  if (!/\p{L}/u.test(value)) return `${variable} "${value}" has no letters in it.`
  const company = variable === 'COMPANY_NAME'
  const others = [...new Set(value.match(company ? NOT_COMPANY_TEXT : NOT_OWNER_TEXT) ?? [])]
  if (others.length) {
    const allowed = company ? 'letters, digits, spaces, apostrophes, hyphens, dots, commas, brackets and "&"' : 'letters, spaces, apostrophes, hyphens and dots'
    return `${variable} "${value}" may have only ${allowed}, not ${others.map(c => `"${c}"`).join(' or ')}: ` +
      "it goes into the assistant's prompts and onto its bot page."
  }
  return ''
}

/**
 * Whether the owner's settings work. OWNER_NAME must be set: with no default, no assistant can introduce itself as
 * someone else's. Each setting must be fit to go into the assistant's words (ownerSettingProblem). An assistant named
 * as the owner is called is a warning: it would answer what is said to the owner.
 */
export function checkOwner(id: Names): NameCheck {
  const errors: string[] = []
  const warnings: string[] = []
  if (!id.owner) {
    errors.push(
      'OWNER_NAME is not set. Add the name of the person the assistant works for to .env, as it should say it ' +
        `(OWNER_NAME=Sam makes "${defaultBotName(id.name, 'Sam')}" and "Sam's notes"). There is no default, so that no ` +
        "assistant ever introduces itself as someone else's.",
    )
  }
  // A full name that is the name (OWNER_FULL_NAME unset) is checked once, as OWNER_NAME.
  const settings: [string, string][] = [
    ['OWNER_NAME', id.owner],
    ['OWNER_FULL_NAME', id.ownerFull === id.owner ? '' : id.ownerFull],
    ['COMPANY_NAME', id.company],
  ]
  for (const [variable, value] of settings) {
    const problem = value ? ownerSettingProblem(variable, value) : ''
    if (problem) errors.push(problem)
  }
  // The owner is in every meeting the assistant is in, and people call them by their first name.
  const firstNames = [id.owner, id.ownerFull].map(full => fold(full.split(/\s+/)[0] ?? ''))
  if (id.owner && firstNames.includes(fold(id.name))) {
    const said = capitalised(id.name)
    warnings.push(
      `AGENT_NAME "${id.name}" is the owner's first name too (OWNER_NAME "${id.owner}"). The owner is in every meeting the ` +
        `assistant is in: what people say to the owner ("${said}, what do you think?") would be taken as said to the ` +
        `assistant, and "${said}, you can go now." said to the owner would make it leave and delete the meeting record. ` +
        'Choose another name for the assistant.',
    )
  }
  return { errors, warnings }
}

/**
 * Checks the names when a process starts: the assistant's (checkName) and the owner's (checkOwner). What reading
 * .env warned about is written first (identity.ts keeps it until now, so that npm run check-name, trying another
 * name, doesn't print it), then the warnings, and it goes on; with errors it writes them and exits, so the service
 * never runs with a name it can't hear, one that would make it leave by mistake, or without knowing whose it is.
 */
export function checkNameAtStartup(
  id: Identity = identity,
  write: (line: string) => void = line => process.stderr.write(`${line}\n`),
  readWarnings: readonly string[] = id === identity ? IDENTITY_WARNINGS : [],
): void {
  for (const warning of readWarnings) write(warning)
  const named = checkName(id)
  const owned = checkOwner(id)
  for (const warning of named.warnings) write(`[name] Warning: ${warning}`)
  for (const warning of owned.warnings) write(`[owner] Warning: ${warning}`)
  if (!named.errors.length && !owned.errors.length) return
  for (const error of owned.errors) write(`[owner] ${error}`)
  if (owned.errors.length) write('[owner] Fix the owner\'s settings in .env (see docs/make-it-yours.md), then start again.')
  for (const error of named.errors) write(`[name] ${error}`)
  if (named.errors.length) {
    write('[name] Fix the name in .env (see docs/choosing-a-name.md), then start again. npm run check-name tries one.')
  }
  process.exit(1)
}
