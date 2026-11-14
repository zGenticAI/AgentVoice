import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ENDED_SUB_CODES, FATAL_SUB_CODES, RecallError, botEnding, botRequest, deleteMedia, howBotEnded, leaveCall, meetingPlatform, sendChat, worthRetrying } from '../src/recall.ts'
import { joinChatMessage } from '../src/consent.ts'
import { config } from '../src/config.ts'

test('bot request names Alex, streams the page and posts the consent message', () => {
  const body = botRequest({ meetingUrl: 'https://zoom.us/j/912345678', pageUrl: 'https://alex.example/agent' }) as any
  assert.equal(body.bot_name, "Alex (Sam's AI assistant)")
  assert.deepEqual(body.output_media, { camera: { kind: 'webpage', config: { url: 'https://alex.example/agent' } } })
  assert.equal(body.chat.on_bot_join.send_to, 'everyone')
  assert.match(body.chat.on_bot_join.message, /AI assistant/)
  // A Zoom bot joins with the link alone: no OBF or ZAK token (Recall needs none, docs/zoom-overview).
  assert.equal('zoom' in body, false)
})

test('bots are created with Zero Data Retention, so Recall keeps no audio or video, and still stream the page', () => {
  const body = botRequest({ meetingUrl: 'https://meet.google.com/abc-defg-hij', pageUrl: 'https://alex.example/agent' }) as any
  // retention: null, not recording_config: null (which does not work with output media).
  assert.deepEqual(body.recording_config, { retention: null })
  assert.deepEqual(body.output_media, { camera: { kind: 'webpage', config: { url: 'https://alex.example/agent' } } })
})

test('the chat notice says Alex keeps no recording of the meeting, that Sam keeps the summary Sam is sent, and that Alex deletes its own copies', () => {
  const notice = joinChatMessage()
  // Not "No audio or video is kept": unless the account has zero retention, ElevenLabs keeps Alex's own speech. And in
  // the first person: the host may record the meeting, and the notice speaks only for Alex.
  assert.match(notice, /I keep no recording of the meeting/)
  assert.doesNotMatch(notice, /No audio or video is kept|No recording of the meeting is kept/)
  // The session sends Sam the minutes (in Telegram, or the Claude Code session), where the sweep never reaches them.
  assert.match(notice, /I send Sam a summary to keep\./)
  assert.ok(notice.includes(`I delete my own transcripts and summaries after ${config.retentionDays} days`))
  assert.doesNotMatch(notice, /summaries are deleted after/, 'no promise that Sam\'s copy is deleted')
})

test('the chat notice has no link in it', () => {
  const notice = joinChatMessage()
  assert.doesNotMatch(notice, /How your data is handled/)
  assert.doesNotMatch(notice, /https?:\/\//)
  assert.match(notice, /To stop me, say "Alex, please leave" or remove me\.$/)
})

// --- How a bot left the call (https://docs.recall.ai/docs/sub-codes) ------------------------------

const left = (code: string, sub_code: string | null) => [
  { code: 'joining_call', sub_code: null },
  { code: 'in_call_recording', sub_code: null },
  { code, sub_code },
]

test('the host removing the bot, from the call or the waiting room, is a removal', () => {
  assert.deepEqual(botEnding(left('call_ended', 'bot_kicked_from_call')), { kind: 'removed', sub_code: 'bot_kicked_from_call' })
  assert.deepEqual(botEnding(left('call_ended', 'bot_kicked_from_waiting_room')), { kind: 'removed', sub_code: 'bot_kicked_from_waiting_room' })
  // Followed by done, as Recall does once the bot has shut down.
  assert.equal(botEnding([...left('call_ended', 'bot_kicked_from_call'), { code: 'done', sub_code: null }])?.kind, 'removed')
})

test('a meeting that ends, a timeout, or our own leave_call is a normal end', () => {
  for (const sub_code of ['call_ended_by_host', 'timeout_exceeded_everyone_left', 'call_ended_by_platform_idle', 'call_ended_by_platform_max_length', 'timeout_exceeded_noone_joined', 'bot_received_leave_call']) {
    assert.ok(ENDED_SUB_CODES.has(sub_code))
    assert.deepEqual(botEnding(left('call_ended', sub_code)), { kind: 'ended', sub_code })
  }
  assert.equal(ENDED_SUB_CODES.has('bot_kicked_from_call'), false)
  assert.equal(ENDED_SUB_CODES.has('bot_kicked_from_waiting_room'), false)
})

test('a reason Recall does not document is unknown: neither a removal nor a normal end', () => {
  const e = botEnding(left('call_ended', 'bot_removed_by_new_feature<b>'))
  assert.equal(e?.kind, 'unknown')
  assert.match((e as any).why, /"bot_removed_by_new_featureb"$/, 'quoted as plain identifier characters')
  assert.equal(botEnding(left('call_ended', null))?.kind, 'unknown')
})

test('a documented fatal error is a normal end, unless it may mean the bot was put out of the call', () => {
  assert.deepEqual(botEnding(left('fatal', 'bot_errored')), { kind: 'ended', sub_code: 'fatal: bot_errored' })
  assert.deepEqual(botEnding(left('fatal', 'microsoft_teams_call_dropped')), { kind: 'ended', sub_code: 'fatal: microsoft_teams_call_dropped' })
  assert.deepEqual(botEnding(left('fatal', 'zoom_bot_blocked')), { kind: 'ended', sub_code: 'fatal: zoom_bot_blocked' }, 'kept out at the door, never in')
  for (const sub_code of ['google_meet_watermark_kicked', 'zoom_account_blocked']) {
    assert.equal(FATAL_SUB_CODES.has(sub_code), false)
    const e = botEnding(left('fatal', sub_code))
    assert.equal(e?.kind, 'unknown')
    assert.match((e as any).why, new RegExp(`dropped from the call, "${sub_code}"$`))
  }
})

test('a fatal error with no code, or one Recall does not document, is unknown: never a normal end', () => {
  const none = botEnding(left('fatal', null))
  assert.deepEqual(none, { kind: 'unknown', why: 'Recall says the bot failed in the call, but not why' })
  assert.equal(botEnding(left('fatal', ''))?.kind, 'unknown')
  const unseen = botEnding(left('fatal', 'some_new_code'))
  assert.deepEqual(unseen, { kind: 'unknown', why: 'Recall gave an error it does not document for the end of the call, "some_new_code"' })
  // A removal Recall might report under a new name is never taken for a normal end.
  for (const sub_code of ['microsoft_teams_bot_ejected', 'zoom_bot_expelled', 'zoom_bot_removed_by_host']) {
    assert.equal(botEnding(left('fatal', sub_code))?.kind, 'unknown', sub_code)
  }
})

test('a bot still in the call has not ended yet; done without a reason is unknown', () => {
  assert.equal(botEnding([{ code: 'joining_call', sub_code: null }, { code: 'in_call_recording', sub_code: null }]), null)
  assert.equal(botEnding([]), null)
  assert.equal(botEnding([{ code: 'in_call_recording', sub_code: null }, { code: 'done', sub_code: null }])?.kind, 'unknown')
})

test('the bot is read again while it is still finishing, then its ending is returned', async () => {
  const paths: string[] = []
  const get = async (p: string) => {
    paths.push(p)
    return { status_changes: paths.length < 3 ? left('in_call_recording', null).slice(0, 2) : left('call_ended', 'call_ended_by_host') }
  }
  assert.deepEqual(await howBotEnded('b1', { get, everyMs: 0, waitMs: 1000 }), { kind: 'ended', sub_code: 'call_ended_by_host' })
  assert.deepEqual(paths, ['/bot/b1/', '/bot/b1/', '/bot/b1/'])
})

// The timeout makes a lost bound a failure, not a run that never ends (node:test has no default timeout).
test('reading the bot is bounded: failures, no final status and no answer at all end as unknown, with why', { timeout: 2000 }, async () => {
  let n = 0
  const failing = await howBotEnded('b1', { get: async () => { n++; throw new Error('Recall GET /bot/b1/ failed (500): oops') }, everyMs: 5, waitMs: 60 })
  assert.deepEqual(failing, { kind: 'unknown', why: 'Recall could not be read: Recall GET /bot/b1/ failed (500): oops' })
  assert.ok(n > 1, 'tried again')
  const inCall = await howBotEnded('b1', { get: async () => ({ status_changes: left('in_call_recording', null) }), everyMs: 5, waitMs: 40 })
  assert.equal(inCall.kind, 'unknown')
  assert.match((inCall as any).why, /had not said the bot left the call/)
  const startedAt = Date.now()
  let aborted = false
  const hanging = await howBotEnded('b1', {
    get: (_p, signal) => new Promise(() => signal.addEventListener('abort', () => (aborted = true))),
    everyMs: 5,
    waitMs: 80,
  })
  assert.deepEqual(hanging, { kind: 'unknown', why: 'Recall could not be read: no answer in time' })
  assert.ok(Date.now() - startedAt < 500)
  assert.ok(aborted, 'the request is aborted at the bound')
  assert.equal((await howBotEnded('b1', { get: async () => null, everyMs: 5, waitMs: 20 })).kind, 'unknown', 'an empty answer is not an ending')
})

test('meeting links are matched to their platform', () => {
  assert.equal(meetingPlatform('https://us06web.zoom.us/j/81234567890?pwd=abc'), 'zoom')
  assert.equal(meetingPlatform('https://meet.google.com/abc-defg-hij'), 'google_meet')
  assert.equal(meetingPlatform('https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0?context=%7b%7d'), 'microsoft_teams')
  assert.equal(meetingPlatform('https://teams.live.com/meet/9312345678901?p=abc'), 'microsoft_teams')
  assert.equal(meetingPlatform('http://meet.google.com/abc-defg-hij'), null)
  assert.equal(meetingPlatform('https://zoom.us.evil.example/j/1'), null)
  assert.equal(meetingPlatform('https://example.com/meet'), null)
  assert.equal(meetingPlatform('not a link'), null)
})

test('the bot leaves an empty or silent meeting by itself, sooner than Recall would by default', () => {
  const body = botRequest({ meetingUrl: 'https://zoom.us/j/912345678', pageUrl: 'y' }) as any
  assert.deepEqual(body.automatic_leave, {
    // Google Meet allows 10 minutes in the waiting room at most.
    waiting_room_timeout: 600,
    // Recall's default is 20 minutes.
    noone_joined_timeout: 300,
    // Recall's default is 60 minutes of silence, counted after 20 in the call.
    silence_detection: { timeout: 900, activate_after: 600 },
  })
  // Everyone else leaving, and only other bots left, keep Recall's defaults (2 s; its bot detection).
  assert.equal('everyone_left_timeout' in body.automatic_leave, false)
  assert.equal('bot_detection' in body.automatic_leave, false)
  // Each of these is a normal end of the meeting, which gets its minutes.
  for (const code of ['timeout_exceeded_waiting_room', 'timeout_exceeded_noone_joined', 'timeout_exceeded_silence_detected', 'timeout_exceeded_everyone_left']) {
    assert.equal(ENDED_SUB_CODES.has(code), true, code)
  }
})

test('the larger bot size is requested on every platform', () => {
  const body = botRequest({ meetingUrl: 'https://meet.google.com/abc-defg-hij', pageUrl: 'y' }) as any
  assert.deepEqual(body.variant, { zoom: 'web_4_core', google_meet: 'web_4_core', microsoft_teams: 'web_4_core' })
})

// Recall's answer to delete_media just after leave_call, seen live on 2026-10-25.
const IN_PROGRESS = 'Recall POST /bot/b1/delete_media/ failed (400): {"code":"cannot_delete_in_progress_bot_media","detail":"Cannot delete media for an in-progress bot."}'

test('media is deleted once the bot has finished: an in-progress refusal is tried again', async () => {
  const calls: string[] = []
  const post = async (path: string) => {
    calls.push(path)
    if (calls.length < 3) throw new Error(IN_PROGRESS)
  }
  assert.equal(await deleteMedia('b1', { post, everyMs: 0 }), true)
  assert.deepEqual(calls, ['/bot/b1/delete_media/', '/bot/b1/delete_media/', '/bot/b1/delete_media/'])
})

test('media deletion gives up after its tries, and at once on any other refusal', async () => {
  let n = 0
  assert.equal(await deleteMedia('b1', { post: async () => { n++; throw new Error(IN_PROGRESS) }, tries: 4, everyMs: 0 }), false)
  assert.equal(n, 4)
  n = 0
  assert.equal(await deleteMedia('b1', { post: async () => { n++; throw new Error('Recall POST /bot/b1/delete_media/ failed (404): not found') }, everyMs: 0 }), false)
  assert.equal(n, 1)
})

test('a failed Recall call carries its HTTP status, so a leave is tried again only when that can help', async t => {
  const realFetch = globalThis.fetch
  const realKey = process.env.RECALL_API_KEY
  t.after(() => {
    globalThis.fetch = realFetch
    if (realKey === undefined) delete process.env.RECALL_API_KEY
    else process.env.RECALL_API_KEY = realKey
  })
  process.env.RECALL_API_KEY = 'test-key'
  let status = 400
  globalThis.fetch = (async () => new Response('{"detail":"Bot is not in a call"}', { status })) as typeof fetch
  const gone = await leaveCall('b1').catch((err: unknown) => err)
  assert.ok(gone instanceof RecallError)
  assert.equal(gone.status, 400)
  assert.match(gone.message, /^Recall POST \/bot\/b1\/leave_call\/ failed \(400\): \{"detail":"Bot is not in a call"\}$/)
  assert.equal(worthRetrying(gone), false, 'the bot is no longer in the call')
  status = 503
  assert.equal(worthRetrying(await leaveCall('b1').catch((err: unknown) => err)), true, 'Recall is having trouble')
  for (const s of [500, 502, 429, 408]) assert.equal(worthRetrying(new RecallError(s, 'x')), true, String(s))
  for (const s of [401, 403, 404, 409]) assert.equal(worthRetrying(new RecallError(s, 'x')), false, String(s))
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed')
  }) as typeof fetch
  const offline = await leaveCall('b1').catch((err: unknown) => err)
  assert.ok(!(offline instanceof RecallError))
  assert.equal(worthRetrying(offline), true, 'the network is down')
})

test('a refused chat post keeps only its status: Recall may quote the message, which is meeting content, and the error is logged', async t => {
  const realFetch = globalThis.fetch
  const realKey = process.env.RECALL_API_KEY
  t.after(() => {
    globalThis.fetch = realFetch
    if (realKey === undefined) delete process.env.RECALL_API_KEY
    else process.env.RECALL_API_KEY = realKey
  })
  process.env.RECALL_API_KEY = 'test-key'
  globalThis.fetch = (async () => new Response('{"message":["Too long: Bob said the Acme deal is off"]}', { status: 400 })) as typeof fetch
  const refused = await sendChat('b1', 'Bob said the Acme deal is off').catch((err: unknown) => err)
  assert.ok(refused instanceof RecallError)
  assert.equal(refused.status, 400)
  assert.equal(refused.message, 'Recall could not post a chat message for bot b1 (400)')
  assert.equal(worthRetrying(refused), false)
})
