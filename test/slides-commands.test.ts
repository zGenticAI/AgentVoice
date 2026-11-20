// The slide commands the room may say by name, and the yes or no to the assistant's own questions: closed lists, the
// name first, the command the whole rest of its sentence. Every phrase of the design's table, and every negative.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attention } from '../src/brain/attention.ts'
import { isCancelRequest, isLeaveRequest } from '../src/brain/text.ts'
import { SLIDES_LINES } from '../src/consent.ts'
import type { AgentName } from '../src/identity.ts'
import { type SlideCommand, makeSlideCommands, slideCommand, windowReply } from '../src/slides/commands.ts'

const POSITIVES: [string, SlideCommand][] = [
  ['Alex, start the presentation.', { kind: 'start' }],
  ['Alex, begin the slides.', { kind: 'start' }],
  ['Alex, start the deck please.', { kind: 'start' }],
  ['Alex, go ahead with the slides.', { kind: 'start' }],
  ['Alex, present your slides.', { kind: 'start' }],
  ['Alex, share your slides.', { kind: 'start' }],
  ['Alex, can you start presenting?', { kind: 'start' }],
  ['Alex, next slide.', { kind: 'next' }],
  ['Alex, next slide please.', { kind: 'next' }],
  ['alex next slide', { kind: 'next' }],
  ['Alex, next one.', { kind: 'next' }],
  ['Alex, skip this slide.', { kind: 'next' }],
  ['Ok Alex, next slide.', { kind: 'next' }],
  ['Thanks, Alex. Next slide please.', { kind: 'next' }],
  ['Alex, go back.', { kind: 'back' }],
  ['Alex, go back a slide.', { kind: 'back' }],
  ['Alex, back a slide.', { kind: 'back' }],
  ['Alex, previous slide.', { kind: 'back' }],
  ['Alex, go to slide 5.', { kind: 'goto', slide: 5 }],
  ['Alex, can you go to slide five?', { kind: 'goto', slide: 5 }],
  ['Alex, back to slide 3.', { kind: 'goto', slide: 3 }],
  ['Alex, show us slide twelve again.', { kind: 'goto', slide: 12 }],
  ['Alex, jump to slide 100.', { kind: 'goto', slide: 100 }],
  ['Alex, skip to slide twenty.', { kind: 'goto', slide: 20 }],
  ['Alex, go to the first slide.', { kind: 'goto', slide: 1 }],
  ['Alex, show the last slide.', { kind: 'goto', slide: 'last' }],
  ['Alex, go through that slide again.', { kind: 'restart' }],
  ['Alex, start this slide again.', { kind: 'restart' }],
  ['Alex, pause.', { kind: 'pause' }],
  ['Alex, wait.', { kind: 'pause' }],
  ['Alex, hold on.', { kind: 'pause' }],
  ['Alex, hang on.', { kind: 'pause' }],
  ['Alex, one moment.', { kind: 'pause' }],
  ['Alex, give me a second.', { kind: 'pause' }],
  ['Alex, carry on.', { kind: 'resume' }],
  ['Alex, continue.', { kind: 'resume' }],
  ['Alex, please continue.', { kind: 'resume' }],
  ['Alex, go on.', { kind: 'resume' }],
  ['Alex, keep going.', { kind: 'resume' }],
  ['Alex, resume.', { kind: 'resume' }],
  ['Alex, go ahead.', { kind: 'resume' }],
  ['Alex, back to the slides.', { kind: 'resume' }],
  ['Alex, go back to where you were.', { kind: 'resume' }],
  ['Alex, stop presenting.', { kind: 'stop' }],
  ['Alex, stop sharing.', { kind: 'stop' }],
  ['Alex, stop sharing your screen.', { kind: 'stop' }],
  ['Alex, stop sharing the slides.', { kind: 'stop' }],
  ['Alex, stop the presentation.', { kind: 'stop' }],
  ["Alex, that's enough slides.", { kind: 'stop' }],
]

// Not commands: left to today's rules, and read exactly as before.
const NEGATIVES = [
  'Next slide.',
  'Next slide, Alex.',
  'Sarah, next slide please.',
  'Alex stopped at slide four.',
  'I asked Alex to go back.',
  'Alex, wait until Sarah joins.',
  'Alex, go back to the pricing and tell me the cost.',
  'Alex, next slide, and what does SSO cost?',
  'Alex, what is on this slide?',
  'Alex, can you continue the Acme contract?',
  'Alex, can you share your screen?',
  'Alex, go to slide 101.',
  'Alex, stop.',
  'Alex, never mind.',
  'Alex, please leave.',
  'Should Alex start the presentation?',
  "Don't let Alex go back.",
]

test('every phrase of the table is its command', () => {
  for (const [line, command] of POSITIVES) assert.deepEqual(slideCommand(line), command, line)
})

test('none of the negatives is a command: the name must come first, and the command must be the whole sentence', () => {
  for (const line of NEGATIVES) assert.equal(slideCommand(line), null, line)
})

test('"Alex, stop." stays a cancel and "please leave" a leave: the session checks those first, and neither is a command', () => {
  assert.equal(isCancelRequest('Alex, stop.'), true)
  assert.equal(slideCommand('Alex, stop.'), null)
  assert.equal(isLeaveRequest('Alex, please leave.'), true)
  assert.equal(slideCommand('Alex, please leave.'), null)
  // And the commands are neither: they never stop Alex as a cancel would, nor make it leave.
  for (const [line] of POSITIVES) {
    assert.equal(isLeaveRequest(line), false, line)
    assert.equal(isCancelRequest(line), false, line)
  }
})

test("today's readings of the commands are unchanged: the matcher is only an extra step in a meeting with slides", () => {
  // As the design found them: "next slide" is nothing asked, "go to slide 5" a question. The command step runs first.
  assert.equal(attention('Alex, next slide.'), 'nothing_asked')
  assert.equal(attention('Alex, go to slide 5.'), 'asked')
  assert.equal(attention('Alex, stop presenting.'), 'nothing_asked')
})

test('in a window the assistant opened, a command needs no name; outside one it does', () => {
  assert.deepEqual(slideCommand('Next slide.', { inWindow: true }), { kind: 'next' })
  assert.deepEqual(slideCommand('Go on.', { inWindow: true }), { kind: 'resume' })
  assert.deepEqual(slideCommand('Hold on.', { inWindow: true }), { kind: 'pause' })
  assert.deepEqual(slideCommand('Go to slide 4.', { inWindow: true }), { kind: 'goto', slide: 4 })
  assert.equal(slideCommand('Hold on.'), null)
  assert.equal(slideCommand('Sure.', { inWindow: true }), null)
  assert.equal(slideCommand('What does it cost?', { inWindow: true }), null)
})

test('the yes and no reader: a closed list, one or the other; anything else is answered as a line', () => {
  for (const yes of ['Yes.', 'Yeah.', 'Yep!', 'Sure.', 'Go ahead.', 'Please do.', 'Carry on.', 'Go on.', 'We can.', 'Looks good.', 'All good, thanks.', 'Yes, we can.', 'Yeah, looks good.', 'Alex, yes.', 'Okay.']) {
    assert.equal(windowReply(yes), 'yes', yes)
  }
  for (const no of ['No.', 'Nope.', 'Not yet.', 'Wait.', 'Hold on.', "We can't.", "I can't see it.", 'Nothing.', 'No, nothing.', "No, I can't see anything.", 'Um, no.']) {
    assert.equal(windowReply(no), 'no', no)
  }
  for (const neither of ['Yes, but wait.', 'What was the price again?', 'I think so, but the text is small.', '', 'Next slide.', 'No idea, ask Sam.']) {
    assert.equal(windowReply(neither), null, neither)
  }
})

test('"Can everyone see my slides?" is answered in sentences: read more loosely, and "hold on" there asks for a moment', () => {
  const table: [string, 'yes' | 'no' | 'wait' | null][] = [
    // Yes, as people say it.
    ['Yes.', 'yes'], ['Yes we can.', 'yes'], ['Yes, we can see them.', 'yes'], ['Yes, I can see it.', 'yes'], ['We can see it.', 'yes'],
    ['Yep, I can see them.', 'yes'], ['I can see it.', 'yes'], ['We see it.', 'yes'], ['Mm-hm.', 'yes'], ['Uh-huh.', 'yes'],
    ['Yes, looks great.', 'yes'], ['Looks good.', 'yes'], ['Oh nice, there it is.', 'yes'], ['Um, yes.', 'yes'], ['Perfect.', 'yes'],
    ["No, no, it's fine, we can see it.", 'yes'],
    // No, as people say it: what they can't see, or what they see instead.
    ['No.', 'no'], ['Nope.', 'no'], ['Not yet.', 'no'], ['Nothing.', 'no'], ["No, we can't see anything.", 'no'], ["I can't.", 'no'],
    ["I don't see anything.", 'no'], ["We don't see them.", 'no'], ["We can't see your slides.", 'no'], ["No, it's not showing.", 'no'],
    ['No, we just see your camera.', 'no'], ["It's just black.", 'no'], ['Only a black screen.', 'no'], ['Nobody can see it.', 'no'],
    ['I can see your camera but not the slides.', 'no'], ["Alex, we can't see it.", 'no'],
    // A moment: the slides may still be loading for them.
    ['Hold on.', 'wait'], ['Wait.', 'wait'], ['Hang on.', 'wait'], ['One moment.', 'wait'], ['Give it a second.', 'wait'], ["It's still loading.", 'wait'],
    // Neither: answered as any line in a window.
    ['Yes, but it\'s a bit small.', null], ["Yes, what's the agenda?", null], ["I don't know.", null], ['No problem.', null],
    ['No idea, ask Sam.', null], ['Thanks.', null], ['Next slide.', null], ['', null],
  ]
  for (const [line, reading] of table) assert.equal(windowReply(line, 'can_see'), reading, line)
  // "Shall I carry on?" keeps its closed list: "wait" and "hold on" are a no there, and "mm-hm" a yes.
  for (const [line, reading] of [['Wait.', 'no'], ['Hold on.', 'no'], ['Mm-hm.', 'yes'], ['Uh-huh.', 'yes'], ['Yes, we can see them.', null]] as const) {
    assert.equal(windowReply(line), reading, line)
  }
})

test("the phrases the slides lines teach work for any name, and a spelling counts as the name does for leaving: it doesn't", () => {
  const nova: AgentName = { name: 'Nova', variants: ['novah'], misheard: ['novel'], leaveMisheard: ['novel'] }
  const rules = makeSlideCommands(nova)
  assert.match(SLIDES_LINES.join, /"Alex, start the presentation"/)
  assert.deepEqual(rules.command('Nova, start the presentation.'), { kind: 'start' })
  assert.deepEqual(rules.command('Novel, next slide.'), { kind: 'next' }, 'a mishearing that counts for leaving counts here too')
  assert.equal(rules.command('Alex, next slide.'), null, 'not another name')
  assert.equal(rules.windowReply('Nova, yes.'), 'yes')
})
