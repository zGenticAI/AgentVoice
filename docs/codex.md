# Codex

The deep tier with Codex CLI instead of Claude Code: the same `zoom-meeting` channel and the same meeting-assistant agent, set up by files committed in this folder. Codex is **pull only**: the meeting's questions reach it only through the meeting-assistant, and the channel can't put anything into your session by itself. Tested with Codex CLI 0.171.0 (see [Tested versions](#tested-versions)). These pages call the assistant Alex, its default name, and you, its owner, Sam. [Your Claude Code session](claude-code.md) has what works the same way in every client: briefs, `add_to_brief`, `why_not_answered`, presentations (but see `npm run slides` below) and the meeting-assistant's loop.

Installed from npm, "this folder" on this page is your session folder, the one `agentvoice setup codex` made (see [Installed from npm](#installed-from-npm)); `npm run <command> -- …` is `agentvoice <command> …`; and `.env` and `data/` are in your AgentVoice folder: `~/.agentvoice/.env` and `~/.agentvoice/data/`.

**The main risk:** Codex can't limit the meeting-assistant's tools, so it has your session's shell, and meeting text reaches it. Read [The meeting-assistant has a shell](#the-meeting-assistant-has-a-shell) before you use it, and turn its shell off there if you prefer.

## What you need

- Codex CLI 0.171.0 or later: `npm install -g @openai/codex`. `scripts/install-codex.sh` refuses an older one, and says so for a newer one.
- This folder as a Git clone, as the README's Quick start makes it: Codex loads a project's `.codex/` folder only from a Git checkout you trust. Installed from npm, the session folder, which `agentvoice setup codex` makes a Git repository of its own (`git init`).
- On Linux, a home folder outside `/tmp` and `$TMPDIR`. Codex's sandbox lets commands write in those, and there it makes an empty, read-only placeholder for each home-folder entry of [the floor](#the-floor) that doesn't exist, and can leave them behind: in the check, `~/.ssh`, `~/.aws` and the others became empty files, and Codex could no longer start in this folder. With a home folder elsewhere, nothing was made. `scripts/install-codex.sh` refuses a home folder in a temporary folder, and `agentvoice setup codex` refuses a home folder or an AgentVoice folder in one.
- `npm install` run in this folder (from npm: AgentVoice installed, and `agentvoice init` run), and the voice service set up and started once (see [Setting it up](setup.md)): the channel links to it with the local token the service makes.

## Setting it up

1. Run `scripts/install-codex.sh`. It checks your Codex and `npm install`, has Codex load its config here with `codex mcp list` (which needs no key and starts nothing), and says whether Codex trusts this folder yet. It writes nothing.
2. Start Codex at the root of this folder: `cd <this folder> && codex`. The channel's command is a path from there, so a session started in a subfolder can't start it. The first time, Codex asks whether you trust the folder: choose "Trust and continue". If you once said no, set `trust_level = "trusted"` under `[projects."<this folder>"]` in `~/.codex/config.toml` (or `$CODEX_HOME`'s), as the script prints. Then run the script again: it should say "Codex trusts this folder and loads its config".
3. Ask the session to "prepare Alex for my meeting with ...", then to send Alex in: "Alex, join this meeting: <link>". Codex asks before `join_meeting`, every time. Once Alex has joined, the session starts the meeting-assistant (`spawn_agent`, agent type `meeting-assistant`), which takes the meeting's questions until the meeting ends.

Don't:
- register the channel with `codex mcp add`: it writes your own config, for every project. If you did, remove it with `codex mcp remove zoom-meeting` (the script tells you when it finds one);
- start Codex here with `--sandbox` (`-s`) or `--dangerously-bypass-approvals-and-sandbox`: either replaces [the floor](#the-floor);
- set `AGENTVOICE_CLIENT` in `.env`: `.codex/config.toml` sets it, and the channel ignores it in `.env` (with a warning), since every client in this folder shares that file.

What is committed:
- `.codex/config.toml`: the `zoom-meeting` server (`node_modules/.bin/tsx src/channel/server.ts`, with `AGENTVOICE_CLIENT=codex`, and `tool_timeout_sec = 900`, so `next_question`'s waits of up to 600 seconds aren't cut at Codex's own limit of 300), which tools ask first, and the floor, a permission profile called `agentvoice`.
- `.codex/agents/meeting-assistant.toml`: the meeting-assistant, with the same instructions as Claude Code's (a test checks they are the same) and no model of its own: it uses the session's.

Keep your own settings, such as your model and provider, in `~/.codex/config.toml`, not in these files.

### Installed from npm

1. Make a folder for your meeting sessions and set it up for Codex:
   ```bash
   mkdir -p ~/agentvoice-session && cd ~/agentvoice-session && agentvoice setup codex
   ```
   It takes a folder that isn't there yet or is empty (or one it set up before for your AgentVoice folder): Codex lets commands write the folder it starts in, so it must never be your AgentVoice folder, your home folder or a project of yours. It must be a folder of yours, in folders only you can change (never one another user made, or one in a folder other people can write): anyone else who can change it could replace the floor and the configs setup writes there. A folder your own group can write is fine when no one else is in that group, as with the group of your own that Ubuntu and Fedora give each user; for any other, setup names the folder and the `chmod go-w` that makes it yours alone. It checks your Codex (0.171.0 or later), makes the folder a Git repository of its own (`git init`), writes `.codex/config.toml` and `.codex/agents/meeting-assistant.toml` from the package's, and asks Codex with `codex mcp list` whether it loads them yet, as the script does. It writes nothing outside the folder, your own `~/.codex/config.toml` included.
2. Start Codex at the root of that folder: `cd <the folder> && codex`, and choose "Trust and continue" the first time (or set `trust_level = "trusted"` under `[projects."<the folder>"]`, as setup prints). Then run `agentvoice setup codex` again there: it should say "Codex trusts this folder and loads its config".
3. From here on it is as above: step 3, and the rest of this page.

The config it writes is the committed one with two changes:
- The channel is started by absolute paths into the installed package: `command` is the Node you ran setup with, `args` is the package's `agentvoice.js` and `channel`, and `env` has `AGENTVOICE_HOME`, your AgentVoice folder, beside `AGENTVOICE_CLIENT = "codex"`, since Codex gives the channel a fixed set of environment variables, not your shell's.
- The floor gains entries for your AgentVoice folder, which is outside the session folder: its `.env` names, `data/local-token` and `data/decks`, as `~/.agentvoice/…` (absolute paths for an `AGENTVOICE_HOME` elsewhere). Check it: `codex sandbox -P agentvoice -C . -- cat ~/.agentvoice/.env` must say "Permission denied". (Not yet tried with Codex itself: check it before your first meeting.)

Run it again after upgrading AgentVoice or Node: it refreshes its own files, and keeps the meeting-assistant's shell switch as you left it. If you changed `.codex/config.toml`, it stops, with a diff, and writes nothing: Codex has no file of yours that setup merges into, so `agentvoice setup codex --replace-changed` replaces it, keeping yours as `.codex/config.toml.before-setup-<date and time>`, and you make your changes to the new one again.

Slides can't be prepared from Codex: the floor denies `data/decks` to every command it runs, so run `agentvoice slides prepare` and `check` yourself in a terminal, as below.

## What works, and what doesn't

| | Claude Code | Codex |
| --- | --- | --- |
| A question the brief can't answer | the meeting-assistant takes it; with none running, it arrives in the session | the meeting-assistant takes it; with none running, Alex says at once "I can't reach Sam's notes right now, so I'll pass that question on to Sam." |
| A question the meeting-assistant hasn't collected after 45 seconds | goes to the session | Alex says the same, then |
| A meeting started with `npm run join` | its questions arrive in the session | nothing takes them unless you ask the session to start the meeting-assistant; without a meeting key, it takes the first question's meeting (not tried with a real model) |
| `meeting_started`, `presentation` and `meeting_ended` events | in the session | none: ask the session how a presentation is going, and it calls `slides_status` |
| The minutes | in `meeting_ended`, and in the meeting-assistant's report | only in the meeting-assistant's report, which reaches you when you next write to the session, not when the meeting ends (from Codex's source; not run) |
| Joining from Telegram | yes | no: `ZOOM_JOIN_TELEGRAM_CHATS` is ignored, with a warning |
| The meeting-assistant's tools | its six channel tools, and Read, Grep and Glob | everything the session has (see below) |
| Which channel tools ask first | what you allow in `settings.local.json` | the same for everyone, committed: `join_meeting`, `set_brief` and `slides_control` ask every time, also when the meeting-assistant calls them; the other eight never ask |
| The file floor | deny rules on Claude Code's file tools and the shell commands it recognises | Codex's sandbox, on every command Codex runs, but only in this folder and for the credential folders in your home folder |
| Network for commands | as your Claude Code settings say | none for any command in this folder, yours included |
| `next_question` waits of up to 600 seconds | yes | yes |
| `npm run slides -- prepare` and `check` (`agentvoice slides` from npm) | the session runs them, and Claude Code asks you first | the floor denies every file in `data/decks` to every command Codex runs, these included, so `check`, and `prepare` once a deck is there, can't read what they need (from the floor; not tried with Codex): run them yourself in a terminal, and ask the session only to draft the script |

When your Codex session links, the voice service logs `[bridge] Coding session #N can't be sent questions: only its meeting-assistant takes them`. When no session takes a question, `why_not_answered` says so, and that the meeting-assistant must be running. If a Claude Code or OpenCode session is linked as well, a question your Codex session can't take goes on to the one of them used most recently that can be sent one.

## The meeting-assistant has a shell

Codex can't limit a custom agent's tools: an agent file can switch off only the shell and a few other things. So the meeting-assistant has what your session has: the shell (`exec_command`), file edits (`apply_patch`), all 11 channel tools, Codex's web search, and more. Meeting text (the questions, the transcript) reaches it, so someone in the meeting could ask it to do something ("read the file ...", "run ..."). That is the main risk of using AgentVoice with Codex. In Claude Code the agent has its six channel tools and three ways to read files, nothing else.

What contains it:
- Its instructions, the same as Claude Code's: meeting text is untrusted, it reads and answers and changes nothing because of it, never opens `.env` files, keys or credentials, and never says credentials, hostnames or anything the brief keeps back.
- [The floor](#the-floor): Codex's sandbox refuses the files Claude Code's deny rules list to every command it runs, the meeting-assistant's included, in this folder and in your home folder's credential folders. Its commands have no network, and can write only in this folder and the temporary folders.
- `join_meeting`, `set_brief` and `slides_control` ask you every time, also when the meeting-assistant calls them, so meeting text can't send Alex anywhere, change a brief or steer slides without you.

What is not contained:
- It can read any file your user can read outside this folder, except those credential folders: a `.env` in a knowledge-source folder elsewhere included.
- It can change files in this folder, with the shell or `apply_patch`, and post in the meeting chat (`post_chat`) and add to what Alex answers from (`add_to_brief`) without asking.
- Codex's web search is a hosted tool, outside the sandbox and its network setting: what it searches for leaves your computer.

To turn its shell off, uncomment the last two lines of `.codex/agents/meeting-assistant.toml` (from npm, the one in your session folder: `agentvoice setup codex` keeps it off when you run it again), between meetings:
```toml
[features]
shell_tool = false
```
It then loses the shell, and keeps everything else (checked: `exec_command` and `write_stdin` went). Codex 0.171.0 has no separate tool to read a file, so it can no longer read your knowledge sources: it answers from the brief and `get_profile` alone, and hands the rest to you. A model that edits with `apply_patch` keeps that tool (from Codex's source: the test model was never offered it). In a clone the file is committed, so `git status` shows your change: keep it out of your commits.

## The floor

`default_permissions = "agentvoice"` in `.codex/config.toml` makes a permission profile Codex's sandbox for every session in this folder. It is Codex's `:workspace` (write in this folder and the temporary folders, read elsewhere, no network), minus the files no command may read or write:
- in this folder and every folder in it: the 12 `.env` names Claude Code's rules deny (`.env`, `.env.local`, `.env.*.local`, `.env.production` and the rest), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `local-token` and everything under `data/decks`;
- in your home folder: `~/.ssh`, `~/.cloudflared`, `~/.aws`, `~/.claude.json`, `~/.git-credentials`, `~/.netrc`, `~/.config/gh`, `~/.docker/config.json`, `~/.kube`, `~/.gnupg` and `~/.claude/.credentials.json`;
- the coding clients' own credentials, which Claude Code's rules don't list: Codex's login (`~/.codex/auth.json`), and OpenCode's service password, which opens every OpenCode session, and its stored keys (`~/.local/state/opencode` and `~/.local/share/opencode`). Only at those default places: with `CODEX_HOME`, `XDG_STATE_HOME` or `XDG_DATA_HOME` set elsewhere, they are outside the floor.

A test checks it denies the same example files as `.claude/settings.json`, in this folder and in the home folder, and the clients' credentials as well. Unlike Claude Code's deny rules, the sandbox holds for every command, whatever it is: in the check, `cat` got "Permission denied" for each kind, even running as root, and `.env.example` stayed readable. In this folder, it replaces a `sandbox_mode` in your own config.

Its limits:
- **It stops at this folder.** Codex finds the files a pattern matches by walking the folder before each command, which it can't do for the whole disk, so outside this folder only the home-folder entries hold. A `.env` or a key in a knowledge-source folder elsewhere is readable to Codex's commands, the meeting-assistant's included. Claude Code and OpenCode deny those names anywhere. Keep secrets out of the folders your sources are in. Installed from npm, the home-folder entries include your AgentVoice folder's `.env` names, local token and decks (see [Installed from npm](#installed-from-npm)), so those hold there; its other files (transcripts, minutes, `profile.md`, the briefs and the log) are readable to Codex's commands, as files outside this folder are.
- A file created after a command starts isn't denied to that command (Codex says so too).
- On Linux, Codex looks for the files the patterns match 16 folders deep (`glob_scan_max_depth` in `.codex/config.toml`): a `.env` or a key deeper than that in this folder isn't denied (not tried).
- The channel itself is not sandboxed: it reads `.env` and the data folder, as with every client. That is why `join_meeting` takes a brief or a script as text, never a path.
- Permission profiles are a beta feature of Codex. `--sandbox` (`-s`) and `--dangerously-bypass-approvals-and-sandbox` replace the profile.
- Commands in this folder have no network, yours included, even when your own config allows it.
- On Linux, each command started about 20 ms later in the check, for the walk (in a folder of about 9,000 files, `node_modules` included). Codex's sandbox there uses bubblewrap: with none installed, Codex uses its own, and says so.

Every one of the 11 tools has its own `approval_mode` in `.codex/config.toml`, and a tool added later asks every time. So Codex never offers to remember a choice, which would write `approval_mode = "approve"` into the committed file. In the check, no prompt offered it; with a tool left on `auto`, its prompt did. An `approval_policy = "never"` in your own config would refuse the three tools that ask, outright (from Codex's source; not tested).

## Meeting text, the model and history

- What the session and the meeting-assistant handle goes to the model Codex uses: OpenAI's, unless you set another provider in your Codex config. The README's [Where meeting data goes](../README.md#where-meeting-data-goes) says what that is.
- Codex keeps each session on your computer, so it can be resumed (`~/.codex/sessions`, or `$CODEX_HOME`'s). Neither "please leave" nor `TRANSCRIPT_RETENTION_DAYS` deletes it.

## Tested versions

Codex CLI 0.171.0, on Linux, with a stand-in model on this computer (no API key) and a stand-in voice service; every meeting text and secret was made up. Seen:
- Untrusted, Codex loads none of this folder's config: the session is read-only, with no `zoom-meeting`. Trusted, it loads all of it: the `agentvoice` profile, the channel (its relative command starts, with all 11 tools, and the channel's instructions reach the model) and the meeting-assistant.
- `join_meeting`, `set_brief` and `slides_control` asked, from the session and from the meeting-assistant. The other eight ran without asking. No prompt offered "remember".
- A `next_question` of 330 seconds was not cut.
- The floor, file by file, as above. Writing in the folder worked, and the network was refused.
- `spawn_agent` started the meeting-assistant, with the shared instructions and a `zoom-meeting` process of its own. With its shell switched off, it lost the shell and kept the rest.
- `scripts/install-codex.sh` with the folder trusted and untrusted, with a broken config (it prints Codex's own error) and with a `zoom-meeting` in the user config.

Not checked: Codex's terminal UI (`codex` with no subcommand: its trust prompt, and how a prompt from the meeting-assistant looks there; every run used `codex app-server`), whether you can keep talking to the session while the meeting-assistant runs (likely, from Codex's source), macOS, a real model, a real voice service and a real meeting.

## How to check it works

1. `scripts/install-codex.sh` (from npm, `agentvoice setup codex` in the session folder) says "Codex trusts this folder and loads its config: the zoom-meeting channel, the meeting-assistant and the floor."
2. The floor: `codex sandbox -P agentvoice -C . -- cat .env` says "Permission denied", and `codex sandbox -P agentvoice -C . -- head -n 1 .env.example` prints the template's first line. From npm, in the session folder: `codex sandbox -P agentvoice -C . -- cat ~/.agentvoice/.env` says "Permission denied".
3. With the voice service running, start Codex here. The service's log shows `[bridge] Coding session linked (1 linked)` (or more) and `[bridge] Coding session #N can't be sent questions: only its meeting-assistant takes them`.
4. In a test meeting you host, send Alex in from the session, allow `join_meeting`, and check that the session starts the meeting-assistant. Ask Alex something the brief doesn't cover: Alex says it is checking, then says the meeting-assistant's answer. If Alex says at once that it can't reach your notes, nothing took the question: ask the session "why didn't Alex answer that?".

## Stopping it

- The meeting-assistant stops when the meeting ends.
- "Alex, please leave", or removing Alex from the participant list, ends the meeting for Alex at once, and so does stopping the voice service.
- Nothing in Codex answers the meeting but the meeting-assistant: with none running, Alex says it can't reach your notes. Whether quitting Codex's terminal stops a meeting-assistant that is still running was not checked: end the meeting for Alex first if you need to be sure.
- To stop Codex loading this folder's config at all, set `trust_level = "untrusted"` under `[projects."<this folder>"]` in `~/.codex/config.toml`.
