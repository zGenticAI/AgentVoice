# Changelog

The notable changes in each version. The project follows [Semantic Versioning](https://semver.org/): until 1.0, a minor version may change settings or behaviour, and says so here.

## Unreleased

### Added

- A code of conduct: the Contributor Covenant 2.1.

### Changed

- Talking over the assistant pauses it first. It stops only for words, and carries on after a cough, a laugh, or "mm-hm", "yeah", "okay", "right" or "I see". It can now be talked over until the bot page has played the end of an answer. Before, it stopped at the first sound Deepgram turned into a word, and only while the answer was still going out to the page.
- The transcript says what the meeting heard the assistant say. When it is talked over, told never mind, or asked something new partway through an answer, when its page goes, or when ElevenLabs fails partway through a line, the line keeps only the words the bot page had played, ending in "(cut off)", and a line it never got to is left out. The minutes and the next answers go by it. Before, the transcript had every line in full as soon as the assistant started it.
- The consent line and the goodbye are protected until the bot page has played them to the end, as the service now follows the page's playback. Before, it went by when their audio had gone out, which could be earlier: when the page started 50 ms late, when ElevenLabs paused partway, or when an answer to a question asked before the consent line was still playing ahead of it.
- The bot leaves a meeting by itself sooner: 5 minutes after it got in if nobody else has joined (Recall's default was 20), and after 15 minutes of silence, counted once it has been in the call 10 minutes (the default was 60, after 20).

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
