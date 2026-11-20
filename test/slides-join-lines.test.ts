// A meeting with slides: what changes in Create Bot, the consent line, the chat notice and the fixed lines, and where
// presenting is allowed (SLIDES_PLATFORMS). A meeting without slides keeps exactly what it had.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { config, slidesPlatformsSetting } from '../src/config.ts'
import {
  FIXED_LINES, JOIN_LINE, SLIDES_FIXED_LINES, SLIDES_LINES, cachedLines, consentLines, joinChatMessage, slidesFixedLines, slidesLines,
} from '../src/consent.ts'
import type { AgentName, Names } from '../src/identity.ts'
import { checkName } from '../src/name-check.ts'
import { DECK_SILENCE_MAX_S, DECK_SILENCE_MIN_S, botRequest, deckSilenceTimeout } from '../src/recall.ts'
import { makeSlideCommands, slideCommand } from '../src/slides/commands.ts'
import { slidesPlatformProblem } from '../src/slides/platforms.ts'
import { makeNameRules } from '../src/brain/text.ts'

const PRIYA: Names = { name: 'Nova', owner: 'Priya', ownerFull: 'Priya Example', company: 'Acme' }
const NOVA: AgentName = { name: 'Nova', variants: ['novah'], misheard: ['novel'], leaveMisheard: ['novel'] }
const PRONOUNS = /\b(?:he|him|his|himself|she|her|hers|herself)\b/i
const PLAN = { meetingUrl: 'https://zoom.us/j/912345678', pageUrl: 'https://alex.example/agent?key=k&token=t' }

/** The whole Create Bot body of a meeting without slides, as it was before slides existed. */
const TODAY = {
  meeting_url: PLAN.meetingUrl,
  bot_name: "Alex (Sam's AI assistant)",
  output_media: { camera: { kind: 'webpage', config: { url: PLAN.pageUrl } } },
  variant: { zoom: 'web_4_core', google_meet: 'web_4_core', microsoft_teams: 'web_4_core' },
  chat: { on_bot_join: { send_to: 'everyone', message: joinChatMessage() } },
  automatic_leave: { waiting_room_timeout: 600, noone_joined_timeout: 300, silence_detection: { timeout: 900, activate_after: 600 } },
  recording_config: { retention: null },
}

test('a meeting without slides is created with exactly the body it always had, field for field and in order', () => {
  const body = botRequest(PLAN)
  assert.deepEqual(body, TODAY)
  assert.equal(JSON.stringify(body), JSON.stringify(TODAY), 'the same bytes, keys in the same order')
  assert.equal(
    (body.chat as any).on_bot_join.message,
    `Alex (Sam's AI assistant) has joined. I transcribe this meeting to answer questions when asked by name, and afterwards I send Sam a summary to keep. I keep no recording of the meeting, and I delete my own transcripts and summaries after ${config.retentionDays} days. To stop me, say "Alex, please leave" or remove me.`,
  )
  // An undefined slides is no slides.
  assert.equal(JSON.stringify(botRequest({ ...PLAN, slides: undefined })), JSON.stringify(TODAY))
  // And with the speaker probe, only the realtime endpoint is added, as before.
  const probed = botRequest({ ...PLAN, eventsUrl: 'wss://alex.example/recall/?key=k&token=e' }) as any
  assert.deepEqual({ ...probed, recording_config: { retention: null } }, TODAY)
})

test('a meeting with slides changes only the chat notice and the silence timer: the camera only, no share at create', () => {
  for (const [minutes, timeout] of [[undefined, 3600], [null, 3600], [15, 1800], [0, 3600], [1, 960], [-5, 3600], [45, 3600], [200, 3600], [30, 2700]] as const) {
    const body = botRequest({ ...PLAN, slides: { minutes } }) as any
    assert.deepEqual(Object.keys(body), Object.keys(TODAY))
    assert.deepEqual(body.output_media, TODAY.output_media, 'the share starts on cue, mid-call, never at create')
    assert.deepEqual(body.recording_config, { retention: null })
    assert.deepEqual(body.automatic_leave, { ...TODAY.automatic_leave, silence_detection: { timeout, activate_after: 600 } }, String(minutes))
    assert.equal('bot_detection' in body.automatic_leave, false, "Recall's default bot detection is left as it is")
    assert.equal(body.chat.on_bot_join.message, joinChatMessage(undefined, undefined, { slides: true }))
    assert.deepEqual({ ...body, chat: TODAY.chat, automatic_leave: TODAY.automatic_leave }, TODAY)
  }
  assert.equal(deckSilenceTimeout(0.001), DECK_SILENCE_MIN_S, 'never under 15 minutes')
  assert.equal(deckSilenceTimeout(2), 1020)
  assert.equal(deckSilenceTimeout(NaN), DECK_SILENCE_MAX_S)
  assert.equal(deckSilenceTimeout(Infinity), DECK_SILENCE_MAX_S)
})

test('the consent line and chat notice of a meeting with slides: the approved wording, the AI said, the leave phrase kept', () => {
  assert.equal(
    SLIDES_LINES.join,
    "Hello, I'm Alex, Sam's AI assistant. I'm transcribing this meeting so I can answer questions when you say my name. " +
      'I also have slides to present for Sam: say "Alex, start the presentation" when you\'re ready. ' +
      "Otherwise I'll only speak when asked, and I can't agree to anything for Sam. " +
      'If you\'d like me to leave, say "Alex, please leave", or remove me from the participant list.',
  )
  assert.equal(
    joinChatMessage(undefined, 30, { slides: true }),
    "Alex (Sam's AI assistant) has joined. I transcribe this meeting to answer questions when asked by name, and I'll " +
      'present slides Sam prepared when asked. Afterwards I send Sam a summary to keep. I keep no recording of the meeting, ' +
      'and I delete my own transcripts and summaries after 30 days. To pause my slides, say "Alex, pause". To stop me, ' +
      'say "Alex, please leave" or remove me.',
  )
  // Today's wording is untouched.
  assert.equal(joinChatMessage(undefined, 30, {}), joinChatMessage(undefined, 30))
  assert.ok(JOIN_LINE.includes("I'll only speak when asked"))
  assert.ok(!JOIN_LINE.includes('slides'))
  // What each teaches is read as it says.
  assert.equal(slideCommand('Alex, start the presentation')?.kind, 'start')
  assert.equal(slideCommand('Alex, pause')?.kind, 'pause')
  assert.ok(makeNameRules(NOVA).isLeaveRequest('Nova, please leave'))
  for (const line of [SLIDES_LINES.join, joinChatMessage(undefined, 30, { slides: true })]) {
    assert.match(line, /AI assistant/)
    assert.match(line, /"Alex, please leave"/)
    assert.doesNotMatch(line, PRONOUNS)
  }
})

test('the fixed lines of a meeting with slides: as written, named for another assistant, and none of them names a slide', () => {
  assert.deepEqual(
    { ...SLIDES_LINES, join: '', hints: {} },
    {
      join: '',
      sharing: "I'm sharing my slides now. They can take a few seconds to appear.",
      canSee: 'Can everyone see my slides?',
      shallCarryOn: 'Shall I carry on?',
      carryOn: "I'll carry on.",
      stopped: "Sure, I'll stop sharing my slides.",
      stoppedForOwner: "I'll stop sharing my slides now.",
      shareFailed: "I couldn't share my slides.",
      notLoading: "My slides didn't load, so I've stopped sharing them.",
      stuck: "My slides seem stuck, so I've stopped sharing them.",
      problem: "My slides had a problem, so I've stopped sharing them.",
      rateLimited: "I'll leave the slides off for now.",
      deaf: "I can't hear the meeting right now, so I'll pause my slides.",
      voice: "I'm having trouble with my voice; one moment.",
      waitForOwner: "I'll wait for Sam on that.",
      wrapUp: 'Let me jump to the last slide.',
      hints: {},
    },
  )
  assert.deepEqual(SLIDES_LINES.hints, {
    zoom: 'It looks like I can\'t share my screen here. The host can allow screen sharing for all participants; then say "Alex, start the presentation" again.',
    google_meet:
      'It looks like I can\'t share my screen here. The host can turn on screen sharing for everyone in Host controls, or make me a co-host; then say "Alex, start the presentation" again.',
    microsoft_teams:
      'It looks like I can\'t share my screen here. The organizer can make me a presenter from the participant list; then say "Alex, start the presentation" again.',
  })
  assert.equal(SLIDES_FIXED_LINES.length, 19)
  assert.equal(new Set(SLIDES_FIXED_LINES).size, SLIDES_FIXED_LINES.length)
  for (const line of SLIDES_FIXED_LINES) {
    assert.doesNotMatch(line, /Back to|Here's slide|Moving to slide|don't have slide/, 'said live: they would put deck content on disk')
    assert.doesNotMatch(line, PRONOUNS, line)
  }
  const nova = slidesLines(PRIYA)
  for (const line of slidesFixedLines(nova)) assert.doesNotMatch(line, /Alex|Sam|Acme/, line)
  assert.match(nova.join, /^Hello, I'm Nova, Priya's AI assistant\. .*say "Nova, start the presentation"/)
  assert.equal(nova.waitForOwner, "I'll wait for Priya on that.")
  assert.match(joinChatMessage(PRIYA, 14, { slides: true }), /^Nova \(Priya's AI assistant\) has joined\. .*slides Priya prepared.*"Nova, pause".*"Nova, please leave" or remove me\.$/)
  // The consent line's leave phrase is the same as today's.
  assert.ok(nova.join.endsWith(consentLines(PRIYA).join.slice(consentLines(PRIYA).join.indexOf('If you'))))
})

test('the line cache keeps the slides lines only once presenting is on for a platform', () => {
  assert.deepEqual(config.slidesPlatforms, [], 'npm test pins SLIDES_PLATFORMS empty')
  assert.equal(cachedLines(), FIXED_LINES)
  assert.equal(cachedLines([]), FIXED_LINES)
  assert.equal(FIXED_LINES.length, 8)
  assert.deepEqual(cachedLines(['zoom']), [...FIXED_LINES, ...SLIDES_FIXED_LINES])
})

test('SLIDES_PLATFORMS is empty unless set, takes the three platform ids, and leaves anything else out with a warning', () => {
  const warned: string[] = []
  const warn = (m: string) => void warned.push(m)
  assert.deepEqual(slidesPlatformsSetting('', warn), [])
  assert.deepEqual(slidesPlatformsSetting(' , ', warn), [])
  assert.deepEqual(slidesPlatformsSetting('zoom', warn), ['zoom'])
  assert.deepEqual(slidesPlatformsSetting('zoom, google_meet,microsoft_teams', warn), ['zoom', 'google_meet', 'microsoft_teams'])
  assert.deepEqual(slidesPlatformsSetting('Zoom,zoom', warn), ['zoom'])
  assert.deepEqual(warned, [])
  assert.deepEqual(slidesPlatformsSetting('meet, teams, zoom, all', warn), ['zoom'])
  assert.deepEqual(warned, [
    '[config] SLIDES_PLATFORMS: "meet" is not one of zoom, google_meet, microsoft_teams, so it is left out',
    '[config] SLIDES_PLATFORMS: "teams" is not one of zoom, google_meet, microsoft_teams, so it is left out',
    '[config] SLIDES_PLATFORMS: "all" is not one of zoom, google_meet, microsoft_teams, so it is left out',
  ])
})

test('a meeting with slides on a platform SLIDES_PLATFORMS does not list is refused: the platform, the test and the setting named', () => {
  assert.equal(
    slidesPlatformProblem('zoom'),
    'Presenting slides is off on Zoom. Run the screen-share test in a Zoom meeting you host first (docs/share-test.md). ' +
      'Once it passes, add zoom to SLIDES_PLATFORMS in .env (it lists none yet) and restart the service.',
  )
  assert.equal(
    slidesPlatformProblem('microsoft_teams', ['zoom', 'google_meet']),
    'Presenting slides is off on Microsoft Teams. Run the screen-share test in a Microsoft Teams meeting you host first ' +
      '(docs/share-test.md). Once it passes, add microsoft_teams to SLIDES_PLATFORMS in .env (it lists zoom, google_meet) and restart the service.',
  )
  assert.equal(slidesPlatformProblem('google_meet', ['google_meet']), '')
  for (const platform of ['zoom', 'google_meet', 'microsoft_teams'] as const) assert.match(slidesPlatformProblem(platform), /docs\/share-test\.md.*SLIDES_PLATFORMS/)
})

test('name-check verifies the phrases a meeting with slides teaches, for the default name and others', () => {
  for (const agent of [NOVA, { name: 'Zoë', variants: ['zoey'], misheard: ['zoo'], leaveMisheard: ['zoo'] }, { name: 'Alex', variants: [], misheard: [], leaveMisheard: [] }]) {
    const rules = makeSlideCommands(agent)
    assert.equal(rules.command(`${agent.name}, start the presentation`)?.kind, 'start', agent.name)
    assert.equal(rules.command(`${agent.name}, pause`)?.kind, 'pause', agent.name)
    assert.deepEqual(checkName(agent).errors, [], agent.name)
  }
})
