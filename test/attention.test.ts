// The attention rules (src/brain/attention.ts), line by line. A few sentences here come from the tests of AMP
// (https://github.com/tokencanopy/amp, test/attention.test.ts and test/asr.test.ts, Apache License 2.0), with the name
// changed (see NOTICE).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attention, endsOnQuestion, isFillerOnly, type Attention } from '../src/brain/attention.ts'

/** What speech recognition may give for a sentence: lower case, no punctuation but apostrophes. */
const spoken = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}'’\s]/gu, ' ').replace(/\s+/g, ' ').trim()

function heardAs(want: Attention, lines: string[], alsoSpoken: boolean): void {
  for (const line of lines) {
    assert.equal(attention(line), want, line)
    if (alsoSpoken) assert.equal(attention(spoken(line)), want, spoken(line))
  }
}

test('Alex answers when spoken to by name with a question or a request, punctuated or not', () => {
  heardAs('asked', [
    "Alex, what's the timeline?",
    'Hey Alex, can you explain the pricing?',
    'So what do you think, Alex?',
    'Alex, tell us about Acme.',
  ], true)
  assert.equal(spoken("Alex, what's the timeline?"), "alex what's the timeline")
  assert.equal(attention('alex whats the timeline'), 'asked')
})

test('Alex answers the other ways people ask it something', () => {
  heardAs('asked', [
    'Ok Alex, give us the short version.',
    'Alex. What does Acme do?',
    'Alex - how does it compare with Copilot?',
    'That covers billing. Alex, what did we decide about retries?',
    'Thanks Alex, and what about the timeline?',
    'Alex please summarise the decision',
    'Alex can you check that',
    'Alex, is the API ready?',
    'Alex, over to you.',
  ], false)
})

test('every way of addressing Alex that counted before still counts', () => {
  heardAs('asked', [
    'Alex, what is the timeline?',
    'so ALEX can you check',
    'Alec, what is Acme?',
    'Ionics, can you try to explain the Acme platform?',
    'Hey Ionics, what is the timeline?',
    'ok, Elix can you check',
  ], false)
})

test('a question after a lead-in such as "quick question", "sorry" or "in terms of pricing" is answered, punctuated or not', () => {
  heardAs('asked', [
    'Alex, quick question: what is the timeline?',
    'Alex, sorry, what was the timeline?',
    'Alex, actually, what is the timeline?',
    'Alex, just to clarify, does it ship in March?',
    'Alex, one more thing, what about security?',
    'Alex, in terms of pricing, what are the tiers?',
    'Alex, back to pricing, what are the tiers?',
    "Alex, sorry, I didn't catch that. Could you repeat it?",
    'Hey Alex, quick question, does it support SSO?',
    'Alex, never mind, what time is it?',
  ], true)
  assert.equal(attention('alex quick question what is the timeline'), 'asked')
  assert.equal(attention('alex sorry what was the timeline'), 'asked')
})

test('when the name opens a sentence that asks nothing, the question in the next sentence is answered', () => {
  // Announcements work unpunctuated too, as one sentence.
  heardAs('asked', [
    'Alex, quick question. How much is it?',
    'Alex, I have a question. What are the tiers?',
    "Alex, question. What's the timeline?",
    'Alex, one more thing. What about security?',
    'Alex, back to pricing. What are the tiers?',
  ], true)
  // These need the full stop: "alex sarah thinks march do you agree" is a known miss.
  heardAs('asked', [
    'Alex, Sarah thinks March. Do you agree?',
    "Alex, we're looking at the Q3 numbers. What was the churn rate?",
    'Alex, you mentioned SSO. Does it support Okta?',
  ], false)
})

test('the next sentence is not carried after a greeting, thanks or compliment, or when it is for someone else', () => {
  // Without the full stop these are different lines, so they are tested as written.
  heardAs('nothing_asked', [
    'Thanks Alex. Did everyone get the deck?',
    'Alex, nice to have you here. Did everyone get the agenda?',
    'Hi Alex. Sarah, can you share your screen?',
    'Thanks, Alex. Moving on.',
    'Hey Alex. Sarah, can you share your screen?',
    'Alex, you were right. Can we move on?',
    'Alex, stop. What were we saying?',
    "Alex, I'll send you the deck. Can we move on?",
  ], false)
  heardAs('mentioned', [
    'Alex just answered that. Can we move on?',
    'Alex and I talked about this yesterday. Can you send me the notes?',
  ], false)
})

test('the next sentence is not carried after Alex is put on hold, or when the floor goes to someone else', () => {
  heardAs('nothing_asked', [
    'Alex, let me stop you there. Go ahead, Sarah.',
    'Alex, hold on. Go ahead, Sarah.',
    "Alex, we'll come back to you. What do you think, Sarah?",
    "Alex, I'll get back to you on that. What's your view, John?",
    'Alex, no. What do you think, Sarah?',
    'Alex, Sarah said Friday. Is that right, Sarah?',
    'Alex, by the way, Sarah will join late. Can we start without her?',
    'Alex, meet Sarah. How are you, Sarah?',
    'Alex, just listen in for now. OK, so what is first on the agenda?',
    'Alex, hold on, go ahead, Sarah.',
  ], true)
  // Unpunctuated, "alex never mind what is next" is one sentence, like "alex never mind what time is it".
  heardAs('nothing_asked', ['Alex, never mind. What is next on the agenda?'], false)
  // Handing over needs someone to hand over to.
  heardAs('asked', ['Alex, go ahead.', 'Alex, go ahead, buddy.', 'Alex, over to you.'], true)
})

test('introducing Alex to the room is talking about it, not to it', () => {
  const introductions = [
    "Just so you know, Alex, Sam's assistant, is recording this, is that OK?",
    "Before we start, Alex, Sam's AI assistant, will be taking notes, is that OK?",
    "Alex, Sam's assistant, is here to take notes. Is that OK?",
    "Alex, Sam's AI assistant, will take notes today. Any objections?",
    'Alex, the AI, is listening. Shall we start?',
    'Alex, our note taker, is here. Is that OK?',
  ]
  heardAs('mentioned', introductions, false)
  // Without the commas nothing marks Alex as spoken to, so these stay quiet too.
  for (const line of introductions) assert.notEqual(attention(spoken(line)), 'asked', spoken(line))
  // A question or request after the words between the commas is still for Alex.
  heardAs('asked', [
    'Before we start, Alex, introduce yourself.',
    "Alex, Sam's notes, what do they say about pricing?",
    'Alex, the timeline, does it hold?',
    "Alex, Sam's assistant, can you hear us?",
    'Alex, the deadline, is Friday right?',
    // An announcement between the commas is not a description of Alex.
    'Alex, a quick question, is everything on track?',
    'Alex, the price, is 30 dollars right?',
  ], false)
  // A topic between the commas, then a question that runs to its question mark: asked, not an introduction.
  heardAs('asked', [
    'Alex, the contract, has legal signed it?',
    'Alex, the budget, has finance approved it?',
    'Alex, the API, is rate limiting on?',
    'Alex, a quick one, is pricing per seat?',
    'Alex, our pricing, is support included?',
    'Alex, the renewal, is procurement on board?',
    'Alex, the launch, will marketing be ready?',
    'Alex, the API, does okta support it?',
  ], false)
})

test('a line that only announces a question is a call, so the question can come in the next turn', () => {
  heardAs('called', [
    'Alex, I have a question about pricing.',
    'OK Alex, next question.',
    'Alex, quick question.',
    'Alex, one more thing.',
    "Alex, I've got a question.",
    'Alex, let me ask you something.',
    'Alex, sorry.',
    'Quick question, Alex.',
  ], true)
  // An apology after a greeting, or one that goes on, is not a call.
  heardAs('nothing_asked', ['Hi Alex, sorry.', 'Alex, sorry about that.', "Alex, sorry I'm late."], true)
})

test('announcing questions in other words is a call too', () => {
  heardAs('called', [
    'Alex, I have two questions.',
    'Alex, I have a couple of questions.',
    'Alex, I have a few questions.',
    "Alex, here's a question.",
    'Alex, I had a question.',
    'Alex, I wanted to ask about pricing.',
    'Alex, I want to ask you something.',
    "Alex, I've got two quick questions.",
    'Alex, my question is about pricing.',
    // A hello before it still opens the conversation with Alex.
    'Hi Alex, quick question.',
    'Good morning Alex, I have a question.',
  ], true)
  assert.equal(attention("alex my question is what's the timeline"), 'asked')
  // An announcement that goes on with a remark is not a call.
  heardAs('nothing_asked', ['Alex, I had a question earlier but Sarah answered it.'], true)
})

test('an announcement after thanks or praise is the host moving on, not a call', () => {
  heardAs('nothing_asked', [
    'Thanks Alex, next question.',
    'Great, thanks Alex, one more thing.',
    'Perfect, Alex, next question.',
    'Thanks Alex, we have another question.',
  ], true)
  // Unless the speaker says the question is their own.
  heardAs('called', ['Thanks Alex, I have another question.', 'Great answer, Alex, I wanted to ask about pricing.'], true)
  // Or announces it before the name: "one more question, Alex" is said to Alex.
  heardAs('called', ['Great, one more question, Alex.', 'Cool, one more thing, Alex.'], true)
})

test('praise followed by "one more question" is not "great one": the announcement and the question still count', () => {
  heardAs('asked', [
    'alex great one more question does it support sso',
    'alex perfect one more thing can you send the deck',
    'thanks alex great one more question how much is it',
    'alex excellent one more thing what about sso',
    'Alex, great, one more thing, tell us about SSO.',
  ], true)
  heardAs('nothing_asked', ['Alex, great one.', 'Alex, nice one.'], true)
})

test('thanks, compliments, goodbyes and "stop" are not answered, even when they start like a request', () => {
  heardAs('nothing_asked', [
    "Thanks Alex, you've been very helpful.",
    'Thanks Alex, take care.',
    'Thanks Alex, have a good one.',
    'Thanks Alex, talk soon.',
    'Alex, please stop.',
    'Alex, please be quiet.',
    "Alex, don't answer that.",
    'Alex, you can stop now.',
    'Alex, never mind.',
    'Never mind, Alex.',
    'Alex, stop.',
    'Alex, cancel that.',
    'Alex, forget it.',
    'Alex, what a great answer!',
    'Alex, great answer.',
    'Thanks Alex, your answer was good.',
    "Alex, you're on mute.",
    'Alex, please.',
  ], true)
})

test('praise is not answered, whatever word it uses', () => {
  heardAs('nothing_asked', [
    'Alex, excellent answer.',
    'Alex, brilliant answer.',
    'Alex, perfect answer.',
    'Thanks Alex, perfect answer.',
    'Excellent answer, Alex.',
    'Alex, good point.',
    'Alex, great summary.',
    'Alex, awesome explanation.',
  ], true)
})

test('asking Alex to wait is not answered, but a question after "wait" is', () => {
  heardAs('nothing_asked', [
    'Alex, please wait.',
    'Alex, please hold on.',
    'Alex, hold on.',
    'Alex, please let me finish.',
    'Alex, give me a second.',
    'Alex, one moment please.',
    'Alex, hang on.',
  ], true)
  heardAs('asked', [
    'Alex, can you wait until Sarah joins?',
    'Alex, wait, what did you say about pricing?',
    'Alex, hold on, what is the timeline?',
  ], true)
  heardAs('asked', ['Alex, give me a second, what was the number again?'], false)
  // Asked politely, waiting is still waiting, but a question about waiting is a question.
  heardAs('nothing_asked', ['Alex, can you hold on a second?', 'Alex, could you give me a second?', 'Alex, can you wait?'], true)
  // Being put off is final: what follows is for the room or the next speaker.
  heardAs('nothing_asked', ["Alex, we'll come back to you, what's next?", "Alex, I'll get back to you on that, any other questions?"], true)
})

test('calling off the last question and asking a new one in the same sentence is answered', () => {
  heardAs('asked', [
    "Alex, forget that, what's the launch date?",
    "Alex, scratch that, what's the launch date?",
    "Alex, ignore my last question, what's the launch date?",
    "Alex, disregard that, what's the launch date?",
    "Alex, no need to check with Sam, what's the launch date?",
    "Alex, enough about pricing, what's the timeline?",
    // "Don't" opening a question is not "don't answer that".
    "Alex, don't the docs say 30 days?",
  ], false)
  // Unpunctuated, only the forms that end clearly say where the new question starts.
  heardAs('asked', [
    "Alex, forget that, what's the launch date?",
    "Alex, scratch that, what's the launch date?",
    "Alex, ignore my last question, what's the launch date?",
    "Alex, enough about pricing, what's the timeline?",
    "Alex, forget about pricing, what's the timeline?",
    "Alex, never mind that, what's the timeline?",
  ], true)
  assert.equal(attention('alex please forget that whats the launch date'), 'asked')
  assert.equal(attention('alex forget about what we said'), 'nothing_asked')
  heardAs('nothing_asked', [
    "Alex, don't answer that.",
    'Alex, forget it.',
    "Alex, don't answer that, it's a trick question.",
    'Alex, stop, please.',
    'Alex, please stop, can everyone hear me?',
    "Alex, that's all the questions I had, what's next?",
  ], true)
})

test('after a stop, a tag or a remark ending in a question mark is not a new question', () => {
  heardAs('nothing_asked', [
    'Alex, stop, OK?',
    "Alex, that's enough, alright?",
    "Alex, stop, let's hear from Sarah, shall we?",
    'Alex, please stop, I think Bob had his hand up, right?',
    'Alex, stop, what do you think Sarah?',
    'Alex, stop, can you?',
    'Alex, stop, is that clear?',
  ], true)
  // A new question still is, after an "OK" or a second stop too.
  heardAs('asked', [
    'Alex, stop, OK, what was the price?',
    'Alex, stop, stop, what is the price?',
    'Alex, forget that, please send the deck.',
    'Alex, forget that, is it ready?',
  ], false)
})

test('questions and requests that start like those still count', () => {
  heardAs('asked', [
    'Alex please summarise the decision',
    'Alex, can you check that',
    'Alex, do you know the price?',
    'Alex, your thoughts?',
    'Alex, you there?',
    'Alex, will it ship in March?',
    'Thanks Alex, and what about the timeline?',
    'Thanks Alex, can you also check the budget?',
    "Alex, don't we need a budget?",
    'Alex, the numbers please',
    'Alex, you could check the numbers',
  ], true)
})

test('a request to someone else, or to the room after thanks, is not for Alex', () => {
  // Only the written form shows that "Sarah," is someone being spoken to.
  heardAs('nothing_asked', ['Hi Alex, Sarah, can you share your screen?', 'Alex. Sarah, what is the status?'], false)
  heardAs('nothing_asked', ['Thanks Alex, can everyone see my screen?', 'Thanks Alex, any questions?'], true)
  assert.equal(attention('thanks alex sarah can you share your screen'), 'nothing_asked')
})

test('a name in the middle of a sentence is spoken to only when commas set it off', () => {
  heardAs('mentioned', [
    'By the way, Alex is recording this, is that OK?',
    'Just so everyone knows, Alex is recording this.',
    "Before we start, Alex is Sam's assistant, can you all hear me?",
    'If you have questions, Alex can answer them.',
  ], true)
  // These need the commas around the name.
  heardAs('asked', [
    'Before we start, Alex, introduce yourself.',
    'So what do you think, Alex?',
    // "Both" takes in Alex, so Alex answers.
    'Sarah, Alex, can you both check the numbers?',
  ], false)
})

test('a greeting or an acknowledgement before the name still lets a question through', () => {
  heardAs('asked', [
    'Good morning Alex, can you give us a recap?',
    "Morning Alex, what's the plan?",
    'Great, thanks Alex, and what about the timeline?',
    "Perfect, Alex, what's next?",
    'Thank you so much Alex, and what about pricing?',
    'Hey there Alex, what does it cost?',
    'Sorry Alex, can you repeat that?',
  ], true)
  heardAs('nothing_asked', ['Morning Alex.', 'Good morning, Alex.', 'Thanks so much, Alex.', 'Good job, Alex.', 'Bye Alex.'], true)
  heardAs('mentioned', ['Great Alex said the demo went well', 'Perfect, Alex will send the notes.'], true)
})

test('after thanks, the host moving on to the room or to a colleague is not for Alex', () => {
  heardAs('nothing_asked', [
    "Cool, thanks Alex, who's next?",
    'Perfect, thanks Alex, who wants to go next?',
    "Thanks Alex, who's up next?",
    'Thanks Alex, what do people think?',
  ], true)
  assert.equal(attention('great thanks alex who is next'), 'nothing_asked')
  // A colleague's name at the end needs its comma.
  heardAs('nothing_asked', [
    'Great, thanks Alex, what do you think, Sarah?',
    'Cheers Alex, what do you think, Sarah?',
    'Yes Alex, and what about you, Sarah?',
  ], false)
  heardAs('asked', ['Thanks Alex, and what about the timeline?', 'Great, thanks Alex, and what about pricing?'], true)
})

test('after thanks, asking the room for a question or the next speaker, or calling on a colleague, is not for Alex', () => {
  heardAs('nothing_asked', [
    'Thanks Alex, who has a question?',
    'Thanks Alex, who would like to go next?',
    'Thanks Alex, who has the next question?',
    "Thanks Alex, who's got the next question?",
    'Thanks Alex, who else?',
    'Thanks Alex, can we start?',
    'Thanks Alex, should we wait for Sarah?',
  ], true)
  // A lone name after thanks is the next speaker being called on; it needs its capital.
  heardAs('nothing_asked', ['Thanks Alex, Sarah?', 'Great, thanks Alex, John?', 'Cheers Alex, John?'], false)
  // Without the thanks, a lone name or thing is something Alex is asked about.
  heardAs('asked', ['Alex, Okta?', 'Alex, Sarah?', 'Thanks Alex, Friday?'], false)
  heardAs('asked', ['Thanks Alex, who has the contract?', 'Thanks Alex, who would like this feature?'], true)
})

test('a question that only starts like one to the room is still for Alex', () => {
  heardAs('asked', [
    'Thanks Alex, can we start invoicing in March?',
    'Thanks Alex, should we wait for the 2.0 release before upgrading?',
    'Thanks Alex, who else uses this product?',
    'Good morning Alex, who is up for renewal this quarter?',
    'Hi Alex, can we proceed with the purchase order?',
    "Alex? Who's next on the agenda?",
    'Alex. Should we wait for the 2.0 release before upgrading?',
    'Alex, one more thing. Can we continue the pilot past March?',
  ], true)
})

test('a question followed by a bare call is for Alex; anything else followed by one is a call', () => {
  // These need the question mark: unpunctuated, "whats the timeline alex" is a known miss.
  heardAs('asked', ["What's the timeline? Alex?", 'What do you think, Sarah? And Alex?'], false)
  heardAs('called', ['Good question. Alex?', 'Maybe Alex knows. Alex?'], false)
  // The call has to be a question itself: "OK, Alex." after a question to the room only calls Alex.
  heardAs('called', [
    "What's the timeline? OK, Alex.",
    'Any other questions? No? OK, Alex.',
    'Is everyone clear on the next steps? Okay, Alex.',
  ], false)
})

test('without a comma, "did", "is" and the like after the name ask only when a pronoun follows', () => {
  heardAs('asked', [
    'alex did you see the email',
    'alex is it ready',
    'alex does it support linux',
    'alex are we on track',
    'alex was there a decision',
    'alex were we on track',
    'alex did it work',
  ], false)
  heardAs('mentioned', [
    'alex did the demo',
    'alex is great at this',
    'alex has the slides',
    'alex was here earlier',
    'alex did it again',
    'alex was there yesterday',
  ], false)
})

test('"Alex has it covered" and the like are remarks, even though "has it" can start a question', () => {
  heardAs('mentioned', [
    'Alex has it covered.',
    'Yeah, Alex does that automatically.',
    'Great, Alex has that handled.',
    'Cool, Alex has it covered.',
    'Alex actually has it covered.',
    'Alex did that already.',
    'Alex just did that.',
  ], true)
  heardAs('asked', [
    'alex does it support linux',
    'alex did it ship',
    'alex has it been deployed',
    'alex actually did you see the email',
  ], false)
})

test('"Alex did that last week" is a remark: "last" is a verb only at the end, as in "does it last?"', () => {
  heardAs('mentioned', [
    'Alex did that last week.',
    'Alex did it last time.',
    'Who updated the deck? Alex did that last night.',
  ], true)
  heardAs('asked', ['Alex, does it last?', 'Alex does it last?'], true)
})

test('talking about Alex is not talking to it', () => {
  heardAs('mentioned', ['I asked Alex yesterday.', 'Alex said the demo went well.'], true)
  heardAs('mentioned', [
    'We should ask Alex later.',
    'alex is great at this',
    "Let's loop Alex in after the call.",
    'Can you send this to Alex?',
    'Did you try Alex?',
    'Remind me to ping Alex.',
    'Alex will join later',
    "Alex's answer was good",
    'In terms of the work Alex did, it was great.',
  ], false)
})

test('thanking or welcoming Alex asks nothing, so Alex stays quiet', () => {
  heardAs('nothing_asked', ['Thanks, Alex.'], true)
  heardAs('nothing_asked', ['Alex, nice to have you here.', 'Welcome, Alex.', 'Thank you, Alex.', 'Hi Alex.'], false)
})

test('just the name is a call: Alex says nothing, but listens for what comes next', () => {
  heardAs('called', ['Alex?', 'Hey Alex.', 'alex', 'Um, Alex?', 'Alex? Alex?', 'Okay, Alex.'], false)
})

test('a line without the name is not for Alex, and neither is a colleague with a similar name', () => {
  heardAs('no_name', [
    'Alexis, can you share your screen?',
    'what is the timeline?',
    'we talked about ionics yesterday',
    'Alexander will join later',
    'Ionicsnotaword',
    'So Alexis, what do you think?',
    'Aleck, over to you',
  ], false)
})

test('some ways of addressing Alex are knowingly missed rather than answering remarks', () => {
  // The predicate guard: "alex is the ..." reads like "alex is the best". A pronoun after "is" would count.
  assert.equal(attention('alex is the api ready'), 'mentioned')
  assert.equal(attention('Alex, is the API ready?'), 'asked')
  // A yes/no question about a thing needs its question mark, comma or not.
  assert.equal(attention('Alex, is the API ready.'), 'nothing_asked')
  assert.equal(attention('alex do the docs cover sso'), 'nothing_asked')
  // A colleague's name at the end needs its comma to show the question is theirs.
  assert.equal(attention('cheers alex what do you think sarah'), 'asked')
  // After "Alex, wait." or "Alex, no." the next sentence is not carried.
  assert.equal(attention('Alex, wait. What did you say about pricing?'), 'nothing_asked')
  // A name at the end with no comma counts only after "think", "say" and the like.
  assert.equal(attention('whats the timeline alex'), 'mentioned')
  assert.equal(attention('what do you think alex'), 'asked')
  assert.equal(attention("What's the timeline, Alex?"), 'asked')
  // Carrying the address into the next sentence needs the full stop between them.
  assert.equal(attention('alex sarah thinks march do you agree'), 'nothing_asked')
  // After thanks, the next sentence is not carried, but the same words in one sentence are answered.
  assert.equal(attention('Thanks Alex. Can you also check the budget?'), 'nothing_asked')
  // A capitalised word set off by commas right after the name is taken as someone else's name.
  assert.equal(attention('Alex, Okta, does it support it?'), 'nothing_asked')
  // So is a lone capitalised word after thanks or a greeting: the host calling on the next speaker.
  assert.equal(attention('Thanks Alex, Okta?'), 'nothing_asked')
  // After a stop, a new question has to start like one: a question word, "is it", "can you", or a request.
  assert.equal(attention('Alex, forget that, the launch date?'), 'nothing_asked')
})

test("an answer that ends on a question hands the turn back; one that asks and carries on doesn't", () => {
  assert.equal(endsOnQuestion('Want me to check the retry path?'), true)
  assert.equal(endsOnQuestion('Is that what you meant?"  '), true)
  assert.equal(endsOnQuestion('Should we retry? We already do, three times.'), false)
  assert.equal(endsOnQuestion('It ships in March.'), false)
  assert.equal(endsOnQuestion(''), false)
})

test('"um" is someone thinking, but "mm-hmm" and "yeah" are answers', () => {
  for (const line of ['um', 'Uh...', 'Erm, hmm.', 'ah']) assert.equal(isFillerOnly(line), true, line)
  for (const line of ['mm-hmm', 'uh-huh', 'yeah', 'yes', 'no', 'ok', 'um, yes']) assert.equal(isFillerOnly(line), false, line)
})
