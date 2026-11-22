# Security policy

## Reporting a vulnerability

Report security issues privately, through GitHub's private vulnerability reporting: open this repository's **Security** tab and choose **Report a vulnerability**, or go straight to the form:

https://github.com/zGenticAI/AgentVoice/security/advisories/new

Please don't open a public issue for one.

Leave out keys, tokens, meeting links, transcripts, minutes and the names of real people: describe the problem with made-up data instead. We will acknowledge your report, keep you told of progress, and agree a disclosure date with you once a fix is ready.

## Supported versions

Security fixes go into the latest version on `main` only.

## Scope

Test only in meetings you run, with people who have agreed to it: the assistant records everyone in a meeting.

In scope, for example:
- reaching the control side (joining meetings, the link to the coding session) as anyone but the owner's user on the owner's computer;
- using the bot's audio stream without the page token and the key of a live meeting;
- using the slides page or its link, or the share test's page or its link, without the token of a live share, or Recall's participant events (`/recall/`) without the token of a meeting joined with the speaker probe;
- getting more of a deck through the slides link than the slide on screen and its neighbours;
- a meeting participant getting the assistant, the owner's coding session (Claude Code, Codex or OpenCode) or its meeting-assistant agent to do anything but answer: read files it shouldn't, post, join meetings, or say what the profile says never to share;
- a file the committed floor denies (`.claude/settings.json`, the permission profile in `.codex/config.toml`, the policies in `opencode.json`) read where that floor is meant to hold: [Codex](docs/codex.md#the-floor) and [OpenCode](docs/opencode.md#the-floor) say where that is;
- the channel posting into any OpenCode session but the owner's, posting anything but a meeting's events, or revealing OpenCode's service password;
- the assistant not leaving, or not deleting the meeting's transcript, after "please leave", or after being removed from the meeting once Recall has confirmed the removal;
- meeting content kept anywhere but the places [Where meeting data goes](README.md#where-meeting-data-goes) lists, or what was said in a meeting written to the log.

Out of scope:
- the services the assistant uses (Recall.ai, Deepgram, ElevenLabs, Anthropic, your tunnel provider, Telegram), the coding clients (Claude Code, Codex, OpenCode) and the models they use, and the meeting platforms (Zoom, Google Meet, Microsoft Teams): report those to them;
- the gaps in each client's floor that its page lists as known, such as Codex's floor stopping at this folder, or OpenCode's `grep`, `glob` and shell not being covered;
- attacks that need the owner's user account on the owner's computer already;
- an answer that is just wrong, unless it crosses one of the lines above.

[Ports and security](docs/security.md) describes the listeners, the tokens and the file permissions.
