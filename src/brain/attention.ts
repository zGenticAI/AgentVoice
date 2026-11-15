// Is a line of the meeting for Alex? Decided from grammar, the way people show who they are talking to,
// so Alex stays out of side conversation ("I asked Alex yesterday", "Thanks, Alex").
// The approach and many of the word lists follow the attention engine in AMP (https://github.com/tokencanopy/amp,
// src/gateway/attention.ts), licensed under the Apache License, Version 2.0. This file is a new implementation, and
// the word lists were changed and extended for this project (see NOTICE).
//
// The name is the user's choice (src/identity.ts). "Alex" is the default, and the one these notes and the tests use.
// The rules take the name, its spellings and its mishearings as data (makeAttention), and nothing else in them
// depends on which name it is. A name that is a word these rules use (GRAMMAR_WORDS) would break them, so
// src/name-check.ts refuses one, and test/name-corpus.test.ts checks every recorded line reads the same with another name.
//
// Punctuation helps but is not needed for most lines: speech recognition often gives "alex whats the timeline",
// with no commas or capitals, and that has to work as well as "Alex, what's the timeline?". The lines that only
// punctuation can settle are in the accepted misses below.
// Answering the room when nobody asked Alex is worse than missing a line (a miss costs one repetition),
// so when the grammar is unclear, Alex stays quiet.
//
// The rules:
// - The name opens the sentence, perhaps after "hey", "so", "um", a greeting, a thank-you or an "OK"
//   ("Good morning Alex", "Great, thanks Alex", "Quick question, Alex"). Then what follows the name is checked,
//   after skipping lead-ins such as "sorry", "actually", "just", "wait", "hold on", "never mind", "quick question",
//   "one more thing", "by the way", "just to clarify", "I have two questions", "I wanted to ask" or a topic ("in
//   terms of pricing", "regarding X", "about X", "back to X"). So "alex sorry what was the timeline" and "alex in
//   terms of pricing what are the tiers" are questions.
// - Or the name ends the sentence after a comma ("So what do you think, Alex?"), or sits in it set off by commas
//   ("Before we start, Alex, introduce yourself."). A name in the middle with no comma after it is talked about:
//   "By the way, Alex is recording this, is that OK?". So is Alex introduced between commas: "Alex, Sam's
//   assistant, is recording this, is that OK?", "Alex, the AI, is listening. Shall we start?".
// - Asking is: a question mark; a question word ("what", "how", but not "what a great answer"); a word like
//   "can", "is" or "did" followed by who or what it asks about ("can you", "is it", "did we"); a request verb
//   ("tell", "check", "summarise"); "please" with a request; "you" in a question shape ("your thoughts", "you there",
//   "you could check"); or "I didn't catch that" and "I was wondering".
// - Thanks, praise, goodbyes and "stop" ask nothing, even when they start like a request: "Thanks Alex, take
//   care", "Thanks Alex, you've been very helpful", "Alex, excellent answer", "Alex, please stop", "Alex, don't
//   answer that". Nor does asking Alex to wait ("Alex, please wait", "Alex, give me a second", "Alex, can you hold
//   on a second?", "Alex, let me finish") or putting it off ("Alex, we'll come back to you"). A new question after a
//   stop or a wait, in the same sentence, is answered: "Alex, forget that, what's the launch date?" replaces the
//   question Alex was working on, as the cancel rule in text.ts also reads it. It has to start like a question or a
//   request: a tag or a remark ("Alex, stop, OK?", "Alex, stop, let's hear from Sarah, shall we?") asks nothing, nor
//   does a question that ends on someone else's name ("Alex, stop, what do you think Sarah?"). "Alex, don't the
//   docs say 30 days?" is a question, not a "don't".
// - A request to someone else is not for Alex: "Hey Alex. Sarah, can you share your screen?", "Alex, what do you
//   think, Sarah?", "Go ahead, Sarah". Nor is one to the room straight after a greeting or thanks: "Thanks Alex, can
//   everyone see my screen?", "Thanks Alex, who's next?", "Thanks Alex, who has a question?", "Cheers Alex, what do
//   people think?", or the next speaker called on: "Thanks Alex, Sarah?". A room question such as "who's next?",
//   "who else?" or "can we start?" counts only as the whole question: "Thanks Alex, can we start invoicing in
//   March?", "Thanks Alex, who else uses this product?" and "Alex? Who's next on the agenda?" are for Alex.
// - When the name opens a sentence that asks nothing, the address carries into the next sentence if that one is a
//   question or a request: "Alex, quick question. How much is it?", "Alex, Sarah thinks March. Do you agree?".
//   Not after a greeting, thanks or praise ("Thanks Alex. Did everyone get the deck?"), nor once Alex is told to
//   wait or never mind, or is put off ("Alex, hold on. Go ahead, Sarah.", "Alex, no. What do you think, Sarah?"),
//   nor when the next sentence is for someone else or the room ("Can we start without her?").
// - A line that only calls Alex ("Alex?", "Hey Alex.", "Okay, Alex.") or only announces a question ("Alex, quick
//   question.", "Alex, I have two questions.", "Alex, I wanted to ask about pricing.", "Alex, sorry.") is a call:
//   Alex says nothing, but the next thing said goes to it. After thanks or praise an announcement is the host moving
//   on, not a call ("Thanks Alex, next question."), unless the question is the speaker's own ("Thanks Alex, I have
//   another question.") or announced before the name ("Great, one more question, Alex."). Praise and then an
//   announcement are two things, not "great one": "Alex, great, one more thing, tell us about SSO." and "alex great
//   one more question does it support sso" ask. A question followed by a call with its own question mark is for
//   Alex: "What's the timeline? Alex?". After "Any other questions? OK, Alex." Alex is only called.
//
// Misses that are accepted, because catching them would make Alex answer far more things not meant for it:
// - With no comma after the name, "is", "was", "does", "did" or "has" right after it reads as a remark about Alex
//   ("alex is great at this", "alex did the demo") unless a pronoun follows ("alex is it ready", "alex did you see
//   the email", "alex are we on track"). With "it", "this" or "that", "does" and "did" ask only before a common verb
//   ("alex does it support linux", "alex did it ship") and "has" only before "been" ("alex has it been deployed"), so
//   "alex has it covered" and "alex does that automatically" are remarks, and "alex has it shipped" is missed.
//   "Last" is that verb only at the end ("alex does it last"), so "Alex did that last week" is a remark and "alex
//   does it last long" is missed.
// - A yes/no question about a thing ("the API", "the docs") needs its question mark, comma or not: "Alex, is the API
//   ready?" asks, but "Alex, is the API ready." and "alex do the docs cover sso" are missed. "alex is the api
//   ready" reads like "alex is the best".
// - A name at the end with no comma before it counts only after "think", "say" and the like ("what do you
//   think alex"). Otherwise it is usually the object of the sentence ("did you try Alex", "ping Alex"),
//   so "whats the timeline alex" stays quiet. With the comma ("What's the timeline, Alex?") it counts.
// - A capitalised word after the last comma is taken as someone else's name ("Alex, what do you think, Sarah?"),
//   so "Alex, what about the other one, Globex?" is missed. So is a capitalised word on its own after thanks or a
//   greeting ("Thanks Alex, Sarah?"), so "Thanks Alex, Okta?" is missed; "Alex, Okta?" asks. Unpunctuated, nothing
//   marks the name: "cheers alex what do you think sarah" is answered.
// - Carrying the address into the next sentence needs the full stop that ends the first one, so unpunctuated
//   "alex sarah thinks march do you agree" is missed.
// - After a thanks or a greeting, the next sentence is not carried: "Thanks Alex. Can you also check the budget?"
//   is missed. "Thanks Alex, can you also check the budget?", in one sentence, is answered. Nor after "Alex,
//   wait.": "Alex, wait. What did you say about pricing?" is missed; "Alex, wait, what did you ...?" is answered.
// - Unpunctuated, a new question after a stop word is found only where the stop clearly ends ("alex forget that
//   whats the launch date", "alex enough about pricing whats the timeline"), so "alex no need to check with sam
//   whats the launch date" is missed. And the new question has to start like one (a question word, "is it", "can
//   you", a request), so "Alex, forget that, the launch date?" and "Alex, forget that, any update?" are missed.
// - A word set off by a comma right after the name is taken as someone else's name when it starts a sentence
//   or has a capital ("Alex. Sarah, what's the status?"), so "Alex, Okta, does it support it?" is missed.

import { type AgentName, fold, identity } from '../identity.ts'

/**
 * What a line of the meeting is, as far as Alex is concerned:
 * - asked: spoken to, with a question or a request. Alex answers.
 * - called: the name alone ("Alex?", "Hey Alex.") or a question announced ("Alex, quick question."). Alex says
 *   nothing, but the next thing said goes to it.
 * - nothing_asked: spoken to, but nothing asked ("Thanks, Alex.", "Welcome, Alex", "Alex, please stop."). Alex stays quiet.
 * - mentioned: talked about, not to ("I asked Alex yesterday", "can you send this to Alex"). Alex stays quiet.
 * - no_name: the name isn't in it. Alex stays quiet.
 */
export type Attention = 'asked' | 'called' | 'nothing_asked' | 'mentioned' | 'no_name'

// Speech recognition sometimes writes the name another way: for Alex, Alec, Alexa or Aleks. These spellings count
// anywhere. It has also written "Ionics" (live, for "Alex, can you ...") and "Elix". Such mishearings are words
// too, so they count only as the first word, or the second after "hey", "hi", "ok", "okay" or "so". Real first
// names such as Alexis, Alix or Alek are left out, so Alex doesn't answer when someone talks to a colleague: only
// whole words count. They are compared folded (src/identity.ts), so "José" and "Jose" are the same name.
export const MISHEARD_AFTER: ReadonlySet<string> = new Set(['hey', 'hi', 'ok', 'okay', 'so'])

/** The names a line is read for, folded: the name and its spellings, the mishearings, and those that count for leaving. */
interface NameSets {
  names: ReadonlySet<string>
  misheard: ReadonlySet<string>
  leave: ReadonlySet<string>
}

function nameSets(agent: AgentName): NameSets {
  const name = fold(agent.name)
  return {
    names: new Set([name, ...agent.variants.map(fold)]),
    misheard: new Set(agent.misheard.map(fold)),
    leave: new Set([name, ...agent.leaveMisheard.map(fold)]),
  }
}

const NO_NAMES: NameSets = { names: new Set(), misheard: new Set(), leave: new Set() }

// The sounds of someone thinking. Not "mm-hmm", "uh-huh", "yeah" or "ok": those are answers. (While the assistant is
// talking they are only backchannels, below: no reason for it to stop. Once it has finished, they still answer it.)
const FILLER = /^(?:u+h*m+|u+h+|e+r+m*|h+m+|a+h+)$/

// While someone else talks, the sounds and short words people make to show they are listening, or to give way:
// "mm-hm", "uh-huh", "yeah", "okay", "right", "sure", "I see", "oh, sorry, go ahead", a laugh. Said over the assistant,
// a line of only these (and the fillers above) is no reason for it to stop talking. Not "no", "wait", "stop", "thanks"
// or the name: those are someone taking the floor. Sounds as speech recognition spells them, drawn out or not: "mm",
// "mhm", "mmhmm" ("mm-hmm" is "mm" and "hmm"), "huh" ("uh-huh"), "nuh" ("nuh-uh"), "aha", "ha", "haha", "heh", "oh",
// "ooh", "wow", "whoa". None of these words are in GRAMMAR_WORDS: a name that is one of them only makes the assistant
// stop more readily (the name always counts), while refusing them would refuse names that work today, such as True.
const BACKCHANNEL_SOUND = /^(?:m+(?:h+m+)?|h+u+h+|n+u+h+|a+h+a+|(?:h+a+)+h*|h+e+h+(?:e+h*)*|o+h+|w+o+w+|w+h+o+a+)$/
const BACKCHANNEL_WORDS = new Set([
  'yeah', 'yea', 'yah', 'ya', 'yep', 'yup', 'yes', 'ok', 'okay', 'right', 'alright', 'sure', 'cool', 'nice', 'great', 'good',
  'fine', 'true', 'totally', 'exactly', 'absolutely', 'definitely', 'indeed', 'gotcha', 'interesting', 'really', 'perfect',
  'awesome', 'sorry', 'agreed', 'correct', 'oops',
])
// Phrases that are a backchannel only as a whole: "I see", but not "I" or "see" on their own.
const BACKCHANNEL_PHRASES = [
  'i see', 'got it', 'all right', 'of course', 'fair enough', 'makes sense', 'that makes sense', 'sounds good', 'go on',
  'go ahead', 'carry on', 'keep going', "that's right", "that's true", 'my bad', 'oh well',
].map(p => p.split(' '))

// Words that can come before the name and still leave it a call: "Hey Alex", "So, Alex", "Um, Alex".
const CALL_WORDS = new Set(['hey', 'ok', 'okay', 'so', 'well', 'right', 'alright', 'and', 'but', 'also', 'now', 'oh'])
// A greeting, a thank-you or an acknowledgement can also open an address ("Good morning Alex, can you give us
// a recap?", "Great, thanks Alex, and what about the timeline?"), but on its own it asks nothing, and it is not a
// call: "Hi Alex", "Thanks, Alex" and "Perfect, Alex" leave Alex quiet.
const GREETINGS = new Set([
  'hi', 'hello', 'bye', 'goodbye', 'thanks', 'cheers', 'welcome', 'morning', 'afternoon', 'evening', 'great', 'perfect', 'cool', 'awesome',
  'nice', 'excellent', 'brilliant', 'lovely', 'fantastic', 'wonderful', 'yes', 'yeah', 'yep', 'sure', 'yo',
])
// Praise: "Alex, excellent answer." and "Brilliant summary, Alex." ask nothing, though "answer" or "summary"
// alone would be a request. Each word of the first list goes with each of the second.
const PRAISE = [
  'good', 'great', 'nice', 'excellent', 'brilliant', 'perfect', 'awesome', 'lovely', 'fantastic', 'wonderful', 'cool', 'fair', 'amazing',
]
const PRAISED = ['answer', 'point', 'question', 'summary', 'job', 'work', 'one', 'stuff', 'call', 'explanation', 'catch', 'idea']
const GREETING_PAIRS = new Set([
  'thank you', 'many thanks', 'good morning', 'good afternoon', 'good evening', 'hey there', 'hi there', 'hello there',
  'welcome back', 'got it', 'well done', ...PRAISE.flatMap(adjective => PRAISED.map(thing => `${adjective} ${thing}`)),
])
// The greetings that open a conversation. After these an announcement is still a call ("Hi Alex, quick question.").
// After thanks, praise or "yes" it is the host moving on ("Thanks Alex, next question."), so it is not, unless
// the speaker says the question is their own ("Thanks Alex, I have another question.").
const SALUTATIONS = new Set([
  'hi', 'hello', 'morning', 'afternoon', 'evening', 'yo', 'welcome', 'good morning', 'good afternoon', 'good evening', 'hey there',
  'hi there', 'hello there', 'welcome back',
])
const THANKS = new Set(['thanks', 'thank you', 'many thanks'])
// What people add after a thank-you: "thank you so much", "thanks again".
const MORE_THANKS = [['so', 'much'], ['very', 'much'], ['a', 'lot'], ['a', 'ton'], ['again']]

// What people say between the name and the question. Skipped when looking for what is asked, so
// "alex quick question what is the timeline" is a question, and on their own they make a call.
// Many are made from parts: "I have" or "I've got", then "a", "two" or "a couple of", then "question(s)", as in
// "Alex, I have two questions." or "Alex, I had a question."; and "I wanted to ask (you something)".
const HAVE = ['', 'i have', "i've got", 'i got', 'i had', 'we have', "we've got"]
const HOW_MANY = [
  'a', 'one', 'two', 'three', 'a couple of', 'a couple', 'a few', 'some', 'another', 'one more', 'a few more', 'a couple more',
  'two more', 'one last',
]
const QUESTIONS = ['question', 'questions', 'quick question', 'quick questions', 'follow up', 'follow up question', 'follow up questions']
const WANT_TO_ASK = ['i want to ask', 'i wanted to ask', "i'd like to ask", 'i would like to ask', 'i need to ask', 'let me ask']
const ANNOUNCEMENTS = [
  'quick question', 'question', 'last question', 'next question', 'follow up', 'followup', 'quick follow up', 'real quick',
  'quick one', 'one more thing', 'one last thing', 'last thing', 'another thing',
  ...HAVE.flatMap(have => HOW_MANY.flatMap(n => QUESTIONS.map(q => `${have} ${n} ${q}`.trim()))),
  ...WANT_TO_ASK.flatMap(ask => ['', ' you', ' something', ' you something', ' a question', ' you a question'].map(what => ask + what)),
  "here's a question", 'here is a question', 'heres a question', "here's my question", 'here is my question', 'heres my question',
  'my question is', 'my next question is', 'just to clarify', 'just to confirm', 'just to check', 'just to be clear',
]
// Asides that are skipped, but on their own announce nothing ("Alex, actually." is not a call).
const ASIDES = [
  'actually', 'just', 'quickly', 'by the way', 'just checking', 'just wondering', 'just curious', 'out of curiosity',
  'anyway', 'so you know', 'just so you know', 'as you know', 'fyi', 'for your information', 'heads up', 'a heads up',
  'just a heads up',
]
// Asking Alex to wait, or telling it never mind. Skipped like the asides, so "Alex, hold on, what's the timeline?"
// and "Alex, never mind, what time is it?" ask. On their own they put Alex on hold: nothing is asked, and the next
// sentence is not taken as Alex's ("Alex, hold on. Go ahead, Sarah.", "Alex, never mind. What's next on the agenda?").
const HOLDS = [
  ...['wait', 'hold on', 'hang on', 'hold up'].flatMap(hold => ['', ' a sec', ' a second', ' a moment', ' a minute'].map(t => hold + t)),
  ...['one', 'just a', 'just one'].flatMap(n => ['sec', 'second', 'moment', 'minute'].map(t => `${n} ${t}`)),
  ...['never mind', 'nevermind'].flatMap(never => ['', ' that', ' about that'].map(what => never + what)),
]
// "Sorry" after the name is usually the start of "sorry, what was that?", so on its own it is a call.
// Before the name ("Sorry, Alex.") it is an apology, like a greeting.
const APOLOGIES = ['sorry', 'sorry to interrupt', 'sorry to bother you', 'sorry to jump in', 'excuse me', 'pardon me']
// A topic before the question: "in terms of pricing, what are the tiers?".
const TOPICS = [
  'in terms of', 'regarding', 'about', 'on', 'back to', 'going back to', 'coming back to', 'as for', 'when it comes to',
  'speaking of', 'with regard to', 'with regards to', 'on the topic of', 'on the subject of',
]
type LeadKind = 'announce' | 'aside' | 'hold' | 'apology' | 'topic'
// The lead-ins by their first word (so the long generated lists cost nothing), the longest first, so "sorry to
// interrupt" wins over "sorry".
const LEAD_INS = new Map<string, [string[], LeadKind][]>()
const KINDS = [[ANNOUNCEMENTS, 'announce'], [ASIDES, 'aside'], [HOLDS, 'hold'], [APOLOGIES, 'apology'], [TOPICS, 'topic']] as const
for (const [phrases, kind] of KINDS) {
  for (const phrase of phrases) {
    const words = phrase.split(' ')
    const leads = LEAD_INS.get(words[0]) ?? []
    if (!leads.some(([known]) => known.join(' ') === phrase)) leads.push([words, kind])
    LEAD_INS.set(words[0], leads)
  }
}
for (const leads of LEAD_INS.values()) leads.sort((a, b) => b[0].length - a[0].length)

// Verbs that start a request: "Alex, tell us about the project", "alex check that". A closed list on purpose:
// guessing at what looks like a verb makes Alex answer remarks.
const REQUESTS = new Set([
  'add', 'answer', 'break', 'brief', 'calculate', 'check', 'clarify', 'compare', 'confirm', 'continue', 'define', 'describe',
  'draft', 'elaborate', 'estimate', 'expand', 'explain', 'find', 'give', 'go', 'help', 'introduce', 'list', 'look', 'note',
  'outline', 'pull', 'quote', 'read', 'recap', 'remember', 'remind', 'repeat', 'review', 'run', 'say', 'share',
  'show', 'spell', 'start', 'suggest', 'sum', 'summarise', 'summarize', 'take', 'talk', 'tell', 'translate', 'walk', 'write',
])

// Words that open a question. Contractions are here because people say "what's" far more than "what is",
// and speech recognition may drop the apostrophe.
const QUESTION_WORDS = new Set([
  'what', 'whats', "what's", 'how', 'hows', "how's", 'when', 'whens', "when's", 'where', 'wheres', "where's", 'who', 'whos',
  "who's", 'whom', 'whose', 'which', 'why', 'whys', "why's",
])
// "Alex, any thoughts?", "Alex, anything else?".
const ANY = new Set(['any', 'anything'])
// These open a question only when who or what it asks about comes next: "do you", "is it", "have we".
// "Don't answer that", "have a good one" and "will do" ask nothing.
const AUXILIARIES = new Set([
  'is', "isn't", 'isnt', 'are', "aren't", 'arent', 'was', "wasn't", 'wasnt', 'were', "weren't", 'werent', 'am', 'do', "don't",
  'dont', 'does', "doesn't", 'doesnt', 'did', "didn't", 'didnt', 'have', "haven't", 'havent', 'has', "hasn't", 'hasnt', 'had',
  "hadn't", 'hadnt',
])
const ASKED_ABOUT = new Set(['you', 'we', 'i', 'it', 'they', 'there', 'he', 'she', 'this', 'that', 'your', 'our'])

const YOU = new Set(['you', 'your', 'yours', "you're", 'youre', "you've", "you'll", "you'd"])
// "Alex, your thoughts?" and "alex your take on pricing" ask; "Alex, your slides are great" and "your thoughts
// were spot on" don't: the word has to end the line or be followed by what it is about.
const YOUR_ASKS = new Set([
  'thoughts', 'thought', 'take', 'view', 'views', 'opinion', 'opinions', 'input', 'feedback', 'verdict', 'recommendation',
  'advice', 'guess', 'call', 'pick', 'suggestion', 'suggestions', 'idea', 'ideas', 'turn',
])
const YOUR_ASKS_ON = new Set(['on', 'about', 'here', 'please', 'regarding', 'for', 're', 'then', 'now'])
// "Alex, you could check the numbers" asks; "Alex, you can stop now" and "you could be right" don't.
const YOU_POLITE = new Set(['can', 'could', 'might', 'may', 'should', 'would'])
const YOU_NOT_ASKED = new Set([
  'stop', 'relax', 'rest', 'go', 'leave', 'sit', 'skip', 'ignore', 'hold', 'wait', 'be', 'drop', 'hang', 'mute', 'pause',
  'keep', 'take', 'have', 'see', 'hear', 'not', 'never',
])

// People talking to the room, not to Alex: "Thanks Alex. Did everyone get the deck?", "Can we move on?",
// "Thanks Alex, who's next?", "Can we start without her?".
const ROOM = new Set(['everyone', 'everybody', 'anyone', 'anybody', 'guys', 'folks', 'team', 'yall', "y'all", 'others'])
// These count anywhere in the first words: "Thanks Alex, can we move on to pricing?".
const TO_THE_ROOM = new RegExp(` (?:${[
  'you all', 'you guys', 'all of you', 'the rest of you', 'any (?:other |more |further )?questions', 'move on', 'moving on',
  'get started', 'wrap up', 'next (?:slide|item|topic|agenda item)',
].join('|')})\\b`)
// These count only as the whole of a short question, because they also start questions for Alex: "Thanks Alex,
// who's next?" is for the room, "Alex? Who's next on the agenda?" and "Thanks Alex, can we start invoicing in
// March?" are not; nor is "who else uses this product?" or "who has the contract?".
const ROOM_QUESTION = new RegExp(`^ (?:so |and |ok |okay |then |now )?(?:${[
  "who(?:'?s| is) (?:next|up|up next|going next|going first|first)",
  "who(?: else)?(?:'?s| has| have)(?: got)? (?:(?:a|any|another|the next|the first|more|other) )?(?:questions?|follow ups?)" +
    '(?: (?:for|about|on) \\S+(?: \\S+)?)?',
  "who(?: else)?(?: wants| would like|'?d like) to(?: \\S+){0,5}",
  'who else',
  'what do (?:people|others|folks|we all|you all|you guys) think(?: (?:about|of) (?:that|this|it))?',
  '(?:can|could|should|shall) we (?:start|begin|kick off|get going|carry on|continue|proceed|wait)' +
    '(?: (?:now|already|yet|here|a (?:moment|minute|sec|second)|for (?:him|her|them|\\S+)|without (?:him|her|them|\\S+)))?',
  'start without (?:him|her|them|\\S+)',
].join('|')})(?: (?:then|now|please))? $`)
// Words that can start a sentence and be followed by a comma without being someone's name.
const NOT_A_NAME = new Set([
  'i', 'no', 'please', 'honestly', 'seriously', 'frankly', 'basically', 'first', 'second', 'third', 'finally', 'then',
  'again', 'listen', 'look', 'plus', 'otherwise', 'ideally', 'realistically', 'personally', 'obviously', 'hopefully',
  'specifically', 'still', 'sorry', 'actually', 'anyway', 'wait', 'interesting', 'exactly', 'true', 'fine', 'agreed',
])
// Capitalised words that can end a question after a comma without being someone's name: "Is it due, Friday?".
const NOT_A_NAME_AT_THE_END = new Set([
  'now', 'then', 'too', 'again', 'here', 'there', 'today', 'tomorrow', 'yesterday', 'right', 'ok', 'okay', 'yes', 'no', 'please',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march', 'april', 'may',
  'june', 'july', 'august', 'september', 'october', 'november', 'december', 'inc', 'ltd', 'llc', 'corp', 'plc',
])

// Telling Alex to stop, or that nothing is needed. Not a request, unless a new question follows in the same
// sentence ("Alex, forget that, what's the launch date?"): that one replaces the last (see asks()).
const STOP = new RegExp(`^ (?:please )?(?:${[
  'stop', 'be quiet', 'quiet', 'shush', 'hush', 'shut up', 'enough', "that'?s enough", "that'?s all", 'that will do', "that'?ll do",
  'cancel', 'forget', 'ignore', 'disregard', 'scratch that', 'no need', 'not now', 'no thanks', 'no thank you', 'leave it',
  'skip it', 'pause', 'mute', 'do not', 'you can stop', 'you can be quiet', "you don'?t need",
  // "Don't" but not "don't you ...?" or "don't the docs say 30 days?", which are questions.
  "don'?t(?! (?:you|we|i|they|the|these|those|our|your|my|their|his|her|its)\\b)",
  'you do not need', "you don'?t have to", "you needn'?t", 'take a break', 'take five', 'go to sleep', 'go away', 'stay quiet',
  'keep quiet', 'be silent', 'silence',
].join('|')}) `)
// The stop words that call off what was just asked, and what they call off, whose end is clear without a comma,
// so that in "alex forget that whats the launch date" the new question can be found.
const CALL_OFF = new Set(['forget', 'scratch', 'ignore', 'disregard', 'cancel'])
const CALLED_OFF = [
  'that', 'it', 'this', 'that question', 'my question', 'my last question', 'the last question', 'my previous question',
  'the previous question', 'the last one', 'what i said', 'what i asked', 'what i just said', 'what i just asked',
].map(p => p.split(' ')).sort((a, b) => b.length - a.length)
// The stop words that close the exchange with Alex. A question after them is the host moving on, not a new
// question for Alex: "Alex, that's all the questions I had, what's next?".
const DONE = /^ (?:please )?(?:that'?s all|that will do|that'?ll do|no thanks|no thank you)\b/
// Asking Alex to wait: "Alex, please wait", "Alex, give me a second", "Alex, let me stop you there", and a bare
// "Alex, no." Not a request, and the next sentence is not taken as Alex's: the floor is going to someone else.
// Like a stop word, a new question may follow in the same sentence ("Alex, give me a second, what was the number
// again?"). "Wait" and "hold on" on their own are lead-ins (HOLDS above).
const HOLD = new RegExp(`^ (?:please |just )*(?:${[
  'wait', 'hold on', 'hang on', 'hold up', 'let me finish', 'let me stop you', 'let me (?:just )?interrupt', 'bear with (?:me|us)',
  'give (?:me|us) (?:a|one|just a) (?:sec|second|moment|minute)', 'hold that thought', 'no(?: no)*(?= $)',
].join('|')})\\b`)
// Asking Alex to wait, politely: "Alex, can you hold on a second?", "Alex, could you give me a moment?". Only as the
// whole line: "Alex, can you wait until Sarah joins?" is a question.
const POLITE_HOLD = new RegExp(`^ (?:can|could|would|will) you (?:please |just )*(?:${[
  'wait', 'hold on', 'hang on', 'hold up', 'bear with (?:me|us)', 'hold that thought',
  'give (?:me|us) (?:a|one|just a) (?:sec|second|moment|minute)',
].join('|')})(?: (?:a|one|just a) (?:sec|second|moment|minute|bit)| for (?:a |one )?(?:sec|second|moment|minute|bit)` +
  '| for (?:me|us)| please| now| there)* $')
// After a stop or a wait, these are tags, not a new question: "Alex, stop, can you?", "Alex, stop, is that clear?".
const TAG = new RegExp(`^ (?:${[
  "(?:can|could|will|would|won'?t|wont|shall|should|do|don'?t|dont|did|didn'?t|didnt|is|isn'?t|isnt|are|aren'?t|arent|was|wasn'?t|wasnt)" +
    ' (?:you|we|i|it|they|that|he|she|there)(?: not)?',
  'is that (?:alright|all right|clear|understood|fine|right|correct)', '(?:do|would) you mind',
].join('|')})(?: (?:please|then|now|ok|okay))? $`)
// Putting Alex off: "Alex, we'll come back to you", "Alex, I'll get back to you on that", "Alex, just listen in
// for now". Never a request, whatever follows: a question after it is for the room or the next speaker.
const PUT_OFF = new RegExp(`^ (?:${[
  "(?:we|i)(?:'?ll| will) (?:come|get) back to you", "let'?s come back to you", 'listen in',
].join('|')})\\b`)
// Thanks, compliments, agreement and goodbyes. Not a request, unless a question mark says otherwise.
const PLEASANTRY = new RegExp(`^ (?:${[
  'take care', 'talk soon', 'talk later', 'talk to you (?:soon|later)', 'speak soon', 'speak later', 'catch you later',
  'see you', 'see ya', 'bye', 'goodbye', 'good night', 'have a (?:good|great|nice|lovely|wonderful) \\w+', 'cheers',
  'appreciate (?:it|that|you)', 'much appreciated', 'well done', 'nicely done', 'welcome',
  `(?:${PRAISE.join('|')}) (?:${PRAISED.join('|')})`,
  '(?:nice|good|great|lovely) to (?:have|see|meet|hear|know)', 'glad (?:to have|you)', 'thanks?', 'thank you',
  "you'?ve been", "you'?re (?:welcome|right|the best|a star|great|amazing|brilliant|awesome|correct|a lifesaver)",
  'you were (?:right|great|helpful|brilliant|amazing|awesome|correct)', 'you nailed it', 'you got it', 'will do',
  "that'?s (?:great|perfect|helpful|right|correct|fine|fair|good|brilliant|awesome|it|all|useful|really helpful|very helpful)",
  'exactly', 'spot on', 'perfect', 'makes sense', 'got it', 'noted', 'understood', 'fair enough', 'no worries',
  'no problem', 'all good', 'i agree', 'agreed', 'love (?:it|that)', 'look(?:ing)? forward', 'what an? ', 'interesting',
  "that'?s (?:a )?(?:good|great|fair|valid|nice|interesting) (?:point|question|idea)",
].join('|')})\\b`)
// Asking Alex to say it again: "Alex, sorry, I didn't catch that."
const REPEAT = new RegExp(`^ (?:${[
  "i (?:didn'?t|did not|couldn'?t|could not) (?:quite )?(?:catch|hear|get)", 'i missed', 'come again', 'one more time', 'pardon',
  'say again',
].join('|')})\\b`)
// A question asked the long way round: "Alex, I was wondering what the pricing is."
const WONDER = new RegExp(`^ (?:${[
  'i was wondering', "i'?m wondering", 'i am wondering', 'i wonder', "i'?d like to know", 'i would like to know', 'i want to know',
  "i'?m curious", 'i am curious', 'i need you to', 'we need you to', "i'?d like you to", 'i want you to', "i'?d love to hear",
  "we'?d love to hear",
].join('|')})\\b`)

// Verb forms that only follow a subject. Right after the name with no comma, they mean the name is the
// subject, so Alex is being talked about: "Alex said the demo went well", "alex is great at this".
const STATEMENTS = new Set([
  'answered', 'answers', 'asked', 'asks', 'believes', 'brought', 'built', 'called', 'calls', 'came', 'checked', 'checks',
  'comes', 'did', "didn't", 'does', "doesn't", 'explained', 'explains', 'found', 'gave', 'gets', 'goes', 'got', 'had', "hadn't",
  'handled', 'handles', 'has', "hasn't", 'helped', 'helps', 'is', "isn't", 'joined', 'joins', 'kept', 'knew', 'knows', 'left',
  'liked', 'likes', 'looked', 'looks', 'made', 'makes', 'means', 'meant', 'mentioned', 'mentions', 'needed', 'needs', 'put',
  'ran', 'reckons', 'replied', 'said', 'saw', 'says', 'seemed', 'seems', 'sent', 'sends', 'showed', 'shows', 'sounded', 'sounds',
  'started', 'suggested', 'suggests', 'takes', 'thinks', 'thought', 'told', 'took', 'tried', 'tries', 'used', 'uses', 'wanted',
  'wants', 'was', "wasn't", 'went', 'were', "weren't", 'worked', 'works', 'wrote', 'writes',
])
// "Alex will join later" and "Alex can handle that" are about Alex; "alex can you check" and "alex should
// we wait" ask it. After the name, a word like "can" or "will" starts a question only when someone or
// something comes next.
const MODALS = new Set([
  'can', 'could', 'would', 'will', 'should', 'shall', 'may', 'might', 'must', "can't", 'cant', "couldn't", 'couldnt',
  "wouldn't", 'wouldnt', "won't", "shouldn't", 'shouldnt',
])
const SUBJECTS = new Set(['i', 'you', 'we', 'they', 'he', 'she', 'it', 'this', 'that', 'there', 'the', 'a', 'an', 'my', 'our', 'your', 'anyone', 'someone', 'everyone'])
// With no comma after the name, "is", "did" and the like make a question only with a subject that fits them:
// "alex did you", "alex is it", "alex were we", but not "alex has you covered".
const SINGULAR = new Set(['is', "isn't", 'was', "wasn't", 'has', "hasn't", 'does', "doesn't"])
const PLURAL = new Set(['were', "weren't"])
const COPULAS = new Set(['is', "isn't", 'was', "wasn't", 'were', "weren't"])
// "alex was there a decision" asks; "alex was there yesterday" doesn't.
const AFTER_THERE = new Set([
  'a', 'an', 'any', 'anything', 'anyone', 'anybody', 'some', 'something', 'someone', 'much', 'many', 'more', 'another',
  'enough', 'no', 'still', 'really', 'one', 'been',
])
// "alex does it support linux" and "alex did it work" ask; "alex did it again", "alex does that automatically" and
// "alex has it covered" are remarks. So after "does it" or "did that", only a plain verb from this list makes a
// question. A closed list on purpose, like REQUESTS: guessing at what looks like a verb makes Alex answer remarks.
// "Last" is a verb only when it ends the sentence ("does it last?"): "Alex did that last week" is a remark.
const BARE_VERBS = new Set([
  'support', 'work', 'include', 'need', 'matter', 'cover', 'have', 'help', 'mean', 'make', 'run', 'use', 'handle', 'cost', 'come',
  'go', 'change', 'happen', 'take', 'look', 'sound', 'affect', 'apply', 'integrate', 'require', 'scale', 'count', 'ship', 'break',
  'fail', 'pass', 'cause', 'connect', 'sync', 'show', 'say', 'get', 'do', 'hurt', 'last', 'fit', 'allow', 'let', 'store', 'keep',
  'send', 'save', 'record',
])
const ADVERBS = new Set([
  'just', 'also', 'already', 'actually', 'really', 'never', 'probably', 'totally', 'clearly', 'always', 'still', 'even',
  'basically', 'definitely', 'apparently', 'obviously', 'literally', 'usually', 'often', 'sometimes',
])
// "Alex and I talked about it" is about Alex.
const PRONOUNS = new Set(['i', 'me', 'you', 'we', 'he', 'she', 'they', 'him', 'her', 'them', 'us', 'my', 'his', 'their', 'our', 'your'])
// A topic's last word can't be one of these: in "about the help desk", "help" is still part of the topic.
const DETERMINERS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'our', 'your', 'my', 'their', 'his', 'her', 'its', 'some', 'any',
])

// The only verbs after which a name at the end counts with no comma: nobody thinks or recommends a person,
// so "what do you think alex" can only be said to Alex.
const OPINIONS = new Set(['think', 'reckon', 'feel', 'suggest', 'recommend', 'advise', 'say'])

interface Word {
  /** The word in lower case, with curly apostrophes made straight. */
  text: string
  /** The word as it was written, for its capital letter. */
  raw: string
  /** What comes after it, up to the next word: spaces and punctuation. */
  after: string
  /** It is the assistant's name here (or a spelling or mishearing of it that counts where it is). */
  name: boolean
  /** It starts a sentence, so a capital letter says nothing about it. */
  initial: boolean
}

const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu
const ASCII = /^[\x00-\x7f]*$/

function wordsOf(text: string, sets: NameSets): Word[] {
  // In NFC, so an accent written as a separate mark doesn't split a word in two.
  if (!ASCII.test(text)) text = text.normalize('NFC')
  const found = [...text.matchAll(WORD)]
  const words = found.map((m, i) => ({
    text: m[0].toLowerCase().replace(/’/g, "'"),
    raw: m[0],
    after: text.slice(m.index + m[0].length, found[i + 1]?.index),
    name: false,
    initial: false,
  }))
  words.forEach((word, i) => {
    const bare = foldWord(word.text.split("'")[0])
    word.name = sets.names.has(bare) || (sets.misheard.has(bare) && (i === 0 || (i === 1 && MISHEARD_AFTER.has(words[0].text))))
    word.initial = i === 0 || /[.!?]/.test(words[i - 1].after)
  })
  return words
}

/** A lower-case word folded to compare with the names: only a word with accents needs the work. */
const foldWord = (word: string): string => (ASCII.test(word) ? word : fold(word))
const isFiller = (word: Word): boolean => FILLER.test(word.text)
const textOf = (words: Word[]): string => ` ${words.map(w => w.text).join(' ')} `
const endsOnMark = (words: Word[]): boolean => words.length > 0 && words[words.length - 1].after.includes('?')
const matches = (words: Word[], i: number, phrase: string[]): boolean => phrase.every((p, k) => words[i + k]?.text === p)

/** Splits the words into sentences, at . ! or ? followed by a space. */
function sentencesOf(words: Word[]): Word[][] {
  const sentences: Word[][] = []
  let sentence: Word[] = []
  for (const word of words) {
    sentence.push(word)
    if (/[.!?]["'’”)\]]*\s/.test(word.after)) {
      sentences.push(sentence)
      sentence = []
    }
  }
  if (sentence.length) sentences.push(sentence)
  return sentences
}

/** Nothing but the name, give or take "hey", "so" or "um": "Alex?", "Hey Alex.". "Alex's" is not a call. */
function isCall(words: Word[]): boolean {
  return words.some(w => w.name) && words.every(w => (w.name ? !w.text.includes("'") : CALL_WORDS.has(w.text) || isFiller(w)))
}

/** What the openers and lead-ins at the start of some words were, and where what is said begins. */
interface Opening {
  /** The first word after them. */
  end: number
  /** A greeting, a thank-you or a compliment was among them ("hi", "thanks", "great", "good morning"). */
  greets: boolean
  /** Of those, one that is not a hello: thanks, praise, "yes" or a goodbye ("thanks", "great", "perfect", "bye"). */
  acknowledges: boolean
  /** A question was announced ("quick question", "one more thing", "I have a question about pricing"). */
  announces: boolean
  /** The speaker announced a question of their own ("I have a question", "I wanted to ask", "my question is"). */
  ownQuestion: boolean
  /** "Sorry" came after the name. */
  apologises: boolean
  /** Alex was asked to wait or told never mind ("wait", "hold on", "one second", "never mind"). */
  holds: boolean
}

/**
 * Skips the openers ("hey", "so", "um", "thanks", "good morning", the name said again) and lead-ins ("sorry",
 * "quick question", "in terms of pricing") at the start of these words. `beforeName` is true for the words
 * before the name: there, a topic may run up to the name after a comma ("Regarding pricing, Alex, ...") and
 * "sorry" is an apology, like a greeting.
 *
 * Two words make a greeting or compliment ("good morning", "great answer") only when said together: "great, one
 * more thing" is praise and then an announcement (a pause after a word that greets on its own splits the pair),
 * and so is "great one more question". `leaveRule` is set for spokenTo(), which keeps the reading the leave rule
 * in text.ts was reviewed with: there, any pair counts.
 */
function opening(words: Word[], beforeName = false, leaveRule = false): Opening {
  const o: Opening = { end: 0, greets: false, acknowledges: false, announces: false, ownQuestion: false, apologises: false, holds: false }
  let i = 0
  let thanked = false
  const greet = (greeting: string, length: number) => {
    o.greets = true
    if (!SALUTATIONS.has(greeting)) o.acknowledges = true
    i += length
  }
  while (i < words.length) {
    const word = words[i]
    const more = thanked ? MORE_THANKS.find(phrase => matches(words, i, phrase)) : undefined
    if (more) {
      i += more.length
      continue
    }
    const pair = `${word.text} ${words[i + 1]?.text}`
    thanked = THANKS.has(pair) || THANKS.has(word.text)
    const together = leaveRule || (
      !(/[,:;.!?—–]/.test(word.after) && GREETINGS.has(word.text)) &&
      !(words[i + 1]?.text === 'one' && ['more', 'last'].includes(words[i + 2]?.text))
    )
    if (together && GREETING_PAIRS.has(pair)) {
      greet(pair, 2)
    } else if (word.name || CALL_WORDS.has(word.text) || isFiller(word)) {
      i++
    } else if (GREETINGS.has(word.text)) {
      greet(word.text, 1)
    } else {
      const lead = leadIn(words, i, beforeName ? 'name' : o.announces ? 'announced' : 'question')
      if (!lead) break
      if (lead.kind === 'announce') o.announces = true
      if (lead.kind === 'announce' && ['i', "i've", "i'd", 'my', 'let'].includes(word.text)) o.ownQuestion = true
      if (lead.kind === 'hold') o.holds = true
      if (lead.kind === 'apology') {
        if (beforeName) o.greets = true
        else o.apologises = true
      }
      i = lead.end
    }
  }
  o.end = i
  return o
}

/**
 * What may follow a topic such as "pricing" in "about pricing": a question ("about pricing, what are the tiers?"),
 * nothing more after an announcement ("I have a question about pricing."), or, before the name, a comma and
 * the name ("Back to pricing, Alex, what are the tiers?").
 */
type TopicEnds = 'question' | 'announced' | 'name'

/** The lead-in starting at word i, if there is one, and where it ends. */
function leadIn(words: Word[], i: number, topicEnds: TopicEnds): { end: number; kind: LeadKind } | undefined {
  for (const [phrase, kind] of LEAD_INS.get(words[i].text) ?? []) {
    if (!matches(words, i, phrase)) continue
    let end = i + phrase.length
    if (kind === 'announce' && matches(words, end, ['for', 'you'])) end += 2
    if (kind === 'topic') {
      const topic = topicEnd(words, end, topicEnds)
      if (topic === undefined) continue
      end = topic
    }
    return { end, kind }
  }
  return undefined
}

/**
 * Where a topic such as "pricing" in "in terms of pricing, what are the tiers?" ends: at a comma or other
 * pause, or just before the question starts. A topic of more than five words, or one that runs to the end
 * ("Alex, about pricing?"), isn't skipped, unless it follows an announcement ("I have a question about pricing").
 * Before the name it needs a comma: in "in terms of the work alex did it was great", Alex is talked about.
 */
function topicEnd(words: Word[], from: number, ends: TopicEnds): number | undefined {
  if (words[from]?.text === 'to') return undefined // "about to ...", not a topic
  // The last word is left out: a topic that ends the sentence is not followed by a question.
  for (let i = from; i < words.length - 1 && i < from + 5; i++) {
    if (words[i].name) return undefined
    if (i > from && startsQuestion(words.slice(i)) && !DETERMINERS.has(words[i - 1].text)) return i
    if (/[,:;.!?—–]|\s-/.test(words[i].after)) return i + 1
  }
  const short = words.length > from && words.length - from <= 5 && !words.slice(from).some(w => w.name)
  // "I had a question about pricing but Sarah answered it" goes on with a remark, so it announces nothing.
  if (ends === 'announced') return short && !words.slice(from).some(w => w.text === 'but') ? words.length : undefined
  if (ends === 'name') return short && /[,:;—–]/.test(words[words.length - 1].after) ? words.length : undefined
  return undefined
}

/**
 * True when these words start as a question: "what ...", "can you ...", "is it ...", "your thoughts", "please ...".
 * Request verbs are left out, because so many of them are nouns too: "on Monday we'll review the numbers".
 */
function startsQuestion(said: Word[]): boolean {
  const [first, second] = said.map(w => w.text)
  return (QUESTION_WORDS.has(first) && !(first === 'what' && (second === 'a' || second === 'an'))) || inQuestionOrder(said) ||
    youAsks(said) || ANY.has(first) || (first === 'please' && said.length > 1)
}

/** True when the words open as a question in question order: "can you", "is it", "did we", "will the API". */
function inQuestionOrder(said: Word[]): boolean {
  const [first, second] = said
  if (!second || /[,:;.!?—–]/.test(first.after)) return false
  if (MODALS.has(first.text)) return SUBJECTS.has(second.text)
  return (AUXILIARIES.has(first.text) || first.text === 'am') && ASKED_ABOUT.has(second.text)
}

/** True when "you" starts a question shape: "your thoughts", "you there", "you know the price", "you could check". */
function youAsks(said: Word[]): boolean {
  const [first, second, third, fourth] = said.map(w => w.text)
  if (first === 'your') return YOUR_ASKS.has(second) && (!third || YOUR_ASKS_ON.has(third))
  if (first !== 'you' || !second) return false
  // "Alex, you there?", "alex you still there", "you with us".
  if (['there', 'around'].includes(second) || `${second} ${third}` === 'still there' || `${second} ${third}` === 'with us') return true
  if (second === 'know') {
    // "alex you know the price", but not "you know, it's been a long day" or "you know what, never mind".
    if (!third || said[1].after.includes(',')) return false
    if (third === 'what' && (!fourth || said[2].after.includes(','))) return false
    const then = said.slice(third === 'what' ? 3 : 2)
    return then[0]?.text !== 'never' && !STOP.test(textOf(then))
  }
  if (!YOU_POLITE.has(second)) return false
  const verb = said.slice(2).find(w => !['just', 'also', 'maybe', 'perhaps', 'now', 'please'].includes(w.text))
  return !!verb && !YOU_NOT_ASKED.has(verb.text)
}

/**
 * True when these words, said right after Alex's name, are for someone else: another person named before the
 * question ("Sarah, can you share your screen?") or after it, following a comma ("What do you think, Sarah?"); the
 * floor handed over ("go ahead sarah", "over to Sarah"); or, when `room` is set, everyone ("did everyone get the
 * deck?", "can we move on?", "who's next?"). When `greeted` is set (after thanks or a greeting), a name on its own
 * is the next speaker called on: "Thanks Alex, Sarah?". Without the thanks, "Alex, Okta?" asks Alex about Okta.
 */
function forSomeoneElse(said: Word[], room: boolean, greeted = false): boolean {
  const first = said[0]
  const word = first.text
  const anotherName = said.length > 1 && /^\s*,/.test(first.after) && (first.initial || /^\p{Lu}/u.test(first.raw)) && !first.name &&
    !NOT_A_NAME.has(word) && !QUESTION_WORDS.has(word) && !AUXILIARIES.has(word) && !MODALS.has(word) && !REQUESTS.has(word) &&
    !YOU.has(word) && !ANY.has(word) && !said.some((w, i) => i > 0 && w.text === 'both')
  if (anotherName || endsOnAnotherName(said) || handsOver(said)) return true
  const alone = said.length === 1 && endsOnMark(said) && looksLikeAName(first) && !QUESTION_WORDS.has(word) && !ANY.has(word)
  if (greeted && alone) return true
  if (!room) return false
  if (said.slice(0, 5).some(w => ROOM.has(w.text)) || TO_THE_ROOM.test(textOf(said.slice(0, 8)))) return true
  // The whole of what is said, or its last clause: "Thanks Alex, Sarah is running late, can we start?".
  const pause = (word: Word) => /[,:;—–]|\s-/.test(word.after)
  let clause = said.length - 1
  while (clause > 0 && said.length - clause <= 16 && !pause(said[clause - 1])) clause--
  const last = clause > 0 && pause(said[clause - 1]) ? said.slice(clause) : undefined
  return (said.length <= 16 && ROOM_QUESTION.test(textOf(said))) || (!!last && ROOM_QUESTION.test(textOf(last)))
}

/** True when a word looks like someone's name: capitalised mid-sentence, and not Alex, a day, "Now" or the like. */
function looksLikeAName(word: Word): boolean {
  return /^\p{Lu}\p{Ll}/u.test(word.raw) && !word.name && !word.initial && !/\d/.test(word.raw) && !NOT_A_NAME.has(word.text) &&
    !NOT_A_NAME_AT_THE_END.has(word.text) && !YOU.has(word.text) && !ROOM.has(word.text)
}

/**
 * True when the words end with a comma and a capitalised name that isn't Alex's: "What do you think, Sarah?",
 * "Go ahead, Sarah.". Only the written form shows this: unpunctuated, "what do you think sarah" is missed.
 */
function endsOnAnotherName(said: Word[]): boolean {
  const before = said[said.length - 2]
  return !!before && before.after.includes(',') && looksLikeAName(said[said.length - 1])
}

/** True when the words hand the floor to someone else: "over to Sarah", or "go ahead" and one more word, "go ahead sarah". */
function handsOver(said: Word[]): boolean {
  const [first, second, third] = [said[0]?.text, said[1]?.text, said[2]?.text]
  if (first === 'over' && second === 'to') return !!third && !YOU.has(third) && !said[2].name
  return first === 'go' && second === 'ahead' && said.length === 3 && !said[2].name && !NOT_A_NAME_AT_THE_END.has(third) &&
    !['and', 'thanks', 'anyway', 'quickly', 'briefly', 'mate', 'buddy', 'pal', 'man', 'sir', 'friend'].includes(third)
}

/**
 * Where a stop clause ends and what follows it, when that may be a new question: after the first comma or dash
 * ("forget that, what's the launch date?"). Unpunctuated, only when the clause ends clearly and a question starts
 * right after: "alex scratch that whats the launch date", "alex ignore my last question whats the launch date",
 * "alex enough about pricing whats the timeline". Not "alex forget about what we said".
 */
function afterStop(said: Word[]): Word[] | undefined {
  const pause = said.findIndex(w => /[,:;—–]|\s-/.test(w.after))
  if (pause >= 0 && pause < said.length - 1) return said.slice(pause + 1)
  const from = said[0].text === 'please' ? 1 : 0
  const first = said[from]?.text
  const second = said[from + 1]?.text
  let end: number | undefined
  if (CALL_OFF.has(first)) end = CALLED_OFF.find(phrase => matches(said, from + 1, phrase))?.length
  if (end !== undefined) end += from + 1
  else if ((CALL_OFF.has(first) || first === 'enough') && second === 'about') end = topicEnd(said, from + 2, 'question')
  const rest = end === undefined ? [] : said.slice(end)
  return rest.length > 0 && startsQuestion(rest) ? rest : undefined
}

// The most stop or wait clauses in a row that asks() reads past (see there).
const MAX_STOPS = 20

/**
 * The first words as text, for the rules that are anchored at the start (STOP, HOLD, DONE, PUT_OFF), so that a
 * long line costs no more to check. Leading "please", "just" and "no" are kept whole: HOLD takes any number of them.
 */
function headOf(said: Word[]): string {
  let k = 0
  while (k < said.length && ['please', 'just', 'no'].includes(said[k].text)) k++
  const head = said.slice(0, k + 12)
  return textOf(head) + (head.length < said.length ? '… ' : '')
}

/**
 * After a stop or a wait, whether what follows is a new question: it opens like one, with a question word, a word
 * like "is" or "can" in question order or a request verb, perhaps after "please"; it isn't only a tag ("Alex, stop,
 * can you?", "is that clear?"); and it doesn't end on someone else's name ("Alex, stop, what do you think Sarah?").
 * So remarks are not answered: "Alex, stop, let's hear from Sarah, shall we?", "Alex, please stop, I think Bob had
 * his hand up, right?". With its question mark, "is" or "will" before a thing is question order too: "Alex, forget
 * that, is pricing per seat?".
 */
function newQuestion(said: Word[], question: boolean): boolean {
  const please = said[0].text === 'please'
  const from = please ? 1 : 0
  const first = said[from]?.text
  const second = said[from + 1]?.text
  if (!first) return false
  // After "please", a request verb outside REQUESTS will do ("please send the deck"), but not a tag, a remark or a
  // name ("please, OK?", "please let's hear from Sarah").
  const pleaseDo = please && !CALL_WORDS.has(first) && !GREETINGS.has(first) && !PRONOUNS.has(first) && !NOT_A_NAME.has(first) &&
    !["let's", 'lets', 'let'].includes(first) && !looksLikeAName(said[from])
  const inOrder = inQuestionOrder(said.slice(from, from + 2)) ||
    (question && !!second && (AUXILIARIES.has(first) || MODALS.has(first)) && !/[,:;.!?—–]/.test(said[from].after))
  const opens = (QUESTION_WORDS.has(first) && !(first === 'what' && (second === 'a' || second === 'an'))) || inOrder ||
    REQUESTS.has(first) || pleaseDo
  if (!opens || (said.length <= 8 && TAG.test(textOf(said)))) return false
  const before = said[said.length - 2]
  return !(before && (OPINIONS.has(before.text) || YOU.has(before.text)) && looksLikeAName(said[said.length - 1]))
}

/**
 * True when these words ask for something: a question or a request. `named` says Alex's name came just before
 * them, so a question word alone is enough ("alex whats the timeline"). `room` turns on the check for questions
 * to everyone, for words after a greeting or a sentence break. `greeted` says a greeting or thanks came first:
 * then only a question mark, or a question or request at the very start, counts. So "thanks alex sarah can you
 * share your screen" and "thanks alex any questions" stay quiet.
 */
function asks(said: Word[], question: boolean, named: boolean, room = false, greeted = false): boolean {
  // "Alex, forget that, what's the launch date?": the last question is called off and a new one asked, as the
  // cancel rule in text.ts also reads it. A new question, not a remark or a tag: "Alex, don't answer that, it's a
  // trick question." and "Alex, stop, OK?" ask nothing (see newQuestion()). What follows may be for the room:
  // "Alex, please stop, can everyone hear me?". Stop and wait clauses are skipped in a loop, one after another,
  // with the openers after each ("Alex, stop, OK, what was the price?"). More of them than anyone says in one line
  // ("stop, stop, stop, ...") ask nothing, so a long line costs no more than a short one.
  let stopped = false
  for (let stops = 0; ; stops++) {
    if (said.length === 0) return false
    const head = headOf(said)
    if (forSomeoneElse(said, room, greeted) || PUT_OFF.test(head)) return false
    if (said.length <= 20 && POLITE_HOLD.test(textOf(said))) return false
    if (!STOP.test(head) && !HOLD.test(head)) break
    if (stops === MAX_STOPS) return false
    const next = DONE.test(head) ? undefined : afterStop(said)
    if (!next) return false
    said = next.slice(opening(next).end)
    room = true
    stopped = true
  }
  if (stopped && !newQuestion(said, question)) return false
  const line = textOf(said)
  if (question) return true
  if (PLEASANTRY.test(line)) return false
  if (REPEAT.test(line) || WONDER.test(line)) return true
  const [first, second] = said.map(w => w.text)
  if (first === 'please') return said.length > 1 // "please stop" was caught above
  if (REQUESTS.has(first)) return true
  const asking = (QUESTION_WORDS.has(first) && !(first === 'what' && (second === 'a' || second === 'an'))) || inQuestionOrder(said)
  if (named && (asking || youAsks(said) || (ANY.has(first) && !greeted))) return true
  if (greeted) return false
  if (/ (?:(?:can|could|would|will) you|go ahead|over to you|your turn)\b/.test(line)) return true
  // "Alex, the numbers please": "please" later on, with a request rather than "stop" after it.
  const please = said.findIndex(w => w.text === 'please')
  if (please > 0 && (please === said.length - 1 || !STOP.test(` please ${textOf(said.slice(please + 1)).trim()} `))) return true
  return !named && (asking || AUXILIARIES.has(first)) && said.some(w => YOU.has(w.text))
}

/**
 * True when the name, with no comma after it, is the subject of what follows. `leaveRule` is set for spokenTo(),
 * which keeps the reading the leave rule was reviewed with (see auxiliaryAsks()).
 */
function isSubject(rest: Word[], leaveRule = false): boolean {
  // "Alex just answered that", "alex also mentioned sso": an adverb can come between the subject and its verb.
  const adverbs = rest.findIndex(w => !ADVERBS.has(w.text))
  if (adverbs > 0 && STATEMENTS.has(rest[adverbs].text)) {
    const verb = rest[adverbs]
    // "Alex just did that", "alex actually has it covered": the adverb doesn't make "did that" a question.
    // "alex actually did you see the email" still asks.
    return !(AUXILIARIES.has(verb.text) && !/[,:;.!?—–]/.test(verb.after) && auxiliaryAsks(rest, adverbs, leaveRule))
  }
  const [next, then] = rest
  if (!next) return false
  // "Alex and I talked about it", "Alex and Sarah will join". Not "Alex and Sarah, can you both check?".
  const together = (next.text === 'and' || next.text === 'or') && then && (PRONOUNS.has(then.text) || /^\p{Lu}/u.test(then.raw))
  if (together && !then.after.includes(',')) return true
  // "Alex is it ready" asks, but "In terms of the work Alex did, it was great" doesn't: no pause after "did".
  if (STATEMENTS.has(next.text)) {
    return !(AUXILIARIES.has(next.text) && !/[,:;.!?—–]/.test(next.after) && auxiliaryAsks(rest, 0, leaveRule))
  }
  return MODALS.has(next.text) && !(then && SUBJECTS.has(then.text))
}

/**
 * With no comma after the name, whether "did", "is" and the like (the word at `at`) start a question: "alex did you
 * see the email". `leaveRule` keeps "last" a verb wherever it is, as the leave rule was reviewed with.
 */
function auxiliaryAsks(words: Word[], at: number, leaveRule: boolean): boolean {
  const aux = words[at].text
  const subject = words[at + 1]?.text
  const after = words[at + 2]?.text
  if (!subject) return false
  if (['he', 'she'].includes(subject)) return !PLURAL.has(aux)
  if (['you', 'we', 'they'].includes(subject)) return !SINGULAR.has(aux)
  if (subject === 'i') return !SINGULAR.has(aux) || aux === 'was' || aux === "wasn't"
  if (subject === 'there') return !PLURAL.has(aux) && !!after && AFTER_THERE.has(after)
  if (['it', 'this', 'that'].includes(subject)) {
    if (PLURAL.has(aux)) return false
    // "alex is it ready" asks. "Did", "does" and "has" also mean doing and having ("alex did it again", "alex has
    // that handled"), so they ask only before "been" ("alex has it been deployed") or a plain verb ("does it support").
    if (COPULAS.has(aux)) return true
    if (!after) return false
    if (['has', "hasn't", 'hasnt', 'had', "hadn't", 'hadnt'].includes(aux)) return after === 'been'
    // "alex does it last" asks; "Alex did that last week." and "Alex did it last." are remarks.
    if (after === 'last' && !leaveRule) return words.length === at + 3 && !/[.!]/.test(words[at + 2].after)
    return BARE_VERBS.has(after)
  }
  return false
}

/** True when the next sentence carries on an address to Alex: a question or request, not for anyone else. */
function carriesInto(sentence: Word[]): boolean {
  const o = opening(sentence)
  const said = sentence.slice(o.end)
  if (o.greets || !asks(said, endsOnMark(sentence), true, true)) return false
  // Without a question mark, only a clear request carries: "Alex, one more thing. Tell us about security."
  const [first, second] = said.map(w => w.text)
  const toYou = (AUXILIARIES.has(first) || MODALS.has(first)) && second === 'you'
  return endsOnMark(sentence) || REQUESTS.has(first) || first === 'please' || toYou
}

interface Use {
  how: 'asked' | 'called' | 'nothing_asked' | 'mentioned'
  /** The address can carry into the next sentence: "Alex, quick question. How much is it?". */
  carries: boolean
  /** The last word this use took in: the name said again right after it ("Alex? Alex?") needn't be looked at again. */
  through?: number
}

// Possessives that are really "it is", "that is" and the like, so they can't start a description of Alex.
const NOT_POSSESSIVE = new Set([
  "it's", "that's", "what's", "who's", "he's", "she's", "there's", "here's", "let's", "where's", "how's", "when's", "why's", "this's",
])
// What can start a description of Alex between commas: "Alex, the AI, is listening".
const DESCRIBES = new Set(['the', 'a', 'an', 'our', 'your', 'my', 'his', 'her', 'their'])
// After "is" or "will", what a question asks about, as in "Alex, the plan, is everything on track?".
const ASKED_AFTER_VERB = new Set([
  ...SUBJECTS, ...DESCRIBES, 'everything', 'anything', 'something', 'everybody', 'anybody', 'somebody', 'these', 'those', 'any',
  'some', 'its',
])

/**
 * True when the words after "Alex," describe Alex and then say something about it: "Alex, Sam's assistant, is
 * here to take notes", "Alex, the AI, is listening". That is Alex being introduced to the room, not spoken to.
 * The description is up to five words starting with a name's "'s" or a word like "the" or "our", and ends at a
 * comma. What follows is a verb with no one to ask about after it: "is recording", "will take notes", but not "is
 * it ready?", "can you hear us?", "does it hold?" or "is Friday right?", which are questions to Alex. Nor a clause
 * that runs to a question mark, "Alex, the contract, has legal signed it?": in an introduction the clause ends
 * first, and a question after it is for the room ("..., is recording this, is that OK?").
 */
function introduces(rest: Word[]): boolean {
  const end = rest.findIndex(w => /[,;—–]/.test(w.after))
  if (end < 0 || end > 4) return false
  const [first] = rest
  const possessive = /^[\p{L}]+'s$/u.test(first.text) && !NOT_POSSESSIVE.has(first.text)
  if (!possessive && !DESCRIBES.has(first.text)) return false
  // "Alex, a quick question, is it ready?" announces a question; it doesn't describe Alex.
  if (opening(rest).end > 0 || rest.slice(0, end + 1).some(w => w.name || /[.!?]/.test(w.after))) return false
  const verb = rest[end + 1]
  const next = rest[end + 2]
  if (!verb || !(STATEMENTS.has(verb.text) || MODALS.has(verb.text))) return false
  if (next && (ASKED_AFTER_VERB.has(next.text) || /^\p{Lu}|\d/u.test(next.raw))) return false
  const clauseEnd = rest.findIndex((w, i) => i > end && /[,:;.!?—–]/.test(w.after))
  return clauseEnd < 0 || !rest[clauseEnd].after.includes('?')
}

/** How the name at this position in the sentence is used. */
function nameUse(sentence: Word[], at: number): Use {
  const name = sentence[at]
  // "Alex's answer", "Alex's right": talked about.
  if (name.text.includes("'")) return { how: 'mentioned', carries: false }
  const before = sentence.slice(0, at)
  const rest = sentence.slice(at + 1)
  const question = endsOnMark(sentence)
  // "Alex, Sam's assistant, is recording this, is that OK?": introduced, so talked about.
  if (name.after.includes(',') && introduces(rest)) return { how: 'mentioned', carries: false }
  // A comma, colon, dash or full stop after the name settles that Alex is spoken to.
  const setOff = /[,:;.!?—–-]/.test(name.after)
  const lead = opening(before, true)
  // The name starts the sentence, perhaps after "hey", "thanks" or "quick question": "Alex, what's the timeline?".
  if (lead.end === before.length) {
    // Without a comma, "alex said ..." is about Alex, while "alex tell us ..." is to it.
    if (!setOff && isSubject(rest)) return { how: 'mentioned', carries: false }
    const post = opening(rest)
    const said = rest.slice(post.end)
    const greets = lead.greets || post.greets
    const announces = lead.announces || post.announces
    // After a greeting, or in a new sentence ("Hey Alex. Did everyone get the deck?"), a question to the room isn't Alex's.
    if (asks(said, question, true, greets || /[.!?]/.test(name.after), greets)) return { how: 'asked', carries: false }
    // "Alex, sorry?" asks Alex to say it again.
    if (said.length === 0 && question && post.apologises && !announces && !greets) return { how: 'asked', carries: false }
    // "Alex, quick question." or "Alex, sorry.": the question is coming. "Hi Alex, sorry." is only an apology.
    // After thanks or praise, "Thanks Alex, next question." is the host moving on, not a call. "Thanks Alex, I have
    // another question." still is, and so is an announcement said to Alex before the name: "Great, one more
    // question, Alex.".
    const movingOn = (lead.acknowledges || post.acknowledges) && post.announces && !post.ownQuestion
    const called = said.length === 0 && !movingOn && (announces || (post.apologises && !greets))
    // Otherwise the address carries on only when the name was clearly said to Alex ("Alex, Sarah thinks March."),
    // not after "Alex just answered that." or a greeting, a compliment or "stop", nor once Alex is told to wait
    // or is put off ("Alex, hold on.", "Alex, we'll come back to you.", "Alex, no."): the floor goes elsewhere.
    const line = textOf(said)
    const quiet = STOP.test(line) || PLEASANTRY.test(line) || HOLD.test(line) || PUT_OFF.test(line) || POLITE_HOLD.test(line) ||
      lead.holds || post.holds
    return { how: called ? 'called' : 'nothing_asked', carries: called || (setOff && !greets && !quiet), through: at + post.end }
  }
  // Otherwise the name has to be set off by a comma before it and punctuation after it, or end the sentence:
  // "So what do you think, Alex?", "Before we start, Alex, introduce yourself.". In "By the way, Alex is recording
  // this", it is talked about. With no comma, a name at the end counts only after "think" and the like.
  const previous = before[before.length - 1]
  if ((previous.after.includes(',') && (setOff || rest.length === 0)) || (rest.length === 0 && OPINIONS.has(previous.text))) {
    if (rest.length > 0) {
      const post = opening(rest)
      if (asks(rest.slice(post.end), question, true, post.greets, post.greets)) return { how: 'asked', carries: false }
    }
    const said = before.slice(opening(before).end)
    return { how: asks(said, question, false) ? 'asked' : 'nothing_asked', carries: false }
  }
  return { how: 'mentioned', carries: false }
}

/** Decides whether a line of the meeting is for the assistant with these names, and if not, why not. */
function attentionOf(text: string, sets: NameSets): Attention {
  const words = wordsOf(text, sets)
  if (!words.some(w => w.name)) return 'no_name'
  // A sentence that only calls Alex goes with the next one: "Alex. What does Acme do?" is one question.
  const sentences: Word[][] = []
  for (const sentence of sentencesOf(words)) {
    const last = sentences[sentences.length - 1]
    if (last && isCall(last)) last.push(...sentence)
    else sentences.push(sentence)
  }
  let quiet: 'nothing_asked' | 'mentioned' = 'mentioned'
  let calledLast = false
  for (let s = 0; s < sentences.length; s++) {
    const sentence = sentences[s]
    const next = sentences[s + 1]
    calledLast = false
    for (let i = 0; i < sentence.length; i++) {
      if (!sentence[i].name) continue
      const use = nameUse(sentence, i)
      if (use.how === 'asked') return 'asked'
      // "Alex, quick question. How much is it?": the question is in the next sentence.
      if (use.carries && next && carriesInto(next)) return 'asked'
      if (use.how === 'called') calledLast = true
      if (use.how !== 'mentioned') quiet = 'nothing_asked'
      i = Math.max(i, use.through ?? i)
    }
  }
  const last = sentences[sentences.length - 1]
  if (isCall(last)) {
    // "What's the timeline? Alex?": the question is handed to Alex. "Good question. Alex?" is a call, and so is
    // "Any other questions? OK, Alex.": without its own question mark, the call doesn't take the question with it.
    const previous = sentences[sentences.length - 2]
    return previous && !isCall(previous) && endsOnMark(previous) && endsOnMark(last) ? 'asked' : 'called'
  }
  return calledLast ? 'called' : quiet
}

/**
 * True when the name at this position is said to Alex rather than about Alex: it starts the sentence (after
 * openers such as "hey", "thanks", "um" or "excuse me") and isn't the subject of what follows, or it is set off
 * by commas ("No, Alex, ..."). The same test nameUse() makes, without asking whether anything was asked.
 */
function spokenTo(sentence: Word[], at: number): boolean {
  const name = sentence[at]
  if (name.text.includes("'")) return false
  const before = sentence.slice(0, at)
  const rest = sentence.slice(at + 1)
  const setOff = /[,:;.!?—–-]/.test(name.after)
  if (opening(before, true, true).end === before.length) return setOff || !isSubject(rest, true)
  return before[before.length - 1].after.includes(',') && (setOff || rest.length === 0)
}

/**
 * For the leave rule (text.ts): what was said to the assistant right after its name, for each place the name is
 * said to it, up to the end of the sentence, or through the next sentence when the name ends its own ("Thanks,
 * Alex. Please leave."). Leaving deletes the meeting record, so only the exact name and the mishearings that count
 * for leaving ("Ionics", as the first word) do, not the spellings Alec, Alexa or Aleks, which are also real names.
 */
function saidAfterNameOf(text: string, sets: NameSets): string[] {
  const sentences = sentencesOf(wordsOf(text, sets))
  const said: string[] = []
  const words = (sentence: Word[] = []) => sentence.map(w => w.raw + w.after).join('')
  sentences.forEach((sentence, s) => {
    sentence.forEach((word, i) => {
      if (!sets.leave.has(foldWord(word.text))) return
      if (!word.name || !spokenTo(sentence, i)) return
      const last = i === sentence.length - 1
      said.push(word.after + words(sentence.slice(i + 1)) + (last ? words(sentences[s + 1]) : ''))
    })
  })
  return said
}

/** True when Alex's reply ended by handing the turn back: its last character is a question mark. */
export function endsOnQuestion(text: string): boolean {
  return text.replace(/["'’”)\]\s]+$/, '').endsWith('?')
}

/** True when a line is only "um", "uh", "er", "erm", "hmm" or "ah" (and punctuation): someone thinking, not talking. */
export function isFillerOnly(text: string): boolean {
  return wordsOf(text, NO_NAMES).every(isFiller)
}

/**
 * How many words of a line said over the assistant are someone taking the floor: every word but the fillers and
 * backchannels above, and the name always. A backchannel phrase counts nothing as a whole ("that makes sense"). A
 * partial line (speech recognition is partway through the turn) stops counting at a phrase it may be partway through:
 * "that makes" counts nothing yet, and 2 once the line has ended there.
 */
function wordsThatCountOf(text: string, sets: NameSets, partial: boolean): number {
  const words = wordsOf(text, sets)
  let count = 0
  for (let i = 0; i < words.length; ) {
    const word = words[i]
    if (word.name) {
      count++
      i++
      continue
    }
    const phrase = BACKCHANNEL_PHRASES.find(p => matches(words, i, p))
    if (phrase) {
      i += phrase.length
      continue
    }
    const left = words.length - i
    if (partial && BACKCHANNEL_PHRASES.some(p => p.length > left && matches(words, i, p.slice(0, left)))) break
    if (!isFiller(word) && !BACKCHANNEL_SOUND.test(word.text) && !BACKCHANNEL_WORDS.has(word.text)) count++
    i++
  }
  return count
}

/** The attention rules for one assistant's names. */
export interface AttentionRules {
  /** Whether a line is for the assistant, and if not, why not. */
  attention(text: string): Attention
  /** For the leave rule (text.ts): what was said to the assistant right after its name, each time it was said to it. */
  saidAfterName(text: string): string[]
  /** For talking over the assistant (session.ts): how many words count as taking the floor (see wordsThatCountOf()). */
  wordsThatCount(text: string, partial?: boolean): number
}

/** The attention rules for these names. Pure: the tests and npm run check-name make them for any name. */
export function makeAttention(agent: AgentName): AttentionRules {
  const sets = nameSets(agent)
  return {
    attention: text => attentionOf(text, sets),
    saidAfterName: text => saidAfterNameOf(text, sets),
    wordsThatCount: (text, partial = false) => wordsThatCountOf(text, sets, partial),
  }
}

// The rules for the assistant this process is (src/identity.ts), as the rest of the service uses them.
const RULES = makeAttention(identity)

/** Decides whether a line of the meeting is for the assistant, and if not, why not. */
export function attention(text: string): Attention {
  return RULES.attention(text)
}

/** How many words of a line said over the assistant count as taking the floor; partial while the turn goes on. */
export function wordsThatCount(text: string, partial = false): number {
  return RULES.wordsThatCount(text, partial)
}

/** For the leave rule (text.ts): what was said to the assistant right after its name (see saidAfterNameOf()). */
export function saidAfterName(text: string): string[] {
  return RULES.saidAfterName(text)
}

/**
 * The words in these lists and patterns, in lower case, split at spaces and apostrophes ("don't" gives "don" and
 * "t", since "don't" would read as the name Don). A pattern's escapes go first, so "\bleave" gives "leave".
 */
export function wordsIn(...sources: (Iterable<string> | RegExp)[]): Set<string> {
  const words = new Set<string>()
  for (const source of sources) {
    const texts = source instanceof RegExp ? [source.source.replace(/\\[a-zA-Z]/g, ' ')] : [...source]
    for (const text of texts) for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) words.add(word)
  }
  return words
}

/**
 * Every word these rules look for. A name that is one of them would be read as part of the grammar: as a name,
 * "Will" would answer every "Will you share your screen?", "May" every "May I ask a question?" and "So" every
 * "So, what's next?". src/name-check.ts refuses such a name, spelling or mishearing.
 */
export const GRAMMAR_WORDS: ReadonlySet<string> = wordsIn(
  MISHEARD_AFTER, CALL_WORDS, GREETINGS, PRAISE, PRAISED, GREETING_PAIRS, SALUTATIONS, THANKS, MORE_THANKS.flat(), ANNOUNCEMENTS,
  ASIDES, HOLDS, APOLOGIES, TOPICS, REQUESTS, QUESTION_WORDS, ANY, AUXILIARIES, ASKED_ABOUT, YOU, YOUR_ASKS, YOUR_ASKS_ON, YOU_POLITE,
  YOU_NOT_ASKED, ROOM, NOT_A_NAME, NOT_A_NAME_AT_THE_END, CALL_OFF, CALLED_OFF.flat(), STATEMENTS, MODALS, SUBJECTS, AFTER_THERE,
  BARE_VERBS, ADVERBS, PRONOUNS, DETERMINERS, OPINIONS, NOT_POSSESSIVE, DESCRIBES, ASKED_AFTER_VERB,
  TO_THE_ROOM, ROOM_QUESTION, STOP, DONE, HOLD, POLITE_HOLD, TAG, PUT_OFF, PLEASANTRY, REPEAT, WONDER,
  // Words the functions above look for themselves.
  [
    'thank', 'please', 'just', 'no', 'not', 'one', 'more', 'last', 'to', 'but', 'both', 'and', 'or', 'over', 'go', 'ahead', 'there',
    'around', 'still', 'with', 'us', 'know', 'what', 'never', 'also', 'maybe', 'perhaps', 'now', 'enough', 'about', "let's", 'lets',
    'let', 'been', 'thanks', 'anyway', 'quickly', 'briefly', 'mate', 'buddy', 'pal', 'man', 'sir', 'friend', "i've", "i'd", 'my',
  ],
)
