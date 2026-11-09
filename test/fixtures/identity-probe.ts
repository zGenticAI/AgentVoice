// Run by test/identity-strings.test.ts in a process of its own, with another name, owner and profile in its environment:
// prints, as JSON, every string that process builds from them at start-up, and how its rules read a few lines.
import fs from 'node:fs'
import path from 'node:path'
import { Brain } from '../../src/brain/brain.ts'
import { attention } from '../../src/brain/attention.ts'
import { isCancelRequest, isLeaveRequest } from '../../src/brain/text.ts'
import { LEFT_NOTE } from '../../src/bridge.ts'
import { joinDescription, joinRule } from '../../src/channel/join-rule.ts'
import { ROOT, config } from '../../src/config.ts'
import { FIXED_LINES, joinChatMessage } from '../../src/consent.ts'
import { identity } from '../../src/identity.ts'
import { minutesRequest } from '../../src/minutes.ts'
import { fillPage } from '../../src/pages.ts'
import { botRequest } from '../../src/recall.ts'
import { lateAnswerText, sessionHandlers } from '../../src/sessions.ts'

// The spoken-answer request, caught by a fake client.
const requests: any[] = []
const client = {
  messages: {
    stream: (body: unknown) => {
      requests.push(body)
      return { on: () => undefined, finalMessage: async () => ({ content: [], stop_reason: 'end_turn' }) }
    },
  },
}
for await (const _ of new Brain(client as any).respond({ transcript: '', latest: '', brief: '', signal: new AbortController().signal })) {
  // nothing is said
}
const minutes = minutesRequest({
  transcript: '',
  transcriptFile: 'm.md',
  brief: '',
  questions: ['q'],
  startedAt: new Date(0),
  endedAt: new Date(0),
})
const n = identity.name

process.stdout.write(
  JSON.stringify({
    identity,
    fixedLines: FIXED_LINES,
    chatNotice: joinChatMessage(),
    brainSystem: requests[0].system[0].text,
    askToolName: requests[0].tools[0].name,
    askTool: requests[0].tools[0].description,
    minutesSystem: minutes.system,
    minutesUser: (minutes.messages[0] as { content: string }).content,
    botName: (botRequest({ meetingUrl: 'https://zoom.us/j/1', pageUrl: 'https://example.com/agent' }) as any).bot_name,
    keyterms: config.deepgramKeyterms,
    joinRule: joinRule([]),
    joinDescription: joinDescription([]),
    notes: [LEFT_NOTE, lateAnswerText('q', { spoken: 'a' }), sessionHandlers([]).transcript(undefined, 'm1')],
    // The default bot page as the server sends it (its script and styles left out: only what it shows).
    page: fillPage(fs.readFileSync(path.join(ROOT, 'public', 'agent.html'), 'utf8'), identity).replace(/<(script|style)\b[\s\S]*?<\/\1>/g, ''),
    reads: {
      leave: isLeaveRequest(`${n}, please leave.`),
      leaveByDefaultName: isLeaveRequest('Alex, please leave.'),
      asked: attention(`${n}, what is the timeline?`),
      askedBySpelling: attention(`${identity.variants[0]}, what is the timeline?`),
      cancel: isCancelRequest(`${n}, never mind.`),
    },
  }),
)
