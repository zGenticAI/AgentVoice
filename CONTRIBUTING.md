# Contributing

Bug reports, fixes and improvements are welcome. Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

- For anything bigger than a small fix, open an issue first, so that we can agree on the approach before you write it.
- Never put real meeting content, transcripts, the names of real people or clients, meeting links, keys or tokens in an issue, a test or a commit. Use made-up names (Sam, Acme) and `example.com`.
- Report security issues as [SECURITY.md](SECURITY.md) says, not in an issue.

## Setting up

You need Node.js 24 or later (`.nvmrc` says 24), on macOS or Linux.

```bash
npm ci
npm test
npm run typecheck
```

`npm test` needs no keys. It uses fakes for Recall.ai, Deepgram, ElevenLabs and Claude, and fixed settings, whatever your `.env` says. To try a change against the real services, run `npm run check`, then use a real meeting.

## Making a change

- Keep each change focused, with a test that fails without it.
- Run `npm test` and `npm run typecheck` before you open the pull request. CI runs both, on Linux and macOS.
- **The attention, leave and cancel rules** (`src/brain/attention.ts`, `src/brain/text.ts`): every line in `test/fixtures/name-corpus.json` must give exactly its recorded result. If your change is meant to change results, record them again with `npm run record-name-corpus`, and explain each changed line in the pull request. Leaving deletes a meeting's record, which can't be undone, so a change that makes the assistant leave on more lines needs a strong case.
- **The consent wording** (`src/consent.ts`) stays: the AI disclosure, that it is transcribing, that it can't agree to anything, and how to make it leave. A change that weakens it won't be accepted.
- **Meeting data:** nothing from a meeting is written anywhere but the transcript and the minutes, and nothing said in a meeting is logged. If a change sends meeting data somewhere new, update [Where meeting data goes](README.md#where-meeting-data-goes) in the same pull request.
- **Dependencies:** `@modelcontextprotocol/sdk` is pinned to an exact version. Claude Code doesn't register a channel server that negotiates MCP protocol revision 2026-07-28 (see [its channels documentation](https://code.claude.com/docs/en/channels)), so before you change the version, check that the channel still registers.
- Update the docs (`README.md`, `docs/`) and `CHANGELOG.md` in the same pull request.

[Development](docs/development.md) has more about the tests and the layout of the code.

## Private terms

`test/private-terms.test.ts` checks that no file git would commit holds a macOS home folder path, a link into a claude.ai account or an email address. It can also check for your own private terms (your name, your company, your hostnames) from a list you keep outside the repository, so that they are caught before you commit: see `test/private-terms.ts`.

## Licence

By contributing, you agree that your contribution is licensed under the [Apache License 2.0](LICENSE), as its section 5 says.
