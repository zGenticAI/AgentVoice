# Testing a screen share (the share test)

A test you run in a test meeting you host, with your real Recall account. These pages call the assistant Alex, its default name.

## What it checks, and why

The slides feature ([Presenting slides](presenting.md)) has Alex present a deck by sharing a page as its screen, while its camera page keeps carrying its voice and its hearing. One thing no Recall document settles: when the bot starts, replaces or stops a screen share mid-call, does Alex's camera page keep running untouched? If it reloads, or its connection drops, Alex goes deaf and silent for a moment, or drops out of the meeting.

`npm run join -- "<link>" --share-test` checks it. Alex joins as usual, then shares a test page as its screen, step by step, while the service watches its camera page. You answer a few questions in the terminal about what you see and hear. At the end it prints a report to paste back to your Claude Code session. It takes about 10 minutes for each platform: Zoom, Google Meet and Microsoft Teams.

The decisive result is the camera page: whether it dropped, connected again, or a copy of it loaded again, in any step from S2 to S9. The test page shows nothing of the meeting and makes no sound.

Presenting is off on every platform until this test has passed there: once its verdict says slides look safe on a platform, add that platform to `SLIDES_PLATFORMS` in `.env` (`zoom`, `google_meet` or `microsoft_teams`, comma-separated) and restart the service. Until then, a join with slides there is refused before any bot is created.

## What you need

- The voice service running, restarted since you updated (the test refuses a service older than it).
- A test meeting that you host, with nothing confidential in it, and only you in it. Ideally a second device or a phone joined too, to look at the share as a participant does. The host's own view of a share can differ.
- The meeting's setting that lets a guest share its screen (below). Alex joins as a guest.

Nothing is recorded: Recall keeps no recording, and at the end Alex leaves as on "Alex, please leave", which deletes its transcript and writes no minutes. With `--keep` it stays in the meeting instead, as in any meeting.

## The platform settings

Check these before you start. The test says the one for your meeting's platform, and again if you can't see the share.

| Platform | The setting |
| --- | --- |
| Zoom | "Who can share?" set to "All participants": in the meeting, the arrow beside Share, then Advanced sharing options. |
| Google Meet | Host controls: "Share their screen" on, or Host management off. |
| Microsoft Teams | Meeting options: "Who can present" includes everyone. Or make Alex a presenter: in People, the "..." beside its name, then Make a presenter. |

## Running it

```bash
npm run join -- "<meeting link>" --share-test
npm run join -- "<meeting link>" --share-test --json data/share-test-zoom.json   # also the raw step records
npm run join -- "<meeting link>" --share-test --keep                             # Alex stays in the meeting after
```

| Option | What it does |
| --- | --- |
| `--json <file>` | Also writes the raw step records to that file, readable only by you (0600; a folder it has to make is 0700). |
| `--keep` | Alex stays in the meeting when the test ends, or when you stop it. Say "Alex, please leave", or remove it, when you are done. |
| `--brief <file>` | As for any join. |

`--json` and `--keep` go only with `--share-test`, and `--share-test` doesn't go with `--speaker-probe`. Your Claude Code session's `join_meeting` can't start the test.

It first says what will happen and which setting to check, then waits for Enter. Then it waits for Alex to be let in (as long as a waiting room can take, about 10 minutes) and for the consent line to finish. Progress and questions go to the terminal's error stream; the report goes to its output.

Ctrl-C at any time stops the share, takes Alex out of the meeting (unless `--keep`), and prints what the test found so far. A second Ctrl-C quits at once. Closing the terminal, or SIGTERM, also stops the share and takes Alex out (the report is printed if there is still somewhere to print it). Every wait has a time limit, and a question left without an answer for 5 minutes stops the test the same way.

## The steps, and what each question means

Answer `y` or `n`, or `s` to skip a question. Enter alone asks it again, except where it says Enter.

| Step | What happens | The question |
| --- | --- | --- |
| S1 baseline | The camera page is connected; the counts so far. | None. |
| S2 share | Alex shares the test page. The service waits up to 20 s for the page to link up. | "Do you see a page titled 'Screen-share test' in the meeting?" If not, the test shows the setting to change, and tries once more after you press Enter. Then: "What is the smallest text size you can read on the ladder?" Answer the number beside the smallest line you can read (12 to 48), or `none`. Read it on the second device or phone if you have one: that sets how small slide text may be (see [Legibility](presenting.md#legibility)). |
| S3 voice while sharing | Alex says a test sentence through its normal speech path. | "Did you hear Alex say the test sentence?" |
| S4 listening while sharing | You ask Alex a question by name. | Press Enter once it has answered, or type `n` if it didn't. |
| S5 slide changes | The big number on the page counts up to 5, every 2 s. The page says when it has shown each one. | "Did the big number count up to 5?" |
| S6 hold | The share stays up for 60 s, while the page reports how it runs. | None. |
| S7 replace | Alex shares a new page without stopping the first. This is the one Recall doesn't document. | "Does the page now show session 2?" (or the number it says) |
| S8 stop | Alex stops the share, then says a test sentence, then you ask it a question by name. | "Has the screen share gone?", "Did you hear Alex after the share stopped?", then press Enter once it has answered, or type `n` if it didn't. |
| S9 restart | Alex shares again, then stops, then the test watches the camera page for 6 s more: the service counts a page that went quiet as dropped only after 4 s. | None: timings only. |

Then Alex leaves, unless `--keep`.

## Reading the report

It starts with the app and Node versions, the platform and the date (UTC), then the verdict:
- **Slides look safe on <platform>.** only if, from S2 to S9: the camera page never dropped, connected again or loaded again, and its state was known at the end; Recall accepted every share and stop, the replace in S7 included; you saw the share in S2 and saw it go in S8; Alex was heard in S3 and S8, and answered your question in S4 and after the stop in S8; and nothing you were asked was answered no (the number counting in S5, the new session in S7). Hearing and speaking take separate paths in the camera page, so one can break while the other works.
- **Not safe yet on <platform>:** with each reason. A test stopped early, even partway through S9, is never safe.

Then:
- **Camera page, step by step**: untouched, or how many times it dropped, connected again, or loaded again and was refused (a page loaded again has lost the secret that lets it back into the meeting).
- **Steps**: each one PASS, FAIL, SKIPPED or UNKNOWN, with how long it took, Recall's answer to each share and stop (its HTTP status, and how long), the timings (how long the page took to link up after it was asked for, how long its link took to close after a stop or a replace), what the test page's link did, and your answers.
- **The test page in the bot's browser**: its size and devicePixelRatio, whether the browser said it was visible, the frame rate from `requestAnimationFrame` (Recall streams 15 frames a second), how late a 100 ms timer ran at worst, the Chrome version, and the `Origin` the browser sent when the page linked up (scheme and host only: the page's own, or another).
- **Smallest readable text**, and what was done at the end.

## What to send back

Paste the whole report, from `Screen-share test report` to `Paste this whole report back to your Claude Code session.`, into your Claude Code session. Run it once on each platform you use.

The report and the `--json` file hold no key or token, no meeting link, no address and no bot id: the public address shows as `[public-host]`, and anything else that looks like one is taken out. The Origin the bot's browser sent is kept as its scheme and host, even another site's: it has no path, so it can't hold a token. Keep the `--json` file to yourself unless your session asks for it.

## What it changes in the service

Only for a meeting joined with `--share-test`. Every other meeting is as it was: the same bot, the same pages, the same log.

- The test page (`/share-test`) and its link (`/share-test-link`) are on the public port, through your tunnel, only while that meeting has a share on, and only with that share's token: see [Ports and security](security.md).
- The join command drives the test on the control socket (`/api/share-test/status` and `/api/share-test/action`), with the local token, as `/api/join`.
- The service's log has `[share-test]` lines with the bot's id, the step, Recall's HTTP status and timings only.
- What the test measured stays in the service's memory until the meeting ends.
