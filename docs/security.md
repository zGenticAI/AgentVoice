# Ports and security

What can reach the voice service, and what keeps the meeting data on your computer private to you. These pages call the assistant Alex, its default name.

The service has two listeners, so what the internet can reach never depends on headers a proxy may or may not add:

| Listener | Where | Serves | For |
| --- | --- | --- | --- |
| `PORT` (8787), the public port | `HOST`: 127.0.0.1 unless set | the bot page (`/agent`) and its scripts, its audio (`/audio`), and `/health`, which says only `{"ok":true}` | the meeting bot, through the tunnel |
| the control socket | `data/control.sock`, a Unix socket in the data folder (`CONTROL_SOCKET` to put it elsewhere) | `/api/join` (`npm run join`), `/bridge` (the Claude Code channel), and `/health` with the details (whether a session is linked, how many meetings). No pages. | your user on this computer only |

- Point the tunnel at the public port. The control side has no port at all. Leave `HOST` unset unless the tunnel runs on another machine; with `HOST=0.0.0.0` the service warns at every start.
- **The bot's audio** needs `AGENT_PAGE_TOKEN` and the key of a meeting this service sent the bot into and that is still on: a made-up key, or one of a meeting that is over, is refused. One connection per meeting at a time; a page that reconnects within a minute of losing its connection is let back in (the meeting keeps its place under `MAX_MEETINGS` meanwhile).
- **The control socket** is a Unix socket in the data folder, not a port on 127.0.0.1. Only your user can open it (the folder is 0700, the socket 0600), and no other user can listen in its place while the service is down, as anyone on this computer could on a port above 1024 and so catch the local token from the channel or `npm run join`. Both send the token only to a socket in a folder only you can open. No browser can open a Unix socket, so DNS rebinding has nothing to reach and no `Host` is checked; `/api/join` and `/bridge` still refuse anything with an `Origin` header (a web page's requests always have one) and need the local token, as a second line, and `/api/join` also needs JSON.
  - The details: `curl --unix-socket data/control.sock http://localhost/health` (the service prints this line, with the full path, when it starts).
  - At start the service replaces a stale socket (one a service that did not stop cleanly left behind), and refuses to start if something other than a socket is at the path, or another voice service is running on it.
  - A socket's path can be 103 bytes at most on macOS (107 on Linux). If the data folder's path is longer than that allows, the service says so at start: set `CONTROL_SOCKET` in `.env` to a shorter path in a folder only you can open, such as `~/.agent-voice/control.sock` after `mkdir -m 700 ~/.agent-voice`. `npm run join` and the channel read the same `.env`.
- **The local token** is `data/local-token`: a random secret the service makes at its first start, readable only by you. `npm run join` and the zoom-meeting channel read it from the same data folder and send it with every request, so another program on this computer can't start bots or take the questions. Without it they say "start the voice service once to create it". To change it, delete the file and restart the service; the channel reads it again each time it relinks.
- **Files:** the `data` folder is readable only by you (0700), and so are the brief (0600), the local token (0600), the control socket (0600) and `pending-bots.json` (0600). Transcripts, minutes and the audio of the fixed lines are written readable only by you, and the service sets the folder, the brief, the token and the socket again at every start.

## Limits on cost

- `MAX_MEETINGS` (default 3): how many meetings Alex is in at once. A join beyond it, with `npm run join` or `join_meeting`, is refused: "Already in 3 meetings, the most MAX_MEETINGS allows." (with how many of them are ending). A meeting holds its place from the join until its bot is out of the call: after its page disconnects, through the minute in which a page may come back, and until Recall takes the request to leave (see [Minutes](minutes-and-data.md#minutes), "If the page disconnects"), so a meeting ending frees its place about a minute later. A bot whose page never connects (the tunnel was down, say) is asked to leave the call after 15 minutes, which frees its place.
- `MAX_MEETING_MINUTES` (default 180, at most 1440): the longest Alex stays in one meeting, counted from when its page first connected, whether or not its page is still connected when it runs out. It then posts "I've reached the time limit for one meeting (180 minutes), so I'm leaving the call now." in the chat, and leaves the call. The meeting gets its minutes, as at any normal end. If its page has gone by then, the bot just leaves, with nothing posted. After "Alex, please leave" nothing more is posted.
- Set spending limits with each provider as well: Anthropic, Deepgram, ElevenLabs and Recall.
