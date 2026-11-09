# Make it yours

Everything the assistant says about you, and everything it, your Claude Code session and the meeting-assistant agent are told about you, comes from two places you own. No person or company is written into the code. These pages call the assistant Alex, its default name, and you, its owner, Sam.

**`.env`: short values that go into sentences.**
- `OWNER_NAME` (required): your name as the assistant says it. "Hello, I'm Alex, Sam's AI assistant. ... I can't agree to anything for Sam.", "Let me check that with Sam's notes.", the participant list ("Alex (Sam's AI assistant)") and the chat notice ("afterwards I send Sam a summary to keep"). There is no default: the service and the channel refuse to start without it, so no install ever introduces itself as someone else's assistant. The wording never uses a pronoun for you, so none needs setting.
- `OWNER_FULL_NAME` (optional, `OWNER_NAME` unless set): in the assistant's rules ("You are Alex, Sam Rivera's AI assistant") and the minutes ("the minutes of a meeting for Sam Rivera").
- `COMPANY_NAME` (optional): in the assistant's rules ("Sam works at Acme." when the profile has no About, and "a question about Acme or Sam's work"), as a word Deepgram listens out for, and as a plain-text label on the bot page. Every sentence that would use it is left out when it is unset. It is never in the consent line, the chat notice or the minutes.

Each is one line of letters, spaces, apostrophes, hyphens and dots, at most 60 characters, since they go into prompts and onto the bot page; `COMPANY_NAME` may also have digits, "&", commas and brackets ("Acme 3D", "Smith & Co", "Acme, Inc.", "Acme (UK)"), which the bot page escapes. Anything else stops the service at start-up, with the reason. An assistant named as you are called (`AGENT_NAME` is your first name) gets a warning: you are in every meeting it is in, so it would answer what people say to you.

**`profile.md`: prose about you and your work.** Copy `profile.example.md` to `profile.md`, which is gitignored, or point `PROFILE_FILE` at a file of your own elsewhere (a private repository, say). Without either, every section has its generic default; but a file `PROFILE_FILE` names that isn't there, or a profile that can't be read, stops the service and the channel at start-up, since it holds your Never share and Never open. It has five sections, each optional:

| Section | What goes in it | Who uses it | Without it |
| --- | --- | --- | --- |
| `## About` | One to three sentences of standing context | The spoken answers' rules (every answer), and `get_profile` | "Sam works at Acme." when `COMPANY_NAME` is set, else nothing |
| `## Hand to the session` | Which questions go to your session | The rules' hand-off line | "current work, repos, documents, decisions, plans, design detail, positioning or how it compares with other products" |
| `## Knowledge sources` | Paths, what each is for, and any rule for a source | The meeting-assistant agent and your session, through `get_profile` | The agent answers from the brief alone |
| `## Never share` | Standing rules on what is never said or posted | The agent and your session, through `get_profile` | Their own rules only |
| `## Never open` | More paths the agent must never read | The agent, through `get_profile` | Its own rules only |

Any other `## ` heading is ignored, with a warning at start-up, so a misspelt one is not silently lost; HTML comments are left out, so the example's notes can stay. The service builds the spoken answers' rules from the profile when it starts, so restart it after changing About or Hand to the session; `get_profile` reads the file again at every call. The spoken answers never see the knowledge sources, Never share or Never open: they come only from the brief and what your session added. Never share and Never open add to the agent's own rules (see [The meeting assistant](claude-code.md#the-meeting-assistant)), and can't loosen them.

`npm run check` prints your settings, the profile sections it found, the consent line, the chat notice and the opening lines of the assistant's rules as a meeting will get them: read them before a meeting does.

The consent wording (`src/consent.ts`) is fixed apart from the names in it: it says the assistant is an AI, that it is transcribing, that it can agree to nothing, and how to make it leave. Whoever runs the assistant is responsible for it being right under the recording and consent rules where they and the people they meet are.

## The bot page

The bot's camera in the meeting is `public/agent.html`: the assistant's name, "Sam's AI assistant", your company as plain text when `COMPANY_NAME` is set, a "Transcribing" badge, and a wave while it speaks. It uses the system's fonts and embeds nothing. Should a placeholder ever go unfilled, the page shows plain text in its place, such as "AI assistant", never `{{owner}}`. To show a page of your own, set `AGENT_PAGE_FILE` to it (kept out of this repository, in `data/` or a private one). The server fills in `{{name}}`, `{{owner}}` and `{{company}}`, HTML-escaped. It reads the page once, when it starts, and serves that copy, so restart the service after changing it; a page moved or edited meanwhile changes nothing until then. The contract a page of your own keeps:
- it imports `startAgent` from `/agent.js` and calls it: that streams the meeting's audio to the service and plays the assistant's voice (the public port serves the page, `/agent.js` and `/pcm-worklet.js`, nothing else);
- it says "AI" in its visible text, as the consent line, the chat notice and the participant list do.

The service checks both when it starts, and refuses a page that breaks either; `npm run check` checks it too. Start from a copy of `public/agent.html`. The public port never says why a request failed, so a page's path never reaches the meeting or the internet.
