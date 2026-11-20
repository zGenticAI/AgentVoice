// What the room may tell the assistant about its slides, by name: start, next, back, go to slide N, start this slide
// again, pause, carry on, stop presenting. A closed list of phrases, read the way the leave rule reads "please leave"
// (saidAfterName in src/brain/attention.ts): the name comes first, and the command is the whole rest of its sentence,
// with only "please", "thanks" or "now" after it. Fillers don't count, wherever they are, as the leave rule skips them
// ("Alex, uh, start the presentation."), and when only fillers or lead words follow the name before a full stop, the
// next sentence is read too ("Alex, um. Start the presentation."). So "Next slide, Alex.", "Alex stopped at slide
// four.", "I asked Alex to go back.", "Alex, wait until Sarah joins." and "Alex, next slide, and what does SSO cost?"
// are not commands: they go to the attention rules as any other line. In a window the assistant opened ("Shall I carry
// on?"), a line is also read without the name. "Alex, stop." stays today's cancel, which the session checks first.
//
// windowReply reads the answer to the assistant's own questions in a window. "Shall I carry on?" takes a closed list of
// yes and no. "Can everyone see my slides?" is answered in sentences ("Yes, we can see them.", "I don't see anything.",
// "It's just black."), so it is read more loosely, and "hold on" or "wait" there asks for a moment (the slides may
// still be loading for them), never a no. Anything else is not an answer, and is handled as any line in a window: it
// is answered.
//
// Only in a meeting with slides: the session runs the commands after the leave and cancel checks and before attention,
// so "please leave" always wins, and a meeting without slides reads every line exactly as before.
import { makeAttention } from '../brain/attention.ts'
import { type AgentName, identity } from '../identity.ts'

export type SlideCommand =
  | { kind: 'start' | 'next' | 'back' | 'restart' | 'pause' | 'resume' | 'stop' }
  /** slide: a page number as said, or the last slide. */
  | { kind: 'goto'; slide: number | 'last' }

export type CommandKind = SlideCommand['kind']

/** Slide numbers as words: one to twenty, and first. Digits are read up to 100. */
const NUMBER_WORDS: Record<string, number> = {
  first: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
}
const NUMBER = `(\\d{1,3}|${Object.keys(NUMBER_WORDS).filter(w => w !== 'first').join('|')})`

// Before the command: polite words, and "can you". After it: "please", "thanks" or "now", and the end of the sentence.
// A lead word may end a sentence of its own ("Alex, okay. Start the presentation.": see readOn below). "Oh", "well" and
// "actually" are words, not the sounds of FILLER below: like "okay" and "so", they are taken only before the command.
const LEAD_WORDS = ['please', 'ok', 'okay', 'so', 'now', 'right', 'oh', 'well', 'actually']
const LEAD = String.raw`^[,.:;!?\s\-–—]*(?:(?:${LEAD_WORDS.join('|')})[,.\s]+)*(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?`
const TAIL = String.raw`(?:[,\s]+(?:please|now|thanks|thank\s+you))*\s*[.!?]*\s*$`
const THE = String.raw`(?:the\s+|your\s+|my\s+)?`
const SLIDE_WORD = String.raw`(?:slide|page)`

/** The phrases of each command, as patterns over the words after the name. In this order: the first full match wins. */
const RULES: readonly [CommandKind, RegExp][] = [
  [
    'start',
    new RegExp(
      [
        String.raw`(?:start|begin)\s+${THE}(?:presentation|slides|deck|slideshow)`,
        String.raw`go\s+ahead\s+with\s+${THE}(?:presentation|slides|deck)`,
        String.raw`(?:present|share)\s+${THE}(?:slides|deck|presentation)`,
        String.raw`start\s+presenting`,
      ].join('|'),
    ),
  ],
  [
    'stop',
    new RegExp(
      [
        String.raw`stop\s+presenting`,
        String.raw`stop\s+sharing(?:\s+(?:your|the)\s+(?:screen|slides))?`,
        String.raw`stop\s+the\s+(?:presentation|slides)`,
        String.raw`that['’]?s\s+enough\s+slides`,
      ].join('|'),
    ),
  ],
  [
    'restart',
    new RegExp(
      [
        String.raw`(?:go\s+(?:through|over)|start|restart|do)\s+(?:that|this)\s+(?:slide|one)\s+again`,
        String.raw`go\s+(?:through|over)\s+(?:that|this|it)\s+again`,
        String.raw`restart\s+(?:that|this)\s+slide`,
      ].join('|'),
    ),
  ],
  [
    'goto',
    new RegExp(
      String.raw`(?:go\s+(?:back\s+)?to|show(?:\s+us)?|back\s+to|jump\s+to|skip\s+to|move\s+to|turn\s+to)\s+` +
        String.raw`(?:${SLIDE_WORD}\s+(?:number\s+)?${NUMBER}|the\s+(first|last)\s+${SLIDE_WORD})(?:\s+again)?`,
    ),
  ],
  [
    'resume',
    new RegExp(
      [
        String.raw`carry\s+on(?:\s+with\s+the\s+(?:presentation|slides))?`,
        String.raw`continue(?:\s+the\s+(?:presentation|slides))?`,
        String.raw`go\s+on`,
        String.raw`keep\s+going`,
        String.raw`resume(?:\s+the\s+(?:presentation|slides))?`,
        String.raw`go\s+ahead`,
        String.raw`(?:go\s+)?back\s+to\s+(?:the\s+)?(?:presentation|slides)`,
        String.raw`(?:go\s+)?back\s+to\s+where\s+you\s+were`,
      ].join('|'),
    ),
  ],
  [
    'next',
    new RegExp(
      [
        String.raw`(?:the\s+)?next\s+(?:slide|one)`,
        String.raw`(?:go|move\s+on|skip\s+ahead)\s+to\s+the\s+next\s+slide`,
        String.raw`skip\s+this\s+(?:slide|one)`,
      ].join('|'),
    ),
  ],
  [
    'back',
    new RegExp(
      [
        String.raw`go\s+back(?:\s+(?:a|one)\s+slide)?`,
        String.raw`back\s+(?:a|one)\s+slide`,
        String.raw`(?:the\s+)?previous\s+slide`,
        String.raw`go\s+to\s+the\s+previous\s+slide`,
      ].join('|'),
    ),
  ],
  [
    'pause',
    new RegExp(
      [
        String.raw`pause(?:\s+(?:the\s+)?(?:presentation|slides))?`,
        String.raw`wait(?:\s+a\s+(?:moment|second|sec|minute))?`,
        String.raw`hold\s+on`,
        String.raw`hang\s+on`,
        String.raw`one\s+(?:moment|second|sec|minute)`,
        String.raw`give\s+(?:me|us)\s+a\s+(?:moment|second|sec|minute)`,
      ].join('|'),
    ),
  ],
]

const COMPILED = RULES.map(([kind, re]) => [kind, new RegExp(`${LEAD}(?:${re.source})${TAIL}`, 'i')] as const)

// The sounds of someone thinking, as the attention rules know them (FILLER in src/brain/attention.ts): um, uh, er, erm,
// hmm and ah, drawn out or not. None carries meaning in a command, so they are dropped wherever they are, with the
// commas, dashes and dots around them: "Alex, uh, start the presentation.", "Alex, start the, um, presentation.",
// "Alex, go to slide, er, five.", "Alex, next slide, um, please." A word joined to them stays whole ("uh-huh").
const FILLER = String.raw`(?:u+h*m+|u+h+|e+r+m*|h+m+|a+h+)`
const SOFT = String.raw`(?:[\s,;:\-–—]|\.{2,})`
const FILLERS = new RegExp(String.raw`${SOFT}*(?<![\p{L}\p{N}'’\-])${FILLER}(?![\p{L}\p{N}'’\-])${SOFT}*`, 'giu')

/** The words to match, without fillers. */
function commandWords(said: string): string {
  // Accents are no part of these phrases, and curly apostrophes are written as Flux writes them. In NFKC "…" is "...".
  return said.normalize('NFKC').replace(FILLERS, ' ')
}

// Nothing yet: what follows the name is only fillers, lead words, commas and full stops. Then the next sentence is read
// too: "Alex, um. Start the presentation.", "Alex, okay. Next slide." (saidAfterName's readOn). Not after a question
// mark: "Alex, okay? Next slide." stays a question to it.
const NOTHING_YET = new RegExp(String.raw`^(?:[\s,.:;\-–—]|\b(?:${LEAD_WORDS.join('|')})\b)*$`, 'i')
const readOn = (said: string): boolean => NOTHING_YET.test(commandWords(said))

/** A command in words said to the assistant (after its name, or the whole line in a window), or null. */
function readCommand(said: string): SlideCommand | null {
  const plain = commandWords(said)
  for (const [kind, re] of COMPILED) {
    const m = re.exec(plain)
    if (!m) continue
    if (kind !== 'goto') return { kind }
    const [, number, edge] = m
    if (edge) return { kind, slide: edge.toLowerCase() === 'last' ? 'last' : 1 }
    const word = number.toLowerCase()
    const slide = /^\d+$/.test(word) ? Number(word) : NUMBER_WORDS[word]
    if (!slide || slide > 100) return null
    return { kind, slide }
  }
  return null
}

// The answers to the assistant's own questions ("Shall I carry on?", "Can everyone see my slides?"): only these, alone
// or together, with "please", "thanks", fillers and the name allowed around them.
const YES = [
  'yes', 'yeah', 'yep', 'yup', 'sure', 'go ahead', 'please do', 'carry on', 'go on', 'we can', 'i can', 'looks good', 'all good',
  'ok', 'okay', 'mm-hm', 'mm-hmm', 'mm hm', 'mhm', 'uh-huh', 'uh huh',
]
const NO = [
  'no', 'nope', 'not yet', 'wait', 'hold on', "we can't", "we cannot", "i can't", 'i cannot', "i can't see it", "we can't see it",
  "i can't see them", "we can't see them", "i can't see anything", "we can't see anything", 'nothing', 'not really',
]
const AROUND = ['please', 'thanks', 'thank you', 'um', 'uh', 'er', 'erm', 'hmm', 'oh', 'well', 'actually']

const phrase = (list: readonly string[]) => list.map(p => p.replace(/'/g, "['’]").replace(/\s+/g, '\\s+')).join('|')

// The answer to "Can everyone see my slides?", read in this order: what they can't see (or see instead), what they
// can see, a moment asked for, then a line that starts with a no or a yes. Over the line without the name and fillers
// in front, in lower case, with plain apostrophes.
//
// What they can't see ends its clause, with at most a word like "yet" after it. "I can't see anything wrong with it"
// and "I don't see why not" go on, so they are no answer.
const UNTIL = String.raw`(?:\s+(?:yet|at\s+all|now|right\s+now|either|here|for\s+(?:me|us)|on\s+(?:my|our)\s+(?:end|side|screen)))*(?=\s*(?:[.!,;]|$))`
const CANT_SEE = String.raw`(?:can'?t|cannot|can\s+not|don'?t|do\s+not|doesn'?t|does\s+not|didn'?t|did\s+not|couldn'?t|could\s+not|not\s+able\s+to)\s+(?:\w+\s+){0,2}?see(?:\s+(?:it|them|anything|a\s+thing|(?:the|your|any)\s+(?:slides?|screen|presentation|deck)))?`
const NOT_UP = String.raw`(?:not|isn'?t|aren'?t|nothing'?s?)\s+(?:showing(?:\s+up)?|coming\s+(?:up|through)|loading|loaded|there|visible|appearing|shared)`
const CAMERA = String.raw`(?:just|only)\s+(?:see\s+)?(?:your|the|a)\s+(?:camera|video|face|tile)`
// "I can see your camera but not the slides.": the one no a line with "but" can be.
const SEE_NOT_SLIDES = /\bnot\s+(?:the|your)\s+(?:slides?|screen|presentation)\b/
// Anywhere in a short line that is no question and has no "but".
const SEE_NO = new RegExp(
  [
    String.raw`\b${CANT_SEE}${UNTIL}`,
    String.raw`\bsee\s+nothing${UNTIL}`,
    String.raw`\b(?:black|blank)\s+(?:screen|box|square|page|window|rectangle)${UNTIL}`,
    String.raw`\b${CAMERA}${UNTIL}`,
    String.raw`\b${NOT_UP}${UNTIL}`,
    String.raw`\bnothing\s+(?:yet|there|on\s+(?:the\s+)?screen)${UNTIL}`,
    SEE_NOT_SLIDES.source,
  ].join('|'),
)
// A line that is only one of those, with who or what it is about in front: "We don't see anything.", "It's just
// black.", "The screen is blank." Black and blank are a no only so, as the whole of what is seen: "the chart is blank"
// and "the black bar at the top" are about a slide. And as narration begins, only such a line is a no (lateNo).
const SEE_NO_LINE = new RegExp(
  String.raw`^(?:(?:we|i|you|everyone|everybody|it|it'?s|it\s+is|that'?s|they'?re|they\s+are|there'?s|there\s+is|(?:the|your)\s+(?:slides?|screen|presentation)(?:\s+(?:is|are)|'s)?|all\s+(?:i|we)\s+(?:see|get|have)\s+is)\s+)?` +
    String.raw`(?:(?:just|only|still|all|completely)\s+)?` +
    String.raw`(?:${CANT_SEE}|${NOT_UP}|see\s+nothing|${CAMERA}|(?:(?:see|get|have)\s+)?(?:(?:just|only)\s+)?(?:a\s+)?(?:black|blank)(?:\s+(?:screen|box|square|page|window|rectangle))?)` +
    String.raw`${UNTIL}[.!\s]*$`,
)
const SEE_YES = new RegExp(
  [
    String.raw`\b(?:we|i|everyone|everybody|all\s+of\s+us)\s+can\s+(?:\w+\s+)?see\b`,
    String.raw`^can\s+see\b`,
    String.raw`\b(?:i|we)\s+(?:see|got)\s+(?:it|them|the\s+slides?|your\s+(?:slides?|screen))\b`,
    String.raw`\bthere\s+it\s+is\b`,
    String.raw`\b(?:looks|looking)\s+(?:good|great|fine|clear|ok|okay|perfect)\b`,
    String.raw`\b(?:it'?s|they'?re)\s+(?:up|showing|there|visible)\b`,
  ].join('|'),
)
const SEE_WAIT =
  /^(?:wait|hold\s+on|hang\s+on|(?:one|just\s+a)\s+(?:moment|sec(?:ond)?|minute|min)|give\s+(?:it|me|us)\s+a\s+(?:moment|sec(?:ond)?|minute|min)|(?:it'?s\s+)?still\s+loading|it'?s\s+loading|loading)\b/
// "We can't" is a no when it ends there or says what they can't see ("I can't hear you" is no answer).
const SEE_NO_START = new RegExp(
  String.raw`^(?:no(?!\s+(?:problem|worries|idea)\b)|nope|nah|nothing(?!'?s?\s+wrong\b)|not\s+(?:yet|really|at\s+all)|nobody|no\s+one|(?:we|i)\s+(?:${CANT_SEE}|can'?t|cannot|can\s+not)${UNTIL})\b`,
)
// "We can", not "we can't" or "I cannot".
const SEE_YES_START = /^(?:yes|yeah|yep|yup|ya|yah|sure|ok|okay|all\s+good|perfect|great|absolutely|definitely|mm-?\s*hmm?|mhm|uh-?\s*huh|(?:we|i)\s+can(?!'|not\b|\s+not\b)|got\s+it)\b/

export interface SlideCommands {
  /**
   * The command in a line said to the assistant by name, or, in a window it opened (inWindow), said without it. Null
   * for anything else, which is left to the attention rules.
   */
  command(text: string, opts?: { inWindow?: boolean }): SlideCommand | null
  /**
   * A yes or a no to the assistant's own question, or null when the line is neither. can_see: the answer to "Can
   * everyone see my slides?", where "wait" asks for a moment; carry_on (the default): to "Shall I carry on?", where
   * "wait" is a no.
   */
  windowReply(text: string, kind?: WindowKind): WindowAnswer
  /**
   * The first line after narration took over from "Can everyone see my slides?" while its window was open: true when it
   * is still a no to it. Only a line without the name and with no question, that starts with a no or is one whole.
   */
  lateNo(text: string): boolean
}

export type WindowKind = 'carry_on' | 'can_see'
export type WindowAnswer = 'yes' | 'no' | 'wait' | null

/** The rules for these names. Pure: the tests and src/name-check.ts make them for any name. */
export function makeSlideCommands(agent: AgentName): SlideCommands {
  const { saidAfterName } = makeAttention(agent)
  const names = [agent.name, ...agent.variants].map(fold)
  const filler = `(?:${phrase(AROUND)}|${names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`
  const answer = (list: readonly string[]) =>
    new RegExp(`^(?:[,.!?:;\\s\\-–—]|${filler}\\b)*(?:${phrase(list)})\\b(?:(?:[,.!?:;\\s\\-–—]|${filler}\\b|(?:${phrase(list)})\\b))*$`, 'i')
  const yes = answer(YES)
  const no = answer(NO)
  // What may come before an answer: punctuation, fillers, "so", "oh" and the name. Not the "uh" of "uh-huh".
  const lead = new RegExp(`^(?:[,.!?:;\\s\\-–—]|(?:${filler}|so|oh|ah|hey|and|well)\\b(?!-))*`, 'i')
  // Any of its names, spellings or mishearings: the line was said to it.
  const anyName = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${[...names, ...agent.misheard.map(fold)].map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\p{L}\\p{N}])`,
    'u',
  )
  const plainOf = (text: string) => fold(text).trim()
  const seeLine = (plain: string) => plain.replace(/[‘’]/g, "'").replace(lead, '')
  return {
    command(text, opts = {}) {
      for (const said of saidAfterName(text, readOn)) {
        const command = readCommand(said)
        if (command) return command
      }
      return opts.inWindow ? readCommand(text) : null
    },
    windowReply(text, kind = 'carry_on') {
      const plain = text.normalize('NFD').replace(/\p{M}/gu, '').trim()
      if (!plain) return null
      if (kind === 'can_see') return seeReply(seeLine(plainOf(text)))
      // Only one or the other: "No, not yet." is a no, and "Yes, but wait." neither (it is answered as a line).
      if (no.test(plain)) return 'no'
      if (yes.test(plain)) return 'yes'
      return null
    },
    lateNo(text) {
      const plain = plainOf(text)
      // Said to it, or a question ("Alex, why can't I see the prices?"): narration has begun, so the attention rules
      // answer it, and the slides go on.
      if (!plain || plain.includes('?') || anyName.test(plain)) return false
      const line = seeLine(plain)
      return seeReply(line) === 'no' && (SEE_NO_START.test(line) || SEE_NO_LINE.test(line))
    },
  }
}

/** Lower case, without accents. */
function fold(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
}

// The rules for the assistant this process is (src/identity.ts).
const COMMANDS = makeSlideCommands(identity)

/** The command in a line said to the assistant (see makeSlideCommands), or null. */
export function slideCommand(text: string, opts: { inWindow?: boolean } = {}): SlideCommand | null {
  return COMMANDS.command(text, opts)
}

/**
 * The answer to "Can everyone see my slides?" (see SEE_NO and the rest). A line with "but", or with a question, is no
 * plain yes or no: it is answered as a line ("Yes, but can you make it bigger?", "Looks good, but the chart is blank.",
 * "Yes. Alex, what's the black bar at the top?"). Only a line that starts with a no, or says the slides are missing
 * after its "but", is a no all the same. Nor is a long line a no for a phrase in it: it is a remark.
 */
function seeReply(line: string): WindowAnswer {
  if (!line) return null
  const asks = line.includes('?')
  const remark = /\b(?:but|though|although|except)\b/.test(line)
  const short = line.split(/\s+/).length <= 12
  if (!asks && !remark && short && (SEE_NO.test(line) || SEE_NO_LINE.test(line))) return 'no'
  if (!asks && remark && SEE_NOT_SLIDES.test(line)) return 'no'
  if (!asks && !remark && SEE_YES.test(line)) return 'yes'
  if (SEE_WAIT.test(line)) return 'wait'
  if (SEE_NO_START.test(line)) return 'no'
  if (!asks && !remark && SEE_YES_START.test(line)) return 'yes'
  return null
}

/** A yes or a no to the assistant's own question in its window (see SlideCommands.windowReply), or null. */
export function windowReply(text: string, kind?: WindowKind): WindowAnswer {
  return COMMANDS.windowReply(text, kind)
}

/** Whether the first line after narration took over from "Can everyone see my slides?" still says no to it. */
export function lateNo(text: string): boolean {
  return COMMANDS.lateNo(text)
}
