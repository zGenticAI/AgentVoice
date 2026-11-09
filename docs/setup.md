# Setting it up

The full setup, step by step. The [README](../README.md#quick-start) has the short version; [Your Claude Code session](claude-code.md) adds the deep tier. These pages call the assistant Alex, its default name, and you, its owner, Sam.

1. **Install:** Node.js 24 or later, on macOS or Linux, then clone the repository and set it up:
   ```bash
   git clone https://github.com/zGenticAI/AgentVoice.git
   cd AgentVoice
   npm install
   install -m 600 .env.example .env
   ```
2. **You:** in `.env`, set `OWNER_NAME` (required) and, if you like, `OWNER_FULL_NAME` and `COMPANY_NAME`; copy `profile.example.md` to `profile.md` and make it yours (see [Make it yours](make-it-yours.md)).
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
6. **Check:** run `npm run check`. It checks the assistant's name and your settings, the bot's link (`PUBLIC_URL` and `AGENT_PAGE_TOKEN`), lists the profile sections it found, prints the consent line, the chat notice and the first lines of the assistant's rules as they will be, checks `RECALL_REGION` and the bot page, then makes one tiny request each to Anthropic, Deepgram and ElevenLabs (which makes a line of Alex's voice) and says which keys work, without printing them. The Recall key is first used when Alex joins a meeting (step 9).
7. **Start the service:** run `npm start` (or `scripts/install-service.sh` to keep it running: a launchd agent on macOS, a systemd user service on Linux, see [Keeping it running](#keeping-it-running)). Its log goes to that Terminal with `npm start`, and to `data/agent-voice.log` when it runs as a service (`tail -f data/agent-voice.log` to follow it). Then check the tunnel from outside your network (a phone with Wi-Fi off, say): `https://assistant.example.com/health`, with your address, has to show `{"ok":true}`; if it doesn't, the meeting bot can't load its page either. A test from your own computer or network can pass when the bot can't reach it.
8. **Brief:** write what Alex may say in the meeting, and what it must not, in `data/brief.md`: copy the example with `install -m 600 brief.example.md data/brief.md` (readable only by you) and fill it in, or have your Claude Code session write it with `set_brief` (see [Your Claude Code session](claude-code.md)). Alex reads it for every answer, in every meeting it is in, until it is replaced.
9. **Send Alex into a meeting:** run the command below (it sends the service's local token, so start the service once first). Alex joins as a guest: if the meeting has a waiting room or lobby, someone in the meeting admits it.
   ```bash
   npm run join -- "https://us06web.zoom.us/j/123456789?pwd=..."
   ```

Google Meet and Microsoft Teams links work the same way (`npm run join -- "https://meet.google.com/abc-defg-hij"`). Some company accounts block guests or bots. If Alex is never offered for admission, the meeting's organiser has to allow external guests.

## Keeping it running

`scripts/install-service.sh` installs the voice service so it starts at login and restarts if it stops:
- **macOS:** a launchd agent, `~/Library/LaunchAgents/<label>.plist`, made from `scripts/agent-voice.plist`. To stop it: `launchctl unload ~/Library/LaunchAgents/<label>.plist`.
- **Linux:** a systemd user service, `~/.config/systemd/user/<label>.service`, made from `scripts/agent-voice.service`. To stop it: `systemctl --user stop <label>`. To keep it running while you are logged out: `loginctl enable-linger $USER`.

The label is `SERVICE_LABEL` from `.env`, `local.agent-voice` unless set. The log goes to `data/agent-voice.log`. Run the script again to restart the service; `scripts/install-service.sh --print` shows the file it would install, and installs nothing. The script checks the file before installing it (with `plutil -lint` on macOS) and stops, saying why, if it isn't valid or doesn't name this folder, and says so if the service manager doesn't take the service. That the service manager took it doesn't mean the service started: a missing setting stops it at once, and the service manager keeps trying. Confirm with the details on the control socket (`curl --unix-socket data/control.sock http://localhost/health`, or the path the service prints when it starts) and the log: `npm run check` reads your settings and tries the keys, but doesn't ask the service. Characters such as "&" or "%" in the folder's path are escaped for the plist and the unit; a quote mark, a backslash or "$" can't be, so the script refuses such a folder. Before you change the label of an installed service, stop and remove the one under the old label (macOS: `launchctl unload` its plist, then delete it; Linux: `systemctl --user disable --now <old label>`, then delete its unit file): otherwise two services fight over the port. The script warns when it finds another service installed for the same folder.
