// What the room may tell the assistant about its slides, by name: start, next, back, go to slide N, start this slide
// again, pause, carry on, stop presenting. A closed list of phrases, read the way the leave rule reads "please leave"
// (saidAfterName in src/brain/attention.ts): the name comes first, and the command is the whole rest of its sentence,
// with only "please", "thanks" or "now" after it. So "Next slide, Alex.", "Alex stopped at slide four.", "I asked Alex
// to go back.", "Alex, wait until Sarah joins." and "Alex, next slide, and what does SSO cost?" are not commands: they
// go to the attention rules as any other line. In a window the assistant opened ("Shall I carry on?"), a line is also
// read without the name. "Alex, stop." stays today's cancel, which the session checks first.
//
// windowReply reads the answer to the assistant's own questions in a window: a closed list of yes and no. Anything
// else is not an answer, and is handled as any line in a window: it is answered.
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
const LEAD = String.raw`^[,.:;!?\s\-–—]*(?:(?:please|ok|okay|so|now|right)[,\s]+)*(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?`
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

/** A command in words said to the assistant (after its name, or the whole line in a window), or null. */
function readCommand(said: string): SlideCommand | null {
  // Accents are no part of these phrases, and curly apostrophes are written as Flux writes them.
  const plain = said.normalize('NFKC')
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
  'ok', 'okay',
]
const NO = [
  'no', 'nope', 'not yet', 'wait', 'hold on', "we can't", "we cannot", "i can't", 'i cannot', "i can't see it", "we can't see it",
  "i can't see them", "we can't see them", "i can't see anything", "we can't see anything", 'nothing', 'not really',
]
const AROUND = ['please', 'thanks', 'thank you', 'um', 'uh', 'er', 'erm', 'hmm', 'oh', 'well', 'actually']

const phrase = (list: readonly string[]) => list.map(p => p.replace(/'/g, "['’]").replace(/\s+/g, '\\s+')).join('|')

export interface SlideCommands {
  /**
   * The command in a line said to the assistant by name, or, in a window it opened (inWindow), said without it. Null
   * for anything else, which is left to the attention rules.
   */
  command(text: string, opts?: { inWindow?: boolean }): SlideCommand | null
  /** A yes or a no to the assistant's own question, or null when the line is neither. */
  windowReply(text: string): 'yes' | 'no' | null
}

/** The rules for these names. Pure: the tests and src/name-check.ts make them for any name. */
export function makeSlideCommands(agent: AgentName): SlideCommands {
  const { saidAfterName } = makeAttention(agent)
  const names = [agent.name, ...agent.variants].map(n => n.toLowerCase().normalize('NFD').replace(/\p{M}/gu, ''))
  const filler = `(?:${phrase(AROUND)}|${names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`
  const answer = (list: readonly string[]) =>
    new RegExp(`^(?:[,.!?:;\\s\\-–—]|${filler}\\b)*(?:${phrase(list)})\\b(?:(?:[,.!?:;\\s\\-–—]|${filler}\\b|(?:${phrase(list)})\\b))*$`, 'i')
  const yes = answer(YES)
  const no = answer(NO)
  return {
    command(text, opts = {}) {
      for (const said of saidAfterName(text)) {
        const command = readCommand(said)
        if (command) return command
      }
      return opts.inWindow ? readCommand(text) : null
    },
    windowReply(text) {
      const plain = text.normalize('NFD').replace(/\p{M}/gu, '').trim()
      if (!plain) return null
      // Only one or the other: "No, not yet." is a no, and "Yes, but wait." neither (it is answered as a line).
      if (no.test(plain)) return 'no'
      if (yes.test(plain)) return 'yes'
      return null
    },
  }
}

// The rules for the assistant this process is (src/identity.ts).
const COMMANDS = makeSlideCommands(identity)

/** The command in a line said to the assistant (see makeSlideCommands), or null. */
export function slideCommand(text: string, opts: { inWindow?: boolean } = {}): SlideCommand | null {
  return COMMANDS.command(text, opts)
}

/** A yes or a no to the assistant's own question in its window, or null. */
export function windowReply(text: string): 'yes' | 'no' | null {
  return COMMANDS.windowReply(text)
}
