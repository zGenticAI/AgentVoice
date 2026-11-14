# agent-voice

A self-hosted AI meeting assistant. It joins your Zoom, Google Meet and Microsoft Teams meetings as a voice participant, says that it is an AI, and answers questions people ask it by name. It answers quick questions itself, from a brief you prepare for the meeting. It hands deeper ones to your own Claude Code session, which can look through your notes and documents, and then speaks the answer. After the meeting, it writes the minutes.

It runs on your own computer, with your own accounts at the services it uses. Nothing is hosted for you.

This is an early release (0.1): expect rough edges, and read [Responsible use](#responsible-use-consent-and-the-law) before you send it into a meeting.

## How it works

```
Zoom, Meet or Teams meeting
   ⇅ Recall.ai bot: joins as a participant, and shows the bot page as its camera
bot page ⇄ your tunnel (public HTTPS) ⇄ voice service (this repository, on your computer)
                                           ├─ Deepgram Flux     speech to text, end of turn
                                           ├─ Claude            fast spoken answers, from the brief
                                           ├─ ElevenLabs Flash  the assistant's voice
                                           ├─ Claude            the minutes, after the meeting
                                           └─ zoom-meeting channel ⇄ your Claude Code session
```

The assistant is called Alex unless you choose another name, and introduces itself as your assistant. This README says Alex, and Sam for you, its owner.

- **Joining.** You send Alex into a meeting with `npm run join -- <link>`, or by asking your Claude Code session. A Recall.ai bot joins as a guest called "Alex (Sam's AI assistant)". Its camera is a web page served by your computer, which streams the meeting's audio to the voice service and plays Alex's voice.
- **Telling the meeting.** As it joins, Alex says that it is an AI assistant, that it is transcribing, that it can't agree to anything for you, and how to make it leave. It also posts a notice in the meeting chat: that it is an AI assistant transcribing the meeting, that it sends you a summary, that it keeps no recording of the meeting, how long it keeps its transcripts, and how to make it leave.
- **Answering.** Alex answers when a line is said to it by name and asks something ("Alex, what's the timeline?"), and, right after it has asked something or someone has said just "Alex?", the next thing said. It doesn't answer talk about it ("I asked Alex yesterday"), thanks or side conversation.
- **Two tiers.** The fast tier is Claude with the brief and the recent transcript, and answers in a second or two. When a question needs more (current work, documents, decisions), Alex says it is checking and hands the question to your Claude Code session through an MCP channel. The session (through its meeting-assistant agent, when the session sent Alex in) looks in the sources you allow and replies, and Alex speaks the answer.
- **Leaving.** "Alex, please leave" makes it leave at once and delete its own transcript and minutes of that meeting (in `data/`), and so does removing it from the participant list. Copies already handed to your Claude Code session stay there (see [Where meeting data goes](#where-meeting-data-goes)). "Alex, never mind" only stops it talking.
- **Minutes.** When the meeting ends, Claude writes minutes from the transcript (a summary, decisions, action items and open questions), and your session sends them to you.

`AGENT_MODEL` in `.env` chooses the Claude model for the spoken answers (Sonnet 5.5 unless set), and `MINUTES_MODEL` the one for the minutes (the same unless set).

## What you need

- **A Mac or a Linux computer** with Node.js 24 or later, which stays on during your meetings.
- **Accounts and API keys** at Anthropic (the Claude API), Deepgram (speech to text), ElevenLabs (the voice: any stock voice) and Recall.ai (the meeting bot).
- **A public HTTPS hostname that tunnels to your computer,** for example with Cloudflare Tunnel. The meeting bot loads its page from it.
- **For the deep tier, Claude Code,** signed in with a claude.ai account or a Claude Console API key. The link to your session is a Claude Code channel, which is a research preview: it needs a development flag, and isn't available when Claude Code runs on Amazon Bedrock, Google Cloud or Microsoft Foundry. On claude.ai Team and Enterprise plans, an Owner must first enable channels for the organisation. See [Claude Code's channels documentation](https://code.claude.com/docs/en/channels). Without the deep tier, Alex answers from the brief alone.
- **Meetings in English.** Speech recognition and the rules for who is being spoken to are English only.
- Optionally, the Claude Code Telegram plugin, with its channel loaded in the same session, to send Alex into a meeting from your phone.

## Costs

You pay each service directly, on your own account. What uses it:

| Service | Billed for | What uses it |
| --- | --- | --- |
| Recall.ai | bot time | the time the bot spends in each meeting |
| Deepgram | streamed audio | all of the meeting's audio while Alex is in it |
| Anthropic (Claude API) | tokens | each answer (the rules, the brief and up to about 12,000 characters of transcript, with the rules and brief cached), and one call per meeting for the minutes |
| ElevenLabs | characters spoken | Alex's answers. Its fixed lines (the consent line, "let me check" and so on) are made once per voice and kept. |
| Claude Code | your plan's usage, or API tokens with a Console key | writing the brief; for a meeting started with `npm run join`, answering its questions (every session with the channel loaded gets them until one replies); when the session sends Alex in, the meeting-assistant agent, which runs for the whole meeting (it waits for questions, answers them, and reads the transcript and your sources when it is quiet); and, after the meeting, reading the transcript and the minutes |

See each provider's pricing page for the current rates. `MAX_MEETINGS` (3 at once unless set) and `MAX_MEETING_MINUTES` (180 unless set) limit what a stray bot can cost, and the bot leaves by itself when nobody else joins within 5 minutes, when everyone else has left, or after 15 minutes of silence. Set a spending limit at each provider as well (see [Limits on cost](docs/security.md#limits-on-cost)).

## Quick start

Clone the repository and set it up:

```bash
git clone https://github.com/zGenticAI/AgentVoice.git
cd AgentVoice
npm install
install -m 600 .env.example .env
cp profile.example.md profile.md
```

1. **In `.env`, set:**
   - `OWNER_NAME`: your name, as Alex says it.
   - The keys: `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY` with `ELEVENLABS_VOICE_ID`, and `RECALL_API_KEY` with `RECALL_REGION`, your Recall account's region.
   - `AGENT_PAGE_TOKEN`: the output of `openssl rand -hex 24`.
   - `PUBLIC_URL`: your tunnel's address, such as `https://assistant.example.com`. Point the tunnel at `http://127.0.0.1:8787`.
2. **Edit `profile.md`:** a sentence or two about you, which questions go to your session, where it may look, and what must never be shared.
3. **Run `npm run check`.** It checks your settings, prints what Alex will say, and tries the Anthropic, Deepgram and ElevenLabs keys. The Recall key is first used when Alex joins a meeting.
4. **Start the service** with `npm start`, or with `scripts/install-service.sh` to keep it running as a launchd or systemd service. Then, from outside your network (a phone with Wi-Fi off, say), open your `PUBLIC_URL` followed by `/health`: it has to show `{"ok":true}`, or the meeting bot can't reach its page. A test from your own network can pass when the bot can't.
5. **Write the brief** for the meeting: what Alex may say, and what it must not. Copy the example with `install -m 600 brief.example.md data/brief.md`, so that only you can read it, and fill it in, or have your Claude Code session write it (see below).
6. **Send Alex into a meeting.** If the meeting has a waiting room, admit it from there.
   ```bash
   npm run join -- "https://us06web.zoom.us/j/123456789?pwd=..."
   ```

[Setting it up](docs/setup.md) has every step in full, with a tunnel example.

## In a meeting

| Say | What happens |
| --- | --- |
| "Alex, what's the timeline?" | It answers, from the brief or after checking with your session. |
| "Alex, never mind" or "Alex, stop" | It stops talking, and drops the question. |
| Talking over it while it answers | It stops at once. The transcript keeps only the words the meeting heard, ending in "(cut off)". |
| "Alex, please leave" | It says goodbye and leaves. It deletes its transcript of the meeting (in `data/`), and writes no minutes. |
| Removing it from the participant list | The same as "Alex, please leave", once Recall confirms the removal. |

When Alex isn't sure a line was said to it, it stays quiet: say its name again. [In a meeting](docs/in-a-meeting.md) has the exact rules, and what to check when it doesn't answer.

## Linking your Claude Code session

1. Register the channel once with `scripts/install-channel.sh`. It is registered for this folder only, so start Claude Code here.
2. Before a meeting, start Claude Code in this folder with the channel loaded, or resume a session with it (add `--resume`):
   ```bash
   claude --dangerously-load-development-channels server:zoom-meeting
   ```
3. Ask the session to "prepare Alex for my meeting with ...". It writes the brief.
4. Allow the meeting-assistant agent's tools, and the folders it may read, in `.claude/settings.local.json` (see [The meeting assistant](docs/claude-code.md#the-meeting-assistant)).

During the meeting, the questions that the brief can't answer reach the session, and Alex speaks the reply. When the session sent Alex in ("Alex, join this meeting: <link>"), its meeting-assistant agent answers them in the background; for a meeting started with `npm run join`, they arrive in the session itself. Afterwards, the session sends you the minutes. [Your Claude Code session](docs/claude-code.md) has the details, the permissions and the safety rules.

## Make it yours

- **You and your company:** `OWNER_NAME`, `OWNER_FULL_NAME` and `COMPANY_NAME` in `.env`. No person or company is written into the code.
- **Your profile:** `profile.md`. It holds standing context about you, which questions go to your session, your knowledge sources, and what must never be shared or opened.
- **The assistant's name:** `AGENT_NAME`, Alex unless set. Not every name works: [Choosing the assistant's name](docs/choosing-a-name.md) says which do, and `npm run check-name` tries one on about 1,900 sample meeting lines.
- **The bot page:** the assistant's camera in the meeting. It is a plain page by default, and `AGENT_PAGE_FILE` serves one of your own.

The consent wording isn't a setting. Whatever its name, the assistant says that it is an AI, that it is transcribing, that it can't agree to anything for you and how to make it leave, and posts a chat notice that it is an AI assistant transcribing the meeting, with how to make it leave. Its participant-list name and its page show "AI". See [Make it yours](docs/make-it-yours.md).

## Responsible use, consent and the law

This is not legal advice. You run the assistant, so it is up to you to use it lawfully, wherever you and the people you meet are.

- **Recording.** Alex transcribes everything said while it is in a meeting, through outside services, live. Some places require the consent of everyone in a conversation to record or listen in on it (California and several other US states, and some countries); others require one party's. In the US, lawsuits have argued that AI notetakers which transcribe a call live are listening in on it. If you aren't in the meeting yourself, your own consent may not count at all.
- **Telling people.** The consent line and the chat notice are notices: on their own, they may not count as consent. They reach the people in the meeting when Alex joins. People who join later don't hear the consent line, and people who dial in by phone don't see the chat. The notice speaks for Alex's own copies: unless your ElevenLabs account has zero retention and you set `ELEVENLABS_ZERO_RETENTION=true`, ElevenLabs keeps what Alex says (see the table below). Tell people before the meeting, in the invitation, and give them a way to say no.
- **Data protection.** Where the GDPR or the UK GDPR applies, you (or your company) are usually the controller of what Alex records.
  - Recall.ai, Deepgram, ElevenLabs, the Anthropic API and your tunnel provider can process it for you as your processors, but only where a data processing agreement covers your account. Check that you have one with each: some include it in their terms, others you sign or ask for.
  - Your Claude Code session is another matter. On an individual claude.ai plan (Pro, Max or Ultra), Anthropic's consumer terms apply to it, and Anthropic isn't your processor for what it reads: use a Team, Enterprise or Console account where this matters.
  - Telegram, if you use it, is not your processor at all: don't send minutes there where the GDPR applies.
  - You need a lawful basis, and you must give people a privacy notice, before the meeting (in the invitation, say): who you are, why you record, which services get what and where they are, how long it is kept, and their rights. [Where meeting data goes](#where-meeting-data-goes) lists the services.
  - Most of these services are in the US, so check each one's transfer basis (such as the EU-US Data Privacy Framework, or standard contractual clauses). Recall offers an EU region (`RECALL_REGION=eu-central-1`).
  - Recording meetings as a matter of course, of staff especially, is likely to need a data protection impact assessment, and in some countries the agreement of a works council.
- **AI disclosure.** People must know when they are talking to an AI. Under the EU AI Act's transparency rules (Article 50), from 2 August 2026, AI systems that talk with people must be designed to tell them so, unless it is obvious, and it requires AI-generated audio to be marked as such: the voice provider's own marking may not cover you, so check whether that rule applies to you too. It is honest everywhere. That is why the disclosure is always there: in the consent line, the chat notice, the participant-list name and the bot page.
- **Leaving.** Anyone can make Alex leave with "Alex, please leave", which also deletes its own transcript and minutes (in `data/`). What was already passed to your Claude Code session or to the services stays there. Don't work around it.
- **When not to use it.** Don't send it into privileged meetings, such as legal advice: passing them to outside services can waive privilege, even when everyone agrees. Don't send it into meetings where recording isn't allowed, or that are confidential (medical matters, HR, board meetings), unless everyone has agreed and you have checked that their agreement is enough: an employee's agreement often isn't, and health data needs explicit consent or another legal basis. Meetings that other organisations host may have their own rules, and some block bots and guests.
- **Not a person.** Use a stock voice. Never clone a real person's voice without their consent. Alex can't agree to anything for you, and says so. Its answers come from Claude, and can be wrong.

## Where meeting data goes

| Where | What reaches it | How long it stays |
| --- | --- | --- |
| Recall.ai | Everything the bot gets in the meeting, live: its audio and video (shared screens included), the participant list and the chat. Every chat message Alex posts. The bot's record: its meeting link, name and status, and the bot page's address, which holds the page token and the meeting's key. | No recording is stored: the bots use zero data retention, and when a bot's session ends, the service also asks Recall to delete its media. The bot's record stays in your Recall account. |
| Deepgram | The meeting's audio, live, for speech to text, and with it the words to listen out for: Alex's name, your name, your company, and `DEEPGRAM_KEYTERMS`. | The stream opts out of Deepgram's model improvement programme. Otherwise, Deepgram's terms. |
| Anthropic (Claude API) | For each answer: the rules (with your profile's About), the brief, what your session added, and up to about 12,000 characters of the transcript. The rules also hold your full name, your company and the topics your profile hands to your session. After the meeting, for the minutes: the whole transcript, the questions put to Alex, the meeting's date, times and platform, and the brief. | Anthropic's commercial terms for the API. |
| ElevenLabs | What Alex says. | Kept in your ElevenLabs history, unless your account has zero retention (enterprise accounts) and you set `ELEVENLABS_ZERO_RETENTION=true`. |
| Your tunnel provider | The bot page and the meeting's audio, both ways, in transit. | The provider's terms. Cloudflare Tunnel, for example, decrypts HTTPS at Cloudflare's edge. |
| Your Claude Code session | The meeting links you give it, and the start and end of each meeting. Each question handed to it, with up to about 60,000 characters of the transcript. The parts of the transcript it asks for, and what it reads in your knowledge sources. After the meeting, the whole transcript, the questions put to Alex and the minutes, which the session and its agent are told to read. When no session has claimed the questions (a meeting started with `npm run join`, say), every session with the channel loaded gets them, and the end-of-meeting event too, so each of those sessions is told to read the transcript and the minutes. | Claude Code keeps its session history on your computer, and sends the conversation to Anthropic under your Claude account's terms. These copies are outside `data/`: neither `TRANSCRIPT_RETENTION_DAYS` nor "please leave" deletes them. On an individual claude.ai plan (Pro, Max or Ultra), check your privacy settings on model training. |
| Telegram (optional) | Requests to join a meeting, and anything your session sends you there, such as the minutes. | Telegram's terms. Bot chats are not end-to-end encrypted. |
| The meeting's chat | The chat notice, the longer detail of your session's answers, anything your session posts with `post_chat`, and the notice Alex posts when it reaches `MAX_MEETING_MINUTES`. | The meeting platform keeps it like any chat message. |
| Your computer (`data/`) | Transcripts, minutes, the brief, the audio of Alex's fixed lines, and the service's log. The log never holds what was said or a meeting's link: it holds each bot's id, the meeting's platform and how the meeting ended. | Readable only by you. Transcripts and minutes are deleted after `TRANSCRIPT_RETENTION_DAYS` (30 unless set), or at once when someone asks Alex to leave, or removes it and Recall confirms the removal (see [Minutes and meeting data](docs/minutes-and-data.md#minutes)). The brief stays until it is replaced, and the log until you delete it. |

[Minutes and meeting data](docs/minutes-and-data.md) has the details.

## Security

- The public port serves only the bot page, its scripts and its audio stream. The audio stream needs the page token and the key of a meeting that is still on.
- Everything else (joining meetings, and the link to your Claude Code session) is on a Unix socket that only your user can open, and needs a local token as well.
- The committed `.claude/settings.json` denies Claude Code sessions in this folder reading `.env` files, keys and credential folders with its file tools and the shell commands it recognises. Deny rules aren't a sandbox: keep secrets out of the folders your session works in.
- Meeting text is untrusted. The assistant, your session and its agent are told to answer it, and never to act on it.

See [Ports and security](docs/security.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Limitations

- Meetings in English only, and macOS and Linux only.
- One owner per install, and one Claude Code session takes the questions.
- One brief at a time: every meeting Alex is in uses `data/brief.md`, until it is replaced.
- Alex hears the meeting but doesn't see it: it can't see shared screens or video, and doesn't read the meeting chat.
- Everyone but Alex is "Speaker" in the transcript and the minutes, so it doesn't know who said what.
- It misses some lines on purpose, rather than answer remarks that weren't for it. It also can't tell a colleague with the same name from itself.
- Deep answers take time, and need your Claude Code session open. Alex waits about a minute for one.
- Claude Code channels are a research preview, so the flag and the protocol may change.
- Meetings that don't admit guests or bots won't let it in.
- Its answers come from Claude, and can be wrong.

## Documentation

- [Setting it up](docs/setup.md): every step, a tunnel example, and keeping the service running.
- [In a meeting](docs/in-a-meeting.md): joining, the consent line, leaving and stopping, and the rules for when Alex answers.
- [Your Claude Code session](docs/claude-code.md): the channel, the meeting-assistant agent, permissions and safety.
- [Make it yours](docs/make-it-yours.md): the owner and company settings, the profile and the bot page.
- [Choosing the assistant's name](docs/choosing-a-name.md): what makes a name work, and `npm run check-name`.
- [Minutes and meeting data](docs/minutes-and-data.md): the minutes, and what each service keeps.
- [Ports and security](docs/security.md): the listeners, tokens and files, and the limits on cost.
- [Development](docs/development.md): the tests, the name corpus, and what's where.

## Contributing

Issues and pull requests are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md), and the [Code of Conduct](CODE_OF_CONDUCT.md) everyone taking part follows. Report security issues privately, as [SECURITY.md](SECURITY.md) says.

## Licence

Licensed under the [Apache License 2.0](LICENSE). The attention rules build on [AMP](https://github.com/tokencanopy/amp), also Apache-2.0: see [NOTICE](NOTICE).

agent-voice is not affiliated with or endorsed by Anthropic, Zoom, Google, Microsoft, Recall.ai, Deepgram, ElevenLabs, Cloudflare or Telegram. Their names are trademarks of their owners.
