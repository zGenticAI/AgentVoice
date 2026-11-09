import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attention } from '../src/brain/attention.ts'
import { isAddressed, isCancelRequest, isLeaveReply, isLeaveRequest, SentenceSplitter } from '../src/brain/text.ts'

test('Alex is addressed by name, case-insensitively', () => {
  assert.equal(isAddressed('Alex, what is the timeline?'), true)
  assert.equal(isAddressed('so ALEX can you check'), true)
  assert.equal(isAddressed('Alec, what is Acme?'), true)
  assert.equal(isAddressed('Alexander will join later'), false)
  assert.equal(isAddressed('what is the timeline?'), false)
})

test('a misheard name counts only as the first word', () => {
  // Heard in a live Teams meeting for "Alex, can you try to explain the Acme platform?"
  assert.equal(isAddressed('Ionics, can you try to explain the Acme platform?'), true)
  assert.equal(isAddressed('Hey Ionics, what is the timeline?'), true)
  assert.equal(isAddressed('ok, Elix can you check'), true)
  assert.equal(isAddressed('we talked about ionics yesterday'), false)
  assert.equal(isAddressed('Ionicsnotaword'), false)
})

test("a colleague's name is not Alex's", () => {
  for (const said of ['Alexis, can you share your screen?', 'So Alexis, what do you think?', 'Alix, you are on mute.', 'Ok Alexis, next slide please', 'Alek, can you check?', 'Aleck, over to you']) {
    assert.equal(isAddressed(said), false, said)
  }
})

test('leave requests need the exact name and a leave word', () => {
  assert.equal(isLeaveRequest('Ionics, please leave'), true)
  assert.equal(isLeaveRequest('tell Ionics to leave the meeting'), false)
  assert.equal(isLeaveRequest('Alex, please leave'), true)
  assert.equal(isLeaveRequest('Alex please leave.'), true)
  assert.equal(isLeaveRequest('Alex can you drop off now'), true)
  assert.equal(isLeaveRequest('Alex, could you leave the meeting now?'), true)
  assert.equal(isLeaveRequest('Alex, leave the call please.'), true)
  assert.equal(isLeaveRequest('Alex, I think you should leave the meeting.'), true)
  assert.equal(isLeaveRequest('Alex, what do we leave out?'), false)
  assert.equal(isLeaveRequest('please leave the door open'), false)
})

test("leaving deletes the record, so a colleague's name or a task never counts as a leave request", () => {
  for (const said of [
    'Alec, could you drop off the deck later?',
    'Alec, please hang up and dial back in.',
    'Alec, please leave the meeting',
    'Alexis, leave that slide up for now',
    'Alexis, could you drop off the slides later?',
    'Alexis, can you leave the meeting notes in the chat?',
    'Alix, please leave it',
    'Alek, hang up the poster',
    'Alexa, hang up',
    'Alex, please leave a note in the chat',
    'Alex, could you drop off the deck later?',
    'Alex, can you leave the meeting notes in the chat?',
    'Alex, hang up the poster',
  ]) {
    assert.equal(isLeaveRequest(said), false, said)
  }
})

test('a question mark, an exclamation mark, a colon or a dash after the name still makes a leave request', () => {
  for (const said of [
    'Alex? Please leave.',
    'Alex! Please leave the meeting.',
    'Alex: leave the call, please.',
    'Alex; please leave now.',
    'Alex - please leave.',
    'Alex – could you leave the meeting?',
    'Alex — please leave.',
    'Alex—please leave',
    'Ionics? Please leave.',
  ]) {
    assert.equal(isLeaveRequest(said), true, said)
  }
})

test('with that punctuation the request must still end the sentence', () => {
  for (const said of [
    'Alex? Please leave a note in the chat.',
    'Alex — please leave the slides up.',
    'Alex! Leave that for Sam.',
    'Alex: what do we leave out?',
    'Alex? Could you drop off the deck later?',
    'Alexa? Hang up.',
    'Alexis — please leave.',
  ]) {
    assert.equal(isLeaveRequest(said), false, said)
  }
})

test('talking about Alex leaving is never a leave request: that would delete the meeting record', () => {
  for (const said of [
    "I don't want Alex to leave the call.",
    "Don't let Alex leave.",
    "We can't make Alex go away.",
    'When does Alex drop off?',
    'Should we ask Alex to leave the meeting?',
    'I told Alex hang up.',
    'Maybe Alex should leave the meeting.',
    'Alex, do you think Bob should leave the meeting?',
    'Alex, you said we should leave the call.',
    'Alex, you can leave the deck in the chat.',
    'Alex will leave soon.',
    'Alex should leave the meeting.',
    "Alex's leaving the call now.",
  ]) {
    assert.equal(isLeaveRequest(said), false, said)
  }
})

test('"you should leave" counts only as a plain statement: not denied, asked, reported or in an if/before clause', () => {
  for (const said of [
    "Alex, I don't think you should leave.",
    "Alex, I don't think you should leave the meeting.",
    'Alex, before you have to leave, can you recap the action items?',
    'Alex, do you have to leave?',
    'Alex, do you have to leave the call?',
    'Alex, do you need to leave?',
    'Alex, do you think you should leave?',
    'Alex, I never said you should leave.',
    'Alex, Bob said you should leave, but please stay.',
    "Alex, if you need to leave, that's fine.",
    'Alex, when you have to leave, let us know.',
    'Alex, would you leave the meeting if I asked?',
    // The request is said to someone else when it ends on their name, whatever came before it.
    'One second Alex. Please leave the meeting, Bob.',
    'Thanks Alex. Could you leave the call now, Bob?',
    'Good idea Alex. Please leave the call, Bob, we need to talk about salaries.',
    'Alex. Please leave the meeting, Bob.',
    'Alex, please leave, Bob.',
    'Alex, time to go through the agenda.',
    'Alex, you can go ahead.',
  ]) {
    assert.equal(isLeaveRequest(said), false, said)
  }
})

test('asking Alex to leave counts however politely it is put, and whatever comes before the name', () => {
  for (const said of [
    'Thanks, Alex. Please leave.',
    'Thank you Alex, please leave now.',
    'OK Alex, you can leave now.',
    'Okay thanks Alex, you can go now.',
    "Alex, I'd like you to leave the meeting.",
    'That covers it. Alex, please leave.',
    'Hey Alex, hang up please.',
    'Alex, could you please leave the meeting?',
    'Alex, can you please leave the call?',
    'Alex, would you leave the meeting?',
    'Alex, will you leave the meeting?',
    'Alex, just leave the meeting.',
    'Alex, kindly leave the meeting.',
    'Alex, go ahead and leave the meeting.',
    'Alex, time to leave the meeting.',
    "Alex, it's time to go.",
    'Alex, actually, please leave the meeting.',
    'Alex, sorry, but please leave the meeting.',
    'alex can you please leave the meeting',
    'Alex you can leave',
    'Bye Alex, please leave.',
    'No, Alex, please leave.',
    'Um, Alex, please leave.',
    'Uh, Alex, could you leave the meeting?',
    'Yes Alex, please leave.',
    'Great, thanks Alex, please leave now.',
    'Thanks a lot Alex, please leave the meeting.',
    'Good morning Alex, please leave the meeting.',
    'Excuse me, Alex, please leave.',
    'Please, Alex, leave the meeting.',
    'Okay everyone, Alex, please leave the meeting.',
    'Before we go on, Alex, please leave the meeting.',
    "I'm not comfortable with this, Alex, please leave.",
    'Alex, please leave, thanks.',
    'Alex, could you leave the meeting now, please?',
  ]) {
    assert.equal(isLeaveRequest(said), true, said)
  }
})

test('in an open window, only a plain request to leave counts without the name', () => {
  for (const said of [
    'Please leave.',
    'Please leave the meeting.',
    'Could you leave the call please?',
    'No, please leave.',
    'Leave the meeting.',
  ]) {
    assert.equal(isLeaveReply(said), true, said)
  }
  // The window takes whoever speaks next, and that may be said to a colleague: without the name, only an
  // explicit request (with "please", or naming the meeting or call) deletes the record.
  for (const said of [
    'Sorry, I have to leave the call now.',
    'Bob had to leave the meeting.',
    'Please leave the door open.',
    'Please leave a note in the chat.',
    'We can leave that for later.',
    'Leave it.',
    'Can you leave now?',
    'Hang up.',
    'OK, hang up.',
    'Go away.',
  ]) {
    assert.equal(isLeaveReply(said), false, said)
  }
})

test('telling Alex never mind, or to stop, is a cancel request', () => {
  for (const said of [
    'Alex, never mind.',
    'alex nevermind',
    'Alex, stop.',
    'Alex stop',
    'Alex, stop talking.',
    "Alex, that's enough.",
    'Alex, thats enough, thanks.',
    'Alex, cancel that.',
    'Alex, cancel it.',
    'Alex, forget it.',
    'Alex, forget about it.',
    'Alex, skip that.',
    'Alex, no need.',
    "Alex, don't bother.",
    'Alex, don’t answer that.',
    'Alex, please stop.',
    'Alex, stop, please.',
    'Alex, be quiet.',
    'Alex? Never mind.',
    'Alex — stop.',
    'Never mind, Alex.',
    'Stop, Alex!',
    'Okay, never mind Alex.',
    'Actually Alex, never mind, we\'ll ask Sam later.',
    'Alex, no, never mind.',
    'Alex, never mind. We will ask Sam.',
    'Never mind, Alex. What is next on the agenda?',
    'Ionics, never mind.',
    'Hey Alec, stop.',
    "Alex, don't worry about it.",
    'Alex, no worries.',
    "Alex, it's fine.",
    "Alex, that's fine, thanks.",
    'Alex, all good.',
    'Alex, leave it.',
    'Alex, scratch that.',
    'Scratch that, Alex.',
    'Alex, you can stop.',
    'Alex, hold on, never mind.',
    "Alex, that's all.",
    'Alex, ignore that.',
    'Alex, disregard that.',
    'Alex, nah, never mind.',
    'Alex, not now.',
    'Alex, no thanks.',
    'Alex, that will do.',
  ]) {
    assert.equal(isCancelRequest(said), true, said)
  }
  // "Leave it" drops what Alex was doing; it is not a leave request, which would delete the record.
  assert.equal(isLeaveRequest('Alex, leave it.'), false)
  assert.equal(isCancelRequest('Alex, is it fine to share this?'), false)
})

test('a request that only contains a cancel word is not a cancel request', () => {
  for (const said of [
    'Alex, can you stop the recording?',
    'Alex, how do I cancel my subscription?',
    'Alex, skip to the pricing',
    "Alex, don't stop",
    "Alex, what does 'never mind' mean?",
    'Alex, stop the recording.',
    'Alex, cancel my two o\'clock.',
    'Alex, forget the deck, what is the timeline?',
    'Alex, never mind, what time is it?',
    'Never mind, Alex, what is the timeline?',
    'Alex, stop. Alex, what is the timeline?',
    'Alex, never mind that the deck is late, what is the plan?',
    'Stop, Alex is right.',
    'Never mind, Alex said it already.',
    'never mind',
    'We should stop here.',
    'Alexis, stop.',
    'we talked about ionics, never mind',
    "Alex, scratch that, what's the launch date?",
    'Alex, scratch that line from the deck.',
    'Alex, you can stop the recording.',
    "Alex, that's all the questions I had, what's next?",
    'Alex, ignore that noise.',
  ]) {
    assert.equal(isCancelRequest(said), false, said)
  }
})

test('sentence splitter emits whole sentences as text streams in', () => {
  const s = new SentenceSplitter()
  assert.deepEqual(s.push('Hello there'), [])
  assert.deepEqual(s.push('. How are'), ['Hello there.'])
  assert.deepEqual(s.push(' you? I am fine'), ['How are you?'])
  assert.deepEqual(s.flush(), ['I am fine'])
  assert.deepEqual(s.flush(), [])
})

test('sentence splitter keeps decimals together', () => {
  const s = new SentenceSplitter()
  assert.deepEqual(s.push('It costs 1.65 dollars an hour. Next'), ['It costs 1.65 dollars an hour.'])
})

test('a stop followed by a question is either a cancel or a new question for Alex, never neither', () => {
  // Neither would let a question still being checked with Sam's session be answered after the meeting called it off.
  for (const said of [
    'Alex, stop, OK?',
    "Alex, that's enough, alright?",
    'Alex, stop, what do you think Sarah?',
    "Alex, stop, let's hear from Sarah, shall we?",
    'Alex, forget that, the launch date?',
    "Alex, forget that, what's the launch date?",
    "Alex, scratch that, what's the launch date?",
    'Alex, never mind, what time is it?',
    'Alex, stop, OK, what was the price?',
    'Never mind, Alex, what is the timeline?',
  ]) {
    const asked = attention(said) === 'asked'
    assert.notEqual(isCancelRequest(said), asked, said)
  }
})
