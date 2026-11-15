# Changelog

The notable changes in each version. The project follows [Semantic Versioning](https://semver.org/): until 1.0, a minor version may change settings or behaviour, and says so here.

## Unreleased

### Added

- A code of conduct: the Contributor Covenant 2.1.
- A brief for one meeting: `npm run join -- "<link>" --brief <file>`, or `join_meeting`'s `brief`. That meeting answers, and its minutes are written, from it instead of the shared brief (`data/brief.md`), and no other meeting sees it, even when `set_brief` changes the shared brief meanwhile. It is kept in the voice service's memory only, until the meeting is over. `get_profile` takes the meeting's key, and gives that meeting's brief; when it can't be had (the meeting is over, say) it gives none, never the shared one in its place. The join note says which brief the meeting uses. The control `/health` and the bridge now say what the service can do (`features`), so a newer `npm run join` or channel refuses a brief to an older service, which would ignore it.
- Ask your Claude Code session why the assistant didn't answer something: the channel's new `why_not_answered` tool gives, for the latest lines of a live meeting (10, or up to 50), what the assistant did with each and why, by its attention rules. It is kept in memory only, never in a file or the log, goes when the meeting ends or at once on "please leave" or a removal, and only your session can read it. The meeting-assistant agent doesn't get it.
- The speaker probe, a test mode for setting up speaker names: with `SPEAKER_PROBE=1` in `.env`, a meeting joined with `npm run join -- "<link>" --speaker-probe` measures how the meeting platform's participant events (who joined, who is speaking, from Recall) line up with the turns the assistant hears. It keeps one file of counts and timings per meeting in `data/speaker-probe/`, with no names or words, deleted with the transcript, and none for a meeting it was asked to leave. `npm run speaker-report` pools them by platform. Off by default; `join_meeting` never turns it on; for test meetings whose participants have agreed (see docs/speaker-probe.md). The control `/health` and the `/api/join` answer say whether it is on (`speaker_probe`).

### Changed

- Briefs are limited to 16,000 characters, `set_brief` included: a longer one is refused, never cut, since its end usually says what must not be shared. A `data/brief.md` edited by hand past the limit is not used at all until it is shortened: meetings without a brief of their own answer as if there were none, and the join note, the service log (its length only) and `get_profile` say why. Before, `set_brief` took anything, and the shared brief was used however long it was.
- One websocket message may hold at most 1 MiB on the bridge and 64 KiB from the bot page; a larger one closes its connection. Before, ws's default of 100 MiB applied.
- Talking over the assistant pauses it first. It stops only for words, and carries on after a cough, a laugh, or "mm-hm", "yeah", "okay", "right" or "I see". It can now be talked over until the bot page has played the end of an answer. Before, it stopped at the first sound Deepgram turned into a word, and only while the answer was still going out to the page.
- The transcript says what the meeting heard the assistant say. When it is talked over, told never mind, or asked something new partway through an answer, when its page goes, or when ElevenLabs fails partway through a line, the line keeps only the words the bot page had played, ending in "(cut off)", and a line it never got to is left out. The minutes and the next answers go by it. Before, the transcript had every line in full as soon as the assistant started it.
- The consent line and the goodbye are protected until the bot page has played them to the end, as the service now follows the page's playback. Before, it went by when their audio had gone out, which could be earlier: when the page started 50 ms late, when ElevenLabs paused partway, or when an answer to a question asked before the consent line was still playing ahead of it.
- The bot leaves a meeting by itself sooner: 5 minutes after it got in if nobody else has joined (Recall's default was 20), and after 15 minutes of silence, counted once it has been in the call 10 minutes (the default was 60, after 20).
- Speech recognition reconnects by itself when Deepgram drops the stream, or when the stream sends nothing back for 5 seconds while the meeting's audio goes to it (a connection that died without closing), as soon as more of the meeting's audio comes in, then backing off, and sends the last 2 seconds said meanwhile first. A sentence cut off by the drop is kept as far as it got. The bot page says "can't hear the meeting" only once Deepgram has been unreachable for 5 seconds, or refused the key, and the message clears once speech recognition is back. Before, a dropped stream left the assistant deaf for the rest of the meeting.
- A meeting survives a drop of the bot page's connection. The page reconnects by itself within a minute, with the secret the service gave it, and the meeting goes on: the same transcript, and no second consent line unless the drop cut it off. What was said while the page was away is not heard, so a question asked then has to be asked again. Before, a dropped connection ended the meeting, and the bot left the call.
- The bot page reconnects by itself when its connection to the service drops, showing "Reconnecting…" meanwhile: it notices a connection that has stopped answering within 4 seconds, tries again within a quarter of a second, then less and less often, and stops after 75 seconds or when the service says the meeting is over. The assistant's voice it already had plays on. Before, a drop left it "Disconnected" for good.
- A meeting that really ended as its page disconnected (or one Alex was removed from) is still reported within seconds: the service asks Recall whether the bot has left, instead of waiting the minute a page has to come back.
- The time limit reached while the bot page is reconnecting still posts its line in the chat before the bot leaves.
- A meeting whose session can't start (a key not set, say) has its bot leave at once, and its page is told not to try again. Before, the bot stayed in the call, silent, until the page wait ran out.
- The last words before a meeting ends are transcribed: the sentence in progress is ended before the stream closes, so it reaches the transcript and the minutes (and a "please leave" among them is honoured). Before, it was lost.

### Fixed

- A `set_brief` whose file couldn't be written (a full disk, say) stopped the service as a crash, ending every meeting. It is now refused, with why.
- The `[minutes]` log lines named the minutes file, whose name holds the meeting's key, and a failure's message, which can name it too. They now name the bot, and a failure's code only; the owner's session still hears the reason in full.
- The `[retention]` log line gave a failure's message, which names the file it could not delete, and so the meeting's key. It now gives counts and the error's code only. One file the sweep can't delete no longer stops it: the others still go, and the next sweep tries again.
- A refused Deepgram connection (a wrong key, no credit left) no longer piles up the meeting's audio in memory for the rest of the meeting, and is not tried again.

### Security

- The `hono` and `@hono/node-server` packages, which the MCP SDK the Claude Code channel is built on depends on, are updated to versions without the advisories GitHub reported (GHSA-qv5m-9pm6-hqp3, GHSA-jpvv-r467-5p4w, GHSA-4m76-xfj5-7975, GHSA-h7mg-cq63-vhpq, GHSA-3gg2-335m-rxc6, GHSA-46wx-v44x-9hh2, GHSA-4h7h-rv7c-7m2v). They were not reachable here: the channel uses the SDK's stdio transport, and Hono only serves its HTTP one.

## 0.1.0

The first public release.

### Added

- A voice assistant that joins Zoom, Google Meet and Microsoft Teams meetings through Recall.ai, says that it is an AI, and answers questions said to it by name.
- Two tiers: quick answers from the meeting brief, and deeper ones from the owner's Claude Code session, through the `zoom-meeting` MCP channel and its meeting-assistant agent.
- "Please leave" and removal from the meeting make it leave and delete the meeting's transcript. "Never mind" stops it talking.
- Minutes after each meeting.
- Settings for the assistant's name, the owner and the company; a profile with the owner's context, sources and rules; and a bot page of your own.
- A public port for the meeting bot only, a control socket for everything else, and limits on meetings at once and meeting length.
- A launchd agent on macOS and a systemd user service on Linux.
- What the meeting sees, and what the log keeps, say no more than they must: when something fails, the bot page shows fixed words, never a provider's error, and the log names each bot and its platform, never the meeting's link.
