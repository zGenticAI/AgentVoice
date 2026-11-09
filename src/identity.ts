// Who the assistant is, and whose: the name it answers to and introduces itself by, the other ways speech
// recognition writes that name, the name it has in the meeting's participant list, and the person and company it
// works for. They come from .env:
//
// - AGENT_NAME: the name. "Alex" unless set.
// - AGENT_NAME_VARIANTS: other spellings speech recognition writes for it that are not everyday words, comma-
//   separated ("Alec, Alexa, Aleks" for Alex). They count anywhere in a line, like the name, for answering and for
//   "never mind", but never for leaving: they may be real people's names too. Never the name of anyone you meet
//   with: the assistant would answer what is said to them. src/name-check.ts warns about one that is an everyday
//   word or a form of address ("dude", "boss", "sweet": said to anyone).
// - AGENT_NAME_MISHEARD: mishearings that are also words ("Ionics, Elix" for Alex). They count only as the first
//   word of a line, or after "hey", "hi", "ok", "okay" or "so", for answering, "never mind" and leaving. So never
//   the name of anyone you meet with: "Mark, you can go now." said to a colleague would make it leave and delete
//   the meeting record. src/name-check.ts warns about one that is an everyday word, a form of address or a reply
//   ("Dude, you can go now." is said to anyone), or a common first name.
// - OWNER_NAME: the name of the person the assistant works for, as it says it: "Sam's AI assistant". Required,
//   with no default: the service and the channel refuse to start without it, so no install ever introduces itself
//   as someone else's assistant.
// - OWNER_FULL_NAME: the owner's full name, for the prompts ("You are Alex, Sam Rivera's AI assistant"). OWNER_NAME
//   unless set.
// - COMPANY_NAME: the owner's company, if any. Only the spoken answers' rules, Deepgram's keyterms and the bot page
//   use it, and each sentence that would is left out when it is unset: never the consent line, the chat notice or
//   the minutes. All three go into prompts and onto the bot page, so src/name-check.ts holds them to one line of
//   letters, spaces, apostrophes, hyphens and dots (the company digits and "&" too), at most 60 characters.
// - AGENT_BOT_NAME: the participant-list name, "<name> (<owner>'s AI assistant)" unless set. Whatever it is, it must
//   have the word "AI" in it, and not deny it ("not AI", "not a bot or AI", "AI-free"), so the participant list says
//   it is an AI, as the consent line and the chat notice do: src/name-check.ts refuses it otherwise. It warns when
//   the name doesn't come first, on its own ("Nova (AI)", not "Nova AI"), since people who only see the list say
//   "<what they read first>, please leave". The older ALEX_BOT_NAME still works, but is ignored when it names Alex
//   and AGENT_NAME is another name.
//
// This is the only place the default name and what speech recognition was seen to make of it live. The grammar
// (src/brain/attention.ts, text.ts), the spoken lines, the prompts and the bot page are built from the identity
// once, at start-up. Every word about the owner is built from OWNER_NAME and the rest: no person or company is
// written into the code. Longer prose about the owner (standing context, sources, rules) is in the owner's profile
// (src/profile.ts). src/name-check.ts says whether the names work, and why not (npm run check-name).
import './env.ts'

/** The name the assistant has unless .env names another: the only one with field data (ALEX_PROFILE). */
export const DEFAULT_NAME = 'Alex'

/** The participants' label in the transcript, so no assistant may have it as a name. */
export const PARTICIPANT_LABEL = 'Speaker'

/** The name and the other ways speech recognition writes it. The lists are folded (see fold()). */
export interface AgentName {
  /** The name as people should read it: one word of letters, NFC ("Alex"). */
  readonly name: string
  /** Other spellings that count anywhere in a line, but never for leaving. */
  readonly variants: readonly string[]
  /** Mishearings that are also words: they count only as the first word (or after hey, hi, ok, okay or so). */
  readonly misheard: readonly string[]
  /** The mishearings that also count for a request to leave: all of them, except in the built-in profile. */
  readonly leaveMisheard: readonly string[]
}

/** The person the assistant works for, and their company. */
export interface Owner {
  /** The owner's name as the assistant says it ("Sam's notes"): OWNER_NAME, or '' when unset (start-up refuses that). */
  readonly owner: string
  /** The owner's full name, for the prompts: OWNER_FULL_NAME, else the owner's name. */
  readonly ownerFull: string
  /** The owner's company: COMPANY_NAME, or '' when there is none. */
  readonly company: string
}

export interface Identity extends AgentName, Owner {
  /** The name in the meeting's participant list. */
  readonly botName: string
}

/** What the assistant's words are made from: its own name, its owner's and the owner's company. */
export type Names = Pick<Identity, 'name' | 'owner' | 'ownerFull' | 'company'>

/**
 * The default name, with what speech recognition was seen to write for it: Alec, Alexa and Aleks anywhere, and
 * "Ionics" (heard live, for "Alex, can you ...") and "Elix" as the first word. Real first names such as Alexis,
 * Alix or Alek are left out, so the assistant doesn't answer when someone talks to a colleague. Leaving deletes
 * the meeting record, so of the mishearings only "Ionics" counts for it, as it always has.
 */
export const ALEX_PROFILE: AgentName = Object.freeze({
  name: DEFAULT_NAME,
  variants: Object.freeze(['alec', 'alexa', 'aleks']),
  misheard: Object.freeze(['ionics', 'elix']),
  leaveMisheard: Object.freeze(['ionics']),
})

/**
 * Names people are called that are also everyday English words or interjections: mostly first names ("Mark",
 * "Grace", "Roger"), and a few surnames that are trades ("Smith", "Baker"). A curated list, a few hundred long, not
 * a dictionary, so a word that is not on it can still be heard in ordinary speech. Allowed as the name, with a
 * warning: ordinary lines that start with one ("Mark the ticket as done, can you?", "Bill them monthly") read as
 * said to the assistant, and "Roger, you can go now." said to someone else makes it leave and delete the meeting
 * record. In AGENT_NAME_MISHEARD one counts for leaving, so letting a colleague of that name go does the same.
 * Only words people use every day belong here, since the warning says so: a name that is only a name ("Taylor",
 * "Cooper") is in COMMON_FIRST_NAMES, and forms of address ("Boss", "Honey") in ADDRESS_WORDS.
 */
export const COMMON_WORD_NAMES: ReadonlySet<string> = new Set([
  'ace', 'amber', 'angel', 'april', 'archer', 'art', 'ash', 'aspen', 'august', 'autumn', 'baker', 'barb', 'basil',
  'bear', 'beau', 'belle', 'bill', 'billy', 'blaze', 'bliss', 'blossom', 'bob', 'bobby', 'bonnie', 'brandy', 'briar',
  'brook', 'buck', 'bud', 'bunny', 'butch', 'butler', 'buzz', 'candy', 'carol', 'cash', 'cedar', 'chance', 'charity',
  'chase', 'cherry', 'chip', 'chuck', 'clay', 'clementine', 'cliff', 'clover', 'colt', 'coral', 'crystal', 'dahlia',
  'daisy', 'dale', 'dash', 'dawn', 'deacon', 'dean', 'destiny', 'diamond', 'dolly', 'dot', 'dove', 'drew', 'duke',
  'dusty', 'earl', 'ebony', 'echo', 'eddy', 'ember', 'emerald', 'eve', 'faith', 'felicity', 'fern', 'fisher', 'flint',
  'flora', 'forest', 'foster', 'gale', 'gardener', 'gene', 'ginger', 'glen', 'glory', 'grace', 'grant',
  'gunner', 'guy', 'hardy', 'harmony', 'harry', 'haven', 'hazel', 'heath', 'heather', 'herb', 'holly', 'honor', 'hope',
  'hunter', 'iris', 'ivy', 'jack', 'jade', 'jasmine', 'jay', 'jet', 'jewel', 'jimmy', 'jock', 'josh', 'joy', 'june',
  'justice', 'kit', 'kitty', 'lance', 'lane', 'lark', 'laurel', 'liberty', 'lily', 'link', 'lucky', 'lyric', 'mac',
  'magnolia', 'major', 'marigold', 'marina', 'mark', 'mason', 'maverick', 'max', 'may', 'meadow', 'melody', 'mercy',
  'merry', 'mike', 'miles', 'miller', 'misty', 'myrtle', 'nan', 'nick', 'noel', 'norm', 'olive', 'opal', 'page',
  'pansy', 'pat', 'patience', 'patty', 'pearl', 'peg', 'penny', 'pepper', 'peter', 'pierce', 'pip', 'poppy', 'porter',
  'potter', 'precious', 'price', 'primrose', 'prince', 'prudence', 'rain', 'randy', 'ranger', 'raven', 'ray', 'red',
  'reed', 'rich', 'rick', 'river', 'rob', 'robin', 'rock', 'rocky', 'rod', 'roger', 'rose', 'rosemary', 'rowan', 'ruby',
  'rusty', 'saffron', 'sage', 'sandy', 'scout', 'serenity', 'shepherd', 'sherry', 'skip', 'sky', 'smith', 'sonny',
  'spike', 'star', 'sterling', 'stone', 'storm', 'stormy', 'sue', 'sugar', 'summer', 'sunny', 'tad', 'tanner',
  'trinity', 'tucker', 'turner', 'unity', 'valentine', 'van', 'verity', 'victor', 'violet', 'wade', 'walker', 'wally',
  'ward', 'warren', 'weaver', 'will', 'willow', 'win', 'winter', 'wolf', 'wood', 'woody', 'wren',
])

/**
 * Common first names that are not everyday words ("Nora", "Sarah", "Taylor"). A mishearing counts for leaving, so one
 * of these in AGENT_NAME_MISHEARD makes the assistant leave when someone of that name is let go: name-check warns.
 * Advisory, like COMMON_WORD_NAMES: a name not on it can still be someone's.
 */
export const COMMON_FIRST_NAMES: ReadonlySet<string> = new Set([
  'aaron', 'abigail', 'adam', 'adrian', 'aidan', 'alan', 'albert', 'alec', 'alex', 'alexander', 'alexis', 'alfie',
  'alfred', 'alice', 'alicia', 'alison', 'alix', 'amanda', 'amelia', 'amy', 'andrea', 'andrew', 'andy', 'angela',
  'angus', 'anna', 'anne', 'annie', 'anthony', 'antonio', 'arthur', 'austin', 'ava', 'barbara', 'beatrice', 'becky',
  'ben', 'benjamin', 'bernard', 'beryl', 'beth', 'betty', 'blake', 'bradley', 'brandon', 'brenda', 'brendan', 'brian',
  'bridget', 'bruce', 'bryan', 'caitlin', 'caleb', 'calvin', 'cameron', 'carl', 'carla', 'carlos', 'caroline', 'carter',
  'casey', 'catherine', 'chandler', 'charles', 'charlie', 'charlotte', 'chloe', 'chris', 'christian', 'christopher',
  'claire', 'clara', 'clark', 'cole', 'colin', 'connor', 'cooper', 'craig', 'daniel', 'danny', 'darren', 'david',
  'debbie', 'deborah', 'dennis', 'derek', 'diana', 'diane', 'dominic', 'donald', 'donna', 'dorothy', 'douglas', 'dylan',
  'edward', 'eleanor', 'elijah', 'elizabeth', 'ella', 'ellie', 'emily', 'emma', 'eric', 'erica', 'erin', 'ethan', 'eva',
  'evan', 'evelyn', 'felix', 'fiona', 'fletcher', 'florence', 'frances', 'francis', 'fred', 'gabriel', 'gary', 'gavin',
  'gemma', 'george', 'georgia', 'gerald', 'gloria', 'glover', 'gordon', 'graham', 'greg', 'gregory', 'hank', 'hannah',
  'harold', 'harper', 'harrison', 'helen', 'henry', 'howard', 'hugo', 'ian', 'isaac', 'isabel', 'isabella', 'jacob',
  'james', 'jamie', 'jane', 'janet', 'jason', 'jeffrey', 'jennifer', 'jenny', 'jeremy', 'jerry', 'jesse', 'jessica',
  'jill', 'joan', 'joel', 'joey', 'john', 'jonathan', 'jordan', 'joseph', 'julia', 'julian', 'julie', 'justin', 'karen',
  'kate', 'katherine', 'katie', 'keith', 'kelly', 'kevin', 'kyle', 'larry', 'laura', 'lauren', 'leah', 'lee', 'leo',
  'leon', 'liam', 'linda', 'lisa', 'logan', 'louis', 'lucas', 'lucy', 'luke', 'lydia', 'maggie', 'margaret', 'maria',
  'marie', 'martha', 'martin', 'mary', 'matthew', 'megan', 'melissa', 'mia', 'michael', 'michelle', 'mitchell',
  'monica', 'morgan', 'nancy', 'natalie', 'nathan', 'neil', 'nicola', 'nicole', 'nina', 'noah', 'nora', 'norman',
  'oliver', 'olivia', 'oscar', 'owen', 'parker', 'patrick', 'paul', 'paula', 'philip', 'phoebe', 'rachel', 'raymond',
  'rebecca', 'rex', 'richard', 'riley', 'rita', 'robert', 'ronald', 'russell', 'ruth', 'ryan', 'sally', 'sam',
  'samantha', 'samuel', 'sara', 'sarah', 'sawyer', 'scott', 'sean', 'sebastian', 'sharon', 'simon', 'sophia', 'sophie',
  'stanley', 'stella', 'stephen', 'steve', 'steven', 'stuart', 'susan', 'tara', 'taylor', 'teresa', 'theo', 'thomas',
  'timothy', 'tina', 'tony', 'trevor', 'trey', 'troy', 'tyler', 'valerie', 'vanessa', 'victoria', 'vincent', 'walter',
  'wayne', 'wendy', 'william', 'zach', 'zachary', 'zoe',
])

/**
 * Forms of address and replies: words said to anyone in a meeting, whatever their name ("Dude, ...", "Boss, ...",
 * "Sweet, you can go now."). A mishearing counts for leaving, so with one of these in AGENT_NAME_MISHEARD, "Dude,
 * you can go now." said to anyone makes the assistant leave and delete the meeting record, and as a spelling or the
 * name it would answer what is said to anyone: name-check warns about it in all three. Advisory and curated, like
 * COMMON_WORD_NAMES. Words the rules already use ("mate", "guys", "cheers", "sir") are refused anyway, so are not
 * here. A few are names as well ("Roger", "Sonny") and are on COMMON_WORD_NAMES too.
 */
export const ADDRESS_WORDS: ReadonlySet<string> = new Set([
  'ace', 'amen', 'angel', 'babe', 'babes', 'bae', 'bet', 'bless', 'boo', 'boss', 'boys', 'bro', 'bruh', 'bud', 'cap',
  'captain', 'champ', 'chap', 'chief', 'chuck', 'coach', 'colleague', 'copy', 'cuz', 'dad', 'darling', 'dawg', 'dear',
  'doc', 'dope', 'dude', 'fab', 'fam', 'fella', 'gentlemen', 'gents', 'girls', 'gotcha', 'guv', 'homie', 'hon', 'honey',
  'hun', 'indeed', 'kid', 'kiddo', 'lad', 'ladies', 'lads', 'lass', 'lovey', 'maam', 'mac', 'madam', 'miss', 'mister',
  'mom', 'mum', 'neat', 'partner', 'pet', 'petal', 'pops', 'princess', 'roger', 'sarge', 'sis', 'skipper',
  'solid', 'son', 'sonny', 'sport', 'sugar', 'sunshine', 'super', 'sweet', 'sweetheart', 'sweetie', 'wicked', 'word',
  'yup',
])

/** Other assistants' wake words: devices in the room may answer as well, and people say them to their own assistant. */
export const WAKE_WORDS: ReadonlySet<string> = new Set([
  'alexa', 'amazon', 'bixby', 'computer', 'copilot', 'cortana', 'echo', 'gemini', 'google', 'siri',
])

const ASCII = /^[\x00-\x7f]*$/

/** The text with accents taken off its letters ("José" becomes "Jose"), in NFC. Plain ASCII comes back as it is. */
export function stripAccents(text: string): string {
  return ASCII.test(text) ? text : text.normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC')
}

/**
 * How names are compared: NFC, accents removed, lower case. Speech recognition writes "Jose" for a configured
 * "José", and "alex" as often as "Alex", and each has to count.
 */
export function fold(text: string): string {
  return stripAccents(text).toLowerCase()
}

/** A comma list from .env, folded, without blanks or repeats. Whether each one works is name-check's to say. */
export function nameList(raw: string | undefined): string[] {
  const words: string[] = []
  for (const item of (raw ?? '').split(',')) {
    const word = fold(item.trim())
    if (word && !words.includes(word)) words.push(word)
  }
  return words
}

type Env = Record<string, string | undefined>

/**
 * The name and its lists from these variables. The default name with neither list set gets the built-in
 * profile, so an install that never set them behaves exactly as before; any other name starts with no
 * variants or mishearings until they are set.
 */
export function agentName(env: Env): AgentName {
  const name = (env.AGENT_NAME?.trim() || DEFAULT_NAME).normalize('NFC')
  const variants = nameList(env.AGENT_NAME_VARIANTS)
  const misheard = nameList(env.AGENT_NAME_MISHEARD)
  if (fold(name) === fold(DEFAULT_NAME) && !variants.length && !misheard.length) return Object.freeze({ ...ALEX_PROFILE, name })
  return Object.freeze({ name, variants: Object.freeze(variants), misheard: Object.freeze(misheard), leaveMisheard: Object.freeze(misheard) })
}

/** Whether the text has this word as a word of its own, compared folded: "Nova (Sam's AI assistant)" has "nova". */
export function hasWord(text: string, word: string): boolean {
  const words: readonly string[] = fold(text).match(/\p{L}+/gu) ?? []
  return words.includes(fold(word))
}

/**
 * The participant-list name made from the name and the owner's, when .env doesn't set one. Without an owner (the
 * service refuses to start then, but npm run check-name still shows a name) it names nobody.
 */
export function defaultBotName(name: string, owner: string): string {
  return owner ? `${name} (${owner}'s AI assistant)` : `${name} (AI assistant)`
}

/**
 * The participant-list name: AGENT_BOT_NAME, or the older ALEX_BOT_NAME (with a warning), or one made from the name.
 * An ALEX_BOT_NAME that names the default is from before the name was a setting: with another name it would
 * list the assistant under a name it doesn't answer to, so it is ignored, with a warning that names it.
 */
export function botName(env: Env, name: string, warn: (message: string) => void, owner = readOwner(env).owner): string {
  const set = env.AGENT_BOT_NAME?.trim()
  if (set) return set
  const made = defaultBotName(name, owner)
  const old = env.ALEX_BOT_NAME?.trim()
  if (old && hasWord(old, DEFAULT_NAME) && fold(name) !== fold(DEFAULT_NAME)) {
    warn(
      `[identity] ALEX_BOT_NAME is "${old}", which names ${DEFAULT_NAME}, but AGENT_NAME is "${name}": it is ignored, and the ` +
        `participant list shows "${made}". Take ALEX_BOT_NAME out of .env, or set AGENT_BOT_NAME to one that starts with "${name}".`,
    )
    return made
  }
  if (old) {
    warn('[identity] ALEX_BOT_NAME is now called AGENT_BOT_NAME. It still works for now: rename it in .env.')
    return old
  }
  return made
}

/** A setting about the owner as it goes into text: trimmed, in NFC. Whether it is fit to is name-check's to say. */
const ownerSetting = (raw: string | undefined): string => (raw ?? '').trim().normalize('NFC')

/** The owner and company these variables give, as they are: nothing is made up for one that is missing. */
export function readOwner(env: Env): Owner {
  const owner = ownerSetting(env.OWNER_NAME)
  return Object.freeze({ owner, ownerFull: ownerSetting(env.OWNER_FULL_NAME) || owner, company: ownerSetting(env.COMPANY_NAME) })
}

/** The identity these variables give. Warnings go to `warn`; whether the names work is checked by name-check.ts. */
export function readIdentity(env: Env, warn: (message: string) => void = message => console.warn(message)): Identity {
  const names = agentName(env)
  const owner = readOwner(env)
  return Object.freeze({ ...names, ...owner, botName: botName(env, names.name, warn, owner.owner) })
}

const readWarnings: string[] = []

/**
 * The assistant this process is, from .env, read once at start-up. What reading it warns about is kept in
 * IDENTITY_WARNINGS, not printed here: the start-up check (checkNameAtStartup) writes it to stderr before the name's
 * own warnings, npm run check prints it, and npm run check-name, which may be trying another name, reads .env again
 * itself. Never to stdout: the channel process speaks MCP there.
 */
export const identity: Identity = readIdentity(process.env, message => void readWarnings.push(message))

/** What reading .env for `identity` warned about (a stale ALEX_BOT_NAME ignored, a renamed variable), "[identity] ..." lines. */
export const IDENTITY_WARNINGS: readonly string[] = Object.freeze(readWarnings)
