// The speaker probe's parts, on their own: the setting, the bot request, reading Recall's events, attributing a turn,
// what is kept of a name, what the file holds (and never holds), and how fast it is worked out.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { config, speakerProbeSetting } from '../src/config.ts'
import { joinChatMessage } from '../src/consent.ts'
import { PARTICIPANT_EVENTS, type Platform, botRequest, recallEventsUrl } from '../src/recall.ts'
import { attribute } from '../src/speakers/attribute.ts'
import { type EventKind, type RecallParticipantEvent, parseParticipantEvent } from '../src/speakers/events.ts'
import {
  ENDINGS,
  MAX_SAMPLES,
  MAX_EVENTS,
  MAX_PARTICIPANTS,
  MAX_SCORED,
  MAX_TURNS,
  type ProbeSummary,
  SpeakerProbe,
  gridConfigs,
  gridKey,
  nameFacts,
  probeCodeword,
  samples,
} from '../src/speakers/probe.ts'

const ZOOM = 'https://us06web.zoom.us/j/123456789?pwd=abc'
const BOT_NAME = "Alex (Sam's AI assistant)"
const T0 = Date.UTC(2026, 10, 15, 10, 0, 0)

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-probe-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

// --- The setting and the bot request ---------------------------------------------------------------------------------

test('SPEAKER_PROBE is on only for 1 or true: unset or empty is off, and anything else is off with a warning', () => {
  const warned: string[] = []
  const warn = (m: string) => void warned.push(m)
  assert.equal(speakerProbeSetting('1', warn), true)
  assert.equal(speakerProbeSetting('true', warn), true)
  assert.equal(speakerProbeSetting(' TRUE ', warn), true)
  assert.equal(speakerProbeSetting('', warn), false)
  assert.deepEqual(warned, [])
  for (const value of ['yes', '0', 'on', 'false']) assert.equal(speakerProbeSetting(value, warn), false, value)
  assert.equal(warned.length, 4)
  assert.match(warned[0], /^\[config\] SPEAKER_PROBE=yes is not 1 or true, so the speaker probe is off$/)
  // The tests never run with it on, whatever .env says.
  assert.equal(config.speakerProbe, false)
})

test('without the speaker probe the bot request is byte for byte what it was; with it, the participant events go to their own URL beside retention: null', () => {
  const plan = { meetingUrl: ZOOM, pageUrl: 'https://assistant.example.com/agent?key=k&token=t' }
  const before = JSON.stringify({
    meeting_url: plan.meetingUrl,
    bot_name: config.botName,
    output_media: { camera: { kind: 'webpage', config: { url: plan.pageUrl } } },
    variant: { zoom: 'web_4_core', google_meet: 'web_4_core', microsoft_teams: 'web_4_core' },
    chat: { on_bot_join: { send_to: 'everyone', message: joinChatMessage() } },
    automatic_leave: { waiting_room_timeout: 600, noone_joined_timeout: 300, silence_detection: { timeout: 900, activate_after: 600 } },
    recording_config: { retention: null },
  })
  assert.equal(JSON.stringify(botRequest(plan)), before)
  assert.equal(JSON.stringify(botRequest({ ...plan, eventsUrl: undefined })), before)

  // The trailing "/" before the query: without it Recall answers 400.
  const eventsUrl = recallEventsUrl('https://assistant.example.com', 'key-1', 'tok_en-1')
  assert.equal(eventsUrl, 'wss://assistant.example.com/recall/?key=key-1&token=tok_en-1')
  assert.equal(recallEventsUrl('https://assistant.example.com:8443', 'k', 't'), 'wss://assistant.example.com:8443/recall/?key=k&token=t')
  const probed = botRequest({ ...plan, eventsUrl })
  assert.deepEqual(probed.recording_config, {
    retention: null,
    realtime_endpoints: [{ type: 'websocket', url: eventsUrl, events: [...PARTICIPANT_EVENTS] }],
  })
  assert.equal('realtime_endpoints' in probed, false, 'inside recording_config, never beside it')
  const { recording_config: _probed, ...rest } = probed
  const { recording_config: _plain, ...restBefore } = botRequest(plan)
  assert.deepEqual(rest, restBefore)
  assert.deepEqual(
    [...PARTICIPANT_EVENTS],
    ['join', 'leave', 'update', 'speech_on', 'speech_off'].map(k => `participant_events.${k}`),
  )
})

// --- Recall's events ---------------------------------------------------------------------------------------------------

/** A participant event as Recall's payload page (2026-04-17) documents it. */
function payload(overrides: { event?: string; participant?: object; timestamp?: object; bot?: object; extra?: object } = {}) {
  return {
    event: overrides.event ?? 'participant_events.speech_on',
    data: {
      data: {
        participant: {
          id: 16998240,
          name: 'Probe Alpha',
          is_host: true,
          platform: 'desktop',
          extra_data: { zoom: { os: 2, guest: false, user_guid: 'EF3AL77C-49AB-6F8A-A947-61C6AB57D6E6', conf_user_id: 'RiajKBaChMxzJAmuF90nln' } },
          email: null,
          ...overrides.participant,
        },
        timestamp: { absolute: '2026-11-15T10:00:01.250Z', relative: 12.5, ...overrides.timestamp },
        data: null,
      },
      realtime_endpoint: { id: 're-1', metadata: {} },
      participant_events: { id: 'pe-1', metadata: {} },
      recording: { id: 'rec-1', metadata: {} },
      bot: { id: 'bot-1', metadata: {}, ...overrides.bot },
      ...overrides.extra,
    },
  }
}
const parse = (p: unknown) => parseParticipantEvent(typeof p === 'string' ? p : JSON.stringify(p))

test("Recall's documented participant event is read, with unknown fields ignored, and only categories of its platform data", () => {
  const got = parse(payload())
  assert.ok('event' in got)
  assert.deepEqual(got.event, {
    kind: 'speech_on',
    pid: 16998240,
    name: 'Probe Alpha',
    isHost: true,
    platform: 'desktop',
    extra: { key: 'zoom', stableId: true },
    emailPresent: false,
    at: Date.parse('2026-11-15T10:00:01.250Z'),
    rel: 12.5,
    botId: 'bot-1',
  })
  // Fields Recall adds later, and the envelope objects, are not a reason to drop it.
  const more = parse(payload({ participant: { new_field: [1, 2] }, extra: { something_new: { x: 1 } } }))
  assert.ok('event' in more)
  for (const kind of ['join', 'leave', 'update', 'speech_off'] as const) {
    const ev = parse(payload({ event: `participant_events.${kind}` }))
    assert.ok('event' in ev && ev.event.kind === kind, kind)
  }
  // Teams and Meet: whether there is an id that stays, never its value.
  const teams = parse(payload({ participant: { platform: null, extra_data: { microsoft_teams: { user_id: '8:orgid:780027c1', tenant_id: 'c21986f7' } }, email: 'a@b.example' } }))
  assert.ok('event' in teams)
  assert.deepEqual([teams.event.platform, teams.event.extra, teams.event.emailPresent], [null, { key: 'microsoft_teams', stableId: true }, true])
  const meet = parse(payload({ participant: { platform: 'unknown', extra_data: { google_meet: { static_participant_id: null } } } }))
  assert.ok('event' in meet && meet.event.extra.stableId === false && meet.event.platform === 'unknown')
  const blank = parse(payload({ participant: { extra_data: { zoom: { conf_user_id: '' } } } }))
  assert.ok('event' in blank && blank.event.extra.stableId === false, 'an empty id is none')
  const odd = parse(payload({ participant: { platform: 'Some Device!', extra_data: { other_platform: {} }, name: null, is_host: null } }))
  assert.ok('event' in odd)
  assert.deepEqual([odd.event.platform, odd.event.extra.key, odd.event.name, odd.event.isHost], ['other', 'other', null, null])
})

test("an event that isn't as documented is dropped as malformed, another event name as unknown_event, and nothing throws", () => {
  const malformed = [
    payload({ participant: { id: 1.5 } }),
    payload({ participant: { id: -1 } }),
    payload({ participant: { id: '7' } }),
    payload({ participant: { name: 42 } }),
    payload({ participant: { is_host: 'yes' } }),
    payload({ timestamp: { absolute: undefined } }),
    payload({ timestamp: { absolute: 'not a date' } }),
    payload({ timestamp: { absolute: `2026-11-15T10:00:00Z${' '.repeat(40)}` } }),
    payload({ timestamp: { relative: -1 } }),
    payload({ timestamp: { relative: '12' } }),
    payload({ bot: { id: 'bot/../1' } }),
    payload({ bot: { id: '' } }),
    { event: 'participant_events.speech_on' },
    [payload()],
    'not json',
    '"just a string"',
    { event: 'speech_on', data: {} },
  ]
  for (const p of malformed) assert.deepEqual(parse(p), { dropped: 'malformed' }, JSON.stringify(p).slice(0, 120))
  assert.deepEqual(parseParticipantEvent(Buffer.from([0xff, 0xfe, 0x00])), { dropped: 'malformed' })
  assert.deepEqual(parse(payload({ event: 'participant_events.microphone_on' })), { dropped: 'unknown_event' })
  assert.deepEqual(parse(payload({ event: 'transcript.data' })), { dropped: 'unknown_event' })
  // Fuzzing: random bytes and mangled payloads never throw.
  const base = JSON.stringify(payload())
  for (let i = 0; i < 3000; i++) {
    const chars = [...base]
    for (let j = 0; j < 1 + (i % 7); j++) chars[(i * 7919 + j * 104729) % chars.length] = String.fromCharCode((i * 31 + j) % 128)
    assert.doesNotThrow(() => parseParticipantEvent(chars.join('')))
    assert.doesNotThrow(() => parseParticipantEvent(Buffer.from(chars.join('').slice(0, i % base.length))))
  }
})

test('a name is read without control, format or bidi characters, normalized, trimmed, and cut to 256 code points', () => {
  const name = (n: string) => {
    const got = parse(payload({ participant: { name: n } }))
    assert.ok('event' in got)
    return got.event.name
  }
  assert.equal(name('  Probe​ Alpha‮\u0007 '), 'Probe Alpha')
  assert.equal(name('Café'), 'Café')
  assert.equal([...name('😀'.repeat(300))!].length, 256)
})

// --- Attributing a turn ----------------------------------------------------------------------------------------------

test('a turn goes to the one participant speaking through it, and to nobody when two are, or none, or too little', () => {
  const o = { startTol: 400, endTol: 300, minShare: 0.4, ratio: 2, now: 20_000 }
  const span = { start: 1000, end: 3000 }
  assert.deepEqual(attribute([{ pid: 1, start: 900, end: 3100 }], span, o)?.pid, 1)
  assert.equal(attribute([{ pid: 1, start: 900, end: 3100 }, { pid: 2, start: 1000, end: 3000 }], span, o), null, 'overlap')
  assert.equal(attribute([], span, o), null)
  assert.equal(attribute([{ pid: 1, start: 2800, end: 3100 }], span, o), null, 'under minShare')
  // Still speaking: the stretch runs to now.
  assert.equal(attribute([{ pid: 1, start: 900, end: null }], span, o)?.pid, 1)
  // The runner-up must be well behind: 2x by ratio.
  assert.equal(attribute([{ pid: 1, start: 900, end: 3100 }, { pid: 2, start: 2000, end: 3300 }], span, o), null)
  assert.equal(attribute([{ pid: 1, start: 900, end: 3100 }, { pid: 2, start: 2600, end: 3300 }], span, o)?.pid, 1)
  // A late speech_off from the speaker before (Meet, Teams) does not take the turn from the new one.
  assert.equal(attribute([{ pid: 1, start: 0, end: 1300 }, { pid: 2, start: 1100, end: 3200 }], span, o)?.pid, 2)
  // Zoom's bursts: close stretches merge into one.
  const bursts = [0, 1, 2, 3].map(i => ({ pid: 3, start: 900 + i * 560, end: 900 + i * 560 + 100 }))
  assert.equal(attribute(bursts, span, o), null, 'unmerged, too little')
  assert.equal(attribute(bursts, span, { ...o, mergeGapMs: 700 })?.pid, 3)
  // The bot is never chosen.
  assert.equal(attribute([{ pid: 9, start: 900, end: 3100 }], span, { ...o, exclude: new Set([9]) }), null)
})

// --- What is kept of a name ------------------------------------------------------------------------------------------

test('a name becomes categories and a salted hash: its shape, whether it is the bot, and its test label', () => {
  const salt = Buffer.alloc(32, 1)
  const shape = (n: string | null) => nameFacts(n, salt, BOT_NAME).shape
  assert.equal(shape('+1 415-555-0100'), 'phone_like')
  assert.equal(shape('(415) 555 0100'), 'phone_like')
  assert.equal(shape('1415****89'), 'phone_masked')
  assert.equal(shape('Call-in User_1'), 'placeholder')
  assert.equal(shape('Guest'), 'placeholder')
  assert.equal(shape('Unknown 3'), 'placeholder')
  assert.equal(shape('Probe Alpha'), 'letters')
  assert.equal(shape("Zoë O'Neil-Smith"), 'letters')
  assert.equal(shape('Room 4B'), 'letters_digits')
  assert.equal(shape('   '), 'empty')
  assert.equal(shape(null), 'null')
  assert.equal(shape('🎧 DJ'), 'other')
  assert.equal(nameFacts(BOT_NAME, salt, BOT_NAME).botMatch, 'exact')
  assert.equal(nameFacts(`${BOT_NAME} (Unverified)`, salt, BOT_NAME).botMatch, 'prefix')
  assert.equal(nameFacts('Alex Smith', salt, BOT_NAME).botMatch, 'none')
  assert.deepEqual(['Probe Alpha', 'probe_alfa', 'PROBE-Foxtrot', 'Probe Golf', 'Alpha'].map(n => nameFacts(n, salt, BOT_NAME).label), [0, 0, 5, null, null])
  // The same name, the same hash in one meeting (case and spaces aside); never the same across meetings.
  const hash = (n: string, s = salt) => nameFacts(n, s, BOT_NAME).hash
  assert.equal(hash('Probe Alpha'), hash(' probe alpha '))
  assert.notEqual(hash('Probe Alpha'), hash('Probe Bravo'))
  assert.notEqual(hash('Probe Alpha'), hash('Probe Alpha', Buffer.alloc(32, 2)))
  assert.match(hash('Probe Alpha')!, /^[0-9a-f]{32}$/)
  assert.equal(nameFacts(null, salt, BOT_NAME).hash, null)
})

test('the probe gets only the index of the code word a turn starts with', () => {
  assert.equal(probeCodeword('Alpha here.'), 0)
  assert.equal(probeCodeword('alfa, okay'), 0)
  assert.equal(probeCodeword('"Echo." I am reading a longer sentence now'), 4)
  assert.equal(probeCodeword('Foxtrot'), 5)
  assert.equal(probeCodeword('So, alpha'), null)
  assert.equal(probeCodeword('Golf here'), null)
  assert.equal(probeCodeword(''), null)
})

// --- What the file holds ---------------------------------------------------------------------------------------------

test('timings are rounded to 10 ms and sorted, so they keep no order of events; past the cap, evenly spaced ones are kept', () => {
  assert.deepEqual(samples([1004, -12, 30, 7, Number.NaN]), [-10, 10, 30, 1000])
  const many = samples(Array.from({ length: 10_000 }, (_, i) => (i * 7919) % 10_000))
  assert.equal(many.length, MAX_SAMPLES)
  assert.deepEqual([many[0], many.at(-1)], [0, 10_000])
  assert.ok(many.every((v, i) => i === 0 || many[i - 1] <= v))
})

type Person = { pid: number; name: string | null; platform?: RecallParticipantEvent['platform']; isHost?: boolean | null }

/** A meeting the probe measures, on a timeline in ms from T0: who says what, and when. */
function meeting(t: { after: (fn: () => void) => void }, platform: Platform = 'google_meet') {
  const dir = tempDir(t)
  const probe = new SpeakerProbe({ platform, botName: BOT_NAME, dir, salt: Buffer.alloc(32, 3), now: () => T0 })
  const event = (kind: EventKind, who: Person, rx: number, o: { delay?: number; rel?: number } = {}) =>
    probe.event(
      {
        kind,
        pid: who.pid,
        name: who.name,
        isHost: who.isHost ?? false,
        platform: who.platform === undefined ? 'desktop' : who.platform,
        extra: { key: 'none', stableId: false },
        emailPresent: false,
        // Recall's own time: 200 ms before it arrives, unless the test says otherwise.
        at: T0 + rx - (o.delay ?? 200),
        rel: o.rel ?? 60 + rx / 1000,
        botId: 'bot-1',
      },
      T0 + rx,
    )
  /** A turn whose first word arrived at fw and last at lw, which Flux started at sot and ended at eot. */
  const turn = (fw: number | null, lw: number | null, o: { sot?: number; eot?: number; codeword?: number | null } = {}) => {
    probe.turnStarted(T0 + (o.sot ?? (fw ?? 0) + 150))
    probe.turnEnded({
      rx: T0 + (o.eot ?? (lw ?? 0) + 600),
      first: fw === null ? null : T0 + fw,
      last: lw === null ? null : T0 + lw,
      words: 6,
      wordTimes: false,
      codeword: o.codeword ?? null,
    })
  }
  const write = (ending: (typeof ENDINGS)[number] = 'ended'): ProbeSummary => {
    const file = probe.write({ stem: 'meeting', startedAt: new Date(T0), endedAt: new Date(T0 + 15 * 60_000), ending })
    assert.ok(file)
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  }
  return { probe, event, turn, write, dir }
}

const ALPHA = { pid: 1, name: 'Probe Alpha' }
const BRAVO = { pid: 2, name: 'Probe Bravo' }
const CHARLIE = { pid: 3, name: 'Probe Charlie' }
const PHONE = { pid: 4, name: '+1 415 555 0100', platform: 'dial_in' as const }

test("a single turn's timings, measured from its first and last word, on Recall's clock and on arrival", t => {
  const m = meeting(t)
  m.event('join', ALPHA, 0, { rel: 1 })
  // Flux's first word arrived at 10,000; speech_on came 300 ms later, stamped by Recall 200 ms before it came.
  m.event('speech_on', ALPHA, 10_300)
  m.event('speech_off', ALPHA, 14_500)
  m.turn(10_000, 14_000, { sot: 10_150, eot: 14_600 })
  const f = m.write()
  assert.equal(f.turns.single, 1)
  assert.deepEqual(f.turns.on_minus_fw_rx_ms, [300])
  assert.deepEqual(f.turns.on_at_minus_fw_rx_ms, [100])
  assert.deepEqual(f.turns.on_minus_sot_rx_ms, [150])
  assert.deepEqual(f.turns.off_minus_lw_rx_ms, [500])
  assert.equal(f.turns.on_after_eot, 0)
  assert.deepEqual(f.delay_ms.speech_on, [200])
  assert.deepEqual(f.events, { join: 1, leave: 0, update: 0, speech_on: 1, speech_off: 1 })
  assert.equal(f.flux.turns, 1)
  assert.equal(f.flux.timed, 1)
  assert.equal(f.participants.joins_first_5s, 1)
})

test("turn classes: a speech_on after the turn ended, one already open, two speakers, none, Alex's audio, short", t => {
  const m = meeting(t)
  // A speech_on that comes after Flux ended the turn.
  m.turn(10_000, 12_000, { eot: 12_400 })
  m.event('speech_on', ALPHA, 12_900)
  m.event('speech_off', ALPHA, 13_000)
  // Bravo's speaking opened long before, and never closed: the turn is Bravo's, with no speech_on of its own.
  m.event('speech_on', BRAVO, 20_000)
  m.turn(40_000, 42_000)
  m.event('speech_off', BRAVO, 46_000)
  // Two people speaking.
  m.event('speech_on', ALPHA, 60_000)
  m.event('speech_on', CHARLIE, 60_100)
  m.turn(60_000, 62_000)
  m.event('speech_off', ALPHA, 62_200)
  m.event('speech_off', CHARLIE, 62_200)
  // Nobody, then while Alex speaks, then short.
  m.turn(80_000, 82_000)
  m.probe.agentAudio(T0 + 99_000, T0 + 104_000)
  m.turn(100_000, 102_000)
  m.event('speech_on', ALPHA, 120_000)
  m.turn(120_000, 120_500)
  m.event('speech_off', ALPHA, 120_700)
  // One speaker, but another turn hard on its heels: both crowded.
  m.event('speech_on', BRAVO, 140_000)
  m.turn(140_000, 142_000)
  m.turn(143_000, 145_000)
  m.event('speech_off', BRAVO, 145_200)
  const f = m.write()
  assert.equal(f.turns.on_after_eot, 1)
  assert.deepEqual(f.turns.on_after_eot_ms, [500])
  assert.equal(f.turns.already_open, 1)
  assert.equal(f.turns.crowded, 3)
  assert.equal(f.turns.no_event, 1)
  assert.equal(f.turns.while_agent, 1)
  assert.equal(f.turns.short, 1)
  assert.equal(f.turns.single, 3)
  assert.equal(f.agent.audio_s, 5)
})

test('the bot is found by its name, or by speaking while Alex does; noise is a speech_on with no words near it', t => {
  const m = meeting(t, 'microsoft_teams')
  m.event('join', { pid: 8, name: `${BOT_NAME} (Unverified)` }, 0)
  // A participant with another name whose speech_on comes during Alex's audio: Alex's own bot, as far as can be told.
  const room = { pid: 9, name: 'Meeting Room' }
  for (const at of [10_000, 30_000, 50_000]) {
    m.probe.agentAudio(T0 + at - 500, T0 + at + 3000)
    m.event('speech_on', room, at)
    m.event('speech_off', room, at + 2500)
  }
  m.event('speech_on', { pid: 8, name: `${BOT_NAME} (Unverified)` }, 30_200)
  // A cough: no turn within 3 s.
  m.event('speech_on', ALPHA, 70_000)
  m.event('speech_off', ALPHA, 70_300)
  const f = m.write()
  assert.equal(f.bot.seen, true)
  assert.equal(f.bot.name_match, 'prefix')
  assert.equal(f.bot.speech_on, 1)
  assert.equal(f.bot.speech_on_while_agent, 1)
  assert.equal(f.bot.self_candidates, 1)
  assert.deepEqual(f.bot.self_candidate_name_match, { exact: 0, prefix: 0, none: 1 })
  assert.equal(f.turns.events_without_words, 1, "only the cough: the bot's own are not a human's")
})

test('the roster: joins at the start, people seen first speaking, re-joins under the same or a new id, renames, hosts, phone callers', t => {
  const m = meeting(t, 'zoom')
  m.event('join', { ...ALPHA, isHost: true }, 0, { rel: 2 })
  m.event('join', BRAVO, 100, { rel: 3 })
  m.event('speech_on', CHARLIE, 5000, { rel: 30 })
  m.event('join', PHONE, 6000, { rel: 40 })
  m.event('speech_on', PHONE, 7000)
  m.event('speech_off', PHONE, 9000)
  m.event('leave', BRAVO, 10_000)
  m.event('join', BRAVO, 20_000)
  m.event('leave', ALPHA, 30_000)
  // Back with a new id (Meet does this): the same name, by its hash.
  m.event('join', { pid: 11, name: 'Probe Alpha' }, 40_000)
  m.event('update', { pid: 3, name: 'Probe Delta' }, 50_000)
  m.event('update', { ...BRAVO, isHost: true }, 60_000)
  const f = m.write()
  const p = f.participants
  assert.equal(p.total, 5)
  assert.equal(p.max_present, 4)
  assert.equal(p.joins_first_5s, 2)
  assert.equal(p.present_without_join, 1)
  assert.deepEqual(p.first_seen_by, { join: 4, leave: 0, update: 0, speech_on: 1, speech_off: 0 })
  assert.equal(p.rejoin_same_id, 1)
  assert.equal(p.rejoin_new_id, 1)
  assert.equal(p.renames, 1)
  assert.equal(p.host_changes, 1)
  assert.deepEqual(p.dial_in, { count: 1, name_shape: { ...zeroShapes(), phone_like: 1 }, spoke: 1 })
  assert.equal(p.platform.dial_in, 1)
  assert.equal(p.probe_labels, 4)
  assert.equal(f.bot.seen, false)
  assert.equal(f.bot.name_match, 'unseen')
})

function zeroShapes() {
  return { null: 0, empty: 0, phone_like: 0, phone_masked: 0, placeholder: 0, letters: 0, letters_digits: 0, other: 0 }
}

test("scoring: each setting's right, wrong and none, against who had the turn's code word then, a rename and phone callers included", t => {
  const m = meeting(t)
  for (const who of [ALPHA, BRAVO, CHARLIE, PHONE]) m.event('join', who, 0)
  const said = (who: Person, fw: number, codeword: number) => {
    m.event('speech_on', who, fw + 300)
    m.event('speech_off', who, fw + 2300)
    m.turn(fw, fw + 2000, { codeword })
  }
  said(ALPHA, 10_000, 0) // right
  said(ALPHA, 20_000, 1) // "Bravo" said in Alpha's voice, by Recall's account: wrong
  m.turn(30_000, 32_000, { codeword: 0 }) // nobody speaking: none
  said(CHARLIE, 40_000, 2) // right
  // Every event after a rename carries the new name.
  const delta = { pid: 3, name: 'Probe Delta' }
  m.event('update', delta, 45_000)
  said(delta, 50_000, 3) // right: the label after the rename
  said(PHONE, 60_000, 4) // "Echo": nobody is labelled so, so the phone callers are
  m.turn(70_000, 72_000, { codeword: 5 }) // Foxtrot: nobody has it
  const f = m.write()
  assert.equal(f.scored.turns, 6)
  assert.equal(f.scored.unmapped, 1)
  const cell = f.scored.grid[gridKey({ clock: 'rx', startTol: 400, endTol: 300, minShare: 0.4, ratio: 2 }, 'eot', 'normal')]
  assert.deepEqual(cell, [4, 1, 1])
  // Recall's own clock waits for three single turns to correct it by: the first three abstain.
  const adj = f.scored.grid[gridKey({ clock: 'abs_adj', startTol: 400, endTol: 300, minShare: 0.4, ratio: 2 }, 'eot', 'normal')]
  assert.equal(adj[0] + adj[1] + adj[2], 6)
  assert.ok(adj[2] >= 3)
  // Every setting, both views: no short turns here.
  assert.equal(Object.keys(f.scored.grid).length, gridConfigs().length * 2)
  assert.ok(Object.keys(f.scored.grid).every(k => k.endsWith('|normal')))
})

test('the caps: events, participants and turns past them are counted, not kept, and scoring stops at 1,000 turns', t => {
  const m = meeting(t)
  for (let i = 0; i < MAX_PARTICIPANTS + 5; i++) m.event('join', { pid: 1000 + i, name: `Person ${String.fromCharCode(65 + (i % 26))}` }, i)
  const first = { pid: 1000, name: 'Probe Alpha' }
  for (let i = 0; i < MAX_EVENTS; i++) m.event(i % 2 ? 'speech_off' : 'speech_on', first, 1000 + i)
  for (let i = 0; i < MAX_TURNS + 3; i++) m.turn(100_000 + i * 10, 100_000 + i * 10 + 5, { codeword: 0 })
  const f = m.write()
  assert.equal(f.participants.total, MAX_PARTICIPANTS)
  assert.equal(Object.values(f.events).reduce((a, b) => a + b, 0), MAX_EVENTS)
  assert.equal(f.endpoint.dropped.overflow, 5 + MAX_PARTICIPANTS)
  assert.equal(f.flux.turns, MAX_TURNS)
  assert.equal(f.flux.dropped, 3)
  assert.equal(f.scored.turns, MAX_SCORED)
  assert.equal(f.scored.over_cap, MAX_TURNS - MAX_SCORED)
  assert.ok(f.delay_ms.speech_on.length <= 2000, 'samples are capped')
})

test('working out the file at the caps takes well under half a second, so the other meetings are not held up', t => {
  const m = meeting(t, 'zoom')
  const people = Array.from({ length: 24 }, (_, i) => ({ pid: i, name: i < 6 ? `Probe ${['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'][i]}` : `Person ${i}` }))
  for (const p of people) m.event('join', p, 0)
  // Three hours: a turn every 2 s, each with its speaker's bursts and others' noise around it, until the caps.
  let events = people.length
  for (let i = 0; i < MAX_TURNS; i++) {
    const fw = 10_000 + i * 2100
    const speaker = people[i % 6]
    for (let j = 0; j < 4 && events < MAX_EVENTS; j++, events += 2) {
      m.event('speech_on', speaker, fw + j * 450)
      m.event('speech_off', speaker, fw + j * 450 + 300)
    }
    for (let j = 0; j < 3 && events < MAX_EVENTS; j++, events += 2) {
      const other = people[6 + ((i + j) % 18)]
      m.event('speech_on', other, fw + 200 + j * 500)
      m.event('speech_off', other, fw + 400 + j * 500)
    }
    m.turn(fw, fw + 1800, { codeword: i % 6 })
    if (i % 10 === 0) m.probe.agentAudio(T0 + fw + 1900, T0 + fw + 2050)
  }
  const started = performance.now()
  const f = m.write()
  const took = performance.now() - started
  assert.equal(f.scored.turns, MAX_SCORED)
  assert.ok(took < 500, `${Math.round(took)} ms`)
})

test("the file holds only the schema's keys, numbers, its enum values and the date: no name, id, email or link of anyone", t => {
  const m = meeting(t, 'microsoft_teams')
  const raw = [
    payload({ event: 'participant_events.join', participant: { id: 501, name: 'Probe Alpha', extra_data: { microsoft_teams: { user_id: '8:orgid:4f1c9e2a-dist-inct', tenant_id: 'tenant-7b3d-9e1f-distinct' } }, email: 'alpha.tester@example.org' } }),
    payload({ event: 'participant_events.join', participant: { id: 502, name: '+1 415 555 0100', platform: 'dial_in', extra_data: null } }),
    payload({ event: 'participant_events.speech_on', participant: { id: 501, name: 'Probe Alpha' }, timestamp: { absolute: '2026-11-15T10:00:10.100Z' } }),
    payload({ event: 'participant_events.speech_off', participant: { id: 501, name: 'Probe Alpha' }, timestamp: { absolute: '2026-11-15T10:00:12.300Z' } }),
    payload({ event: 'participant_events.update', participant: { id: 501, name: 'Probe Delta Renamed' } }),
  ]
  for (const [i, p] of raw.entries()) {
    const got = parse(p)
    assert.ok('event' in got)
    m.probe.event(got.event, T0 + 10_000 + i * 1000)
  }
  m.turn(10_000, 12_000, { codeword: 0 })
  const file = m.probe.write({ stem: '2026-11-15-10-00-0f8e4c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b', startedAt: new Date(T0), endedAt: new Date(T0 + 60_000), ending: 'ended' })
  assert.ok(file)
  const text = fs.readFileSync(file, 'utf8')
  for (const secret of ['Probe', 'Alpha', 'Delta', 'Renamed', '415 555', '4155550100', 'orgid', 'dist-inct', 'tenant', 'alpha.tester', 'example.org', 'RiajKBaChMxzJAmuF90nln', 'EF3AL77C', 'bot-1', 're-1', '0f8e4c1a', 'https:']) {
    assert.ok(!text.includes(secret), secret)
  }
  // Every key is the schema's, and every string one of its values or the date.
  const strings = new Set(['speaker-probe', 'zoom', 'google_meet', 'microsoft_teams', ...ENDINGS, 'exact', 'prefix', 'unseen', 'true', 'false', 'null'])
  const gridKeys = new Set(gridConfigs().flatMap(c => ['eot', 'settled'].flatMap(v => ['short', 'normal'].map(l => gridKey(c, v, l)))))
  const walk = (value: unknown, schema: unknown, at: string): void => {
    if (typeof value === 'string') {
      assert.ok(strings.has(value) || (at === '.date' && /^\d{4}-\d{2}-\d{2}$/.test(value)), `${at}: ${value}`)
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      // Numbers, flags and nothing.
    } else if (Array.isArray(value)) {
      for (const [i, v] of value.entries()) assert.equal(typeof v, 'number', `${at}[${i}]`)
    } else {
      for (const [key, v] of Object.entries(value as object)) {
        const known = at === '.scored.grid' ? gridKeys.has(key) : Object.hasOwn(schema as object, key)
        assert.ok(known, `${at}.${key} is not in the schema`)
        walk(v, at === '.scored.grid' ? [] : (schema as Record<string, unknown>)[key], `${at}.${key}`)
      }
    }
  }
  walk(JSON.parse(text), SCHEMA, '')
})

// The file's keys, version 1: what the privacy walk allows.
const counts = (...keys: string[]) => Object.fromEntries(keys.map(k => [k, 0]))
const KINDS = counts('join', 'leave', 'update', 'speech_on', 'speech_off')
const SHAPES = counts('null', 'empty', 'phone_like', 'phone_masked', 'placeholder', 'letters', 'letters_digits', 'other')
const SCHEMA = {
  kind: 0,
  v: 0,
  platform: 0,
  date: 0,
  minutes: 0,
  ending: 0,
  endpoint: {
    connections: 0,
    replaced: 0,
    closes: counts('1000', '1006', '1009', 'other'),
    ping_timeouts: 0,
    first_event_after_page_ms: 0,
    events_before_page: 0,
    longest_quiet_s: 0,
    dropped: counts('binary', 'too_big', 'malformed', 'unknown_event', 'wrong_bot', 'rate', 'overflow'),
  },
  events: KINDS,
  delay_ms: KINDS,
  recall_clock_spread_ms: 0,
  flux: counts('turns', 'timed', 'word_times', 'dropped', 'lag_ms'),
  agent: counts('audio_s'),
  participants: {
    ...counts('total', 'max_present', 'joins_first_5s', 'present_without_join', 'rejoin_same_id', 'rejoin_new_id', 'renames', 'host_changes', 'stable_id', 'email_present', 'probe_labels'),
    first_seen_by: KINDS,
    host: counts('true', 'false', 'null'),
    platform: counts('desktop', 'dial_in', 'unknown', 'other', 'null'),
    name_shape: SHAPES,
    extra_data: counts('zoom', 'microsoft_teams', 'google_meet', 'webex', 'other', 'none'),
    dial_in: { count: 0, spoke: 0, name_shape: SHAPES },
  },
  bot: { ...counts('seen', 'name_match', 'is_host', 'speech_on', 'speech_on_while_agent', 'self_candidates'), self_candidate_name_match: counts('exact', 'prefix', 'none') },
  turns: counts(
    'with_words', 'single', 'crowded', 'no_event', 'while_agent', 'already_open', 'short', 'on_minus_sot_rx_ms', 'on_minus_fw_rx_ms',
    'on_at_minus_fw_rx_ms', 'off_minus_lw_rx_ms', 'on_after_eot', 'on_after_eot_ms', 'same_turn_gap_ms', 'events_without_words',
  ),
  scored: { turns: 0, unmapped: 0, over_cap: 0, grid: {} },
}

test('the file is written readable by you only, in a folder made private again at every write, by way of .next', t => {
  const dir = path.join(tempDir(t), 'speaker-probe')
  fs.mkdirSync(dir, { mode: 0o755 })
  fs.chmodSync(dir, 0o755)
  // A file left at its name, or half written beside it (by a crash, say), is replaced whole, and made private.
  for (const left of ['a-meeting.json', 'a-meeting.json.next']) {
    fs.writeFileSync(path.join(dir, left), 'old', { mode: 0o644 })
    fs.chmodSync(path.join(dir, left), 0o644)
  }
  const probe = new SpeakerProbe({ platform: 'zoom', botName: BOT_NAME, dir })
  const file = probe.write({ stem: 'a-meeting', startedAt: new Date(T0), endedAt: new Date(T0), ending: 'unconfirmed' })
  assert.equal(file, path.join(dir, 'a-meeting.json'))
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(fs.readdirSync(dir), ['a-meeting.json'])
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).ending, 'unconfirmed')
  // Once only; and a discard afterwards ("please leave" in a later session) deletes it.
  assert.equal(probe.write({ stem: 'again', startedAt: new Date(T0), endedAt: new Date(T0), ending: 'ended' }), null)
  let closed = 0
  const discarded = new SpeakerProbe({ platform: 'zoom', botName: BOT_NAME, dir, onDiscard: () => closed++ })
  const kept = discarded.write({ stem: 'b-meeting', startedAt: new Date(T0), endedAt: new Date(T0), ending: 'ended' })!
  assert.ok(fs.existsSync(kept))
  discarded.discard()
  discarded.discard()
  assert.equal(fs.existsSync(kept), false)
  assert.equal(closed, 1)
  // A discarded probe takes nothing and writes nothing.
  const left = new SpeakerProbe({ platform: 'zoom', botName: BOT_NAME, dir })
  left.discard()
  assert.equal(left.accepting, false)
  assert.equal(left.write({ stem: 'c-meeting', startedAt: new Date(T0), endedAt: new Date(T0), ending: 'ended' }), null)
  // Nor to a name that is not a transcript's.
  assert.equal(new SpeakerProbe({ platform: 'zoom', botName: BOT_NAME, dir }).write({ stem: '../x', startedAt: new Date(T0), endedAt: new Date(T0), ending: 'ended' }), null)
  assert.deepEqual(fs.readdirSync(dir), ['a-meeting.json'])
})

test("a file that can't be written logs its error's code only, never its path, and leaves nothing behind", t => {
  const base = tempDir(t)
  const blocked = path.join(base, 'not-a-folder')
  fs.writeFileSync(blocked, '')
  const errors: string[] = []
  t.mock.method(console, 'error', (...args: unknown[]) => void errors.push(args.map(String).join(' ')))
  const probe = new SpeakerProbe({ platform: 'zoom', botName: BOT_NAME, dir: blocked })
  assert.equal(probe.write({ stem: 'secret-key-1', startedAt: new Date(T0), endedAt: new Date(T0), ending: 'ended' }), null)
  t.mock.restoreAll()
  assert.deepEqual(errors, ['[probe] could not keep the speaker measurements (EEXIST)'])
  assert.deepEqual(fs.readdirSync(base), ['not-a-folder'])
})
