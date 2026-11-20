# agent-voice

[![M8ven Score](https://m8ven.ai/badge/mcp/zgenticai-agentvoice-16488l?v=197a9936ef5ef1c6d7dddad2f6056696)](https://m8ven.ai/mcp/zgenticai-agentvoice-16488l?s=readme)

A self-hosted AI meeting assistant. It joins your Zoom, Google Meet and Microsoft Teams meetings as a voice participant, says that it is an AI, and answers questions people ask it by name. It answers quick questions itself, from a brief you prepare for the meeting. It hands deeper ones to your own coding session (Claude Code, Codex or OpenCode), which can look through your notes and documents, and then speaks the answer. After the meeting, it writes the minutes.

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
                                           └─ zoom-meeting channel ⇄ your Claude Code, Codex or OpenCode session ⇄ its model
```

The assistant is called Alex unless you choose another name, and introduces itself as your assistant. This README says Alex, and Sam for you, its owner.

- **Joining.** You send Alex into a meeting with `npm run join -- <link>`, or by asking your coding session. A Recall.ai bot joins as a guest called "Alex (Sam's AI assistant)". Its camera is a web page served by your computer, which streams the meeting's audio to the voice service and plays Alex's voice.
- **Telling the meeting.** As it joins, Alex says that it is an AI assistant, that it is transcribing, that it can't agree to anything for you, and how to make it leave. It also posts a notice in the meeting chat: that it is an AI assistant transcribing the meeting, that it sends you a summary, that it keeps no recording of the meeting, how long it keeps its transcripts, and how to make it leave.
- **Answering.** Alex answers when a line is said to it by name and asks something ("Alex, what's the timeline?"), and, right after it has asked something or someone has said just "Alex?", the next thing said. It doesn't answer talk about it ("I asked Alex yesterday"), thanks or side conversation.
- **Two tiers.** The fast tier is Claude with the brief and the recent transcript, and answers in a second or two. When a question needs more (current work, documents, decisions), Alex says it is checking and hands the question to your coding session through an MCP channel. The session's meeting-assistant agent, started when the session sends Alex in, looks in the sources you allow and replies, and Alex speaks the answer. When no meeting-assistant is running, Claude Code takes a question in the session itself, and so does OpenCode once it knows which session is yours; Codex takes them only through the meeting-assistant.
- **Leaving.** "Alex, please leave" makes it leave at once and delete its own transcript and minutes of that meeting (in `data/`), and so does removing it from the participant list. Copies already handed to your coding session stay there (see [Where meeting data goes](#where-meeting-data-goes)). "Alex, never mind" only stops it talking.
- **Presenting.** Sent in with slides you prepared (`npm run join -- <link> --slides <script>`), Alex shares them as its screen when someone says "Alex, start the presentation", and says your script over them, word for word, stopping for questions and carrying on where it was. It never makes up narration. Presenting is off on each platform until you have run the share test there and turned it on (see [Presenting slides](docs/presenting.md)).
- **Minutes.** When the meeting ends, Claude writes minutes from the transcript (a summary, decisions, action items and open questions), and your session sends them to you (Codex, when you next write to it).

`AGENT_MODEL` in `.env` chooses the Claude model for the spoken answers (Sonnet 5.5 unless set), and `MINUTES_MODEL` the one for the minutes (the same unless set).

## What you need

- **A Mac or a Linux computer** with Node.js 24 or later, which stays on during your meetings. `npm install` takes about 175 MB, 73 MB of it pdf.js and a native canvas library for preparing slide decks; `npm install --omit=optional` leaves the canvas out if you never will.
- **Accounts and API keys** at Anthropic (the Claude API), Deepgram (speech to text), ElevenLabs (the voice: any stock voice) and Recall.ai (the meeting bot).
- **A public HTTPS hostname that tunnels to your computer,** for example with Cloudflare Tunnel. The meeting bot loads its page from it.
- **For the deep tier, a coding session,** one of these. Without one, Alex answers from the brief alone.
  - **Claude Code,** signed in with a claude.ai account or a Claude Console API key. The link to your session is a Claude Code channel, which is a research preview: it needs a development flag, and isn't available when Claude Code runs on Amazon Bedrock, Google Cloud or Microsoft Foundry. On claude.ai Team and Enterprise plans, an Owner must first enable channels for the organisation. See [Claude Code's channels documentation](https://code.claude.com/docs/en/channels).
  - **Codex CLI** 0.171.0 or later, pull only: no events, and questions only through its meeting-assistant agent, which has your session's shell. See [Codex](docs/codex.md).
  - **OpenCode** 2.3.2 or later, the V2 line (`@opencode/cli`). It can answer while nobody is at the screen, until you stop its background service. See [OpenCode](docs/opencode.md).
- **Meetings in English.** Speech recognition and the rules for who is being spoken to are English only.
- Optionally, with Claude Code only, its Telegram plugin, with its channel loaded in the same session, to send Alex into a meeting from your phone.

## Costs

You pay each service directly, on your own account. What uses it:

| Service | Billed for | What uses it |
| --- | --- | --- |
| Recall.ai | bot time | the time the bot spends in each meeting |
| Deepgram | streamed audio | all of the meeting's audio while Alex is in it |
| Anthropic (Claude API) | tokens | each answer (the rules, the brief and up to about 12,000 characters of transcript, with the rules and brief cached), and one call per meeting for the minutes |
| ElevenLabs | characters spoken | Alex's answers. Its fixed lines (the consent line, "let me check" and so on) are made once per voice and kept. |
| Your coding session (Claude Code, Codex or OpenCode) | your plan's usage, or API tokens at the provider of the model it uses | writing the brief; for a meeting started with `npm run join`, answering its questions (in Claude Code, every session with the channel loaded gets them until one replies; not in Codex); when the session sends Alex in, the meeting-assistant agent, which runs for the whole meeting (it waits for questions, answers them, and reads the transcript and your sources when it is quiet); and, after the meeting, reading the transcript and the minutes. In OpenCode, each question or event posted into your session starts a turn, also while you are away |

See each provider's pricing page for the current rates. `MAX_MEETINGS` (3 at once unless set) and `MAX_MEETING_MINUTES` (180 unless set) limit what a stray bot can cost, and the bot leaves by itself when nobody else joins within 5 minutes, when everyone else has left, or after 15 minutes of silence (up to 60 in a meeting with slides, whose script sets it). Set a spending limit at each provider as well (see [Limits on cost](docs/security.md#limits-on-cost)).

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
5. **Write the brief** for the meeting: what Alex may say, and what it must not. Copy the example with `install -m 600 brief.example.md data/brief.md`, so that only you can read it, and fill it in, or have your coding session write it (see below). That is the shared brief, for every meeting without one of its own.
6. **Send Alex into a meeting.** If the meeting has a waiting room, admit it from there.
   ```bash
   npm run join -- "https://us06web.zoom.us/j/123456789?pwd=..."
   ```
   To give the meeting a brief of its own instead, add `--brief` and its file: `npm run join -- "<link>" --brief briefs/acme.md`. That meeting answers from it, and no other meeting sees it. `briefs/` is gitignored, or keep them outside this folder.

[Setting it up](docs/setup.md) has every step in full, with a tunnel example.

## In a meeting

| Say | What happens |
| --- | --- |
| "Alex, what's the timeline?" | It answers, from the brief or after checking with your session. |
| "Alex, never mind" or "Alex, stop" | It stops talking, and drops the question. |
| Talking over it while it answers | It pauses at once. It stops for real words, and carries on for "mm-hm", "yeah", "okay" or a cough. It can be talked over until the bot page has played the end of the answer. The transcript keeps only the words the meeting heard, ending in "(cut off)". |
| "Alex, please leave" | It says goodbye and leaves. It deletes its transcript of the meeting (in `data/`), and writes no minutes. |
| Removing it from the participant list | The same as "Alex, please leave", once Recall confirms the removal. |
| "Alex, start the presentation" (in a meeting it has slides for) | It shares its slides and presents them. "Alex, next slide", "go back", "go to slide 5", "pause", "carry on" and "stop presenting" steer it ([When Alex presents](docs/in-a-meeting.md#when-alex-presents)). |

When Alex isn't sure a line was said to it, it stays quiet: say its name again. [In a meeting](docs/in-a-meeting.md) has the exact rules, and what to check when it doesn't answer.

## Linking your coding session

With Claude Code:
1. Register the channel once with `scripts/install-channel.sh`. It is registered for this folder only, so start Claude Code here.
2. Before a meeting, start Claude Code in this folder with the channel loaded, or resume a session with it (add `--resume`):
   ```bash
   claude --dangerously-load-development-channels server:zoom-meeting
   ```
3. Ask the session to "prepare Alex for my meeting with ...". It writes the brief. When the session then sends Alex in, it gives that meeting the brief for itself alone.
4. Allow the meeting-assistant agent's tools, and the folders it may read, in `.claude/settings.local.json` (see [The meeting assistant](docs/claude-code.md#the-meeting-assistant)).

During the meeting, the questions that the brief can't answer reach the session, and Alex speaks the reply. When the session sent Alex in ("Alex, join this meeting: <link>"), its meeting-assistant agent answers them in the background; for a meeting started with `npm run join`, they arrive in the session itself. Afterwards, the session sends you the minutes. [Your Claude Code session](docs/claude-code.md) has the details, the permissions and the safety rules.

Codex and OpenCode use the same channel and meeting-assistant, registered by files committed in this folder (`.codex/`, and `opencode.json` with `.opencode/`). Run `scripts/install-codex.sh` or `scripts/install-opencode.sh`, start the client in this folder, and read its page first, for what differs and the risks: [Codex](docs/codex.md) or [OpenCode](docs/opencode.md).

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
  - Your Claude Code session is another matter. On an individual claude.ai plan (Pro, Max or Ultra), Anthropic's consumer terms apply to it, and Anthropic isn't your processor for what it reads: use a Team, Enterprise or Console account where this matters. With Codex or OpenCode, the same question goes to the provider of the model each one uses: check its terms.
  - Telegram, if you use it, is not your processor at all: don't send minutes there where the GDPR applies.
  - You need a lawful basis, and you must give people a privacy notice, before the meeting (in the invitation, say): who you are, why you record, which services get what and where they are, how long it is kept, and their rights. [Where meeting data goes](#where-meeting-data-goes) lists the services.
  - Most of these services are in the US, so check each one's transfer basis (such as the EU-US Data Privacy Framework, or standard contractual clauses). Recall offers an EU region (`RECALL_REGION=eu-central-1`).
  - Recording meetings as a matter of course, of staff especially, is likely to need a data protection impact assessment, and in some countries the agreement of a works council.
- **AI disclosure.** People must know when they are talking to an AI. Under the EU AI Act's transparency rules (Article 50), from 2 August 2026, AI systems that talk with people must be designed to tell them so, unless it is obvious, and it requires AI-generated audio to be marked as such: the voice provider's own marking may not cover you, so check whether that rule applies to you too. It is honest everywhere. That is why the disclosure is always there: in the consent line, the chat notice, the participant-list name and the bot page.
- **Leaving.** Anyone can make Alex leave with "Alex, please leave", which also deletes its own transcript and minutes (in `data/`). What was already passed to your coding session or to the services stays there. Don't work around it.
- **When not to use it.** Don't send it into privileged meetings, such as legal advice: passing them to outside services can waive privilege, even when everyone agrees. Don't send it into meetings where recording isn't allowed, or that are confidential (medical matters, HR, board meetings), unless everyone has agreed and you have checked that their agreement is enough: an employee's agreement often isn't, and health data needs explicit consent or another legal basis. Meetings that other organisations host may have their own rules, and some block bots and guests.
- **The speaker probe.** `SPEAKER_PROBE` and `npm run join -- "<link>" --speaker-probe` are for test meetings whose participants have agreed beforehand to a test of who-is-speaking detection: the consent line and the chat notice don't mention it, and while it runs their display names and speaking reach your computer through the tunnel. See [Measuring who is speaking](docs/speaker-probe.md).
- **The share test.** `npm run join -- "<link>" --share-test` is for a test meeting you host: Alex shares a test page as its screen, step by step, and asks you what you see and hear. The page shows nothing of the meeting. See [Testing a screen share](docs/share-test.md).
- **Not a person.** Use a stock voice. Never clone a real person's voice without their consent. Alex can't agree to anything for you, and says so. Its answers come from Claude, and can be wrong.

## Where meeting data goes

| Where | What reaches it | How long it stays |
| --- | --- | --- |
| Recall.ai | Everything the bot gets in the meeting, live: its audio and video (shared screens included), the participant list and the chat. Every chat message Alex posts. The bot's record: its meeting link, name and status, and the bot page's address, which holds the page token and the meeting's key. With `SPEAKER_PROBE` on, for a test meeting joined with `--speaker-probe`, it also sends the service the participants' join, leave, rename and speaking events, with their display names and platform ids, and the bot's record holds the address they go to, with a token of that meeting's own. In a share test, the bot's record also holds the test page's address, with a token of that share's own. While Alex presents slides, the bot's browser shows them, anyone with access to your Recall dashboard can watch them through Remote DevTools, and the bot's record keeps the slides page's address, with a token that dies when the share stops. | No recording is stored: the bots use zero data retention, and when a bot's session ends, the service also asks Recall to delete its media. With zero data retention it keeps none of the participant events after the meeting. The bot's record stays in your Recall account. |
| Deepgram | The meeting's audio, live, for speech to text, and with it the words to listen out for: Alex's name, your name, your company, and `DEEPGRAM_KEYTERMS`. | The stream opts out of Deepgram's model improvement programme. Otherwise, Deepgram's terms. |
| Anthropic (Claude API) | For each answer: the rules (with your profile's About), the meeting's brief (its own, or the shared one), what your session added, and up to about 12,000 characters of the transcript. The rules also hold your full name, your company and the topics your profile hands to your session. In a meeting with slides, also each slide's title and first sentence, and the slide on screen: your script for it and its text. After the meeting, for the minutes: the whole transcript, the questions put to Alex, the meeting's date, times and platform, the meeting's brief, and the title of a presentation given. | Anthropic's commercial terms for the API. |
| ElevenLabs | What Alex says. | Kept in your ElevenLabs history, unless your account has zero retention (enterprise accounts) and you set `ELEVENLABS_ZERO_RETENTION=true`. |
| Your tunnel provider | The bot page and the meeting's audio, both ways, in transit, and, with the speaker probe (test meetings only), Recall's participant events: display names, platform ids and who is speaking. While Alex presents, the slides page and the images of the slide on screen and its neighbours, never the whole deck. | The provider's terms. Cloudflare Tunnel, for example, decrypts HTTPS at Cloudflare's edge. |
| Your coding session (Claude Code, Codex or OpenCode) | The meeting links you give it, and the start and end of each meeting. Each question handed to it, with up to about 60,000 characters of the transcript. The parts of the transcript it asks for, the latest lines (up to 50) with what Alex did with each when you ask why it didn't answer something, and what it reads in your knowledge sources. After the meeting, the whole transcript, the questions put to Alex and the minutes, which the session and its agent are told to read. When no session has claimed the questions (a meeting started with `npm run join`, say), every session with the channel loaded gets them, and the end-of-meeting event too, so each of those sessions is told to read the transcript and the minutes. When you ask it to draft a presentation script: the PDF of your slides, and the script, comments included; and the whole script again whenever it reads it to send Alex in with the slides. During a presentation, slide titles, in its `presentation` events, in `slides_status`, and with the questions handed to it ("On screen: slide 6 of 9, Pricing."). With Codex or OpenCode, all of this goes to the model the client uses: OpenAI's for Codex unless you set another provider; for OpenCode, the provider you set, and with none set, OpenCode 2.3.2 used a free hosted model. In OpenCode, the questions and events the channel posts into your session too. Codex gets no events. | Claude Code keeps its session history on your computer, and sends the conversation to Anthropic under your Claude account's terms. Codex keeps each session on your computer (`~/.codex/sessions`), and OpenCode keeps its sessions, what the channel posts included, in its database (`~/.local/share/opencode`); each sends the conversation to its model's provider under that provider's terms. These copies are outside `data/`: neither `TRANSCRIPT_RETENTION_DAYS` nor "please leave" deletes them. On an individual claude.ai plan (Pro, Max or Ultra), check your privacy settings on model training. |
| Telegram (optional) | Requests to join a meeting, and anything your session sends you there, such as the minutes. | Telegram's terms. Bot chats are not end-to-end encrypted. |
| The meeting's chat | The chat notice, the longer detail of your session's answers, anything your session posts with `post_chat`, and the notice Alex posts when it reaches `MAX_MEETING_MINUTES`. | The meeting platform keeps it like any chat message. |
| The meeting itself | The slides Alex presents, shared as its screen: anyone in the meeting can screenshot or record them. Only the slides your script shows: an excluded one never leaves your computer. | As the meeting's own recordings, if any. |
| Your computer (`data/`) | Transcripts, minutes, the shared brief, the audio of Alex's fixed lines, and the service's log. With the speaker probe, `data/speaker-probe/`: each test meeting's measurements, counts and timings only, with no names or words (see [Measuring who is speaking](docs/speaker-probe.md)). A meeting's own brief is never written there: the service keeps it in memory. The slide decks you prepare, in `data/decks/`: each slide's image and text, and the contact sheet (see [Presenting slides](docs/presenting.md)). In a meeting with slides, the service holds the script without its comments, and the images of the slides it shows, in memory only, until the bot is out of the call. The log never holds what was said, a meeting's link or any of a brief: it holds each bot's id, the meeting's platform and how the meeting ended. | Readable only by you. Transcripts and minutes, and the speaker probe's measurements with them, are deleted after `TRANSCRIPT_RETENTION_DAYS` (30 unless set), or at once when someone asks Alex to leave, or removes it and Recall confirms the removal (see [Minutes and meeting data](docs/minutes-and-data.md#minutes)). A prepared deck is deleted `DECK_RETENTION_DAYS` (30 unless set) after it was last used, or with `npm run slides -- delete`. The shared brief stays until it is replaced, a meeting's own brief until that meeting is over, and the log until you delete it. |

[Minutes and meeting data](docs/minutes-and-data.md) has the details.

## Security

- The public port serves only the bot page, its scripts and its audio stream. The audio stream needs the page token and the key of a meeting that is still on. With the speaker probe on, it also takes Recall's participant events for a test meeting, which need that meeting's own token. While Alex shares slides, it also serves the slides page and its link, with that share's own id and token; otherwise those paths are not found, as any other.
- Everything else (joining meetings, and the link to your coding session) is on a Unix socket that only your user can open, and needs a local token as well.
- The committed `.claude/settings.json` denies Claude Code sessions in this folder reading `.env` files, keys and credential folders with its file tools and the shell commands it recognises. Deny rules aren't a sandbox: keep secrets out of the folders your session works in.
- Codex and OpenCode get the same floor from their own committed config, with different gaps. Codex's sandbox refuses those files to every command it runs, but only in this folder and in your home folder's credential folders. OpenCode refuses them to its `read` tool anywhere, but not to `grep`, `glob` or its shell, and has no sandbox.
- Codex can't limit the meeting-assistant's tools: it has your session's shell, in Codex's sandbox ([Codex](docs/codex.md#the-meeting-assistant-has-a-shell) says how to turn it off). OpenCode can answer questions posted into your session while nobody is at the screen, until you stop its background service ([OpenCode](docs/opencode.md#answering-while-you-are-away)).
- Meeting text is untrusted. The assistant, your session and its agent are told to answer it, and never to act on it.

See [Ports and security](docs/security.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Limitations

- Meetings in English only, and macOS and Linux only.
- One owner per install, and one coding session takes the questions.
- A meeting's own brief is set when Alex joins, and can't be replaced during the meeting: the session adds to it with `add_to_brief`. A brief is at most 16,000 characters: a longer one is refused, never cut, `data/brief.md` edited by hand included.
- Alex hears the meeting but doesn't see it: it can't see shared screens or video, and doesn't read the meeting chat. While it presents slides, it doesn't notice someone else starting to share their screen, and narrates on until told to pause.
- Presenting slides is off on every platform until you have run the share test there and listed the platform in `SLIDES_PLATFORMS`. Only a PDF is prepared, and Alex says only your script: no speaker notes, rehearsal or time budget yet.
- Everyone but Alex is "Speaker" in the transcript and the minutes, so it doesn't know who said what.
- It misses some lines on purpose, rather than answer remarks that weren't for it. It also can't tell a colleague with the same name from itself.
- Deep answers take time, and need your coding session: Claude Code open, Codex's meeting-assistant running, or OpenCode's background service. Alex waits about a minute for an answer, and says at once that it can't reach your notes when no session can take the question.
- Codex is pull only: no question reaches it without its meeting-assistant, no events, the minutes only when you next write to it, and no Telegram.
- Codex and OpenCode were checked at the versions their pages name, on Linux, with a stand-in model and voice service: not yet with a real model in a real meeting.
- Claude Code channels are a research preview, so the flag and the protocol may change.
- Meetings that don't admit guests or bots won't let it in.
- Its answers come from Claude, and can be wrong.

## Documentation

- [Setting it up](docs/setup.md): every step, a tunnel example, and keeping the service running.
- [In a meeting](docs/in-a-meeting.md): joining, the consent line, leaving and stopping, the rules for when Alex answers, and what people can say while it presents.
- [Your Claude Code session](docs/claude-code.md): the channel, the meeting-assistant agent, permissions and safety.
- [Codex](docs/codex.md): Codex CLI as your coding session, pull only: setting it up, what differs from Claude Code, the meeting-assistant's shell, and the floor.
- [OpenCode](docs/opencode.md): OpenCode as your coding session, with push: setting it up, what differs from Claude Code, answering while you are away and how to stop it, and the floor.
- [Presenting slides](docs/presenting.md): exporting a deck as a PDF, `npm run slides -- prepare` and `check`, the script Alex presents from, the contact sheet, and presenting in a meeting: joining with `--slides`, what the room can say, your controls, and turning presenting on per platform with `SLIDES_PLATFORMS`.
- [Make it yours](docs/make-it-yours.md): the owner and company settings, the profile and the bot page.
- [Choosing the assistant's name](docs/choosing-a-name.md): what makes a name work, and `npm run check-name`.
- [Minutes and meeting data](docs/minutes-and-data.md): the minutes, and what each service keeps.
- [Measuring who is speaking](docs/speaker-probe.md): the speaker probe, a test mode for naming speakers, and `npm run speaker-report`.
- [Measuring Deepgram Flux](docs/flux-probe.md): `npm run flux-probe`, which streams test clips to Deepgram as the service does, to tune when talking over Alex stops it.
- [Testing a screen share](docs/share-test.md): `npm run join -- "<link>" --share-test`, which checks in a test meeting you host whether Alex's voice and hearing keep running while it shares a screen.
- [Ports and security](docs/security.md): the listeners, tokens and files, and the limits on cost.
- [Development](docs/development.md): the tests, the name corpus, and what's where.

## Contributing

Issues and pull requests are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md), and the [Code of Conduct](CODE_OF_CONDUCT.md) everyone taking part follows. Report security issues privately, as [SECURITY.md](SECURITY.md) says.

## Licence

Licensed under the [Apache License 2.0](LICENSE). The attention rules build on [AMP](https://github.com/tokencanopy/amp), also Apache-2.0: see [NOTICE](NOTICE).

agent-voice is not affiliated with or endorsed by Anthropic, OpenAI, OpenCode, Zoom, Google, Microsoft, Recall.ai, Deepgram, ElevenLabs, Cloudflare or Telegram. Their names are trademarks of their owners.
