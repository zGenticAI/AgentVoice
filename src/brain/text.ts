// Small pure helpers, kept separate so they are easy to test. The name is the user's choice (src/identity.ts):
// the notes use the default, Alex, with its spellings (Alec, Alexa, Aleks) and mishearings (Ionics, Elix).
import { type AgentName, fold, identity, stripAccents } from '../identity.ts'
import { MISHEARD_AFTER, makeAttention, type AttentionRules, wordsIn } from './attention.ts'

// Leave requests. Leaving deletes the transcript and the recording, and can't be undone, so a wrong match
// is far worse than a missed one (a missed request can be said again). Two conditions, both strict:
//
// 1. The name is said TO Alex, by the same test attention.ts uses: it starts the sentence, perhaps after
//    "hey", "thanks", "um", "no" or "excuse me", or it is set off by commas ("I'm not comfortable with this,
//    Alex, please leave."). Talk ABOUT Alex never counts: "I don't want Alex to leave the call.", "Don't let
//    Alex leave.", "When does Alex drop off?", "Should we ask Alex to leave the meeting?". Only the exact name
//    and the mishearings that count for leaving ("Ionics", as the first word) do, not the spellings Alec, Alexa
//    or Aleks, which are real names too.
//
// 2. What follows the name is the request itself, and it ends the sentence: "please leave", "could you please
//    leave the meeting now?", "it's time to go". Not "please leave a note in the chat", "could you drop off the
//    deck later?" or "what do we leave out?". The longer form, "I think you should leave the meeting.", counts
//    only as a plain statement: not "I don't think you should leave", "do you have to leave?", "before you
//    have to leave, ..." or "Bob said you should leave".
// The request ends the sentence. After a comma only "please", "thanks" or "now" may follow: "Please leave the
// meeting, Bob." is said to Bob, whatever came before it, so a name or anything else after the comma doesn't count.
const ENDS =
  '(?:\\s+(?:now|please|for\\s+now|for\\s+today|us|then))*\\s*(?:,\\s*(?:please|thanks|thank\\s+you|now)\\s*)?(?:[.?!]|$)'
const THE_MEETING = '(?:\\s+(?:the\\s+|this\\s+)?(?:meeting|call))?'
// Polite words that may come before the request, in any order: "could you please just leave".
const POLITE =
  '(?:(?:please|kindly|just|actually|sorry|but|so|ok|okay|well|now|no|um+|uh+|er+m?)[,!\\s]+|(?:can|could|would|will)\\s+you\\s+' +
  '|go\\s+ahead\\s+and\\s+)*'
const LEAVE_VERB = `(?:leave|go\\s+away|drop\\s+off|hang\\s+up)${THE_MEETING}`
// Directly after the name: the request, or "time to go".
const ASKED = new RegExp(
  `^[,.?!:;\\s\\-–—]*${POLITE}(?:${LEAVE_VERB}|(?:it['’]?s\\s+)?time\\s+(?:for\\s+you\\s+)?to\\s+(?:go|${LEAVE_VERB}))${ENDS}`,
  'i',
)
// "I think you should leave.", "I'd like you to leave the meeting.", "OK Alex, you can go now.": a statement,
// with only these few lead-ins before "you", ending in a full stop, an exclamation mark or nothing.
const TOLD = new RegExp(
  '^[,.:;\\s\\-–—]*(?:(?:i|we)\\s+(?:think|believe|guess)\\s+(?:that\\s+)?|(?:i|we)(?:[\'’]d|\\s+would)\\s+like\\s+|(?:i|we)\\s+(?:need|want)\\s+)?' +
    'you(?:[\'’]d)?\\s+(?:should|must|can|may|need\\s+to|have\\s+to|ought\\s+to|to|better)\\s+(?:now\\s+)?' +
    `(?:go|${LEAVE_VERB})(?:\\s+(?:now|please|for\\s+now|for\\s+today|then))*\\s*(?:[.!]|$)`,
  'i',
)
// Without the name, inside an open window (Alex has just asked something, or someone said just "Alex?"), only
// a plain, explicit request counts, as the whole line: "Please leave.", "Please leave the meeting.", "No, could
// you leave the call?". The window takes whoever speaks next, and that may be said to someone else, so not
// "Sorry, I have to leave the call now.", nor a bare "Can you leave now?", "Hang up." or "Go away.".
const LEAVE_REPLY = new RegExp(
  '^\\s*(?:(?:no|ok|okay|so|actually)[,.!\\s]+)?(?:please\\s+(?:just\\s+)?(?:leave|go\\s+away|drop\\s+off|hang\\s+up)' +
    `${THE_MEETING}|(?:(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?)?leave\\s+(?:the\\s+|this\\s+)?(?:meeting|call))${ENDS}\\s*$`,
  'i',
)

/** True when a line said without the name, in an open reply or called window, asks the assistant to leave. */
export function isLeaveReply(text: string): boolean {
  return LEAVE_REPLY.test(text)
}

// Cancel requests: "Alex, never mind", "Alex, stop", "Never mind, Alex." The assistant then stops what it is
// doing, a question still waiting for the owner's session included, and says nothing. Only a closed list of phrases,
// said to it by name, as the whole request: "Alex, can you stop the recording?", "Alex, skip to the pricing"
// and "Alex, don't stop" are requests, not cancels. The name or a spelling of it ("Alec") opens or ends the
// request; a mishearing ("Ionics", a word too) only opens it, as the first word, as with the attention rules.
// Words that can come first: "Actually Alex, never mind", "OK, stop, Alex".
const CANCEL_OPENERS =
  '(?:(?:actually|ok|okay|oh|sorry|hey|hi|so|well|no|right|alright|wait|thanks|thank\\s+you|um+|uh+|er+m?|hmm+)[,.!\\s]+)'
// Between the name and the request: punctuation, and perhaps "no" or "wait" ("Alex, no, never mind").
const CANCEL_BETWEEN = '[,.?!:;\\s\\-–—]*(?:(?:no|nah|nope|oh|ok|okay|actually|sorry|well|wait|hold\\s+on|hang\\s+on|hold\\s+up)[,.!\\s]+)*'
const CANCEL_PHRASE =
  '(?:please[,\\s]+)?(?:' +
  [
    'never\\s*mind(?:\\s+(?:that|it))?',
    'stop(?:\\s+(?:talking|there|it|that))?',
    "(?:that['’]?s\\s+)?enough",
    'cancel(?:\\s+(?:that|it))?',
    'forget\\s+(?:about\\s+it|it|that)',
    'skip\\s+(?:it|that)',
    'no\\s+need',
    "do(?:n['’]?t|\\s+not)\\s+(?:bother|answer(?:\\s+that)?|worry(?:\\s+about\\s+(?:it|that))?)",
    'no\\s+worries',
    "(?:it['’]?s|that['’]?s)\\s+(?:fine|ok|okay|alright|all\\s+right)",
    "(?:all|we['’]?re)\\s+good",
    'not\\s+needed',
    'leave\\s+it',
    'scratch\\s+(?:that|it)',
    '(?:ignore|disregard)\\s+that',
    'you\\s+can\\s+stop(?:\\s+(?:now|there))?',
    "that['’]?s\\s+all",
    'not\\s+now',
    'no\\s+thanks',
    'that\\s+will\\s+do',
    'be\\s+quiet',
    'shush',
  ].join('|') +
  ')(?:\\s+(?:please|now|then|thanks|thank\\s+you|for\\s+now|actually))*'
// The request ends there: the line ends, or a comma, full stop or the like comes next.
const CANCEL_END = '(?=\\s*(?:$|[,.?!:;\\-–—]))'

/**
 * Words as alternatives in a pattern; with none, a pattern that never matches. A valid name is letters only, but
 * the rules are made before the name is checked, so a bad one must give the checks' error, not a broken pattern.
 */
const anyOf = (words: readonly string[]): string =>
  words.length ? `(?:${words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})` : '(?!)'

/**
 * True when someone tells the assistant never mind, or to stop, and asks nothing else of it. What follows the
 * request may be a remark ("Actually Alex, never mind, we'll ask Sam later."), but not a new question for
 * it: "Alex, never mind, what time is it?" is a question (and stops what it was doing anyway). A question in
 * a new sentence without the name ("Never mind, Alex. What's next on the agenda?") is for the room.
 */
function cancelRequest(text: string, cancel: RegExp, named: RegExp, grammar: AttentionRules): boolean {
  // The names in the patterns are folded, so the line is matched without its accents.
  const plain = stripAccents(text)
  const head = cancel.exec(plain)
  if (!head) return false
  const rest = plain.slice(head[0].length)
  // Nothing more, or only punctuation and quotes: "Alex, stop!"
  if (!/[\p{L}\p{N}]/u.test(rest)) return true
  const asks = /\?["'’”)\]\s]*$/.test(rest)
  const sameSentence = !/^\s*[.?!]/.test(rest)
  if (!(asks && (sameSentence || named.test(rest)))) return true
  // A question follows. attention.ts decides whether it is a new question for the assistant ("Alex, forget that,
  // what's the launch date?": answered, which stops the old one anyway) or only a tag or a remark ("Alex, stop,
  // OK?", "Alex, stop, what do you think Sarah?"): then it is a plain cancel, so a question still being checked
  // is dropped too.
  return grammar.attention(text) !== 'asked'
}

/** The rules that take the assistant's names: answering, leaving and cancelling. */
export interface NameRules {
  /** True when the speaker spoke to the assistant by name and asked something (see attention.ts for the rules). */
  isAddressed(text: string): boolean
  /** True when someone asks the assistant to leave the meeting. */
  isLeaveRequest(text: string): boolean
  /** True when someone tells the assistant never mind, or to stop, and asks nothing else of it. */
  isCancelRequest(text: string): boolean
}

/** The rules for these names. Pure: the tests, src/name-check.ts and npm run check-name make them for any name. */
export function makeNameRules(agent: AgentName): NameRules {
  const grammar = makeAttention(agent)
  const names = anyOf([fold(agent.name), ...agent.variants.map(fold)])
  const misheard = `(?:${anyOf([...MISHEARD_AFTER])}[,.!\\s]+)?${anyOf(agent.misheard.map(fold))}\\b`
  const cancel = new RegExp(
    `^\\s*(?:${CANCEL_OPENERS}*${names}\\b|${misheard})${CANCEL_BETWEEN}${CANCEL_PHRASE}${CANCEL_END}` +
      `|^\\s*${CANCEL_OPENERS}*${CANCEL_PHRASE}[,\\s]+${CANCEL_OPENERS}?${names}\\b(?:\\s+(?:please|thanks|thank\\s+you))*${CANCEL_END}`,
    'i',
  )
  const named = new RegExp(`\\b${names}\\b`, 'i')
  return {
    isAddressed: text => grammar.attention(text) === 'asked',
    isLeaveRequest: text => grammar.saidAfterName(text).some(said => ASKED.test(said) || TOLD.test(said)),
    isCancelRequest: text => cancelRequest(text, cancel, named, grammar),
  }
}

// The rules for the assistant this process is (src/identity.ts), as the rest of the service uses them.
const RULES = makeNameRules(identity)

/** True when the speaker spoke to the assistant by name and asked something (see attention.ts for the rules). */
export function isAddressed(text: string): boolean {
  return RULES.isAddressed(text)
}

/** True when someone asks the assistant to leave the meeting. */
export function isLeaveRequest(text: string): boolean {
  return RULES.isLeaveRequest(text)
}

/** True when someone tells the assistant never mind, or to stop, and asks nothing else of it (see cancelRequest()). */
export function isCancelRequest(text: string): boolean {
  return RULES.isCancelRequest(text)
}

/** The words the leave and cancel rules look for: a name can't be one of them (src/name-check.ts). */
export const LEAVE_AND_CANCEL_WORDS: ReadonlySet<string> = wordsIn(
  ASKED, TOLD, LEAVE_REPLY, new RegExp(CANCEL_OPENERS + CANCEL_BETWEEN + CANCEL_PHRASE),
)

/**
 * Splits streamed text into speakable sentences. Feed it deltas; it returns the
 * sentences completed so far and keeps the remainder for the next call.
 */
export class SentenceSplitter {
  private buffer = ''

  push(delta: string): string[] {
    this.buffer += delta
    const out: string[] = []
    // A sentence ends at . ! ? followed by whitespace, or at a newline, so "1.65" stays whole.
    const boundary = /[.!?]+(?=\s)|\n/g
    let consumed = 0
    for (let m = boundary.exec(this.buffer); m; m = boundary.exec(this.buffer)) {
      const sentence = this.buffer.slice(consumed, boundary.lastIndex).trim()
      if (sentence) out.push(sentence)
      consumed = boundary.lastIndex
    }
    this.buffer = this.buffer.slice(consumed)
    return out
  }

  /** Whatever is left once the stream ends. */
  flush(): string[] {
    const rest = this.buffer.trim()
    this.buffer = ''
    return rest ? [rest] : []
  }
}
