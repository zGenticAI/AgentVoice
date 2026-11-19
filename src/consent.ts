// The consent wording: what the assistant says and posts word for word. It tells the meeting the assistant is an
// AI, that it is transcribing, that it can agree to nothing, and how to make it leave, and that never changes.
// Only the names in it are settings: the assistant's and its owner's (src/identity.ts), filled in once, at start-up.
// The company is never in it. Whoever runs the assistant is responsible for the wording being right where they and
// the people they meet are: review it against the recording and consent rules that apply there before use.
import { config } from './config.ts'
import { type Names, defaultBotName, identity } from './identity.ts'

/** Everything the assistant says word for word, for one assistant and owner. */
export interface ConsentLines {
  /** Said on joining, always in full. */
  join: string
  /** The goodbye after a request to leave. */
  leave: string
  /** Said, in turn, while a question goes to the owner's session. */
  checking: readonly string[]
  /** Said once when the owner's session is slow to answer. */
  progress: string
  /** Said when the owner's session can't be reached. */
  offline: string
  /** Said when Claude declines to answer. */
  refusal: string
}

/** The fixed lines for this assistant and owner. They name the owner, never with a pronoun, so none needs setting. */
export function consentLines(id: Pick<Names, 'name' | 'owner'>): ConsentLines {
  const { name, owner } = id
  return {
    // Said when the assistant joins, and always in full, since it tells the meeting how to make it leave: talking
    // over it or "<name>, never mind" doesn't stop it. A leave request, its removal or the end of the session do
    // (src/pipeline/session.ts). The phrase it teaches is checked at start-up to be a leave request (src/name-check.ts).
    join:
      `Hello, I'm ${name}, ${owner}'s AI assistant. I'm transcribing this meeting so I can answer questions ` +
      `when you say my name. I'll only speak when asked, and I can't agree to anything for ${owner}. ` +
      `If you'd like me to leave, say "${name}, please leave", or remove me from the participant list.`,
    leave: "Of course. I'm leaving now, and I'll delete my transcript of this meeting.",
    // Said while a question goes to the owner's session: the question is sent first, so the session is already on it
    // as the assistant says this. They are taken in turn, so several hand-offs in one meeting don't all sound the
    // same.
    checking: [`Let me check that with ${owner}'s notes.`, `One moment, I'll check ${owner}'s notes.`, `Let me look that up in ${owner}'s notes.`],
    // Said once when the owner's session takes a while to answer, so the meeting knows the assistant is still on it.
    progress: 'Still checking. One moment.',
    offline: `I can't reach ${owner}'s notes right now, so I'll pass that question on to ${owner}.`,
    refusal: `Sorry, I can't help with that one. I'll leave it for ${owner}.`,
  }
}

/**
 * The notice posted in the meeting chat when the assistant joins. With slides: the variant for a meeting it has slides
 * to present in, which says so and how to pause them. It is set when the bot is created, so it never changes later.
 */
export function joinChatMessage(
  id: Pick<Names, 'name' | 'owner'> = identity,
  retentionDays = config.retentionDays,
  opts: { slides?: boolean } = {},
): string {
  const { name, owner } = id
  if (opts.slides) {
    return (
      `${defaultBotName(name, owner)} has joined. I transcribe this meeting to answer questions when asked by name, ` +
      `and I'll present slides ${owner} prepared when asked. Afterwards I send ${owner} a summary to keep. I keep no ` +
      `recording of the meeting, and I delete my own transcripts and summaries after ${retentionDays} days. To pause my ` +
      `slides, say "${name}, pause". To stop me, say "${name}, please leave" or remove me.`
    )
  }
  return (
    `${defaultBotName(name, owner)} has joined. I transcribe this meeting to answer questions when asked by name, ` +
    `and afterwards I send ${owner} a summary to keep. I keep no recording of the meeting, and I delete my own ` +
    `transcripts and summaries after ${retentionDays} days. To stop me, say "${name}, please leave" or remove me.`
    // A link to your own privacy notice could follow here (the README's "Responsible use" says what it should cover).
  )
}

/** The meeting platforms, by the ids src/recall.ts gives them. */
export type HintPlatform = 'zoom' | 'google_meet' | 'microsoft_teams'

/**
 * What the assistant says word for word in a meeting it has slides to present in (docs/presenting.md). Only the names
 * in them are settings. None names a slide: "Back to <title>." and "Here's slide N." are said live, never kept, since
 * they would put the deck's content on disk with the kept lines.
 */
export interface SlidesLines {
  /**
   * The consent line in a meeting with slides, said in full, as the other one is. "I'll only speak when asked" would be
   * untrue while it presents, so it says how a presentation starts, then the rest as always.
   */
  join: string
  /** Said as the share is asked for: loading can take a few seconds. */
  sharing: string
  /** Asked once, after the first slide is up: nothing tells the service that the platform shows the share. */
  canSee: string
  /** Asked once the room is quiet after someone talked over the narration. */
  shallCarryOn: string
  carryOn: string
  /** "<name>, stop presenting". */
  stopped: string
  /** The share was refused (Recall's answer). */
  shareFailed: string
  /** Recall took the share, but the page never linked up, or never showed the first slide. */
  notLoading: string
  /** The page stopped acknowledging slides. */
  stuck: string
  /** Something else went wrong with the share: a contested link, or a fault of its own. */
  problem: string
  /** The share was asked for too often. */
  rateLimited: string
  /** Speech recognition was lost: it never talks on when it can't hear "please leave". */
  deaf: string
  /** ElevenLabs failed twice: played from the kept audio, which needs no ElevenLabs. */
  voice: string
  /** A room "carry on" while the owner has paused the deck. */
  waitForOwner: string
  /** The owner's wrap_up. */
  wrapUp: string
  /** Said after a "no" to canSee: which host setting lets the assistant share, per platform. */
  hints: Record<HintPlatform, string>
}

/** The fixed lines of a meeting with slides, for this assistant and owner (slidesLines). */
export function slidesLines(id: Pick<Names, 'name' | 'owner'>): SlidesLines {
  const { name, owner } = id
  const again = `then say "${name}, start the presentation" again.`
  return {
    join:
      `Hello, I'm ${name}, ${owner}'s AI assistant. I'm transcribing this meeting so I can answer questions ` +
      `when you say my name. I also have slides to present for ${owner}: say "${name}, start the presentation" when ` +
      `you're ready. Otherwise I'll only speak when asked, and I can't agree to anything for ${owner}. ` +
      `If you'd like me to leave, say "${name}, please leave", or remove me from the participant list.`,
    sharing: "I'm sharing my slides now. They can take a few seconds to appear.",
    canSee: 'Can everyone see my slides?',
    shallCarryOn: 'Shall I carry on?',
    carryOn: "I'll carry on.",
    stopped: "Sure, I'll stop sharing my slides.",
    shareFailed: "I couldn't share my slides.",
    notLoading: "My slides didn't load, so I've stopped sharing them.",
    stuck: "My slides seem stuck, so I've stopped sharing them.",
    problem: "My slides had a problem, so I've stopped sharing them.",
    rateLimited: "I'll leave the slides off for now.",
    deaf: "I can't hear the meeting right now, so I'll pause my slides.",
    voice: "I'm having trouble with my voice; one moment.",
    waitForOwner: `I'll wait for ${owner} on that.`,
    wrapUp: 'Let me jump to the last slide.',
    // Zoom's co-host is left out until a test shows a guest bot can be made one.
    hints: {
      zoom: `It looks like I can't share my screen here. The host can allow screen sharing for all participants; ${again}`,
      google_meet: `It looks like I can't share my screen here. The host can turn on screen sharing for everyone in Host controls, or make me a co-host; ${again}`,
      microsoft_teams: `It looks like I can't share my screen here. The organizer can make me a presenter from the participant list; ${again}`,
    },
  }
}

/** Every line of a meeting with slides, the consent line included, for the line cache. */
export function slidesFixedLines(lines: SlidesLines): readonly string[] {
  const { hints, ...said } = lines
  return [...Object.values(said), ...Object.values(hints)]
}

/**
 * Every line the assistant says word for word. Their audio is made once per voice and kept on disk
 * (src/pipeline/line-cache.ts), so they play at once. Nothing else it says is ever kept that way. A new name
 * makes new lines, so their audio is made again at the next start, and the old files are removed.
 */
export function fixedLines(lines: ConsentLines): readonly string[] {
  return [lines.join, lines.leave, ...lines.checking, lines.progress, lines.offline, lines.refusal]
}

// The lines for the assistant this process is.
const LINES = consentLines(identity)

export const JOIN_LINE = LINES.join
export const LEAVE_LINE = LINES.leave
export const CHECKING_LINES: readonly string[] = LINES.checking
export const CHECKING_LINE = CHECKING_LINES[0]
export const PROGRESS_LINE = LINES.progress
export const SESSION_OFFLINE_LINE = LINES.offline
export const REFUSAL_LINE = LINES.refusal
export const FIXED_LINES: readonly string[] = fixedLines(LINES)

// The lines of a meeting with slides, for the assistant this process is.
export const SLIDES_LINES = slidesLines(identity)
export const SLIDES_FIXED_LINES: readonly string[] = slidesFixedLines(SLIDES_LINES)

/**
 * The lines the line cache keeps: the fixed lines, and the slides lines too once presenting is on for any platform
 * (SLIDES_PLATFORMS). With it off, no meeting can have slides, so nothing more is made or kept.
 */
export function cachedLines(slidesPlatforms: readonly string[] = config.slidesPlatforms): readonly string[] {
  return slidesPlatforms.length ? [...FIXED_LINES, ...SLIDES_FIXED_LINES] : FIXED_LINES
}
