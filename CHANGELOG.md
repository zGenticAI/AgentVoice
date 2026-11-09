# Changelog

The notable changes in each version. The project follows [Semantic Versioning](https://semver.org/): until 1.0, a minor version may change settings or behaviour, and says so here.

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
