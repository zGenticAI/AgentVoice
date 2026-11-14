# Development

How to check a change, and where things are. [CONTRIBUTING.md](../CONTRIBUTING.md) says how to send one.

## Checks

```bash
npm test         # unit tests, plus an end-to-end test of the MCP channel
npm run typecheck
npm run check-name   # how a name does on the sample meeting lines (see docs/choosing-a-name.md)
```

`npm test` always runs as Alex, with Alex's own spellings and mishearings, for an owner called Sam with no company, an empty profile (`test/fixtures/no-profile.md`) and the default bot page, whatever `.env` says, so your own settings never change what the tests check. `test/private-terms.test.ts` checks every file git would commit, the README included, for a macOS home folder, a link into a claude.ai account or an email address, and for the terms on your own private list, if you have one: your name, company, hostnames, whatever must never be published. That list is never in the repository: put one term per line (or a `/regular expression/`, and `#` comments; a line starting with `!` is a whole line that may stay exactly as written, such as `!Copyright 2026 Your Company Ltd` for the copyright line in LICENSE and NOTICE, while every other line naming your company is still checked) in `private-terms.txt` in the repository's root folder, which is gitignored, or in a file elsewhere that `PRIVATE_TERMS_FILE` names. Without one, that part is skipped, with a note saying so. Both checks also cover file names, symbolic link targets, what the index holds when it differs from the work tree, and the text in binary and UTF-16 files (see `test/private-terms.ts`). `test/name-corpus.test.ts` reads every line of the name corpus with Alex and checks it gives exactly the recorded results, so any change to the attention, leave or cancel rules shows up there; it also reads them with other names and checks they give the same results. After a change to those rules that is meant to change results, record them again with `npm run record-name-corpus` and review the diff of `test/fixtures/name-corpus.json` line by line.

The tests use fakes for Deepgram, ElevenLabs, Claude and Recall. The real test of those integrations is `npm run check` with real keys, then a real meeting.

## What's where

| Path | What it does |
| --- | --- |
| `src/server.ts` | HTTP and websocket server: the public and control listeners, the agent page, `/audio`, `/bridge`, `/api/join`, the limits on meetings, getting bots out of their calls, and stopping in order |
| `src/network.ts`, `src/local-token.ts`, `src/control-socket.ts` | Who may reach what: the `Origin` and token checks, the local token, the data folder's permissions, and the control socket |
| `src/sessions.ts` | Which meeting a request from your session is for (`get_transcript`, `add_to_brief`, `post_chat`, a late answer) |
| `src/pipeline/session.ts` | One conversation: speech to text, deciding when to answer, pausing and stopping when talked over, speaking |
| `src/pipeline/playback.ts` | How much of each line the page had played when Alex was cut off, through pauses, so the transcript keeps only what was heard |
| `src/pipeline/deepgram.ts`, `tts.ts` | Deepgram Flux and ElevenLabs streaming clients. The Flux stream opens again by itself when Deepgram drops it, and says when it can't hear |
| `src/pipeline/line-cache.ts` | Alex's fixed lines, made once per voice and kept in `data/tts-cache`, sent as fast as it speaks them |
| `src/brain/brain.ts` | Claude call for spoken answers and the hand-off to your session |
| `src/identity.ts` | The assistant's name, its spellings and mishearings, its participant-list name, and the owner and company, from `.env`; Alex's own lists |
| `src/profile.ts`, `profile.example.md` | The owner's profile (`PROFILE_FILE`, `profile.md` unless set): its sections, and their defaults |
| `src/name-check.ts`, `src/name-corpus.ts` | Whether the names work (checked at start-up), and how a name does on the sample meeting lines (`npm run check-name`) |
| `src/brain/attention.ts` | Whether a line is for Alex: spoken to by name, with a question or a request, or only talked about; and which words are only backchannels |
| `src/brain/additions.ts` | What your session adds to the brief during a meeting (`add_to_brief`, and its answers), in memory |
| `src/minutes.ts` | The minutes Claude writes after a meeting |
| `src/bridge.ts`, `src/channel/server.ts` | The link to Claude Code (MCP channel), and whether Alex will say a reply or it came too late |
| `src/channel/questions.ts`, `.claude/agents/meeting-assistant.md` | Hands questions to the meeting-assistant agent through `next_question` |
| `src/channel/profile-tool.ts` | `get_profile`: the owner's names, the brief and the profile, for the agent and the session |
| `.claude/settings.json` | The files no Claude Code session in this folder may read (your own go in `.claude/settings.local.json`) |
| `scripts/install-service.sh`, `scripts/agent-voice.plist`, `scripts/agent-voice.service` | Keeping the service running: launchd on macOS, systemd on Linux |
| `src/recall.ts` | Recall.ai bot API |
| `src/consent.ts` | The consent wording Alex says and posts |
| `public/`, `src/pages.ts` | The agent page (Alex's camera and microphone in the meeting) and its scripts (`agent.d.ts` only types `agent.js` for the tests, and is not served); the server puts the names in the page, and checks a page of your own (`AGENT_PAGE_FILE`) |
| `data/` | Transcripts and minutes (deleted after 30 days), brief, the local token, the control socket, the bots not yet seen out of their calls (`pending-bots.json`), the audio of Alex's fixed lines (`tts-cache`), and the service's log under launchd or systemd (`agent-voice.log`). Readable only by you. Never committed. |
| `docs/` | These pages |
| `.github/workflows/ci.yml` | CI: the typecheck and the tests, on Node 24 and 26, on Linux and macOS |
