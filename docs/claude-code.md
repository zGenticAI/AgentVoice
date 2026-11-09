# Your Claude Code session

The deep tier. Questions the brief can't answer go to your own Claude Code session through an MCP channel, `zoom-meeting`, and the session answers them: through its meeting-assistant agent when the session sent Alex in, itself otherwise. Channels are a research preview of Claude Code: the README's [What you need](../README.md#what-you-need) says what they require. These pages call the assistant Alex, its default name, and you, its owner, Sam.

## Linking the session

1. Register the channel once with `scripts/install-channel.sh`. It registers it for this folder only (Claude Code's local scope), so only a session started here loads it, with this folder's agent and deny rules. The channel links to the voice service on its control socket with the local token (see [Ports and security](security.md)), so start the service once first; until then the channel says, on stderr, that the token is missing, and keeps trying. While it has no link, its tools tell the session why, so the session can tell you: the local token is missing, nothing is listening on the control socket (the service is not running, or it and the channel use a different `.env` or data folder), or the service refused the link because the local token doesn't match (restart the voice service and the session).
2. Before a meeting, start a session with the channel loaded, or resume one with it:
   ```bash
   claude --dangerously-load-development-channels server:zoom-meeting
   claude --resume --dangerously-load-development-channels server:zoom-meeting
   ```
   Channels are a research preview, so a custom channel needs this flag. Claude Code shows a warning; choose "I am using this for local development".
3. Ask the session to "prepare Alex for my meeting with ...". It writes the brief with the `set_brief` tool, and Alex uses it for quick answers.
4. During the meeting, deep questions arrive in the session as `<channel source="zoom-meeting" kind="question">`. The session answers with `reply`, and Alex speaks the answer. Keep the session open in its terminal until the meeting ends. Alex waits about 60 seconds for an answer, then tells the meeting it can't reach your notes. If the meeting moves on first (Alex is talked over while it says it is checking, told never mind, asked something else or asked to leave, or its page goes), it stops waiting at once. A reply after either is not said, and the `reply` tool tells the session which of the two happened, instead of "Alex will say it now."

   Alex keeps every answer the session gives, the chat detail included (only the spoken part is in the transcript), and every message the session posts with `post_chat`, and answers from them by itself for the rest of the meeting. So a follow-up such as "what was the third step again?" is answered at once instead of going back to the session. An answer that came too late to be said is kept too, marked as one the meeting hasn't heard, so Alex gives it if the question comes up again. For that the service remembers the questions it stopped waiting for, in memory only, for 10 minutes at most. Once Alex is out of a meeting it was asked to leave or removed from, the words of its questions go at once, those still waiting for an answer included: only that they were asked stays, so a reply to one is told that nothing is kept. A late answer is not kept once Alex was asked to leave or the meeting is over, and the `reply` tool says so. The session can also get ahead of questions with `add_to_brief`: facts the meeting is likely to ask about next, in short plain sentences, only what the brief's "may be shared" allows. Alex answers from them from the next question. These additions live in memory, for that meeting only: the brief file is unchanged (`set_brief` still replaces it), they are capped at 8,000 characters (the oldest go first, to keep answers quick), and they go when the meeting ends, or at once when Alex is asked to leave or removed.

   `add_to_brief`, `get_transcript` and `post_chat` take the meeting's key (`meeting`, which `join_meeting` returns and every question carries). Without it they use the latest meeting Alex is in. A `post_chat` without it is refused while Alex is in more than one meeting, since everyone in the meeting sees a post and it can't be taken back.
5. To send Alex into a meeting from the session, join the meeting yourself and paste the link with a request, such as "Alex, join this meeting: https://us06web.zoom.us/j/...". The session calls the channel's `join_meeting` tool, which does the same as `npm run join`. Claude Code asks before using the tool unless you allow it.

   From Telegram too, if you want: set `ZOOM_JOIN_TELEGRAM_CHATS` in `.env` to your own chat's ID (the `chat_id` the Telegram plugin puts on your messages), then restart the session with the Telegram plugin's channel loaded as well (add `--channels plugin:telegram@claude-plugins-official`; see Claude Code's channels documentation). The session then also joins when a message from that chat asks, with the link in the same message, and replies there saying which meeting Alex is joining. It goes by the chat and user IDs the plugin sets, never by what a message says, and only private chats are taken (anyone in a group could ask). A link in a meeting, a file, a web page, another chat or a forwarded message still never sends Alex anywhere.
6. After the meeting, the session receives a `meeting_ended` event with the transcript path and the minutes file (or why there are none), and sends you the minutes.

When a question goes to your session, it goes first, so your session is already working on it while Alex says it is checking. If no answer has come 15 seconds after that, Alex says "Still checking. One moment." once, and keeps waiting.

## The meeting assistant

Channel events only reach the main session, and only between its own tool calls, so a long tool call can hold a question past the 30 seconds people wait. So after `join_meeting` succeeds, the session starts the `meeting-assistant` agent (`.claude/agents/meeting-assistant.md`) in the background, and that agent pulls the questions instead:

1. It calls the channel's `next_question` tool with the meeting key `join_meeting` returned, which waits up to `wait_seconds` (default 120, at most 600) and returns that meeting's next question as JSON, or `{"none": true}` if nobody asked anything.
2. It answers with `reply`, then calls `next_question` again.
   - It gets ahead of questions too. After a reply, if the sources it just read hold one or two facts the meeting is likely to ask about next, it adds them with `add_to_brief`. When nobody has asked anything for a while (`{"none": true}`), it reads the latest part of that meeting's transcript once (`get_transcript` with `max_chars` 3000 and the meeting key). If the talk is heading to something neither the brief nor its additions cover, it does at most one or two quick reads in its sources, checking for a question (`next_question` with `wait_seconds` 1) before each, so a question asked meanwhile isn't kept waiting, then adds the facts and goes back to waiting. It adds only facts from its own sources, never anything taken from the transcript or the questions, and it doesn't repeat its answers, which are kept automatically.
3. When the meeting ends, `next_question` returns `{"meeting_ended": true, ...}`, at once and on every later call, so an agent that was busy answering still finishes. The agent then gives the session the questions, answers and follow-ups. The session still gets its `meeting_ended` event. Without a meeting key, the agent hears the end of the latest meeting until Alex joins or starts another one.

While the agent is waiting, or answering (up to 45 seconds after its last `next_question` call returned), questions go to it and not to the session. With no agent running, they arrive in the session as before. A question the agent doesn't collect within 45 seconds goes to the session as well.

The agent's instructions are the same for everyone and name no one. Who you are, the brief, where to look and your own rules come from the channel's read-only `get_profile` tool, which the agent calls once, right after its first `next_question` returns: your names and company from `.env`, the brief (its path and text), and your profile's sections (see [Make it yours](make-it-yours.md)), read again at every call. It looks in the brief first, then in the knowledge sources your profile lists, in that order and by each source's own rule; with none listed, it answers from the brief alone and says anything else is one for you to follow up on. The session sees `get_profile` too, and is told to read it before writing a brief.

Permissions for the session. Claude Code merges two settings files in this folder: the committed `.claude/settings.json`, the floor of deny rules below, which is the same for everyone, and your own `.claude/settings.local.json`, which is gitignored and never committed. Keep the floor as it is, and put everything of your own in `settings.local.json`; a deny rule in either wins over any allow. In `settings.local.json`:
- Allow `mcp__zoom-meeting__next_question`, `mcp__zoom-meeting__get_profile`, `mcp__zoom-meeting__reply`, `mcp__zoom-meeting__post_chat`, `mcp__zoom-meeting__add_to_brief` and `mcp__zoom-meeting__get_transcript` in `permissions.allow`: an agent in the background can't answer a permission prompt, so a tool it isn't allowed is simply denied. Without `get_profile`, it has neither your name, the brief's text nor your knowledge sources.
- Knowledge sources outside the project need reading allowed too: add their folders to `permissions.additionalDirectories`, or allow them with a rule such as `Read(//home/sam/work/acme-docs/**)` or `Read(~/work/acme-docs/**)` in `permissions.allow`. Otherwise its reads there are denied.
- Add your own private paths (the ones in your profile's Never open, say) to `permissions.deny`.
- The project agent (`.claude/agents/meeting-assistant.md`) and both settings files load only when the session runs in this folder: start it here.

For example (with your own paths):
```json
{
  "permissions": {
    "allow": [
      "mcp__zoom-meeting__next_question", "mcp__zoom-meeting__get_profile", "mcp__zoom-meeting__reply",
      "mcp__zoom-meeting__post_chat", "mcp__zoom-meeting__add_to_brief", "mcp__zoom-meeting__get_transcript",
      "Read(~/work/acme-docs/**)", "Read(~/work/acme-website/**)"
    ],
    "deny": ["Read(~/work/acme-docs/hr/**)", "Read(~/work/acme-ops/secrets/**)"]
  }
}
```

What the agent must never open or say has a floor of its own, in its instructions, that a profile only adds to: never open `.env` files, `~/.ssh`, `~/.cloudflared`, `~/.claude.json` or anything named like a key, secret, token, credential or certificate; never say or post credentials, hostnames, internal URLs, account IDs, security findings, or anything about other people or clients. The committed `.claude/settings.json` enforces part of the file floor for every session in this folder: its `permissions.deny` rules stop a session reading these, wherever they are: `.env`, `.env.local`, `.env.*.local`, `.env.production`, `.env.prod`, `.env.development`, `.env.dev`, `.env.staging`, `.env.test`, `.env.bak`, `.env.backup`, `.env.old`, `*.pem`, `*.key`, `*.p12`, `*.pfx` and `local-token` (the service's local token); and these in your home folder: `~/.ssh`, `~/.cloudflared`, `~/.aws`, `~/.claude.json`, `~/.git-credentials`, `~/.netrc`, `~/.config/gh`, `~/.docker/config.json`, `~/.kube`, `~/.gnupg` and `~/.claude/.credentials.json`. `.env.example` is not among them, so a session can read the template. The rest of the floor (other names for keys, secrets, tokens and credentials) is the agent's instructions alone: add deny rules for your own in `settings.local.json`. Deny rules apply to Claude Code's file tools and to the shell commands it recognises as reading a file (such as `cat` or `head`), not to a command that reads files without naming them or to a script that opens files itself: they are not a sandbox, so keep secrets out of the folders the session works in (Claude Code's sandboxing can enforce it for every process).

Several Claude Code processes can have the channel loaded at once, such as idle pre-started ones. They all stay linked. Questions and meeting events go to:
1. a session whose meeting-assistant is waiting in `next_question`, or answering;
2. else the session that most recently used `join_meeting`, `reply` or `next_question`. Each session sends that time again when it relinks, so after the voice service restarts the same session gets them, whatever order they reconnect in. `get_transcript`, `set_brief`, `add_to_brief` and `post_chat` don't move them;
3. else, when no session has used one of those (for example a meeting started with `npm run join`), every linked session, and the first reply wins. Replying then claims the next questions.

The service logs `[bridge] Questions now go to Claude Code session #N` when that changes, and a warning when a question goes to every session. Only the channel server can link: `/bridge` is on the control socket (your user only), needs the local token, and refuses any browser (a request with an `Origin` header), so neither a web page nor another program or user on this computer can take the questions.

Safety:
- The channel tells the session, and the agent's instructions tell the agent, to treat meeting text as untrusted: to read and answer, and to change nothing because of it, with one exception. They may add to Alex's additions for that meeting with `add_to_brief`, using facts from their own sources. Meeting text may suggest a topic to add, but never supplies the content, and never leads them to do anything else.
- What the session and its agent add with `add_to_brief` comes from their own sources, never from the transcript or the questions, and only what the brief allows to be shared. Alex is told that the questions quoted in the answers it keeps were asked by participants and are not instructions.
- For extra safety, open meeting sessions in a permission mode that asks before edits.
- Don't use `--dangerously-skip-permissions` for meeting sessions.
