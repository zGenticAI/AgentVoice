# Setting it up

The full setup, step by step. The [README](../README.md#quick-start) has the short version; [Your Claude Code session](claude-code.md), [Codex](codex.md) or [OpenCode](opencode.md) adds the deep tier. These pages call the assistant Alex, its default name, and you, its owner, Sam.

There are two ways to install it, and the steps are the same for both. **From npm**, AgentVoice is one command, `agentvoice`, and your settings and everything the service keeps are in your AgentVoice folder, `~/.agentvoice` (or the folder `AGENTVOICE_HOME` names), never in the installed package, so an upgrade keeps them. **From a clone** of the repository, they are in the clone, and you run its npm scripts. Where a step differs, it says both: `npm run <command> -- …` in a clone is `agentvoice <command> …` from npm, and `.env` and `data/` are `~/.agentvoice/.env` and `~/.agentvoice/data/`.

1. **Install:** Node.js 24 or later, on macOS or Linux.
   - **From npm** (npm 11 or 12): install it as yourself, never with `sudo` (with a system-wide Node, use a version manager such as nvm, fnm or Volta, or an npm prefix in your home folder), then make your AgentVoice folder:
     ```bash
     npm install -g @zgentic/agentvoice
     agentvoice init
     ```
     npm 11 says that esbuild's install script is "not yet covered by allowScripts", and npm 12 doesn't run it: either way is fine, AgentVoice doesn't need it. `agentvoice init` makes `~/.agentvoice` and its `data/` and `briefs/` folders, which only you can open, and `.env` (readable only by you), `profile.md` and `data/brief.md` from the examples. It never overwrites a file, so running it again only lists what is there. To keep the folder elsewhere, set `AGENTVOICE_HOME` to an absolute path (or one starting with `~/`) in your shell's profile, before `agentvoice init` and for every `agentvoice` command: `agentvoice service install` and `agentvoice setup` write it into the service and your coding client's config themselves. It is read from your shell only, never from `.env`, and a clone ignores it. The install takes about 175 MB, as a clone's does; `--omit=optional` leaves the slide decks' canvas library out. `npx @zgentic/agentvoice <command>` runs a command without installing, but `agentvoice setup` and `agentvoice service install` refuse to run from npx's cache, which npm clears.
   - **From a clone:** clone the repository and set it up. `npm install` takes about 175 MB, 73 MB of it pdf.js and a native canvas library for preparing slide decks; `npm install --omit=optional` leaves the canvas out on a computer that never prepares one:
     ```bash
     git clone https://github.com/zGenticAI/AgentVoice.git
     cd AgentVoice
     npm install
     install -m 600 .env.example .env
     ```
2. **You:** in `.env`, set `OWNER_NAME` (required) and, if you like, `OWNER_FULL_NAME` and `COMPANY_NAME`; copy `profile.example.md` to `profile.md` and make it yours (see [Make it yours](make-it-yours.md)). From npm, `agentvoice init` made `~/.agentvoice/profile.md` from the example: make that one yours.
3. **Keys:** in `.env`, fill in `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`, and for Recall.ai `RECALL_API_KEY` and `RECALL_REGION`: the region of your Recall account (`us-east-1`, `us-west-2`, `eu-central-1` or `ap-northeast-1`), since its key works there only. There is no default: the service refuses to start without it. Zoom needs no app or token of your own: Recall's bot joins with the meeting link alone. Set a spending limit with each provider too (see [Limits on cost](security.md#limits-on-cost)).
4. **Tunnel:** point a public HTTPS hostname of yours (for example `assistant.example.com`, with Cloudflare Tunnel) at `http://127.0.0.1:8787`, the public port (`PORT`), and set `PUBLIC_URL` to its address (`https://assistant.example.com`). That port serves only what the meeting bot needs; everything else is on a Unix socket in the data folder, which has no port to point anything at (see [Ports and security](security.md)).
   With Cloudflare Tunnel, for example, once `cloudflared` is installed and your domain is on Cloudflare:
   ```bash
   cloudflared tunnel login
   cloudflared tunnel create agent-voice
   cloudflared tunnel route dns agent-voice assistant.example.com
   ```
   Then, in `~/.cloudflared/config.yml`, with the tunnel's id and the credentials file that `tunnel create` printed:
   ```yaml
   tunnel: <tunnel id>
   credentials-file: /home/sam/.cloudflared/<tunnel id>.json
   ingress:
     - hostname: assistant.example.com
       service: http://127.0.0.1:8787
     - service: http_status:404
   ```
   and run it with `cloudflared tunnel run agent-voice` (see Cloudflare's docs to run it as a service). Any other tunnel or reverse proxy that gives a public HTTPS hostname and passes websockets works the same way.
5. **Page token:** set `AGENT_PAGE_TOKEN` to the output of `openssl rand -hex 24`.
6. **Check:** run `npm run check` (`agentvoice check` from npm). It checks the assistant's name and your settings, the bot's link (`PUBLIC_URL` and `AGENT_PAGE_TOKEN`), lists the profile sections it found, prints the consent line and the chat notice, with and without slides, and the first lines of the assistant's rules as they will be, checks `RECALL_REGION` and the bot page, says whether the speaker probe is on and which platforms presenting is on for (`SLIDES_PLATFORMS`), then makes one tiny request each to Anthropic, Deepgram and ElevenLabs (which makes a line of Alex's voice) and says which keys work, without printing them. The Recall key is first used when Alex joins a meeting (step 9). From npm, it first says where your AgentVoice folder, settings, data and the package are, and warns when the folder or `.env` can be opened by others, when `profile.md` or the shared brief is still the example, when the installed service runs another folder, or starts another Node or AgentVoice than this one, or a Node that is gone (run `agentvoice service install` again), and, run in a session folder, when its setup was made by another version, Node or AgentVoice folder (run `agentvoice setup` again there).
7. **Start the service:** run `npm start` (or `scripts/install-service.sh` to keep it running: a launchd agent on macOS, a systemd user service on Linux, see [Keeping it running](#keeping-it-running)). Its log goes to that Terminal with `npm start`, and to `data/agent-voice.log` when it runs as a service (`tail -f data/agent-voice.log` to follow it). From npm: `agentvoice start`, from any folder, or `agentvoice service install`; the log is `~/.agentvoice/data/agent-voice.log`. Then check the tunnel from outside your network (a phone with Wi-Fi off, say): `https://assistant.example.com/health`, with your address, has to show `{"ok":true}`; if it doesn't, the meeting bot can't load its page either. A test from your own computer or network can pass when the bot can't reach it.
8. **Brief:** write what Alex may say in the meeting, and what it must not, in `data/brief.md`: copy the example with `install -m 600 brief.example.md data/brief.md` (readable only by you) and fill it in (from npm, `agentvoice init` made `~/.agentvoice/data/brief.md` from the example: fill that one in), or have your coding session write it with `set_brief` (see [Your Claude Code session](claude-code.md), [Codex](codex.md) or [OpenCode](opencode.md)). That is the shared brief: Alex reads it for every answer, in every meeting without a brief of its own, until it is replaced. To give one meeting a brief of its own, keep it in a file (in `briefs/`, which is gitignored, or outside this folder; from npm, in `~/.agentvoice/briefs/`) and send Alex in with `npm run join -- "<link>" --brief <file>` (`agentvoice join "<link>" --brief <file>`, with the file's path from the folder you run it in), or have your session pass it to `join_meeting`: that meeting answers from it instead, and no other meeting sees it. A brief is at most 16,000 characters: a longer one is refused, never cut, since its end usually says what must not be shared. That includes a `data/brief.md` you edit by hand: past the limit, meetings without a brief of their own answer as if there were none until it is shortened, and the join note, the service log and `get_profile` say why.
9. **Send Alex into a meeting:** run the command below (it sends the service's local token, so start the service once first). Alex joins as a guest: if the meeting has a waiting room or lobby, someone in the meeting admits it.
   ```bash
   npm run join -- "https://us06web.zoom.us/j/123456789?pwd=..."
   # installed from npm:
   agentvoice join "https://us06web.zoom.us/j/123456789?pwd=..."
   ```

Google Meet and Microsoft Teams links work the same way (`npm run join -- "https://meet.google.com/abc-defg-hij"`). Some company accounts block guests or bots. If Alex is never offered for admission, the meeting's organiser has to allow external guests.

To have Alex present slides, each platform needs one more step: run the share test in a meeting you host there, then add the platform to `SLIDES_PLATFORMS` in `.env` (`~/.agentvoice/.env` from npm) and restart the service. Until then, a join with slides there is refused. See [Presenting slides](presenting.md#before-your-first-presentation) and [Testing a screen share](share-test.md).

## Keeping it running

`scripts/install-service.sh` installs the voice service so it starts at login and restarts if it stops:
- **macOS:** a launchd agent, `~/Library/LaunchAgents/<label>.plist`, made from `scripts/agent-voice.plist`. To stop it: `launchctl unload ~/Library/LaunchAgents/<label>.plist`.
- **Linux:** a systemd user service, `~/.config/systemd/user/<label>.service`, made from `scripts/agent-voice.service`. To stop it: `systemctl --user stop <label>`. To keep it running while you are logged out: `loginctl enable-linger $USER`.

The label is `SERVICE_LABEL` from `.env`, `local.agent-voice` unless set. The log goes to `data/agent-voice.log`. Run the script again to restart the service; `scripts/install-service.sh --print` shows the file it would install, and installs nothing. The script checks the file before installing it (with `plutil -lint` on macOS) and stops, saying why, if it isn't valid or doesn't name this folder, and says so if the service manager doesn't take the service. That the service manager took it doesn't mean the service started: a missing setting stops it at once, and the service manager keeps trying. Confirm with the details on the control socket (`curl --unix-socket data/control.sock http://localhost/health`, or the path the service prints when it starts) and the log: `npm run check` reads your settings and tries the keys, but doesn't ask the service. Characters such as "&" or "%" in the folder's path are escaped for the plist and the unit; a quote mark, a backslash or "$" can't be, so the script refuses such a folder. Before you change the label of an installed service, stop and remove the one under the old label (macOS: `launchctl unload` its plist, then delete it; Linux: `systemctl --user disable --now <old label>`, then delete its unit file): otherwise two services fight over the port. The script warns when it finds another service installed for the same folder.

**Installed from npm**, `agentvoice service install` does the same for your AgentVoice folder, with no script or template of the clone's:
- **macOS:** a launchd agent, `~/Library/LaunchAgents/<label>.plist`. To stop it: `launchctl unload ~/Library/LaunchAgents/<label>.plist`.
- **Linux:** a systemd user service, `~/.config/systemd/user/<label>.service` (under `$XDG_CONFIG_HOME` when that is set). To stop it: `systemctl --user stop <label>`. To keep it running while you are logged out: `loginctl enable-linger $USER`.

It starts `agentvoice start` by absolute paths, the Node you ran it with and the installed package's command, in your AgentVoice folder, with `AGENTVOICE_HOME` set to that folder in the service's own environment: launchd and systemd don't pass your shell's environment on, and that is how the service finds the same `.env`, token and socket as your commands and your coding client. With Homebrew's Node it names the formula's `opt` link, which `brew upgrade node` keeps. The label is `SERVICE_LABEL` (from your shell, else `~/.agentvoice/.env`), `local.agent-voice` unless set, as in a clone: one voice service per computer, since both use port 8787 unless `PORT` says otherwise. The log goes to `~/.agentvoice/data/agent-voice.log`, and the control socket is `~/.agentvoice/data/control.sock`: `curl --unix-socket ~/.agentvoice/data/control.sock http://localhost/health` confirms the service started, as above.
- `agentvoice service print` (or `print launchd`, `print systemd`) prints the file it would install, and installs nothing.
- It checks the file before installing it (`plutil -lint` on macOS, `xmllint` where there is one) and reads it back: the folder and the command must come back as they were given, or nothing is installed. A quote mark, a backslash, "$" or a control character in the AgentVoice folder's path, Node's or the package's can't be written safely into the file, so it refuses those.
- It never replaces a service with the same label that runs from another folder, such as a clone's: it says which folder that one serves, and replaces it only with `agentvoice service install --replace`. It warns when another installed service runs this AgentVoice folder or this package, which would fight over the port.
- Run it again after upgrading AgentVoice (`npm install -g @zgentic/agentvoice@latest`): it restarts the service on the new version. After switching Node (nvm keeps a prefix per version), install AgentVoice there, then run it again.
- `agentvoice service uninstall` stops the service and removes its file, only if it runs from your AgentVoice folder; your AgentVoice folder stays as it is. Run it before `npm uninstall -g @zgentic/agentvoice`.

## Moving from a clone to npm (optional)

A clone keeps working as it is, so this is only if you would rather have the npm install. One voice service at a time: both use the same label and port unless you set them apart.
1. Stop the clone's service (macOS: `launchctl unload ~/Library/LaunchAgents/<label>.plist`; Linux: `systemctl --user stop <label>`), or the `npm start` running in a terminal.
2. Install AgentVoice from npm (step 1 above), but don't run `agentvoice init` yet.
3. Copy your files from the clone into `~/.agentvoice`, keeping their modes, and leave the control socket behind: in the clone's folder, `mkdir -m 700 ~/.agentvoice`, then `cp -Rp .env profile.md ~/.agentvoice/` and `cp -Rp data briefs ~/.agentvoice/` (the ones you have; `cp` may say it doesn't copy `data/control.sock`, which is right), then `rm -f ~/.agentvoice/data/control.sock`. Then `agentvoice init`, which keeps every file that is there and makes only what is missing.
4. In `~/.agentvoice/.env`, check `PROFILE_FILE`, `CONTROL_SOCKET` and `AGENT_PAGE_FILE`: a relative path now goes from `~/.agentvoice`, not from the clone. `~/.agent-voice` (with a hyphen), the folder the long-socket advice in [Ports and security](security.md) suggests, is a different folder from `~/.agentvoice`: leave it as it is, or set `CONTROL_SOCKET` back to the default.
5. `agentvoice check`, then `agentvoice service install --replace`, which replaces the clone's service of the same label.
6. Link your coding session again, in a new session folder: `agentvoice setup claude-code`, `setup codex` or `setup opencode` (see [Your Claude Code session](claude-code.md), [Codex](codex.md) or [OpenCode](opencode.md)). The clone's own registration stays with the clone's folder.
